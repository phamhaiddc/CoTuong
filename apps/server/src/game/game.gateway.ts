import { Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { parse as parseCookie } from 'cookie';
import type { IncomingMessage } from 'http';
import type { Socket } from 'socket.io';
import { isGameType, type GameType } from '@cotuong/game-core';
import { ERROR_CODES, type Ack, type ClientToServerEvents, type GameVariant, type ServerToClientEvents } from '@cotuong/shared';
import { AppConfig } from '../config';
import { GameError } from '../common/errors';
import { ipBucket } from '../common/net';
import { TokenBucketLimiter } from '../common/rate-limiter';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService, rooms, type IoServer } from '../common/realtime.service';
import { AuthService } from '../auth/auth.service';
import { ChatService } from './chat.service';
import { LiveMatchService } from './live-match.service';
import { MatchmakingService } from './matchmaking.service';
import { RoomsService } from './rooms.service';

interface SocketUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  sid: string;
  /** Phiên khách: chơi được phòng riêng / Cờ úp, không vào được hàng chờ xếp hạng */
  isGuest: boolean;
}

interface SocketData {
  user: SocketUser | null;
  /** Khoá IP của kết nối (ipBucket) — để đếm số socket mỗi IP */
  ip?: string;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Mỗi người dùng (kể cả phiên khách) giữ tối đa chừng này socket cùng lúc trên một instance (mỗi tab một socket) */
const MAX_SOCKETS_PER_USER = 20;
/** Mỗi IP (IPv6: cả dải /64) giữ tối đa chừng này socket cùng lúc trên một instance — đủ cho nhiều người chung IP (NAT) */
const MAX_SOCKETS_PER_IP = 200;

type TrustFn = (addr: string, i: number) => boolean;

/**
 * IP thật của kết nối, theo đúng cài đặt "trust proxy" của Express (như req.ip ở API): đi ngược X-Forwarded-For từ
 * địa chỉ kết nối trực tiếp, dừng ở địa chỉ đầu tiên không được tin.
 */
function clientIp(req: IncomingMessage, trust: TrustFn | undefined): string {
  const addrs = [req.socket?.remoteAddress ?? ''];
  const xff = req.headers['x-forwarded-for'];
  const header = Array.isArray(xff) ? xff.join(',') : xff;
  if (header) {
    const parts = header.split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i].trim();
      if (p) addrs.push(p);
    }
  }
  if (typeof trust !== 'function') return addrs[0];
  for (let i = 0; i < addrs.length - 1; i++) if (!trust(addrs[i], i)) return addrs[i];
  return addrs[addrs.length - 1];
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function dec(map: Map<string, number>, key: string): void {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

function assertGame(v: unknown): GameType {
  if (!isGameType(v)) throw new GameError('Loại game không hợp lệ');
  return v;
}

/** Biến thể từ client: thiếu = 'standard'; giá trị lạ bị từ chối */
function assertVariant(v: unknown): GameVariant {
  if (v === undefined || v === null || v === 'standard') return 'standard';
  if (v === 'jieqi') return 'jieqi';
  throw new GameError('Biến thể không hợp lệ');
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 64) throw new GameError(`${what} không hợp lệ`);
  return v;
}

/**
 * Kết nối realtime (Socket.IO). Chưa có phiên nào vẫn kết nối được để nhận cập nhật Top 10; mọi thao tác chơi cần một
 * phiên — thành viên hoặc khách (phòng riêng, Cờ úp). Hàng chờ xếp hạng thì cần tài khoản thành viên.
 */
@WebSocketGateway({ path: '/socket.io', serveClient: false })
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('Gateway');
  /** Mỗi người: ~10 sự kiện/giây (dồn tối đa 20); xem / vào phòng riêng: ~30 lần/phút (chống dò mã phòng) */
  private readonly limiter = new TokenBucketLimiter({
    event: { capacity: 20, perSecond: 10 },
    room: { capacity: 10, perSecond: 0.5 },
  });
  private readonly readiness = new WeakMap<object, Promise<void>>();
  /**
   * Bắt tay kết nối theo IP: mỗi lần bắt tay có đăng nhập tốn một lần đọc Redis + một truy vấn DB, nên chặn vòng lặp
   * kết nối / ngắt liên tục. Dư dả cho cả mạng nhiều người chung IP kết nối lại cùng lúc sau khi server khởi động lại.
   */
  private readonly handshakeLimiter = new TokenBucketLimiter({ handshake: { capacity: 60, perSecond: 2 } });
  /** Số socket đang kết nối vào instance này, theo người dùng / theo IP */
  private readonly userSockets = new Map<string, number>();
  private readonly ipSockets = new Map<string, number>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly cfg: AppConfig,
    private readonly realtime: RealtimeService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly live: LiveMatchService,
    private readonly matchmaking: MatchmakingService,
    private readonly rooms: RoomsService,
    private readonly chat: ChatService,
  ) {}

  afterInit(server: IoServer): void {
    this.realtime.setServer(server);
    // Chống trang khác (vd tên miền con cùng site) mở kết nối realtime bằng cookie của người dùng — như kiểm tra ở main.ts
    const appOrigin = new URL(this.cfg.appUrl).origin;
    server.use((socket, next) => {
      const origin = socket.handshake.headers.origin;
      if (typeof origin === 'string' && origin !== appOrigin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === socket.handshake.headers.host;
        } catch {
          sameHost = false;
        }
        if (!sameHost) return next(new Error('Nguồn kết nối không hợp lệ'));
      }
      next();
    });
    // Giới hạn theo IP TRƯỚC bước tra phiên đăng nhập (đọc Redis + DB): số lần bắt tay và số socket đang mở
    server.use((socket, next) => {
      const ip = ipBucket(clientIp(socket.request, this.trustFn()));
      (socket as GameSocket).data.ip = ip;
      if (!this.handshakeLimiter.take(ip, 'handshake')) {
        this.ipLimitAlert('handshake');
        return next(new Error('Kết nối quá nhanh, vui lòng thử lại sau ít phút'));
      }
      if ((this.ipSockets.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) {
        this.ipLimitAlert('sockets');
        return next(new Error('Có quá nhiều kết nối từ mạng của bạn, vui lòng thử lại sau'));
      }
      next();
    });
    server.use((socket, next) => {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      this.auth
        .userFromToken(cookies[this.cfg.cookieName])
        .then((u) => {
          if (u && (this.userSockets.get(u.id) ?? 0) >= MAX_SOCKETS_PER_USER) {
            next(new Error('Bạn đang mở quá nhiều tab, hãy đóng bớt rồi tải lại trang'));
            return;
          }
          socket.data.user = u
            ? { id: u.id, username: u.username, avatarUrl: u.avatarUrl, sid: u.sid, isGuest: u.isGuest }
            : null;
          next();
        })
        .catch((e: Error) => {
          // Không gửi lỗi nội bộ (câu lệnh Prisma, đường dẫn mã nguồn, địa chỉ DB…) cho client
          this.logger.error(`Xác thực kết nối realtime lỗi: ${e.message}`);
          next(new Error('Lỗi hệ thống, vui lòng thử lại'));
        });
    });
  }

  private ipAlert = { at: 0, refused: 0 };

  /**
   * Một IP chạm giới hạn kết nối realtime: ghi cảnh báo (không ghi IP), tối đa một lần mỗi 10 phút (mỗi instance), kèm số
   * kết nối bị từ chối từ lần báo trước. Thấy thường xuyên thì nhiều khả năng TRUST_PROXY không khớp số tầng proxy thật —
   * khi đó mọi người dùng bị coi là chung MỘT IP và cả trang chỉ mở được MAX_SOCKETS_PER_IP kết nối mỗi instance.
   */
  private ipLimitAlert(kind: 'handshake' | 'sockets'): void {
    const now = Date.now();
    this.ipAlert.refused++;
    if (now - this.ipAlert.at < 10 * 60_000) return;
    const what =
      kind === 'sockets' ? `giữ quá ${MAX_SOCKETS_PER_IP} kết nối cùng lúc` : 'mở kết nối mới quá nhanh (quá 60 lần liền rồi 2 lần / giây)';
    this.logger.warn(
      `Một IP ${what} — đã từ chối ${this.ipAlert.refused} kết nối realtime từ lần báo trước. Nếu thấy thường xuyên, kiểm ` +
        'tra TRUST_PROXY (README "Bảo mật và vận hành"): cấu hình sai thì mọi người dùng bị coi là chung một IP.',
    );
    this.ipAlert = { at: now, refused: 0 };
  }

  /** Hàm "trust proxy" Express đã dựng sẵn (app.set('trust proxy', …) ở main.ts) */
  private trustFn(): TrustFn | undefined {
    try {
      const app = this.adapterHost.httpAdapter?.getInstance() as { get?: (name: string) => unknown } | undefined;
      const fn = app?.get?.('trust proxy fn');
      return typeof fn === 'function' ? (fn as TrustFn) : undefined;
    } catch {
      return undefined;
    }
  }

  handleConnection(socket: GameSocket): void {
    // Đếm socket đang mở (giảm lại ở handleDisconnect) cho giới hạn theo người dùng / theo IP ở bước bắt tay
    if (socket.data.ip) inc(this.ipSockets, socket.data.ip);
    if (socket.data.user) inc(this.userSockets, socket.data.user.id);
    // Đăng ký handler ngay (đồng bộ) để không mất sự kiện client gửi ngay khi vừa kết nối;
    // mỗi handler chờ bước chuẩn bị (vào phòng user, ghi nhận presence) xong mới chạy.
    const ready = this.prepare(socket).catch((e: Error) => {
      this.logger.warn(`prepare socket: ${e.message}`);
    });
    this.readiness.set(socket, ready);
    this.register(socket, ready);
  }

  private async prepare(socket: GameSocket): Promise<void> {
    const user = socket.data.user;
    if (!user) return;
    await socket.join([rooms.user(user.id), rooms.session(user.sid)]);
    await this.presence.add(user.id, socket.id, { guest: user.isGuest });
  }

  async handleDisconnect(socket: GameSocket): Promise<void> {
    if (socket.data.ip) dec(this.ipSockets, socket.data.ip);
    const user = socket.data.user;
    if (!user) return;
    dec(this.userSockets, user.id);
    // Chờ bước ghi presence xong để không để lại bản ghi "còn kết nối" sai
    await this.readiness.get(socket);
    try {
      await this.presence.remove(user.id, socket.id);
      await this.matchmaking.onSocketGone(user.id, socket.id);
      await this.live.onSocketGone(user.id, socket.id);
    } catch (e) {
      this.logger.warn(`disconnect: ${(e as Error).message}`);
    }
  }

  /** Đăng ký handler có xác thực, bắt lỗi và trả kết quả qua ack */
  private on<P>(
    socket: GameSocket,
    ready: Promise<void>,
    event: keyof ClientToServerEvents,
    fn: (user: SocketUser, payload: P) => Promise<object>,
  ): void {
    (socket as Socket).on(event, async (payload: P, ack?: (r: Ack<object>) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      await ready;
      const user = socket.data.user;
      if (!user) {
        reply({ ok: false, error: 'Bạn cần đăng nhập', code: ERROR_CODES.NOT_AUTHENTICATED });
        return;
      }
      // Chống spam sự kiện: gửi dồn dập (vd lời mời hoà / nước đi sai liên tục) chiếm khoá ván làm nước đi của đối thủ
      // bị kẹt tới hết giờ; dò mã phòng riêng hàng nghìn lần mỗi giây
      if (!this.limiter.take(user.id, event === 'room:info' || event === 'room:join' ? 'room' : 'event')) {
        reply({ ok: false, error: 'Bạn thao tác quá nhanh, hãy chậm lại một chút', code: 'rate' });
        return;
      }
      try {
        const res = await fn(user, (payload ?? {}) as P);
        reply({ ok: true, ...res });
      } catch (e) {
        if (e instanceof GameError) reply({ ok: false, error: e.message, code: e.code });
        else {
          this.logger.error(`${event}: ${(e as Error).stack ?? e}`);
          reply({ ok: false, error: 'Lỗi hệ thống, vui lòng thử lại' });
        }
      }
    });
  }

  private register(socket: GameSocket, ready: Promise<void>): void {
    this.on<{ game: unknown; variant?: unknown }>(socket, ready, 'queue:join', async (u, p) => {
      // Lấy lại trạng thái xác thực email mới nhất (có thể vừa xác thực sau khi kết nối)
      const fresh = await this.prisma.user.findUnique({ where: { id: u.id } });
      if (!fresh || fresh.isBanned) throw new GameError('Tài khoản không hợp lệ');
      const status = await this.matchmaking.join(
        { id: fresh.id, username: fresh.username, avatarUrl: fresh.avatarUrl, emailVerified: fresh.emailVerifiedAt !== null, isGuest: fresh.isGuest },
        assertGame(p.game),
        socket.id,
        assertVariant(p.variant),
      );
      return { status };
    });

    this.on(socket, ready, 'queue:leave', async (u) => {
      await this.matchmaking.leave(u.id);
      return {};
    });

    this.on<{ game: unknown; minutes: unknown; incrementSec: unknown; variant?: unknown }>(socket, ready, 'room:create', async (u, p) => {
      const room = await this.rooms.create(u, assertGame(p.game), Number(p.minutes), Number(p.incrementSec), assertVariant(p.variant));
      return { room };
    });

    this.on<{ code: unknown }>(socket, ready, 'room:info', async (_u, p) => ({ room: await this.rooms.info(p.code) }));

    this.on<{ code: unknown }>(socket, ready, 'room:join', async (u, p) => ({ matchId: await this.rooms.join(u, p.code) }));

    this.on<{ code: unknown }>(socket, ready, 'room:cancel', async (u, p) => {
      await this.rooms.cancel(u.id, p.code);
      return {};
    });

    this.on(socket, ready, 'room:mine', async (u) => ({ room: await this.rooms.mine(u.id) }));

    this.on<{ matchId: unknown }>(socket, ready, 'match:join', async (u, p) => {
      const state = await this.live.attach(str(p.matchId, 'Mã ván'), u.id, socket.id);
      await socket.join(rooms.match(state.id));
      const chat = await this.chat.history(state.id);
      return { state, chat };
    });

    this.on<{ matchId: unknown }>(socket, ready, 'match:leave', async (_u, p) => {
      await socket.leave(rooms.match(str(p.matchId, 'Mã ván')));
      return {};
    });

    // Thao tác trong ván kèm socket gửi: chỉ socket đang giữ ghế (tab đã vào bàn) mới được đi / đầu hàng / mời hoà
    const actor = { socketId: socket.id };

    this.on<{ matchId: unknown; move: unknown; confirmPerpetual?: unknown }>(socket, ready, 'match:move', async (u, p) => {
      await this.live.move(u.id, str(p.matchId, 'Mã ván'), str(p.move, 'Nước đi'), p.confirmPerpetual === true, undefined, actor);
      return {};
    });

    this.on<{ matchId: unknown }>(socket, ready, 'match:resign', async (u, p) => {
      await this.live.resign(u.id, str(p.matchId, 'Mã ván'), actor);
      return {};
    });

    this.on<{ matchId: unknown }>(socket, ready, 'match:offerDraw', async (u, p) => {
      await this.live.offerDraw(u.id, str(p.matchId, 'Mã ván'), actor);
      return {};
    });

    this.on<{ matchId: unknown; accept: unknown }>(socket, ready, 'match:respondDraw', async (u, p) => {
      await this.live.respondDraw(u.id, str(p.matchId, 'Mã ván'), p.accept === true, actor);
      return {};
    });

    this.on<{ matchId: unknown; content: unknown }>(socket, ready, 'chat:send', async (u, p) => ({
      message: await this.chat.send(u, str(p.matchId, 'Mã ván'), p.content),
    }));

    this.on<{ messageId: unknown }>(socket, ready, 'chat:report', async (u, p) => {
      await this.chat.report(u.id, p.messageId);
      return {};
    });
  }
}
