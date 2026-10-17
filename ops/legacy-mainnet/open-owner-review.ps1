param(
    [string]$ServerAddress = '2.27.12.39',
    [string]$KeyPath = "$env:USERPROFILE/.ssh/enclave_pilot_ed25519"
)
$ErrorActionPreference = 'Stop'
if ($ServerAddress -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid server address.' }
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'The configured SSH key file is missing.' }
if (Get-NetTCPConnection -State Listen -LocalPort 3283 -ErrorAction SilentlyContinue) {
    throw 'Local port 3283 is already occupied. Inspect the existing process before opening another forward.'
}
$reviewSshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$reviewArguments = @('-i', ('"' + (Resolve-Path -LiteralPath $KeyPath).Path + '"'),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-N', '-L', '127.0.0.1:3283:127.0.0.1:3283', ('root@' + $ServerAddress))
$reviewProcess = Start-Process -FilePath $reviewSshPath -ArgumentList $reviewArguments -WindowStyle Hidden -PassThru
@{ pid = $reviewProcess.Id; url = 'http://127.0.0.1:3283/'; purpose = 'Closed owner-review SSH forward' } | ConvertTo-Json -Compress
