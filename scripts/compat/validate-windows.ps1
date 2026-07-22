$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$versions = @{}
Get-Content (Join-Path $PSScriptRoot 'versions.env') | ForEach-Object {
  if ($_ -match '^([^=]+)=(.+)$') { $versions[$Matches[1]] = $Matches[2] }
}
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = [System.IO.Path]::GetFullPath((Join-Path $tempRoot 'proxyhub-compat'))
if (-not $work.StartsWith($tempRoot) -or (Split-Path $work -Leaf) -ne 'proxyhub-compat') {
  throw 'Unsafe compatibility work directory'
}
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$bin = New-Item -ItemType Directory -Path (Join-Path $work 'bin')
$config = New-Item -ItemType Directory -Path (Join-Path $work 'config')
$mihomoHome = New-Item -ItemType Directory -Path (Join-Path $work 'mihomo-home')

function Get-VerifiedArchive([string]$Url, [string]$Path, [string]$ExpectedHash) {
  Invoke-WebRequest -Uri $Url -OutFile $Path
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedHash) { throw "Checksum mismatch for $Path" }
}

$mihomoArchive = Join-Path $work $versions.MIHOMO_WINDOWS_ASSET
Get-VerifiedArchive `
  "https://github.com/MetaCubeX/mihomo/releases/download/$($versions.MIHOMO_VERSION)/$($versions.MIHOMO_WINDOWS_ASSET)" `
  $mihomoArchive $versions.MIHOMO_WINDOWS_SHA256
Expand-Archive -LiteralPath $mihomoArchive -DestinationPath $bin
$mihomo = (Get-ChildItem -LiteralPath $bin -Filter 'mihomo*.exe' -Recurse | Select-Object -First 1).FullName

$singArchive = Join-Path $work $versions.SING_BOX_WINDOWS_ASSET
Get-VerifiedArchive `
  "https://github.com/SagerNet/sing-box/releases/download/v$($versions.SING_BOX_VERSION)/$($versions.SING_BOX_WINDOWS_ASSET)" `
  $singArchive $versions.SING_BOX_WINDOWS_SHA256
Expand-Archive -LiteralPath $singArchive -DestinationPath $bin
$singBox = (Get-ChildItem -LiteralPath $bin -Filter 'sing-box.exe' -Recurse | Select-Object -First 1).FullName

Push-Location $root
try {
  pnpm compat:generate --output $config.FullName
  & $mihomo -v
  & $singBox version
  & $mihomo -t -f (Join-Path $config.FullName 'mihomo.yaml') -d $mihomoHome.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Mihomo validation failed' }
  & $singBox check -c (Join-Path $config.FullName 'sing-box.json')
  if ($LASTEXITCODE -ne 0) { throw 'sing-box validation failed' }
  Write-Host "Validated against Mihomo $($versions.MIHOMO_VERSION) and sing-box $($versions.SING_BOX_VERSION)."
} finally {
  Pop-Location
}
