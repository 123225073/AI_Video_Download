param([ValidateSet('inspect','apply','restore','guard','state-status')][string]$Action,[string]$StateFile,[int]$OwnerProcess)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:taskStage='state'
trap { @{ok=$false;stage=$script:taskStage;helperStage=$script:routeHelperStage;proxyField=$script:proxyMismatchField;errorCode=$_.Exception.HResult;exceptionType=$_.Exception.GetType().Name;innerErrorCode=if ($_.Exception.InnerException) {$_.Exception.InnerException.HResult} else {$null};innerType=if ($_.Exception.InnerException) {$_.Exception.InnerException.GetType().Name} else {$null}} | ConvertTo-Json -Compress; exit 1 }
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
function Read-Proxy {
  $properties = Get-ItemProperty -LiteralPath $registryPath
  $result = @{}
  foreach ($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
    $property = $properties.PSObject.Properties[$name]
    $result[$name] = @{present=($null -ne $property);value=if ($property) {$property.Value} else {$null}}
  }
  return $result
}
function Initialize-Native {
  if (-not ('FengshaTemporaryRoot' -as [type])) {
    [void][Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'collector-native.dll'))
  }
}
function Notify-Proxy {
  Initialize-Native
  foreach ($option in @(39,37)) { [void][FengshaProxyNotice]::InternetSetOption([IntPtr]::Zero,$option,[IntPtr]::Zero,0) }
}
function Read-ProxyGuard {
  if (-not (Get-Process -Name 'clash-verge' -ErrorAction SilentlyContinue)) { return $false }
  foreach ($folder in @('io.github.clash-verge-rev.clash-verge-rev','clash-verge','io.github.clash-verge.clash-verge')) {
    $configFile = Join-Path (Join-Path $env:APPDATA $folder) 'verge.yaml'
    if (-not (Test-Path -LiteralPath $configFile)) { continue }
    $guardEnabled=$false; $systemEnabled=$false
    # Read only public boolean controls; never return proxy profiles or secrets.
    foreach ($line in Get-Content -LiteralPath $configFile) {
      if ($line -match '^\s*enable_proxy_guard\s*:\s*true\s*$') { $guardEnabled=$true }
      if ($line -match '^\s*enable_system_proxy\s*:\s*true\s*$') { $systemEnabled=$true }
    }
    return ($guardEnabled -and $systemEnabled)
  }
  return $false
}
function Save-State($state) {
  $temporary = $StateFile + '.writing'
  [IO.File]::WriteAllText($temporary,($state | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($temporary,$StateFile,[NullString]::Value)
}
function Open-Root {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
  # Read-only inspection avoids the protected-root modal prompts of X509Store.Add/Remove.
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
  Initialize-Native
  [FengshaTemporaryRoot]::Refresh($store.StoreHandle)
  return $store
}
function Update-Certificate([bool]$add,[Security.Cryptography.X509Certificates.X509Certificate2]$certificate) {
  # The user requested automatic handling of this application's temporary trust.
  # CryptoAPI operates only on the exact certificate in the current user's store.
  Initialize-Native
  [FengshaTemporaryRoot]::Update($add,$certificate.RawData)
}
function Read-State {
  $state = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.proxyAddress -ne '127.0.0.1:2023' -or $state.certificateName -notlike 'Fengsha-WeChat-*') { throw '无效的恢复记录' }
  return $state
}
function Assert-ProxyBaseline($state, $nowProxy) {
  $names = @('ProxyEnable','ProxyServer','AutoConfigURL')
  # Routed mode owns no registry settings. Preserve independently refreshed
  # bypass lists instead of rejecting a valid route because their text changed.
  if ($state.mode -ne 'routed') { $names += 'ProxyOverride' }
  foreach ($name in $names) {
    if ($nowProxy[$name].present -ne $state.before.$name.present -or [string]$nowProxy[$name].value -ne [string]$state.before.$name.value) { $script:proxyMismatchField=$name; throw 'Proxy changed during connection preparation' }
  }
}
function Restore-State {
  $script:taskStage='restore-state'
  $state = Read-State
  $mutex = [Threading.Mutex]::new($false,('Local\FengshaCollector-' + $state.id))
  try {
    if (-not $mutex.WaitOne(15000)) { throw '等待连接恢复超时' }
    $state = Read-State
    if ($state.phase -eq 'restored') { return $state }
    $routeRestored=$true
    if ($state.mode -eq 'routed') {
      $script:taskStage='route-restore'
      $node=Join-Path (Split-Path $PSScriptRoot -Parent) 'node/node.exe'
      $helper=Join-Path $PSScriptRoot 'clash-route-helper.cjs'
      $script:routeHelperStage=$null
      try {
        # This reader can decode protected leases that native Node sees as an
        # encrypted envelope. Pass only the in-memory object, never a new file.
        $OutputEncoding=[Text.UTF8Encoding]::new($false)
        $reply=$state | ConvertTo-Json -Depth 8 -Compress | & $node $helper --stdin
        $helperExitCode=$LASTEXITCODE
        $result=$reply | ConvertFrom-Json
        if ($helperExitCode -ne 0 -or $result.restored -ne $true) {
          $routeRestored=$false
          $script:routeHelperStage='helper-output'
          if ($result.stage -in @('lease-read','lease-size','lease-parse','lease-validate','route-restore')) { $script:routeHelperStage=$result.stage }
        }
      } catch { $routeRestored=$false; $script:routeHelperStage='helper-exec' }
      # An orphaned collector must not keep decrypting traffic after its owner exits.
      try {
        $null=Invoke-RestMethod -Uri 'http://127.0.0.1:2022/api/proxy/config' -Method Post -ContentType 'application/json' -Body '{"values":{"proxy.enabled":false,"proxy.system":false},"restart":false}' -TimeoutSec 15
        $null=Invoke-RestMethod -Uri 'http://127.0.0.1:2022/api/service/stop' -Method Post -ContentType 'application/json' -Body '{"name":"interceptor"}' -TimeoutSec 15
      } catch {}
    }
    $current = Read-Proxy
    # If the user changed the proxy independently, preserve their newer selection.
    if ($state.mode -ne 'routed' -and $current.ProxyServer.value -eq $state.proxyAddress) {
      $script:taskStage='proxy-restore'
      foreach ($name in @('ProxyEnable','ProxyServer')) {
        $saved = $state.before.$name
        if ($saved.present) { Set-ItemProperty -LiteralPath $registryPath -Name $name -Value $saved.value }
        else { Remove-ItemProperty -LiteralPath $registryPath -Name $name -ErrorAction SilentlyContinue }
      }
      Notify-Proxy
    }
    if ($state.certificateAdded) {
      $script:taskStage='certificate-remove'
      $store = Open-Root
      try {
        $matched = @($store.Certificates | Where-Object { $_.Thumbprint -eq $state.certificateThumbprint -and $_.GetNameInfo(0,$false) -eq $state.certificateName })
      } finally { $store.Close() }
      foreach ($certificate in $matched) { Update-Certificate $false $certificate }
      $store = Open-Root
      try { if (@($store.Certificates | Where-Object Thumbprint -eq $state.certificateThumbprint).Count -gt 0) { throw '临时证书尚未移除' } } finally { $store.Close() }
    }
    if (-not $routeRestored) { $script:taskStage='route-restore'; throw 'Clash routing restoration incomplete; current settings preserved' }
    $script:taskStage='restore-save';$state.phase = 'restored'; Save-State $state
    return $state
  } finally { try {$mutex.ReleaseMutex()} catch {}; $mutex.Dispose() }
}
if ($Action -eq 'state-status') {
  $script:taskStage='state-status'
  $state=Read-State
  @{phase=$state.phase;mode=$state.mode} | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'inspect') {
  $script:taskStage='inspect'
  $owner = Get-Process -Id $OwnerProcess
  @{proxy=Read-Proxy;ownerStarted=$owner.StartTime.ToUniversalTime().Ticks.ToString();guardedProxy=Read-ProxyGuard} | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($Action -eq 'apply') {
  $script:taskStage='certificate-check'
  $state = Read-State
  $script:taskStage='certificate-proxy-baseline'
  $nowProxy=Read-Proxy
  Assert-ProxyBaseline $state $nowProxy
  $script:taskStage='certificate-parse'
  $pem=Get-Content -LiteralPath $state.certificateFile -Raw -Encoding UTF8
  $encoded=$pem -replace '-----BEGIN CERTIFICATE-----','' -replace '-----END CERTIFICATE-----','' -replace '\s',''
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($encoded))
  $script:taskStage='certificate-identity'
  if ($certificate.GetNameInfo(0,$false) -ne $state.certificateName -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotAfter -gt (Get-Date).AddYears(2).AddDays(2)) { throw '证书身份或有效期不符合连接约定' }
  if ($state.certificateFingerprint) {
    $script:taskStage='certificate-fingerprint'
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $fingerprint=[BitConverter]::ToString($hash.ComputeHash($certificate.RawData)).Replace('-',':') } finally { $hash.Dispose() }
    if ($fingerprint -ne $state.certificateFingerprint) { throw '证书与本次连接记录不一致' }
  }
  $script:taskStage='certificate-store'
  $store = Open-Root
  try {
    $present = @($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint).Count -gt 0
  } finally { $store.Close() }
  $state.certificateThumbprint=$certificate.Thumbprint; $state.certificateAdded=(-not $present); $state.phase='applying'; Save-State $state
  if (-not $present) { $script:taskStage='certificate-add';Update-Certificate $true $certificate }
  $store = Open-Root
  try { if (@($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint).Count -eq 0) { throw '本机专用证书尚未完成信任，未切换代理' } } finally { $store.Close() }
  if ($state.mode -ne 'routed') {
    $script:taskStage='proxy-apply'
    Set-ItemProperty -LiteralPath $registryPath -Name ProxyServer -Value $state.proxyAddress
    Set-ItemProperty -LiteralPath $registryPath -Name ProxyEnable -Value 1
    Notify-Proxy
  }
  $state.phase='active'; Save-State $state
  @{active=$true} | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'restore') { $state=Restore-State; @{restored=($state.phase -eq 'restored')} | ConvertTo-Json -Compress; exit }
if ($Action -eq 'guard') {
  $guardReady=$false
  while ($true) {
    try {
      $state=Read-State
      if ($state.phase -eq 'restored') { exit }
      # Report readiness only after this reader has validated the lease. File
      # protection/scanners can delay readable metadata after the initial write.
      if (-not $guardReady) { [IO.File]::WriteAllText(($StateFile + '.guard-ready'),'ready'); $guardReady=$true }
      $owner=Get-Process -Id $state.owner -ErrorAction SilentlyContinue
      if (-not $owner -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.ownerStarted) { $null=Restore-State; exit }
    } catch { Start-Sleep -Seconds 1; continue }
    Start-Sleep -Seconds 1
  }
}
