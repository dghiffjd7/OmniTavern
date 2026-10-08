param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Repo = "",
  [string]$KeystorePath = "",
  [string]$KeystoreAlias = "",
  [string]$KeystorePass = "",
  [string]$KeyPass = "",
  # 桌面自动更新签名私钥（tauri signer generate 生成）；丢失后已安装版本将无法验证后续更新
  [string]$UpdaterKeyPath = (Join-Path $env:USERPROFILE ".tauri\omnitavern-updater.key"),
  [switch]$SkipPreflight,
  [switch]$SkipBuild,
  [switch]$SkipSign,
  [switch]$SkipAndroid,
  [switch]$SkipWindows,
  [switch]$SkipRelease
)

$ErrorActionPreference = "Stop"

function Get-PlainText([Security.SecureString]$secure) {
  if (-not $secure) { return "" }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Invoke-ExternalCommand([string]$FailureMessage, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage，退出码 $LASTEXITCODE"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# 取 CHANGELOG.md 中「## v版本号」一节作为发布说明
function Get-ChangelogSection([string]$Path, [string]$TargetVersion) {
  if (-not (Test-Path $Path)) { return "" }
  $lines = [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)
  $collecting = $false
  $section = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match '^##\s+v?([0-9A-Za-z.\-+]+)') {
      if ($collecting) { break }
      if ($Matches[1] -eq $TargetVersion) { $collecting = $true; continue }
    }
    if ($collecting) { $section.Add($line) }
  }
  return ($section -join "`n").Trim()
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$tag = "v$Version"
$isPrerelease = $Version -match '-'
$repoSlug = if ($Repo) { $Repo } else { "dghiffjd7/OmniTavern" }
$distDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# 自动更新按版本号比较：发布版本必须与打包配置一致
$configVersion = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($configVersion -ne $Version) {
  throw "tauri.conf.json 版本为 $configVersion，与发布版本 $Version 不一致。"
}

$changelogPath = Join-Path $root "src\assets\CHANGELOG.md"
$notes = Get-ChangelogSection $changelogPath $Version
if ($isPrerelease) {
  if (-not $notes) { $notes = "预览版 $Version（不会推送给正式版用户）" }
} elseif (-not $notes -or $notes -match '待补充') {
  throw "正式版需要在 src\assets\CHANGELOG.md 写好「## v$Version」一节的实际内容。"
}

if (-not $SkipPreflight) {
  Write-Host "[1/5] 发布前检查..."
  Invoke-ExternalCommand "发布前检查失败" { npm run test:all }
  Invoke-ExternalCommand "Rust ZIP contract 检查失败" { npm run test:rust:zip }
}

$releaseAssets = New-Object System.Collections.Generic.List[string]

if (-not $SkipAndroid) {
  if (-not $SkipBuild) {
    Write-Host "[2/5] 构建 APK..."
    Invoke-ExternalCommand "构建失败" { npm run android:build }
  }

  $apkInputCandidates = @(
    (Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"),
    (Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk")
  )
  $apkInputItem = $apkInputCandidates `
    | Where-Object { Test-Path $_ } `
    | ForEach-Object { Get-Item $_ } `
    | Sort-Object LastWriteTime -Descending `
    | Select-Object -First 1
  if ($apkInputItem) {
    $apkInput = $apkInputItem.FullName
  }
  if (-not $apkInput) {
    $fallback = $apkInputCandidates -join "; "
    throw "未找到 APK：$fallback"
  }

  $alignedApk = Join-Path $distDir "app-universal-release-aligned.apk"
  $signedApk = Join-Path $distDir "app-universal-release.apk"

  if (-not $SkipSign) {
    Write-Host "[3/5] 对齐并签名 APK..."

    if (-not $env:ANDROID_HOME) {
      throw "ANDROID_HOME 未设置。"
    }

    $buildToolsRoot = Join-Path $env:ANDROID_HOME "build-tools"
    $buildTools = Get-ChildItem $buildToolsRoot -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $buildTools) {
      throw "未找到 build-tools，请安装 Android SDK Build-Tools。"
    }

    $zipalign = Join-Path $buildTools.FullName "zipalign.exe"
    $apksigner = Join-Path $buildTools.FullName "apksigner.bat"

    if (-not (Test-Path $zipalign)) { throw "未找到 zipalign：$zipalign" }
    if (-not (Test-Path $apksigner)) { throw "未找到 apksigner：$apksigner" }

    if (-not $KeystorePath) {
      $KeystorePath = Read-Host "请输入 keystore 路径"
    }
    if (-not (Test-Path $KeystorePath)) {
      throw "keystore 不存在：$KeystorePath"
    }
    if (-not $KeystoreAlias) {
      $KeystoreAlias = Read-Host "请输入 keystore alias"
    }
    if (-not $KeystorePass) {
      $KeystorePass = Get-PlainText (Read-Host "请输入签名密码（APK keystore 与 Windows 更新签名共用）" -AsSecureString)
    }
    if (-not $KeyPass) {
      $KeyPass = Get-PlainText (Read-Host "请输入 key 密码(回车沿用 keystore 密码)" -AsSecureString)
      if (-not $KeyPass) { $KeyPass = $KeystorePass }
    }

    Remove-Item -Force -ErrorAction SilentlyContinue $alignedApk, $signedApk, "$signedApk.idsig"
    Invoke-ExternalCommand "zipalign 失败" { & $zipalign -f -v 4 $apkInput $alignedApk }
    Invoke-ExternalCommand "apksigner 失败" { & $apksigner sign --ks $KeystorePath --ks-key-alias $KeystoreAlias --ks-pass "pass:$KeystorePass" --key-pass "pass:$KeyPass" --out $signedApk $alignedApk }
    Invoke-ExternalCommand "apksigner verify 失败" { & $apksigner verify --verbose $signedApk }
  } else {
    Copy-Item $apkInput $signedApk -Force
  }

  # 对外资产名与 README 一致；APP 更新检查按 .apk 后缀找下载地址
  $publishedApk = Join-Path $distDir "OmniTavern_$Version.apk"
  Copy-Item $signedApk $publishedApk -Force
  $releaseAssets.Add($publishedApk)
}

if (-not $SkipWindows) {
  $bundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
  if (-not $SkipBuild) {
    Write-Host "[4/5] 构建 Windows 安装包（含自动更新签名）..."
    if (-not (Test-Path $UpdaterKeyPath)) {
      throw "未找到自动更新签名私钥：$UpdaterKeyPath"
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $UpdaterKeyPath -Raw
    # 与 APK keystore 共用同一个密码：前面已输入就直接沿用，只问一次
    $presetUpdaterPass = [bool]$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    if (-not $presetUpdaterPass) {
      if (-not $KeystorePass) {
        $KeystorePass = Get-PlainText (Read-Host "请输入签名密码（APK keystore 与 Windows 更新签名共用）" -AsSecureString)
      }
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeystorePass
    }
    try {
      Invoke-ExternalCommand "Windows 构建失败" { npm run build -- --config src-tauri/tauri.release.conf.json }
    } finally {
      Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
      if (-not $presetUpdaterPass) { Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }
    }
  }

  $setup = Join-Path $bundleDir "OmniTavern_${Version}_x64-setup.exe"
  $signature = "$setup.sig"
  if (-not (Test-Path $setup)) { throw "未找到 Windows 安装包：$setup" }
  if (-not (Test-Path $signature)) { throw "未找到自动更新签名：$signature（需用 tauri.release.conf.json 构建）" }
  $publishedSetup = Join-Path $distDir (Split-Path $setup -Leaf)
  Copy-Item $setup $publishedSetup -Force
  $releaseAssets.Add($publishedSetup)

  if (-not $isPrerelease) {
    # 桌面 updater 端点固定为 releases/latest/download/latest.json，只随正式版发布
    $latest = [ordered]@{
      version = $Version
      notes = $notes
      pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
      platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
          signature = (Get-Content $signature -Raw).Trim()
          url = "https://github.com/$repoSlug/releases/download/$tag/$(Split-Path $setup -Leaf)"
        }
      }
    }
    $latestJson = Join-Path $distDir "latest.json"
    Write-Utf8NoBom $latestJson ($latest | ConvertTo-Json -Depth 5)
    $releaseAssets.Add($latestJson)
  }
}

if (-not $SkipRelease) {
  Write-Host "[5/5] 发布 GitHub Release..."
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "未找到 gh CLI，请先安装并完成 gh auth login。"
  }
  if (-not $releaseAssets.Count) { throw "没有可上传的资产。" }

  $repoArg = @()
  if ($Repo) { $repoArg = @("--repo", $Repo) }
  $notesFile = Join-Path $distDir "release-notes-$Version.md"
  Write-Utf8NoBom $notesFile $notes

  $exists = $false
  try {
    gh release view $tag @repoArg | Out-Null
    $exists = ($LASTEXITCODE -eq 0)
  } catch {}

  if ($exists) {
    Invoke-ExternalCommand "上传资产失败" { gh release upload $tag @releaseAssets --clobber @repoArg }
  } else {
    # 预览版标记为 prerelease，APP 只提示正式版，releases/latest 也始终指向正式版
    $channelArg = if ($isPrerelease) { @("--prerelease") } else { @("--latest") }
    Invoke-ExternalCommand "创建 Release 失败" { gh release create $tag @releaseAssets --title $tag --notes-file $notesFile @channelArg @repoArg }
  }
}

Write-Host "完成：$($releaseAssets -join '; ')"
