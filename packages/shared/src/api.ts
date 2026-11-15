import type { Color, GameType } from '@cotuong/game-core';
import type { AiLevel } from './constants';
import type { GameVariant } from './variant';
import type { TimeControl } from './validation';

export type Role = 'player' | 'admin';
export type GameMode = 'pvp' | 'ai';
export type SeasonStatus = 'active' | 'finalizing' | 'closed';
/** Kết quả lưu trong bảng matches: player1 = bên đi trước (Đỏ/Trắng) */
export type StoredMatchResult = 'p1' | 'p2' | 'draw' | 'aborted';

export interface PublicUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  /** Khách (chưa đăng nhập): không có trang hồ sơ */
  isGuest?: boolean;
}

export interface MeDto extends PublicUser {
  email: string;
  role: Role;
  emailVerified: boolean;
  createdAt: string;
  /** Ván đang chơi (nếu có) để vào lại */
  activeMatchId: string | null;
  /**
   * Phiên KHÁCH (chưa đăng nhập): server tự tạo danh tính tạm (tên "Khách 123456") để chơi phòng riêng / Cờ úp.
   * Khách không có email (email = ''), không chơi xếp hạng, không dùng được các API cần đăng nhập (trả 401).
   */
  isGuest: boolean;
}

export interface SeasonDto {
  id: string;
  game: GameType;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  startAt: string;
  endAt: string;
  status: SeasonStatus;
  daysLeft: number;
}

export interface LeaderboardEntry {
  /** 1..10 */
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  rating: number;
  /** Cấp bậc, tính bằng getTier(rating) */
  tier: string;
  tierLevel: number;
  wins: number;
  gamesPlayed: number;
}

export interface MyStanding {
  /** null = chưa đủ số ván tối thiểu */
  rank: number | null;
  rating: number;
  tier: string;
  tierLevel: number;
  wins: number;
  gamesPlayed: number;
  minGames: number;
}

export interface LeaderboardResponse {
  season: SeasonDto;
  entries: LeaderboardEntry[];
  me: MyStanding | null;
}

export interface SeasonArchiveDto {
  season: SeasonDto;
  entries: LeaderboardEntry[];
}

export interface SeasonStats {
  rating: number;
  peakRating: number;
  tier: string;
  tierLevel: number;
  rank: number | null;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
}

export interface PastSeasonDto {
  season: SeasonDto;
  finalRank: number | null;
  rating: number;
  peakRating: number;
  /** Huy hiệu mùa: cấp bậc cao nhất đạt được (theo peak_rating) */
  peakTier: string;
  peakTierLevel: number;
  /** "Top X – Quý Y/năm" nếu lọt Top 10 */
  topBadge: string | null;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
}

export interface ProfileGameDto {
  game: GameType;
  season: SeasonDto;
  current: SeasonStats | null;
  /** Tổng các ván xếp hạng mọi mùa */
  allTime: { wins: number; losses: number; draws: number; gamesPlayed: number };
  pastSeasons: PastSeasonDto[];
}

export interface ProfileDto {
  user: PublicUser & { createdAt: string; role: Role };
  games: ProfileGameDto[];
}

export interface MatchSummaryDto {
  id: string;
  game: GameType;
  mode: GameMode;
  ranked: boolean;
  aiLevel: AiLevel | null;
  timeControl: string | null;
  /** Bên cầm quân của người chơi đang xem hồ sơ */
  color: Color;
  /** null khi đấu với máy */
  opponent: PublicUser | null;
  outcome: 'win' | 'loss' | 'draw' | 'aborted' | null;
  endReason: string | null;
  /** Điểm +/- của người chơi đang xem (chỉ ván xếp hạng) */
  ratingChange: number | null;
  moveCount: number;
  startedAt: string;
  endedAt: string | null;
  /** Biến thể của ván (cờ úp: 'jieqi') */
  variant: GameVariant;
}

export interface MatchDetailDto {
  id: string;
  game: GameType;
  mode: GameMode;
  ranked: boolean;
  aiLevel: AiLevel | null;
  timeControl: string | null;
  /** Theo bên cầm quân: [Đỏ/Trắng, Đen]; null = máy */
  players: [PublicUser | null, PublicUser | null];
  result: StoredMatchResult | null;
  endReason: string | null;
  /** Điểm thay đổi của player1 */
  ratingChange: number | null;
  /** Điểm thay đổi của player2; null ở ván cũ (khi đó = số đối của player1) */
  ratingChange2: number | null;
  moves: string[];
  startedAt: string;
  endedAt: string | null;
  variant: GameVariant;
  /** Cờ úp: chuỗi xếp quân (chỉ trả về khi ván đã kết thúc) để xem lại */
  setup: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminUserDto {
  id: string;
  username: string;
  email: string;
  role: Role;
  isBanned: boolean;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: string;
  /** Chỉ trang quản trị: tài khoản máy chơi và mức của nó (null = người thật) */
  botLevel: AiLevel | null;
  /** Chỉ trang quản trị: hàng chờ xếp hạng mà tài khoản máy phục vụ (null = người thật / chưa gán) */
  botGame?: GameType | null;
}

export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface AdminReportDto {
  id: string;
  status: ReportStatus;
  createdAt: string;
  reporter: PublicUser;
  message: {
    id: string;
    content: string;
    isDeleted: boolean;
    createdAt: string;
    matchId: string;
    author: PublicUser;
  };
}

/** POST /api/analytics/visit — trình duyệt báo một lần xem trang (không cần đăng nhập; trả 204) */
export interface VisitRequest {
  /** Mã ngẫu nhiên của trình duyệt (lưu ở localStorage) — dùng đếm số người xem, không gắn với danh tính */
  vid: string;
  /** Đường dẫn trang (vd "/co-up"); server chuẩn hoá về mẫu ("/play/:id") */
  path: string;
}

/** Số liệu một ngày (giờ Việt Nam) */
export interface AdminDayStatDto {
  /** YYYY-MM-DD (GMT+7) */
  date: string;
  /** Lượt xem trang */
  pageViews: number;
  /** Số người xem (trình duyệt khác nhau, ước lượng — sai số khoảng 1%) */
  visitors: number;
  /** Thành viên (tài khoản thật) có mở web trong ngày */
  members: number;
  /** Tài khoản mới (không tính khách, máy) */
  newAccounts: number;
  /** Ván đấu bắt đầu trong ngày (mọi loại, kể cả với máy đã lưu) */
  matches: number;
}

/** GET /api/admin/stats — bảng theo dõi của trang quản trị */
export interface AdminStatsDto {
  generatedAt: string;
  accounts: {
    /** Tài khoản thật (không gồm máy chơi và khách) */
    members: number;
    verified: number;
    banned: number;
    admins: number;
    /** Có liên kết đăng nhập Google / Facebook */
    viaGoogle: number;
    viaFacebook: number;
    newToday: number;
    new7d: number;
    new30d: number;
    /** Tài khoản khách đang lưu (tự xoá sau khi phiên hết hạn) */
    guests: number;
    bots: number;
    /** Khách được tự xoá sau bao nhiêu ngày kể từ lúc tạo (= SESSION_TTL_DAYS + 1; có thể là số lẻ) */
    guestTtlDays: number;
  };
  online: {
    /** Đang kết nối realtime (thành viên + khách, không gồm máy) */
    connected: number;
    /** Trình duyệt có mở web trong 5 phút gần nhất */
    visitorsNow: number;
  };
  traffic: {
    today: { pageViews: number; visitors: number; members: number };
    last7d: { pageViews: number; visitors: number; members: number };
    last30d: { pageViews: number; visitors: number; members: number };
  };
  matches: {
    /** Ván bắt đầu hôm nay theo loại */
    today: { ranked: number; unranked: number; ai: number };
    /** Ván người với người đang diễn ra (không tính ván xếp hạng ghép với tài khoản máy) */
    live: number;
    /** Tổng số ván đã lưu */
    total: number;
  };
  /** 30 ngày gần nhất, cũ → mới (ngày cuối là hôm nay) */
  days: AdminDayStatDto[];
  /** Trang được xem nhiều nhất hôm nay */
  topPages: Array<{ path: string; views: number }>;
}

/** Nhà cung cấp đăng nhập mạng xã hội */
export type OAuthProvider = 'google' | 'facebook';

/**
 * POST /api/auth/reset-password — removedLinks: các liên kết Google / Facebook vừa bị gỡ (email của tài khoản chưa được
 * chủ hộp thư / Google chứng minh, vd tài khoản tạo bằng Facebook) — đăng nhập rồi liên kết lại trong Hồ sơ nếu là của mình
 */
export interface ResetPasswordResponse {
  ok: true;
  removedLinks: OAuthProvider[];
}

/** GET /api/auth/oauth/links — tài khoản đang đăng nhập đã liên kết Google / Facebook chưa */
export interface OAuthLinksDto {
  linked: Record<OAuthProvider, boolean>;
  /** Server có cấu hình mã ứng dụng của nhà cung cấp đó không (không thì không hiện nút) */
  enabled: Record<OAuthProvider, boolean>;
}

export interface AppConfigDto {
  /** Nhà cung cấp đăng nhập mạng xã hội đang bật (có cấu hình mã ứng dụng trên server) */
  oauth?: Record<OAuthProvider, boolean>;
  tiers: Array<{ name: string; min: number | null }>;
  minGames: number;
  rankedTimeControl: TimeControl;
  chat: { maxLength: number; minIntervalMs: number };
  avatar: { maxBytes: number; mimeTypes: readonly string[] };
  matchmaking: { initialRange: number; stepRange: number; stepMs: number; maxRange: number };
  firstMoveTimeoutMs: number;
  reconnectGraceMs: number;
}

/** POST /api/auth/register/start — bước 1 đăng ký: gửi mã 6 chữ số (gọi lại để gửi lại mã) */
export interface RegisterStartRequest {
  email: string;
  /** (Khi bấm "Gửi lại mã") mã phiên của lần gửi trước — server huỷ mã cũ đó */
  regId?: string;
}
export interface RegisterStartResponse {
  /** Email đã chuẩn hoá */
  email: string;
  /**
   * Mã phiên đăng ký (ngẫu nhiên) gắn với mã vừa gửi — trình duyệt giữ lại và gửi kèm ở bước 2.
   * Người khác không có regId nên không thể nhập thử / khoá / thay mã của bạn.
   */
  regId: string;
  /** Số giây phải chờ trước khi gửi lại mã */
  resendAfterSec: number;
  /** Mã hết hạn sau số giây này */
  expiresInSec: number;
}

/** POST /api/auth/register/verify — bước 2: kiểm tra mã */
export interface RegisterVerifyRequest {
  email: string;
  /** regId nhận được ở bước 1 */
  regId: string;
  code: string;
}

/**
 * Thân lỗi JSON của mọi API: { statusCode, message, code?, ...thông tin thêm }.
 * Mã lỗi (code) của luồng đăng ký 3 bước:
 * - reg_ip_limit (429): IP này yêu cầu / nhập mã quá nhiều lần — kèm retryAfterSec
 * - reg_resend_wait (429): vừa gửi mã tới email này từ máy này, chờ rồi gửi lại — kèm retryAfterSec
 * - reg_mail_quota (429): đã gửi nhiều mã tới email này — kèm retryAfterSec
 * - mail_unavailable (503): chưa gửi được email (SMTP lỗi / chưa cấu hình / vượt hạn mức gửi thư của trang)
 * - reg_code_wrong (400, kèm attemptsLeft) / reg_code_locked (400) / reg_code_expired (400) / reg_ticket_expired (400)
 */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  code?: string;
  /** Số giây nên chờ trước khi thử lại (429; cũng gửi trong header Retry-After) */
  retryAfterSec?: number;
  /** Số lần nhập mã còn lại (reg_code_wrong) */
  attemptsLeft?: number;
}
export interface RegisterVerifyResponse {
  /**
   * Phiếu dùng một lần cho bước 3: POST /api/auth/register/complete { ticket, username, password } — tạo tài khoản
   * (email đã xác thực), trả { user: MeDto }
   */
  ticket: string;
  expiresInSec: number;
}
