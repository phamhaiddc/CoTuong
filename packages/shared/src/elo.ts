import { ELO_K, RANKED_RULES, RATING_FLOOR } from './constants';
import { DEFAULT_TIERS, getTier, type TierDef } from './tiers';

export type EloScore = 1 | 0.5 | 0;

/**
 * Điểm cộng/trừ theo Elo cho người A (đúng công thức trong đặc tả); người B theo công thức nhận số đối (-delta).
 * Điểm thực nhận còn qua các luật xếp hạng (rankedDelta) và sàn RATING_FLOOR (ratingAfter).
 */
export function eloDelta(rating: number, opponent: number, score: EloScore, k: number = ELO_K): number {
  const expected = 1 / (1 + 10 ** ((opponent - rating) / 400));
  const d = Math.round(k * (score - expected));
  return d === 0 ? 0 : d; // tránh -0
}

/** Điểm mới sau khi cộng delta, không xuống dưới sàn RATING_FLOOR */
export function ratingAfter(rating: number, delta: number): number {
  return Math.max(RATING_FLOOR, rating + delta);
}

/** Hệ số nhân điểm bị trừ khi thua, theo cấp bậc của người thua (cấp càng cao thua càng mất nhiều) */
export function lossMultiplier(rating: number, tiers: readonly TierDef[] = DEFAULT_TIERS): number {
  const level = getTier(rating, tiers).level;
  const m = 1 + RANKED_RULES.lossStepPerTier * Math.max(0, level - RANKED_RULES.lossFreeTiers + 1);
  return Math.min(RANKED_RULES.lossMaxMultiplier, Math.round(m * 100) / 100);
}

/** Điểm thưởng chuỗi thắng khi thắng ván này (streakBefore = số ván thắng liên tiếp NGAY TRƯỚC ván này) */
export function streakBonus(streakBefore: number): number {
  const streak = Math.max(0, Math.floor(streakBefore)) + 1;
  if (streak < RANKED_RULES.streakFrom) return 0;
  return Math.min(RANKED_RULES.streakMaxBonus, (streak - RANKED_RULES.streakFrom + 1) * RANKED_RULES.streakStep);
}

export interface RankedDeltaInput {
  rating: number;
  opponent: number;
  score: EloScore;
  /** Số ván xếp hạng đã chơi trong mùa, TRƯỚC ván này */
  gamesPlayed: number;
  /** Số ván thắng liên tiếp ngay trước ván này */
  winStreak: number;
  tiers?: readonly TierDef[];
}

export interface RankedDelta {
  /** Điểm thay đổi (trước khi qua sàn 0 — dùng ratingAfter để ra điểm mới) */
  delta: number;
  /** Elo gốc */
  base: number;
  /** Ván nằm trong 5 ván đầu mùa và được cộng điểm (đã nhân ×1,5) */
  placement: boolean;
  /** Hệ số đã nhân vào điểm bị trừ (1 nếu không bị trừ) */
  lossMultiplier: number;
  /** Điểm thưởng chuỗi thắng đã cộng */
  streakBonus: number;
}

/**
 * Điểm thay đổi của MỘT người sau ván xếp hạng — Elo + các luật giúp người đến sau dễ leo hạng (RANKED_RULES).
 * Hai bên tính riêng (không còn đối xứng tuyệt đối).
 */
export function rankedDelta(i: RankedDeltaInput): RankedDelta {
  const base = eloDelta(i.rating, i.opponent, i.score);
  let d = base;
  const placement = i.gamesPlayed < RANKED_RULES.placementGames && d > 0;
  if (placement) d = Math.round(d * RANKED_RULES.placementMultiplier);
  let lm = 1;
  if (d < 0) {
    lm = lossMultiplier(i.rating, i.tiers);
    d = Math.round(d * lm);
  }
  const bonus = i.score === 1 ? streakBonus(i.winStreak) : 0;
  d += bonus;
  return { delta: d === 0 ? 0 : d, base, placement, lossMultiplier: lm, streakBonus: bonus };
}

/** Chuỗi thắng sau ván này */
export function nextWinStreak(streakBefore: number, score: EloScore): number {
  return score === 1 ? Math.max(0, Math.floor(streakBefore)) + 1 : 0;
}

/**
 * Điểm sau một ngày "không chơi thì tụt": −decayPerDay nhưng không xuống dưới mốc của cấp bậc hiện tại.
 * Trả về điểm cũ nếu không thuộc diện tụt (dưới decayMinRating).
 */
export function decayedRating(rating: number, tiers: readonly TierDef[] = DEFAULT_TIERS): number {
  if (rating < RANKED_RULES.decayMinRating) return rating;
  const min = tiers.find((t) => rating >= t.min)?.min ?? -Infinity;
  const floor = Number.isFinite(min) ? Math.max(min, RATING_FLOOR) : RATING_FLOOR;
  return Math.max(floor, rating - RANKED_RULES.decayPerDay);
}
