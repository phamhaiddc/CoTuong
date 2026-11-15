import type { EndReason, GameType } from '@cotuong/game-core';
import type { AiLevel } from './constants';

export const GAME_LABEL: Record<GameType, string> = {
  xiangqi: 'Cờ tướng',
  chess: 'Cờ vua',
};

export const COLOR_LABEL: Record<GameType, [string, string]> = {
  xiangqi: ['Đỏ', 'Đen'],
  chess: ['Trắng', 'Đen'],
};

export const AI_LEVEL_LABEL: Record<AiLevel, string> = {
  easy: 'Dễ',
  medium: 'Trung bình',
  hard: 'Khó',
};

export const END_REASON_LABEL: Record<EndReason, string> = {
  checkmate: 'Chiếu bí',
  stalemate: 'Hết nước đi',
  perpetual_check: 'Chiếu dai',
  repetition: 'Lặp thế cờ 3 lần',
  insufficient_material: 'Không đủ quân chiếu hết',
  fifty_moves: 'Luật 50 nước',
  resign: 'Đầu hàng',
  timeout: 'Hết giờ',
  agreement: 'Hai bên đồng ý hoà',
  no_first_move: 'Không đi nước đầu trong 30 giây',
  disconnect: 'Mất kết nối quá 60 giây',
};

export type Outcome = 'win' | 'loss' | 'draw';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  win: 'Thắng',
  loss: 'Thua',
  draw: 'Hoà',
};
