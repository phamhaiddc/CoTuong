# syntax=docker/dockerfile:1
# Ảnh production của Xe Pháo Mã: MỘT tiến trình Node phục vụ API + WebSocket + giao diện web đã build.
# Dùng với docker-compose.prod.yml (kèm PostgreSQL, Redis, S3, Caddy HTTPS) — xem README mục "Triển khai bằng Docker".

# Node 22 LTS (được vá bảo mật tới 30/04/2027; Node 20 đã hết hỗ trợ 30/04/2026). Thẻ "22" luôn trỏ bản vá mới nhất
# của dòng 22 → khi cập nhật nên build với --pull để lấy bản vá (README mục "Triển khai bằng Docker", bước 8).

# ---------- Bước build: cài thư viện, build packages + server (kèm prisma generate) + web
FROM node:22-bookworm-slim AS build
# Prisma cần OpenSSL
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Chép package.json trước để Docker giữ lớp cache "npm ci" khi chỉ sửa mã nguồn
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/game-core/package.json packages/game-core/
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build

# ---------- Ảnh chạy
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
# Giữ nguyên node_modules (cần Prisma CLI để chạy migration lúc khởi động) + mã đã build
COPY --from=build /app /app
COPY deploy/docker-entrypoint.sh /usr/local/bin/vuaco-entrypoint
# Bỏ ký tự CR (tệp sửa trên Windows) để /bin/sh chạy được
RUN tr -d '\015' < /usr/local/bin/vuaco-entrypoint > /tmp/entry && mv /tmp/entry /usr/local/bin/vuaco-entrypoint && chmod 755 /usr/local/bin/vuaco-entrypoint && chown -R node:node /app/apps/server
USER node
WORKDIR /app/apps/server
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "vuaco-entrypoint"]
