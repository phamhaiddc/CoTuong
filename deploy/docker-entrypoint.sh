#!/bin/sh
# Khởi động container app: áp dụng migration cơ sở dữ liệu (mặc định bật) rồi chạy server.
# Chạy nhiều bản app cùng lúc: đặt RUN_MIGRATIONS=false cho các bản phụ (prisma migrate deploy dùng khoá của Postgres
# nên chạy đồng thời vẫn an toàn, nhưng không cần thiết).
set -e
cd /app/apps/server
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[vuaco] Áp dụng migration cơ sở dữ liệu…"
  npx --no-install prisma migrate deploy
fi
exec node --enable-source-maps dist/main.js
