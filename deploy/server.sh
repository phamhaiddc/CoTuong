#!/usr/bin/env bash
# Cài / cập nhật Xe Pháo Mã trên VPS Linux (Ubuntu / Debian) — chạy trong thư mục dự án đã giải nén (~/vuaco):
#   bash deploy/server.sh            lần đầu: cài Docker, hỏi vài câu, tạo deploy/prod.env, chạy web, tạo máy chơi, cấp admin
#                                    các lần sau (đã có deploy/prod.env): build lại và chạy bản mới (cập nhật)
#   bash deploy/server.sh backup     sao lưu cơ sở dữ liệu ra ~/vuaco-backup-<ngày>.sql
#   bash deploy/server.sh admin      cấp quyền admin cho một email (tài khoản phải đăng ký trên web trước)
#   bash deploy/server.sh logs       xem log của app (Ctrl+C để thoát)
# Thường không cần gọi trực tiếp: trên máy Windows bấm đúp deploy.cmd, trên Linux / macOS chạy bash deploy.sh (xem DEPLOY.md).
#
# Biến môi trường cho chạy tự động / thử nghiệm (không bắt buộc):
#   NONINTERACTIVE=1  không hỏi gì, lấy giá trị từ biến DOMAIN, SMTP_USER, SMTP_PASS, GOOGLE_CLIENT_ID, ...
#   SKIP_DOCKER_INSTALL=1, SKIP_FIREWALL=1, SKIP_SWAP=1, ENV_ONLY=1 (chỉ tạo deploy/prod.env rồi dừng)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="${ENV_FILE:-deploy/prod.env}"
COMPOSE_FILE="docker-compose.prod.yml"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31m%s\033[0m\n' "$*" >&2
  exit 1
}

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "Không chạy bằng root và không có sudo: các bước cần quyền root (cài Docker, swap, tường lửa) có thể lỗi."
  fi
fi

# docker có thể cần sudo nếu người dùng chưa vào nhóm docker
dk() {
  if docker info >/dev/null 2>&1; then docker "$@"; else $SUDO docker "$@"; fi
}
dc() { dk compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Chuỗi ngẫu nhiên dạng hex (không cần openssl)
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ask() { # ask <tên biến> <câu hỏi> [mặc định] — giữ giá trị đã có trong biến môi trường khi NONINTERACTIVE=1
  local var="$1" q="$2" def="${3:-}" ans
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    printf -v "$var" '%s' "${!var:-$def}"
    return
  fi
  if [ -n "$def" ]; then read -r -p "$q [$def]: " ans; else read -r -p "$q: " ans; fi
  printf -v "$var" '%s' "${ans:-$def}"
}

ask_secret() { # như ask nhưng không hiện ký tự gõ
  local var="$1" q="$2" ans
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    printf -v "$var" '%s' "${!var:-}"
    return
  fi
  read -r -s -p "$q: " ans
  echo
  printf -v "$var" '%s' "$ans"
}

# Ghi giá trị vào tệp env trong nháy đơn (Docker Compose: không hiểu $ trong nháy đơn là biến)
q1() {
  case "$1" in
    *"'"*) die "Giá trị không được chứa dấu nháy đơn ('): $1" ;;
  esac
  printf "'%s'" "$1"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && dk compose version >/dev/null 2>&1; then
    ok "Docker đã có: $(dk --version)"
    return
  fi
  say "Cài Docker (script chính thức get.docker.com)"
  command -v curl >/dev/null 2>&1 || { $SUDO apt-get update -y && $SUDO apt-get install -y curl; }
  curl -fsSL https://get.docker.com | $SUDO sh
  [ -n "$SUDO" ] && $SUDO usermod -aG docker "$(id -un)" || true
  dk compose version >/dev/null 2>&1 || die "Cài Docker chưa xong (thiếu docker compose). Xem https://docs.docker.com/engine/install/"
  ok "Đã cài Docker."
}

setup_swap() {
  local mem_mb swap_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
  if [ "$mem_mb" -lt 1900 ] && [ "$swap_mb" -lt 1000 ] && [ ! -f /swapfile ]; then
    say "Máy có ${mem_mb} MB RAM — tạo thêm swap 2 GB để build không bị thiếu bộ nhớ"
    $SUDO fallocate -l 2G /swapfile || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048
    $SUDO chmod 600 /swapfile
    $SUDO mkswap /swapfile >/dev/null
    $SUDO swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
    ok "Đã tạo swap 2 GB."
  fi
}

open_firewall() {
  # Chỉ thêm luật khi tường lửa ufw ĐANG bật (không tự bật ufw — có thể khoá luôn SSH)
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Mở cổng 80 và 443 trên tường lửa ufw"
    $SUDO ufw allow 22/tcp >/dev/null
    $SUDO ufw allow 80/tcp >/dev/null
    $SUDO ufw allow 443/tcp >/dev/null
    $SUDO ufw allow 443/udp >/dev/null
    ok "Đã mở cổng."
  fi
  warn "Nhớ mở cổng 80 và 443 cả ở tường lửa trên trang quản lý của nhà cung cấp VPS (nếu có)."
}

write_env() {
  say "Cấu hình (Enter để dùng giá trị trong [ngoặc] hoặc bỏ qua mục tuỳ chọn)"
  # Không khai báo local: khi NONINTERACTIVE=1 các giá trị lấy từ biến môi trường cùng tên
  DOMAIN="${DOMAIN:-}"
  SMTP_USER="${SMTP_USER:-}"
  SMTP_PASS="${SMTP_PASS:-}"
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
  FACEBOOK_APP_ID="${FACEBOOK_APP_ID:-}"
  FACEBOOK_APP_SECRET="${FACEBOOK_APP_SECRET:-}"

  while :; do
    ask DOMAIN "Tên miền của web (vd xephaoma.vn hoặc choi.xephaoma.vn)"
    DOMAIN="${DOMAIN#http://}"
    DOMAIN="${DOMAIN#https://}"
    DOMAIN="${DOMAIN%%/*}"
    if [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || [ "$DOMAIN" = "localhost" ]; then break; fi
    [ "${NONINTERACTIVE:-0}" = "1" ] && die "DOMAIN không hợp lệ: '$DOMAIN'"
    warn "Tên miền chưa đúng dạng, nhập lại."
  done

  echo
  echo "Gửi email (mã đăng ký, đặt lại mật khẩu) qua Gmail: cần Mật khẩu ứng dụng 16 ký tự"
  echo "(tạo tại https://myaccount.google.com/apppasswords — tài khoản Google phải bật Xác minh 2 bước)."
  ask SMTP_USER "Địa chỉ Gmail dùng để gửi thư (Enter để bỏ qua — khi đó chưa đăng ký bằng email được)"
  if [ -n "$SMTP_USER" ]; then
    ask_secret SMTP_PASS "Mật khẩu ứng dụng Gmail (không hiện khi gõ)"
    SMTP_PASS="${SMTP_PASS// /}"
    [ -n "$SMTP_PASS" ] || die "Chưa nhập mật khẩu ứng dụng Gmail."
  fi

  echo
  echo "Đăng nhập bằng Google / Facebook (tuỳ chọn — Enter để bỏ qua, thêm sau được)."
  ask GOOGLE_CLIENT_ID "Google Client ID"
  [ -n "$GOOGLE_CLIENT_ID" ] && ask_secret GOOGLE_CLIENT_SECRET "Google Client secret (không hiện khi gõ)"
  ask FACEBOOK_APP_ID "Facebook App ID"
  [ -n "$FACEBOOK_APP_ID" ] && ask_secret FACEBOOK_APP_SECRET "Facebook App secret (không hiện khi gõ)"

  local app_url="https://${DOMAIN}"
  [ "$DOMAIN" = "localhost" ] && app_url="https://localhost${HTTPS_PORT:+:${HTTPS_PORT##*:}}"
  umask 077
  {
    echo "# Tạo bởi deploy/server.sh lúc $(date '+%Y-%m-%d %H:%M'). Chứa mật khẩu — KHÔNG chia sẻ tệp này."
    echo "# Sửa xong thì chạy lại: bash deploy/server.sh"
    echo "DOMAIN=$DOMAIN"
    echo "APP_URL=$app_url"
    echo "POSTGRES_USER=vuaco"
    echo "POSTGRES_PASSWORD=$(rand_hex 24)"
    echo "POSTGRES_DB=vuaco"
    echo "JWT_SECRET=$(rand_hex 32)"
    echo "SESSION_TTL_DAYS=7"
    if [ -n "$SMTP_USER" ]; then
      echo "SMTP_HOST=smtp.gmail.com"
      echo "SMTP_PORT=465"
      echo "SMTP_SECURE=true"
      echo "SMTP_USER=$(q1 "$SMTP_USER")"
      echo "SMTP_PASS=$(q1 "$SMTP_PASS")"
      echo "MAIL_FROM=$(q1 "Xe Pháo Mã <$SMTP_USER>")"
    else
      echo "# Chưa cấu hình gửi email: điền SMTP_* rồi chạy lại bash deploy/server.sh"
      echo "SMTP_HOST="
    fi
    echo "S3_REGION=us-east-1"
    echo "S3_BUCKET=avatars"
    echo "S3_ACCESS_KEY_ID=vuaco"
    echo "S3_SECRET_ACCESS_KEY=$(rand_hex 16)"
    echo "GOOGLE_CLIENT_ID=$(q1 "$GOOGLE_CLIENT_ID")"
    echo "GOOGLE_CLIENT_SECRET=$(q1 "$GOOGLE_CLIENT_SECRET")"
    echo "FACEBOOK_APP_ID=$(q1 "$FACEBOOK_APP_ID")"
    echo "FACEBOOK_APP_SECRET=$(q1 "$FACEBOOK_APP_SECRET")"
    [ -n "${HTTP_PORT:-}" ] && echo "HTTP_PORT=$HTTP_PORT"
    [ -n "${HTTPS_PORT:-}" ] && echo "HTTPS_PORT=$HTTPS_PORT"
    true
  } >"$ENV_FILE"
  ok "Đã tạo $ENV_FILE (mật khẩu cơ sở dữ liệu và khoá phiên được sinh ngẫu nhiên)."
}

check_domain() {
  local domain ips
  domain=$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  [ "$domain" = "localhost" ] && return
  ips=$(getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  if [ -z "$ips" ]; then
    warn "Tên miền $domain chưa trỏ về đâu (chưa có bản ghi A). HTTPS sẽ chưa chạy được cho tới khi trỏ xong."
  else
    echo "Tên miền $domain đang trỏ về: $ips"
    echo "Địa chỉ của máy này: $(hostname -I 2>/dev/null || true)"
    echo "(Hai địa chỉ trên phải khớp — nếu VPS dùng IP công khai khác, so với IP trên trang quản lý VPS.)"
  fi
}

wait_healthy() {
  say "Chờ app khởi động (lần đầu build có thể mất 5–15 phút)"
  local id status i
  for i in $(seq 1 120); do
    id=$(dc ps -q app 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$(dk inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo "?")
      [ "$status" = "healthy" ] && { ok "App đã chạy."; return 0; }
      [ "$status" = "unhealthy" ] && break
    fi
    sleep 5
  done
  warn "App chưa sẵn sàng. 50 dòng log gần nhất:"
  dc logs --tail 50 app || true
  die "Xem lỗi ở trên (hoặc chạy: bash deploy/server.sh logs)."
}

# Chạy mọi dịch vụ. Caddy chỉ khởi động khi app đã "healthy" (docker-compose.prod.yml) nên "up -d" chờ app; app không lên
# được thì "up -d" báo lỗi — wait_healthy in log của app. Chạy "up -d" lần nữa khi app đã sẵn sàng để lỗi thật của Caddy
# (vd cổng 80 / 443 đang bận) hiện ra.
start_all() {
  dc up -d || true
  wait_healthy
  dc up -d
}

promote_admin() {
  local email out
  if [ -n "${1:-}" ]; then email="$1"; else
    [ "${NONINTERACTIVE:-0}" = "1" ] && return
    echo
    echo "Mở web, ĐĂNG KÝ tài khoản của bạn (hoặc đăng nhập bằng Google), rồi nhập email đó vào đây để cấp quyền admin."
    read -r -p "Email (Enter để làm sau bằng: bash deploy/server.sh admin): " email
  fi
  [ -n "$email" ] || return 0
  while :; do
    if out=$(dc exec -T app node dist/cli/promote-admin.js "$email" 2>&1); then
      ok "$out"
      return 0
    fi
    echo "$out" | tail -1
    [ "${NONINTERACTIVE:-0}" = "1" ] && return 1
    read -r -p "Chưa thấy tài khoản này — đăng ký trên web xong thì nhấn Enter để thử lại (gõ q để bỏ qua): " ans
    [ "$ans" = "q" ] && return 0
  done
}

first_install() {
  say "Cài đặt Xe Pháo Mã lần đầu"
  [ "${SKIP_SWAP:-0}" = "1" ] || setup_swap
  [ "${SKIP_DOCKER_INSTALL:-0}" = "1" ] || install_docker
  [ "${SKIP_FIREWALL:-0}" = "1" ] || open_firewall
  write_env
  [ "${ENV_ONLY:-0}" = "1" ] && return 0
  check_domain
  say "Build và chạy (app + PostgreSQL + Redis + S3 + Caddy HTTPS)"
  dc build
  start_all
  say "Tạo 14 tài khoản máy chơi"
  dc exec -T app node dist/cli/seed-bots.js | tail -3 || warn "Chưa tạo được máy chơi — chạy lại sau: bash deploy/server.sh"
  local url
  url=$(grep -E '^APP_URL=' "$ENV_FILE" | cut -d= -f2-)
  ok "XONG! Mở $url"
  promote_admin "${ADMIN_EMAIL:-}"
}

update() {
  say "Cập nhật Xe Pháo Mã (giữ nguyên dữ liệu và $ENV_FILE)"
  dc build --pull
  start_all
  # Máy chơi: chạy lại không tạo trùng (cập nhật tên / mức nếu danh sách đổi)
  dc exec -T app node dist/cli/seed-bots.js >/dev/null 2>&1 || true
  dk image prune -f >/dev/null 2>&1 || true
  ok "Đã cập nhật xong. Mở $(grep -E '^APP_URL=' "$ENV_FILE" | cut -d= -f2-)"
}

backup() {
  local file
  file="$HOME/vuaco-backup-$(date +%Y%m%d-%H%M).sql"
  dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' >"$file"
  ok "Đã sao lưu cơ sở dữ liệu vào $file ($(du -h "$file" | cut -f1))."
}

case "${1:-}" in
  backup) backup ;;
  admin) promote_admin "${2:-}" ;;
  logs) dc logs -f --tail 100 app ;;
  "")
    if [ -f "$ENV_FILE" ]; then update; else first_install; fi
    ;;
  *) die "Lệnh không rõ: $1 (dùng: bash deploy/server.sh [backup|admin <email>|logs])" ;;
esac
