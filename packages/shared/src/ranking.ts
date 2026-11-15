export interface Standing {
  rating: number;
  wins: number;
  gamesPlayed: number;
  /** Thời điểm đạt mức điểm hiện tại (ms) */
  ratingUpdatedAt: number;
}

/**
 * Thứ tự xếp hạng: điểm cao hơn; bằng điểm thì (1) nhiều ván thắng hơn trong quý,
 * (2) tỉ lệ thắng cao hơn, (3) đạt mức điểm đó sớm hơn.
 * Trả về số âm nếu a đứng trên b.
 */
export function compareStandings(a: Standing, b: Standing): number {
  if (b.rating !== a.rating) return b.rating - a.rating;
  if (b.wins !== a.wins) return b.wins - a.wins;
  const wa = a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0;
  const wb = b.gamesPlayed > 0 ? b.wins / b.gamesPlayed : 0;
  if (wb !== wa) return wb - wa;
  return a.ratingUpdatedAt - b.ratingUpdatedAt;
}
