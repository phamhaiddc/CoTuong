import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { GameType } from '@cotuong/game-core';
import { GAME_LABEL, PRIVATE_ROOM_TTL_MS, type RoomDto } from '@cotuong/shared';
import { GameIcon, Icon, type IconName } from './icons';

export function Avatar({ name, url, size = 32 }: { name: string; url: string | null | undefined; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  if (url) {
    return <img className="avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="avatar avatar-initials"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 52% 48%), hsl(${(hue + 28) % 360} 48% 36%))`,
      }}
    >
      {initials || '?'}
    </span>
  );
}

/** Màu theo cấp bậc: level 0 = Tân thủ ... 6 = Kỳ vương */
export const TIER_COLORS = ['#8d8d8d', '#5f8f6c', '#3f7cac', '#7b5ea7', '#c0392b', '#d35400', '#c9a227'];

export function tierColor(level: number | null | undefined): string {
  return TIER_COLORS[Math.max(0, Math.min(TIER_COLORS.length - 1, level ?? 0))];
}

/** Biểu tượng + tên cấp bậc */
export function TierBadge({ name, level }: { name: string | null; level: number | null }) {
  if (!name || level === null) return null;
  const color = tierColor(level);
  const stars = Math.max(1, Math.min(3, (level % 3) + 1));
  return (
    <span className="tier-badge" title={name} style={{ color }}>
      <svg viewBox="0 0 20 22" width="14" height="15" aria-hidden="true">
        <path d="M10 1 L18 4.5 V11 C18 16 14.5 19.5 10 21 C5.5 19.5 2 16 2 11 V4.5 Z" fill={color} />
        {level >= 6 ? (
          <path d="M5 9 L7.5 12 L10 7 L12.5 12 L15 9 L14 15 H6 Z" fill="#fff" />
        ) : (
          Array.from({ length: stars }, (_, i) => <circle key={i} cx={10 + (i - (stars - 1) / 2) * 4.2} cy={11.5} r={1.6} fill="#fff" />)
        )}
      </svg>
      {/* Chữ pha thêm màu chữ thường để đủ tương phản (≥ 4.5:1) ở cả nền sáng và tối; khiên giữ màu cấp bậc */}
      <span className="tier-name" style={{ color: `color-mix(in srgb, ${color} 60%, var(--text))` }}>
        {name}
      </span>
    </span>
  );
}

export function RankMedal({ rank }: { rank: number }) {
  if (rank > 3) return <span className="rank-num">{rank}</span>;
  const cls = ['gold', 'silver', 'bronze'][rank - 1];
  return (
    <span className={`medal medal-${cls}`} title={`Hạng ${rank}`}>
      {rank}
    </span>
  );
}

/**
 * Hộp thoại. Được render vào document.body (portal) nên luôn nằm trên cùng, không bị cha cắt.
 * Trên điện thoại hiển thị dạng tấm trượt từ dưới lên.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  actions,
  dismissable = true,
  icon,
  tone,
}: {
  open: boolean;
  title: string;
  onClose?: () => void;
  children: ReactNode;
  actions?: ReactNode;
  dismissable?: boolean;
  /** Biểu tượng tròn phía trên tiêu đề */
  icon?: IconName;
  tone?: 'primary' | 'danger' | 'ok' | 'warn' | 'gold';
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Giá trị mới nhất cho phím Esc: trang ván đấu vẽ lại nhiều lần mỗi giây (đồng hồ) và truyền onClose mới mỗi lần —
  // không được để việc đó chạy lại hiệu ứng bên dưới (sẽ kéo tiêu điểm về nút đầu tiên liên tục)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    // Chỉ đặt tiêu điểm một lần khi mở: nút đánh dấu data-autofocus (nút an toàn khi nút chính là thao tác khó hoàn tác,
    // vd "Chơi lại" bỏ ván đang chơi), không thì nút chính (.btn-primary), không nữa thì nút đầu tiên của hàng nút (các hộp
    // thoại đặt nút an toàn như "Không, chơi tiếp" trước nút nguy hiểm .btn-danger)
    const box = ref.current;
    const target =
      box?.querySelector<HTMLElement>('.modal-actions [data-autofocus]:not(:disabled)') ??
      box?.querySelector<HTMLElement>('.modal-actions .btn-primary:not(:disabled)') ??
      box?.querySelector<HTMLElement>('.modal-actions button:not(:disabled), .modal-actions a[href]') ??
      box?.querySelector<HTMLElement>('button:not(:disabled)');
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissRef.current) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onClick={() => dismissable && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        {icon && (
          <div className={`modal-icon tone-${tone ?? 'primary'}`}>
            <Icon name={icon} size={26} />
          </div>
        )}
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function GameTabs({
  value,
  onChange,
  size = 'md',
  withIcons = false,
  className,
}: {
  value: GameType;
  onChange: (g: GameType) => void;
  size?: 'sm' | 'md';
  withIcons?: boolean;
  className?: string;
}) {
  return (
    <div className={`seg seg-${size}${className ? ` ${className}` : ''}`} role="tablist" aria-label="Chọn loại cờ">
      {(['xiangqi', 'chess'] as const).map((g) => (
        <button key={g} role="tab" aria-selected={value === g} className={value === g ? 'active' : ''} onClick={() => onChange(g)}>
          {withIcons && <GameIcon game={g} size={18} />}
          {GAME_LABEL[g]}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  );
}

/** Trạng thái rỗng: biểu tượng mờ + lời nhắn */
export function EmptyState({ icon = 'info', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} strokeWidth={1.6} />
      <div>{children}</div>
    </div>
  );
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

/** Đồng hồ cho phần đếm giờ: cập nhật mỗi `ms` khi `active` (vd. đang chờ ghép trận) */
export function useNow(active: boolean, ms = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return now;
}

/* ------------------------------------------------------------------ Phòng riêng (trang chủ và trang Cờ úp) */

/** Phòng riêng chưa có người vào tự huỷ sau chừng này phút */
export const ROOM_TTL_MINUTES = Math.round(PRIVATE_ROOM_TTL_MS / 60_000);

/** "10 phút + 5 giây/nước" — dễ hiểu hơn ký hiệu "10+5" */
export function timeControlText(tc: { initialMs: number; incrementMs: number }): string {
  const min = tc.initialMs / 60_000;
  const inc = tc.incrementMs / 1000;
  const minText = Number.isInteger(min) ? String(min) : min.toFixed(1);
  return inc > 0 ? `${minText} phút + ${inc} giây/nước` : `${minText} phút, không cộng giờ`;
}

/** Tên trò chơi của phòng riêng (phòng Cờ úp dùng bàn cờ tướng nhưng là trò khác) */
export function roomGameLabel(room: RoomDto): string {
  return room.variant === 'jieqi' ? 'Cờ úp' : GAME_LABEL[room.game];
}

/** Lấy mã phòng từ chuỗi người dùng nhập (cho phép dán cả đường dẫn mời) */
export function normalizeRoomCode(raw: string): string {
  const fromLink = /\/room\/([A-Za-z0-9]{6})/.exec(raw);
  return (fromLink ? fromLink[1] : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}
