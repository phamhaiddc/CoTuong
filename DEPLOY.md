# Đưa Xe Pháo Mã lên VPS — cách dễ nhất

Bạn chỉ cần **bấm đúp `deploy.cmd`** trên máy Windows rồi trả lời vài câu hỏi. Mọi việc còn lại (cài Docker trên VPS,
tạo mật khẩu ngẫu nhiên, chạy web, xin chứng chỉ HTTPS, tạo máy chơi) được làm tự động.
Lần sau muốn cập nhật bản mới: bấm đúp `deploy.cmd` lần nữa — dữ liệu người chơi giữ nguyên.

> **Dùng máy Linux / macOS?** `deploy.cmd` chỉ chạy trên Windows. Thay vào đó mở Terminal ở thư mục dự án và gõ
> **`bash deploy.sh`** — các bước và câu hỏi giống hệt. Ở mọi chỗ bên dưới ghi "bấm đúp `deploy.cmd`", bạn chạy
> `bash deploy.sh`.
>
> **Mã nguồn đã nằm sẵn trên VPS** (bạn SSH vào VPS rồi làm việc ngay trên đó)? Không cần `deploy.cmd` / `deploy.sh`:
> `cd` vào thư mục dự án trên VPS rồi chạy **`bash deploy/server.sh`** (lần đầu là cài, các lần sau là cập nhật).

---

## 1. Chuẩn bị (làm một lần)

**a) Một VPS** chạy **Ubuntu 22.04 hoặc 24.04**, nên có **2 GB RAM** (máy 1 GB thì script tự tạo thêm bộ nhớ phụ
— swap — để build, nhưng sẽ chậm hơn). Nhà cung cấp VPS sẽ gửi cho bạn: **địa chỉ IP**, **tên đăng nhập** (thường là `root`) và **mật khẩu**.
Trên trang quản lý VPS, nếu có mục tường lửa (Firewall / Security group) thì **mở cổng 22, 80 và 443**.

**b) Một tên miền** (vd `xephaoma.vn`). Vào trang quản lý tên miền, thêm một bản ghi:

| Loại | Tên | Giá trị |
|---|---|---|
| A | `@` (dùng chính `xephaoma.vn`) hoặc `choi` (dùng `choi.xephaoma.vn`) | địa chỉ IP của VPS |

Bản ghi thường có hiệu lực sau vài phút (đôi khi lâu hơn, tuỳ nhà cung cấp tên miền).

**c) (Nên có) Mật khẩu ứng dụng Gmail** — để web gửi mã đăng ký và thư đặt lại mật khẩu:

1. Tài khoản Google phải bật **Xác minh 2 bước**.
2. Vào https://myaccount.google.com/apppasswords → tạo mật khẩu → Google hiện **16 ký tự**. Ghi lại (dấu cách không
   quan trọng).

Không có cũng được: web vẫn chạy, người chơi vẫn đăng nhập bằng Google/Facebook và chơi khách được — chỉ chưa đăng ký
bằng email được.

**d) (Tuỳ chọn) Đăng nhập Google / Facebook:** chuẩn bị Client ID + secret (Google) và App ID + secret (Facebook) như đang
dùng ở máy dev. Thêm sau cũng được (mục 4).

## 2. Đưa lên lần đầu

1. Mở thư mục `D:\co tuong`, **bấm đúp `deploy.cmd`**.
2. Nhập địa chỉ VPS dạng **`root@IP`**, vd `root@103.20.30.40`.
3. Được hỏi mật khẩu thì nhập **mật khẩu VPS** (gõ không hiện ký tự — bình thường). Có thể được hỏi 2 lần.
   Lần đầu kết nối nếu thấy câu `Are you sure you want to continue connecting (yes/no)?` → gõ `yes`.
4. Trả lời các câu hỏi trên màn hình:
   - **Tên miền** (vd `xephaoma.vn`)
   - **Gmail** dùng để gửi thư và **mật khẩu ứng dụng** 16 ký tự (Enter để bỏ qua)
   - **Google / Facebook** (Enter để bỏ qua)
5. Chờ **10–20 phút** (cài Docker và build lần đầu). Thấy dòng **`XONG! Mở https://…`** là web đã chạy.
6. Mở địa chỉ đó trên trình duyệt, **đăng ký tài khoản của bạn** (hoặc đăng nhập Google), rồi quay lại cửa sổ đen,
   **nhập email đó** → tài khoản của bạn thành **admin** (có menu Quản trị, bảng theo dõi).

## 3. Cập nhật bản mới

Bấm đúp **`deploy.cmd`** → nhấn **Enter** để dùng lại địa chỉ VPS cũ → nhập mật khẩu VPS. Script tự nhận ra web đã cài nên
chỉ cập nhật: build bản mới, khởi động lại (mất vài phút; trong lúc đó web gián đoạn chốc lát). Tài khoản, điểm, ván đấu,
ảnh đại diện **giữ nguyên**.

## 4. Việc thường làm trên VPS

Đăng nhập VPS: mở PowerShell, gõ `ssh root@IP` (thay IP), nhập mật khẩu, rồi `cd ~/vuaco`.

| Muốn làm | Lệnh |
|---|---|
| Xem log của web (Ctrl+C để thoát) | `bash deploy/server.sh logs` |
| Sao lưu cơ sở dữ liệu | `bash deploy/server.sh backup` (tạo tệp `~/vuaco-backup-<ngày>.sql`) |
| Tải bản sao lưu về máy Windows | trên máy Windows: `scp root@IP:vuaco-backup-*.sql .` |
| Cấp quyền admin cho email khác | `bash deploy/server.sh admin <email>` |
| Đổi Gmail / thêm Google, Facebook | `nano deploy/prod.env` → sửa → Ctrl+O, Enter, Ctrl+X → `bash deploy/server.sh` |

Sau khi thêm Google / Facebook, nhớ khai báo địa chỉ chuyển hướng (redirect URI) mới:

- Google Cloud Console: `https://<tên-miền>/api/auth/oauth/google/callback`
- Meta (Facebook Login → Valid OAuth Redirect URIs): `https://<tên-miền>/api/auth/oauth/facebook/callback`

App Google ở chế độ Testing / app Facebook ở chế độ Development thì chỉ tài khoản được thêm vào mới đăng nhập được —
muốn mở cho mọi người phải chuyển app sang chế độ công khai.

`deploy/prod.env` trên VPS chứa mật khẩu (sinh ngẫu nhiên lúc cài) — **không chia sẻ tệp này**, và không xoá nó (xoá thì
lần chạy sau sẽ coi là cài mới và không vào được cơ sở dữ liệu cũ).

## 5. Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| `Gửi tệp thất bại` | Sai địa chỉ / mật khẩu VPS, hoặc VPS chưa mở cổng 22. |
| Web không mở được, hoặc trình duyệt báo lỗi chứng chỉ | Tên miền chưa trỏ đúng IP, hoặc cổng 80 / 443 chưa mở. Sửa xong chờ vài phút; vẫn lỗi thì bấm `deploy.cmd` lần nữa. |
| Không nhận được mã đăng ký qua email | Kiểm tra Gmail và mật khẩu ứng dụng trong `deploy/prod.env` (mục 4). Đổi mật khẩu tài khoản Google thì mật khẩu ứng dụng bị thu hồi — phải tạo lại. |
| Build bị dừng giữa chừng (thiếu bộ nhớ) | Chạy lại `deploy.cmd` (script tự thêm bộ nhớ phụ khi VPS dưới 2 GB RAM). |
| Linux: `$'\r': command not found` khi chạy `bash deploy.sh` | Tệp bị đổi sang kiểu xuống dòng Windows khi chép. Chạy `sed -i 's/\r$//' deploy.sh deploy/*.sh` rồi chạy lại. |
| Linux: `ssh: command not found` | `sudo apt install openssh-client` (Ubuntu / Debian). |
| Lỗi khác | Chạy `bash deploy/server.sh logs` trên VPS, chụp màn hình gửi người hỗ trợ kỹ thuật. |

Chi tiết kỹ thuật (lệnh làm bằng tay, chạy sau nginx / CDN, cấu trúc dịch vụ): README mục **"Triển khai bằng Docker"**.
