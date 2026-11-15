# Builds dist\Emdedown.exe — one self-contained file.
# Needs: Node.js (build time only) and the C# compiler that ships with Windows (.NET Framework 4.x).
param([switch]$SkipWeb)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$web = Join-Path $root 'web'
$obj = Join-Path $root 'obj'
$dist = Join-Path $root 'dist'
$wv = Join-Path $root '.deps\webview2\pkg'
$wvVersion = '1.0.4129.50'
# SHA-256 of microsoft.web.webview2.1.0.4129.50.nupkg. Update together with $wvVersion.
$wvSha256 = 'D3934F482D484B89FB4825DF720C710664E1143A1E90F7B3A60794EF33F473D2'

# 1. WebView2 SDK (from nuget.org, once)
if (-not (Test-Path "$wv\lib\net462\Microsoft.Web.WebView2.Core.dll")) {
    Write-Host 'Fetching WebView2 SDK...'
    $d = Join-Path $root '.deps\webview2'
    New-Item -ItemType Directory -Force $d | Out-Null
    $pkg = Join-Path $d 'pkg.zip'
    if (-not (Test-Path $pkg)) {
        Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wvVersion/microsoft.web.webview2.$wvVersion.nupkg" -OutFile $pkg
    }
    $hash = (Get-FileHash $pkg -Algorithm SHA256).Hash
    if ($hash -ne $wvSha256) {
        Remove-Item -Force $pkg -ErrorAction SilentlyContinue
        throw "WebView2 package hash mismatch (expected $wvSha256, got $hash). The download was removed; not building."
    }
    Expand-Archive $pkg $wv -Force
}

# 2. Web UI bundle
if (-not $SkipWeb) {
    Push-Location $web
    try {
        if (-not (Test-Path 'node_modules')) { npm ci --no-fund --no-audit; if ($LASTEXITCODE) { throw 'npm ci failed' } }
        node build.mjs
        if ($LASTEXITCODE) { throw 'web build failed' }
    } finally { Pop-Location }
}

# 3. Stage compressed resources
Remove-Item -Recurse -Force $obj -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$obj\res" | Out-Null
$resArgs = New-Object System.Collections.Generic.List[string]
$distWeb = Join-Path $web 'dist'
Get-ChildItem $distWeb -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($distWeb.Length + 1).Replace('\', '/')
    $gzPath = Join-Path "$obj\res" ([guid]::NewGuid().ToString('N') + '.gz')
    $in = [System.IO.File]::OpenRead($_.FullName)
    $out = [System.IO.File]::Create($gzPath)
    $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
    $in.CopyTo($gz); $gz.Close(); $in.Close()
    $resArgs.Add("/resource:`"$gzPath`",web/$rel.gz")
}
$resArgs.Add("/resource:`"$wv\lib\net462\Microsoft.Web.WebView2.Core.dll`",lib/Microsoft.Web.WebView2.Core.dll")
$resArgs.Add("/resource:`"$wv\lib\net462\Microsoft.Web.WebView2.WinForms.dll`",lib/Microsoft.Web.WebView2.WinForms.dll")
# The user guide (opened from inside the app); keep this list in step with GuideFiles in src\MainForm.cs.
foreach ($g in 'Guide.md', 'Welcome.md', 'images/emdedown-logo.svg') { $resArgs.Add("/resource:`"$root\samples\$($g.Replace('/', '\'))`",guide/$g") }
foreach ($a in 'x64', 'x86', 'arm64') { $resArgs.Add("/resource:`"$wv\runtimes\win-$a\native\WebView2Loader.dll`",native/$a/WebView2Loader.dll") }

# 4. Compile
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fw 'csc.exe'
New-Item -ItemType Directory -Force $dist | Out-Null
$rsp = @(
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/debug-', '/utf8output',
    "/out:`"$dist\Emdedown.exe`"",
    "/win32icon:`"$root\src\app.ico`"",
    "/win32manifest:`"$root\src\app.manifest`"",
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll', '/r:System.IO.Compression.dll', "/r:`"$fw\System.IO.Compression.FileSystem.dll`"",
    "/r:`"$wv\lib\net462\Microsoft.Web.WebView2.Core.dll`"", "/r:`"$wv\lib\net462\Microsoft.Web.WebView2.WinForms.dll`""
) + $resArgs + (Get-ChildItem "$root\src\*.cs" | ForEach-Object { "`"$($_.FullName)`"" })
$rspFile = Join-Path $obj 'build.rsp'
[System.IO.File]::WriteAllLines($rspFile, $rsp)
& $csc "@$rspFile"
if ($LASTEXITCODE) { throw 'C# compile failed' }
$size = (Get-Item "$dist\Emdedown.exe").Length / 1MB
Write-Host ("Built dist\Emdedown.exe ({0:N2} MB)" -f $size) -ForegroundColor Green
