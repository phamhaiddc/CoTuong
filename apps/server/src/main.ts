import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { BlockList, isIP } from 'net';
import { join } from 'path';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { RedisIoAdapter } from './common/redis-io.adapter';

/**
 * Content-Security-Policy cho trang HTML của giao diện web (lớp phòng thủ thứ hai nếu sau này lỡ có lỗi XSS).
 * Script inline (đặt giao diện sáng/tối trước khi React chạy) được phép theo mã băm sha256 tính từ chính index.html
 * đang phục vụ → sửa script đó không phải sửa ở đây. Phông chữ lấy từ Google Fonts; ảnh vân gỗ bàn cờ là ảnh data:;
 * realtime dùng WebSocket cùng địa chỉ (ghi rõ thêm ws(s):// của APP_URL cho trình duyệt cũ không coi ws là 'self').
 */
function buildCsp(html: string, appUrl: string): string {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || !m[2].trim()) continue;
    // Trình duyệt đổi CRLF / CR thành LF trước khi băm nội dung script (quy tắc xuống dòng của HTML) → băm theo LF, nếu
    // không index.html lỡ lưu kiểu Windows (CRLF) sẽ làm script inline bị chặn
    const text = m[2].replace(/\r\n?/g, '\n');
    hashes.push(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
  }
  const u = new URL(appUrl);
  const wsOrigin = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Dải địa chỉ nội bộ (mạng LAN, mạng Docker, chính máy này): người dùng đến từ Internet không có IP thuộc các dải này */
const INTERNAL_NETS = (() => {
  const b = new BlockList();
  b.addSubnet('10.0.0.0', 8, 'ipv4');
  b.addSubnet('172.16.0.0', 12, 'ipv4');
  b.addSubnet('192.168.0.0', 16, 'ipv4');
  b.addSubnet('127.0.0.0', 8, 'ipv4');
  b.addSubnet('169.254.0.0', 16, 'ipv4');
  b.addSubnet('fc00::', 7, 'ipv6');
  b.addSubnet('fe80::', 10, 'ipv6');
  b.addAddress('::1', 'ipv6');
  return b;
})();

function isInternalIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
  const family = isIP(v);
  return family !== 0 && INTERNAL_NETS.check(v, family === 4 ? 'ipv4' : 'ipv6');
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const cfg = app.get(AppConfig);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');
  app.set('trust proxy', cfg.trustProxy);
  // Ghi ra để người vận hành đối chiếu với số tầng proxy thật (sai thì mọi người dùng chung một IP khi giới hạn số lần thử)
  logger.log(`TRUST_PROXY = ${JSON.stringify(cfg.trustProxy)}`);
  if (cfg.isProd) {
    // Tự kiểm tra cấu hình proxy: yêu cầu đã qua proxy (có X-Forwarded-For) mà IP người dùng tính ra lại là địa chỉ nội
    // bộ → gần như chắc chắn TRUST_PROXY / trusted_proxies của Caddy không khớp số tầng proxy thật, cả trang bị tính
    // chung một IP (vd 50 lần đăng nhập sai của một người chặn đăng nhập bằng mật khẩu của mọi người). Chỉ xét 500 yêu cầu
    // như vậy đầu tiên, báo tối đa một lần; không ghi IP của người dùng thật vào log.
    let proxyChecksLeft = 500;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (proxyChecksLeft > 0 && req.headers['x-forwarded-for'] !== undefined) {
        proxyChecksLeft--;
        if (req.ip && isInternalIp(req.ip)) {
          proxyChecksLeft = 0;
          logger.warn(
            `Yêu cầu đi qua proxy nhưng IP người dùng tính ra là địa chỉ nội bộ ${req.ip} (TRUST_PROXY = ${JSON.stringify(cfg.trustProxy)}) ` +
              '→ có thể mọi người đang bị tính chung một IP khi giới hạn số lần thử. Kiểm tra TRUST_PROXY và TRUSTED_PROXIES ' +
              '(README "Đứng sau web server / CDN khác"). Bỏ qua cảnh báo này nếu người chơi ở cùng mạng nội bộ với server.',
          );
        }
      }
      next();
    });
  }
  app.disable('x-powered-by');
  app.use(cookieParser());

  // Header bảo mật cơ bản
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Chống CSRF: yêu cầu thay đổi dữ liệu (POST/PUT/PATCH/DELETE) vào /api phải đến từ chính trang web (APP_URL).
  // Công cụ không gửi Origin / Sec-Fetch-Site (curl, smoke test) vẫn đi qua.
  const appOrigin = new URL(cfg.appUrl).origin;
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Định tuyến của Express không phân biệt hoa thường (/API/... vẫn tới controller) → so sánh bằng chữ thường
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.path.toLowerCase().startsWith('/api/')) {
      return next();
    }
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    let sameHost = false;
    if (typeof origin === 'string') {
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
    }
    if (site === 'cross-site' || (typeof origin === 'string' && origin !== appOrigin && !sameHost)) {
      res.status(403).json({ statusCode: 403, message: 'Yêu cầu bị chặn vì không được gửi từ trang Xe Pháo Mã. Bạn tải lại trang rồi thử lại nhé.' });
      return;
    }
    next();
  });

  const io = new RedisIoAdapter(app, cfg.redisUrl);
  await io.connect();
  app.useWebSocketAdapter(io);

  // Production 1 tiến trình: phục vụ luôn frontend đã build (SPA)
  if (cfg.webDistDir) {
    const dir = cfg.webDistDir;
    const indexFile = join(dir, 'index.html');
    // CSP tính lại khi index.html đổi (build lại web trong lúc server đang chạy)
    let csp = { mtimeMs: -1, value: '' };
    const htmlHeaders = (res: Response): void => {
      try {
        const st = statSync(indexFile);
        if (st.mtimeMs !== csp.mtimeMs) csp = { mtimeMs: st.mtimeMs, value: buildCsp(readFileSync(indexFile, 'utf8'), cfg.appUrl) };
      } catch {
        // index.html tạm thời không đọc được: giữ CSP cũ (nếu có)
      }
      if (csp.value) res.setHeader('Content-Security-Policy', csp.value);
      // Trang HTML luôn hỏi lại server → sau khi cập nhật phiên bản, trình duyệt tải đúng các tệp mới
      res.setHeader('Cache-Control', 'no-cache');
    };
    app.useStaticAssets(dir, {
      index: false,
      maxAge: '7d',
      setHeaders: (res: Response, path: string) => {
        if (path.toLowerCase().endsWith('.html')) htmlHeaders(res);
      },
    });
    // Tệp tĩnh không còn (vd tab mở từ phiên bản cũ xin tệp /assets/... đã bị thay khi cập nhật): trả 404 thật thay vì
    // trang HTML — trả HTML thì trình duyệt coi như tải được rồi báo lỗi kiểu nội dung và cứ xin lại mãi
    const staticFile = /\.(?:m?js|css|map|json|webmanifest|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|txt|xml|wasm)$/i;
    app.use((req: Request, res: Response, next: NextFunction) => {
      // HEAD như GET (công cụ theo dõi trang hay hỏi bằng HEAD)
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
        return next();
      }
      if (req.path.startsWith('/assets/') || staticFile.test(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).type('text/plain; charset=utf-8').send('Không tìm thấy tệp');
        return;
      }
      htmlHeaders(res);
      res.sendFile(indexFile);
    });
    logger.log(`Phục vụ frontend từ ${dir}`);
  } else if (process.env.WEB_DIST_DIR) {
    // Đặt WEB_DIST_DIR mà thư mục không có index.html (chưa build web / sai đường dẫn): báo rõ thay vì im lặng trả 404
    logger.warn(
      `WEB_DIST_DIR=${process.env.WEB_DIST_DIR} không có index.html → KHÔNG phục vụ giao diện web (trang chủ trả 404). ` +
        'Build web trước ("npm run build") hoặc sửa đường dẫn.',
    );
  }

  // Đọc thân yêu cầu (JSON / form): tự đăng ký tại đây — đúng chỗ Nest vẫn tự thêm lúc khởi tạo (Nest thấy đã có thì
  // không thêm nữa) — để lỗi đọc thân đi qua bộ chuyển ngay sau. Không có bộ chuyển này, Nest đổi lỗi JSON hỏng
  // (SyntaxError) thành BadRequestException mang câu tiếng Anh của JSON.parse.
  app.useBodyParser('json');
  app.useBodyParser('urlencoded', { extended: true });
  app.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
    // Lỗi của body-parser (JSON hỏng, quá lớn, sai bảng mã…) luôn có type 'entity.*' / 'charset.*'… và status 4xx:
    // chuyển thành lỗi thường → AllExceptionsFilter trả "Dữ liệu gửi lên không hợp lệ" / "Dữ liệu gửi lên quá lớn"
    const e = err as { status?: unknown; type?: unknown } | null;
    if (e && typeof e === 'object' && typeof e.type === 'string' && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
      next({ status: e.status, type: e.type });
      return;
    }
    next(err);
  });

  app.enableShutdownHooks();
  await app.listen(cfg.port);
  logger.log(`Server chạy tại http://localhost:${cfg.port} (instance ${cfg.instanceId})`);
}

void bootstrap();
