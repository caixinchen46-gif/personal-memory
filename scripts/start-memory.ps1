$ErrorActionPreference = 'Stop'
$memoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $memoryRoot
$env:PM_DB_PATH = Join-Path $memoryRoot 'data\memory.db'
$env:PM_RUNTIME_CONFIG = Join-Path $memoryRoot 'data\runtime\connection.json'
& node --import tsx (Join-Path $memoryRoot 'src\server.ts')
exit $LASTEXITCODE
