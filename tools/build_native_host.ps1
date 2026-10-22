param([string]$OutputPath = "dist/conf/FB_bridge_host.exe")
$ErrorActionPreference = "Stop"
$taskProject = Split-Path -Parent $PSScriptRoot
$taskOutput = [IO.Path]::GetFullPath($OutputPath)
$taskCompiler = Join-Path $env:WINDIR "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
if (-not (Test-Path -LiteralPath $taskCompiler)) {
    $taskCompiler = Join-Path $env:WINDIR "Microsoft.NET/Framework/v4.0.30319/csc.exe"
}
if (-not (Test-Path -LiteralPath $taskCompiler)) {
    throw "Windows .NET Framework 4.x C# compiler is required to build the native host."
}
New-Item -ItemType Directory -Path (Split-Path -Parent $taskOutput) -Force | Out-Null
& $taskCompiler /nologo /target:winexe /platform:anycpu /optimize+ /debug- /warnaserror+ `
    /reference:System.Security.dll /reference:System.Runtime.Serialization.dll `
    "/out:$taskOutput" (Join-Path $taskProject "native_host/BridgeHost.cs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Windowless native host built: $taskOutput"
