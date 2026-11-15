import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { BoardPiece, Color, GameEngine } from '@cotuong/game-core';

export interface MoveMark {
  from: string;
  to: string;
}

export interface BoardProps {
  engine: GameEngine;
  /** Tăng mỗi khi thế cờ đổi (engine là đối tượng thay đổi tại chỗ) */
  version: number;
  /** Bên ở phía dưới bàn cờ */
  orientation: Color;
  /** Bên người dùng được đi (null = chỉ xem) */
  movable: Color | null;
  onMove?: (move: string) => void;
  lastMove?: MoveMark | null;
  hint?: MoveMark | null;
}

const XQ_CHARS: Record<string, [string, string]> = {
  k: ['帥', '將'],
  a: ['仕', '士'],
  e: ['相', '象'],
  h: ['傌', '馬'],
  r: ['俥', '車'],
  c: ['炮', '砲'],
  p: ['兵', '卒'],
};
const XQ_NAMES: Record<string, string> = { k: 'Tướng', a: 'Sĩ', e: 'Tượng', h: 'Mã', r: 'Xe', c: 'Pháo', p: 'Tốt' };
const CHESS_NAMES: Record<string, string> = { k: 'Vua', q: 'Hậu', r: 'Xe', b: 'Tượng', n: 'Mã', p: 'Tốt' };
const SIDE_NAMES = { xiangqi: ['đỏ', 'đen'], chess: ['trắng', 'đen'] } as const;

const cls = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** id duy nhất cho gradient / clipPath của từng bàn cờ (có thể có nhiều bàn trên một trang) */
function useSvgId(prefix: string): string {
  return prefix + useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Một điểm dừng gradient lấy màu từ biến CSS (để đổi theo giao diện sáng / tối) */
function Stop({ at, c, o }: { at: number; c: string; o?: number }) {
  return <stop offset={at} style={{ stopColor: c, stopOpacity: o }} />;
}

/** Vân gỗ: ảnh SVG nhiễu (feTurbulence) — trình duyệt vẽ một lần rồi lưu đệm như ảnh thường, nên rất nhẹ */
function grainUri(w: number, h: number, fx: number, fy: number, seed: number, gain: number, bias: number): string {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<filter id="g" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${fx} ${fy}" numOctaves="4" seed="${seed}"/>` +
        `<feColorMatrix values="0 0 0 0 .3 0 0 0 0 .16 0 0 0 0 .05 ${gain} 0 0 0 ${bias}"/>` +
        `</filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`,
    )
  );
}

// --------------------------------------------------------------------------- Chọn quân, phong cấp

function useSelection(engine: GameEngine, version: number, movable: Color | null, onMove?: (m: string) => void) {
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<MoveMark | null>(null);

  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [version, movable]);

  const canMove = movable !== null && !!onMove && engine.turn() === movable && !engine.status().over;
  const targets = useMemo(() => {
    if (!selected || !canMove) return new Set<string>();
    return new Set(engine.legalMovesFrom(selected).map((m) => m.slice(2, 4)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, version, canMove]);

  const click = (sq: string) => {
    if (!canMove) {
      setSelected(null);
      return;
    }
    if (selected && targets.has(sq)) {
      if (engine.isPromotion(selected, sq)) {
        setPromo({ from: selected, to: sq });
        return;
      }
      onMove!(selected + sq);
      setSelected(null);
      return;
    }
    const piece = engine.pieceAt(sq);
    if (piece && piece.color === movable) {
      setSelected(sq === selected ? null : sq);
      return;
    }
    setSelected(null);
  };

  const choosePromo = (letter: string) => {
    if (promo) onMove!(promo.from + promo.to + letter);
    setPromo(null);
    setSelected(null);
  };

  return {
    selected,
    targets,
    click,
    promo,
    choosePromo,
    cancelPromo: () => setPromo(null),
    deselect: () => setSelected(null),
    canMove,
  };
}

function checkedKing(engine: GameEngine): string | null {
  return engine.inCheck() ? engine.kingSquare(engine.turn()) : null;
}

/**
 * Nước vừa đi để chạy hiệu ứng "quân trượt tới". Chỉ khi ván tiến thêm đúng một nước
 * (không chạy khi mới mở bàn, khi lùi trong xem lại hay khi tải lại cả ván).
 */
interface Arrival extends MoveMark {
  /** Khoá duy nhất cho mỗi lần chuyển thế cờ (để hiệu ứng chạy lại, kể cả khi xem lại tới lui) */
  id: number;
  version: number;
  /** Thế cờ đã hiển thị trước đó (lần commit thứ mấy) — tránh phát hiện trùng khi React render 2 lần */
  basedOn: number;
  /** Quân bị ăn ở ô đến (để làm mờ dần) */
  captured: BoardPiece | null;
  /** Cờ úp: quân vừa đi trước đó đang úp (giờ đã lật) → hiệu ứng lật quân */
  revealed: boolean;
}

function useArrival(engine: GameEngine, version: number, pieces: BoardPiece[], lastMove?: MoveMark | null): Arrival | null {
  const plies = engine.history().length;
  const prev = useRef<{ version: number; plies: number; pieces: BoardPiece[]; n: number } | null>(null);
  const anim = useRef<Arrival | null>(null);
  const seq = useRef(0);
  const p = prev.current;
  if (p && version !== p.version && plies === p.plies + 1 && lastMove && anim.current?.basedOn !== p.n) {
    const captured = p.pieces.find((x) => x.square === lastMove.to) ?? null;
    const revealed = !!p.pieces.find((x) => x.square === lastMove.from)?.hidden;
    anim.current = { ...lastMove, id: ++seq.current, version, basedOn: p.n, captured, revealed };
  }
  useEffect(() => {
    prev.current = { version, plies, pieces, n: (prev.current?.n ?? 0) + 1 };
  }, [version, plies, pieces]);
  const a = anim.current;
  return a && a.version === version && lastMove && a.to === lastMove.to && a.from === lastMove.from ? a : null;
}

/** Quân bị ăn chỉ hiện trong lúc mờ dần, xong thì gỡ khỏi DOM */
function useGhost(arrival: Arrival | null) {
  const [done, setDone] = useState<number | null>(null);
  return {
    piece: arrival?.captured && done !== arrival.id ? arrival.captured : null,
    onEnd: () => {
      if (arrival) setDone(arrival.id);
    },
  };
}

/** Điều khiển bằng bàn phím: phím mũi tên di chuyển ô, Enter / Space để chọn hoặc đi, Esc để bỏ chọn */
function useKeyboard(
  files: number,
  ranks: number,
  orientation: Color,
  firstRank: number,
  sel: ReturnType<typeof useSelection>,
  enabled: boolean,
) {
  const [cursor, setCursor] = useState<{ f: number; r: number } | null>(null);
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!enabled) return;
    const dirs: Record<string, [number, number]> = {
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const start = sel.selected
      ? { f: sel.selected.charCodeAt(0) - 97, r: Number(sel.selected.slice(1)) - firstRank }
      : { f: Math.floor(files / 2), r: orientation === 0 ? 0 : ranks - 1 };
    const cur = cursor ?? start;
    if (e.key in dirs) {
      e.preventDefault();
      if (!cursor) {
        // Lần bấm đầu: chỉ hiện ô đang trỏ
        setCursor(start);
        return;
      }
      const [df, dr] = dirs[e.key];
      const s = orientation === 0 ? 1 : -1;
      setCursor({
        f: Math.min(files - 1, Math.max(0, cur.f + df * s)),
        r: Math.min(ranks - 1, Math.max(0, cur.r + dr * s)),
      });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCursor(cur);
      sel.click(String.fromCharCode(97 + cur.f) + (cur.r + firstRank));
    } else if (e.key === 'Escape') {
      sel.deselect();
    }
  };
  const square = cursor ? String.fromCharCode(97 + cursor.f) + (cursor.r + firstRank) : null;
  return { cursor, square, onKeyDown };
}

/** Câu đọc cho trình đọc màn hình khi di chuyển ô bằng bàn phím */
function cursorText(engine: GameEngine, sq: string | null, selected: string | null): string {
  if (!sq) return '';
  const p = engine.pieceAt(sq);
  const names = engine.game === 'xiangqi' ? XQ_NAMES : CHESS_NAMES;
  const what = p ? `${names[p.type]} ${SIDE_NAMES[engine.game][p.color]}` : 'trống';
  return `${sq}: ${what}${selected === sq ? ', đang chọn' : ''}`;
}

/** Bấm vào bàn: tìm phần tử gần nhất có data-sq (ô / giao điểm, quân, điểm đích) */
function delegateClick(click: (sq: string) => void) {
  return (e: MouseEvent<SVGSVGElement>) => {
    const el = (e.target as Element).closest('[data-sq]');
    const sq = el?.getAttribute('data-sq');
    if (sq) click(sq);
  };
}

/** Mũi tên gợi ý từ tâm ô đi tới tâm ô đến */
function Arrow({ a, b, w, head }: { a: { x: number; y: number }; b: { x: number; y: number }; w: number; head: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const sx = a.x + ux * w * 1.1;
  const sy = a.y + uy * w * 1.1;
  const ex = b.x - ux * head * 0.9;
  const ey = b.y - uy * head * 0.9;
  const hw = head * 0.62;
  const tip = `${b.x - ux * 2},${b.y - uy * 2}`;
  const l = `${ex - uy * hw},${ey + ux * hw}`;
  const r = `${ex + uy * hw},${ey - ux * hw}`;
  return (
    <g className="hint-arrow">
      <line x1={sx} y1={sy} x2={ex} y2={ey} strokeWidth={w} />
      <polygon points={`${tip} ${l} ${r}`} />
    </g>
  );
}

// --------------------------------------------------------------------------- Cờ tướng

const XC = 60;
const XM = 44;
const XW = 8 * XC + 2 * XM;
const XH = 9 * XC + 2 * XM;
const XR = 26.5;
const XQ_FILES = 'abcdefghi';

/**
 * Chữ khắc trên quân và chữ "楚河 漢界": phông Khải thư LXGW WenKai TC, chỉ tải đúng 18 chữ cần dùng
 * (~6 KB) để quân cờ hiển thị giống nhau trên mọi máy. Không tải được thì dùng --font-han của hệ thống.
 */
const HAN_FONT_ID = 'board-han-font';
const HAN_TEXT = '帥將仕士相象傌馬俥車炮砲兵卒楚河漢界';
function ensureHanFont() {
  if (typeof document === 'undefined' || document.getElementById(HAN_FONT_ID)) return;
  const link = document.createElement('link');
  link.id = HAN_FONT_ID;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@700&display=swap&text=${encodeURIComponent(HAN_TEXT)}`;
  document.head.appendChild(link);
}
const XQ_GRAIN = grainUri(XW, XH, 0.004, 0.1, 21, 2, -0.95);

function xqPos(o: Color) {
  return (f: number, r: number) =>
    o === 0 ? { x: XM + f * XC, y: XM + (9 - r) * XC } : { x: XM + (8 - f) * XC, y: XM + r * XC };
}

/** Phần tĩnh của bàn cờ tướng: gỗ, đường kẻ, sông, cung, dấu pháo/tốt, toạ độ */
const XqStatic = memo(function XqStatic({ o, uid }: { o: Color; uid: string }) {
  const pos = xqPos(o);
  const lines: JSX.Element[] = [];
  for (let r = 0; r <= 9; r++) {
    const a = pos(0, r);
    const b = pos(8, r);
    lines.push(<line key={`h${r}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={r === 0 || r === 9 ? 'edge' : undefined} />);
  }
  for (let f = 0; f <= 8; f++) {
    if (f === 0 || f === 8) {
      const a = pos(f, 0);
      const b = pos(f, 9);
      lines.push(<line key={`v${f}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="edge" />);
    } else {
      const a = pos(f, 0);
      const b = pos(f, 4);
      const c = pos(f, 5);
      const d = pos(f, 9);
      lines.push(<line key={`v${f}a`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
      lines.push(<line key={`v${f}b`} x1={c.x} y1={c.y} x2={d.x} y2={d.y} />);
    }
  }
  for (const [f1, r1, f2, r2] of [
    [3, 0, 5, 2],
    [5, 0, 3, 2],
    [3, 7, 5, 9],
    [5, 7, 3, 9],
  ]) {
    const a = pos(f1, r1);
    const b = pos(f2, r2);
    lines.push(<line key={`p${f1}${r1}${f2}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />);
  }
  // Dấu vị trí pháo và tốt
  const marks: JSX.Element[] = [];
  const markPts: Array<[number, number]> = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  ];
  for (const [f, r] of markPts) {
    const { x, y } = pos(f, r);
    const g = 4.5;
    const l = 9;
    for (const sx of [-1, 1]) {
      const fileSide = o === 0 ? f + sx : f - sx;
      if (fileSide < 0 || fileSide > 8) continue;
      for (const sy of [-1, 1]) {
        marks.push(
          <polyline
            key={`m${f}${r}${sx}${sy}`}
            points={`${x + sx * g},${y + sy * (g + l)} ${x + sx * g},${y + sy * g} ${x + sx * (g + l)},${y + sy * g}`}
          />,
        );
      }
    }
  }
  const riverTop = Math.min(pos(0, 4).y, pos(0, 5).y);
  const riverY = riverTop + XC / 2;
  return (
    <g className="xq-static" aria-hidden="true">
      <rect className="xq-wood" width={XW} height={XH} rx={16} fill={`url(#${uid}-wood)`} />
      <image
        className="board-grain"
        href={XQ_GRAIN}
        width={XW}
        height={XH}
        preserveAspectRatio="none"
        clipPath={`url(#${uid}-clip)`}
      />
      <rect width={XW} height={XH} rx={16} fill={`url(#${uid}-sheen)`} />
      <rect x={1.25} y={1.25} width={XW - 2.5} height={XH - 2.5} rx={15} fill="none" stroke={`url(#${uid}-bevel)`} strokeWidth={2.5} />
      <rect className="xq-river-band" x={XM} y={riverTop} width={8 * XC} height={XC} />
      <rect className="xq-border" x={XM - 8} y={XM - 8} width={8 * XC + 16} height={9 * XC + 16} rx={2} />
      <g className="xq-lines">{lines}</g>
      <g className="xq-marks">{marks}</g>
      {(
        [
          [XM + 2 * XC, '楚', '河'],
          [XM + 6 * XC, '漢', '界'],
        ] as const
      ).map(([cx, a, b]) => (
        <g key={a} className="xq-river">
          <text x={cx - 26} y={riverY} dominantBaseline="central">
            {a}
          </text>
          <text x={cx + 26} y={riverY} dominantBaseline="central">
            {b}
          </text>
        </g>
      ))}
      <g className="coords">
        {Array.from({ length: 9 }, (_, f) => (
          <text key={`cf${f}`} x={pos(f, 0).x} y={XH - 4.5}>
            {XQ_FILES[f]}
          </text>
        ))}
        {Array.from({ length: 10 }, (_, r) => (
          <text key={`cr${r}`} x={9.5} y={pos(0, r).y} dominantBaseline="central">
            {r}
          </text>
        ))}
      </g>
    </g>
  );
});

/** Bốn cung tròn ở các góc chéo (đánh dấu quân có thể ăn) */
function reticle(cx: number, cy: number, r: number, frac = 0.56): string {
  const n = (v: number) => Math.round(v * 100) / 100;
  let d = '';
  for (let i = 0; i < 4; i++) {
    const mid = Math.PI / 4 + (i * Math.PI) / 2;
    const half = (Math.PI / 4) * frac;
    const [a0, a1] = [mid - half, mid + half];
    d += `M${n(cx + r * Math.cos(a0))} ${n(cy + r * Math.sin(a0))}A${r} ${r} 0 0 1 ${n(cx + r * Math.cos(a1))} ${n(cy + r * Math.sin(a1))}`;
  }
  return d;
}

/** Bốn góc vuông quanh một giao điểm (đánh dấu nước vừa đi) */
function Brackets({ x, y, s, a, className }: { x: number; y: number; s: number; a: number; className?: string }) {
  const d = [-1, 1]
    .flatMap((sx) => [-1, 1].map((sy) => `M${x + sx * s} ${y + sy * (s - a)}V${y + sy * s}H${x + sx * (s - a)}`))
    .join('');
  return <path d={d} className={className} />;
}

function XiangqiBoard({ engine, version, orientation, movable, onMove, lastMove, hint }: BoardProps) {
  const uid = useSvgId('xq');
  const sel = useSelection(engine, version, movable, onMove);
  const pos = xqPos(orientation);
  const sqPos = (sq: string) => pos(sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 48);
  const pieces = useMemo(() => engine.pieces(), [engine, version]);
  const check = useMemo(() => checkedKing(engine), [engine, version]);
  const arrival = useArrival(engine, version, pieces, lastMove);
  const ghostFx = useGhost(arrival);
  // Bàn để chơi (có onMove) luôn nhận focus bàn phím, kể cả khi đang chờ đối thủ / máy
  const interactive = !!onMove;
  const kb = useKeyboard(9, 10, orientation, 0, sel, interactive);
  useEffect(ensureHanFont, []);

  const hits = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let f = 0; f < 9; f++) {
      for (let r = 0; r < 10; r++) {
        const sq = XQ_FILES[f] + r;
        const { x, y } = xqPos(orientation)(f, r);
        out.push(<circle key={sq} cx={x} cy={y} r={XC / 2 - 1} className="hit" data-sq={sq} />);
      }
    }
    return out;
  }, [orientation]);

  // Quân vừa đi được vẽ sau cùng để trượt lên trên các quân khác
  const ordered = arrival ? [...pieces].sort((a, b) => Number(a.square === arrival.to) - Number(b.square === arrival.to)) : pieces;

  /** ghost = quân vừa bị ăn, mờ dần dưới quân vừa tới (chỉ để trang trí) */
  const piece = (p: BoardPiece, ghost = false) => {
    const { x, y } = sqPos(p.square);
    const isSel = !ghost && sel.selected === p.square;
    const arrive = !ghost && arrival && arrival.to === p.square ? arrival : null;
    const inCheck = !ghost && check === p.square;
    let style: CSSProperties | undefined;
    if (arrive) {
      const from = sqPos(arrive.from);
      style = { '--dx': `${from.x - x}px`, '--dy': `${from.y - y}px` } as CSSProperties;
    }
    const ch = XQ_CHARS[p.type][p.color];
    const key = ghost ? `ghost~${arrival?.id}` : arrive ? `${p.square}~${arrive.id}` : p.square;
    if (p.hidden) {
      // Cờ úp: mặt sau của quân — không có chữ (không lộ danh tính), màu theo bên
      return (
        <g
          key={key}
          transform={`translate(${x},${y})`}
          className={cls(
            'xq-piece',
            'hidden',
            p.color === 0 ? 'red' : 'black',
            isSel && 'selected',
            arrive && 'arrive',
            ghost && 'ghost',
            !ghost && sel.canMove && p.color === movable && 'mine',
          )}
          data-sq={ghost ? undefined : p.square}
          role={ghost ? undefined : 'img'}
          aria-label={ghost ? undefined : `Quân úp ${SIDE_NAMES.xiangqi[p.color]} ở ${p.square} (đi như ${XQ_NAMES[p.type]})`}
          aria-hidden={ghost || undefined}
          onAnimationEnd={ghost ? ghostFx.onEnd : undefined}
        >
          <g className="pc-move" style={style}>
            <ellipse className="pc-shadow" cx={1.4} cy={4} rx={XR + 1} ry={XR} fill={`url(#${uid}-shadow)`} />
            <g className="pc-lift">
              <circle className="xq-edge" cy={2.6} r={XR} fill={`url(#${uid}-edge)`} />
              <circle className="xq-back" r={XR} />
              <circle className="xq-back-ring" r={21.6} />
              <circle className="xq-back-ring inner" r={9.5} />
              <path className="xq-back-mark" d="M0 -15.5L4.2 -4.2L15.5 0L4.2 4.2L0 15.5L-4.2 4.2L-15.5 0L-4.2 -4.2Z" />
              <ellipse className="xq-gloss" cx={-6} cy={-13.5} rx={14} ry={7.5} transform="rotate(-24)" fill={`url(#${uid}-gloss)`} />
              {isSel && <circle r={XR + 2.6} className="sel-ring" />}
            </g>
          </g>
        </g>
      );
    }
    return (
      <g
        key={key}
        transform={`translate(${x},${y})`}
        className={cls(
          'xq-piece',
          p.color === 0 ? 'red' : 'black',
          isSel && 'selected',
          arrive && 'arrive',
          ghost && 'ghost',
          inCheck && 'in-check',
          !!arrive?.revealed && 'flip',
          !ghost && sel.canMove && p.color === movable && 'mine',
        )}
        data-sq={ghost ? undefined : p.square}
        role={ghost ? undefined : 'img'}
        aria-label={ghost ? undefined : `${XQ_NAMES[p.type]} ${SIDE_NAMES.xiangqi[p.color]} ở ${p.square}`}
        aria-hidden={ghost || undefined}
        onAnimationEnd={ghost ? ghostFx.onEnd : undefined}
      >
        <g className="pc-move" style={style}>
          <ellipse className="pc-shadow" cx={1.4} cy={4} rx={XR + 1} ry={XR} fill={`url(#${uid}-shadow)`} />
          <g className="pc-lift">
            {inCheck && <circle r={XR + 4.5} className="check-ring" />}
            <circle className="xq-edge" cy={2.6} r={XR} fill={`url(#${uid}-edge)`} />
            <circle className="xq-face" r={XR} fill={`url(#${uid}-face)`} />
            <circle r={XR - 1.2} fill="none" stroke={`url(#${uid}-rim)`} strokeWidth={1.6} />
            <circle className="xq-ring" r={21.6} />
            <text className="xq-char xq-char-hl" y={0.9} dominantBaseline="central">
              {ch}
            </text>
            <text className="xq-char" dominantBaseline="central">
              {ch}
            </text>
            <ellipse className="xq-gloss" cx={-6} cy={-13.5} rx={14} ry={7.5} transform="rotate(-24)" fill={`url(#${uid}-gloss)`} />
            {isSel && <circle r={XR + 2.6} className="sel-ring" />}
          </g>
        </g>
      </g>
    );
  };

  const cur = kb.square ? sqPos(kb.square) : null;

  return (
    <>
      <svg
        viewBox={`0 0 ${XW} ${XH}`}
        className={cls('board-svg xq-board', sel.canMove && 'interactive')}
        aria-label="Bàn cờ tướng"
        onClick={delegateClick(sel.click)}
        onKeyDown={kb.onKeyDown}
        tabIndex={interactive ? 0 : undefined}
      >
        <defs>
          <clipPath id={`${uid}-clip`}>
            <rect width={XW} height={XH} rx={16} />
          </clipPath>
          <linearGradient id={`${uid}-wood`} x1="0" y1="0" x2="1" y2="1">
            <Stop at={0} c="var(--xq-wood-1)" />
            <Stop at={0.55} c="var(--xq-wood-2)" />
            <Stop at={1} c="var(--xq-wood-3)" />
          </linearGradient>
          <radialGradient id={`${uid}-sheen`} cx="0.42" cy="0.36" r="0.78">
            <Stop at={0} c="#fff" o={0.2} />
            <Stop at={0.55} c="#fff" o={0} />
            <Stop at={1} c="#2a1405" o={0.16} />
          </radialGradient>
          <linearGradient id={`${uid}-bevel`} x1="0" y1="0" x2="0" y2="1">
            <Stop at={0} c="#fff" o={0.55} />
            <Stop at={0.5} c="#fff" o={0.08} />
            <Stop at={1} c="#2a1405" o={0.4} />
          </linearGradient>
          <radialGradient id={`${uid}-face`} cx="0.4" cy="0.32" r="0.78">
            <Stop at={0} c="var(--xq-face-1)" />
            <Stop at={0.62} c="var(--xq-face-2)" />
            <Stop at={1} c="var(--xq-face-3)" />
          </radialGradient>
          <linearGradient id={`${uid}-edge`} x1="0" y1="0" x2="0" y2="1">
            <Stop at={0} c="var(--xq-edge-1)" />
            <Stop at={1} c="var(--xq-edge-2)" />
          </linearGradient>
          <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0" y2="1">
            <Stop at={0} c="#fff" o={0.95} />
            <Stop at={0.45} c="#fff" o={0} />
            <Stop at={1} c="#5a3510" o={0.35} />
          </linearGradient>
          <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
            <Stop at={0} c="#fff" o={0.55} />
            <Stop at={1} c="#fff" o={0} />
          </linearGradient>
          <radialGradient id={`${uid}-shadow`}>
            <Stop at={0.6} c="#2a1405" o={0.5} />
            <Stop at={1} c="#2a1405" o={0} />
          </radialGradient>
          <radialGradient id={`${uid}-check`}>
            <Stop at={0.5} c="var(--board-check)" o={0.95} />
            <Stop at={0.68} c="var(--board-check)" o={0.55} />
            <Stop at={1} c="var(--board-check)" o={0} />
          </radialGradient>
        </defs>

        <XqStatic o={orientation} uid={uid} />

        {lastMove && (
          <g className="last-move" aria-hidden="true">
            {[lastMove.from, lastMove.to].map((sq, i) => {
              const { x, y } = sqPos(sq);
              return <Brackets key={sq} x={x} y={y} s={28.5} a={10} className={i === 0 ? 'from' : 'to'} />;
            })}
          </g>
        )}
        {check && (() => {
          const { x, y } = sqPos(check);
          return <circle className="check-glow" cx={x} cy={y} r={47} fill={`url(#${uid}-check)`} />;
        })()}

        <g className="hits">{hits}</g>
        <g className="pieces">
          {ghostFx.piece && piece(ghostFx.piece, true)}
          {ordered.map((p) => piece(p))}
        </g>

        {hint && (
          <g className="hint-mark" aria-hidden="true">
            {[hint.from, hint.to].map((sq) => {
              const { x, y } = sqPos(sq);
              return <circle key={sq} cx={x} cy={y} r={XR + 4} />;
            })}
            <Arrow a={sqPos(hint.from)} b={sqPos(hint.to)} w={9} head={24} />
          </g>
        )}

        <g className="targets">
          {[...sel.targets].map((sq) => {
            const { x, y } = sqPos(sq);
            const occupied = !!engine.pieceAt(sq);
            return (
              <g key={sq} className={cls('target', occupied && 'capture')} data-sq={sq}>
                <circle cx={x} cy={y} r={XC / 2 - 1} className="target-hit" />
                {occupied ? (
                  <>
                    <circle cx={x} cy={y} r={XR + 1} className="target-tint" />
                    <path d={reticle(x, y, XR + 4)} className="target-capture" />
                  </>
                ) : (
                  <circle cx={x} cy={y} r={7.5} className="target-dot" />
                )}
              </g>
            );
          })}
        </g>

        {cur && <rect className="kb-cursor" x={cur.x - 30} y={cur.y - 30} width={60} height={60} rx={10} />}
      </svg>
      {interactive && (
        <div className="sr-only" aria-live="polite">
          {cursorText(engine, kb.square, sel.selected)}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------- Cờ vua: quân Staunton tự vẽ (hộp 100×100)

const circ = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const pill = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
};
/** Đế quân: hình thang bo góc, đáy rộng 2w */
const plinth = (w: number, top = 77, bottom = 89) => {
  const l = 50 - w;
  const r = 50 + w;
  return (
    `M${l + 2} ${bottom}H${r - 2}Q${r} ${bottom} ${r - 0.4} ${bottom - 2}L${r - 2.6} ${top + 2}` +
    `Q${r - 3} ${top} ${r - 5} ${top}H${l + 5}Q${l + 3} ${top} ${l + 2.6} ${top + 2}L${l + 0.4} ${bottom - 2}Q${l} ${bottom} ${l + 2} ${bottom}Z`
  );
};

/** Vệt sáng ở mép trên của vành / đế — chỉ hiện trên quân đen để thấy rõ các khúc tiện */
const pillSeam = (x: number, y: number, w: number) => `M${x + 4} ${y + 2.8}H${x + w - 4}`;
const plinthSeam = (w: number, top = 77) => `M${50 - w + 6.5} ${top + 2.8}H${50 + w - 6.5}`;

interface PieceArt {
  /** Các mảng có tô + viền, vẽ theo thứ tự */
  body: string[];
  /** Nét chi tiết (màu tương phản với thân quân) */
  detail?: string[];
  /** Chấm chi tiết (mắt, lỗ mũi) */
  spots?: string[];
  /** Vệt sáng (chỉ quân đen) */
  seams?: string[];
}

const PIECE_ART: Record<string, PieceArt> = {
  p: {
    body: [
      'M35 78C40 71 42.6 63.5 42.8 55H57.2C57.4 63.5 60 71 65 78Z',
      plinth(27),
      pill(35.5, 48.5, 29, 7.5),
      circ(50, 35.5, 13.5),
    ],
    seams: [pillSeam(35.5, 48.5, 29), plinthSeam(27), 'M42.6 31.5A8.6 8.6 0 0 1 49 26.2'],
  },
  r: {
    body: [
      'M29.5 77C31.5 65 33 53 33.5 42H66.5C67 53 68.5 65 70.5 77Z',
      plinth(33),
      pill(25, 72, 50, 7),
      'M25.5 40V17H36V24.5H44.5V17H55.5V24.5H64V17H74.5V40Z',
      pill(27, 37.5, 46, 7),
    ],
    seams: [pillSeam(25, 72, 50), pillSeam(27, 37.5, 46), plinthSeam(33)],
  },
  b: {
    body: [
      'M33 77C38.5 70 42.5 63 43 56.5H57C57.5 63 61.5 70 67 77Z',
      plinth(30),
      pill(28.5, 72, 43, 7),
      'M50 16C60.5 23.5 68 32.5 67.5 42.5C67 50.5 60 55 50 55C40 55 33 50.5 32.5 42.5C32 32.5 39.5 23.5 50 16Z',
      pill(34.5, 52, 31, 7),
      circ(50, 12, 5),
    ],
    detail: ['M57 28.5L47.5 41.5'],
    seams: [pillSeam(28.5, 72, 43), pillSeam(34.5, 52, 31), plinthSeam(30), 'M38.6 36.5C39.8 31.5 42.6 27.2 46.4 23.6'],
  },
  q: {
    body: [
      'M31 77C36 67.5 40.5 57.5 41 47H59C59.5 57.5 64 67.5 69 77Z',
      plinth(33),
      pill(26.5, 72, 47, 7),
      'M35 46.5C32 39.5 28.5 32.5 24.5 25.5L34.5 33L38.5 20L45 31L50 17L55 31L61.5 20L65.5 33L75.5 25.5C71.5 32.5 68 39.5 65 46.5Z',
      pill(32.5, 43.5, 35, 7),
      circ(24.5, 23.5, 4),
      circ(38.5, 18, 4),
      circ(50, 14, 4.5),
      circ(61.5, 18, 4),
      circ(75.5, 23.5, 4),
    ],
    seams: [pillSeam(26.5, 72, 47), pillSeam(32.5, 43.5, 35), plinthSeam(33)],
  },
  k: {
    body: [
      'M31 77C36 68 40.5 59 41 49H59C59.5 59 64 68 69 77Z',
      plinth(33),
      pill(26.5, 72, 47, 7),
      'M46.5 31V19.5H40.5V13H46.5V5.5H53.5V13H59.5V19.5H53.5V31Z',
      'M37 48C32.5 42.5 28.5 36 29.5 30C39 24.5 61 24.5 70.5 30C71.5 36 67.5 42.5 63 48Z',
      pill(32.5, 45.5, 35, 7),
    ],
    detail: ['M32 37.5C43.5 33.5 56.5 33.5 68 37.5'],
    seams: [pillSeam(26.5, 72, 47), pillSeam(32.5, 45.5, 35), plinthSeam(33)],
  },
  n: {
    body: [
      'M29 75C28.5 66 32 59 39.5 54.5C36 55.6 31.5 56.6 26.5 56.6C21 56.8 17 53.4 17.3 48.6C17.6 43.8 22.5 38.3 27.5 32.8C31.5 28.3 34.6 23.6 37.2 18.5L40.6 7.5L47.6 16C60.6 15.6 72.6 24.2 77.4 37.8C81 49 80.5 62 76 75Z',
      plinth(31),
      pill(25, 72, 50, 7),
    ],
    detail: ['M50 19.8C62 21.4 70.8 30.4 73.6 42.8C75.6 53.2 75 63.8 72.2 72.4', 'M26.5 56.6C25.8 54 27.4 52.4 29.6 52.2'],
    spots: ['M33.4 30.6C34.2 28.2 37 26.9 39.4 27.7C38.8 30.2 36 31.5 33.4 30.6Z', circ(22.2, 48.3, 1.6)],
    seams: [pillSeam(25, 72, 50), plinthSeam(31)],
  },
};

/** Vẽ một quân cờ vua trong hộp 100×100; `fill` là gradient của bên (trắng / đen) */
function ChessArt({ type, fill }: { type: string; fill: string }) {
  const art = PIECE_ART[type];
  return (
    <>
      {art.body.map((d, i) => (
        <path key={`b${i}`} d={d} className="cp-body" fill={fill} />
      ))}
      {art.detail?.map((d, i) => (
        <path key={`d${i}`} d={d} className="cp-detail" />
      ))}
      {art.spots?.map((d, i) => (
        <path key={`s${i}`} d={d} className="cp-spot" />
      ))}
      {art.seams?.map((d, i) => (
        <path key={`m${i}`} d={d} className="cp-seam" />
      ))}
    </>
  );
}

const CS = 64;
const CM = 22;
const CW = 8 * CS + 2 * CM;
const C_FILES = 'abcdefgh';
const CP_SCALE = 0.7;
const CB_GRAIN = grainUri(8 * CS, 8 * CS, 0.0045, 0.14, 5, 2.2, -1.05);
const CB_FRAME_GRAIN = grainUri(CW, CW, 0.004, 0.09, 23, 2.2, -0.9);

function chessPos(o: Color) {
  return (f: number, r: number) =>
    o === 0 ? { x: CM + f * CS, y: CM + (7 - r) * CS } : { x: CM + (7 - f) * CS, y: CM + r * CS };
}

/** Khung gỗ, các ô và toạ độ — không đổi theo thế cờ */
const ChessStatic = memo(function ChessStatic({ o, uid }: { o: Color; uid: string }) {
  const pos = chessPos(o);
  const squares: JSX.Element[] = [];
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const sq = C_FILES[f] + (r + 1);
      const { x, y } = pos(f, r);
      const dark = (f + r) % 2 === 0;
      squares.push(<rect key={sq} x={x} y={y} width={CS} height={CS} className={dark ? 'sq-dark' : 'sq-light'} data-sq={sq} />);
    }
  }
  return (
    <>
      <g className="cb-frame" aria-hidden="true">
        <rect width={CW} height={CW} rx={12} fill={`url(#${uid}-frame)`} />
        <image
          className="board-grain"
          href={CB_FRAME_GRAIN}
          width={CW}
          height={CW}
          preserveAspectRatio="none"
          clipPath={`url(#${uid}-clip)`}
        />
        <rect x={1.25} y={1.25} width={CW - 2.5} height={CW - 2.5} rx={11} fill="none" stroke={`url(#${uid}-bevel)`} strokeWidth={2.5} />
        <rect x={CM - 2.5} y={CM - 2.5} width={8 * CS + 5} height={8 * CS + 5} rx={2} className="cb-inlay" />
      </g>
      <g className="squares">{squares}</g>
      <image
        className="board-grain cb-grain"
        href={CB_GRAIN}
        x={CM}
        y={CM}
        width={8 * CS}
        height={8 * CS}
        preserveAspectRatio="none"
        aria-hidden="true"
      />
      <g className="coords" aria-hidden="true">
        {Array.from({ length: 8 }, (_, f) => (
          <text key={`f${f}`} x={pos(f, 0).x + CS / 2} y={CW - CM / 2} dominantBaseline="central">
            {C_FILES[f]}
          </text>
        ))}
        {Array.from({ length: 8 }, (_, r) => (
          <text key={`r${r}`} x={CM / 2} y={pos(0, r).y + CS / 2} dominantBaseline="central">
            {r + 1}
          </text>
        ))}
      </g>
    </>
  );
});

function ChessDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <clipPath id={`${uid}-clip`}>
        <rect width={CW} height={CW} rx={12} />
      </clipPath>
      <linearGradient id={`${uid}-frame`} x1="0" y1="0" x2="1" y2="1">
        <Stop at={0} c="var(--cb-frame-1)" />
        <Stop at={1} c="var(--cb-frame-2)" />
      </linearGradient>
      <linearGradient id={`${uid}-bevel`} x1="0" y1="0" x2="0" y2="1">
        <Stop at={0} c="#fff" o={0.35} />
        <Stop at={0.5} c="#fff" o={0.04} />
        <Stop at={1} c="#000" o={0.45} />
      </linearGradient>
      <linearGradient id={`${uid}-wp`} x1="0.2" y1="0" x2="0.8" y2="1">
        <Stop at={0} c="var(--cp-white-1)" />
        <Stop at={1} c="var(--cp-white-2)" />
      </linearGradient>
      <linearGradient id={`${uid}-bp`} x1="0.2" y1="0" x2="0.8" y2="1">
        <Stop at={0} c="var(--cp-black-1)" />
        <Stop at={1} c="var(--cp-black-2)" />
      </linearGradient>
      <radialGradient id={`${uid}-shadow`}>
        <Stop at={0} c="#1a0d03" o={0.42} />
        <Stop at={1} c="#1a0d03" o={0} />
      </radialGradient>
      <radialGradient id={`${uid}-check`}>
        <Stop at={0} c="var(--board-check)" o={1} />
        <Stop at={0.3} c="var(--board-check)" o={0.85} />
        <Stop at={1} c="var(--board-check)" o={0} />
      </radialGradient>
    </defs>
  );
}

function ChessBoard({ engine, version, orientation, movable, onMove, lastMove, hint }: BoardProps) {
  const uid = useSvgId('cb');
  const sel = useSelection(engine, version, movable, onMove);
  const pos = chessPos(orientation);
  const sqPos = (sq: string) => pos(sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 49);
  const center = (sq: string) => {
    const p = sqPos(sq);
    return { x: p.x + CS / 2, y: p.y + CS / 2 };
  };
  const pieces = useMemo(() => engine.pieces(), [engine, version]);
  const check = useMemo(() => checkedKing(engine), [engine, version]);
  const arrival = useArrival(engine, version, pieces, lastMove);
  const ghostFx = useGhost(arrival);
  const interactive = !!onMove;
  const kb = useKeyboard(8, 8, orientation, 1, sel, interactive);

  const overlay = (sq: string, c: string) => {
    const { x, y } = sqPos(sq);
    return <rect key={`${c}-${sq}`} x={x} y={y} width={CS} height={CS} className={c} />;
  };
  const ordered = arrival ? [...pieces].sort((a, b) => Number(a.square === arrival.to) - Number(b.square === arrival.to)) : pieces;
  const cur = kb.square ? sqPos(kb.square) : null;

  /** ghost = quân vừa bị ăn, mờ dần dưới quân vừa tới (chỉ để trang trí) */
  const piece = (p: BoardPiece, ghost = false) => {
    const { x, y } = sqPos(p.square);
    const arrive = !ghost && arrival && arrival.to === p.square ? arrival : null;
    let style: CSSProperties | undefined;
    if (arrive) {
      const from = sqPos(arrive.from);
      style = { '--dx': `${from.x - x}px`, '--dy': `${from.y - y}px` } as CSSProperties;
    }
    const off = (CS - 100 * CP_SCALE) / 2;
    return (
      <g
        key={ghost ? `ghost~${arrival?.id}` : arrive ? `${p.square}~${arrive.id}` : p.square}
        transform={`translate(${x},${y})`}
        className={cls(
          'chess-piece',
          p.color === 0 ? 'white' : 'black',
          !ghost && sel.selected === p.square && 'selected',
          arrive && 'arrive',
          ghost && 'ghost',
          !ghost && sel.canMove && p.color === movable && 'mine',
        )}
        data-sq={ghost ? undefined : p.square}
        role={ghost ? undefined : 'img'}
        aria-label={ghost ? undefined : `${CHESS_NAMES[p.type]} ${SIDE_NAMES.chess[p.color]} ở ${p.square}`}
        aria-hidden={ghost || undefined}
        onAnimationEnd={ghost ? ghostFx.onEnd : undefined}
      >
        <g className="pc-move" style={style}>
          <g transform={`translate(${off},${off + 1.6}) scale(${CP_SCALE})`}>
            <ellipse className="pc-shadow" cx={51.5} cy={89.5} rx={30} ry={6} fill={`url(#${uid}-shadow)`} />
            <g className="pc-lift">
              <ChessArt type={p.type} fill={`url(#${uid}-${p.color === 0 ? 'wp' : 'bp'})`} />
            </g>
          </g>
        </g>
      </g>
    );
  };

  return (
    <>
      <svg
        viewBox={`0 0 ${CW} ${CW}`}
        className={cls('board-svg chess-board', sel.canMove && 'interactive')}
        aria-label="Bàn cờ vua"
        onClick={delegateClick(sel.click)}
        onKeyDown={kb.onKeyDown}
        tabIndex={interactive ? 0 : undefined}
      >
        <ChessDefs uid={uid} />
        <ChessStatic o={orientation} uid={uid} />
        <g className="sq-marks" aria-hidden="true">
          {lastMove && [overlay(lastMove.from, 'last-sq'), overlay(lastMove.to, 'last-sq')]}
          {sel.selected && overlay(sel.selected, 'sel-sq')}
          {check &&
            (() => {
              const { x, y } = sqPos(check);
              return <rect x={x} y={y} width={CS} height={CS} className="check-sq" fill={`url(#${uid}-check)`} />;
            })()}
        </g>
        <g className="pieces">
          {ghostFx.piece && piece(ghostFx.piece, true)}
          {ordered.map((p) => piece(p))}
        </g>
        {hint && (
          <g className="hint-mark" aria-hidden="true">
            {[hint.from, hint.to].map((sq) => {
              const { x, y } = center(sq);
              return <circle key={sq} cx={x} cy={y} r={CS / 2 - 3} />;
            })}
            <Arrow a={center(hint.from)} b={center(hint.to)} w={10} head={26} />
          </g>
        )}
        <g className="targets">
          {[...sel.targets].map((sq) => {
            const { x, y } = sqPos(sq);
            const occupied = !!engine.pieceAt(sq);
            const cx = x + CS / 2;
            const cy = y + CS / 2;
            return (
              <g key={sq} className={cls('target', occupied && 'capture')} data-sq={sq}>
                <rect x={x} y={y} width={CS} height={CS} className="target-hit" />
                {occupied ? (
                  <path
                    className="target-capture"
                    d={`M${x} ${y}h${CS}v${CS}h${-CS}Z${circ(cx, cy, CS / 2 + 1)}`}
                    fillRule="evenodd"
                  />
                ) : (
                  <circle cx={cx} cy={cy} r={10} className="target-dot" />
                )}
              </g>
            );
          })}
        </g>
        {cur && <rect className="kb-cursor" x={cur.x + 2} y={cur.y + 2} width={CS - 4} height={CS - 4} rx={6} />}
      </svg>
      {sel.promo && (
        <PromotionPicker color={engine.turn()} uid={uid} onPick={sel.choosePromo} onCancel={sel.cancelPromo} />
      )}
      {interactive && (
        <div className="sr-only" aria-live="polite">
          {cursorText(engine, kb.square, sel.selected)}
        </div>
      )}
    </>
  );
}

function PromotionPicker({
  color,
  uid,
  onPick,
  onCancel,
}: {
  color: Color;
  uid: string;
  onPick: (l: string) => void;
  onCancel: () => void;
}) {
  const side = color === 0 ? 'white' : 'black';
  return (
    <div
      className="promo-picker"
      role="dialog"
      aria-label="Chọn quân phong cấp"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="promo-card">
        <div className="promo-title">Phong cấp thành</div>
        <div className="promo-options">
          {(['q', 'r', 'b', 'n'] as const).map((l, i) => (
            <button
              key={l}
              type="button"
              className={`promo-btn ${side}`}
              onClick={() => onPick(l)}
              title={CHESS_NAMES[l]}
              aria-label={CHESS_NAMES[l]}
              autoFocus={i === 0}
            >
              <svg viewBox="0 0 100 100" className={`promo-piece chess-piece ${side}`} aria-hidden="true">
                <ChessArt type={l} fill={`url(#${uid}-${color === 0 ? 'wp' : 'bp'})`} />
              </svg>
              <span className="promo-name">{CHESS_NAMES[l]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm promo-cancel" onClick={onCancel}>
          Huỷ
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Bàn cờ chung

export function GameBoard(props: BoardProps) {
  const game = props.engine.game;
  return (
    <div className={`board-wrap is-${game}`}>
      {game === 'xiangqi' ? <XiangqiBoard {...props} /> : <ChessBoard {...props} />}
    </div>
  );
}

/** Lấy ô đi / ô đến của nước cuối để tô sáng */
export function lastMoveOf(engine: GameEngine): MoveMark | null {
  const h = engine.history();
  if (!h.length) return null;
  const m = h[h.length - 1];
  return { from: m.slice(0, 2), to: m.slice(2, 4) };
}
