import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { HINT_CONFIG } from '@cotuong/ai';
import { createGame, otherColor, type Color, type GameEngine, type GameResult, type MoveInfo } from '@cotuong/game-core';
import {
  END_REASON_LABEL,
  PUZZLE_COUNT,
  getPuzzle,
  puzzleMoveCount,
  type PuzzleAttemptResultDto,
  type PuzzleDef,
  type PuzzleProgressResponse,
} from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { AI_UNAVAILABLE_MESSAGE, AiClient } from '../ai/aiClient';
import { GameBoard, lastMoveOf, type MoveMark } from '../components/Board';
import { Icon, type IconName } from '../components/icons';
import { MoveList } from '../components/MoveList';
import { PlayerBar } from '../components/PlayerBar';
import { Modal } from '../components/ui';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { GameScreen, PerpetualModal, PlayError, warningNotices, type BoardNotice } from './PlayPage';
import { UNVERIFIED_TITLE, addGuestSolve, importGuestSolves, readGuestSolved } from './PuzzlesPage';

/*
 * Giải một thế cờ (/co-the/:puzzleId). Người chơi cầm Đỏ (bên đi trước của mọi thế), máy cầm Đen và tự đỡ.
 *
 * Cách máy đỡ (quyết định của trang này — cần xác nhận):
 *  - Thế đã chứng minh (có mateIn + solution) và ván còn nằm trên đường giải: Đen đi đúng nước đỡ trong lời giải
 *    (= cách đỡ kéo dài nhất theo bộ giải), nên "Gợi ý" và "Xem lời giải" luôn khớp với ván đang chơi.
 *  - Ra khỏi đường giải (người chơi đi nước khác) hoặc thế chưa kiểm chứng: AI của trang đấu với máy, ~1,5 giây mỗi nước.
 *
 * Kết quả do server quyết định lại (đi lại các nước bằng game-core); khách: lưu số thế đã giải trong localStorage.
 */

const RED: Color = 0;
const BLACK: Color = 1;
const NO_MOVES: readonly string[] = [];

/** AI phòng thủ khi ra khỏi đường giải: mức Khó nhưng giới hạn ~1,5 giây để không phải chờ lâu */
const DEFENCE = { level: 'hard' as const, config: { timeMs: 1500 } };
/** Đen đi theo lời giải đã lưu khi ván còn trên đường giải (đặt false để luôn dùng AI) */
const BLACK_FOLLOWS_SOLUTION = true;
/** Độ trễ tối thiểu trước nước của máy (để người chơi kịp thấy nước vừa đi) */
const MIN_REPLY_MS = 450;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const codeOf = (id: number) => String(id).padStart(3, '0');

/** Câu mô tả kết thúc ván, theo góc nhìn người giải (Đỏ) */
function endText(res: GameResult): string {
  const red = res.winner === RED;
  switch (res.reason) {
    case 'checkmate':
      return red ? 'Đỏ chiếu bí Đen' : 'Đỏ bị chiếu bí';
    case 'stalemate':
      return red ? 'Đen hết nước đi — bị xử thua' : 'Đỏ hết nước đi — bị xử thua';
    case 'perpetual_check':
      return red ? 'Đen chiếu dai — bị xử thua' : 'Đỏ chiếu dai — bị xử thua';
    case 'repetition':
      return 'Thế cờ lặp lại 3 lần — hoà';
    default:
      return END_REASON_LABEL[res.reason] ?? res.reason;
  }
}

// =========================================================================== Trang

export function PuzzlePage() {
  const { puzzleId = '' } = useParams();
  const puzzle = /^\d{1,3}$/.test(puzzleId) ? getPuzzle(Number(puzzleId)) : undefined;
  if (!puzzle) {
    return (
      <PlayError
        icon="puzzle"
        title="Không tìm thấy thế cờ"
        message={`Không có thế “${puzzleId}”. Tuyển tập gồm các thế từ 001 đến ${codeOf(PUZZLE_COUNT)}.`}
      >
        <Link to="/co-the" className="btn btn-primary">
          <Icon name="grid" size={18} />
          Danh sách cờ thế
        </Link>
        <Link to="/co-the/1" className="btn btn-ghost">
          Giải Thế 001
        </Link>
      </PlayError>
    );
  }
  // key: sang thế khác thì dựng lại toàn bộ trạng thái ván
  return <PuzzleGame key={puzzle.id} puzzle={puzzle} />;
}

// =========================================================================== Ván giải thế

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; res: PuzzleAttemptResultDto }
  | { kind: 'error'; message: string }
  /** Khách giải được: đã ghi vào trình duyệt */
  | { kind: 'guest' };

/** Thành tích đã có ở thế này (để hiện chip "Đã giải") */
interface SolvedRecord {
  bestMoves: number | null;
  /** Chỉ lưu trên trình duyệt (khách) */
  local: boolean;
}

interface Hint {
  mark: MoveMark;
  /** Lấy từ lời giải đã kiểm chứng (ngược lại: máy tính) */
  fromSolution: boolean;
}

type Tone = 'turn' | 'wait' | 'think' | 'check' | 'win' | 'loss' | 'draw' | 'solution';

function PuzzleGame({ puzzle }: { puzzle: PuzzleDef }) {
  const { me, loading: authLoading } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const solution = puzzle.mateIn && puzzle.solution?.length ? puzzle.solution : NO_MOVES;
  const proven = solution.length > 0;
  const mateIn = puzzle.mateIn ?? 0;
  const prevId = puzzle.id > 1 ? puzzle.id - 1 : null;
  const nextId = puzzle.id < PUZZLE_COUNT ? puzzle.id + 1 : null;

  const aiRef = useRef<AiClient | null>(null);
  const engineRef = useRef<GameEngine>(createGame('xiangqi', puzzle.fen));
  const gameNoRef = useRef(0);
  const finishedRef = useRef(false);
  const savedMovesRef = useRef<string[]>([]);
  const [ver, setVer] = useState(0);
  const [gameNo, setGameNo] = useState(0);
  const [thinking, setThinking] = useState(false);
  // Thử lại khi máy (bên Đen) gặp lỗi
  const [defRetry, setDefRetry] = useState(0);
  const defRetryRef = useRef(0);
  /** Máy lỗi liên tiếp, đã ngừng tự thử lại */
  const [defFailed, setDefFailed] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [result, setResult] = useState<GameResult | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [flip, setFlip] = useState(false);
  /** Đang xem lời giải: số nước đã hiện trên bàn (null = đang chơi) */
  const [solStep, setSolStep] = useState<number | null>(null);
  const [sawSolution, setSawSolution] = useState(false);
  const [record, setRecord] = useState<SolvedRecord | null>(null);

  useEffect(() => {
    aiRef.current = new AiClient();
    return () => aiRef.current?.terminate();
  }, []);

  // Thành tích đã có ở thế này
  const meId = me?.id ?? null;
  useEffect(() => {
    if (authLoading) return;
    if (!meId) {
      setRecord(readGuestSolved().includes(puzzle.id) ? { bestMoves: null, local: true } : null);
      return;
    }
    let alive = true;
    // Vừa đăng nhập: chuyển các thế đã giải khi còn là khách vào tài khoản (máy chủ đi lại các nước để xác nhận)
    importGuestSolves()
      .catch(() => null)
      .then((imp) => {
        if (alive && imp && imp.imported > 0) toast(`Đã chuyển ${imp.imported} thế bạn giải khi chưa đăng nhập vào tài khoản.`, 'success');
        return api.get<PuzzleProgressResponse>('/api/puzzles/progress');
      })
      .then((r) => {
        const it = r.items.find((x) => x.puzzleId === puzzle.id);
        if (alive) setRecord(it?.solvedAt ? { bestMoves: it.bestMoves, local: false } : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [meId, authLoading, puzzle.id, toast]);

  /** Ván còn nằm trên đường giải đã lưu (mọi nước đã đi trùng lời giải) */
  const onSolutionLine = useCallback(
    (hist: readonly string[]) => proven && hist.length < solution.length && hist.every((m, i) => m === solution[i]),
    [proven, solution],
  );

  const persist = useCallback(
    async (moves: string[], won: boolean) => {
      if (!meId) {
        if (won) {
          // Giữ cả các nước đi: sau khi đăng nhập, gửi lại để máy chủ xác nhận và ghi vào tài khoản
          addGuestSolve(puzzle.id, moves);
          setRecord((r) => r ?? { bestMoves: null, local: true });
        }
        setSave(won ? { kind: 'guest' } : { kind: 'idle' });
        return;
      }
      setSave({ kind: 'saving' });
      try {
        const res = await api.post<PuzzleAttemptResultDto>(`/api/puzzles/${puzzle.id}/attempt`, { moves });
        setSave({ kind: 'saved', res });
        if (res.progress.solvedAt) setRecord({ bestMoves: res.progress.bestMoves, local: false });
      } catch (e) {
        setSave({ kind: 'error', message: errorMessage(e) });
      }
    },
    [meId, puzzle.id],
  );

  const finish = useCallback(
    (res: GameResult) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setHint(null);
      setResult(res);
      setShowResult(true);
      const moves = engineRef.current.history();
      savedMovesRef.current = moves;
      void persist(moves, res.winner === RED);
    },
    [persist],
  );

  const applyMove = useCallback(
    (move: string): boolean => {
      const eng = engineRef.current;
      if (!eng.play(move)) return false;
      setHint(null);
      setVer((v) => v + 1);
      const st = eng.status();
      if (st.over) finish(st.result);
      return true;
    },
    [finish],
  );

  // Lượt của máy (Đen)
  useEffect(() => {
    const eng = engineRef.current;
    const ai = aiRef.current;
    if (result || eng.status().over || eng.turn() !== BLACK || !ai) return;
    let cancelled = false;
    const myGame = gameNoRef.current;
    const t0 = Date.now();
    const hist = eng.history();
    const book = BLACK_FOLLOWS_SOLUTION && onSolutionLine(hist) ? solution[hist.length] : null;
    setThinking(true);
    (async () => {
      let move: string | null = null;
      if (book && eng.isLegal(book)) {
        move = book;
      } else {
        const r = await ai.search({ game: 'xiangqi', startFen: puzzle.fen, moves: hist, ...DEFENCE });
        move = r?.move ?? null;
      }
      const wait = MIN_REPLY_MS - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      if (cancelled || myGame !== gameNoRef.current || !move) return;
      defRetryRef.current = 0;
      setThinking(false);
      applyMove(move);
    })().catch(() => {
      if (cancelled || myGame !== gameNoRef.current) return;
      setThinking(false);
      // Không để thế cờ kẹt: thử lại tối đa 2 lần rồi mới báo (thông báo trên bàn cờ có nút Thử lại).
      // Máy cờ không tải được nữa (trang vừa được cập nhật) thì báo ngay: thử lại vô ích
      if (aiRef.current?.unavailable) {
        setDefFailed(true);
      } else if (defRetryRef.current < 2) {
        defRetryRef.current++;
        window.setTimeout(() => setDefRetry((n) => n + 1), 800);
      } else {
        setDefFailed(true);
      }
    });
    return () => {
      cancelled = true;
      setThinking(false);
    };
  }, [ver, result, gameNo, puzzle.fen, solution, onSolutionLine, applyMove, defRetry]);

  const onHumanMove = (move: string, confirmed = false) => {
    const eng = engineRef.current;
    if (result || solStep !== null || eng.turn() !== RED) return;
    if (!confirmed && eng.isPerpetualCheckLoss(move)) {
      setConfirmMove(move);
      return;
    }
    applyMove(move);
  };

  const askHint = async () => {
    const eng = engineRef.current;
    if (hintBusy || result || eng.turn() !== RED) return;
    const hist = eng.history();
    if (onSolutionLine(hist)) {
      const m = solution[hist.length];
      setHint({ mark: { from: m.slice(0, 2), to: m.slice(2, 4) }, fromSolution: true });
      setHintsUsed((n) => n + 1);
      return;
    }
    if (!aiRef.current) return;
    const myGame = gameNoRef.current;
    setHintBusy(true);
    try {
      const r = await aiRef.current.search({ game: 'xiangqi', startFen: puzzle.fen, moves: hist, config: HINT_CONFIG });
      if (myGame === gameNoRef.current && r?.move && engineRef.current.history().length === hist.length) {
        setHint({ mark: { from: r.move.slice(0, 2), to: r.move.slice(2, 4) }, fromSolution: false });
        setHintsUsed((n) => n + 1);
      }
    } catch {
      toast(aiRef.current?.unavailable ? AI_UNAVAILABLE_MESSAGE : 'Chưa lấy được gợi ý, bạn bấm Gợi ý lần nữa nhé.', 'error');
    } finally {
      setHintBusy(false);
    }
  };

  const restart = () => {
    aiRef.current?.restart();
    gameNoRef.current++;
    engineRef.current = createGame('xiangqi', puzzle.fen);
    finishedRef.current = false;
    savedMovesRef.current = [];
    setResult(null);
    setShowResult(false);
    setHint(null);
    setHintBusy(false);
    setHintsUsed(0);
    setSawSolution(false);
    setSave({ kind: 'idle' });
    setThinking(false);
    setDefFailed(false);
    defRetryRef.current = 0;
    setConfirmMove(null);
    setSolStep(null);
    setGameNo((n) => n + 1);
    setVer((v) => v + 1);
  };

  const goTo = (id: number | null) => {
    if (id) navigate(`/co-the/${id}`);
  };

  const openSolution = () => {
    if (!proven) return;
    setShowResult(false);
    setHint(null);
    setSolStep(0);
    setSawSolution(true);
  };

  // ---- Lời giải: toàn bộ nhãn nước đi + thế cờ ở bước đang xem
  const solInfos = useMemo<MoveInfo[]>(() => {
    if (!proven) return [];
    const e = createGame('xiangqi', puzzle.fen);
    for (const m of solution) if (!e.play(m)) break;
    return e.historyInfo();
  }, [proven, puzzle.fen, solution]);
  const solEngine = useMemo(() => {
    if (solStep === null) return null;
    const e = createGame('xiangqi', puzzle.fen);
    for (const m of solution.slice(0, solStep)) e.play(m);
    return e;
  }, [solStep, puzzle.fen, solution]);
  const solLen = solInfos.length;
  const viewing = solEngine !== null && solStep !== null;
  const step = (n: number) => setSolStep((s) => (s === null ? s : Math.max(0, Math.min(solLen, n))));

  // Lời giải: phím ← → / Home / End (trừ khi đang ở ô nhập hoặc trên bàn cờ — bàn cờ dùng phím mũi tên riêng)
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, svg, .modal')) return;
      if (e.key === 'ArrowRight') setSolStep((s) => (s === null ? s : Math.min(solLen, s + 1)));
      else if (e.key === 'ArrowLeft') setSolStep((s) => (s === null ? s : Math.max(0, s - 1)));
      else if (e.key === 'Home') setSolStep(0);
      else if (e.key === 'End') setSolStep(solLen);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewing, solLen]);

  // ---- Trạng thái hiển thị
  const engine = engineRef.current;
  const infos = useMemo(() => engine.historyInfo(), [engine, ver]);
  const hintLabel = useMemo(() => {
    if (!hint) return null;
    try {
      const e = engine.clone();
      if (!e.play(hint.mark.from + hint.mark.to)) return null;
      const all = e.historyInfo();
      return all[all.length - 1]?.label ?? null;
    } catch {
      return null;
    }
  }, [engine, hint, ver]);

  const shown = viewing ? solEngine : engine;
  const turn = shown.turn();
  const inCheck = !shown.status().over && shown.inCheck();
  const plies = infos.length;
  const redMoves = puzzleMoveCount(plies);
  const won = result?.winner === RED;
  const drawn = !!result && result.winner === null;
  const bottom: Color = flip ? BLACK : RED;
  const lastInfo = plies > 0 ? infos[plies - 1] : null;
  const goalText = proven ? `chiếu hết trong ${mateIn} nước` : 'tìm cách thắng';

  // ---- Ô trạng thái
  let status: { tone: Tone; icon?: IconName; title: string; sub?: ReactNode };
  if (viewing) {
    const s = solStep ?? 0;
    const cur = s > 0 ? solInfos[s - 1] : null;
    status = {
      tone: 'solution',
      icon: 'eye',
      title: s === 0 ? 'Lời giải' : `Lời giải · bước ${s}/${solLen}`,
      sub:
        s === 0 ? (
          `Đỏ chiếu hết trong ${mateIn} nước — bấm Tiến để xem từng nước`
        ) : (
          <>
            {s % 2 === 1 ? 'Đỏ' : 'Đen'} đi <b>{cur?.label}</b>
            {s === solLen ? ' — chiếu hết!' : ''}
          </>
        ),
    };
  } else if (result) {
    status = won
      ? { tone: 'win', icon: 'trophy', title: 'Giải được!', sub: endText(result) }
      : drawn
        ? { tone: 'draw', icon: 'draw', title: 'Hoà — chưa giải được', sub: endText(result) }
        : { tone: 'loss', icon: 'flag', title: 'Chưa giải được', sub: endText(result) };
  } else if (turn === RED) {
    status = inCheck
      ? { tone: 'check', icon: 'alert', title: 'Chiếu!', sub: 'Tướng Đỏ đang bị chiếu — hãy gỡ chiếu.' }
      : {
          tone: 'turn',
          title: 'Đến lượt bạn',
          sub: hintLabel ? (
            <>
              {hint?.fromSolution ? (
                <>
                  Gợi ý<span className="pzp-src"> (theo lời giải)</span>
                </>
              ) : (
                'Máy gợi ý'
              )}
              : <b>{hintLabel}</b>
            </>
          ) : lastInfo ? (
            <>
              Máy vừa đi <b>{lastInfo.label}</b>
            </>
          ) : (
            'Bạn cầm quân Đỏ'
          ),
        };
  } else if (defFailed) {
    status = {
      tone: 'wait',
      icon: 'alert',
      title: 'Máy chưa đi được',
      sub: aiRef.current?.unavailable ? 'Bấm Tải lại trang ở thông báo trên bàn cờ.' : 'Bấm Thử lại ở thông báo trên bàn cờ.',
    };
  } else {
    status = {
      tone: 'think',
      title: 'Máy đang đỡ…',
      sub: inCheck ? 'Bạn vừa chiếu — máy đang tìm cách gỡ' : 'Máy cầm quân Đen',
    };
  }

  // ---- Thông báo
  const notices: BoardNotice[] = [];
  if (!viewing) {
    if (defFailed && !result && aiRef.current?.unavailable) {
      notices.push({
        key: 'def-failed',
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
    } else if (defFailed && !result) {
      notices.push({
        key: 'def-failed',
        tone: 'warn',
        icon: 'alert',
        text: 'Máy gặp trục trặc nên chưa đi được.',
        actions: (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setDefFailed(false);
              defRetryRef.current = 0;
              setDefRetry((n) => n + 1);
            }}
          >
            <Icon name="restart" size={16} />
            Thử lại
          </button>
        ),
      });
    }
    if (thinking && !result) notices.push({ key: 'think', tone: 'think', text: 'Máy đang nghĩ…', overlayOnly: true });
    if (!result) notices.push(...warningNotices('xiangqi', engine.warnings()));
  }

  const bar = (color: Color) =>
    color === RED ? (
      <PlayerBar
        game="xiangqi"
        color={RED}
        name={me?.username ?? 'Khách'}
        avatarUrl={me?.avatarUrl}
        isMe
        active={!result && turn === RED}
        inCheck={inCheck && turn === RED}
      />
    ) : (
      <PlayerBar
        game="xiangqi"
        color={BLACK}
        name="Máy"
        isBot
        active={!result && turn === BLACK}
        thinking={thinking && !viewing}
        inCheck={inCheck && turn === BLACK}
      />
    );

  const head = (
    <header className="game-head pzp-head">
      <button
        type="button"
        className="btn btn-quiet btn-icon pzp-nav pzp-prev"
        onClick={() => goTo(prevId)}
        disabled={!prevId}
        aria-label="Thế trước"
        title={prevId ? `Thế trước (Thế ${codeOf(prevId)})` : 'Đây là thế đầu tiên'}
      >
        <Icon name="chevron-left" size={20} />
      </button>
      <div className="pzp-id">
        <span className="pzp-code num">Thế {puzzle.code}</span>
        {!proven && (
          <span className="pzp-unverified" title={UNVERIFIED_TITLE}>
            Chưa kiểm chứng
          </span>
        )}
        {record && (
          <span
            className="pzp-solved"
            title={record.local ? 'Đã giải trên trình duyệt này — đăng nhập để chuyển vào tài khoản' : 'Bạn đã giải thế này'}
          >
            <Icon name="check" size={13} strokeWidth={3} />
            Đã giải{record.bestMoves ? ` · ${record.bestMoves} nước` : ''}
          </span>
        )}
      </div>
      <h1 className="pzp-name">
        <span className="pzp-han" lang="zh-Hans">
          {puzzle.han}
        </span>
        {puzzle.viet ? (
          <span className="pzp-viet" title="Phiên âm Hán Việt theo tài liệu, chưa được duyệt chính thức">
            {puzzle.viet}
          </span>
        ) : (
          <span className="pzp-viet is-missing" title="Tài liệu tên Hán Việt hiện chỉ có thế 1–100">
            Chưa có tên Hán Việt
          </span>
        )}
      </h1>
      <p className={`pzp-goal${proven ? ' is-proven' : ''}`}>
        <Icon name="target" size={15} />
        <span className="pzp-goal-text">
          <span className="pzp-goal-long">
            Đỏ đi trước — <b>{goalText}</b>
          </span>
          {/* Điện thoại rất hẹp: bỏ "Đỏ đi trước" để mục tiêu không bị cắt */}
          <b className="pzp-goal-short">{proven ? `Chiếu hết trong ${mateIn} nước` : 'Tìm cách thắng'}</b>
        </span>
      </p>
      <button
        type="button"
        className="btn btn-quiet btn-icon pzp-nav pzp-next"
        onClick={() => goTo(nextId)}
        disabled={!nextId}
        aria-label="Thế sau"
        title={nextId ? `Thế sau (Thế ${codeOf(nextId)})` : 'Đây là thế cuối cùng'}
      >
        <Icon name="chevron-right" size={20} />
      </button>
    </header>
  );

  const loginLink = (
    <Link to="/login" state={{ from: location.pathname }}>
      Đăng nhập
    </Link>
  );

  /** Dòng lưu kết quả (dưới ô trạng thái và trong hộp thoại) */
  const saveLine = (inModal: boolean): ReactNode => {
    if (!result) return null;
    if (save.kind === 'saving')
      return (
        <div className="save-status pzp-save" role="status">
          <span className="spinner spinner-sm" aria-hidden="true" />
          <span>Đang lưu kết quả…</span>
        </div>
      );
    if (save.kind === 'saved')
      return (
        <div className="save-status ok pzp-save" role="status">
          <Icon name="check" size={16} />
          <span>
            {save.res.solved ? (inModal ? 'Đã lưu vào tiến độ của bạn' : 'Đã lưu tiến độ') : 'Đã ghi nhận lần thử'}
            {save.res.solved && save.res.progress.bestMoves ? ` · tốt nhất ${save.res.progress.bestMoves} nước` : ''}
            {!save.res.solved && ` · tổng ${save.res.progress.attempts} lần thử`}
          </span>
        </div>
      );
    if (save.kind === 'error')
      return (
        <div className="save-status error pzp-save" role="alert">
          <Icon name="alert" size={16} />
          <span>Chưa lưu được kết quả ({save.message}).</span>
          <button type="button" className="link-btn" onClick={() => void persist(savedMovesRef.current, won)}>
            Thử lại
          </button>
        </div>
      );
    if (save.kind === 'guest')
      return (
        <div className="save-status pzp-save pzp-guest" role="status">
          <Icon name="info" size={16} />
          <span>
            Đã ghi nhớ trên trình duyệt này. {loginLink} để chuyển kết quả{inModal ? ' vào tài khoản của bạn' : ' vào tài khoản'}.
          </span>
        </div>
      );
    if (!meId && !won && inModal)
      return (
        <div className="save-status pzp-save pzp-guest">
          <Icon name="info" size={16} />
          <span>{loginLink} để lưu các thế bạn giải vào tài khoản.</span>
        </div>
      );
    return null;
  };

  // ---- Thanh thao tác
  const toolbar = viewing ? (
    <div className="actions pzp-sol-actions" role="group" aria-label="Điều khiển lời giải">
      <button type="button" className="btn btn-ghost btn-sm act pzp-step" onClick={() => step(0)} disabled={solStep === 0} aria-label="Về thế ban đầu" title="Về thế ban đầu (Home)">
        <Icon name="chevron-first" size={18} />
        <span className="act-label">Đầu</span>
      </button>
      <button type="button" className="btn btn-ghost btn-sm act pzp-step" onClick={() => step((solStep ?? 0) - 1)} disabled={solStep === 0} aria-label="Lùi một nước" title="Lùi một nước (←)">
        <Icon name="chevron-left" size={18} />
        <span className="act-label">Lùi</span>
      </button>
      <button type="button" className="btn btn-primary btn-sm act pzp-step pzp-step-next" onClick={() => step((solStep ?? 0) + 1)} disabled={solStep === solLen} aria-label="Tiến một nước" title="Tiến một nước (→)">
        <Icon name="chevron-right" size={18} />
        <span className="act-label">Tiến</span>
      </button>
      <button type="button" className="btn btn-ghost btn-sm act pzp-step" onClick={() => step(solLen)} disabled={solStep === solLen} aria-label="Tới nước chiếu hết" title="Tới nước chiếu hết (End)">
        <Icon name="chevron-last" size={18} />
        <span className="act-label">Cuối</span>
      </button>
      <button type="button" className="btn btn-soft btn-sm act pzp-sol-exit" onClick={() => setSolStep(null)}>
        <Icon name="close" size={18} />
        <span className="act-label">
          Đóng<span className="act-more"> lời giải</span>
        </span>
      </button>
    </div>
  ) : (
    <div className="actions">
      {!result && (
        <button
          type="button"
          className="btn btn-sm act act-hint"
          onClick={askHint}
          disabled={hintBusy || thinking || turn !== RED}
          aria-label="Gợi ý nước đi"
          aria-busy={hintBusy}
          title={proven ? 'Gợi ý nước tiếp theo' : 'Máy gợi ý một nước (thế chưa kiểm chứng)'}
        >
          {hintBusy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="bulb" size={18} />}
          <span className="act-label">{hintBusy ? 'Đang tính…' : 'Gợi ý'}</span>
        </button>
      )}
      {won && (
        <button type="button" className="btn btn-primary btn-sm act" onClick={() => (nextId ? goTo(nextId) : navigate('/co-the'))}>
          <Icon name={nextId ? 'arrow-right' : 'grid'} size={18} />
          <span className="act-label">{nextId ? 'Thế tiếp theo' : 'Danh sách'}</span>
        </button>
      )}
      <button
        type="button"
        className={`btn ${result && !won ? 'btn-primary' : 'btn-ghost'} btn-sm act`}
        onClick={restart}
        disabled={!result && plies === 0}
        title="Bắt đầu lại từ thế ban đầu"
      >
        <Icon name="restart" size={18} />
        <span className="act-label">Làm lại</span>
      </button>
      {proven && (
        <button type="button" className="btn btn-ghost btn-sm act pzp-sol-btn" onClick={openSolution} aria-label="Xem lời giải" title="Xem lời giải từng nước">
          <Icon name="eye" size={18} />
          <span className="act-label">Lời giải</span>
        </button>
      )}
    </div>
  );

  const counter = !viewing && (
    <span className="pzp-counter" title={proven ? `Số nước của bạn / số nước chiếu hết đã kiểm chứng` : 'Số nước của bạn'}>
      <b className="num">{redMoves}</b>
      {proven && <span className="num">/{mateIn}</span>}
      <small>nước</small>
    </span>
  );

  const statusBox = (
    <>
      <div className={`status-card tone-${status.tone} pzp-status`} role="status" aria-live="polite">
        <span className="status-icon" aria-hidden="true">
          {status.tone === 'think' ? (
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          ) : status.icon ? (
            <Icon name={status.icon} size={20} />
          ) : (
            <span className="live-dot" />
          )}
        </span>
        <div className="status-text" key={`${status.tone}:${status.title}`}>
          <div className="status-title">{status.title}</div>
          {status.sub && <div className="status-sub">{status.sub}</div>}
        </div>
        {counter && <div className="status-extra">{counter}</div>}
      </div>
      {!viewing && saveLine(false)}
    </>
  );

  // ---- Hộp thoại kết quả
  const resultModal = result && (
    <Modal
      open={showResult}
      title={won ? 'Giải được rồi!' : drawn ? 'Hoà — chưa giải được' : 'Chưa giải được'}
      icon={won ? 'trophy' : drawn ? 'draw' : 'flag'}
      tone={won ? 'gold' : drawn ? 'warn' : 'danger'}
      onClose={() => setShowResult(false)}
      actions={
        won ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={restart}>
              <Icon name="restart" size={18} />
              Làm lại
            </button>
            {nextId ? (
              <button type="button" className="btn btn-primary" onClick={() => goTo(nextId)}>
                Thế tiếp theo
                <Icon name="arrow-right" size={18} />
              </button>
            ) : (
              <Link to="/co-the" className="btn btn-primary">
                <Icon name="grid" size={18} />
                Về danh sách
              </Link>
            )}
          </>
        ) : (
          <>
            {proven ? (
              <button type="button" className="btn btn-ghost" onClick={openSolution}>
                <Icon name="eye" size={18} />
                Xem lời giải
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={() => setShowResult(false)}>
                Đóng
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={restart}>
              <Icon name="restart" size={18} />
              Làm lại
            </button>
          </>
        )
      }
    >
      <div className="result-details pzp-result">
        <p className="result-reason">
          <Icon name="info" size={16} />
          {endText(result)}
        </p>
        {won ? (
          <>
            <div className="pzp-stat">
              <span className="pzp-stat-num num">{redMoves}</span>
              <span className="pzp-stat-label">nước của bạn</span>
            </div>
            <p className="result-note">
              {!proven
                ? 'Thế này máy chưa kiểm chứng được — bạn đã tự tìm ra cách thắng.'
                : redMoves === mateIn
                  ? `Bằng lời giải đã kiểm chứng (${mateIn} nước).`
                  : redMoves < mateIn
                    ? `Ít nước hơn lời giải đã kiểm chứng (${mateIn} nước).`
                    : `Lời giải đã kiểm chứng chỉ cần ${mateIn} nước — thử giải gọn hơn?`}
            </p>
            {(hintsUsed > 0 || sawSolution) && (
              <p className="pzp-usage">
                {[hintsUsed > 0 ? `Đã dùng ${hintsUsed} gợi ý` : '', sawSolution ? 'đã xem lời giải' : ''].filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        ) : drawn ? (
          <p className="result-note">
            Hoà chưa tính là giải được.
            {proven
              ? ' Đỏ thắng được thế này — hãy thử lại hoặc xem lời giải.'
              : ' Thế này máy chưa kiểm chứng được nên có thể không có cách thắng.'}
          </p>
        ) : (
          <p className="result-note">
            Mục tiêu là bạn (Đỏ) thắng, nhưng ván này Đỏ đã thua.
            {proven ? ' Hãy thử lại từ thế ban đầu hoặc xem lời giải.' : ' Hãy thử lại từ thế ban đầu.'}
          </p>
        )}
        {saveLine(true)}
      </div>
    </Modal>
  );

  return (
    <GameScreen
      game="xiangqi"
      className={`pzp${viewing ? ' pzp-viewing' : ''}`}
      ended={!!result && !viewing}
      head={head}
      top={bar(otherColor(bottom))}
      bottom={bar(bottom)}
      board={
        viewing ? (
          <GameBoard key="solution" engine={shown} version={solStep ?? 0} orientation={bottom} movable={null} lastMove={lastMoveOf(shown)} />
        ) : (
          <GameBoard
            key="play"
            engine={engine}
            version={ver}
            orientation={bottom}
            movable={result || thinking || turn !== RED ? null : RED}
            onMove={(m) => onHumanMove(m)}
            lastMove={lastMoveOf(engine)}
            hint={hint?.mark ?? null}
          />
        )
      }
      notices={notices}
      status={statusBox}
      toolbar={toolbar}
      onFlip={() => setFlip((f) => !f)}
      tabs={[
        viewing
          ? {
              id: 'moves',
              label: 'Lời giải',
              icon: 'eye',
              count: solLen,
              content: <MoveList moves={solInfos} current={solStep ?? 0} onSelect={(ply) => step(ply)} game="xiangqi" />,
            }
          : { id: 'moves', label: 'Nước đi', icon: 'list', count: plies, content: <MoveList moves={infos} game="xiangqi" /> },
      ]}
      sideFooter={
        <div className="pzp-foot">
          <p className="side-note">
            <Icon name="info" size={15} />
            {proven
              ? 'Bạn cầm Đỏ, máy cầm Đen và tự đỡ. Gợi ý dùng bao nhiêu lần cũng được.'
              : 'Thế chưa kiểm chứng: máy chưa chứng minh được Đỏ thắng được, nên có thể không có cách thắng.'}
          </p>
          <Link to="/co-the" className="pzp-all">
            <Icon name="grid" size={15} />
            Tất cả thế cờ
          </Link>
        </div>
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
      {resultModal}
    </GameScreen>
  );
}
