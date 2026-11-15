/**
 * Biến thể của một ván:
 *  - "standard": Cờ tướng / Cờ vua thường (theo đặc tả)
 *  - "jieqi":    Cờ úp (biến thể của Cờ tướng; chỉ chơi với máy hoặc với người, KHÔNG tính điểm hạng)
 */
export const GAME_VARIANTS = ['standard', 'jieqi'] as const;
export type GameVariant = (typeof GAME_VARIANTS)[number];
