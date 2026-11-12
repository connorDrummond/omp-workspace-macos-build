param([switch]$NoDesktop)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$launch = Join-Path $project 'launch.mjs'
$installDir = Join-Path $env:LOCALAPPDATA 'omp'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$command = Join-Path $installDir 'omp-workspace.cmd'
if ((Test-Path $command) -and -not ((Get-Content $command -Raw).Contains('@rem OMP Workspace launcher'))) {
    throw "Refusing to overwrite unrelated command: $command"
}
$shim = "@echo off`r`n@rem OMP Workspace launcher`r`n`"$node`" `"$launch`" %*`r`nif errorlevel 1 exit /b 1`r`n"
Set-Content -Path $command -Value $shim -Encoding ASCII -NoNewline
$projects = Join-Path $env:USERPROFILE 'Projects'
if (-not (Test-Path $projects -PathType Container)) { $projects = $project }
$shell = New-Object -ComObject WScript.Shell
$locations = @([Environment]::GetFolderPath('Programs'))
if (-not $NoDesktop) { $locations += [Environment]::GetFolderPath('Desktop') }
foreach ($location in $locations) {
    $shortcutPath = Join-Path $location 'OMP Workspace.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ((Test-Path $shortcutPath) -and ($shortcut.Arguments -notlike "*$launch*")) {
        throw "Refusing to overwrite unrelated shortcut: $shortcutPath"
    }
    $shortcut.TargetPath = $node
    $shortcut.Arguments = "`"$launch`" --root `"$projects`""
    $shortcut.WorkingDirectory = $projects
    $shortcut.Description = 'Repository, live omp chats, agents, and file reader'
    $shortcut.IconLocation = "$(Join-Path $project 'public\icon.ico'),0"
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Host "Installed shortcut: $shortcutPath"
}
Write-Host "Installed command: $command"
Write-Host 'Launch from a repository: omp-workspace'
