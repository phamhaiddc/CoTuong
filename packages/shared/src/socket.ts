import type { Color, GameResult, GameType, GameWarning, JieqiReveal } from '@cotuong/game-core';
import type { GameVariant } from './variant';
import type { TimeControl } from './validation';

export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
export type AckFn<T extends object = object> = (res: Ack<T>) => void;

export interface LivePlayer {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Điểm hạng quý hiện tại (chỉ ván xếp hạng) */
  rating: number | null;
  tier: string | null;
  tierLevel: number | null;
  /** Người chơi là khách (chưa đăng nhập): không có trang hồ sơ */
  isGuest?: boolean;
}

export interface ClockDto {
  /** Thời gian còn lại của mỗi bên tại thời điểm turnStartedAt (ms) */
  remaining: [number, number];
  /** Thời điểm (giờ server) bên đang đi bắt đầu lượt */
  turnStartedAt: number;
  /** Giờ server lúc gửi gói tin, để client tính độ lệch đồng hồ */
  serverNow: number;
  running: boolean;
  initialMs: number;
  incrementMs: number;
}

export interface RatingChangeDto {
  userId: string;
  before: number;
  after: number;
  delta: number;
  tierBefore: string;
  tierAfter: string;
  tierLevelBefore: number;
  tierLevelAfter: number;
  /** "Thăng cấp" / "Xuống cấp" */
  change: 'promoted' | 'demoted' | null;
  /** Các luật xếp hạng đã áp dụng cho ván này (để giải thích trên giao diện) */
  rules?: {
    /** Nằm trong 5 ván đầu mùa, điểm cộng ×1,5 */
    placement: boolean;
    /** Hệ số nhân điểm bị trừ (1 = không nhân) */
    lossMultiplier: number;
    /** Điểm thưởng chuỗi thắng */
    streakBonus: number;
    /** Chuỗi thắng sau ván này */
    winStreak: number;
  };
}

/** ranked = ghép trận xếp hạng; private = phòng riêng; casual = ghép trận thường không tính điểm (cờ úp) */
export type LiveMatchKind = 'ranked' | 'private' | 'casual';

export interface MatchStateDto {
  id: string;
  game: GameType;
  kind: LiveMatchKind;
  ranked: boolean;
  /** index = bên cầm quân (0 = Đỏ/Trắng, 1 = Đen) */
  players: [LivePlayer, LivePlayer];
  myColor: Color | null;
  moves: string[];
  clock: ClockDto;
  /** Hạn đi nước đầu tiên của bên đang đi (ván xếp hạng), null nếu không áp dụng */
  firstMoveDeadline: number | null;
  drawOfferBy: Color | null;
  /** Hạn vào lại ván nếu đang mất kết nối (giờ server) */
  disconnectedUntil: [number | null, number | null];
  status: 'playing' | 'ended';
  result: GameResult | null;
  ratingChanges: [RatingChangeDto, RatingChangeDto] | null;
  warnings: GameWarning[];
  startedAt: number;
  timeControl: TimeControl;
  /** Biến thể (mặc định 'standard'). Cờ úp: 'jieqi' — luôn không tính điểm */
  variant?: GameVariant;
  /**
   * Cờ úp: thông tin lật quân CÔNG KHAI của từng nước (cùng độ dài với moves; null nếu nước đó không dính quân úp).
   * Server không bao giờ gửi chuỗi xếp quân bí mật khi ván đang diễn ra.
   */
  reveals?: Array<JieqiReveal | null>;
}

export interface MoveEventDto {
  matchId: string;
  move: string;
  ply: number;
  clock: ClockDto;
  firstMoveDeadline: number | null;
  warnings: GameWarning[];
  /** Cờ úp: quân vừa đi / quân bị ăn lộ ra loại gì (nếu là quân úp) */
  reveal?: JieqiReveal | null;
}

export interface MatchEndedDto {
  matchId: string;
  result: GameResult;
  clock: ClockDto;
  ratingChanges: [RatingChangeDto, RatingChangeDto] | null;
}

export interface ChatMessageDto {
  id: string;
  matchId: string;
  userId: string;
  username: string;
  content: string;
  createdAt: string;
}

export interface QueueStatusDto {
  searching: boolean;
  game: GameType | null;
  /** Khoảng chênh lệch điểm hiện tại (±) */
  range: number | null;
  waitedMs: number;
  rating: number | null;
  /** Hàng chờ của biến thể nào (cờ úp: ghép thường, không tính điểm) */
  variant?: GameVariant;
}

export interface RoomDto {
  code: string;
  game: GameType;
  timeControl: TimeControl;
  /** isGuest: chủ phòng là khách (không có trang hồ sơ) */
  host: { id: string; username: string; isGuest?: boolean };
  createdAt: number;
  /** Biến thể của phòng (mặc định 'standard') */
  variant?: GameVariant;
  /** Chủ phòng còn đang kết nối không (chỉ có trong room:info) — đang vắng thì người được mời chưa vào được */
  hostOnline?: boolean;
}

export interface ServerToClientEvents {
  'queue:status': (s: QueueStatusDto) => void;
  'match:found': (p: { matchId: string; game: GameType; variant?: GameVariant }) => void;
  'match:move': (e: MoveEventDto) => void;
  'match:ended': (e: MatchEndedDto) => void;
  'match:drawOffer': (p: { matchId: string; by: Color }) => void;
  'match:drawDeclined': (p: { matchId: string; by: Color }) => void;
  'match:connection': (p: { matchId: string; color: Color; disconnectedUntil: number | null }) => void;
  'chat:message': (m: ChatMessageDto) => void;
  'chat:deleted': (p: { matchId: string; messageId: string }) => void;
  'leaderboard:changed': (p: { game: GameType }) => void;
  'room:closed': (p: { code: string; reason: string }) => void;
  /**
   * Máy chủ hỏi "tab này còn đó không" (socket đang giữ ghế trong ván khi một socket khác của cùng người muốn vào bàn):
   * client trả lời ngay qua ack. Không trả lời kịp → máy chủ coi kết nối đó đã mất (vd đổi mạng, kết nối cũ treo).
   */
  'conn:probe': (ack: (alive: true) => void) => void;
}

export interface ClientToServerEvents {
  'queue:join': (p: { game: GameType; variant?: GameVariant }, ack: AckFn<{ status: QueueStatusDto }>) => void;
  'queue:leave': (p: Record<string, never>, ack: AckFn) => void;
  'room:create': (p: { game: GameType; minutes: number; incrementSec: number; variant?: GameVariant }, ack: AckFn<{ room: RoomDto }>) => void;
  'room:info': (p: { code: string }, ack: AckFn<{ room: RoomDto }>) => void;
  'room:join': (p: { code: string }, ack: AckFn<{ matchId: string }>) => void;
  'room:cancel': (p: { code: string }, ack: AckFn) => void;
  /** Phòng riêng đang chờ của chính mình (để hiện lại sau khi tải lại trang / kết nối lại); null = không có */
  'room:mine': (p: Record<string, never>, ack: AckFn<{ room: RoomDto | null }>) => void;
  'match:join': (p: { matchId: string }, ack: AckFn<{ state: MatchStateDto; chat: ChatMessageDto[] }>) => void;
  'match:leave': (p: { matchId: string }, ack: AckFn) => void;
  /** Lỗi code 'confirm_perpetual': cần gửi lại với confirmPerpetual = true */
  'match:move': (p: { matchId: string; move: string; confirmPerpetual?: boolean }, ack: AckFn) => void;
  'match:resign': (p: { matchId: string }, ack: AckFn) => void;
  'match:offerDraw': (p: { matchId: string }, ack: AckFn) => void;
  'match:respondDraw': (p: { matchId: string; accept: boolean }, ack: AckFn) => void;
  'chat:send': (p: { matchId: string; content: string }, ack: AckFn<{ message: ChatMessageDto }>) => void;
  'chat:report': (p: { messageId: string }, ack: AckFn) => void;
}

export const ERROR_CODES = {
  CONFIRM_PERPETUAL: 'confirm_perpetual',
  NOT_AUTHENTICATED: 'not_authenticated',
  EMAIL_NOT_VERIFIED: 'email_not_verified',
  IN_MATCH: 'in_match',
  RATE_LIMITED: 'rate_limited',
  SESSION_CONFLICT: 'session_conflict',
  /** Đang có phòng riêng chờ người vào (phải huỷ phòng trước khi tìm đối thủ) */
  HAS_ROOM: 'has_room',
  /** Chủ phòng riêng đang mất kết nối — người được mời chưa vào được */
  HOST_OFFLINE: 'host_offline',
} as const;
