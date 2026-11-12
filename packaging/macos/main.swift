import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func showError(_ message: String) {
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "OMP Workspace could not start"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
}

let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
let home = FileManager.default.homeDirectoryForCurrentUser
let projects = home.appendingPathComponent("Projects")
var isDirectory: ObjCBool = false
let hasProjects = FileManager.default.fileExists(atPath: projects.path, isDirectory: &isDirectory) && isDirectory.boolValue
let node = contents.appendingPathComponent("MacOS/node")
let launcher = contents.appendingPathComponent("Resources/workspace/launch.mjs")
var environment = ProcessInfo.processInfo.environment
// Finder does not inherit a terminal's PATH. Load the user's login-shell environment.
environment["OMP_WORKSPACE_NODE"] = node.path
environment["OMP_WORKSPACE_LAUNCH"] = launcher.path
environment["OMP_WORKSPACE_ROOT"] = (hasProjects ? projects : home).path
environment["PATH"] = "\(node.deletingLastPathComponent().path):\(home.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")"

let process = Process()
process.executableURL = URL(fileURLWithPath: environment["SHELL"] ?? "/bin/zsh")
process.arguments = ["-l", "-c", "exec \"$OMP_WORKSPACE_NODE\" \"$OMP_WORKSPACE_LAUNCH\" --root \"$OMP_WORKSPACE_ROOT\""]
process.environment = environment
process.currentDirectoryURL = home
let output = Pipe()
process.standardOutput = output
process.standardError = output

do {
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        showError(String(decoding: data, as: UTF8.self))
        exit(EXIT_FAILURE)
    }
} catch {
    showError(error.localizedDescription)
    exit(EXIT_FAILURE)
}
