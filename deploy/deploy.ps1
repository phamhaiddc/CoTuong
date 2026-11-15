# Đưa Xe Pháo Mã lên VPS (chạy trên máy Windows): nén mã → gửi lên VPS → chạy deploy/server.sh trên VPS.
# Lần đầu: server.sh cài Docker, hỏi vài câu (tên miền, Gmail…), chạy web. Các lần sau: tự cập nhật bản mới.
# Cách dùng: bấm đúp deploy.cmd ở thư mục dự án (xem DEPLOY.md).
# Cần: OpenSSH client của Windows (có sẵn trên Windows 10/11: lệnh ssh và scp).

$root = Split-Path -Parent $PSScriptRoot
$lastFile = Join-Path $PSScriptRoot '.last-server'

foreach ($cmd in 'ssh', 'scp', 'tar') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Không tìm thấy lệnh '$cmd'. Bật OpenSSH Client: Settings → Apps → Optional features → OpenSSH Client." -ForegroundColor Red
    exit 1
  }
}

$last = if (Test-Path $lastFile) { (Get-Content $lastFile -Raw).Trim() } else { '' }
Write-Host 'Địa chỉ VPS dạng  user@IP  (vd root@103.20.30.40). Nhà cung cấp VPS gửi user, IP và mật khẩu qua email.'
$server = Read-Host ("VPS" + $(if ($last) { " [$last]" } else { '' }))
if (-not $server) { $server = $last }
if ($server -notmatch '^[^@\s]+@[^@\s]+$') { Write-Host 'Địa chỉ chưa đúng dạng user@IP.' -ForegroundColor Red; exit 1 }
Set-Content -Path $lastFile -Value $server -Encoding ascii

$archive = Join-Path $env:TEMP 'vuaco.tgz'
Write-Host "`n== 1/3 Nén mã nguồn (bỏ node_modules, dist, .env — tệp mật khẩu của máy dev KHÔNG được gửi đi)" -ForegroundColor Cyan
tar -czf $archive --exclude=node_modules --exclude=dist --exclude=.env --exclude=deploy/prod.env --exclude=deploy/.last-server -C $root .
if ($LASTEXITCODE -ne 0) { Write-Host 'Nén mã thất bại.' -ForegroundColor Red; exit 1 }
Write-Host ("   {0:N1} MB" -f ((Get-Item $archive).Length / 1MB))

Write-Host "`n== 2/3 Gửi lên $server (nhập mật khẩu VPS nếu được hỏi)" -ForegroundColor Cyan
scp $archive "${server}:vuaco.tgz"
if ($LASTEXITCODE -ne 0) { Write-Host 'Gửi tệp thất bại (sai địa chỉ / mật khẩu, hoặc VPS chưa mở cổng 22).' -ForegroundColor Red; exit 1 }

Write-Host "`n== 3/3 Cài đặt / cập nhật trên VPS (nhập mật khẩu VPS lần nữa nếu được hỏi)" -ForegroundColor Cyan
# Giữ deploy/prod.env (cấu hình + mật khẩu trên VPS); bỏ mã cũ để tệp đã xoá ở bản mới không sót lại
$remote = 'set -e; mkdir -p ~/vuaco; cd ~/vuaco; rm -rf apps packages; tar -xzf ~/vuaco.tgz -C ~/vuaco; sed -i ''s/\r$//'' deploy/server.sh deploy/docker-entrypoint.sh; bash deploy/server.sh'
ssh -t $server $remote
if ($LASTEXITCODE -ne 0) { Write-Host "`nCó lỗi trên VPS (xem thông báo ở trên)." -ForegroundColor Red; exit 1 }
Write-Host "`nXong." -ForegroundColor Green
