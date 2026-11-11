# Windows desktop notification - plain PowerShell 5.1, no npm modules.
# Arguments are UTF-8 base64 to prevent command injection from market symbols.
# 1) Windows 10/11 toast (shown under "Windows PowerShell" in Settings > Notifications).
# 2) If the toast API is unavailable, a tray balloon.
# Exit code 0 = shown by one of them; 1 = both failed (the reason goes to stderr).
param([Parameter(Mandatory=$true)][string]$Title64,
      [Parameter(Mandatory=$true)][string]$Body64)
$ErrorActionPreference = 'Stop'
$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Title64))
$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Body64))
$toastError = $null
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
    $t = [System.Security.SecurityElement]::Escape($title)
    $b = [System.Security.SecurityElement]::Escape($body)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    [Console]::Out.WriteLine('TOAST')
    exit 0
} catch {
    $toastError = $_.Exception.Message
}
$notify = $null
try {
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
    [Console]::Out.WriteLine('BALLOON')
    exit 0
} catch {
    [Console]::Error.WriteLine('toast: ' + $toastError + ' / balloon: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $notify) { $notify.Visible = $false; $notify.Dispose() }
}
