# Bật môi trường phát triển Xe Pháo Mã trên máy Windows:
#   1. Docker Desktop + các container (PostgreSQL, Redis, S3, Mailpit) — docker-compose.yml
#   2. Build các package + server
#   3. API (cổng 3000) và web (cổng 5173), mỗi cái một cửa sổ PowerShell riêng (đóng cửa sổ = tắt)
# Cách dùng: bấm đúp start-dev.cmd (hoặc: powershell -ExecutionPolicy Bypass -File .\start-dev.ps1)
# Chỉ "docker compose up" thì KHÔNG đủ: Docker chỉ chạy cơ sở dữ liệu / Redis / S3 / Mailpit, còn API và web là hai
# chương trình Node chạy riêng.

$root = $PSScriptRoot
$dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host '== 1/3 Docker' -ForegroundColor Cyan
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  if (-not (Test-Path $dockerExe)) { Write-Host "Không tìm thấy Docker Desktop ở $dockerExe — hãy mở Docker Desktop rồi chạy lại." -ForegroundColor Red; exit 1 }
  Write-Host 'Đang bật Docker Desktop (có thể mất 1-2 phút)...'
  Start-Process $dockerExe
  $t0 = Get-Date
  do {
    Start-Sleep -Seconds 3
    docker info *> $null
  } until ($LASTEXITCODE -eq 0 -or ((Get-Date) - $t0).TotalSeconds -gt 240)
  if ($LASTEXITCODE -ne 0) { Write-Host 'Docker chưa sẵn sàng sau 4 phút. Mở Docker Desktop xem có lỗi gì rồi chạy lại.' -ForegroundColor Red; exit 1 }
}
docker compose -f "$root\docker-compose.yml" up -d
if ($LASTEXITCODE -ne 0) { Write-Host 'Không bật được các container.' -ForegroundColor Red; exit 1 }

Write-Host '== 2/3 Build' -ForegroundColor Cyan
Push-Location $root
npm run build:packages
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'Build các package bị lỗi.' -ForegroundColor Red; exit 1 }
Push-Location "$root\apps\server"
npx nest build
$buildOk = $LASTEXITCODE -eq 0
Pop-Location
Pop-Location
if (-not $buildOk) { Write-Host 'Build server bị lỗi.' -ForegroundColor Red; exit 1 }

Write-Host '== 3/3 API + web' -ForegroundColor Cyan
if (Test-Port 3000) {
  Write-Host 'API (cổng 3000) đang chạy rồi — giữ nguyên. Muốn chạy bản vừa build: đóng cửa sổ API cũ rồi chạy lại file này.'
} else {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Xe Phao Ma - API :3000'; Set-Location '$root\apps\server'; node --enable-source-maps dist/main.js"
}
if (Test-Port 5173) {
  Write-Host 'Web (cổng 5173) đang chạy rồi — giữ nguyên.'
} else {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Xe Phao Ma - Web :5173'; Set-Location '$root'; npm run dev:web"
}

Write-Host ''
Write-Host 'Xong. Chờ khoảng 1 phút rồi mở http://localhost:5173' -ForegroundColor Green
Write-Host 'Tắt: đóng hai cửa sổ "Xe Phao Ma - API" và "Xe Phao Ma - Web". Thư thử ở dev: http://localhost:8025 (Mailpit).'
