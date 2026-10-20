# Windows desktop balloon notification - plain PowerShell 5.1, no npm modules.
# Arguments are UTF-8 base64 to prevent command injection from market symbols.
param([Parameter(Mandatory=$true)][string]$Title64,
      [Parameter(Mandatory=$true)][string]$Body64)
$ErrorActionPreference = 'Stop'
$notify = $null
try {
    $title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Title64))
    $body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Body64))
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = $body
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notify.Text = 'Signal Lab - Paper Trading (SIM)'
    $notify.Visible = $true
    $notify.ShowBalloonTip(6000)
    # The tray icon must stay alive long enough for Windows to show the notice.
    Start-Sleep -Seconds 8
    exit 0
} catch {
    [Console]::Error.WriteLine('Windows notification failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $notify) { $notify.Visible = $false; $notify.Dispose() }
}
