import { useEffect, useId, useRef, useState } from 'react';
import type { GameType, MoveInfo } from '@cotuong/game-core';
import { Icon } from './icons';

/** Cuộn bên trong danh sách (không kéo cả trang) để nước đang xem nằm trong tầm nhìn */
function revealCurrent(box: HTMLElement, latest: boolean) {
  const el = box.querySelector<HTMLElement>('.mv.current');
  if (!el) {
    box.scrollTop = 0;
    box.scrollLeft = 0;
    return;
  }
  if (latest) {
    // Nước mới nhất: luôn bám cuối danh sách (cả chiều dọc lẫn dải ngang trên điện thoại)
    box.scrollTop = box.scrollHeight;
    box.scrollLeft = box.scrollWidth;
    return;
  }
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 8;
  if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
  else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - (b.bottom - pad);
  if (r.left < b.left + pad) box.scrollLeft -= b.left + pad - r.left;
  else if (r.right > b.right - pad) box.scrollLeft += r.right - (b.right - pad);
}

/**
 * Nhãn nước đi chia hai phần để hiện đủ trong cột hẹp (không cắt chữ, kể cả trên điện thoại):
 * "P8.7 → Sĩ (ăn Tốt úp)" → dòng chính "P8.7 → Sĩ" + dòng phụ nhỏ "ăn Tốt úp" (Cờ úp).
 */
function splitLabel(label: string): [string, string | null] {
  const m = /^(.*?)\s*\((.+)\)$/.exec(label);
  return m ? [m[1], m[2]] : [label, null];
}

/** Hướng dẫn đọc ký hiệu nước đi (theo đúng cách game-core ghi nhãn) */
function NotationHelp({ game, jieqi }: { game: GameType; jieqi?: boolean }) {
  if (game === 'chess') {
    return (
      <>
        <p>
          <b>e4</b>: Tốt đi tới ô e4. Ô ghi bằng cột (a–h) và hàng (1–8).
        </p>
        <p>
          Chữ hoa là quân: <b>N</b> Mã · <b>B</b> Tượng · <b>R</b> Xe · <b>Q</b> Hậu · <b>K</b> Vua. Không có chữ hoa là Tốt.
        </p>
        <ul>
          <li>
            <b>x</b> ăn quân (vd. <b>Nxe5</b>: Mã ăn quân ở e5)
          </li>
          <li>
            <b>+</b> chiếu · <b>#</b> chiếu hết
          </li>
          <li>
            <b>O-O</b> nhập thành gần (phía Vua) · <b>O-O-O</b> nhập thành xa (phía Hậu)
          </li>
          <li>
            <b>=Q</b> Tốt phong cấp thành Hậu
          </li>
        </ul>
      </>
    );
  }
  return (
    <>
      <p>
        <b>P2-5</b>: Pháo ở cột 2 đi ngang sang cột 5.
      </p>
      <ul>
        <li>
          Chữ đầu là quân: <b>X</b> Xe · <b>M</b> Mã · <b>T</b> Tượng · <b>S</b> Sĩ · <b>Tg</b> Tướng · <b>P</b> Pháo · <b>B</b> Tốt
        </li>
        <li>Số tiếp theo là cột quân đang đứng, đếm 1–9 từ phải sang trái theo phía người đi.</li>
        <li>
          Dấu: <kbd className="key">.</kbd> tiến · <kbd className="key">/</kbd> lui · <kbd className="key">-</kbd> đi ngang
        </li>
        <li>
          Số cuối: Xe, Pháo, Tốt, Tướng đi tiến/lui thì là số bước (<b>X1.1</b>: Xe cột 1 tiến 1 bước); đi ngang, hoặc Mã, Tượng, Sĩ
          thì là cột đến (<b>M8.7</b>: Mã cột 8 tiến sang cột 7).
        </li>
        <li>
          <b>t</b> / <b>s</b>: quân trước / quân sau, khi hai quân cùng loại đứng chung một cột (vd. <b>Xt.1</b>).
        </li>
        {jieqi && (
          <>
            <li>
              Cờ úp: quân úp đi theo quân gốc của ô nó đang đứng (úp ở ô Pháo thì đi như Pháo), nên chữ đầu là quân gốc đó. Đi xong
              thì lật lên.
            </li>
            <li>
              <b>→ Mã</b>: quân úp vừa đi được lật ra là Mã. <b>ăn Sĩ úp</b>: vừa ăn một quân úp, lật ra là Sĩ.
            </li>
          </>
        )}
      </ul>
    </>
  );
}

/**
 * Danh sách nước đi theo cặp; bấm vào nước để xem lại (nếu có onSelect).
 * Bảng 2 cột cuộn dọc (cả máy tính và điện thoại); nhãn dài xuống dòng thay vì bị cắt.
 * Có nút "Cách đọc nước đi" ở cuối khung (truyền game để hiện đúng hướng dẫn cờ tướng / cờ vua).
 */
export function MoveList({
  moves,
  current,
  onSelect,
  game,
  jieqi,
}: {
  moves: MoveInfo[];
  /** Số nước đang xem (moves.length = thế mới nhất) */
  current?: number;
  onSelect?: (ply: number) => void;
  /** Có thì hiện nút "Cách đọc nước đi" */
  game?: GameType;
  /** Cờ úp: thêm giải thích phần "→ quân lật" / "ăn … úp" */
  jieqi?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cur = current ?? moves.length;
  const latestRef = useRef(true);
  latestRef.current = cur === moves.length;
  const [help, setHelp] = useState(false);
  const helpId = useId();

  useEffect(() => {
    if (ref.current) revealCurrent(ref.current, latestRef.current);
  }, [moves.length, cur]);

  // Khung đổi cỡ (thông báo xuất hiện, xoay màn hình…): giữ nước đang xem trong tầm nhìn
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => revealCurrent(box, latestRef.current));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const rows: Array<[MoveInfo, MoveInfo | undefined, number]> = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([moves[i], moves[i + 1], i]);

  const btn = (m: MoveInfo, ply: number) => {
    const [main, note] = splitLabel(m.label);
    return (
      <button
        type="button"
        className={`mv${cur === ply ? ' current' : ''}${m.check ? ' is-check' : ''}${m.captured ? ' is-capture' : ''}`}
        onClick={() => onSelect?.(ply)}
        disabled={!onSelect}
        aria-current={cur === ply ? 'step' : undefined}
        aria-label={note ? `${main}, ${note}` : undefined}
      >
        <span className="mv-main">{main}</span>
        {note && <span className="mv-note">{note}</span>}
      </button>
    );
  };

  return (
    <>
      <div className={`move-list${onSelect ? ' selectable' : ''}`} ref={ref} hidden={help}>
        {rows.length === 0 && <div className="mv-empty">Chưa có nước đi nào</div>}
        {rows.map(([a, b, i]) => (
          <div className="mv-row" key={i}>
            <span className="mv-no">{i / 2 + 1}.</span>
            {btn(a, i + 1)}
            {b ? btn(b, i + 2) : <span className="mv-pad" />}
          </div>
        ))}
      </div>
      {game && (
        <>
          {help && (
            <div className="mv-help" id={helpId} role="region" aria-label="Cách đọc nước đi">
              <NotationHelp game={game} jieqi={jieqi} />
            </div>
          )}
          <div className="mv-help-bar">
            <button type="button" className="mv-help-btn" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-controls={help ? helpId : undefined}>
              <Icon name={help ? 'list' : 'info'} size={14} />
              {help ? 'Quay lại danh sách nước đi' : 'Cách đọc nước đi'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
