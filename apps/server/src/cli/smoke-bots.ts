/**
 * Kiểm thử đầu-cuối tài khoản máy chơi trên server đang chạy (cần docker-compose + server + đã chạy bots:seed).
 *   npm run smoke:bots -w @cotuong/server [-- --game chess] [-- --moves 4]
 * Một người chơi mới vào hàng chờ xếp hạng một mình → sau BOT_FALLBACK_SEC giây (mặc định 30) được ghép với máy;
 * máy đi nước hợp lệ trong thời gian hợp lý, từ chối hoà; người chơi đầu hàng → điểm/lịch sử cập nhật bình thường;
 * không API / sự kiện nào lộ thông tin "là máy". Máy không đăng nhập được.
 * Biến môi trường: SMOKE_BASE (mặc định http://localhost:3000), MAILPIT_URL (mặc định http://localhost:8025),
 * BOT_FALLBACK_SEC (thời gian chờ server đang dùng, mặc định 30 — chỉ để kiểm tra thời điểm ghép).
 * Kết nối thẳng PostgreSQL / Redis theo DATABASE_URL / REDIS_URL (thiếu thì lấy từ apps/server/.env) — chạy vào server
 * khác (SMOKE_BASE) thì đặt hai biến này đúng DB / Redis của server đó.
 * Tạo người chơi thử bằng POST /api/auth/register kiểu cũ → server cần ALLOW_LEGACY_REGISTER bật (mặc định bật khi
 * NODE_ENV khác production; tắt thì endpoint trả 404). Bước này gửi một thư xác thực tới địa chỉ @test.local → KHÔNG
 * chạy vào server gửi thư thật (Gmail…).
 */
import { io, type Socket } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { replayGame, type GameType } from '@cotuong/game-core';
import type { MatchEndedDto, MatchStateDto, MoveEventDto } from '@cotuong/shared';
import { AppConfig } from '../config';
import { botGameOfEmail } from '../bots/bot-accounts';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const FALLBACK_SEC = Number(process.env.BOT_FALLBACK_SEC || 30);
const argOf = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const GAME: GameType = argOf('--game') === 'chess' ? 'chess' : 'xiangqi';
const HUMAN_MOVES = Math.max(1, Number(argOf('--moves') ?? 4));

let failures = 0;
let passes = 0;
function check(cond: unknown, label: string, extra?: unknown): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tìm khoá/giá trị lộ thông tin máy trong một đối tượng JSON bất kỳ */
function leaks(value: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...leaks(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^(is_?bot|bot_?level|bot)$/i.test(k)) out.push(`${path}.${k}`);
      out.push(...leaks(v, `${path}.${k}`));
    }
  } else if (typeof value === 'string' && value.includes('bots.invalid')) out.push(`${path} (email máy)`);
  return out;
}

async function api(method: string, path: string, cookie = '', body?: unknown): Promise<{ status: number; body: any; cookie: string }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let next = cookie;
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [name, v] = pair.split('=');
    if (name === 'ct_session') next = v ? `ct_session=${v}` : '';
  }
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* không phải JSON */
  }
  return { status: res.status, body: parsed, cookie: next };
}

function waitFor<T = any>(socket: Socket, event: string, pred: (p: T) => boolean = () => true, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Hết thời gian chờ sự kiện ${event}`));
    }, ms);
    const handler = (p: T) => {
      if (pred(p)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(p);
      }
    };
    socket.on(event, handler);
  });
}

async function mailCount(to: string): Promise<number> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=500`)).json()) as {
    messages: Array<{ To: Array<{ Address: string }> }>;
  };
  return (list.messages ?? []).filter((m) => m.To?.some((t) => t.Address.toLowerCase() === to.toLowerCase())).length;
}

async function main(): Promise<void> {
  const run = Date.now().toString(36);
  const cfg = new AppConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: cfg.databaseUrl } } });
  const redis = new Redis(cfg.redisUrl);
  const seen: Array<{ where: string; payload: unknown }> = [];

  console.log(`1. Tài khoản máy (${BASE})`);
  const bots = await prisma.user.findMany({ where: { isBot: true }, orderBy: { email: 'asc' } });
  check(bots.length >= 1, `có tài khoản máy trong DB (${bots.length})`);
  if (!bots.length) {
    console.log('  → chạy trước: npm run bots:seed -w @cotuong/server');
    process.exit(1);
  }
  // Mỗi loại tìm trận xếp hạng có 7 máy riêng: 3 Trung bình + 4 Khó
  for (const g of ['xiangqi', 'chess'] as const) {
    const list = bots.filter((b) => botGameOfEmail(b.email) === g);
    const lvl = (l: string) => list.filter((b) => b.botLevel === l).length;
    check(list.length === 7 && lvl('medium') === 3 && lvl('hard') === 4, `${g}: 7 máy (3 Trung bình + 4 Khó)`, [list.length, lvl('medium'), lvl('hard')]);
  }
  check(bots.every((b) => b.emailVerifiedAt !== null && b.role === 'player'), 'máy: email đã xác thực, vai trò người chơi');

  const someBot = bots[0];
  const human = { username: `Thử máy ${run}`.slice(0, 20), email: `bot-smoke-${run}@test.local`, password: 'matkhau123', cookie: '', id: '' };
  const reg = await api('POST', '/api/auth/register', '', { username: human.username, email: human.email, password: human.password });
  if (reg.status === 404) {
    console.log('  → server tắt đăng ký kiểu cũ (ALLOW_LEGACY_REGISTER=false): bật ALLOW_LEGACY_REGISTER=true cho server thử nghiệm rồi chạy lại');
    process.exit(1);
  }
  check(reg.status === 201, `đăng ký người chơi thử ${human.username}`, reg.body);
  human.cookie = reg.cookie;
  human.id = reg.body.user?.id;
  await prisma.user.update({ where: { id: human.id }, data: { emailVerifiedAt: new Date() } });

  // Không ai đăng ký trước được email thuộc tên miền dành riêng cho máy (lỗi y như email sai định dạng)
  const badEmail = await api('POST', '/api/auth/register', '', { username: `Bad ${run}`.slice(0, 20), email: 'khong-hop-le', password: 'matkhau123' });
  const reserved = await api('POST', '/api/auth/register', '', { username: `Res ${run}`.slice(0, 20), email: `bot99-${run}@Bots.Invalid`, password: 'matkhau123' });
  check(
    reserved.status === 400 && reserved.body.message === badEmail.body.message,
    'không đăng ký được email thuộc tên miền của máy (báo như email không hợp lệ)',
    [reserved.status, reserved.body.message, badEmail.body.message],
  );
  const wrongHuman = await api('POST', '/api/auth/login', '', { email: human.email, password: 'sai-mat-khau-1' });
  const botLogin = await api('POST', '/api/auth/login', '', { email: someBot.email, password: 'matkhau123' });
  check(
    botLogin.status === 401 && botLogin.body.message === wrongHuman.body.message,
    'máy không đăng nhập bằng mật khẩu được (lỗi y như sai mật khẩu)',
    [botLogin.status, botLogin.body.message, wrongHuman.body.message],
  );
  const before = await mailCount(someBot.email);
  const forgot = await api('POST', '/api/auth/forgot-password', '', { email: someBot.email });
  await sleep(1500);
  check(forgot.status === 200 && (await mailCount(someBot.email)) === before, 'quên mật khẩu với email máy: trả lời như thường, không gửi thư');
  // Phiên giả mạo (ký đúng bí mật, có cả bản ghi phiên ở Redis) cho máy vẫn không được chấp nhận
  const sid = randomBytes(18).toString('base64url');
  await redis.set(`sess:${sid}`, someBot.id, 'EX', 60);
  const forged = jwt.sign({ sub: someBot.id, sid, typ: 'session' }, cfg.jwtSecret, { expiresIn: 60, algorithm: 'HS256' });
  const meForged = await api('GET', '/api/auth/me', `${cfg.cookieName}=${forged}`);
  check(meForged.status === 200 && meForged.body.user === null, 'phiên đăng nhập của máy không bao giờ hợp lệ', meForged.body);
  await redis.del(`sess:${sid}`);

  console.log(`2. Chờ một mình ở hàng chờ xếp hạng (${GAME}) → ghép với máy sau ~${FALLBACK_SEC} giây`);
  const socket = io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: human.cookie }, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  for (const ev of ['match:found', 'match:move', 'match:ended', 'match:drawDeclined', 'match:connection', 'queue:status']) {
    socket.on(ev, (p: unknown) => seen.push({ where: `socket ${ev}`, payload: p }));
  }
  const emit = async <T = any>(event: string, payload: unknown = {}): Promise<T> =>
    (await socket.timeout(8000).emitWithAck(event, payload)) as T;

  const foundP = waitFor<{ matchId: string; game: string }>(socket, 'match:found', () => true, (FALLBACK_SEC + 25) * 1000);
  const t0 = Date.now();
  const q = await emit('queue:join', { game: GAME });
  check(q.ok && q.status.searching, 'vào hàng chờ xếp hạng', q);
  seen.push({ where: 'queue:join ack', payload: q });
  const found = await foundP;
  const waited = Date.now() - t0;
  check(waited >= FALLBACK_SEC * 1000 - 1500 && waited <= FALLBACK_SEC * 1000 + 12_000, `được ghép sau ${(waited / 1000).toFixed(1)} giây`);
  const matchId = found.matchId;

  const join = await emit<{ ok: boolean; state: MatchStateDto; error?: string }>('match:join', { matchId });
  check(join.ok, 'vào bàn cờ', join.error);
  seen.push({ where: 'match:join ack', payload: join });
  let state = join.state;
  const myColor = state.myColor!;
  const botColor = (1 - myColor) as 0 | 1;
  const opp = state.players[botColor];
  const oppRow = await prisma.user.findUnique({ where: { id: opp.userId } });
  check(oppRow?.isBot === true, `đối thủ là tài khoản máy: ${opp.username} (mức ${oppRow?.botLevel})`);
  check(!!oppRow && botGameOfEmail(oppRow.email) === GAME, `máy được ghép đúng loại cờ (${GAME})`, oppRow && botGameOfEmail(oppRow.email));
  check(oppRow?.botLevel === 'medium' || oppRow?.botLevel === 'hard', 'máy mức Trung bình hoặc Khó', oppRow?.botLevel);
  check(state.ranked && state.kind === 'ranked' && state.clock.initialMs === 900_000 && state.clock.incrementMs === 10_000, 'ván xếp hạng 15 phút + 10 giây như thường');
  check(state.firstMoveDeadline !== null, 'có luật 30 giây cho nước đầu');
  check(opp.rating !== null && typeof opp.tier === 'string', 'đối thủ có điểm và cấp bậc như người chơi', opp);
  const dbMatch0 = await prisma.match.findUnique({ where: { id: matchId } });
  check(dbMatch0?.ranked === true && dbMatch0.mode === 'pvp' && dbMatch0.seasonId !== null, 'ván ghi vào DB như ván người với người (pvp, xếp hạng, có mùa)');
  // Máy luôn "đang kết nối"
  let connected = false;
  for (let i = 0; i < 10 && !connected; i++) {
    const again = await emit<{ ok: boolean; state: MatchStateDto }>('match:join', { matchId });
    connected = again.ok && again.state.disconnectedUntil[botColor] === null;
    if (!connected) await sleep(500);
  }
  check(connected, 'máy hiện là đang kết nối (không có đồng hồ mất kết nối)');

  console.log(`3. Đánh ${HUMAN_MOVES} nước, máy trả lời`);
  const moves = state.moves.slice();
  const replyTimes: number[] = [];
  let ended: MatchEndedDto | null = null;
  socket.on('match:ended', (e: MatchEndedDto) => {
    if (e.matchId === matchId) ended = e;
  });
  const botMove = (ply: number, ms: number) =>
    waitFor<MoveEventDto>(socket, 'match:move', (e) => e.matchId === matchId && e.ply === ply, ms);
  if (myColor === 1) {
    // Máy cầm Đỏ/Trắng: đi trước, phải đi trong 30 giây
    const t = Date.now();
    const e = await botMove(1, 31_000);
    replyTimes.push(Date.now() - t);
    moves.push(e.move);
    check(true, `máy đi nước đầu ${e.move} sau ${((Date.now() - t) / 1000).toFixed(1)} giây`);
  }
  let declineChecked = false;
  for (let i = 0; i < HUMAN_MOVES && !ended; i++) {
    const engine = replayGame(GAME, moves);
    if (engine.status().over) break;
    const legal = engine.legalMoves().filter((m) => GAME !== 'xiangqi' || !engine.isPerpetualCheckLoss(m));
    // Lượt mình: thử mời hoà một lần — máy phải từ chối
    if (!declineChecked) {
      declineChecked = true;
      const declined = waitFor(socket, 'match:drawDeclined', (p: { matchId: string }) => p.matchId === matchId, 8000);
      const offer = await emit('match:offerDraw', { matchId });
      check(offer.ok, 'mời hoà máy');
      const d = await declined.then(() => true).catch(() => false);
      check(d, 'máy từ chối hoà');
    }
    const mv = legal[Math.floor(Math.random() * legal.length)];
    const reply = botMove(moves.length + 2, 20_000);
    const r = await emit('match:move', { matchId, move: mv });
    check(r.ok, `người chơi đi ${mv}`, r);
    moves.push(mv);
    const t = Date.now();
    try {
      const e = await reply;
      replyTimes.push(Date.now() - t);
      moves.push(e.move);
      check(replayGame(GAME, moves.slice(0, -1)).isLegal(e.move), `máy đi ${e.move} (hợp lệ) sau ${((Date.now() - t) / 1000).toFixed(1)} giây`);
      const left = e.clock.remaining[botColor];
      check(left > 840_000, `đồng hồ máy còn ${(left / 1000).toFixed(0)} giây`);
    } catch (err) {
      if (!ended) check(false, 'máy trả lời trong 20 giây', (err as Error).message);
    }
  }
  check(replyTimes.every((t) => t >= 300 && t <= 15_000), 'thời gian mỗi nước của máy trong khoảng hợp lý', replyTimes);

  console.log('4. Đầu hàng, điểm và lịch sử');
  const rBefore = await prisma.rating.findMany({ where: { seasonId: dbMatch0!.seasonId!, userId: { in: [human.id, opp.userId] } } });
  const endedP = waitFor<MatchEndedDto>(socket, 'match:ended', (e) => e.matchId === matchId, 10_000);
  if (!ended) {
    const rs = await emit('match:resign', { matchId });
    // Người thử đi nước ngẫu nhiên nên có thể vừa bị máy chiếu hết ngay trước khi kịp đầu hàng — vẫn hợp lệ
    check(rs.ok || /đã kết thúc/.test(String(rs.error)), 'người chơi đầu hàng (hoặc ván vừa kết thúc trước đó)', rs);
  }
  const end = ended ?? (await endedP);
  seen.push({ where: 'match:ended', payload: end });
  check(end.result.reason === 'resign' ? end.result.winner === botColor : true, `kết quả: ${JSON.stringify(end.result)}`);
  check(end.ratingChanges !== null, 'ván xếp hạng có thay đổi điểm', end.ratingChanges);
  const dbMatch = await prisma.match.findUnique({ where: { id: matchId } });
  check(dbMatch?.endedAt && dbMatch.result && dbMatch.ratingChange !== null, 'DB: kết quả và điểm của ván đã ghi', dbMatch && { result: dbMatch.result, rc: dbMatch.ratingChange, rc2: dbMatch.ratingChange2 });
  const rAfter = await prisma.rating.findMany({ where: { seasonId: dbMatch0!.seasonId!, userId: { in: [human.id, opp.userId] } } });
  for (const id of [human.id, opp.userId]) {
    const b = rBefore.find((x) => x.userId === id);
    const a = rAfter.find((x) => x.userId === id);
    check(a && a.gamesPlayed === (b?.gamesPlayed ?? 0) + 1, `${id === human.id ? 'người chơi' : 'máy'}: số ván xếp hạng +1 (${b?.gamesPlayed ?? 0} → ${a?.gamesPlayed})`);
  }
  check((await redis.get(`u:match:${opp.userId}`)) === null, 'máy rảnh lại sau ván');

  const hist = await api('GET', `/api/users/${human.id}/matches?game=${GAME}`, human.cookie);
  const item = hist.body.items?.find((m: any) => m.id === matchId);
  check(item && item.ranked && item.opponent?.id === opp.userId && typeof item.ratingChange === 'number', 'lịch sử ván của người chơi có ván với máy (như người thường)', item);
  const botHist = await api('GET', `/api/users/${opp.userId}/matches?game=${GAME}`, human.cookie);
  const replay = await api('GET', `/api/matches/${matchId}`, human.cookie);
  check(replay.status === 200 && replay.body.moves.join(' ') === dbMatch!.moves.join(' '), 'xem lại ván');
  const prof = await api('GET', `/api/users/${opp.userId}/profile`, human.cookie);
  check(prof.status === 200 && prof.body.user?.role === 'player', 'hồ sơ máy xem được như người chơi thường');
  const lb = await api('GET', `/api/leaderboard/${GAME}`, human.cookie);
  const me = await api('GET', '/api/auth/me', human.cookie);

  console.log('5. Không lộ thông tin "là máy"');
  for (const [where, payload] of [
    ['GET /users/:bot/profile', prof.body],
    ['GET /users/:human/matches', hist.body],
    ['GET /users/:bot/matches', botHist.body],
    ['GET /matches/:id', replay.body],
    ['GET /leaderboard', lb.body],
    ['GET /auth/me', me.body],
  ] as const) {
    seen.push({ where, payload });
  }
  const found2 = seen.flatMap((s) => leaks(s.payload).map((p) => `${s.where}: ${p}`));
  check(found2.length === 0, `không có trường isBot/botLevel trong ${seen.length} phản hồi/sự kiện`, found2.slice(0, 10));

  socket.disconnect();
  redis.disconnect();
  await prisma.$disconnect();
  console.log(`\nKết quả: ${passes} đạt, ${failures} lỗi`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
