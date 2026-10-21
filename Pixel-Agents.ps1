# Starts the standalone server hidden, opens it in an Edge app window, and stops
# the server when that window closes.
Set-Location $PSScriptRoot
$data = "$env:LOCALAPPDATA\PixelAgents"
New-Item -ItemType Directory -Force $data | Out-Null
$log = "$data\server.log"

$server = Start-Process node -ArgumentList 'dist\cli.js' -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError "$data\server-err.log"

$url = $null
for ($i = 0; $i -lt 60 -and -not $url -and -not $server.HasExited; $i++) {
  Start-Sleep -Milliseconds 500
  $m = Select-String -Path $log -Pattern '(http://\S+token=\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Groups[1].Value }
}
if (-not $url) {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Pixel Agents nao iniciou. Veja $data\server-err.log", 'Pixel Agents') | Out-Null
  exit 1
}

# A dedicated profile makes this Edge process its own browser instance, so it
# exits exactly when the app window closes.
$edge = Start-Process msedge -ArgumentList "--app=$url", "--user-data-dir=$data\edge", '--no-first-run' -PassThru
$edge.WaitForExit()
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
