param([ValidateSet('inspect','apply','restore','guard')][string]$Action,[string]$StateFile,[int]$OwnerProcess)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:taskStage='state'
trap { @{ok=$false;stage=$script:taskStage;errorCode=$_.Exception.HResult} | ConvertTo-Json -Compress; exit 1 }
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
function Save-State($state) {
  $temporary = $StateFile + '.writing'
  [IO.File]::WriteAllText($temporary,($state | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  [IO.File]::Replace($temporary,$StateFile,[NullString]::Value)
}
function Open-Root {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
  # Read-only inspection avoids the protected-root modal prompts of X509Store.Add/Remove.
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
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
function Restore-State {
  $script:taskStage='restore-state'
  $state = Read-State
  $mutex = [Threading.Mutex]::new($false,('Local\FengshaCollector-' + $state.id))
  try {
    if (-not $mutex.WaitOne(15000)) { throw '等待连接恢复超时' }
    $state = Read-State
    if ($state.phase -eq 'restored') { return $state }
    $current = Read-Proxy
    # If the user changed the proxy independently, preserve their newer selection.
    if ($current.ProxyServer.value -eq $state.proxyAddress) {
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
    $script:taskStage='restore-save';$state.phase = 'restored'; Save-State $state
    return $state
  } finally { try {$mutex.ReleaseMutex()} catch {}; $mutex.Dispose() }
}
if ($Action -eq 'inspect') {
  $script:taskStage='inspect'
  $owner = Get-Process -Id $OwnerProcess
  @{proxy=Read-Proxy;ownerStarted=$owner.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($Action -eq 'apply') {
  $script:taskStage='certificate-check'
  $state = Read-State
  $nowProxy=Read-Proxy
  foreach ($name in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')) {
    if ($nowProxy[$name].present -ne $state.before.$name.present -or [string]$nowProxy[$name].value -ne [string]$state.before.$name.value) { throw 'Proxy changed during connection preparation' }
  }
  $pem=Get-Content -LiteralPath $state.certificateFile -Raw -Encoding UTF8
  $encoded=$pem -replace '-----BEGIN CERTIFICATE-----','' -replace '-----END CERTIFICATE-----','' -replace '\s',''
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($encoded))
  if ($certificate.GetNameInfo(0,$false) -ne $state.certificateName -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotAfter -gt (Get-Date).AddYears(2).AddDays(2)) { throw '证书身份或有效期不符合连接约定' }
  if ($state.certificateFingerprint) {
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $fingerprint=[BitConverter]::ToString($hash.ComputeHash($certificate.RawData)).Replace('-',':') } finally { $hash.Dispose() }
    if ($fingerprint -ne $state.certificateFingerprint) { throw '证书与本次连接记录不一致' }
  }
  $store = Open-Root
  try {
    $present = @($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint).Count -gt 0
  } finally { $store.Close() }
  $state.certificateThumbprint=$certificate.Thumbprint; $state.certificateAdded=(-not $present); $state.phase='applying'; Save-State $state
  if (-not $present) { $script:taskStage='certificate-add';Update-Certificate $true $certificate }
  $store = Open-Root
  try { if (@($store.Certificates | Where-Object Thumbprint -eq $certificate.Thumbprint).Count -eq 0) { throw '本机专用证书尚未完成信任，未切换代理' } } finally { $store.Close() }
  $script:taskStage='proxy-apply'
  Set-ItemProperty -LiteralPath $registryPath -Name ProxyServer -Value $state.proxyAddress
  Set-ItemProperty -LiteralPath $registryPath -Name ProxyEnable -Value 1
  Notify-Proxy
  $state.phase='active'; Save-State $state
  @{active=$true} | ConvertTo-Json -Compress
  exit
}
if ($Action -eq 'restore') { $state=Restore-State; @{restored=($state.phase -eq 'restored')} | ConvertTo-Json -Compress; exit }
if ($Action -eq 'guard') {
  [IO.File]::WriteAllText(($StateFile + '.guard-ready'),'ready')
  while ($true) {
    try {
      $state=Read-State
      if ($state.phase -eq 'restored') { exit }
      $owner=Get-Process -Id $state.owner -ErrorAction SilentlyContinue
      if (-not $owner -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.ownerStarted) { $null=Restore-State; exit }
    } catch { Start-Sleep -Seconds 1; continue }
    Start-Sleep -Seconds 1
  }
}
