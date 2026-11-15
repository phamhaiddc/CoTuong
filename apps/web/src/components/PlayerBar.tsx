import type { GameType } from '@cotuong/game-core';
import { COLOR_LABEL } from '@cotuong/shared';
import { Icon } from './icons';
import { Avatar, TierBadge, formatClock, signed } from './ui';

export interface PlayerBarProps {
  game: GameType;
  color: 0 | 1;
  name: string;
  avatarUrl?: string | null;
  isMe?: boolean;
  isBot?: boolean;
  /** Tài khoản người chơi không còn (đã bị xoá): ảnh đại diện trung tính thay cho chữ cái đầu của tên */
  gone?: boolean;
  rating?: number | null;
  tier?: string | null;
  tierLevel?: number | null;
  /** ms còn lại; undefined = không giới hạn thời gian */
  clockMs?: number;
  active: boolean;
  /** Giây còn lại để vào lại ván (đang mất kết nối) */
  reconnectSec?: number | null;
  thinking?: boolean;
  /** Tướng / Vua của bên này đang bị chiếu */
  inCheck?: boolean;
  /** Điểm hạng thay đổi sau ván (trang xem lại) */
  delta?: number | null;
  /** Bên thắng ván (trang xem lại) */
  winner?: boolean;
  /** Cờ úp: các quân (của đối phương) mà bên này đã ăn, theo loại thật — xem capturedList() */
  captured?: readonly CapturedLetter[];
}

/** Loại quân cờ tướng (không gồm Tướng): Xe, Mã, Tượng, Sĩ, Pháo, Tốt */
export type CapturedLetter = 'r' | 'h' | 'e' | 'a' | 'c' | 'p';
const CAPTURE_ORDER: readonly CapturedLetter[] = ['r', 'c', 'h', 'e', 'a', 'p'];
const CAPTURE_CHARS: Record<CapturedLetter, [string, string]> = {
  r: ['俥', '車'],
  h: ['傌', '馬'],
  e: ['相', '象'],
  a: ['仕', '士'],
  c: ['炮', '砲'],
  p: ['兵', '卒'],
};
const CAPTURE_NAMES: Record<CapturedLetter, string> = { r: 'Xe', h: 'Mã', e: 'Tượng', a: 'Sĩ', c: 'Pháo', p: 'Tốt' };

/** Bảng đếm quân bị ăn (vd JieqiGame.capturedPieces()[màu]) → danh sách theo giá trị: Xe, Pháo, Mã, Tượng, Sĩ, Tốt */
export function capturedList(counts: Readonly<Record<CapturedLetter, number>>): CapturedLetter[] {
  const out: CapturedLetter[] = [];
  for (const l of CAPTURE_ORDER) for (let i = 0; i < (counts[l] ?? 0); i++) out.push(l);
  return out;
}

/** Dải quân đã ăn (quân của đối phương, màu ngược với bên đang xem) */
function CapturedStrip({ letters, victimColor }: { letters: readonly CapturedLetter[]; victimColor: 0 | 1 }) {
  const names = letters.map((l) => CAPTURE_NAMES[l]).join(', ');
  return (
    <div className="pb-captured" title={`Đã ăn: ${names}`} aria-label={`Đã ăn: ${names}`}>
      <span className="pb-cap-label" aria-hidden="true">
        Đã ăn
      </span>
      {letters.map((l, i) => (
        <span key={i} className={`pb-cap side-xiangqi-${victimColor}`} aria-hidden="true">
          {CAPTURE_CHARS[l][victimColor]}
        </span>
      ))}
    </div>
  );
}

/** Quân Tướng / Vua của mỗi bên, dùng làm huy hiệu màu quân trên ảnh đại diện */
const KING: Record<GameType, [string, string]> = { xiangqi: ['帥', '將'], chess: ['♔', '♚'] };

export function PlayerBar(p: PlayerBarProps) {
  const side = COLOR_LABEL[p.game][p.color];
  const timed = p.clockMs !== undefined;
  const ms = p.clockMs ?? 0;
  const low = timed && ms < 30_000;
  const critical = timed && ms < 10_000;
  const offline = p.reconnectSec != null;
  const cls = ['player-bar', p.active && 'active', p.isMe && 'is-me', offline && 'offline', p.inCheck && 'in-check']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-color={p.color}>
      <span className="pb-avatar">
        {p.isBot || p.gone ? (
          <span className="avatar bot-avatar" aria-hidden="true">
            <Icon name={p.gone ? 'user' : 'bot'} size={22} />
          </span>
        ) : (
          <Avatar name={p.name} url={p.avatarUrl} size={40} />
        )}
        <span className={`side-piece side-${p.game}-${p.color}`} title={`Cầm quân ${side}`} aria-hidden="true">
          {KING[p.game][p.color]}
        </span>
      </span>
      <div className="pb-info">
        <div className="pb-name">
          <span className="pb-name-text" title={p.name}>
            {p.name}
          </span>
          {p.isMe && <span className="pb-you">Bạn</span>}
          {p.winner && <Icon name="crown" size={15} className="pb-crown" title="Thắng ván" />}
        </div>
        <div className="pb-meta">
          <span className="pb-side">
            <span className={`side-dot side-${p.game}-${p.color}`} aria-hidden="true" />
            {side}
          </span>
          {p.rating != null && (
            <span className="pb-rating num" title={`Điểm hạng: ${p.rating}`}>
              {p.rating}
              <span className="pb-rating-unit"> điểm</span>
            </span>
          )}
          {p.tier && <TierBadge name={p.tier} level={p.tierLevel ?? 0} />}
          {p.delta != null && (
            <span className={`pb-delta num ${p.delta > 0 ? 'up' : p.delta < 0 ? 'down' : 'zero'}`} title="Điểm hạng được cộng / bị trừ sau ván">
              {signed(p.delta)}
              <span className="pb-rating-unit"> điểm</span>
            </span>
          )}
        </div>
        {p.captured && p.captured.length > 0 && <CapturedStrip letters={p.captured} victimColor={p.color === 0 ? 1 : 0} />}
      </div>
      {/* Trạng thái tức thời: ô riêng để không bị cắt khi tên / cấp bậc dài */}
      {(p.thinking || offline || p.inCheck) && (
        <div className="pb-flags">
          {p.thinking && (
            <span className="pb-thinking" title="Đang nghĩ">
              <span className="pb-thinking-text">Đang nghĩ</span>
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          )}
          {offline && (
            <span className="pb-offline" title={`Mất kết nối — nếu sau ${p.reconnectSec} giây chưa vào lại sẽ bị xử thua`}>
              <Icon name="wifi-off" size={13} />
              <span className="pb-offline-text">Mất kết nối ·</span>
              <span className="num">{p.reconnectSec} giây</span>
            </span>
          )}
          {p.inCheck && <span className="pb-check">Chiếu!</span>}
        </div>
      )}
      {timed && (
        <div
          className={`clock${p.active ? ' running' : ''}${low ? ' low' : ''}${critical ? ' critical' : ''}`}
          role="timer"
          aria-label={`Đồng hồ của ${p.name}`}
        >
          {formatClock(ms)}
        </div>
      )}
    </div>
  );
}
