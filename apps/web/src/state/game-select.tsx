import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { GameType } from '@cotuong/game-core';

const KEY = 'cotuong.game';

function readStored(): GameType {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'chess' ? 'chess' : 'xiangqi';
  } catch {
    return 'xiangqi';
  }
}

interface GameSelectValue {
  game: GameType;
  setGame: (g: GameType) => void;
}

const Ctx = createContext<GameSelectValue | null>(null);

/** Game đang chọn trên thanh menu (Cờ tướng / Cờ vua) */
export function GameSelectProvider({ children }: { children: ReactNode }) {
  const [game, setGameState] = useState<GameType>(readStored);
  const setGame = useCallback((g: GameType) => {
    setGameState(g);
    try {
      localStorage.setItem(KEY, g);
    } catch {
      /* bỏ qua */
    }
  }, []);
  const value = useMemo(() => ({ game, setGame }), [game, setGame]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGameSelect(): GameSelectValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGameSelect phải dùng trong GameSelectProvider');
  return ctx;
}
