# Keeps Windows from going to sleep while Signal Lab's server runs (the screen may still turn off).
# Same mechanism media players use (SetThreadExecutionState); nothing is changed in the power
# settings, and the request ends when this script ends. It ends by itself when the server
# process (ParentId) is gone, so a crashed server never leaves the PC awake.
param([Parameter(Mandatory=$true)][int]$ParentId)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SignalLab -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
try {
    while ($true) {
        if (-not (Get-Process -Id $ParentId -ErrorAction SilentlyContinue)) { break }
        [void][SignalLab.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
        Start-Sleep -Seconds 30
    }
} finally {
    [void][SignalLab.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
exit 0
