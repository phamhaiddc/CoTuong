# Xe Pháo Mã — Web game Cờ tướng & Cờ vua (TypeScript)

Cài đặt theo tài liệu **"Đặc tả tính năng – Web Game Cờ Tướng & Cờ Vua"** (07/11/2026): đăng nhập, đấu xếp hạng
(ghép trận theo điểm), phòng riêng, đấu với máy, điểm Elo theo quý, cấp bậc, Top 10 realtime, hồ sơ, xem lại ván,
quản trị cơ bản. Toàn bộ frontend + backend viết bằng TypeScript, giao diện tiếng Việt.

## Cấu trúc monorepo

```
apps/web            Frontend React + Vite. Bàn cờ vẽ bằng SVG; AI chạy trong Web Worker
apps/server         Backend NestJS: REST API + WebSocket (Socket.IO), Prisma (PostgreSQL), Redis
packages/game-core  Luật Cờ tướng, Cờ vua: nước hợp lệ, chiếu, chiếu bí, hoà, lặp nước, chiếu dai
packages/ai         AI tự viết: minimax + alpha-beta (iterative deepening, quiescence, bảng chuyển vị)
packages/shared     Kiểu dữ liệu, sự kiện realtime, Elo, cấp bậc, mùa giải, nhãn tiếng Việt
docker-compose.yml  Hạ tầng dev: PostgreSQL, Redis, object storage S3 (SeaweedFS), SMTP giả (Mailpit)
Dockerfile          Ảnh production: một tiến trình Node phục vụ API + WebSocket + giao diện web đã build
docker-compose.prod.yml  Production: app + PostgreSQL + Redis + S3 + Caddy (HTTPS) — xem "Triển khai bằng Docker"
deploy/             Caddyfile, cấu hình production mẫu (prod.env.example), script khởi động container app
```

Luật cờ nằm trong `game-core` dùng chung: trình duyệt dùng để gợi ý nước hợp lệ, server dùng để kiểm tra mọi nước
và quyết định kết quả. Server là nơi duy nhất ghi kết quả và điểm.

## Yêu cầu

- Node.js 22 LTS (khuyên dùng; ảnh Docker production dùng Node 22) và npm 10. Chạy được từ Node 20.11 (máy dev đang dùng
  20.11.1), nhưng Node 20 đã hết được vá bảo mật từ 30/04/2026 và `@aws-sdk/client-s3` báo các bản phát hành sau tuần
  đầu tháng 1/2027 sẽ cần Node ≥ 22 → nên chuyển máy dev sang Node 22.
- Docker (để chạy hạ tầng dev)

## Chạy môi trường phát triển

**Cách nhanh trên Windows (đã cài xong lần đầu):** bấm đúp `start-dev.cmd`. Script bật Docker Desktop + các container,
build packages + server, rồi mở hai cửa sổ: API (cổng 3000) và web (cổng 5173) → mở http://localhost:5173. Tắt: đóng hai
cửa sổ đó. Lưu ý: chỉ `docker compose up` thì **chưa đủ** — Docker chỉ chạy PostgreSQL / Redis / S3 / Mailpit; API và
web là hai chương trình Node chạy riêng.

Lần đầu / cách làm từng bước:

```bash
npm install
cp apps/server/.env.example apps/server/.env   # chỉnh nếu cần
npm run infra:up          # PostgreSQL :5432, Redis :6379, S3 :8333, Mailpit :1025/:8025
npm run db:migrate        # tạo bảng (Prisma migrate)
npm run build:packages    # build game-core, shared, ai (server dùng bản build)
npm run dev:server        # API + WebSocket: http://localhost:3000
npm run dev:web           # Giao diện: http://localhost:5173
```

- Email (mã đăng ký, liên kết xác thực, đặt lại mật khẩu) ở môi trường dev xem tại Mailpit: http://localhost:8025.
  Bỏ trống `SMTP_HOST` thì chỉ ở dev nội dung email (kể cả mã đăng ký) được in ra log server; ở production không gửi
  được thư nào (xem "Gửi email").
- Sửa code trong `packages/*` thì chạy lại `npm run build:packages` để server nhận thay đổi
  (frontend dùng thẳng mã nguồn TypeScript nên tự cập nhật).
- Cấp quyền admin cho một tài khoản đã đăng ký (cần build server trước):
  `npm run admin:promote -w @cotuong/server -- email@cua.ban` (thêm `--revoke` để thu hồi).

## Kiểm thử

```bash
npm test             # unit test: game-core (perft + luật), shared (Elo, mùa, cấp bậc…), ai
npm run smoke        # kiểm thử đầu-cuối trên server đang chạy (cần infra + server gửi thư tới Mailpit)
npm run smoke -- --slow   # thêm luật 30 giây nước đầu và 60 giây mất kết nối (~2 phút)
```

- `game-core` được kiểm chứng bằng perft với số liệu tham chiếu: Cờ tướng thế ban đầu 44 / 1.920 / 79.666;
  Cờ vua 5 thế chuẩn (thế ban đầu, Kiwipete, position 3/4/5).
- Smoke test chạy thật qua HTTP + Socket.IO: đăng ký (kiểu cũ, và 3 bước bằng mã email: `regId`, mã sai / khoá sau
  5 lần / gửi lại, người lạ không khoá được mã, giới hạn theo hộp thư, phiếu dùng một lần), xác thực email qua Mailpit,
  ghép trận, đi nước, Elo, chat, phòng riêng, cầu hoà, mất kết nối/vào lại, chặn đăng nhập nơi khác, lưu ván với máy,
  avatar, quản trị, quên mật khẩu.
- **Không chạy smoke vào server gửi thư thật** (Gmail…). Trước mọi kiểm tra, smoke gửi một mã tới địa chỉ `@test.local`
  và dừng nếu server trả 503 `mail_unavailable` hoặc thư không tới Mailpit trong ~10 giây. Nhắm server mặc định
  (`http://localhost:3000`) mà `SMTP_HOST` trong `apps/server/.env` không phải máy này thì smoke từ chối chạy ngay.
- Smoke đọc thư ở Mailpit và kết nối thẳng vào Redis / PostgreSQL của server (xoá khoá chờ "Gửi lại mã", đọc bộ đếm,
  sửa DB ở phần quản trị). Biến môi trường: `SMOKE_BASE` (mặc định `http://localhost:3000`), `MAILPIT_URL` (mặc định
  `http://localhost:8025`), `REDIS_URL`, `DATABASE_URL` (thiếu thì lấy từ `apps/server/.env`). Đã đặt `SMOKE_BASE` thì
  **bắt buộc** đặt `REDIS_URL` đúng Redis của server đó (thiếu thì smoke từ chối chạy, sai thì dừng ở bước kiểm tra
  trước); `DATABASE_URL` lấy từ `.env` được nếu dùng chung DB. Ví dụ:
  `SMOKE_BASE=http://localhost:3008 REDIS_URL=redis://127.0.0.1:6395 MAILPIT_URL=http://127.0.0.1:8025 npm run smoke`
- Mỗi lần chạy dùng IP giả mới (header `X-Forwarded-For`, dải dành cho tài liệu `198.51.100.0/24`, `203.0.113.0/24`,
  `2001:db8::/32`) nên giới hạn theo IP không dồn qua các lần chạy. Server cần tin header này (mặc định
  `TRUST_PROXY=loopback` tin khi smoke chạy cùng máy); không tin thì smoke bỏ qua các kiểm tra cần nhiều IP, mọi yêu cầu
  tính cho một IP và chỉ chạy được vài lần mỗi giờ.
- Mỗi lần chạy gửi 14 thư (đếm ngày 12/11/2026: 11 thư mã đăng ký, 2 thư liên kết xác thực, 1 thư đặt lại mật khẩu),
  tính vào trần thư toàn trang đếm trong Redis của server (mặc định 100 thư / giờ và 400 thư / 24 giờ, chia phần theo
  loại thư — xem "Gửi email"). Với trần mặc định, phần thư liên kết xác thực (10 / giờ, 40 / 24 giờ) hết trước → tối đa
  khoảng 5 lần chạy mỗi giờ và 20 lần / 24 giờ; lần vượt hỏng ở bước nhận thư (503 `mail_unavailable` hoặc thư không tới
  Mailpit). Chạy nhiều hơn thì tăng `MAIL_MAX_PER_HOUR` / `MAIL_MAX_PER_DAY` cho server thử nghiệm. (Lời cảnh báo "sắp
  chạm trần" của smoke vẫn tính theo quy tắc cũ "mã đăng ký chỉ gửi khi tổng còn dưới 80% trần" nên có thể không báo trước.)
- Smoke tạo nhanh tài khoản thử bằng `POST /api/auth/register` kiểu cũ → server cần `ALLOW_LEGACY_REGISTER` bật (mặc
  định bật khi `NODE_ENV` khác `production`).
- `npm run smoke` chạy bản build (`apps/server/dist/cli/smoke-test.js`): sửa mã smoke thì build lại server
  (`npm run build -w @cotuong/server`).

## Chạy production

```bash
npm run build                      # build packages, server (kèm prisma generate) và web
npm run db:deploy                  # áp dụng migration
WEB_DIST_DIR=../web/dist npm start # server phục vụ luôn frontend đã build (1 tiến trình)
```

- Biến môi trường: xem `apps/server/.env.example`. Ở `NODE_ENV=production` bắt buộc `JWT_SECRET` ≥ 32 ký tự;
  cookie phiên mặc định `secure` (`COOKIE_SECURE`, mặc định bật khi production hoặc `APP_URL` là https; cookie `secure`
  kèm header HSTS — chỉ tắt khi thử production qua `http://localhost`).
- `WEB_DIST_DIR` trỏ tới thư mục chưa có `index.html` (chưa build web / sai đường dẫn) thì server ghi cảnh báo lúc khởi
  động và không phục vụ giao diện (trang chủ trả 404).
- Trang HTML được trả kèm `Content-Security-Policy` (script chỉ từ chính trang + script đặt giao diện sáng/tối trong
  `index.html` theo mã băm tự tính lúc chạy; phông chữ Google Fonts; ảnh `data:`; WebSocket cùng địa chỉ) và
  `Cache-Control: no-cache`. Tệp tĩnh không có (vd `/assets/...` của phiên bản cũ) trả 404 thay vì trang HTML. `HEAD` vào
  các trang trả 200 như `GET` (công cụ theo dõi trang hay dùng `HEAD`). Thêm phông chữ / ảnh / script từ địa chỉ khác thì
  phải sửa CSP trong `apps/server/src/main.ts` (`buildCsp`). Vite dev (:5173) không dùng CSP này.
- Email: production **bắt buộc** cấu hình SMTP — thiếu thì không ai đăng ký được bằng email và không đặt lại được mật
  khẩu (xem "Gửi email"). Đăng ký kiểu cũ `POST /api/auth/register` mặc định tắt ở production (`ALLOW_LEGACY_REGISTER`).
- Chạy nhiều instance: trạng thái ván, hàng chờ, phiên, cache Top 10 đều ở Redis; Socket.IO đồng bộ qua
  Redis adapter; khoá Redis đảm bảo mỗi ván / vòng ghép trận / job chốt quý chỉ một instance xử lý tại một thời
  điểm. Client dùng WebSocket và có thể lùi về HTTP long-polling — nếu để polling qua load balancer thì cần
  sticky session.

## Triển khai bằng Docker (server thật)

**Cách dễ nhất:** xem [DEPLOY.md](DEPLOY.md) — bấm đúp `deploy.cmd` trên máy Windows (Linux / macOS: `bash deploy.sh`); `deploy/server.sh` trên VPS tự cài Docker,
hỏi vài câu, sinh mật khẩu, chạy web, tạo máy chơi, cấp admin; chạy lại để cập nhật. Phần dưới là cách làm bằng tay.

Gồm `Dockerfile` (một image Node 22 chứa API + WebSocket + giao diện web), `docker-compose.prod.yml` (app + PostgreSQL +
Redis + S3/SeaweedFS + **Caddy** tự lấy chứng chỉ HTTPS) và `deploy/` (Caddyfile, cấu hình mẫu, script khởi động). Chỉ
Caddy mở cổng 80/443 ra ngoài. Hai mạng Docker riêng: `edge` (Caddy + app) và `backend` (app + PostgreSQL + Redis + S3,
loại `internal`: không mở cổng, không ra được Internet) → Caddy chỉ với tới được app. Redis và S3 đi kèm **không đặt mật
khẩu / không kiểm tra khoá** (ai nối được vào là đọc ghi được); an toàn nhờ chỉ app ở chung mạng `backend` — đừng thêm
dịch vụ khác vào mạng này.

1. **Server:** máy Linux (vd Ubuntu 22.04/24.04), khuyên ≥ 2 GB RAM (build image + máy chơi tính nước), đã cài Docker
   Engine và plugin Compose (tài liệu cài đặt: https://docs.docker.com/engine/install/). Mở cổng 80 và 443 (TCP; thêm
   443/UDP cho HTTP/3) trên tường lửa / bảng điều khiển của nhà cung cấp.
2. **Tên miền:** tạo bản ghi A (và AAAA nếu có IPv6) trỏ tên miền về IP server. Caddy chỉ lấy được chứng chỉ khi tên
   miền đã trỏ đúng và cổng 80/443 vào được từ Internet.
3. **Đưa mã lên server** (dự án chưa dùng git): trên máy dev nén mã nguồn, KHÔNG kèm `node_modules`, `dist`, `.env`:
   ```powershell
   # PowerShell, tại D:\co tuong
   tar -czf vuaco.tgz --exclude=node_modules --exclude=dist --exclude=.env --exclude=deploy/prod.env *
   scp vuaco.tgz <user>@<ip-server>:~/
   ```
   ```bash
   # trên server
   mkdir -p ~/vuaco && tar -xzf ~/vuaco.tgz -C ~/vuaco && cd ~/vuaco
   ```
   (Lâu dài nên đưa mã lên một kho git riêng tư rồi `git clone` / `git pull` trên server.)
4. **Cấu hình:** `cp deploy/prod.env.example deploy/prod.env` rồi điền: `DOMAIN`, `APP_URL=https://<DOMAIN>`,
   `POSTGRES_PASSWORD` và `JWT_SECRET` ngẫu nhiên (`openssl rand -hex 32`), SMTP (bắt buộc để đăng ký bằng email),
   khoá Google/Facebook nếu dùng. Không dùng lại `JWT_SECRET` / mật khẩu của máy dev. Docker Compose đọc tệp này: giá
   trị có ký tự `$` phải đặt trong nháy đơn (`SMTP_PASS='ab$cd12'`), không thì phần sau `$` bị cắt mất (Compose chỉ in
   cảnh báo "variable is not set"); ghi chú để trên dòng riêng.
5. **Chạy:**
   ```bash
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml up -d --build
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml ps        # app "healthy" là xong
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml logs -f app
   ```
   Lúc khởi động app tự áp dụng migration cơ sở dữ liệu (`prisma migrate deploy`). Caddy chỉ chạy khi app đã "healthy"
   (không trả 502 lúc app đang khởi động), nên `up -d` chờ thêm khoảng 15–30 giây; app không lên được thì `up -d` báo
   lỗi "app is unhealthy" — xem `logs app`. Mở `https://<DOMAIN>`.
6. **Dữ liệu ban đầu** (một lần): tạo 14 tài khoản máy chơi, rồi đăng ký tài khoản của bạn trên web và cấp quyền admin:
   ```bash
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml exec app node dist/cli/seed-bots.js
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml exec app node dist/cli/promote-admin.js <email>
   ```
7. **Google / Facebook:** thêm redirect URI mới `https://<DOMAIN>/api/auth/oauth/google/callback` (Google Cloud Console)
   và `https://<DOMAIN>/api/auth/oauth/facebook/callback` (Meta, mục Facebook Login → Valid OAuth Redirect URIs). App
   Google đang ở chế độ Testing / app Facebook ở chế độ Development thì chỉ tài khoản được thêm vào mới đăng nhập được —
   muốn mở cho mọi người phải chuyển app sang chế độ công khai (trang quản lý của Google / Meta sẽ báo các mục còn thiếu).
8. **Cập nhật phiên bản:** nén và chép mã mới lên như bước 3, rồi trên server:
   ```bash
   cd ~/vuaco
   rm -rf apps packages              # bỏ mã cũ: tệp đã xoá / đổi tên ở bản mới không bị sót lại (prod.env giữ nguyên)
   tar -xzf ~/vuaco.tgz -C ~/vuaco
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml build --pull   # --pull: lấy bản vá mới của Node 22
   docker compose --env-file deploy/prod.env -f docker-compose.prod.yml up -d
   docker image prune -f             # xoá ảnh cũ không còn tên (mỗi lần cập nhật để lại ~1 GB)
   ```
   Dữ liệu nằm trong các volume Docker nên không mất. `docker image prune -f` xoá mọi ảnh "lơ lửng" (không tên) trên
   máy, không đụng ảnh đang dùng. Caddy chỉ đọc `Caddyfile` lúc khởi động: bản mới có sửa `deploy/Caddyfile` hoặc
   các biến của Caddy thì chạy thêm `... up -d --force-recreate caddy`.
9. **Sao lưu:** cơ sở dữ liệu
   `docker compose --env-file deploy/prod.env -f docker-compose.prod.yml exec -T postgres pg_dump -U vuaco vuaco > backup.sql`
   (đổi `vuaco` nếu đã đổi `POSTGRES_USER` / `POSTGRES_DB`); ảnh đại diện nằm trong volume `vuaco_s3data`.

Ghi chú:

- Redis bật ghi xuống đĩa (`appendonly`) nên khởi động lại không mất phiên đăng nhập / ván đang chơi.
- Log của mọi container giới hạn 3 tệp × 10 MB (`x-logging` trong `docker-compose.prod.yml`), không làm đầy đĩa.
- Biến chỉ dùng ở Docker: `RUN_MIGRATIONS` (mặc định `true`: app chạy `prisma migrate deploy` lúc khởi động; chạy nhiều
  bản app thì đặt `false` cho các bản phụ), `APP_ENV_FILE` (đường dẫn tệp cấu hình, mặc định `deploy/prod.env`),
  `HTTP_PORT` / `HTTPS_PORT`, `SITE_ADDRESS`, `TRUSTED_PROXIES`, `TRUST_PROXY` (mục dưới).
- IP người dùng (dùng cho mọi giới hạn số lần thử theo IP): mặc định app đứng sau đúng một proxy (Caddy) nên compose
  đặt `TRUST_PROXY=1`; Caddy không tin `X-Forwarded-For` gửi tới (ghi đè bằng IP thật của bên kết nối) nên không ai
  giả được IP. Lúc khởi động app ghi `TRUST_PROXY = ...` vào log; ở production, nếu yêu cầu qua proxy mà IP tính ra lại
  là địa chỉ nội bộ (10.x, 172.16–31.x, 192.168.x, 127.x, fc00::/7…) thì app ghi một cảnh báo "IP người dùng tính ra là
  địa chỉ nội bộ" → cấu hình proxy sai, cả trang đang bị tính chung một IP (mọi giới hạn theo IP dùng chung, kể cả trần
  200 kết nối realtime mỗi IP — xem mục "Bảo mật và vận hành"). Chưa kiểm tra trên server Linux thật: người
  chơi vào bằng IPv6 (mạng Docker mặc định chỉ có IPv4) — sau khi triển khai nên xem log có cảnh báo này không.

### Đứng sau web server / CDN khác

Có thêm một tầng proxy trước Caddy thì phải khai cả hai nơi, nếu không mọi người bị tính chung IP của proxy đó (vd 50 lần
đăng nhập sai của một người chặn đăng nhập bằng mật khẩu của cả trang, cả trang chỉ tạo được 10 khách / giờ và giữ được
200 kết nối realtime mỗi instance):
`TRUSTED_PROXIES` (Caddy giữ IP người dùng do proxy đó gửi) và `TRUST_PROXY=2` (app tính đúng 2 tầng: proxy + Caddy).
App lấy IP theo số tầng tính từ phải sang trong `X-Forwarded-For`, nên giá trị người dùng tự ghi vào header này không
có tác dụng.

- **Web server trên chính server này (nginx, Apache…) đã chiếm 80/443, tự lo HTTPS rồi chuyển tiếp HTTP vào Caddy.**
  Trong `deploy/prod.env`:
  ```bash
  HTTP_PORT=127.0.0.1:8080        # Caddy chỉ nhận kết nối từ chính máy này
  HTTPS_PORT=127.0.0.1:8443
  SITE_ADDRESS=http://vuaco.ten-mien-cua-ban.vn   # Caddy chỉ nghe HTTP: không xin chứng chỉ, không chuyển hướng sang https
  TRUSTED_PROXIES=private_ranges  # web server tới Caddy qua địa chỉ nội bộ của Docker
  TRUST_PROXY=2
  ```
  (Ghi chú trong khối trên chỉ để giải thích — trong `prod.env` để ghi chú trên dòng riêng.) Thiếu `SITE_ADDRESS=http://...`
  thì Caddy trả 308 sang `https://` cho mọi yêu cầu → trình duyệt chuyển hướng vòng tròn (ERR_TOO_MANY_REDIRECTS).
  `private_ranges` chỉ an toàn khi cổng của Caddy chỉ mở trên `127.0.0.1` như trên. Ví dụ nginx (đặt trong khối `http`,
  dùng chứng chỉ của chính web server này):
  ```nginx
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server {
      listen 443 ssl;
      server_name vuaco.ten-mien-cua-ban.vn;
      # ssl_certificate / ssl_certificate_key: chứng chỉ của tên miền
      location / {
          proxy_pass http://127.0.0.1:8080;
          proxy_http_version 1.1;
          proxy_set_header Host $host;                      # bắt buộc: Caddy chọn trang theo tên miền
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header Upgrade $http_upgrade;           # WebSocket (realtime)
          proxy_set_header Connection $connection_upgrade;
      }
  }
  ```
- **CDN / proxy ở máy khác kết nối tới Caddy qua Internet** (Caddy vẫn tự lo HTTPS): `TRUSTED_PROXIES` = các dải IP do
  CDN đó công bố, cách nhau bằng dấu cách, và `TRUST_PROXY=2`. Không dùng `private_ranges` khi cổng Caddy mở ra
  Internet.
- Đã thử cả hai cách trên máy dev (Docker Desktop trên Windows, nginx 1.27 đóng vai web server / CDN): trang, WebSocket,
  `HEAD`, không chuyển hướng vòng tròn; mỗi người dùng giữ IP riêng, IP tự ghi vào `X-Forwarded-For` bị bỏ qua; thiếu
  `TRUSTED_PROXIES` thì mọi người chung một IP và app ghi cảnh báo. Chưa thử trên server Linux thật / với CDN thật.
- Proxy phía trước chuyển tiếp nguyên kết nối TLS (TCP / SNI passthrough) thì Caddy chỉ thấy IP của proxy → cách trên
  không dùng được (cần PROXY protocol — chưa làm).
- Sau khi đổi: `docker compose --env-file deploy/prod.env -f docker-compose.prod.yml up -d --force-recreate caddy app`,
  log app phải có `TRUST_PROXY = 2` và không có cảnh báo "địa chỉ nội bộ".

## Quyết định cho mục "Review – cần chốt thêm" của đặc tả

Các mục này đặc tả chưa chốt; bản cài đặt dùng **cột "Đề xuất"** của đặc tả. Cần người phụ trách xác nhận.

| # | Vấn đề | Đã làm |
|---|---|---|
| 1 | Chuyển quý khi ván đang dở | Ván ghi `season_id` lúc bắt đầu. 00:00 GMT+7 mùa mới mở và ghép trận dùng ngay; mùa cũ chuyển "finalizing", job chờ các ván cũ kết thúc (cộng điểm vào quý cũ) rồi mới chốt Top 10 |
| 2 | Mất kết nối vs chặn đăng nhập | Chỉ chặn khi nơi đang chơi còn kết nối; nơi cũ đã mất kết nối thì cho đăng nhập và vào lại ván. Khi vào lại bàn mà máy chủ vẫn tưởng kết nối cũ còn (vd vừa đổi Wi-Fi sang 4G, kết nối cũ treo tới ~45 giây), máy chủ hỏi thẳng kết nối cũ; không trả lời trong 2,5 giây thì kết nối mới nhận ghế ngay |
| 3 | Cờ tướng hết nước đi | `game-core` xử thua bên hết nước đi (lý do `stalemate`), cờ vua vẫn là hoà |
| 4 | Phạm vi luật 30 giây | Áp dụng cho nước đầu của mỗi bên, chỉ ván xếp hạng |
| 5 | Dịch vụ email | Gửi qua SMTP (nodemailer) — dùng được với mọi nhà cung cấp có SMTP. **Chưa chọn nhà cung cấp** |
| 6 | Hosting | **Chưa chọn nhà cung cấp**. Đã có sẵn `Dockerfile` + `docker-compose.prod.yml` chạy trên mọi máy Linux có Docker (xem "Triển khai bằng Docker") |
| 7 | Avatar không phù hợp | Trang admin có nút xoá avatar, đưa về ảnh mặc định (chữ cái đầu) |
| 8 | Thời gian khi đấu với máy | Chọn không giới hạn hoặc tuỳ ý như phòng riêng (1–180 phút, 0–60 giây/nước) |
| 9 | `rating_change` | Lưu điểm thay đổi của player1 (Đỏ/Trắng) ở `rating_change` và của player2 ở `rating_change2` (hai số không còn luôn đối nhau vì có sàn 0 điểm) |

Avatar lưu trên S3 theo mặc định "chưa được xác nhận" của đặc tả. Ảnh được phục vụ lại qua
`/api/avatars/...` nên bucket không cần mở công khai.

## Các điểm tự quyết khi cài đặt (đặc tả không nói rõ — cần xác nhận)

- **Bổ sung cột DB**: `users.username_key` (tên hiển thị duy nhất không phân biệt hoa thường),
  `ratings.final_rank` (thứ hạng cuối quý cho hồ sơ), `matches.season_id` (ván tính cho quý bắt đầu).
- **Ghép trận**: hai người được ghép khi chênh lệch điểm nằm trong khoảng chấp nhận của *cả hai* (mỗi người nới
  khoảng theo thời gian chờ của mình); ưu tiên người chờ lâu, chọn đối thủ gần điểm nhất. Theo yêu cầu chủ sản phẩm
  (12/11/2026): những người thật còn lại trong cùng hàng chờ sau bước trên **luôn được ghép với nhau** ngay (xếp theo
  điểm, ghép từng cặp liền kề), kể cả khi chênh điểm vượt khoảng chấp nhận — chỉ người còn lẻ một mình mới chờ tiếp /
  được ghép với máy.
- **Đồng hồ**: chạy ngay từ đầu lượt, kể cả nước đầu; luật 30 giây là hạn bổ sung. Hết giờ luôn xử thua
  (kể cả khi đối phương không đủ quân chiếu hết).
- **Cầu hoà**: lời mời hết hiệu lực khi có nước đi mới; hai bên cùng mời thì coi như đồng ý.
- **Chat** còn gửi được trong 10 phút sau khi ván kết thúc (lúc trạng thái ván còn trong Redis).
- **Phòng riêng** chưa có người vào tự huỷ sau 1 giờ. Cấp bậc hiển thị cạnh tên theo điểm quý hiện tại (không tính điểm).
- **Ván đấu với máy** chỉ lưu khi kết thúc (kể cả đầu hàng); rời trang giữa chừng hoặc "Chơi lại" thì không lưu.
  Server dựng lại ván để kiểm tra nước đi và kết quả trước khi lưu.
- **Tài khoản bị khoá** bị huỷ mọi phiên, ra khỏi hàng chờ, không hiện trong Top 10 và không được xếp hạng khi chốt quý.
  Nếu đang trong ván: mất kết nối quá 60 giây thì bị xử thua như thường.
- **Đặt lại mật khẩu qua email** đồng thời đánh dấu email đã xác thực; mọi phiên cũ bị huỷ.
- **Quy tắc dữ liệu**: tên hiển thị 3–20 ký tự (chữ, số, dấu cách, `_ . -`); mật khẩu ≥ 8 ký tự; giới hạn số lần
  đăng nhập **sai** trong 15 phút: 50 lần mỗi IP (IPv6 gộp /64), 150 lần mỗi dải IPv6 /48, 10 lần mỗi email — đăng nhập
  đúng không bị tính. Trình duyệt đã từng đăng nhập (hoặc đặt lại mật khẩu) thành công bằng email đó với **mật khẩu
  hiện tại** (cookie nhớ trình duyệt, gắn với cả mật khẩu: đặt lại mật khẩu thì mọi trình duyệt cũ thôi được tin) không
  bị khoá theo email mà có giới hạn riêng 10 lần mỗi (email, IP), nên người lạ cố nhập sai không khoá được chủ tài
  khoản. Kiểm tra mật khẩu chạy cùng lúc (mỗi instance): trình duyệt lạ 4 lần mỗi IP / dải /48; trình duyệt quen riêng 4
  lần mỗi IP / dải /48 và 2 lần mỗi email. Quyền "trình duyệt quen" (được xếp trước trong hàng chờ) mỗi IP / dải /48
  dùng được 10 lần liền rồi 1 lần / 30 giây (mỗi instance), quá thì được xét như trình duyệt lạ. Vượt giới hạn chạy cùng lúc, hoặc hàng chờ
  kiểm tra mật khẩu đầy / chờ quá 5 giây → 503 `busy` "Máy chủ đang bận" (không tính vào giới hạn); hàng ưu tiên không
  chặn hẳn hàng thường (cứ 3 việc ưu tiên thì làm 1 việc thường), hàng chờ đầy thì ghi cảnh báo vào log.
- **Ký hiệu nước đi**: cờ vua dùng SAN (`Nf3`, `O-O`, `exd6`…); cờ tướng dùng ký hiệu ngắn của sách cờ Việt Nam
  (`P2-5` = Pháo 2 bình 5, `M8.7` = Mã 8 tấn 7, `X1/1` = Xe 1 thoái 1, `Xt.1` = Xe trước tấn 1; quân Tg S T M X P B,
  cột 1–9 đếm từ phải sang trái theo hướng mỗi bên; không ghi dấu chiếu / ăn quân) — xem
  `packages/game-core/src/xiangqi/notation.ts`. Cờ úp: quân úp ghi theo loại gốc của ô rồi quân lật ra
  (`B7.1 → Xe`, `X9.6 → Tốt (ăn Mã úp)`). Dữ liệu lưu vẫn là chuỗi UCI / ICCS theo đặc tả.
- **Cờ tướng không tự xử hoà khi hai bên hết quân tấn công** (đặc tả chỉ nêu lặp thế cờ) — hai bên có thể thoả thuận hoà.
- Ảnh Docker MinIO hiện không còn kéo được từ Docker Hub (`pull access denied`), nên môi trường dev dùng SeaweedFS
  làm S3. Production dùng bất kỳ dịch vụ chuẩn S3 nào qua biến `S3_*`.

## Cờ úp (揭棋)

- Trang `/co-up`: đấu với người (hàng chờ riêng, ghép người vào trước) hoặc phòng riêng, và đấu với máy. **Không tính điểm.**
- Luật: hai Tướng ngửa; 15 quân còn lại mỗi bên úp ngẫu nhiên trên các ô xuất phát; quân úp đi theo quân gốc của ô
  đang đứng, đi xong thì lật. Quân đã lật đi đúng luật quân đó (Sĩ/Tượng đã lật không bị giới hạn cung/sông).
- Máy chủ giữ bí mật thế xếp quân tới khi hết ván (client chỉ nhận quân được lật). Máy chơi chỉ dựa trên thông tin
  công khai (mô phỏng nhiều cách xếp có thể).
- Tự quyết (cần xác nhận): quân úp bị ăn được lật cho cả hai bên xem; lặp thế 3 lần / chiếu dai xử như cờ tướng;
  thời gian ván người–người 10 phút + 5 giây/nước.

## Cờ thế

- Trang `/co-the` (danh sách) và `/co-the/:id` (giải thế): 200 thế đầu tuyển tập 适情雅趣 (Thích tình nhã thú).
- Dữ liệu thế cờ lấy từ `fen/shiqingyaqu551.fen` của https://github.com/kuiba1949/xiangqi-tools
  (BSD 3-Clause, © 2018 Careone Kuiba) — giấy phép phải đi kèm khi phân phối (`packages/shared/THIRD_PARTY_NOTICES.md`).
- 157/200 thế đã được máy chứng minh "Đỏ chiếu liên tục và chiếu hết trong N nước" (kiểm với mọi cách đỡ của Đen) và có
  lời giải; 43 thế còn lại ghi "Chưa kiểm chứng" (máy chưa chứng minh được, không có nghĩa là không thắng được).
- Tên Hán Việt (thế 1–100) lấy từ tài liệu "100 thế cờ – Thích tình nhã thú"; tài liệu ghi phần phiên âm **cần người
  duyệt**. Thế 101–200 **chưa có tên Hán Việt** (chỉ hiện tên chữ Hán) — cần tài liệu để bổ sung.
- Người đăng nhập: tiến độ lưu trên server; khách: lưu trong trình duyệt.
- **Tiến độ là tự ghi nhận** (chấp nhận, chưa sửa): máy đỡ của Đen chạy trong trình duyệt, nên server chỉ kiểm tra
  chuỗi nước gửi lên có hợp lệ và kết thúc bằng Đỏ thắng — không biết Đen có đỡ hết sức không. Người cố ý gửi nước đỡ
  "nhường" vẫn đánh dấu được "đã giải" với số nước ít hơn lời giải. Chỉ ảnh hưởng tiến độ riêng của người đó (không
  dùng cho xếp hạng hay hiện cho người khác). Chặn hẳn cần server tự chạy máy đỡ cho từng nước — chưa làm.

## Đăng ký bằng mã email (3 bước)

- Trang `/register`: (1) nhập email → (2) nhập mã 6 chữ số gửi qua email → (3) chọn tên hiển thị + mật khẩu. Tài khoản
  tạo xong có email đã xác thực (chơi xếp hạng được ngay) và được đăng nhập luôn; bước 3 không gửi thêm thư.
- API:
  - `POST /api/auth/register/start {email, regId?}` → `{email, regId, resendAfterSec: 60, expiresInSec: 600}`. Mỗi lần
    gửi thành công tạo một `regId` mới (chuỗi ngẫu nhiên 22 ký tự) gắn với một mã mới; trình duyệt giữ `regId` cho bước 2.
    "Gửi lại mã" gửi kèm `regId` đang giữ → mã cũ của chính người đó bị huỷ. Người khác không có `regId` nên không nhập
    thử, khoá hay thay được mã của bạn. Email đã có tài khoản → 409.
  - `POST /api/auth/register/verify {email, regId, code}` → `{ticket, expiresInSec: 900}`.
  - `POST /api/auth/register/complete {ticket, username, password}` → `{user}` + cookie phiên.
- Mã có hiệu lực 10 phút, sai tối đa 5 lần mỗi mã (hết lượt phải gửi mã mới); Redis chỉ lưu băm HMAC của mã. Thiếu
  `regId`, `regId` không có thật hoặc của email khác → báo như mã hết hạn, không tính lượt nhập. Phiếu bước 3 hiệu lực
  15 phút, dùng một lần (tên trùng / mật khẩu yếu thì phiếu vẫn còn).
- Giới hạn gửi mã, xét theo thứ tự:
  1. mỗi IP 60 lần gọi `register/start` / giờ, tính mọi lần gọi kể cả bị từ chối (409, 429) — email sai định dạng thì
     không tính;
  2. email đã có tài khoản → 409;
  3. chờ 60 giây giữa hai lần gửi tới cùng hộp thư từ cùng IP (`reg_resend_wait`); mỗi IP 10 thư mã / giờ và 30 thư mã
     / 24 giờ, mỗi dải IPv6 /48 20 thư mã / giờ (`reg_ip_limit`); mỗi (hộp thư, IP) 5 thư mã / 24 giờ và mỗi hộp thư 5
     thư mã / giờ dù gửi từ IP nào (`reg_mail_quota`). Khi phần thư mã đăng ký của cả trang đã dùng quá nửa (xem "Gửi
     email") thì siết lại: mỗi IP 3 thư mã / giờ, mỗi /48 6 thư mã / giờ — người mới vẫn đăng ký được, một người có vài IP
     không dùng hết được phần của mọi người. Bước này kiểm tra và ghi nhận cùng lúc (nguyên tử): lần bị từ chối không
     tính vào các bộ đếm này và không bật thời gian chờ.

  "Hộp thư" chỉ dùng cho giới hạn (tài khoản vẫn theo đúng email): không phân biệt hoa thường, bỏ phần `+nhãn`; riêng
  Gmail bỏ cả dấu chấm và coi `googlemail.com` là `gmail.com`. "IP" của IPv6 là cả dải /64. Bộ đếm là cửa sổ cố định tính
  từ lần đầu. Nhập mã: mỗi IP 60 lần / giờ (`reg_ip_limit`).
- Gửi thư không thành (SMTP lỗi, production chưa cấu hình SMTP, hết phần trần thư của mã đăng ký, địa chỉ thử nghiệm qua
  SMTP thật — xem "Gửi email") → 503 `mail_unavailable` (hết phần trần thì kèm `retryAfterSec`); mã vừa tạo bị xoá, thời
  gian chờ và các bộ đếm gửi thư của lần đó được trả lại (lượt gọi `register/start` vẫn tính).
- Lỗi trả JSON `{statusCode, message, code?, retryAfterSec?, attemptsLeft?}`; có `retryAfterSec` thì kèm header
  `Retry-After`. Mã lỗi: `reg_ip_limit`, `reg_resend_wait`, `reg_mail_quota` (429, kèm `retryAfterSec`);
  `mail_unavailable` (503); `reg_code_wrong` (kèm `attemptsLeft`), `reg_code_locked`, `reg_code_expired`,
  `reg_ticket_expired` (400).
- Hạn chế đã biết: người khác có thể gửi đủ 5 mã tới một hộp thư trong vài phút để hộp thư đó hết lượt tới khi hết cửa sổ
  1 giờ (mỗi IP chỉ làm được 5 thư / hộp thư / 24 giờ, muốn chặn tiếp phải đổi IP); chặn hẳn cần captcha — chưa có.
- Sau proxy / load balancer phải đặt `TRUST_PROXY` (bản Docker: xem "Đứng sau web server / CDN khác"), nếu không cả
  trang chung một IP: mọi người cộng lại chỉ được 10 thư mã / giờ.
- `POST /api/auth/register` kiểu cũ (tạo tài khoản CHƯA xác thực và gửi liên kết xác thực, không cần chứng minh sở hữu
  email) chỉ chạy khi `ALLOW_LEGACY_REGISTER` bật: mặc định bật khi `NODE_ENV` khác `production`, tắt ở production; tắt
  thì trả 404 như đường dẫn không có. Nhận `true` / `false` / `1` / `0` (không phân biệt hoa thường), giá trị khác thì
  server không khởi động. Giao diện không dùng; smoke test dùng.

## Gửi email

- Thư gửi đi: mã đăng ký, liên kết xác thực email (tài khoản Google có email chưa được Google xác minh, hoặc đăng ký kiểu cũ), đặt lại mật khẩu.
  Gửi qua SMTP (nodemailer) theo `SMTP_*`, `MAIL_FROM`, `MAIL_REPLY_TO` trong `apps/server/.env` (mẫu và ghi chú trong
  `apps/server/.env.example`). Ghi chú trong `.env` phải nằm trên dòng riêng: `KEY=giá-trị # ...` thì `# ...` thành một
  phần giá trị.
- **Production bắt buộc có SMTP**: thiếu `SMTP_HOST` thì không gửi được thư nào → không ai đăng ký được bằng email (bước
  1 trả 503), không đặt lại được mật khẩu. Server ghi lỗi lúc khởi động nhưng vẫn chạy (đăng nhập Google vẫn dùng được).
  Ở dev, thiếu `SMTP_HOST` thì nội dung thư (kể cả mã) chỉ được in ra log server.
- Trần thư toàn trang, dùng chung mọi instance (đếm ở Redis): `MAIL_MAX_PER_HOUR` (mặc định 100) thư / giờ và
  `MAIL_MAX_PER_DAY` (mặc định 400) thư / 24 giờ tính từ thư đầu tiên. Trần chia phần cho từng loại thư
  (`MAIL_SHARE_PCT` trong `apps/server/src/common/mail.service.ts`): mã đăng ký 70%, đặt lại mật khẩu 20%, liên kết xác
  thực 10% (mặc định 70 / 20 / 10 thư mỗi giờ, 280 / 80 / 40 thư mỗi 24 giờ) — một loại dùng hết phần của mình (vd có
  người xin mã đăng ký liên tục) không lấn sang phần của loại khác — trừ thư đặt lại mật khẩu đầu tiên trong 24 giờ tới
  một email, được dùng phần còn trống của loại khác. Thư mã đăng ký / thư đặt lại mật khẩu đã dùng quá nửa
  phần của loại đó thì giới hạn theo IP của loại đó bị siết lại (xem "Đăng ký bằng mã email" và mục "Bảo mật"). Chạm trần thì không gửi và ghi lỗi
  vào log (tối đa một lần mỗi 10 phút cho mỗi loại). Giá trị không phải số nguyên ≥ 1 thì server báo lỗi khi khởi động.
- Thư không gửi được (SMTP lỗi / quá thời gian chờ, production thiếu SMTP, chạm trần, địa chỉ thử nghiệm): bước 1 đăng ký
  và "Gửi lại email xác thực" trả 503 `mail_unavailable` (chạm trần thì kèm `retryAfterSec`); "Quên mật khẩu" vẫn trả
  lời như thường (không để lộ gì) nhưng ghi lỗi vào log; đăng nhập Google / Facebook và đăng ký kiểu cũ vẫn chạy, chỉ
  là thư không tới.
- Địa chỉ thử nghiệm: khi `SMTP_HOST` không phải máy này (`127.0.0.1`, `::1`, `localhost`), server không gửi thư tới tên
  miền kết thúc bằng `.test`, `.example`, `.invalid`, `.localhost`, `.local` (không ai nhận được; gửi qua Gmail chỉ sinh
  thư báo lỗi, mà Gmail có thể tạm chặn gửi khi nhiều thư không tới được người nhận —
  https://support.google.com/mail/answer/22839).
- `MAIL_REPLY_TO` (tuỳ chọn): địa chỉ nhận thư trả lời, gắn vào mọi thư. Production không ghi nội dung thư, mã hay link
  vào log.
- Thử bằng Gmail (mẫu cấu hình trong khối SMTP của `apps/server/.env.example`):
  - Mật khẩu ứng dụng chỉ dùng được khi tài khoản Google bật Xác minh 2 bước; tạo tại
    https://myaccount.google.com/apppasswords (mã 16 ký tự) rồi điền vào `SMTP_PASS` — không dùng mật khẩu đăng nhập
    Gmail. Đổi mật khẩu tài khoản Google thì mọi mật khẩu ứng dụng bị thu hồi → phải tạo lại, nếu không mọi thư đều gửi
    thất bại. Không thấy tuỳ chọn mật khẩu ứng dụng thì có thể do: Xác minh 2 bước chỉ dùng khoá bảo mật, tài khoản bật
    Bảo vệ nâng cao, hoặc đang dùng tài khoản cơ quan / trường học. Google cũng ghi rằng mật khẩu ứng dụng không được
    khuyến nghị. (https://support.google.com/accounts/answer/185833)
  - `SMTP_HOST=smtp.gmail.com`; cổng 465 đi với `SMTP_SECURE=true`, cổng 587 đi với `SMTP_SECURE=false` (STARTTLS)
    (https://support.google.com/a/answer/176600). `MAIL_FROM` dùng đúng địa chỉ của `SMTP_USER`.
  - Gmail giới hạn số thư gửi mỗi ngày: trang trợ giúp ghi gửi hơn 500 thư trong một ngày có thể bị báo lỗi vượt giới
    hạn, thường 1–24 giờ sau mới gửi lại được (https://support.google.com/mail/answer/22839) → giữ `MAIL_MAX_PER_DAY`
    dưới mức này; production nên dùng dịch vụ email giao dịch.
- Không chạy `npm run smoke` vào server đang gửi thư thật (xem "Kiểm thử").

## Đăng nhập bằng Google / Facebook

Nút chỉ hiện khi server có cấu hình. Cách bật:

1. **Google**: Google Cloud Console → APIs & Services → Credentials → "OAuth client ID", loại *Web application*.
   Authorized redirect URI: `<APP_URL>/api/auth/oauth/google/callback`. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
2. **Facebook**: developers.facebook.com → tạo ứng dụng, thêm sản phẩm *Facebook Login*, quyền `email`, `public_profile`.
   Valid OAuth Redirect URI: `<APP_URL>/api/auth/oauth/facebook/callback`. Điền `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
3. Khởi động lại server. `GET /api/config` trả `oauth: { google, facebook }` cho biết nút nào được bật.

Quy tắc liên kết tài khoản (tự quyết — cần xác nhận):

- Đã từng đăng nhập bằng tài khoản Google/Facebook đó → vào đúng tài khoản cũ.
- Email trùng tài khoản đăng ký bằng mật khẩu: **Google** (email đã được Google xác minh) → tự liên kết vào tài khoản đó;
  **Facebook** → không tự liên kết (tránh chiếm tài khoản), báo người dùng đăng nhập bằng mật khẩu.
- Email mới → tạo tài khoản; tên hiển thị lấy từ tên mạng xã hội (trùng thì thêm số). Theo yêu cầu chủ sản phẩm
  (11/11/2026) **đăng nhập bằng Google/Facebook không phải xác thực email lại**: email Google đã xác minh
  (`email_verified`) và email Facebook trả về đều coi như đã xác thực ngay (chơi xếp hạng được luôn, không gửi thư).
  Lưu ý: tài liệu Graph API của Facebook chỉ ghi "không trả trường email nếu không có email hợp lệ", không cam kết rõ là
  đã xác nhận — vì vậy email Facebook vẫn KHÔNG dùng để tự gộp vào tài khoản có sẵn. Chỉ Google trả `email_verified=false`
  mới còn gửi thư xác thực; tài khoản đó đăng nhập lại khi Google đã xác minh cùng email thì tự được xác thực.
- Tài khoản tạo qua mạng xã hội có mật khẩu ngẫu nhiên; muốn đăng nhập bằng mật khẩu thì dùng "Quên mật khẩu". Lưu ý:
  tài khoản tạo bằng **Facebook** (hoặc Google khi Google chưa xác minh email) mà đặt lại mật khẩu thì liên kết Facebook /
  Google bị gỡ (không phân biệt được chủ email thật với người dùng tài khoản Facebook khai email đó) — trang "Đã đổi mật
  khẩu" báo rõ điều này; chủ tài khoản đăng nhập bằng mật khẩu mới rồi liên kết lại trong Hồ sơ. Tài khoản tạo bằng
  Google đã xác minh email thì giữ nguyên liên kết.
- **Liên kết từ trang hồ sơ** (mục "Đăng nhập nhanh", chỉ hiện khi đã cấu hình): người đang đăng nhập bấm "Liên kết
  Google/Facebook" → đồng ý ở trang Google/Facebook → quay về hồ sơ. Dùng cho tài khoản email/mật khẩu có sẵn (Facebook
  không bao giờ tự gộp theo email). Không liên kết được tài khoản Google/Facebook đã gắn với người khác; mỗi dịch vụ
  một liên kết; không cho huỷ liên kết cuối cùng khi email chưa xác thực. API: `GET /api/auth/oauth/links`,
  `DELETE /api/auth/oauth/:provider/link`, bắt đầu bằng `/api/auth/oauth/:provider/start?mode=link&from=/profile/<id>`.
- Tài khoản tạo bằng Google/Facebook mà email chưa được xác minh: liên kết xác thực email chỉ có hiệu lực khi đang đăng
  nhập đúng tài khoản đó (chống chiếm tài khoản trước); chủ email thật dùng "Quên mật khẩu" để lấy quyền (gỡ liên kết lạ).
- Bảo vệ: `state` ngẫu nhiên dùng một lần (Redis + cookie), chỉ quay về đường dẫn nội bộ, giới hạn 30 lần / 10 phút mỗi IP.

Đã kiểm thử đầu-cuối với một nhà cung cấp OAuth giả chạy cục bộ; **chưa thử với Google/Facebook thật** (cần mã ứng dụng).

## Điểm hạng và cấp bậc (theo yêu cầu chủ sản phẩm, 08/11/2026)

- Mỗi mùa (quý) ai cũng bắt đầu **0 điểm**. Thắng/thua/hoà tính theo Elo (K = 32) như đặc tả, nhưng điểm **không
  xuống dưới 0**: người thua đang ở 0 điểm giữ 0, người thắng vẫn nhận đủ.
- Cấp bậc (giữ tên cũ, mốc mới — đề xuất ban đầu, chỉnh bằng `TIERS_JSON`): Tân thủ 0–99 · Sơ cấp ≥ 100 ·
  Trung cấp ≥ 200 · Cao cấp ≥ 350 · Cao thủ ≥ 500 · Đại cao thủ ≥ 700 · Kỳ vương ≥ 900.
- Điểm thực tế người chơi đạt được trong một quý chưa được đo; nên chỉnh mốc khi có dữ liệu thật.
- Bảng xếp hạng / Top 10 chỉ tính người đã chơi **ít nhất 5 ván xếp hạng** trong quý (`LEADERBOARD_MIN_GAMES`, chủ sản
  phẩm đổi từ 10 xuống 5 ngày 11/11/2026); chưa đủ thì vẫn có điểm nhưng chưa có hạng.
- **Luật giúp người đến sau dễ leo hạng** (chủ sản phẩm chọn 11/11/2026; thông số ở `RANKED_RULES` trong
  `packages/shared/src/constants.ts`, công thức ở `rankedDelta` / `decayedRating` trong `packages/shared/src/elo.ts`).
  Mỗi bên tính riêng nên điểm hai bên không còn luôn đối nhau (`matches.rating_change` / `rating_change2`):
  1. **5 ván xếp hạng đầu mùa**: điểm CỘNG nhân ×1,5 (vd thắng người ngang điểm +24 thay vì +16).
  2. **Thua bị nhân hệ số theo cấp bậc** của người thua: Tân thủ, Sơ cấp ×1,0; Trung cấp ×1,1; Cao cấp ×1,2; Cao thủ ×1,3;
     Đại cao thủ ×1,4; Kỳ vương ×1,5 (vd Kỳ vương thua người ngang điểm −24 thay vì −16). Thắng không nhân.
  3. **Chuỗi thắng**: ván thắng thứ 3 liên tiếp +3, từ ván thứ 4 +6 mỗi ván; thua / hoà về 0 (cột `ratings.win_streak`).
  4. **Không chơi thì tụt điểm**: từ 350 điểm, 7 ngày không chơi ván xếp hạng nào (cột `ratings.last_ranked_at`) → mỗi ngày
     −5 điểm, không xuống dưới mốc cấp bậc đang có. `RatingDecayService` kiểm tra mỗi 30 phút, mỗi (mùa, ngày giờ Việt Nam)
     chỉ trừ một lần (khoá Redis `decay:done:*`), xong thì làm mới cache Top 10.
  Bảng kết quả ván hiện rõ luật đã áp dụng (`RatingChangeDto.rules`); trang Mùa giải mục "Cách tính điểm hạng" giải thích
  cho người chơi.

## Tài khoản máy chơi (theo yêu cầu chủ sản phẩm, 08/11/2026)

- 14 tài khoản máy (`npm run bots:seed -w @cotuong/server`, chạy lại nhiều lần không tạo trùng; danh sách ở
  `apps/server/src/bots/bot-accounts.ts`): **7 cho tìm trận xếp hạng cờ tướng + 7 cho cờ vua**, mỗi nhóm 3 mức
  Trung bình + 4 mức Khó. Máy chỉ được ghép đúng game của nó; không dùng cho Cờ úp, phòng riêng, trang đấu với máy.
- Người chơi chờ ở hàng chờ xếp hạng ≥ `BOT_FALLBACK_SEC` (mặc định 30 giây) mà chưa có đối thủ người → ghép với máy
  rảnh có điểm gần nhất. **Không ghép máy khi đang có hơn `BOT_MAX_ONLINE_HUMANS` (mặc định 50) thành viên online**
  (người có tài khoản đang kết nối; khách không được tính).
- Theo quyết định của chủ sản phẩm, máy hiện ra **như người chơi thật** (tên, hồ sơ, điểm, Top 10); chỉ trang quản trị
  có nhãn "Máy". Máy không đăng nhập được; email `botNN@bots.invalid` (người dùng không đăng ký được tên miền này).
- Máy tính nước ở phía server bằng `@cotuong/ai` trong luồng phụ (worker_threads), thời gian mỗi nước 1,5–8 giây,
  luôn từ chối hoà, không chat, không đầu hàng. Chạy được nhiều instance (khoá Redis) và tự tiếp tục sau khi server khởi
  động lại. Kiểm thử: `npm run smoke:bots -w @cotuong/server [-- --game chess]` (cũng tạo người chơi thử bằng đăng ký
  kiểu cũ → cần `ALLOW_LEGACY_REGISTER` bật).
- Lưu ý: giấu việc đối thủ là máy có thể gây hiểu lầm cho người chơi; nếu sau này có giải thưởng nên xem lại.

## Chơi không cần đăng nhập — khách (theo yêu cầu chủ sản phẩm, 11/11/2026)

- **Chỉ đánh xếp hạng mới cần tài khoản** (và email đã xác thực). Mọi cách chơi khác dùng được khi chưa đăng nhập:
  đấu với máy (`/ai`, chạy trong trình duyệt), phòng riêng (kể cả mở link mời `/room/:code`), Cờ úp (tìm đối thủ, phòng
  riêng, với máy), cờ thế (tiến độ lưu ở trình duyệt như trước).
- Phòng riêng / Cờ úp cần một danh tính trên server: khi khách thao tác lần đầu, web gọi `POST /api/auth/guest` → server
  tạo **tài khoản khách tạm** (cột `users.is_guest`, tên "Khách 123456", email nội bộ `guest-<uuid>@guests.invalid` — tên
  miền dành riêng, không ai đăng ký được; mật khẩu ngẫu nhiên nên không đăng nhập bằng mật khẩu được) và đặt cookie phiên
  như đăng nhập. Đã có phiên (thành viên hoặc khách) thì trả lại đúng người đó. `/api/auth/me` trả `isGuest: true`.
- Giới hạn khách mới mỗi giờ: mỗi IP (IPv6 gộp /64) 10, mỗi dải IPv6 /48 30. Cả trang quá 300 / giờ ("đang đông")
  thì không chặn mọi người mà siết theo IP: mỗi IP 3, mỗi /48 6. Trần cứng cả trang 3000 / giờ (bảo vệ cơ sở dữ liệu,
  chạm trần thì ghi lỗi vào log). Vượt → `429` mã `guest_limit` (kèm `retryAfterSec`); yêu cầu bị từ chối không tính.
- Khách KHÔNG dùng được các API cần đăng nhập (trả `401`): hồ sơ, ảnh đại diện, lưu ván với máy, lịch sử, liên kết
  Google/Facebook, quản trị, tiến độ cờ thế trên server. Socket: khách vào được hàng chờ Cờ úp, phòng riêng, ván, chat;
  hàng chờ xếp hạng trả mã `login_required`. Trong ván, người chơi khách có `isGuest: true` (không có điểm / trang hồ sơ);
  trang quản trị không liệt kê khách.
- Đăng nhập / đăng ký khi đang là khách: phiên thành viên thay phiên khách (danh tính khách bỏ đi, không gộp lịch sử).
- Dọn dẹp: mỗi giờ `GuestCleanupService` xoá khách tạo trước (hạn phiên `SESSION_TTL_DAYS` + 1 ngày) — lúc đó phiên khách
  đã hết hạn nên không ai dùng được nữa; khách còn giữ chỗ trong một ván, đang ở hàng chờ / có phòng riêng, còn socket
  kết nối, hoặc có tin nhắn đang bị báo cáo mà admin chưa xử lý thì để lần sau. Ván đã lưu giữ lại (người chơi thành
  NULL → lịch sử của đối thủ hiện "Người chơi đã rời"), tin nhắn chat của khách bị xoá theo; báo cáo do khách gửi vẫn
  giữ cho admin xử lý (người báo cáo hiện "Tài khoản đã xoá").

## Bảng theo dõi của admin (tab "Tổng quan" ở /admin, 11/11/2026)

- `GET /api/admin/stats` (chỉ admin) trả: số tài khoản (thành viên, đã xác thực, liên kết Google / Facebook, bị khoá,
  quản trị viên, mới hôm nay / 7 / 30 ngày, khách, máy), đang online (đang kết nối realtime; trình duyệt mở web trong 5
  phút), lượt truy cập (lượt xem trang, người xem, thành viên hoạt động — hôm nay / 7 / 30 ngày), ván đấu hôm nay
  (xếp hạng / không xếp hạng / với máy đã lưu, đang diễn ra, tổng), biểu đồ 30 ngày và trang xem nhiều hôm nay.
  Giao diện tự làm mới mỗi phút; có bảng số liệu theo ngày (đọc được bằng bàn phím / trình đọc màn hình).
- Đếm truy cập: web gửi `POST /api/analytics/visit {vid, path}` mỗi lần đổi trang (`vid` = mã ngẫu nhiên trong
  localStorage, không gắn danh tính). Server **không lưu IP**; bỏ qua bot / trình duyệt headless / thư viện HTTP theo
  User-Agent; mỗi IP (IPv6 gộp /64) tối đa 120 lượt / phút và 10 người xem MỚI / phút, mỗi dải IPv6 /48 tối đa 30
  người xem mới / phút (vượt thì vẫn đếm lượt xem nhưng không thêm người xem / "đang xem web"); đường dẫn gộp theo mẫu
  (`/play/:id`…) nên không lưu mã ván / mã người.
- **Số liệu truy cập vẫn có thể bị thổi phồng** (chấp nhận, chỉ là số liệu tham khảo của admin): không cần đăng nhập,
  User-Agent làm giả được, nên một người có nhiều IP / nhiều dải IPv6 vẫn đẩy được lượt xem, người xem và "đang xem
  web" lên cao (mỗi IPv4 thêm được tối đa 10 người xem mới / phút, mỗi dải IPv6 /48 tối đa 30). Giới hạn trên chỉ làm việc đó
  chậm và tốn công hơn. Không ảnh hưởng ván đấu, tài khoản hay điểm hạng.
  Bộ đếm ở Redis (`an:*`, giữ 40 ngày): lượt xem (INCR), người xem và thành viên hoạt động (HyperLogLog — ước lượng, sai
  số khoảng 1%, đếm không trùng qua nhiều ngày). Mỗi 10 phút chép số của hôm nay + hôm qua vào bảng `site_daily_stats`
  (giữ lâu dài, luôn giữ số lớn hơn nếu Redis lỡ mất dữ liệu). Ngày tính theo giờ Việt Nam.
- Giới hạn: chỉ đếm trình duyệt có chạy JavaScript; người chặn localStorage được tính là người xem mới mỗi lần mở trang;
  "Ván với máy" chỉ gồm ván của thành viên đã được lưu vào lịch sử (khách chơi với máy không được lưu nên không đếm).

## Bảo mật và vận hành (bổ sung sau review 08/11/2026)

- `TRUST_PROXY`: chạy bằng `npm start` mặc định chỉ tin proxy chạy cùng máy (`loopback`); đặt số tầng proxy khi chạy
  sau load balancer / CDN, nếu không giới hạn số lần thử theo IP sẽ sai (vd cả trang chung một IP, chỉ được 10 thư mã
  đăng ký / giờ, và **cả trang chỉ mở được 200 kết nối realtime mỗi instance** — người thứ 201 trở đi không chơi được
  ván trực tiếp; log có cảnh báo "Một IP giữ quá 200 kết nối…"). Bản Docker: compose đặt sẵn `TRUST_PROXY=1` (chỉ
  Caddy), có thêm proxy phía trước thì đặt `TRUST_PROXY` + `TRUSTED_PROXIES` trong `deploy/prod.env` (xem "Đứng sau web
  server / CDN khác").
- `JWT_SECRET` mẫu trong `.env.example` chỉ chạy được khi `APP_URL` là localhost.
- Chặn yêu cầu thay đổi dữ liệu và kết nối realtime đến từ trang khác (kiểm tra `Origin`); header bảo mật cơ bản.
- Giới hạn: đăng nhập sai (tính cả yêu cầu gửi đồng thời; xem "Quy tắc dữ liệu"), thư liên kết xác thực 10 thư / 24
  giờ / địa chỉ, mã đăng ký (xem "Đăng ký bằng mã email"), trần thư toàn trang (xem "Gửi email"), đổi avatar 10 lần /
  giờ, ảnh tối đa ~16 triệu điểm ảnh. Quên mật khẩu: mỗi IP 20 yêu cầu / giờ, mỗi dải IPv6 /48 60 yêu cầu / giờ; thư
  đặt lại mật khẩu (chỉ đếm thư thật sự gửi đi) mỗi (email, IP) 5 thư / ngày, mỗi email 4 thư / giờ, mỗi IP 5 thư / giờ
  (còn 1 khi phần thư đặt lại mật khẩu của trang đã dùng quá nửa) và 15 thư / ngày, mỗi dải IPv6 /48 10 thư / giờ (lúc
  bận 2) và 30 thư / ngày. Thư đặt lại mật khẩu đầu tiên trong 24 giờ tới một email được dùng cả phần trần còn trống của
  loại thư khác. Rủi ro còn lại (chấp nhận, chưa có captcha): người có khoảng chục IP và vài email đã đăng ký vẫn làm
  hết được phần 20% thư đặt lại mật khẩu trong một giờ; khi đó người cần lấy lại mật khẩu vẫn nhận được thư đầu tiên của
  mình (trừ khi cả trần chung của trang cũng đầy), các thư sau phải chờ. Kết nối realtime (mỗi instance): mỗi
  IP (IPv6 gộp /64) mở kết nối mới tối đa 60 lần liền rồi 2 lần / giây và giữ tối đa 200 kết nối cùng lúc; mỗi người
  (kể cả khách) tối đa 20 kết nối (tab). Chạm các giới hạn này thì ghi cảnh báo vào log (không ghi IP, tối đa một lần
  mỗi 10 phút).
- Thân yêu cầu JSON quá 100 KB → 413 "Dữ liệu gửi lên quá lớn"; JSON hỏng → 400 "Dữ liệu gửi lên không hợp lệ" (không
  ghi stack trace vào log).
- Hàng chờ tự bỏ người đã mất kết nối; ván kết thúc mà ghi DB lỗi thì tự thử lại; chốt mùa chờ thêm 1 phút sau mốc
  chuyển quý.
- Đợt kiểm tra bảo mật 08/11/2026 (đã vá + kiểm thử lại): email đăng nhập không hợp lệ không tạo khoá Redis (chống
  làm đầy bộ nhớ); giới hạn ~10 sự kiện realtime/giây/người và 30 lần xem/vào phòng riêng mỗi phút; thao tác sai
  bị loại trước khi chiếm khoá ván; lưu ván với máy ≤ 600 nửa nước, 30 lần/giờ; avatar luôn trả `image/webp` + CSP,
  chỉ nhận tệp có chữ ký JPEG/PNG/WebP; email chỉ nhận dạng `a@b.c`; giới hạn theo IP gộp IPv6 theo /64; thư đặt lại
  mật khẩu tính theo (email, IP) + trần theo email; tài khoản tạo bằng Google/Facebook chỉ xác thực email khi đang
  đăng nhập đúng tài khoản; production không in link trong email ra log; cookie `secure` tự bật khi `APP_URL` là
  https; bản build web không kèm source map.
- `docker-compose.yml` chỉ mở cổng trên 127.0.0.1 và Redis giới hạn 512 MB; đây là cấu hình DEV (mật khẩu mặc định,
  Redis/S3 không xác thực). Production: PostgreSQL có mật khẩu riêng, `JWT_SECRET` riêng; Redis và S3 đi kèm
  `docker-compose.prod.yml` vẫn không xác thực nhưng chỉ app với tới được (mạng `backend` loại `internal`, không mở cổng,
  Caddy không ở mạng này). Dùng Redis / S3 ở máy khác hay dịch vụ ngoài thì phải bật mật khẩu / khoá.
- Thư viện (kiểm `npm audit` ngày 12/11/2026): đã nâng các bản vá cùng major — `@nestjs/*` 11.2.9 (kéo `multer` 2.5.0,
  vá lỗi từ chối dịch vụ GHSA-q7qp-rjg7-q26m) và `@aws-sdk/client-s3` 3.1166 (bỏ `fast-xml-parser` có lỗ hổng). Còn 15 cảnh báo, mọi
  cách vá đều là nâng **major** — chưa làm, cần chủ dự án quyết định và kiểm thử lại:
  - Chạy trên server: `sharp` 0.33.5 → 0.35.5 (lỗ hổng của libvips / libheif, mức cao; app chỉ nhận JPEG/PNG/WebP đã
    kiểm chữ ký), `nodemailer` 6.10.1 → 10.5.0 (mức cao; địa chỉ email đã bị giới hạn dạng `a@b.c`), `prisma` 6.19.3
    (`deepmerge-ts` qua `@prisma/config`, mức cao; chỉ dùng lúc chạy migration) → 7.10.1 hoặc chờ bản 8.
  - Trình duyệt: `react-router-dom` 6.30.6 → 7.x (chuyển hướng mở bằng `\` — đã chặn ở phía ứng dụng).
  - Chỉ dùng khi phát triển: `vitest` 3.2.7 → 5.x (mức nghiêm trọng, qua `tinypool`; chỉ chạy unit test trên máy dev),
    `@nestjs/cli` 11 → 12 (`glob`, `minimatch`, `deepmerge`).
  Ảnh Docker vẫn chép cả thư viện chỉ dùng khi phát triển (không chạy tới); bỏ đi cần tách Prisma CLI (migration lúc
  khởi động) ra khỏi `devDependencies` — chưa làm.

## Tham số chỉnh được

- Mốc cấp bậc: biến `TIERS_JSON` của server (mặc định trong `packages/shared/src/tiers.ts`), không viết cứng.
- Thông số AI (độ sâu, thời gian, % nước ngẫu nhiên): `AI_LEVEL_CONFIG` trong `packages/ai/src/engine.ts`.
  Dễ: độ sâu 1 + 30% ngẫu nhiên; Trung bình: độ sâu 3; Khó: tối đa 3 giây mỗi nước. Độ mạnh thực tế chưa được đo.
- Thông số luật (Elo K, thời gian ván, ghép trận, chat, avatar, số ván tối thiểu): `packages/shared/src/constants.ts`.

## Chưa làm (theo đặc tả hoặc chưa chốt)

- Chống gian lận, xử đuổi dai (đặc tả: bản đầu chưa làm); người xem ván; đi lại (undo).
- Chọn hosting và nhà cung cấp email (mục Review #5, #6).
- Bàn cờ đi quân bằng cách bấm chọn quân rồi bấm ô đích (chưa có kéo-thả).
