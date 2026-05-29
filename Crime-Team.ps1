# create a Start Menu shortcut
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Crime Team.lnk")
$shortcut.TargetPath = "C:\Users\user\Projects\crime-team-orchestrator\desktop\src-tauri\target\debug\crime-team-desktop.exe"
$shortcut.IconLocation = "C:\Users\user\Projects\crime-team-orchestrator\desktop\src-tauri\icons\icon.ico"
$shortcut.Save()