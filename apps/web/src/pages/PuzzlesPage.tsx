import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  PUZZLES,
  PUZZLE_COUNT,
  PUZZLE_LICENSE_TEXT,
  PUZZLE_SOURCE,
  getPuzzle,
  type PuzzleAttemptResultDto,
  type PuzzleDef,
  type PuzzleProgressDto,
  type PuzzleProgressResponse,
} from '@cotuong/shared';
import { ApiError, api, errorMessage } from '../api/http';
import { Icon } from '../components/icons';
import { EmptyState, Modal } from '../components/ui';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

// =========================================================================== Bàn cờ thu nhỏ

const THUMB_CELL = 10;
const THUMB_MARGIN = 6;
const THUMB_W = 8 * THUMB_CELL + 2 * THUMB_MARGIN;
const THUMB_H = 9 * THUMB_CELL + 2 * THUMB_MARGIN;
const tx = (file: number) => THUMB_MARGIN + file * THUMB_CELL;
const ty = (rank: number) => THUMB_MARGIN + (9 - rank) * THUMB_CELL;

/** Đường kẻ bàn cờ tướng (một path duy nhất, dùng chung cho mọi bàn thu nhỏ) */
const THUMB_GRID = (() => {
  let d = '';
  for (let r = 0; r <= 9; r++) d += `M${tx(0)} ${ty(r)}H${tx(8)}`;
  for (let f = 0; f <= 8; f++) {
    if (f === 0 || f === 8) d += `M${tx(f)} ${ty(9)}V${ty(0)}`;
    else d += `M${tx(f)} ${ty(9)}V${ty(5)}M${tx(f)} ${ty(4)}V${ty(0)}`;
  }
  // Cửu cung
  d += `M${tx(3)} ${ty(9)}L${tx(5)} ${ty(7)}M${tx(5)} ${ty(9)}L${tx(3)} ${ty(7)}`;
  d += `M${tx(3)} ${ty(2)}L${tx(5)} ${ty(0)}M${tx(5)} ${ty(2)}L${tx(3)} ${ty(0)}`;
  return d;
})();

/** Chữ trên quân, giống bàn cờ chính: [Đỏ, Đen] */
const GLYPH: Record<string, [string, string]> = {
  k: ['帥', '將'],
  a: ['仕', '士'],
  b: ['相', '象'],
  e: ['相', '象'],
  n: ['傌', '馬'],
  h: ['傌', '馬'],
  r: ['俥', '車'],
  c: ['炮', '砲'],
  p: ['兵', '卒'],
};

interface ThumbPiece {
  file: number;
  rank: number;
  red: boolean;
  glyph: string;
}

/** Đọc phần xếp quân của FEN cờ tướng (hàng 9 → 0, cột a → i) */
function parsePlacement(fen: string): ThumbPiece[] {
  const out: ThumbPiece[] = [];
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, i) => {
    const rank = 9 - i;
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '9') {
        file += Number(ch);
        continue;
      }
      const g = GLYPH[ch.toLowerCase()];
      if (g) {
        const red = ch !== ch.toLowerCase();
        out.push({ file, rank, red, glyph: red ? g[0] : g[1] });
      }
      file++;
    }
  });
  return out;
}

/** Bàn cờ thu nhỏ, tĩnh, vẽ từ FEN (SVG nhẹ: 1 path kẻ bàn + mỗi quân 1 vòng tròn và 1 chữ) */
export const PuzzleThumb = memo(function PuzzleThumb({ fen }: { fen: string }) {
  const pieces = useMemo(() => parsePlacement(fen), [fen]);
  return (
    <svg
      className="pz-thumb"
      viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect className="pz-thumb-wood" x="0.5" y="0.5" width={THUMB_W - 1} height={THUMB_H - 1} rx="3" />
      <path className="pz-thumb-grid" d={THUMB_GRID} />
      <rect className="pz-thumb-edge" x={tx(0)} y={ty(9)} width={8 * THUMB_CELL} height={9 * THUMB_CELL} />
      {pieces.map((p) => (
        <g key={`${p.file}${p.rank}`} className={p.red ? 'pz-pc red' : 'pz-pc black'} transform={`translate(${tx(p.file)} ${ty(p.rank)})`}>
          <circle r="4.55" />
          <text dominantBaseline="central">{p.glyph}</text>
        </g>
      ))}
    </svg>
  );
});

/** Giải thích "Chưa kiểm chứng" (rê chuột / trình đọc màn hình) — dùng chung cho danh sách và trang giải thế */
export const UNVERIFIED_TITLE =
  'Chưa kiểm chứng: máy chưa chứng minh được Đỏ thắng được thế này hay không (tài liệu gốc không ghi mục tiêu của từng thế).';

// =========================================================================== Tiến độ

type ProgressMap = Map<number, PuzzleProgressDto>;

/*
 * Khách giải thế (chưa đăng nhập): ghi vào trình duyệt
 *  - GUEST_KEY: danh sách số thế đã giải (để đánh dấu "Đã giải" khi chưa đăng nhập);
 *  - GUEST_MOVES_KEY: các nước Đỏ/Đen của lần giải (ngắn nhất) từng thế.
 * Sau khi đăng nhập, mở Cờ thế thì các lần giải có nước đi được GỬI LẠI lên máy chủ (POST /api/puzzles/:id/attempt) —
 * máy chủ tự đi lại các nước để xác nhận, nên tiến độ chuyển vào tài khoản mà không phải tin trình duyệt. Thế đã chuyển
 * xong thì xoá khỏi trình duyệt. Thế giải trước khi có GUEST_MOVES_KEY (không còn nước đi) không chuyển được: báo thật
 * cho người chơi và để họ ẩn ghi chú.
 */
const GUEST_KEY = 'cotuong.puzzles.solved';
const GUEST_MOVES_KEY = 'cotuong.puzzles.guestSolves';
/** Mỗi lần mở trang chuyển tối đa ngần này thế (máy chủ giới hạn 30 lần gửi / phút) */
const IMPORT_BATCH = 20;

export function readGuestSolved(): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GUEST_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
function writeGuestSolved(ids: number[]) {
  try {
    if (ids.length) localStorage.setItem(GUEST_KEY, JSON.stringify([...new Set(ids)].sort((a, b) => a - b)));
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* trình duyệt chặn localStorage: bỏ qua */
  }
}
function readGuestMoves(): Record<string, string[]> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GUEST_MOVES_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, moves] of Object.entries(v as Record<string, unknown>)) {
      if (/^\d{1,3}$/.test(k) && Array.isArray(moves) && moves.length > 0 && moves.every((m) => typeof m === 'string')) out[k] = moves;
    }
    return out;
  } catch {
    return {};
  }
}
function writeGuestMoves(map: Record<string, string[]>) {
  try {
    if (Object.keys(map).length) localStorage.setItem(GUEST_MOVES_KEY, JSON.stringify(map));
    else localStorage.removeItem(GUEST_MOVES_KEY);
  } catch {
    /* bỏ qua */
  }
}

/** Khách vừa giải được thế `id` bằng các nước `moves`: ghi nhớ (giữ lần giải ít nước nhất) */
export function addGuestSolve(id: number, moves: readonly string[]) {
  writeGuestSolved([...readGuestSolved(), id]);
  const map = readGuestMoves();
  const prev = map[id];
  if (!prev || prev.length > moves.length) {
    map[id] = [...moves];
    writeGuestMoves(map);
  }
}

/** Bỏ thế khỏi phần ghi nhớ của khách (đã chuyển vào tài khoản, hoặc người chơi ẩn ghi chú) */
function forgetGuest(ids: number[]) {
  const drop = new Set(ids);
  writeGuestSolved(readGuestSolved().filter((x) => !drop.has(x)));
  const map = readGuestMoves();
  for (const id of ids) delete map[id];
  writeGuestMoves(map);
}

/** Thế khách đã giải nhưng không còn nước đi (giải trước khi có tính năng chuyển) → không chuyển được */
export function legacyGuestSolved(): number[] {
  const map = readGuestMoves();
  return readGuestSolved().filter((id) => !map[id] && getPuzzle(id));
}
export function forgetLegacyGuestSolved() {
  forgetGuest(legacyGuestSolved());
}

export interface GuestImportResult {
  /** Số thế vừa chuyển vào tài khoản (máy chủ xác nhận đã giải) */
  imported: number;
  /** Số thế còn chờ chuyển (lỗi mạng / gửi quá nhiều) — lần sau mở trang sẽ thử lại */
  pending: number;
}

let importing: Promise<GuestImportResult> | null = null;
/** Đã đăng nhập: gửi lại các lần giải của khách lên máy chủ (một lượt chạy tại một thời điểm) */
export function importGuestSolves(): Promise<GuestImportResult> {
  importing ??= runImport().finally(() => {
    importing = null;
  });
  return importing;
}
async function runImport(): Promise<GuestImportResult> {
  const map = readGuestMoves();
  const ids = Object.keys(map)
    .map(Number)
    .filter((id) => getPuzzle(id));
  let imported = 0;
  for (const id of ids.slice(0, IMPORT_BATCH)) {
    try {
      const res = await api.post<PuzzleAttemptResultDto>(`/api/puzzles/${id}/attempt`, { moves: map[id] });
      if (res.solved) imported++;
      // Máy chủ đã xét lần giải này (được hay không) → không giữ ở trình duyệt nữa
      forgetGuest([id]);
    } catch (e) {
      // Dữ liệu hỏng (máy chủ không nhận các nước này): bỏ; lỗi khác (mạng, gửi quá nhiều, hết phiên): để lần sau
      if (e instanceof ApiError && (e.status === 400 || e.status === 404)) forgetGuest([id]);
      else break;
    }
  }
  // Thế lỗi thời (không còn trong danh sách) cũng bỏ
  forgetGuest(Object.keys(readGuestMoves()).map(Number).filter((id) => !getPuzzle(id)));
  return { imported, pending: Object.keys(readGuestMoves()).length };
}

function guestProgress(): ProgressMap {
  const map: ProgressMap = new Map();
  for (const id of readGuestSolved()) map.set(id, { puzzleId: id, attempts: 1, solvedAt: 'local', bestMoves: null });
  return map;
}

/**
 * Người đăng nhập: tiến độ trên server (trước đó chuyển các thế đã giải khi chưa đăng nhập vào tài khoản);
 * khách (enabled = false): tiến độ trong trình duyệt
 */
function useProgress(enabled: boolean, authLoading: boolean) {
  const toast = useToast();
  const [data, setData] = useState<ProgressMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (authLoading) {
      setData(null);
      return;
    }
    if (!enabled) {
      setData(guestProgress());
      setError(null);
      return;
    }
    setData(null);
    let alive = true;
    setError(null);
    (async () => {
      const imp = await importGuestSolves().catch(() => null);
      if (alive && imp) {
        setPending(imp.pending);
        if (imp.imported > 0) toast(`Đã chuyển ${imp.imported} thế bạn giải khi chưa đăng nhập vào tài khoản.`, 'success');
      }
      const r = await api.get<PuzzleProgressResponse>('/api/puzzles/progress');
      if (alive) setData(new Map(r.items.map((it) => [it.puzzleId, it])));
    })().catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [enabled, authLoading, nonce, toast]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, retry, pending };
}

// =========================================================================== Tìm kiếm & lọc

type Filter = 'all' | 'todo' | 'done';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Tất cả'],
  ['todo', 'Chưa giải'],
  ['done', 'Đã giải'],
];
/** Giá trị trên URL (?loc=...) để quay lại danh sách vẫn giữ bộ lọc */
const FILTER_PARAM: Record<Filter, string | null> = { all: null, todo: 'chua-giai', done: 'da-giai' };

function readFilter(v: string | null): Filter {
  return v === 'chua-giai' ? 'todo' : v === 'da-giai' ? 'done' : 'all';
}

/** Bỏ dấu tiếng Việt, chữ thường — để tìm "khi thon" ra "Khí thôn" */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();
}

const SEARCH_INDEX = PUZZLES.map((p) => ({ id: p.id, text: `${fold(p.viet ?? '')} ${p.han}` }));

function matchIds(query: string): Set<number> | null {
  const q = fold(query).trim().replace(/\s+/g, ' ');
  if (!q) return null;
  // "12", "#12", "012", "thế 12", "the 12"
  const num = /^(?:#|so |the )?\s*0*(\d{1,3})$/.exec(q);
  const ids = new Set<number>();
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= PUZZLE_COUNT) ids.add(n);
  }
  for (const it of SEARCH_INDEX) if (it.text.includes(q)) ids.add(it.id);
  return ids;
}

// =========================================================================== Thẻ thế cờ

function PuzzleCard({ p, progress }: { p: PuzzleDef; progress: PuzzleProgressDto | undefined }) {
  const solved = !!progress?.solvedAt;
  const tried = !solved && !!progress && progress.attempts > 0;
  return (
    <li className="pz-item">
      <Link to={`/co-the/${p.id}`} className={`pz-card${solved ? ' is-solved' : ''}`}>
        <span className="pz-thumb-box">
          <PuzzleThumb fen={p.fen} />
          {solved && (
            <span className="pz-solved-badge" title="Đã giải">
              <Icon name="check" size={14} strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="pz-card-body">
          <span className="pz-num num">Thế {p.code}</span>
          <span className="pz-han" lang="zh-Hans">
            {p.han}
          </span>
          {p.viet ? <span className="pz-viet">{p.viet}</span> : <span className="pz-viet is-missing">Chưa có tên Hán Việt</span>}
          <span className="pz-meta">
            {p.mateIn ? (
              <span className="pz-tag pz-tag-mate">Chiếu hết trong {p.mateIn} nước</span>
            ) : (
              <span className="pz-tag" title={UNVERIFIED_TITLE}>
                Chưa kiểm chứng
              </span>
            )}
          </span>
          {solved ? (
            <span className="pz-status pz-status-ok">
              <Icon name="check" size={14} strokeWidth={2.6} />
              Đã giải{progress?.bestMoves ? ` · ${progress.bestMoves} nước` : ''}
            </span>
          ) : tried ? (
            <span className="pz-status">Đã thử {progress!.attempts} lần</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

// =========================================================================== Đầu trang

/** Ghi chú dưới thẻ tiến độ (đã đăng nhập): thế giải khi chưa đăng nhập chưa chuyển được vào tài khoản */
function GuestCarryNote({ pending }: { pending: number }) {
  const [legacy, setLegacy] = useState(() => legacyGuestSolved().length);
  if (pending > 0) {
    return (
      <p className="pz-progress-note pz-carry">
        <Icon name="info" size={15} />
        <span>Còn {pending} thế bạn giải khi chưa đăng nhập chưa chuyển được vào tài khoản. Lần sau mở trang này sẽ tự thử lại.</span>
      </p>
    );
  }
  if (legacy === 0) return null;
  return (
    <p className="pz-progress-note pz-carry">
      <Icon name="info" size={15} />
      <span>
        {legacy} thế bạn từng giải trên trình duyệt này khi chưa đăng nhập không chuyển được vào tài khoản (trình duyệt không lưu lại
        các nước đã đi). Hãy giải lại để lưu.{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            forgetLegacyGuestSolved();
            setLegacy(0);
          }}
        >
          Đã hiểu, ẩn ghi chú
        </button>
      </span>
    </p>
  );
}

function ProgressCard({
  loggedIn,
  authLoading,
  progress,
  error,
  onRetry,
  pending,
}: {
  loggedIn: boolean;
  authLoading: boolean;
  progress: ProgressMap | null;
  error: string | null;
  onRetry: () => void;
  /** Đã đăng nhập: số thế giải khi chưa đăng nhập còn chờ chuyển vào tài khoản */
  pending: number;
}) {
  if (authLoading || (loggedIn && !progress && !error)) {
    return (
      <div className="pz-progress" aria-busy="true">
        <span className="skeleton pz-s-line" />
        <span className="skeleton pz-s-bar" />
        <span className="skeleton pz-s-line short" />
      </div>
    );
  }
  if (!loggedIn) {
    return (
      <div className="pz-progress pz-progress-guest">
        <div className="pz-progress-title">
          <Icon name="target" size={18} />
          Lưu tiến độ giải thế
        </div>
        <p className="pz-progress-note">
          {progress && progress.size > 0
            ? `Bạn đã giải ${progress.size} thế — hiện chỉ ghi nhớ trên trình duyệt này. Đăng nhập để chuyển các thế đã giải vào tài khoản và lưu tiến độ về sau.`
            : 'Đăng nhập để lưu các thế bạn giải và số nước giải ít nhất vào tài khoản, xem được trên mọi máy.'}
        </p>
        <div className="pz-progress-actions">
          {/* URL hiện tại (có bộ lọc) — đọc từ window vì bộ lọc được ghi bằng replaceState */}
          <Link to="/login" state={{ from: window.location.pathname + window.location.search }} className="btn btn-primary btn-sm">
            <Icon name="login" size={16} />
            Đăng nhập
          </Link>
          <Link to="/register" state={{ from: window.location.pathname + window.location.search }} className="btn btn-ghost btn-sm">
            Đăng ký
          </Link>
        </div>
      </div>
    );
  }
  if (error || !progress) {
    return (
      <div className="pz-progress pz-progress-error" role="alert">
        <div className="pz-progress-title">
          <Icon name="alert" size={18} />
          Không tải được tiến độ
        </div>
        <p className="pz-progress-note">{error}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          <Icon name="restart" size={16} />
          Thử lại
        </button>
      </div>
    );
  }
  const solved = PUZZLES.filter((p) => progress.get(p.id)?.solvedAt).length;
  const pct = Math.round((solved / PUZZLE_COUNT) * 100);
  const next = PUZZLES.find((p) => !progress.get(p.id)?.solvedAt);
  return (
    <div className="pz-progress">
      <div className="pz-progress-head">
        <span className="pz-progress-label">Đã giải</span>
        <span className="pz-progress-count num">
          <b>{solved}</b>/{PUZZLE_COUNT}
        </span>
      </div>
      <div
        className="pz-bar"
        role="progressbar"
        aria-label={`Đã giải ${solved}/${PUZZLE_COUNT}`}
        aria-valuemin={0}
        aria-valuemax={PUZZLE_COUNT}
        aria-valuenow={solved}
      >
        <span className="pz-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {next ? (
        <Link to={`/co-the/${next.id}`} className="btn btn-soft btn-sm btn-block pz-next">
          {solved ? 'Giải tiếp' : 'Bắt đầu'}: Thế {next.code}
          <Icon name="arrow-right" size={16} />
        </Link>
      ) : (
        <p className="pz-progress-note pz-done">
          <Icon name="trophy" size={16} /> Bạn đã giải hết {PUZZLE_COUNT} thế!
        </p>
      )}
      <GuestCarryNote pending={pending} />
    </div>
  );
}

// =========================================================================== Nguồn

/**
 * Giấy phép chia theo đoạn để đọc dễ trên điện thoại: đoạn văn dài (bản gốc ngắt dòng cứng ~80 cột) được nối lại
 * thành một dòng; đoạn gồm các dòng ngắn (tiêu đề, dòng bản quyền) giữ nguyên xuống dòng. Chỉ đổi khoảng trắng.
 */
const LICENSE_PARAGRAPHS = PUZZLE_LICENSE_TEXT.split(/\n\s*\n/).map((para) => {
  const lines = para.split('\n').map((l) => l.trim());
  return lines.some((l) => l.length > 60) ? [lines.join(' ')] : lines;
});

/** Thế có ghi chú "cần duyệt" trong tài liệu tên Hán Việt */
const NEEDS_REVIEW = PUZZLES.filter((p) => p.note && /duyệt/i.test(p.note)).map((p) => p.id);
const STARRED = PUZZLES.filter((p) => p.star).map((p) => p.id);

function SourceSection({ provenCount }: { provenCount: number }) {
  const location = useLocation();
  const [licenseOpen, setLicenseOpen] = useState(() => location.hash === '#giay-phep');
  const list = (ids: number[]) => ids.join(', ');
  return (
    <section className="panel pz-source" id="nguon" aria-labelledby="pz-source-title">
      <h2 className="panel-title pz-source-title" id="pz-source-title">
        <Icon name="info" size={20} />
        Nguồn
      </h2>
      <div className="pz-source-grid">
        <div className="pz-source-text">
          <p>
            Thế cờ (vị trí quân, tên chữ Hán) là {PUZZLE_SOURCE.used} thế đầu trong tệp <code>{PUZZLE_SOURCE.file}</code> của kho{' '}
            <a href={PUZZLE_SOURCE.repository} target="_blank" rel="noopener noreferrer">
              xiangqi-tools
              <Icon name="external" size={13} className="pz-ext" />
            </a>{' '}
            ({PUZZLE_SOURCE.copyright.replace('Copyright (c) ', '© ')}), phát hành theo giấy phép {PUZZLE_SOURCE.licenseName}.
          </p>
          <p>
            Tên Hán Việt (thế 1–{PUZZLE_SOURCE.namedCount}) là phiên âm theo tài liệu “{PUZZLE_SOURCE.namesDocument}”,{' '}
            <b>chưa được duyệt chính thức</b>; thế {PUZZLE_SOURCE.namedCount + 1}–{PUZZLE_SOURCE.used} chưa có tên Hán Việt. Tài liệu ghi
            cần duyệt kỹ thêm ở các thế {list(NEEDS_REVIEW)}. Nguồn đánh dấu “*” ở các thế {list(STARRED)} mà không giải thích ý nghĩa.
          </p>
          <p>
            “Chiếu hết trong N nước” chỉ ghi ở {provenCount} thế mà máy đã chứng minh: Đỏ chiếu liên tục và chiếu hết được trong N nước dù
            Đen đỡ thế nào. Thế ghi “Chưa kiểm chứng” là máy chưa chứng minh được — dữ liệu gốc không ghi mục tiêu của từng thế.
          </p>
        </div>
        <dl className="pz-facts">
          <div>
            <dt>Tuyển tập</dt>
            <dd>
              <span lang="zh-Hans">{PUZZLE_SOURCE.collection}</span> · {PUZZLE_SOURCE.collectionVi}
            </dd>
          </div>
          <div>
            <dt>Bản (ghi trong tệp)</dt>
            <dd lang="zh-Hans">{PUZZLE_SOURCE.edition}</dd>
          </div>
          <div>
            <dt>Bản quyền dữ liệu</dt>
            <dd>{PUZZLE_SOURCE.copyright}</dd>
          </div>
          <div>
            <dt>Giấy phép</dt>
            <dd>
              {PUZZLE_SOURCE.licenseName}{' '}
              <a
                href="#giay-phep"
                className="pz-license-link"
                onClick={(e) => {
                  e.preventDefault();
                  setLicenseOpen(true);
                }}
              >
                Xem toàn văn
              </a>
            </dd>
          </div>
        </dl>
      </div>
      <Modal open={licenseOpen} title={PUZZLE_SOURCE.licenseName} icon="lock" tone="gold" onClose={() => setLicenseOpen(false)}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setLicenseOpen(false)}>
            Đóng
          </button>
        }
      >
        <p className="pz-license-intro">
          Áp dụng cho dữ liệu thế cờ lấy từ{' '}
          <a href={PUZZLE_SOURCE.repository} target="_blank" rel="noopener noreferrer">
            xiangqi-tools
          </a>{' '}
          ({PUZZLE_SOURCE.file}).
        </p>
        <div className="pz-license" id="giay-phep" tabIndex={0} role="document" aria-label="Toàn văn giấy phép">
          {LICENSE_PARAGRAPHS.map((lines, i) => (
            <p key={i}>
              {lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {l}
                </span>
              ))}
            </p>
          ))}
        </div>
      </Modal>
    </section>
  );
}

// =========================================================================== Trang

/**
 * Bộ lọc + ô tìm kiếm, phản chiếu lên URL (?loc=…&q=…) để bấm Quay lại từ một thế vẫn giữ nguyên danh sách.
 * Ghi URL bằng history.replaceState (giữ nguyên history.state của router) thay vì điều hướng của router: không tạo
 * mục lịch sử, và không làm Layout cuộn về đầu trang khi đang gõ / đổi bộ lọc. Khi router thật sự điều hướng tới
 * trang (menu "Cờ thế", Quay lại / Tiến tới) thì đọc lại từ URL.
 */
function useListState() {
  const location = useLocation();
  const [filter, setFilter] = useState<Filter>(() => readFilter(new URLSearchParams(location.search).get('loc')));
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get('q') ?? '');

  const seenKey = useRef(location.key);
  useEffect(() => {
    if (location.key === seenKey.current) return;
    seenKey.current = location.key;
    const sp = new URLSearchParams(location.search);
    setFilter(readFilter(sp.get('loc')));
    setQuery(sp.get('q') ?? '');
  }, [location.key, location.search]);

  const pathname = location.pathname;
  useEffect(() => {
    const write = () => {
      // Đã sang trang khác (router đổi URL trước khi trang này kịp gỡ) → không ghi đè URL của trang mới
      if (window.location.pathname !== pathname) return;
      const url = new URL(window.location.href);
      const loc = FILTER_PARAM[filter];
      if (loc) url.searchParams.set('loc', loc);
      else url.searchParams.delete('loc');
      const q = query.trim();
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    };
    const t = setTimeout(write, 250);
    return () => clearTimeout(t);
  }, [filter, query, pathname]);

  return { filter, setFilter, query, setQuery };
}

export function PuzzlesPage() {
  const { me, loading: authLoading } = useAuth();
  const loggedIn = !!me;
  const { data: progress, error, retry, pending } = useProgress(loggedIn, authLoading);
  const { filter, setFilter, query, setQuery } = useListState();
  const deferredQuery = useDeferredValue(query);

  const provenCount = useMemo(() => PUZZLES.filter((p) => p.mateIn).length, []);
  const solvedCount = progress ? PUZZLES.filter((p) => progress.get(p.id)?.solvedAt).length : 0;
  const counts: Record<Filter, number | null> = progress
    ? { all: PUZZLE_COUNT, todo: PUZZLE_COUNT - solvedCount, done: solvedCount }
    : { all: PUZZLE_COUNT, todo: null, done: null };

  const visible = useMemo(() => {
    const ids = matchIds(deferredQuery);
    return PUZZLES.filter((p) => {
      if (ids && !ids.has(p.id)) return false;
      if (filter === 'all') return true;
      if (!progress) return false;
      const solved = !!progress.get(p.id)?.solvedAt;
      return filter === 'done' ? solved : !solved;
    });
  }, [deferredQuery, filter, progress]);

  const searching = deferredQuery.trim().length > 0;
  const needsLogin = filter !== 'all' && !loggedIn && !authLoading && !progress;
  const waitingProgress = filter !== 'all' && loggedIn && !progress && !error;

  let empty: ReactNode = null;
  if (needsLogin) {
    empty = (
      <EmptyState icon="lock">
        <div>Đăng nhập để lọc các thế {filter === 'done' ? 'đã giải' : 'chưa giải'} của bạn.</div>
        <Link to="/login" state={{ from: '/co-the' }} className="btn btn-primary btn-sm pz-empty-btn">
          Đăng nhập
        </Link>
      </EmptyState>
    );
  } else if (!waitingProgress && visible.length === 0) {
    empty = searching ? (
      <EmptyState icon="search">
        <div>Không có thế nào khớp “{deferredQuery.trim()}”.</div>
        <button type="button" className="btn btn-ghost btn-sm pz-empty-btn" onClick={() => setQuery('')}>
          Xoá tìm kiếm
        </button>
      </EmptyState>
    ) : filter === 'done' ? (
      <EmptyState icon="puzzle">
        <div>Bạn chưa giải thế nào — hãy bắt đầu với Thế 001.</div>
        <Link to="/co-the/1" className="btn btn-primary btn-sm pz-empty-btn">
          Giải Thế 001
        </Link>
      </EmptyState>
    ) : (
      <EmptyState icon="trophy">Bạn đã giải hết các thế!</EmptyState>
    );
  }

  return (
    <div className="pz-page">
      <header className="pz-hero">
        <div className="pz-hero-text">
          <span className="pz-kicker">
            <Icon name="puzzle" size={16} />
            Cờ thế cổ điển
          </span>
          <h1 className="page-title pz-title">
            Cờ thế <span className="pz-title-sep">·</span> <span className="pz-title-name">Thích tình nhã thú</span>
          </h1>
          <p className="pz-lead">
            {PUZZLE_COUNT} thế cờ tướng chọn từ tuyển tập <span lang="zh-Hans">{PUZZLE_SOURCE.collection}</span>. Ở mọi thế, Đỏ đi trước;{' '}
            {provenCount} thế đã được máy kiểm chứng số nước chiếu hết.
          </p>
        </div>
        <span className="pz-hero-art" lang="zh-Hans" aria-hidden="true">
          {PUZZLE_SOURCE.collection}
        </span>
        <ProgressCard loggedIn={loggedIn} authLoading={authLoading} progress={progress} error={error} onRetry={retry} pending={pending} />
      </header>

      <div className="pz-toolbar">
        <div className="seg pz-filter" role="radiogroup" aria-label="Lọc theo trạng thái">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {label}
              {counts[f] !== null && <span className="pz-count num">{counts[f]}</span>}
            </button>
          ))}
        </div>
        <label className="pz-search">
          <Icon name="search" size={18} />
          <span className="sr-only">Tìm thế cờ</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm theo số hoặc tên thế…"
            autoComplete="off"
            enterKeyHint="search"
          />
          {query && (
            <button type="button" className="pz-search-clear" onClick={() => setQuery('')} aria-label="Xoá tìm kiếm">
              <Icon name="close" size={16} />
            </button>
          )}
        </label>
      </div>
      <p className="sr-only" aria-live="polite">
        {waitingProgress ? 'Đang tải tiến độ' : `Hiển thị ${visible.length} thế`}
      </p>

      {waitingProgress ? (
        <ul className="pz-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="pz-item">
              <div className="pz-card pz-card-skel">
                <span className="skeleton pz-s-thumb" />
                <span className="skeleton pz-s-line" />
                <span className="skeleton pz-s-line short" />
              </div>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <div className="panel pz-empty">{empty}</div>
      ) : (
        <>
          {(searching || filter !== 'all') && (
            <p className="pz-result-count muted small">
              {visible.length} thế{searching ? ` khớp “${deferredQuery.trim()}”` : ''}
            </p>
          )}
          <ul className="pz-grid" aria-label="Danh sách thế cờ">
            {visible.map((p) => (
              <PuzzleCard key={p.id} p={p} progress={progress?.get(p.id)} />
            ))}
          </ul>
        </>
      )}

      <SourceSection provenCount={provenCount} />
    </div>
  );
}
