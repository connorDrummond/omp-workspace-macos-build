# OMP Workspace

Browser-based workspace around the real omp terminal, with Windows desktop shortcuts and macOS installer packaging. Repository explorer, live agents, and chats on the left; up to two terminal panes in the center; Markdown/source reader and text editor on the right. Graphite panels, compact monospace text, amber active-pane borders, and draggable column dividers approximate the reference layout without Ghostty.

## Launch

Desktop and Start Menu: **OMP Workspace**. The shortcut starts in your Projects folder; choose a repository using the folder button in the header.

From a repository in PowerShell or Command Prompt:

```powershell
omp-workspace
```

Or choose a directory explicitly:

```powershell
omp-workspace C:\path\to\repository
```

On Windows, the launcher opens Edge in an app window (Chrome/browser fallback), reuses the running workspace for that launch directory, and uses a private browser profile. The macOS app uses a native WebKit window with its own gear icon in Finder and the Dock. It does not change your global omp settings, credentials, theme, model, or installed extensions. The terminal is your installed omp, not a simulated chat client.

Closing the window or hiding a pane **keeps chats running**. Stop one with its terminal's × button; use **? → Stop workspace** to stop all owned chats and the local server. Equivalent shell command:

```powershell
omp-workspace --root C:\path\to\repository --stop
```

The stop directory is the one used to launch the server, even if you later change the explorer folder. Stop preserves saved conversations.

## Controls

| Action | Input |
|---|---|
| New independent chat | Ctrl+Alt+N |
| Split with another independent chat | Ctrl+Alt+S |
| Toggle reader | Ctrl+Alt+R |
| Focus terminal 1 / 2 | Alt+1 / Alt+2 |
| Zoom focused terminal | Ctrl+Shift+Enter |
| Save the open text editor | Ctrl+S |
| Native omp Agent Hub | Alt+A, or Hub in the sidebar |
| Resize navigator / reader | Drag their vertical dividers |

The two terminal panes are independent omp sessions. Native Agent Hub focuses/controls subagents of the current session. Sidebar agents open read-only live transcripts; the reader's steering form sends a real user message to that live agent. Parked/offline agents require revival through native Agent Hub before steering.

Commands added only to workspace-owned omp processes:

```text
/workspace-read path/to/file.md
/workspace-split
/workspace-rename Chat title
```

Select a sidebar chat to show it in the active terminal slot; select a stopped/saved chat to resume it. Browser reload reconnects to the same processes and restores the split layout and terminal history. New app windows show up to two existing live sessions.

## Files and repositories

Expand directories, then select a file. Markdown opens in sanitized Preview; Source shows numbered text; Edit enables changes. Ctrl+S saves an existing UTF-8 file atomically. A file changed on disk is rejected with a conflict instead of overwritten: preserve your edits and reopen it to reload.

Explorer filtering searches already-loaded directory entries, not a recursive content index. `.git`, `node_modules`, `.venv`, and Python cache directories are hidden. Text files are limited to 2 MiB. Binary files, new-file creation, and deletion are outside this reader/editor. Markdown images are disabled to avoid external tracking requests.

Changing the header folder changes the explorer and the directory for **new** chats. Existing terminals retain their displayed working directories. The reader is hidden initially below 1150px; the navigator is hidden below 850px. Use the header toggles to reveal them.

## Installation and state

Requires Node.js 22+, a recent Windows ConPTY host, and omp. This installation was exercised on Windows with Node 26 and omp 18.19.0.

```powershell
cd C:\Users\cdrum\Projects\omp-workspace
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` adds `omp-workspace.cmd` beside the existing omp executable and creates Desktop/Start Menu shortcuts. The project directory must remain in place; rerun installation if you move it. `OMP_BIN` can select another omp executable.

Runtime state lives in `%LOCALAPPDATA%\omp-workspace`: native session files, saved-chat index, server rendezvous/log files, and the dedicated browser profile. Existing normal omp saved chats for the selected directory are also discovered. At most eight live/pending sessions run per server. No model request is made merely by opening an empty chat; prompts and steering use your normal provider/account.

The server binds only `127.0.0.1`. Its private launch URL establishes an HttpOnly session cookie; keep that URL private. APIs and terminal WebSockets require authentication, and browser writes require a matching origin. Reader paths are checked against real repository boundaries, including junctions/symlinks. Do not expose the port through a public proxy or run untrusted repositories without considering omp's normal execution permissions.

## macOS installer

The `macOS installer` GitHub Actions workflow builds separate Apple Silicon (`arm64`) and Intel (`x64`) `.dmg` files. Put this source in a GitHub repository, open **Actions → macOS installer → Run workflow**, then download the installer archive from the completed run's summary or Artifacts section. Artifact links require GitHub sign-in and expire after 30 days. No installer is published merely by adding the workflow.

For a local build on a Mac with Node.js 22+, npm, and Xcode Command Line Tools:

```sh
npm run package:mac
```

The builder downloads the official Node runtime matching the build process's version and architecture, verifies its SHA-256 checksum, installs locked production dependencies in an isolated app bundle, and compiles a native launcher. Before creating and verifying the disk image, it checks code signatures, exercises the bundled native PTY, and checks the bundled server's authenticated HTTP startup/shutdown. Output: `dist/OMP-Workspace-1.0.0-macos-arm64.dmg` or `dist/OMP-Workspace-1.0.0-macos-x64.dmg`.

Requires macOS 13+ and a separately installed/configured `omp` accessible through your zsh login PATH (or `OMP_BIN`). Node.js is bundled for the workspace; it does not bundle omp, model credentials, or your sessions. Open the disk image, drag **OMP Workspace.app** to **Applications**, then launch it. It starts in `~/Projects` when present, otherwise your home directory; select a repository using the header folder button. Closing the native window keeps chats running; **? → Stop workspace** shuts them down. State is stored in `~/.local/share/omp-workspace`.

Builds are ad-hoc signed, **not Developer ID signed or notarized**. Gatekeeper may block a downloaded app; only if you trust the build, allow it through **System Settings → Privacy & Security → Open Anyway**. Do not disable Gatekeeper globally. Apple Silicon and Intel builds passed compilation, code-signature verification, bundled native PTY and authenticated server checks, and disk-image verification on GitHub macOS runners. Both native application windows were launched and captured; each installer archive includes a UI screenshot. Real omp chats on macOS have not been verified because the build runners do not include omp.

The original eight-tooth gear/terminal logo lives in `public/icon.svg`, with derived PNG/ICO assets for Mac packaging and Windows shortcuts. `install.ps1` applies the gear to Desktop/Start Menu shortcuts; rerun it to update an existing installation. The Windows runtime still uses a browser-owned window, so its running taskbar icon can remain Edge/Chrome.


## Verification

Exercised through the actual browser UI and installed omp: two native terminals, real model replies and concurrent scouts, live transcript/steering, native Agent Hub, reader slash commands, Markdown sanitization, UTF-8 editing/Ctrl+S, stale-save rejection, browser reconnect, stopped-chat resume, and clean server shutdown. Unauthenticated/foreign-origin requests and traversal/junction escapes were rejected. Throwaway file fixtures were removed; the clearly named Workspace verification conversation remains as a real saved smoke-test transcript.

## Changes

### 1.0.0

- Added Apple Silicon/Intel macOS `.app`/`.dmg` packaging with a bundled Node runtime, native launcher, build-time native PTY/server checks, and downloadable GitHub Actions artifacts.
- Added original orange gear branding for browser/header icons, Windows shortcuts, and macOS app icons; replaced the Mac browser launcher with a native WebKit window and verified native-window screenshots on both Mac architectures.

- Added the screenshot-style Windows workspace shell, native terminal sessions, persistent chat resume, live agent bridge, and safe reader/editor.
- Added desktop/command launchers, private loopback access, split restoration, and explicit shutdown controls.
