import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)

func showError(_ message: String) {
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "OMP Workspace could not start"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
}

final class WorkspaceDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let origin: URL

    init(origin: URL) {
        self.origin = origin
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // The detached server keeps chats alive until Stop workspace is selected.
        return true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.window?.title = "OMP Workspace"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error.localizedDescription)
    }
}

let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
let home = FileManager.default.homeDirectoryForCurrentUser
let projects = home.appendingPathComponent("Projects")
var isDirectory: ObjCBool = false
let hasProjects = FileManager.default.fileExists(atPath: projects.path, isDirectory: &isDirectory) && isDirectory.boolValue
let node = contents.appendingPathComponent("MacOS/node")
let launcher = contents.appendingPathComponent("Resources/workspace/launch.mjs")
var environment = ProcessInfo.processInfo.environment
// Finder does not inherit a terminal's PATH. Load the zsh login environment.
environment["OMP_WORKSPACE_NODE"] = node.path
environment["OMP_WORKSPACE_LAUNCH"] = launcher.path
environment["OMP_WORKSPACE_ROOT"] = (hasProjects ? projects : home).path
environment["PATH"] = "\(node.deletingLastPathComponent().path):\(home.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")"

let process = Process()
process.executableURL = URL(fileURLWithPath: "/bin/zsh")
process.arguments = ["-l", "-c", "export PATH=\"${OMP_WORKSPACE_NODE%/*}:$PATH\"; exec \"$OMP_WORKSPACE_NODE\" \"$OMP_WORKSPACE_LAUNCH\" --root \"$OMP_WORKSPACE_ROOT\" --no-open"]
process.environment = environment
process.currentDirectoryURL = home
let output = Pipe()
process.standardOutput = output
process.standardError = output

var launchURL: URL?
do {
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    if process.terminationStatus != 0 {
        showError(text)
        exit(EXIT_FAILURE)
    }
    for line in text.split(separator: "\n") where line.hasPrefix("Local window: ") {
        launchURL = URL(string: String(line.dropFirst("Local window: ".count)))
    }
} catch {
    showError(error.localizedDescription)
    exit(EXIT_FAILURE)
}

guard let url = launchURL, url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
    showError("The local server did not return a valid workspace URL.")
    exit(EXIT_FAILURE)
}

let delegate = WorkspaceDelegate(origin: url)
app.delegate = delegate
let menu = NSMenu()
let appMenu = NSMenu()
appMenu.addItem(withTitle: "Quit OMP Workspace", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
let appItem = NSMenuItem()
appItem.submenu = appMenu
menu.addItem(appItem)
let editMenu = NSMenu(title: "Edit")
for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
    editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
}
let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
editItem.submenu = editMenu
menu.addItem(editItem)
app.mainMenu = menu

let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
webView.navigationDelegate = delegate
let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "OMP Workspace — Loading…"
window.minSize = NSSize(width: 880, height: 560)
window.contentView = webView
window.setFrameAutosaveName("OMP Workspace")
window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: url))
app.run()
