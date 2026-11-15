import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { HINT_CONFIG } from '@cotuong/ai';
import {
  JieqiGame,
  createGame,
  createJieqiGame,
  otherColor,
  randomJieqiSetup,
  replayGame,
  replayJieqi,
  type Color,
  type GameEngine,
  type GameResult,
} from '@cotuong/game-core';
import { AI_LEVEL_LABEL, COLOR_LABEL, GAME_LABEL, type LeaderboardResponse } from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { AI_UNAVAILABLE_MESSAGE, AiClient } from '../ai/aiClient';
import { GameBoard, lastMoveOf, type MoveMark } from '../components/Board';
import { Icon } from '../components/icons';
import { MoveList } from '../components/MoveList';
import { PlayerBar, capturedList } from '../components/PlayerBar';
import { Modal } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useToast } from '../state/toast';
import type { AiSetup } from './HomePage';
import {
  GameHead,
  GameScreen,
  PerpetualModal,
  PlaySkeleton,
  ResultDetails,
  StatusCard,
  endReasonText,
  resultLook,
  timeControlShort,
  timeControlTitle,
  warningNotices,
  type BoardNotice,
  type StatusTone,
} from './PlayPage';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resolveSide = (s: AiSetup['side']): Color => (s === 'random' ? (Math.random() < 0.5 ? 0 : 1) : s);

// --------------------------------------------------------------------------- Ván đang chơi dở (giữ qua tải lại trang)

/**
 * Ván đấu với máy chỉ chạy trong trình duyệt: tải lại trang / bấm sang trang khác là mất. Ván đang chơi được ghi tạm
 * vào sessionStorage (riêng từng thẻ trình duyệt) sau mỗi nước, để tải lại trang thì chơi tiếp được, còn mở lại
 * "Đấu với máy" thì được hỏi có chơi tiếp ván dở không. Ván kết thúc / chơi lại thì xoá.
 */
const RUNNING_KEY = 'cotuong.ai.running';

interface SavedAiGame {
  v: 1;
  userId: string;
  /** location.key của lần ghi: trùng = cùng mục lịch sử (tải lại trang, quay lại / tiến tới) → chơi tiếp luôn */
  locKey: string;
  setup: AiSetup;
  humanColor: Color;
  moves: string[];
  /** Cờ úp: chuỗi xếp quân của ván (chỉ trình duyệt này biết, như khi đang chơi) */
  jieqiSetup: string | null;
  startedAt: string;
  /** Thời gian còn lại mỗi bên lúc ghi (đồng hồ dừng trong lúc rời trang) */
  remaining: [number, number] | null;
}

/**
 * Chủ của ván dở: id tài khoản thành viên; chưa đăng nhập (kể cả khách) thì dùng chung một mã — ván với máy chạy
 * trong trình duyệt, không gắn với phiên khách. Đăng nhập / đăng xuất thì không mở nhầm ván dở của người khác.
 */
const NON_MEMBER_OWNER = 'khach';
const runOwner = (me: { id: string } | null): string => me?.id ?? NON_MEMBER_OWNER;

function readRunning(userId: string | undefined): SavedAiGame | null {
  if (!userId) return null;
  try {
    const v = JSON.parse(sessionStorage.getItem(RUNNING_KEY) ?? 'null') as SavedAiGame | null;
    if (!v || v.v !== 1 || v.userId !== userId || !Array.isArray(v.moves) || v.moves.length === 0 || !v.setup) return null;
    return v;
  } catch {
    return null;
  }
}
function writeRunning(v: SavedAiGame | null) {
  try {
    if (v) sessionStorage.setItem(RUNNING_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(RUNNING_KEY);
  } catch {
    /* trình duyệt chặn sessionStorage: bỏ qua (chỉ mất khả năng chơi tiếp sau khi tải lại) */
  }
}

/** Dựng lại ván dở; null nếu dữ liệu hỏng */
function restoreEngine(s: SavedAiGame): GameEngine | null {
  try {
    if (s.setup.variant === 'jieqi') return s.jieqiSetup ? replayJieqi(s.jieqiSetup, s.moves) : null;
    return replayGame(s.setup.game, s.moves);
  } catch {
    return null;
  }
}

const variantName = (s: AiSetup) => (s.variant === 'jieqi' ? 'Cờ úp' : GAME_LABEL[s.game]);

export function AiPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // Trang chỉ mở khi đã biết đăng nhập hay chưa (AuthReady) nên `me` ở đây đã chắc chắn
  const { me } = useAuth();
  const setup = location.state as AiSetup | null;
  // Đọc một lần khi mở trang
  const [saved] = useState(() => readRunning(runOwner(me)));
  const sameEntry = !!saved && saved.locKey === location.key;
  /** null = đang hỏi; 'resume' = chơi tiếp ván dở; 'new' = ván mới theo lựa chọn ở sảnh */
  const [mode, setMode] = useState<'resume' | 'new' | null>(() => (!saved ? 'new' : sameEntry ? 'resume' : null));

  if (mode === 'resume' && saved) return <AiGame setup={saved.setup} resume={saved} />;
  if (mode === 'new' || !saved) {
    if (!setup) return <Navigate to="/" replace />;
    return <AiGame setup={setup} />;
  }
  // Có ván dở và người chơi vừa chọn bắt đầu ván mới ở sảnh (hoặc mở thẳng /ai): hỏi trước
  return (
    <>
      <PlaySkeleton game={saved.setup.game} label="Đang mở ván…" />
      <Modal
        open
        title="Bạn còn một ván chưa xong"
        icon="restart"
        tone="primary"
        dismissable={false}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                writeRunning(null);
                if (setup) setMode('new');
                else navigate('/', { replace: true });
              }}
            >
              {setup ? 'Bỏ ván đó, chơi ván mới' : 'Bỏ ván đó'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setMode('resume')}>
              <Icon name="play" size={18} />
              Chơi tiếp ván dở
            </button>
          </>
        }
      >
        Ván {variantName(saved.setup)} với máy (mức {AI_LEVEL_LABEL[saved.setup.level]}) đã đi {saved.moves.length} nước. Bạn muốn
        chơi tiếp ván đó không? Nếu bỏ, ván đó sẽ không được lưu.
      </Modal>
    </>
  );
}

interface ClockState {
  remaining: [number, number];
  turnStartedAt: number;
}

function AiGame({ setup, resume }: { setup: AiSetup; resume?: SavedAiGame }) {
  // me: chỉ thành viên (lưu ván vào lịch sử, cấp bậc); player: tên hiển thị (thành viên hoặc khách)
  const { me, player } = useAuth();
  const memberId = me?.id ?? null;
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { setGame } = useGameSelect();
  const tc = setup.timeControl;

  const jieqi = setup.variant === 'jieqi';
  const aiRef = useRef<AiClient | null>(null);
  /** Cờ úp: chuỗi xếp quân của ván này (chỉ trình duyệt biết; máy chỉ nhận thông tin công khai) */
  const setupRef = useRef<string | null>(null);
  const newEngine = (): GameEngine => {
    if (!jieqi) return createGame(setup.game);
    setupRef.current = randomJieqiSetup();
    return createJieqiGame(setupRef.current);
  };
  const engineRef = useRef<GameEngine | null>(null);
  const clockRef = useRef<ClockState | null>(null);
  const startedAtRef = useRef('');
  const initRef = useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    const restored = resume ? restoreEngine(resume) : null;
    if (resume && restored) {
      engineRef.current = restored;
      setupRef.current = resume.jieqiSetup;
      startedAtRef.current = resume.startedAt;
      clockRef.current = tc ? { remaining: resume.remaining ?? [tc.initialMs, tc.initialMs], turnStartedAt: Date.now() } : null;
    } else {
      engineRef.current = newEngine();
      startedAtRef.current = new Date().toISOString();
      clockRef.current = tc ? { remaining: [tc.initialMs, tc.initialMs], turnStartedAt: Date.now() } : null;
    }
  }
  const gameNoRef = useRef(0);
  const [humanColor, setHumanColor] = useState<Color>(() => (resume && engineRef.current?.history().length ? resume.humanColor : resolveSide(setup.side)));
  const [ver, setVer] = useState(0);
  const [gameNo, setGameNo] = useState(0);
  const [thinking, setThinking] = useState(false);
  // Số lần thử lại khi AI gặp lỗi (worker hỏng…) — tránh khoá ván
  const [aiRetry, setAiRetry] = useState(0);
  const aiRetryRef = useRef(0);
  /** Máy lỗi liên tiếp, đã ngừng tự thử lại: hiện nút "Thử lại" */
  const [aiFailed, setAiFailed] = useState(false);
  const [hint, setHint] = useState<MoveMark | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [result, setResult] = useState<GameResult | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  /** Đường dẫn người chơi bấm tới khi ván đang dở (chờ xác nhận rời trang) */
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [flip, setFlip] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => setGame(setup.game), [setup.game, setGame]);

  // Cấp bậc hiện cạnh tên người chơi (theo điểm hạng quý hiện tại; đấu máy không làm đổi điểm)
  const [myTier, setMyTier] = useState<{ name: string; level: number } | null>(null);
  useEffect(() => {
    setMyTier(null);
    if (!memberId) return;
    let alive = true;
    api
      .get<LeaderboardResponse>(`/api/leaderboard/${setup.game}`)
      .then((d) => alive && d.me && setMyTier({ name: d.me.tier, level: d.me.tierLevel }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [setup.game, memberId]);

  useEffect(() => {
    aiRef.current = new AiClient();
    return () => aiRef.current?.terminate();
  }, []);

  const resetClock = useCallback(() => {
    clockRef.current = tc ? { remaining: [tc.initialMs, tc.initialMs], turnStartedAt: Date.now() } : null;
  }, [tc]);

  const save = useCallback(
    async (res: GameResult) => {
      // Chưa có tài khoản (kể cả khách): không lưu được — cuối ván chỉ hiện lời mời đăng nhập
      if (!memberId) {
        setSaveState('idle');
        return;
      }
      setSaveState('saving');
      try {
        await api.post('/api/matches/ai', {
          game: setup.game,
          aiLevel: setup.level,
          humanColor,
          timeControl: tc,
          moves: engineRef.current!.history(),
          result: res,
          startedAt: startedAtRef.current,
          ...(jieqi ? { variant: 'jieqi', setup: setupRef.current } : {}),
        });
        setSaveState('saved');
      } catch (e) {
        setSaveError(errorMessage(e));
        setSaveState('error');
      }
    },
    [memberId, setup.game, setup.level, humanColor, tc, jieqi],
  );

  const finishedRef = useRef(false);
  const finish = useCallback(
    (res: GameResult) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setHint(null);
      setAiFailed(false);
      setResult(res);
      setShowResult(true);
      writeRunning(null);
      void save(res);
    },
    [save],
  );

  /** Yêu cầu cho AI. Cờ úp: CHỈ nước đi + thông tin lật quân công khai (không bao giờ gửi chuỗi xếp quân) */
  const publicRequest = (eng: GameEngine, extra: { level?: AiSetup['level']; config?: typeof HINT_CONFIG }) =>
    eng instanceof JieqiGame
      ? {
          game: setup.game,
          variant: 'jieqi' as const,
          moves: eng.history(),
          reveals: eng.reveals(),
          seed: Math.floor(Math.random() * 2 ** 31),
          ...extra,
        }
      : { game: setup.game, moves: eng.history(), ...extra };

  const applyMove = useCallback(
    (move: string): boolean => {
      const eng = engineRef.current!;
      const mover = eng.turn();
      if (!eng.play(move)) return false;
      const c = clockRef.current;
      if (c && tc) {
        const now = Date.now();
        c.remaining[mover] = c.remaining[mover] - (now - c.turnStartedAt) + tc.incrementMs;
        c.turnStartedAt = now;
      }
      setHint(null);
      setVer((v) => v + 1);
      const st = eng.status();
      if (st.over) finish(st.result);
      return true;
    },
    [finish, tc],
  );

  // Lượt của máy
  useEffect(() => {
    const eng = engineRef.current!;
    if (result || eng.status().over || eng.turn() === humanColor || !aiRef.current) return;
    let cancelled = false;
    const myGame = gameNoRef.current;
    const t0 = Date.now();
    setThinking(true);
    aiRef.current
      .search(publicRequest(eng, { level: setup.level }))
      .then(async (r) => {
        const wait = 350 - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
        if (cancelled || myGame !== gameNoRef.current || !r?.move) return;
        aiRetryRef.current = 0;
        setThinking(false);
        applyMove(r.move);
      })
      .catch(() => {
        if (cancelled || myGame !== gameNoRef.current) return;
        setThinking(false);
        if (aiRef.current?.unavailable) {
          setAiFailed(true);
        } else if (aiRetryRef.current < 2) {
          aiRetryRef.current++;
          window.setTimeout(() => setAiRetry((n) => n + 1), 800);
        } else {
          setAiFailed(true);
        }
      });
    return () => {
      cancelled = true;
      setThinking(false);
    };
  }, [ver, humanColor, result, gameNo, setup.game, setup.level, applyMove, aiRetry]);

  // Đồng hồ + xử thua khi hết giờ
  useEffect(() => {
    if (!tc || result) return;
    const id = window.setInterval(() => {
      const c = clockRef.current;
      const eng = engineRef.current!;
      if (!c || eng.status().over) return;
      const turn = eng.turn();
      if (c.remaining[turn] - (Date.now() - c.turnStartedAt) <= 0) {
        c.remaining[turn] = 0;
        c.turnStartedAt = Date.now();
        finish({ winner: otherColor(turn), reason: 'timeout' });
      }
      tick((t) => t + 1);
    }, 200);
    return () => window.clearInterval(id);
  }, [tc, result, gameNo, finish]);

  // ---- Giữ ván dở: ghi sau mỗi nước và khi rời trang (để tải lại trang vẫn chơi tiếp được)
  const userId = runOwner(me);
  const locKey = location.key;
  const persistRunning = useCallback(() => {
    const eng = engineRef.current;
    if (!eng || finishedRef.current) return;
    const moves = eng.history();
    if (moves.length === 0 || eng.status().over) {
      writeRunning(null);
      return;
    }
    const c = clockRef.current;
    let remaining: [number, number] | null = null;
    if (c) {
      remaining = [c.remaining[0], c.remaining[1]];
      const t = eng.turn();
      remaining[t] = Math.max(1000, remaining[t] - (Date.now() - c.turnStartedAt));
    }
    writeRunning({
      v: 1,
      userId,
      locKey,
      setup,
      humanColor,
      moves,
      jieqiSetup: setupRef.current,
      startedAt: startedAtRef.current,
      remaining,
    });
  }, [userId, locKey, setup, humanColor]);
  useEffect(() => {
    if (!result) persistRunning();
  }, [ver, gameNo, result, persistRunning]);

  const running = !result && engineRef.current!.history().length > 0;
  // Rời trang (tải lại / đóng thẻ): trình duyệt hỏi lại; ván vẫn được ghi tạm để chơi tiếp
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      persistRunning();
      e.preventDefault();
      e.returnValue = '';
    };
    const onPageHide = () => persistRunning();
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [running, persistRunning]);
  // Bấm link sang trang khác trong web (menu, logo…) khi ván đang dở: hỏi trước. Router hiện tại (BrowserRouter) không có
  // useBlocker nên chặn ở pha capture của document — trước khi <Link> của React nhận cú bấm.
  useEffect(() => {
    if (!running) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [running]);

  const onHumanMove = (move: string, confirmed = false) => {
    const eng = engineRef.current!;
    if (result || eng.turn() !== humanColor) return;
    if (setup.game === 'xiangqi' && !confirmed && eng.isPerpetualCheckLoss(move)) {
      setConfirmMove(move);
      return;
    }
    applyMove(move);
  };

  const askHint = async () => {
    if (!aiRef.current || hintBusy) return;
    setHintBusy(true);
    const myGame = gameNoRef.current;
    const ply = engineRef.current!.historyInfo().length;
    try {
      const r = await aiRef.current.search(publicRequest(engineRef.current!, { config: HINT_CONFIG }));
      // Người chơi đã đi / chơi lại trong lúc máy tính gợi ý → gợi ý không còn đúng thế cờ
      if (myGame !== gameNoRef.current || engineRef.current!.historyInfo().length !== ply) return;
      if (r?.move) setHint({ from: r.move.slice(0, 2), to: r.move.slice(2, 4) });
    } catch {
      toast(aiRef.current?.unavailable ? AI_UNAVAILABLE_MESSAGE : 'Chưa lấy được gợi ý, bạn bấm Gợi ý lần nữa nhé.', 'error');
    } finally {
      setHintBusy(false);
    }
  };

  const restart = () => {
    setConfirmRestart(false);
    aiRef.current?.restart();
    gameNoRef.current++;
    engineRef.current = newEngine();
    startedAtRef.current = new Date().toISOString();
    resetClock();
    finishedRef.current = false;
    writeRunning(null);
    setHumanColor(resolveSide(setup.side));
    setResult(null);
    setShowResult(false);
    setHint(null);
    setSaveState('idle');
    setThinking(false);
    setAiFailed(false);
    aiRetryRef.current = 0;
    setGameNo((n) => n + 1);
    setVer((v) => v + 1);
  };

  const engine = engineRef.current!;
  const infos = useMemo(() => engine.historyInfo(), [engine, ver]);
  // Tên nước gợi ý theo ký hiệu Việt Nam (vd "P2-5" = Pháo 2 bình 5) — chỉ để hiển thị
  const hintLabel = useMemo(() => {
    if (!hint) return null;
    try {
      const e = engine.clone();
      if (!e.play(hint.from + hint.to)) return null;
      const all = e.historyInfo();
      const label = all[all.length - 1]?.label ?? null;
      // Cờ úp: phần "→ <quân lật ra>" / "(ăn <quân> úp)" là bí mật trước khi đi → chỉ giữ phần công khai
      return label && engine instanceof JieqiGame ? label.split(' → ')[0].split(' (ăn')[0] : label;
    } catch {
      return null;
    }
  }, [engine, hint, ver]);
  // Vào ván: đưa bàn cờ lên đầu màn hình (router không tự cuộn về đầu khi chuyển trang)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  // Chơi tiếp ván dở: báo cho người chơi biết (một lần, kể cả khi StrictMode chạy hiệu ứng hai lần)
  const toldResumeRef = useRef(false);
  useEffect(() => {
    if (toldResumeRef.current || !resume || engineRef.current!.history().length === 0) return;
    toldResumeRef.current = true;
    toast('Đã mở lại ván bạn đang chơi dở.', 'info');
  }, [resume, toast]);

  const aiColor = otherColor(humanColor);
  const bottom: Color = flip ? aiColor : humanColor;
  const turn = engine.turn();
  const c = clockRef.current;
  const clockOf = (color: Color): number | undefined => {
    if (!c) return undefined;
    if (!result && turn === color) return Math.max(0, c.remaining[color] - (Date.now() - c.turnStartedAt));
    return c.remaining[color];
  };
  const outcome = result ? (result.winner === null ? 'Hoà' : result.winner === humanColor ? 'Bạn thắng!' : 'Bạn thua') : null;
  const warnings = result ? [] : engine.warnings();
  const botName = `Máy (${AI_LEVEL_LABEL[setup.level]})`;
  const inCheck = !result && engine.inCheck();
  const look = resultLook(result?.winner ?? null, humanColor);
  const kingWord = setup.game === 'xiangqi' ? 'tướng' : 'vua';
  const lastInfo = infos.length > 0 ? infos[infos.length - 1] : null;
  const reasonText = result ? endReasonText(setup.game, result, humanColor, 'Máy') : undefined;

  const bar = (color: Color) =>
    color === humanColor ? (
      <PlayerBar
        game={setup.game}
        color={color}
        name={player?.username ?? 'Khách'}
        avatarUrl={player?.avatarUrl}
        isMe
        tier={myTier?.name}
        tierLevel={myTier?.level}
        clockMs={clockOf(color)}
        active={!result && turn === color}
        inCheck={inCheck && turn === color}
        captured={engine instanceof JieqiGame ? capturedList(engine.capturedPieces()[color === 0 ? 1 : 0]) : undefined}
      />
    ) : (
      <PlayerBar
        game={setup.game}
        color={color}
        name={botName}
        isBot
        clockMs={clockOf(color)}
        active={!result && turn === color}
        thinking={thinking}
        inCheck={inCheck && turn === color}
        captured={engine instanceof JieqiGame ? capturedList(engine.capturedPieces()[color === 0 ? 1 : 0]) : undefined}
      />
    );

  let status: { tone: StatusTone; title: string; sub?: ReactNode };
  if (!result) {
    if (turn === humanColor) {
      status = inCheck
        ? { tone: 'check', title: 'Chiếu!', sub: `Đến lượt bạn — hãy gỡ chiếu cho ${kingWord}.` }
        : {
            tone: 'turn',
            title: 'Đến lượt bạn',
            sub: hintLabel ? (
              <>
                Gợi ý: <b>{hintLabel}</b> (xem mũi tên trên bàn cờ)
              </>
            ) : lastInfo ? (
              <>
                Máy vừa đi <b>{lastInfo.label}</b>
              </>
            ) : (
              `Bạn cầm quân ${COLOR_LABEL[setup.game][humanColor]}, đi trước`
            ),
          };
    } else if (aiFailed) {
      status = {
        tone: 'wait',
        title: 'Máy chưa đi được',
        sub: aiRef.current?.unavailable ? 'Bấm Tải lại trang ở thông báo trên bàn cờ.' : 'Bấm Thử lại ở thông báo trên bàn cờ.',
      };
    } else {
      status = inCheck
        ? { tone: 'check', title: 'Chiếu!', sub: 'Máy đang nghĩ cách gỡ chiếu…' }
        : { tone: 'think', title: 'Máy đang nghĩ…', sub: `Mức ${AI_LEVEL_LABEL[setup.level]}` };
    }
  } else {
    status = { tone: look.tone, title: outcome ?? '', sub: reasonText };
  }

  // Thông báo: máy lỗi (có nút Thử lại), máy đang nghĩ (chỉ trên thanh nổi của máy tính), cảnh báo luật
  const notices: BoardNotice[] = [];
  if (aiFailed && !result && aiRef.current?.unavailable) {
    // Tệp máy cờ không tải được (thường do trang vừa được cập nhật): thử lại vô ích, cần tải lại trang (ván dở được giữ)
    notices.push({
      key: 'ai-failed',
      tone: 'warn',
      icon: 'alert',
      text: AI_UNAVAILABLE_MESSAGE,
      actions: (
        <button type="button" className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
          <Icon name="restart" size={16} />
          Tải lại trang
        </button>
      ),
    });
  } else if (aiFailed && !result) {
    notices.push({
      key: 'ai-failed',
      tone: 'warn',
      icon: 'alert',
      text: 'Máy gặp trục trặc nên chưa đi được.',
      actions: (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            setAiFailed(false);
            aiRetryRef.current = 0;
            setAiRetry((n) => n + 1);
          }}
        >
          <Icon name="restart" size={16} />
          Thử lại
        </button>
      ),
    });
  }
  if (thinking && !result) notices.push({ key: 'think', tone: 'think', text: `${botName} đang nghĩ…`, overlayOnly: true });
  notices.push(...warningNotices(setup.game, warnings));

  return (
    <GameScreen
      game={setup.game}
      className="ai-game"
      ended={!!result}
      head={
        <GameHead
          game={setup.game}
          title="Đấu với máy"
          sub={
            <>
              {variantName(setup)} · Mức {AI_LEVEL_LABEL[setup.level]} · Không tính điểm hạng
            </>
          }
          tc={timeControlShort(tc)}
          tcTitle={timeControlTitle(tc)}
        />
      }
      top={bar(otherColor(bottom))}
      bottom={bar(bottom)}
      board={
        <GameBoard
          engine={engine}
          version={ver}
          orientation={bottom}
          movable={result || thinking ? null : humanColor}
          onMove={(m) => onHumanMove(m)}
          lastMove={lastMoveOf(engine)}
          hint={hint}
        />
      }
      notices={notices}
      status={
        <>
          <StatusCard tone={status.tone} title={status.title} sub={status.sub} />
          {result && !me && (
            // Chưa có tài khoản (kể cả khách): ván không được lưu — mời đăng nhập
            <div className="save-status" role="status">
              <Icon name="info" size={16} />
              <span>
                <Link to="/login">Đăng nhập</Link> để lưu ván vào lịch sử.
              </span>
            </div>
          )}
          {result && me && (
            <div className={`save-status ${saveState === 'saved' ? 'ok' : saveState}`} role="status">
              {saveState === 'saving' && (
                <>
                  <span className="spinner spinner-sm" aria-hidden="true" />
                  <span>Đang lưu ván vào lịch sử…</span>
                </>
              )}
              {saveState === 'saved' && (
                <>
                  <Icon name="check" size={16} />
                  <span>
                    Đã lưu vào <Link to={`/profile/${me.id}`}>lịch sử ván đấu</Link>.
                  </span>
                </>
              )}
              {saveState === 'error' && (
                <>
                  <Icon name="alert" size={16} />
                  <span>
                    Chưa lưu được ván này vào lịch sử{saveError ? ` (${saveError})` : ''}.{' '}
                    <button type="button" className="link-btn" onClick={() => void save(result)}>
                      Thử lại
                    </button>
                  </span>
                </>
              )}
            </div>
          )}
        </>
      }
      toolbar={
        <div className="actions">
          {!result && (
            <button
              className="btn btn-sm act act-hint"
              onClick={askHint}
              disabled={hintBusy || thinking || turn !== humanColor}
              aria-label="Gợi ý nước đi"
              aria-busy={hintBusy}
              title="Máy gợi ý một nước cho bạn (bấm bao nhiêu lần cũng được)"
            >
              {hintBusy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="bulb" size={18} />}
              <span className="act-label">
                {hintBusy ? (
                  'Đang tính…'
                ) : (
                  <>
                    Gợi ý<span className="act-more"> nước đi</span>
                  </>
                )}
              </span>
            </button>
          )}
          <button
            className={`btn ${result ? 'btn-primary' : 'btn-ghost'} btn-sm act`}
            onClick={() => (result || engine.history().length === 0 ? restart() : setConfirmRestart(true))}
            title={result ? 'Bắt đầu ván mới với cùng mức máy' : 'Bỏ ván này, bắt đầu lại từ đầu'}
          >
            <Icon name="restart" size={18} />
            <span className="act-label">{result ? 'Ván mới' : 'Chơi lại'}</span>
          </button>
          {!result && (
            <button className="btn btn-danger btn-sm act" onClick={() => setConfirmResign(true)} title="Chịu thua ván này">
              <Icon name="flag" size={18} />
              <span className="act-label">Đầu hàng</span>
            </button>
          )}
        </div>
      }
      onFlip={() => setFlip((f) => !f)}
      tabs={[
        {
          id: 'moves',
          label: 'Nước đi',
          icon: 'list',
          count: infos.length,
          content: <MoveList moves={infos} game={setup.game} jieqi={jieqi} />,
        },
      ]}
      sideFooter={
        <p className="side-note">
          <Icon name="info" size={15} />
          {jieqi
            ? 'Quân úp đi theo quân gốc của ô nó đứng, đi xong thì lật lên. Không đi lại được nước đã đi.'
            : 'Không đi lại được nước đã đi. Gợi ý thì dùng bao nhiêu lần cũng được.'}
        </p>
      }
    >
      <PerpetualModal
        open={confirmMove !== null}
        onCancel={() => setConfirmMove(null)}
        onConfirm={() => {
          const m = confirmMove!;
          setConfirmMove(null);
          onHumanMove(m, true);
        }}
      />

      <Modal
        open={confirmResign}
        title="Đầu hàng ván này?"
        icon="flag"
        tone="danger"
        onClose={() => setConfirmResign(false)}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirmResign(false)}>
              Không, chơi tiếp
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                setConfirmResign(false);
                aiRef.current?.restart();
                gameNoRef.current++;
                finish({ winner: aiColor, reason: 'resign' });
              }}
            >
              <Icon name="flag" size={18} />
              Đầu hàng
            </button>
          </>
        }
      >
        Ván này sẽ tính là bạn thua (đấu với máy không ảnh hưởng điểm hạng).
      </Modal>

      <Modal
        open={confirmRestart}
        title="Chơi lại từ đầu?"
        icon="restart"
        tone="primary"
        onClose={() => setConfirmRestart(false)}
        actions={
          <>
            <button className="btn btn-ghost" data-autofocus onClick={() => setConfirmRestart(false)}>
              Không, chơi tiếp
            </button>
            <button className="btn btn-primary" onClick={restart}>
              <Icon name="restart" size={18} />
              Chơi lại
            </button>
          </>
        }
      >
        Ván đang chơi sẽ bị bỏ và không được lưu vào lịch sử.
      </Modal>

      <Modal
        open={leaveTo !== null}
        title="Rời ván đang chơi?"
        icon="alert"
        tone="warn"
        onClose={() => setLeaveTo(null)}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const to = leaveTo!;
                persistRunning();
                setLeaveTo(null);
                navigate(to);
              }}
            >
              Rời trang
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setLeaveTo(null)}>
              Ở lại chơi tiếp
            </button>
          </>
        }
      >
        Ván với máy chưa xong nên chưa được lưu vào lịch sử. Ván được giữ tạm trong thẻ trình duyệt này — lần sau mở Đấu với máy, bạn
        có thể chơi tiếp.
      </Modal>

      <Modal
        open={showResult && !!result}
        title={outcome ?? ''}
        icon={look.icon}
        tone={look.modalTone}
        onClose={() => setShowResult(false)}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setShowResult(false)}>
              Xem lại bàn cờ
            </button>
            <button className="btn btn-primary" onClick={restart}>
              <Icon name="restart" size={18} />
              Chơi ván mới
            </button>
          </>
        }
      >
        <ResultDetails reason={reasonText} note="Đấu với máy không tính điểm hạng." />
      </Modal>
    </GameScreen>
  );
}
