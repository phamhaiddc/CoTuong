import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { createGame, type GameEngine, type GameType } from '@cotuong/game-core';
import {
  AI_LEVELS,
  AI_LEVEL_LABEL,
  COLOR_LABEL,
  CUSTOM_TIME_LIMITS,
  FIRST_MOVE_TIMEOUT_MS,
  GAME_LABEL,
  LEADERBOARD_MIN_GAMES,
  LEADERBOARD_SIZE,
  MATCHMAKING,
  PRIVATE_ROOM_TTL_MS,
  RANKED_TIME_CONTROL,
  PUZZLE_COUNT,
  RECONNECT_GRACE_MS,
  deserializeTiers,
  getTier,
  matchmakingRange,
  validateCustomTimeControl,
  type AiLevel,
  type MeDto,
  type MyStanding,
  type RoomDto,
  type SeasonDto,
  type TierDef,
} from '@cotuong/shared';
import { api, loadAppConfig } from '../api/http';
import { emit } from '../api/socket';
import { GameBoard, lastMoveOf } from '../components/Board';
import { GameIcon, Icon, type IconName } from '../components/icons';
import { Top10Card, useLeaderboard } from '../components/Sidebar';
import {
  Avatar,
  ROOM_TTL_MINUTES,
  TierBadge,
  formatClock,
  normalizeRoomCode,
  roomGameLabel,
  tierColor,
  timeControlText,
  useNow,
} from '../components/ui';
import { useAuth, useEnsurePlayer } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useRealtime } from '../state/realtime';
import { useToast } from '../state/toast';

type Mode = 'ranked' | 'private' | 'ai';
type Side = 0 | 1 | 'random';

export interface AiSetup {
  game: GameType;
  level: AiLevel;
  side: 0 | 1 | 'random';
  timeControl: { initialMs: number; incrementMs: number } | null;
  /** 'jieqi' = Cờ úp (bàn cờ tướng); mặc định cờ thường */
  variant?: 'standard' | 'jieqi';
}

const MODES: ReadonlyArray<{ id: Mode; label: string; icon: IconName }> = [
  { id: 'ranked', label: 'Xếp hạng', icon: 'trophy' },
  { id: 'private', label: 'Phòng riêng', icon: 'users' },
  { id: 'ai', label: 'Đấu với máy', icon: 'bot' },
];

const RANKED_MINUTES = RANKED_TIME_CONTROL.initialMs / 60_000;
const RANKED_INCREMENT = RANKED_TIME_CONTROL.incrementMs / 1000;

/** Thời gian có sẵn (phút + giây cộng mỗi nước); nhãn theo cách phân loại phổ biến */
const TIME_PRESETS: ReadonlyArray<{ minutes: number; inc: number; tag: string }> = [
  { minutes: 3, inc: 2, tag: 'Chớp' },
  { minutes: 5, inc: 3, tag: 'Chớp' },
  { minutes: 10, inc: 5, tag: 'Nhanh' },
  { minutes: 15, inc: 10, tag: 'Nhanh' },
  { minutes: 30, inc: 0, tag: 'Chậm' },
];

/** Ký tự đặc biệt viết bằng mã số để mã nguồn không chứa ký tự vô hình */
const NBSP = String.fromCharCode(0xa0); // dấu cách không ngắt dòng
const TEXT_VS = String.fromCharCode(0xfe0e); // buộc hiển thị quân cờ vua dạng chữ, không phải emoji
const KNIGHT_GLYPH = String.fromCharCode(0x265e) + TEXT_VS;
const KING_GLYPH = String.fromCharCode(0x265a) + TEXT_VS;

// NBSP giữ các cụm từ trên cùng một dòng khi thẻ hẹp
const LEVEL_HINT: Record<AiLevel, string> = {
  easy: `Người${NBSP}mới học${NBSP}luật`,
  medium: `Người${NBSP}chơi thường${NBSP}xuyên`,
  hard: `Người${NBSP}chơi mạnh`,
};
const LEVEL_BARS: Record<AiLevel, number> = { easy: 1, medium: 2, hard: 3 };
const SIDE_HINT: Record<'0' | '1' | 'random', string> = { '0': 'Đi trước', '1': 'Đi sau', random: 'Bốc thăm' };

/** Ván mẫu chạy trên bàn cờ xem trước (khai cuộc phổ biến, đã kiểm tra hợp lệ với game-core) */
const DEMO: Record<GameType, { name: string; moves: string[] }> = {
  xiangqi: { name: 'Pháo đầu đối Bình phong mã', moves: ['h2e2', 'h9g7', 'h0g2', 'i9h9', 'i0h0', 'b9c7', 'c3c4', 'g6g5'] },
  chess: { name: 'Khai cuộc Tây Ban Nha', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6'] },
};

// --------------------------------------------------------------------------- Biểu tượng riêng của trang

const LOCAL_ICONS = {
  minus: 'M5 12h14',
  share: 'M12 14.5V3.5M8 7.5l4-4 4 4M8.5 10.5H6.5A1.5 1.5 0 0 0 5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7a1.5 1.5 0 0 0-1.5-1.5h-2',
} as const;

function LocalIcon({ name, size = 20 }: { name: keyof typeof LOCAL_ICONS; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={LOCAL_ICONS[name]} />
    </svg>
  );
}

// --------------------------------------------------------------------------- Hooks

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED_MOTION);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Danh sách cấp bậc từ /api/config (dùng chung lần tải cấu hình với các trang khác — loadAppConfig) */
let tiersRequest: Promise<TierDef[] | null> | null = null;

function useTiers(): TierDef[] | null {
  const [tiers, setTiers] = useState<TierDef[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (!tiersRequest) {
      tiersRequest = loadAppConfig()
        .then((c) => deserializeTiers(c.tiers))
        .catch(() => {
          tiersRequest = null;
          return null;
        });
    }
    void tiersRequest.then((t) => alive && setTiers(t));
    return () => {
      alive = false;
    };
  }, []);
  return tiers;
}

interface TierProgress {
  /** Cấp kế tiếp (null = đã ở cấp cao nhất) */
  next: string | null;
  nextLevel: number;
  need: number;
  pct: number;
}

function tierProgress(rating: number, tiers: readonly TierDef[]): TierProgress | null {
  if (!tiers.length) return null;
  const cur = getTier(rating, tiers);
  const i = tiers.length - 1 - cur.level;
  if (i <= 0) return { next: null, nextLevel: cur.level, need: 0, pct: 1 };
  const next = tiers[i - 1];
  // Cấp thấp nhất không có mốc dưới: lấy độ rộng của cấp kế tiếp làm thang đo cho thanh tiến độ
  const above = i - 2 >= 0 ? tiers[i - 2].min : null;
  const span = Number.isFinite(tiers[i].min) ? next.min - tiers[i].min : above !== null ? above - next.min : 200;
  const lo = next.min - span;
  const pct = span > 0 ? Math.min(1, Math.max(0, (rating - lo) / span)) : 0;
  return { next: next.name, nextLevel: cur.level + 1, need: Math.max(0, next.min - rating), pct };
}

// --------------------------------------------------------------------------- Chưa có tài khoản: lời mời đăng nhập (chỉ xếp hạng)

/** Chỉ ván xếp hạng cần tài khoản; phòng riêng và đấu với máy ai cũng chơi được (khách) */
const RANKED_INFO: { what: string; points: Array<{ icon: IconName; text: ReactNode }> } = {
  what: 'chơi ván xếp hạng',
  points: [
    {
      icon: 'clock',
      text: (
        <>
          Mỗi bên <b>{RANKED_MINUTES} phút</b>, đi xong mỗi nước được cộng thêm <b>{RANKED_INCREMENT} giây</b>
        </>
      ),
    },
    {
      icon: 'target',
      text: (
        <>
          Ưu tiên người cùng trình độ (chênh không quá <b>{MATCHMAKING.initialRange} điểm</b>, chờ lâu thì nới dần tới{' '}
          {MATCHMAKING.maxRange}); có người khác đang tìm trận thì luôn được ghép ngay
        </>
      ),
    },
    { icon: 'trophy', text: <>Thắng cộng điểm, thua trừ điểm; có cấp bậc và Top {LEADERBOARD_SIZE} mỗi mùa giải (theo quý)</> },
  ],
};

function FactList({ items, label }: { items: Array<{ icon: IconName; text: ReactNode }>; label: string }) {
  return (
    <ul className="hm-facts" aria-label={label}>
      {items.map((f, i) => (
        <li key={i}>
          <span className="hm-fact-ico" aria-hidden="true">
            <Icon name={f.icon} size={17} />
          </span>
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Khung chờ trong lúc chưa biết đã đăng nhập hay chưa */
function PanelSkeleton() {
  return (
    <div className="hm-body" aria-busy="true">
      <div className="skeleton hm-sk-block" />
      <div className="skeleton hm-sk-line" />
      <div className="skeleton hm-sk-btn" />
    </div>
  );
}

/** Ván xếp hạng cần tài khoản: người chưa đăng nhập và khách thấy lời mời đăng nhập */
function LoginPrompt() {
  const location = useLocation();
  const { loading } = useAuth();
  if (loading) return <PanelSkeleton />;
  const info = RANKED_INFO;
  return (
    <div className="hm-body hm-login">
      <FactList items={info.points} label="Điểm nổi bật" />
      <div className="hm-lp-box">
        <span className="hm-lp-lock" aria-hidden="true">
          <Icon name="lock" size={18} />
        </span>
        <p>Bạn cần đăng nhập để {info.what}.</p>
      </div>
      <div className="hm-lp-actions">
        <Link className="btn btn-soft" to="/login" state={{ from: location.pathname }}>
          <Icon name="login" size={18} /> Đăng nhập
        </Link>
        <Link className="btn btn-ghost" to="/register">
          Đăng ký
        </Link>
      </div>
    </div>
  );
}

const FEATURES: ReadonlyArray<{ icon: IconName; tone: 'gold' | 'primary' | 'info'; title: string; text: string }> = [
  { icon: 'trophy', tone: 'gold', title: 'Ván xếp hạng', text: `Tích điểm hạng, lên cấp bậc, vào Top ${LEADERBOARD_SIZE} mỗi mùa giải` },
  { icon: 'users', tone: 'primary', title: 'Phòng riêng với bạn bè', text: 'Gửi mã hoặc đường dẫn mời, tự chọn thời gian' },
  { icon: 'bot', tone: 'info', title: 'Đấu với máy', text: 'Ba mức độ, xin gợi ý nước đi thoải mái' },
];

function GuestHero({ game }: { game: GameType }) {
  const location = useLocation();
  return (
    <section className="panel hm-hero" aria-labelledby="home-hero-title">
      <span className={`hm-hero-art hm-hero-art-${game}`} aria-hidden="true">
        {game === 'xiangqi' ? '帥' : KNIGHT_GLYPH}
      </span>
      <div className="hm-hero-eyebrow">
        <span className="hm-hero-eyebrow-icons" aria-hidden="true">
          <GameIcon game="xiangqi" size={18} />
          <GameIcon game="chess" size={18} />
        </span>
        Cờ tướng &amp; Cờ vua trực tuyến
      </div>
      <h2 id="home-hero-title" className="hm-hero-title">
        Chơi <em>{GAME_LABEL[game]}</em> trực{NBSP}tuyến, <span className="nowrap">leo hạng mỗi quý</span>
      </h2>
      <p className="hm-hero-sub">
        Đấu xếp hạng với người cùng trình độ, mời bạn bè vào phòng riêng hoặc luyện tập với máy — trên cả máy tính lẫn
        điện thoại.
      </p>
      <div className="hm-hero-cta">
        <Link className="btn btn-primary btn-lg" to="/register">
          Đăng ký miễn phí <Icon name="arrow-right" size={19} />
        </Link>
        <Link className="btn btn-ghost btn-lg" to="/login" state={{ from: location.pathname }}>
          Đăng nhập
        </Link>
      </div>
      <ul className="hm-hero-features">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <span className={`hm-hf-ico hm-tone-${f.tone}`} aria-hidden="true">
              <Icon name={f.icon} size={20} />
            </span>
            <span className="hm-hf-text">
              <b>{f.title}</b>
              <span>{f.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- Xếp hạng

function Meter({ label, value, pct }: { label: ReactNode; value: ReactNode; pct: number }) {
  return (
    <div className="hm-meter">
      <div className="hm-meter-head">
        <span className="hm-meter-label">{label}</span>
        <span className="hm-meter-value">{value}</span>
      </div>
      <div className="hm-meter-track" aria-hidden="true">
        <span className="hm-meter-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
    </div>
  );
}

function PlayerCard({
  me,
  standing,
  season,
  tiers,
}: {
  me: MeDto;
  standing: MyStanding;
  season: SeasonDto | null;
  tiers: TierDef[] | null;
}) {
  const min = standing.minGames || LEADERBOARD_MIN_GAMES;
  const played = Math.min(standing.gamesPlayed, min);
  const progress = tiers ? tierProgress(standing.rating, tiers) : null;
  const style = { '--tier': tierColor(standing.tierLevel) } as CSSProperties;
  return (
    <div className="hm-pcard" style={style}>
      <div className="hm-pcard-top">
        <span className="hm-pcard-avatar">
          <Avatar name={me.username} url={me.avatarUrl} size={38} />
        </span>
        <div className="hm-pcard-id">
          <Link className="hm-pcard-name" to={`/profile/${me.id}`} title="Xem hồ sơ và lịch sử ván đấu">
            {me.username}
          </Link>
          <TierBadge name={standing.tier} level={standing.tierLevel} />
        </div>
        <div className="hm-pcard-rating">
          <b className="num">{standing.rating}</b>
          <span>điểm</span>
        </div>
      </div>
      <div className="hm-pcard-meters">
        {standing.rank ? (
          <div className="hm-pcard-status">
            <span className="hm-pcard-status-ico" aria-hidden="true">
              <Icon name="trophy" size={16} />
            </span>
            <span>
              Hạng <b>{standing.rank}</b> mùa này
            </span>
            {standing.rank <= LEADERBOARD_SIZE && <span className="chip chip-gold">Top {LEADERBOARD_SIZE}</span>}
          </div>
        ) : standing.gamesPlayed < min ? (
          <Meter
            label={`Chơi đủ ${min} ván để có thứ hạng`}
            value={`${played}/${min} ván`}
            pct={played / min}
          />
        ) : (
          <div className="hm-pcard-status muted">Chưa xếp hạng</div>
        )}
        {progress && (
          // Tiến độ cấp bậc: một dòng chữ gọn (thanh tiến độ chính dành cho số ván / thứ hạng)
          <div className="hm-pcard-next" title={season ? `Mùa giải quý ${season.quarter}/${season.year} · còn ${season.daysLeft} ngày` : undefined}>
            {progress.next ? (
              <>
                <span className="hm-next-dot" style={{ background: tierColor(progress.nextLevel) }} aria-hidden="true" />
                <span>
                  Còn <b className="num">{progress.need}</b> điểm nữa lên <b>{progress.next}</b>
                </span>
              </>
            ) : (
              <>
                <Icon name="crown" size={14} />
                <span>Bạn đang ở cấp cao nhất</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Luật ván xếp hạng dạng chip ngắn gọn (câu đầy đủ cho trình đọc màn hình và khi rê chuột) */
function RankedRules() {
  const rules: Array<{ icon: IconName; short: ReactNode; full: string }> = [
    {
      icon: 'clock',
      short: (
        <>
          {RANKED_MINUTES} phút + {RANKED_INCREMENT} giây/nước
        </>
      ),
      full: `Mỗi bên ${RANKED_MINUTES} phút, đi xong mỗi nước được cộng thêm ${RANKED_INCREMENT} giây`,
    },
    {
      icon: 'target',
      short: <>Cùng trình độ</>,
      full: `Ưu tiên người chênh không quá ${MATCHMAKING.initialRange} điểm với bạn (chờ lâu thì nới dần tới ${MATCHMAKING.maxRange}); có người khác đang tìm trận thì luôn được ghép ngay`,
    },
    {
      icon: 'bolt',
      short: <>Thắng cộng, thua trừ điểm</>,
      full: 'Thắng được cộng điểm hạng, thua bị trừ (không xuống dưới 0). Thắng người điểm cao hơn được cộng nhiều hơn.',
    },
  ];
  return (
    <ul className="hm-rules" aria-label="Luật ván xếp hạng">
      {rules.map((r, i) => (
        <li key={i} title={r.full}>
          <Icon name={r.icon} size={14} />
          <span aria-hidden="true">{r.short}</span>
          <span className="sr-only">{r.full}</span>
        </li>
      ))}
    </ul>
  );
}

function SearchCard({
  game,
  waited,
  rating,
  onCancel,
}: {
  game: GameType;
  waited: number;
  rating: number | null;
  onCancel: () => void;
}) {
  const range = matchmakingRange(waited);
  const pct = Math.min(1, range / MATCHMAKING.maxRange);
  return (
    <div className="hm-search">
      <div className="hm-radar" aria-hidden="true">
        <span className="hm-radar-sweep" />
        <span className="hm-radar-ring" />
        <span className="hm-radar-ring" />
        <span className="hm-radar-ring" />
        <span className="hm-radar-core">
          <GameIcon game={game} size={30} />
        </span>
      </div>
      <p className="hm-search-title" role="status">
        Đang tìm đối thủ {GAME_LABEL[game]}…
      </p>
      <div className="hm-search-time num">
        <span className="sr-only">Đã chờ </span>
        {formatClock(waited)}
      </div>
      <p className="hm-search-hint">Tìm thấy là ván tự mở — bạn cứ để trang này mở.</p>
      <div className="hm-search-chips">
        <span className="chip" title={`Ván xếp hạng ${GAME_LABEL[game]}`}>
          <Icon name="clock" size={13} /> {RANKED_MINUTES} phút + {RANKED_INCREMENT} giây/nước
        </span>
        {rating !== null && <span className="chip chip-gold">Điểm của bạn: {rating}</span>}
      </div>
      <div className="hm-range">
        <div className="hm-range-head">
          <span>Tìm người chênh tối đa</span>
          <b className="num">±{range} điểm</b>
        </div>
        <div className="hm-range-track" aria-hidden="true">
          <span className="hm-range-band" style={{ width: `${pct * 100}%` }} />
          <span className="hm-range-you" />
        </div>
        <div className="hm-range-scale" aria-hidden="true">
          <span>−{MATCHMAKING.maxRange}</span>
          <span>Bạn</span>
          <span>+{MATCHMAKING.maxRange}</span>
        </div>
        <p className="hm-range-note">
          {range < MATCHMAKING.maxRange ? 'Chờ càng lâu, khoảng này càng rộng để dễ gặp đối thủ hơn.' : 'Đã mở rộng tối đa.'}
        </p>
      </div>
      <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
        Huỷ tìm đối thủ
      </button>
    </div>
  );
}

/** Đang có phòng riêng chờ bạn bè: không tìm đối thủ được cho tới khi huỷ phòng */
function OpenRoomNotice({ room, onShowRoom, what }: { room: RoomDto; onShowRoom?: () => void; what: string }) {
  const { cancelRoom } = useRealtime();
  const [busy, setBusy] = useState(false);
  return (
    <div className="notice info" role="status">
      <Icon name="users" size={18} />
      <div className="grow">
        <div>
          Bạn đang có <b>phòng riêng {roomGameLabel(room)}</b> (mã <b className="num">{room.code}</b>) chờ bạn bè vào. Huỷ phòng
          này nếu muốn {what}.
        </div>
        <div className="hm-notice-actions">
          {onShowRoom && (
            <button type="button" className="link-btn" onClick={onShowRoom}>
              Xem phòng
            </button>
          )}
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await cancelRoom();
              setBusy(false);
            }}
          >
            {busy ? 'Đang huỷ…' : 'Huỷ phòng'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Chưa xác thực email: chưa chơi ván xếp hạng được (các chế độ khác vẫn chơi được) */
function VerifyEmailNotice({ email }: { email: string }) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  return (
    <div className="notice warn">
      <Icon name="mail" size={18} />
      <div className="grow">
        <div>
          Ván xếp hạng chỉ dành cho tài khoản đã xác thực email. Hãy mở thư chúng tôi gửi tới <b>{email}</b> và bấm vào đường
          dẫn xác thực.
        </div>
        <div className="hm-notice-sub">Trong lúc chờ, bạn vẫn chơi được Phòng riêng, Đấu với máy và Cờ úp.</div>
        <div className="hm-notice-actions">
          <button
            type="button"
            className="link-btn"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await api.post('/api/auth/resend-verification');
                toast(`Đã gửi lại thư xác thực tới ${email}`, 'success');
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Không gửi được thư, bạn thử lại sau nhé', 'error');
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? 'Đang gửi…' : 'Gửi lại thư xác thực'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RankedPanel({ game, onShowRoom }: { game: GameType; onShowRoom: () => void }) {
  const { me } = useAuth();
  const { queue, joinQueue, leaveQueue, room } = useRealtime();
  const { setGame } = useGameSelect();
  const tiers = useTiers();
  // Cùng nguồn với thẻ Top 10 bên dưới (dùng chung bộ nhớ đệm và một lần gọi API)
  const { data: current, error: failed, retry } = useLeaderboard(game);
  const [busy, setBusy] = useState(false);
  const now = useNow(!!queue);

  // Chỉ tài khoản thành viên mới chơi xếp hạng (khách cũng thấy lời mời đăng nhập)
  if (!me) return <LoginPrompt />;

  // Hàng chờ Cờ úp (variant jieqi) không phải tìm trận xếp hạng
  const jieqiQueue = queue?.variant === 'jieqi';
  const searchingThis = !jieqiQueue && queue?.game === game;
  const waited = queue ? now - queue.since : 0;

  if (queue && searchingThis) {
    return (
      <div className="hm-body">
        <SearchCard game={game} waited={waited} rating={queue.rating ?? current?.me?.rating ?? null} onCancel={() => void leaveQueue()} />
      </div>
    );
  }

  return (
    <div className="hm-body">
      {current ? (
        current.me && <PlayerCard me={me} standing={current.me} season={current.season} tiers={tiers} />
      ) : failed ? (
        <div className="notice warn">
          <Icon name="alert" size={18} />
          <span className="grow">Không tải được điểm hạng của bạn.</span>
          <button type="button" className="link-btn" onClick={retry}>
            Thử lại
          </button>
        </div>
      ) : (
        <div className="hm-pcard is-loading" aria-busy="true">
          <div className="hm-pcard-top">
            <span className="skeleton hm-sk-avatar" />
            <div className="hm-pcard-id">
              <span className="skeleton hm-sk-text" />
              <span className="skeleton hm-sk-text short" />
            </div>
            <span className="skeleton hm-sk-rating" />
          </div>
          <div className="skeleton hm-sk-meter" />
        </div>
      )}
      <RankedRules />
      {/* Thứ tự ưu tiên: ván đang dở → đang tìm ở chỗ khác → phòng riêng đang chờ → chưa xác thực email → nút tìm */}
      {me.activeMatchId ? (
        <Link className="btn btn-primary btn-block btn-lg hm-cta" to={`/play/${me.activeMatchId}`}>
          <Icon name="play" size={20} /> Vào lại ván đang chơi
        </Link>
      ) : queue ? (
        <div className="notice info" role="status">
          <Icon name="search" size={18} />
          <div className="grow">
            <div>
              {jieqiQueue ? (
                <>
                  Bạn đang tìm đối thủ <b>Cờ úp</b>.
                </>
              ) : (
                <>
                  Bạn đang tìm đối thủ <b>{queue.game ? GAME_LABEL[queue.game] : ''}</b> (ván xếp hạng).
                </>
              )}
            </div>
            <div className="hm-notice-actions">
              {jieqiQueue ? (
                <Link className="link-btn" to="/co-up">
                  Mở trang Cờ úp
                </Link>
              ) : (
                queue.game && (
                  <button type="button" className="link-btn" onClick={() => setGame(queue.game!)}>
                    Chuyển sang {GAME_LABEL[queue.game]}
                  </button>
                )
              )}
              <button type="button" className="link-btn" onClick={() => void leaveQueue()}>
                Huỷ tìm đối thủ
              </button>
            </div>
          </div>
        </div>
      ) : room ? (
        <OpenRoomNotice room={room} onShowRoom={onShowRoom} what="tìm ván xếp hạng" />
      ) : !me.emailVerified ? (
        <VerifyEmailNotice email={me.email} />
      ) : (
        <div className="hm-cta-wrap">
          <button
            type="button"
            className="btn btn-primary btn-block btn-lg hm-cta"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await joinQueue(game);
              setBusy(false);
            }}
          >
            {busy ? <span className="hm-spinner" aria-hidden="true" /> : <Icon name="swords" size={20} />}
            Tìm ván xếp hạng
          </button>
          <p className="hm-cta-note">
            Lưu ý: phải đi nước đầu trong {FIRST_MOVE_TIMEOUT_MS / 1000} giây; đóng trang hoặc mất mạng quá{' '}
            {RECONNECT_GRACE_MS / 1000} giây sẽ bị xử thua.
          </p>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Chọn thời gian

function Stepper({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  /** Đơn vị cho nhãn nút −/+ ("Bớt 1 phút"), không lặp lại nhãn ô nhập để tránh trùng tên */
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const invalid = !Number.isInteger(value) || value < min || value > max;
  return (
    <div className={`hm-stepper${invalid ? ' is-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="hm-stepper-ctl">
        <button
          type="button"
          className="hm-step-btn"
          aria-label={`Bớt 1 ${unit}`}
          title={`Bớt 1 ${unit}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(Math.round(value) - 1))}
        >
          <LocalIcon name="minus" size={18} />
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(Math.round(Number(e.target.value)))}
        />
        <button
          type="button"
          className="hm-step-btn"
          aria-label={`Thêm 1 ${unit}`}
          title={`Thêm 1 ${unit}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(Math.round(value) + 1))}
        >
          <Icon name="plus" size={18} />
        </button>
      </div>
    </div>
  );
}

function TimePicker({
  minutes,
  inc,
  onChange,
}: {
  minutes: number;
  inc: number;
  onChange: (minutes: number, inc: number) => void;
}) {
  const err = validateCustomTimeControl(minutes, inc);
  return (
    <div className="hm-time">
      <div className="hm-presets" role="group" aria-label="Thời gian có sẵn">
        {TIME_PRESETS.map((p) => {
          const on = p.minutes === minutes && p.inc === inc;
          return (
            <button
              key={`${p.minutes}+${p.inc}`}
              type="button"
              className={`hm-preset${on ? ' active' : ''}`}
              aria-pressed={on}
              title={`${p.minutes} phút mỗi bên + ${p.inc} giây mỗi nước`}
              onClick={() => onChange(p.minutes, p.inc)}
            >
              <b className="num">
                {p.minutes}+{p.inc}
              </b>
              <span>{p.tag}</span>
            </button>
          );
        })}
      </div>
      <div className="hm-steppers">
        <Stepper
          label="Phút mỗi bên"
          unit="phút"
          value={minutes}
          min={CUSTOM_TIME_LIMITS.minMinutes}
          max={CUSTOM_TIME_LIMITS.maxMinutes}
          onChange={(v) => onChange(v, inc)}
        />
        <Stepper
          label="Giây cộng mỗi nước"
          unit="giây"
          value={inc}
          min={0}
          max={CUSTOM_TIME_LIMITS.maxIncrementSec}
          onChange={(v) => onChange(minutes, v)}
        />
      </div>
      {err && (
        <div className="hm-field-error error small" role="alert">
          <Icon name="alert" size={16} />
          <span>{err}</span>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Phòng riêng

function RoomWaiting({ room, me, onCancel }: { room: RoomDto; me: MeDto; onCancel: () => Promise<void> }) {
  const toast = useToast();
  const linkRef = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const copiedTimer = useRef<number>();
  const link = `${window.location.origin}/room/${room.code}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const label = roomGameLabel(room);
  const jieqi = room.variant === 'jieqi';
  // Phòng chưa có người vào tự huỷ sau PRIVATE_ROOM_TTL_MS kể từ lúc tạo
  const expiresAt = new Date(room.createdAt + PRIVATE_ROOM_TTL_MS).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copy = async (text: string, what: 'code' | 'link', done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done, 'success');
      setCopied(what);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1800);
    } catch {
      linkRef.current?.select();
      toast('Không tự sao chép được. Bạn hãy bôi đen đường dẫn rồi sao chép bằng tay nhé.', 'warn');
    }
  };
  const share = async () => {
    try {
      await navigator.share({
        title: `Mời chơi ${label}`,
        text: `${room.host.username} mời bạn chơi ${label} (${timeControlText(room.timeControl)}). Mở đường dẫn để vào ván, hoặc nhập mã phòng: ${room.code}`,
        url: link,
      });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') toast('Không chia sẻ được, bạn hãy sao chép đường dẫn mời', 'warn');
    }
  };

  return (
    <div className="hm-body hm-room">
      <div className="hm-vs" aria-hidden="true">
        <span className="hm-vs-player">
          <Avatar name={me.username} url={me.avatarUrl} size={44} />
          <span>Bạn</span>
        </span>
        <span className="hm-vs-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="hm-vs-player">
          <span className="hm-vs-empty">
            <Icon name="user" size={22} />
          </span>
          <span>Bạn bè</span>
        </span>
      </div>
      <div className="hm-wait-head" role="status">
        <p className="hm-wait-text">Đang chờ bạn bè vào phòng…</p>
        <p className="hm-wait-sub">Gửi mã hoặc đường dẫn bên dưới cho bạn bè. Bạn bè vào phòng là ván bắt đầu ngay.</p>
      </div>
      <div className="hm-ticket">
        <span className="hm-ticket-label">Mã phòng</span>
        <div className="hm-ticket-code">
          <div className="room-code">{room.code}</div>
          <button
            type="button"
            className={`btn btn-quiet btn-icon${copied === 'code' ? ' hm-copied' : ''}`}
            onClick={() => void copy(room.code, 'code', 'Đã sao chép mã phòng')}
            aria-label="Sao chép mã phòng"
            title="Sao chép mã phòng"
          >
            <Icon name={copied === 'code' ? 'check' : 'copy'} size={20} />
          </button>
        </div>
        <div className="hm-ticket-facts">
          <span className="chip">
            {jieqi ? <Icon name="hidden" size={14} /> : <GameIcon game={room.game} size={14} />} {label}
          </span>
          <span className="chip">
            <Icon name="clock" size={13} /> {timeControlText(room.timeControl)}
          </span>
          <span className="chip">Bốc thăm bên cầm quân</span>
          <span className="chip">Không tính điểm hạng</span>
        </div>
      </div>
      <div className="hm-invite">
        <label className="hm-label" htmlFor={linkId}>
          Đường dẫn mời
        </label>
        <div className="hm-link-row">
          <input id={linkId} ref={linkRef} readOnly value={link} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className={`btn${copied === 'link' ? ' hm-copied' : ''}`}
            aria-label="Sao chép đường dẫn mời"
            onClick={() => void copy(link, 'link', 'Đã sao chép đường dẫn mời')}
          >
            <Icon name={copied === 'link' ? 'check' : 'link'} size={18} /> {copied === 'link' ? 'Đã chép' : 'Sao chép'}
          </button>
        </div>
        {canShare && (
          <button type="button" className="btn btn-soft btn-block" onClick={() => void share()}>
            <LocalIcon name="share" size={18} /> Chia sẻ lời mời
          </button>
        )}
      </div>
      <p className="hm-wait-note">
        <Icon name="info" size={15} />
        <span>
          Mã có hiệu lực {ROOM_TTL_MINUTES} phút (đến <span className="num">{expiresAt}</span>). Hãy giữ trang web này mở để vào ván
          ngay khi bạn bè tới.
        </span>
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        disabled={cancelling}
        onClick={async () => {
          setCancelling(true);
          await onCancel();
          setCancelling(false);
        }}
      >
        Huỷ phòng
      </button>
    </div>
  );
}

function PrivatePanel({ game }: { game: GameType }) {
  // Không cần tài khoản: chưa có danh tính thì Tạo phòng / Vào phòng sẽ vào với tư cách khách
  const { player, loading } = useAuth();
  const ensurePlayer = useEnsurePlayer();
  const { room, setRoom, cancelRoom, queue, leaveQueue } = useRealtime();
  const toast = useToast();
  const navigate = useNavigate();
  const [minutes, setMinutes] = useState(10);
  const [inc, setInc] = useState(5);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  if (loading) return <PanelSkeleton />;

  if (room && player) return <RoomWaiting room={room} me={player} onCancel={cancelRoom} />;

  const err = validateCustomTimeControl(minutes, inc);

  return (
    <div className="hm-body">
      <div className="hm-sect-head">
        <h3 className="hm-sect-title">Tạo phòng mời bạn bè</h3>
        <p className="hm-sect-desc">
          Chọn thời gian, tạo phòng rồi gửi mã hoặc đường dẫn mời cho bạn bè. Bên cầm quân được bốc thăm; ván không tính điểm
          hạng.
        </p>
      </div>
      <TimePicker
        minutes={minutes}
        inc={inc}
        onChange={(m, i) => {
          setMinutes(m);
          setInc(i);
        }}
      />
      {queue && (
        <div className="notice info" role="status">
          <Icon name="search" size={18} />
          <div className="grow">
            <div>
              Bạn đang tìm đối thủ{' '}
              <b>{queue.variant === 'jieqi' ? 'Cờ úp' : queue.game ? `${GAME_LABEL[queue.game]} (ván xếp hạng)` : ''}</b>. Huỷ
              tìm để tạo phòng.
            </div>
            <div className="hm-notice-actions">
              <button type="button" className="link-btn" onClick={() => void leaveQueue()}>
                Huỷ tìm đối thủ
              </button>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-block btn-lg hm-cta"
        disabled={!!err || busy || !!queue}
        onClick={async () => {
          setBusy(true);
          try {
            if (!(await ensurePlayer())) return;
            const r = await emit('room:create', { game, minutes, incrementSec: inc });
            if (r.ok) setRoom(r.room);
            else toast(r.error, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <span className="hm-spinner" aria-hidden="true" /> : <Icon name="plus" size={20} />}
        Tạo phòng {GAME_LABEL[game]}
      </button>
      <div className="divider">hoặc</div>
      <div className="hm-sect-head">
        <h3 className="hm-sect-title">Vào phòng bạn bè đã tạo</h3>
        <p className="hm-sect-desc">Nhập mã 6 ký tự bạn bè gửi cho bạn (dán cả đường dẫn mời cũng được).</p>
      </div>
      <form
        className="hm-code-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const c = code.trim().toUpperCase();
          if (!/^[A-Z0-9]{6}$/.test(c)) {
            toast('Mã phòng gồm đúng 6 chữ hoặc số', 'warn');
            return;
          }
          setBusy(true);
          const ok = await ensurePlayer();
          setBusy(false);
          if (ok) navigate(`/room/${c}`);
        }}
      >
        <input
          className="hm-code-input"
          value={code}
          onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
          placeholder="VD: K7P2QX"
          aria-label="Mã phòng (6 ký tự)"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <button className={`btn${code.length === 6 ? ' btn-primary' : ''}`} type="submit" disabled={busy}>
          Vào phòng <Icon name="arrow-right" size={18} />
        </button>
      </form>
    </div>
  );
}

// --------------------------------------------------------------------------- Đấu với máy

function DifficultyBars({ level }: { level: AiLevel }) {
  const n = LEVEL_BARS[level];
  return (
    <span className={`hm-diff hm-diff-${level}`} aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : undefined} />
      ))}
    </span>
  );
}

/** Mặt quân minh hoạ màu bên cầm quân (vẽ như quân thật nên dùng màu cố định) */
function PieceDisc({ game, color, x = 16 }: { game: GameType; color: 0 | 1; x?: number }) {
  if (game === 'xiangqi') {
    const ink = color === 0 ? '#b3261e' : '#1f1a17';
    return (
      <g transform={`translate(${x} 16)`}>
        <circle r="14" fill="#f2d7a2" stroke="#8a5a2b" strokeWidth="1.4" />
        <circle r="11" fill="none" stroke={ink} strokeWidth="1.1" />
        <text
          dy="0.36em"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill={ink}
          fontFamily="KaiTi, STKaiti, 'Noto Serif SC', SimSun, serif"
        >
          {color === 0 ? '帥' : '將'}
        </text>
      </g>
    );
  }
  // Giống quân trên bàn cờ vua: cùng một hình Vua, tô trắng viền đen hoặc tô đen viền sáng
  return (
    <g transform={`translate(${x} 16)`}>
      <circle r="14" fill="#e9cfa6" stroke="#b58863" strokeWidth="1.4" />
      <text
        dy="0.36em"
        textAnchor="middle"
        fontSize="19"
        fill={color === 0 ? '#fffdf8' : '#1c1c1c'}
        stroke={color === 0 ? '#1c1c1c' : '#f5f0e6'}
        strokeWidth={color === 0 ? 1.2 : 0.6}
        paintOrder="stroke"
        fontFamily="'Segoe UI Symbol', 'DejaVu Sans', 'Noto Sans Symbols 2', sans-serif"
      >
        {KING_GLYPH}
      </text>
    </g>
  );
}

function SideSwatch({ game, side }: { game: GameType; side: Side }) {
  if (side === 'random') {
    return (
      <svg className="hm-swatch" viewBox="0 0 46 32" width="44" height="31" aria-hidden="true">
        <PieceDisc game={game} color={1} x={30} />
        <PieceDisc game={game} color={0} x={16} />
      </svg>
    );
  }
  return (
    <svg className="hm-swatch" viewBox="0 0 32 32" width="31" height="31" aria-hidden="true">
      <PieceDisc game={game} color={side} />
    </svg>
  );
}

function AiPanel({ game }: { game: GameType }) {
  // Ai cũng đấu với máy được (ván chạy trong trình duyệt); chỉ tài khoản thành viên mới lưu ván vào lịch sử
  const { me, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const uid = useId();
  const [level, setLevel] = useState<AiLevel>('medium');
  const [side, setSide] = useState<Side>(0);
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [inc, setInc] = useState(5);
  if (loading) return <PanelSkeleton />;
  const err = timed ? validateCustomTimeControl(minutes, inc) : null;
  return (
    <div className="hm-body">
      <p className="hm-note">
        <Icon name="info" size={16} />
        {me ? (
          <span>Ván với máy không tính điểm hạng. Kết quả vẫn được lưu vào lịch sử ván đấu của bạn.</span>
        ) : (
          <span>
            Ván với máy không tính điểm hạng.{' '}
            <Link to="/login" state={{ from: location.pathname }}>
              Đăng nhập
            </Link>{' '}
            để lưu ván vào lịch sử.
          </span>
        )}
      </p>
      <fieldset className="hm-choices">
        <legend className="hm-label">Mức độ</legend>
        <div className="hm-choice-grid">
          {AI_LEVELS.map((l) => (
            <label key={l} className={`choice hm-level-choice${level === l ? ' active' : ''}`}>
              <input type="radio" name={`${uid}-level`} checked={level === l} onChange={() => setLevel(l)} />
              <DifficultyBars level={l} />
              <span className="hm-choice-title">{AI_LEVEL_LABEL[l]}</span>
              <span className="hm-choice-hint">{LEVEL_HINT[l]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="hm-choices">
        <legend className="hm-label">Bên cầm quân</legend>
        <div className="hm-choice-grid">
          {([0, 1, 'random'] as const).map((s) => (
            <label key={String(s)} className={`choice hm-side-choice${side === s ? ' active' : ''}`}>
              <input type="radio" name={`${uid}-side`} checked={side === s} onChange={() => setSide(s)} />
              <SideSwatch game={game} side={s} />
              <span className="hm-choice-title">{s === 'random' ? 'Ngẫu nhiên' : COLOR_LABEL[game][s]}</span>
              <span className="hm-choice-hint">{SIDE_HINT[String(s) as '0' | '1' | 'random']}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={`hm-timelimit${timed ? ' on' : ''}`}>
        <label className="check">
          <span className="hm-check-ico" aria-hidden="true">
            <Icon name="clock" size={18} />
          </span>
          <span className="hm-check-text">Giới hạn thời gian</span>
          <input type="checkbox" className="hm-switch" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
        </label>
        {timed ? (
          <TimePicker
            minutes={minutes}
            inc={inc}
            onChange={(m, i) => {
              setMinutes(m);
              setInc(i);
            }}
          />
        ) : (
          <p className="hm-check-desc">Đang tắt — không tính giờ, bạn suy nghĩ bao lâu cũng được.</p>
        )}
      </div>
      <div className="hm-cta-dock">
        <button
          type="button"
          className="btn btn-primary btn-block btn-lg hm-cta"
          disabled={!!err}
          onClick={() => {
            const setup: AiSetup = {
              game,
              level,
              side,
              timeControl: timed ? { initialMs: minutes * 60_000, incrementMs: inc * 1000 } : null,
            };
            navigate('/ai', { state: setup });
          }}
        >
          <Icon name="play" size={20} /> Bắt đầu ván với máy
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Bàn cờ xem trước

/** Nhãn các nước của ván mẫu (tính một lần mỗi game) — để hiện cả danh sách nước bên cạnh bàn cờ */
const demoLabels = new Map<GameType, string[]>();

function demoMoveLabels(game: GameType): string[] {
  let labels = demoLabels.get(game);
  if (!labels) {
    const engine = createGame(game);
    for (const m of DEMO[game].moves) if (!engine.play(m)) break;
    labels = engine.historyInfo().map((i) => i.label);
    demoLabels.set(game, labels);
  }
  return labels;
}

function BoardPreview({ game }: { game: GameType }) {
  const reduced = useReducedMotion();
  const line = DEMO[game].moves;
  const labels = demoMoveLabels(game);
  const [demo, setDemo] = useState<{ engine: GameEngine; ply: number }>(() => ({ engine: createGame(game), ply: 0 }));

  useEffect(() => {
    if (reduced) {
      // Người dùng bật "giảm chuyển động": đứng yên ở thế cờ khởi đầu
      if (demo.ply > 0) setDemo({ engine: createGame(game), ply: 0 });
      return;
    }
    const done = demo.ply >= line.length;
    const t = window.setTimeout(
      () => {
        if (done) {
          setDemo({ engine: createGame(game), ply: 0 });
          return;
        }
        const ok = demo.engine.play(line[demo.ply]);
        setDemo({ engine: demo.engine, ply: ok ? demo.ply + 1 : line.length });
      },
      done ? 4200 : demo.ply === 0 ? 1600 : 1900,
    );
    return () => window.clearTimeout(t);
  }, [demo, game, line, reduced]);

  const shown = reduced ? 0 : demo.ply;
  const info = shown > 0 ? demo.engine.historyInfo()[shown - 1] : null;
  const last = useMemo(() => (shown > 0 ? lastMoveOf(demo.engine) : null), [demo, shown]);
  // Danh sách nước theo lượt: 1. (Đỏ/Trắng) (Đen)
  const rows: string[][] = [];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));

  // Hai phần tử anh em (bàn cờ + chú thích) để lưới .hm-aside đặt chú thích dưới bàn cờ hoặc ở cột phụ bên phải
  return (
    <>
      <div className="home-board" aria-hidden="true">
        <GameBoard engine={demo.engine} version={shown} orientation={0} movable={null} lastMove={last} />
      </div>
      <div className="hm-cap">
        <p className="hm-cap-head">
          <span className="hm-cap-name">
            <Icon name={reduced ? 'grid' : 'play'} size={14} />
            {reduced ? (
              'Thế cờ khởi đầu'
            ) : (
              <>
                <span className="hm-cap-kicker">Ván mẫu</span> <span className="hm-cap-title">{DEMO[game].name}</span>
              </>
            )}
          </span>
          {!reduced && (
            <span className="hm-cap-move num">
              {info ? `${Math.ceil(shown / 2)}${shown % 2 ? '.' : '…'} ${info.label}` : COLOR_LABEL[game][0] + ' đi trước'}
            </span>
          )}
        </p>
        {!reduced && (
          // Danh sách nước của ván mẫu (chỉ hiện ở cột phụ trên máy tính); nước đang chiếu được tô đậm
          <ol className="hm-cap-moves num" aria-hidden="true">
            {rows.map((pair, r) => (
              <li key={r}>
                <span className="hm-cap-no">{r + 1}.</span>
                {pair.map((label, j) => {
                  const ply = r * 2 + j + 1;
                  return (
                    <span key={j} className={`hm-cap-mv${ply === shown ? ' on' : ply > shown ? ' next' : ''}`}>
                      {label}
                    </span>
                  );
                })}
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------------------- Thêm cách chơi: Cờ úp, Cờ thế

/** Minh hoạ Cờ úp: một quân còn úp (mặt lưng) và một quân đã lật. Màu là "vật liệu" quân cờ (xem home.css) */
function CoUpArt() {
  return (
    <svg className="hm-art" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <g transform="translate(18 18)">
        <circle className="hm-art-edge" cy="2.2" r="13.5" />
        <circle className="hm-art-back" r="13.5" />
        <circle className="hm-art-back-ring" r="10" />
        <text className="hm-art-q" dy="0.36em">
          ?
        </text>
      </g>
      <g transform="translate(31 29)">
        <circle className="hm-art-edge" cy="2.2" r="13.5" />
        <circle className="hm-art-face" r="13.5" />
        <circle className="hm-art-ring" r="10.5" />
        <text className="hm-art-char" dy="0.36em">
          炮
        </text>
      </g>
    </svg>
  );
}

/** Minh hoạ Cờ thế: góc bàn cờ có cung tướng, quân Xe đỏ sắp chiếu Tướng đen */
function CoTheArt() {
  return (
    <svg className="hm-art" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <rect className="hm-art-wood" x="1" y="1" width="46" height="46" rx="10" />
      <path className="hm-art-lines" d="M4 11H44M4 23H44M4 35H44M12 4V44M24 4V44M36 4V44M12 11 36 35M36 11 12 35" />
      <path className="hm-art-arrow" d="M12 31V17" />
      <path className="hm-art-arrow-head" d="M8.5 19.5 12 15.5l3.5 4" />
      <g transform="translate(24 11)">
        <circle className="hm-art-face" r="7.6" />
        <text className="hm-art-char is-sm is-black" dy="0.36em">
          將
        </text>
      </g>
      <g transform="translate(12 35)">
        <circle className="hm-art-face" r="7.6" />
        <text className="hm-art-char is-sm" dy="0.36em">
          俥
        </text>
      </g>
    </svg>
  );
}

const MORE_MODES: ReadonlyArray<{ to: string; title: string; tag: string; desc: string; meta: string; art: ReactNode }> = [
  {
    to: '/co-up',
    title: 'Cờ úp',
    tag: 'Cờ tướng úp quân',
    desc: 'Quân bị úp và xáo trộn; quân nào đi lần đầu mới lật mặt.',
    meta: 'Đấu với người hoặc máy',
    art: <CoUpArt />,
  },
  {
    to: '/co-the',
    title: 'Cờ thế',
    tag: 'Cờ tướng',
    desc: `${PUZZLE_COUNT} thế cờ kinh điển trong «Thích${NBSP}tình${NBSP}nhã${NBSP}thú».`,
    meta: 'Chọn thế và tự giải',
    art: <CoTheArt />,
  },
];

/** Lối vào hai chế độ mới (khách cũng thấy) */
function MoreModes() {
  const uid = useId();
  return (
    <section className="hm-more" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`} className="hm-more-title">
        Thêm cách chơi
      </h2>
      <ul className="hm-more-list">
        {MORE_MODES.map((m, i) => (
          <li key={m.to}>
            <Link
              to={m.to}
              className="hm-mc"
              aria-labelledby={`${uid}-t${i} ${uid}-g${i}`}
              aria-describedby={`${uid}-d${i} ${uid}-m${i}`}
            >
              <span className="hm-mc-art">{m.art}</span>
              <span className="hm-mc-head">
                <span className="hm-mc-title" id={`${uid}-t${i}`}>
                  {m.title}
                </span>
                <span className="hm-mc-tag" id={`${uid}-g${i}`}>
                  {m.tag}
                </span>
              </span>
              <span className="hm-mc-desc" id={`${uid}-d${i}`}>
                {m.desc}
              </span>
              <span className="hm-mc-foot">
                <span className="hm-mc-meta" id={`${uid}-m${i}`}>
                  {m.meta}
                </span>
                <Icon name="arrow-right" size={16} className="hm-mc-go" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- Trang chủ

export function HomePage() {
  const { game, setGame } = useGameSelect();
  const { me, loading } = useAuth();
  const { joinQueue, queue, room } = useRealtime();
  const location = useLocation();
  const navigate = useNavigate();
  // Đang có phòng chờ (ví dụ chủ phòng mở lại link mời) thì mở thẳng thẻ Phòng riêng
  const [mode, setMode] = useState<Mode>(() => (room && !queue ? 'private' : 'ranked'));
  const uid = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // "Chơi tiếp" sau ván xếp hạng: tự tìm trận mới
  useEffect(() => {
    const auto = (location.state as { autoQueue?: GameType } | null)?.autoQueue;
    if (!auto || !me) return;
    setGame(auto);
    setMode('ranked');
    navigate('.', { replace: true, state: null });
    void joinQueue(auto);
  }, [location.state, me, joinQueue, navigate, setGame]);

  // "Về Phòng riêng" sau ván phòng riêng: mở thẳng thẻ Phòng riêng
  useEffect(() => {
    if ((location.state as { lobbyTab?: string } | null)?.lobbyTab !== 'private') return;
    setMode('private');
    navigate('.', { replace: true, state: null });
  }, [location.state, navigate]);

  // Chưa có tài khoản (kể cả đang là khách): hiện lời giới thiệu + nút đăng ký
  const visitor = !me && !loading;

  const onTabsKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % MODES.length;
    else if (e.key === 'ArrowLeft') next = (i + MODES.length - 1) % MODES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setMode(MODES[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={`home${visitor ? ' hm-is-guest' : ''}`}>
      <div className="hm-main">
        <section className="panel hm-lobby" aria-labelledby={`${uid}-title`}>
          <header className="hm-lobby-head">
            <span className="hm-lobby-emblem" aria-hidden="true">
              <GameIcon game={game} size={32} />
            </span>
            <div className="hm-lobby-heading">
              {visitor ? (
                // Chưa đăng nhập: "Chọn cách chơi" là thứ đầu tiên trên trang (lời giới thiệu nằm ngay bên dưới)
                <h1 id={`${uid}-title`} className="hm-lobby-title">
                  Chọn cách chơi
                </h1>
              ) : (
                <h1 id={`${uid}-title`} className="hm-lobby-title">
                  {GAME_LABEL[game]}
                </h1>
              )}
              {/* Người đã đăng nhập: tên đã có trong thẻ người chơi — bỏ dòng chào để sảnh gọn */}
              {!me && <p className="hm-lobby-sub">{visitor ? <>Ba cách chơi {GAME_LABEL[game]}</> : 'Đang tải…'}</p>}
            </div>
          </header>
          <div className="mode-tabs" role="tablist" aria-label="Chế độ chơi" onKeyDown={onTabsKey}>
            {MODES.map((m, i) => {
              const active = mode === m.id;
              const live = (m.id === 'ranked' && !!queue && queue.variant !== 'jieqi') || (m.id === 'private' && !!room);
              return (
                <button
                  key={m.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  id={`${uid}-tab-${m.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${uid}-panel`}
                  tabIndex={active ? 0 : -1}
                  className={active ? 'active' : ''}
                  onClick={() => setMode(m.id)}
                >
                  <span className="hm-mode-ico" aria-hidden="true">
                    <Icon name={m.icon} size={20} />
                    {live && !active && <span className="hm-mode-dot" />}
                  </span>
                  <span className="hm-mode-label">{m.label}</span>
                </button>
              );
            })}
          </div>
          <div className="hm-mode-panel" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${mode}`} key={mode}>
            {mode === 'ranked' && <RankedPanel game={game} onShowRoom={() => setMode('private')} />}
            {mode === 'private' && <PrivatePanel game={game} />}
            {mode === 'ai' && <AiPanel game={game} />}
          </div>
        </section>
        {/* Lời giới thiệu cho người chưa đăng nhập: nằm DƯỚI "Chọn cách chơi" (theo yêu cầu chủ sản phẩm 11/11/2026) */}
        {visitor && <GuestHero game={game} />}
        {/* Top 10 của quý nằm ngay dưới bảng tìm trận (theo yêu cầu: chỉ ở trang chủ) */}
        <section className="panel hm-top10" aria-labelledby={`${uid}-top10`}>
          <Top10Card titleId={`${uid}-top10`} />
        </section>
      </div>
      {/* Bàn cờ xem trước + cột phụ: lối vào Cờ úp / Cờ thế và ván mẫu (vị trí từng phần đổi theo cỡ màn hình) */}
      <div className={`hm-aside is-${game}`}>
        <BoardPreview key={game} game={game} />
        <MoreModes />
      </div>
    </div>
  );
}
