#!/usr/bin/env bash
# Đưa Xe Pháo Mã lên VPS từ máy Linux / macOS (bản tương đương deploy.cmd của Windows):
# nén mã → gửi lên VPS → chạy deploy/server.sh trên VPS. Lần đầu: cài Docker, hỏi vài câu, chạy web. Lần sau: cập nhật.
# Cách dùng: mở Terminal ở thư mục dự án, gõ   bash deploy.sh   (xem DEPLOY.md).
# Cần: ssh, scp, tar (Ubuntu / Debian: sudo apt install openssh-client tar).
# Đang ở ngay trên VPS (mã nguồn đã nằm trên VPS)? Không cần tệp này: chạy   bash deploy/server.sh
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -uo pipefail

red() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
last_file="$root/deploy/.last-server"

for cmd in ssh scp tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "Không tìm thấy lệnh '$cmd'. Ubuntu / Debian: sudo apt install openssh-client tar"
    exit 1
  fi
done

last=""
[ -f "$last_file" ] && last="$(tr -d '\r\n ' < "$last_file")"
echo 'Địa chỉ VPS dạng  user@IP  (vd root@103.20.30.40). Nhà cung cấp VPS gửi user, IP và mật khẩu qua email.'
read -r -p "VPS${last:+ [$last]}: " server
server="${server:-$last}"
if ! [[ "$server" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  red 'Địa chỉ chưa đúng dạng user@IP.'
  exit 1
fi
printf '%s\n' "$server" > "$last_file"

archive="$(mktemp "${TMPDIR:-/tmp}/vuaco.XXXXXX")"
trap 'rm -f "$archive"' EXIT

step '1/3 Nén mã nguồn (bỏ node_modules, dist, .env — tệp mật khẩu của máy dev KHÔNG được gửi đi)'
# COPYFILE_DISABLE: macOS không chèn tệp ._* vào bản nén
if ! COPYFILE_DISABLE=1 tar -czf "$archive" \
  --exclude=node_modules --exclude=dist --exclude=.env --exclude=.git \
  --exclude=./deploy/prod.env --exclude=deploy/prod.env \
  --exclude=./deploy/.last-server --exclude=deploy/.last-server \
  -C "$root" .; then
  red 'Nén mã thất bại.'
  exit 1
fi
echo "   $(du -h "$archive" | cut -f1)"

step "2/3 Gửi lên $server (nhập mật khẩu VPS nếu được hỏi)"
if ! scp "$archive" "$server:vuaco.tgz"; then
  red 'Gửi tệp thất bại (sai địa chỉ / mật khẩu, hoặc VPS chưa mở cổng 22).'
  exit 1
fi

step '3/3 Cài đặt / cập nhật trên VPS (nhập mật khẩu VPS lần nữa nếu được hỏi)'
# Giữ deploy/prod.env (cấu hình + mật khẩu trên VPS); bỏ mã cũ để tệp đã xoá ở bản mới không sót lại
remote="set -e; mkdir -p ~/vuaco; cd ~/vuaco; rm -rf apps packages; tar -xzf ~/vuaco.tgz -C ~/vuaco; sed -i 's/\r\$//' deploy/server.sh deploy/docker-entrypoint.sh; bash deploy/server.sh"
if ! ssh -t "$server" "$remote"; then
  red $'\nCó lỗi trên VPS (xem thông báo ở trên).'
  exit 1
fi
printf '\n\033[1;32mXong.\033[0m\n'
