/**
 * Các thông số luật đã chốt trong đặc tả. Đặt ở một chỗ để dễ chỉnh.
 */

/** Ván xếp hạng: 15 phút mỗi bên + 10 giây mỗi nước */
export const RANKED_TIME_CONTROL = { initialMs: 15 * 60_000, incrementMs: 10_000 } as const;

/** Cờ úp — ghép trận thường (không tính điểm): 10 phút mỗi bên + 5 giây mỗi nước (tự quyết, cần xác nhận) */
export const JIEQI_CASUAL_TIME_CONTROL = { initialMs: 10 * 60_000, incrementMs: 5_000 } as const;

/**
 * Ghép trận: ưu tiên cặp trong khoảng điểm — bắt đầu ±100, mỗi 10 giây nới thêm 50, tối đa ±400. Người thật còn lại
 * trong hàng chờ luôn được ghép với nhau dù chênh bao nhiêu (MatchmakingService.pairUp); chỉ người lẻ mới gặp máy.
 */
export const MATCHMAKING = {
  initialRange: 100,
  stepRange: 50,
  stepMs: 10_000,
  maxRange: 400,
} as const;

/**
 * Hàng chờ xếp hạng: người chơi chờ quá thời gian này mà chưa có đối thủ thì được ghép với một tài khoản máy
 * (server có thể đổi bằng biến môi trường BOT_FALLBACK_SEC; 0 = tắt)
 */
export const BOT_FALLBACK_WAIT_MS = 30_000;

/**
 * Đang có NHIỀU HƠN số thành viên (có tài khoản, đang kết nối; không tính khách) này trên toàn hệ thống thì không ghép
 * với tài khoản máy nữa — người chơi chỉ chờ người (server đổi bằng BOT_MAX_ONLINE_HUMANS)
 */
export const BOT_MAX_ONLINE_HUMANS = 50;

/** Không đi nước đầu tiên trong 30 giây: xử thua (chỉ ván xếp hạng, áp dụng cho nước đầu của mỗi bên) */
export const FIRST_MOVE_TIMEOUT_MS = 30_000;

/** Mất kết nối: 60 giây để vào lại ván, quá hạn xử thua */
export const RECONNECT_GRACE_MS = 60_000;

/** Chat trong ván: tối đa 1 tin mỗi 2 giây, 200 ký tự mỗi tin */
export const CHAT_LIMITS = { maxLength: 200, minIntervalMs: 2_000 } as const;

/** Avatar: tối đa 2 MB, JPG/PNG/WebP; server cắt về ảnh vuông */
export const AVATAR_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as readonly string[],
  outputSize: 256,
} as const;

/** Elo */
export const ELO_K = 32;
/** Điểm đầu mùa: mỗi quý ai cũng bắt đầu từ 0 */
export const START_RATING = 0;
/** Điểm không xuống dưới mức này (thua khi đang ở 0 điểm thì giữ 0) */
export const RATING_FLOOR = 0;

/**
 * Luật giúp người đến sau dễ leo hạng (chủ sản phẩm chọn ngày 11/11/2026):
 * 1. 5 ván xếp hạng đầu tiên mỗi mùa: điểm CỘNG nhân ×1,5 (bắt kịp nhanh).
 * 2. Thua: điểm TRỪ nhân hệ số theo cấp bậc hiện tại — Tân thủ, Sơ cấp ×1,0; mỗi cấp cao hơn +0,1; tối đa ×1,5 (Kỳ vương).
 * 3. Chuỗi thắng: từ ván thắng thứ 3 liên tiếp được thưởng thêm +3, ván thứ 4 trở đi +6 (tối đa +6 mỗi ván).
 * 4. Không chơi thì tụt điểm: từ 350 điểm trở lên mà 7 ngày không chơi ván xếp hạng nào → mỗi ngày −5 điểm, không tụt
 *    xuống dưới mốc của cấp bậc đang có.
 */
export const RANKED_RULES = {
  placementGames: 5,
  placementMultiplier: 1.5,
  /** Hệ số trừ khi thua = 1 + lossStepPerTier × max(0, cấp − lossFreeTiers + 1), tối đa lossMaxMultiplier */
  lossFreeTiers: 2,
  lossStepPerTier: 0.1,
  lossMaxMultiplier: 1.5,
  streakFrom: 3,
  streakStep: 3,
  streakMaxBonus: 6,
  decayMinRating: 350,
  decayAfterDays: 7,
  decayPerDay: 5,
} as const;

/** Điều kiện vào bảng xếp hạng: tối thiểu 5 ván xếp hạng trong quý (chủ sản phẩm đổi từ 10 xuống 5 ngày 11/11/2026) */
export const LEADERBOARD_MIN_GAMES = 5;
export const LEADERBOARD_SIZE = 10;

/** Múi giờ chốt quý: GMT+7 */
export const SEASON_UTC_OFFSET_HOURS = 7;

/** Phòng riêng / đấu với máy: chủ phòng chọn thời gian tuỳ ý trong giới hạn hợp lý */
export const CUSTOM_TIME_LIMITS = {
  minMinutes: 1,
  maxMinutes: 180,
  maxIncrementSec: 60,
} as const;

/** Phòng riêng chưa có người vào sẽ tự huỷ sau thời gian này */
export const PRIVATE_ROOM_TTL_MS = 60 * 60_000;

export const AI_LEVELS = ['easy', 'medium', 'hard'] as const;
export type AiLevel = (typeof AI_LEVELS)[number];

export function matchmakingRange(waitedMs: number): number {
  const steps = Math.max(0, Math.floor(waitedMs / MATCHMAKING.stepMs));
  return Math.min(MATCHMAKING.initialRange + steps * MATCHMAKING.stepRange, MATCHMAKING.maxRange);
}
