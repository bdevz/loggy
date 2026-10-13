# Keeps the Log1 Socket Mode worker alive in the interactive Cashew host session.
# The .env file is read on the host and never committed.
Set-Location $PSScriptRoot
$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envPath)) { throw "Missing $envPath" }
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'logs') | Out-Null

# A scheduled task can be started again before its previous PowerShell process
# has exited. Keep one Socket Mode worker per host so Slack does not deliver
# events to competing consumers.
$mutex = New-Object System.Threading.Mutex($false, 'Global\LoggySocketModeWorker')
if (-not $mutex.WaitOne(0)) {
  Add-Content (Join-Path $PSScriptRoot 'logs\stdout.log') "[$(Get-Date -Format o)] another Log1 runner is already active"
  exit 0
}

Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith('#')) { return }
  $separator = $line.IndexOf('=')
  if ($separator -le 0) { return }
  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1).Trim()
  Set-Item -Path "Env:$name" -Value $value
}

try {
  while ($true) {
    & npm run start:socket *>> (Join-Path $PSScriptRoot 'logs\stdout.log')
    Add-Content (Join-Path $PSScriptRoot 'logs\stdout.log') "[$(Get-Date -Format o)] log1 exited ($LASTEXITCODE), restarting in 5s"
    Start-Sleep -Seconds 5
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
