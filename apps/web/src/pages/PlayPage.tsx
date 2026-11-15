import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  JieqiGame,
  otherColor,
  replayGame,
  replayJieqiPublic,
  type Color,
  type GameEngine,
  type GameResult,
  type GameType,
  type GameWarning,
} from '@cotuong/game-core';
import {
  COLOR_LABEL,
  END_REASON_LABEL,
  ERROR_CODES,
  FIRST_MOVE_TIMEOUT_MS,
  GAME_LABEL,
  RANKED_RULES,
  RATING_FLOOR,
  RECONNECT_GRACE_MS,
  type ChatMessageDto,
  type MatchEndedDto,
  type MatchStateDto,
  type MoveEventDto,
  type RatingChangeDto,
} from '@cotuong/shared';
import { emit, socket } from '../api/socket';
import { GameBoard, lastMoveOf } from '../components/Board';
import { ChatForm, ChatMessages } from '../components/ChatPanel';
import { GameIcon, Icon, type IconName } from '../components/icons';
import { useFocusMode } from '../components/Layout';
import { MoveList } from '../components/MoveList';
import { PlayerBar, capturedList } from '../components/PlayerBar';
import { Modal, Spinner, TierBadge, signed } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useRealtime } from '../state/realtime';
import { useToast } from '../state/toast';

export function warningText(game: 'xiangqi' | 'chess', w: GameWarning): string {
  if (w.type === 'repetition') {
    return game === 'xiangqi'
      ? 'Thế cờ này đã lặp lại 2 lần. Nếu lặp lần thứ 3: bên nào chiếu liên tục (chiếu dai) bị xử thua, nếu không thì hoà.'
      : 'Thế cờ này đã lặp lại 2 lần. Nếu lặp lần thứ 3, ván tự động hoà.';
  }
  return `Đã ${50 - w.movesLeft} nước không ăn quân, không đi Tốt. Thêm ${w.movesLeft} nước như vậy nữa thì ván hoà (luật 50 nước).`;
}

/**
 * Lý do kết thúc theo góc nhìn người chơi: "Đối thủ đầu hàng", "Bạn hết giờ"…
 * (nhãn chung "Đầu hàng", "Hết giờ" không cho biết bên nào). my = null (người xem) → nhãn chung.
 */
export function endReasonText(game: GameType, result: GameResult, my: Color | null, opp = 'Đối thủ'): string {
  const generic = END_REASON_LABEL[result.reason] ?? result.reason;
  if (my === null || result.winner === null) return generic;
  const iWon = result.winner === my;
  const loser = iWon ? opp : 'Bạn';
  switch (result.reason) {
    case 'checkmate':
      return iWon ? `Bạn chiếu bí ${opp.toLowerCase()}` : 'Bạn bị chiếu bí';
    case 'stalemate':
      return game === 'xiangqi' ? `${loser} hết nước đi (cờ tướng: hết nước đi là thua)` : generic;
    case 'perpetual_check':
      return `${loser} bị xử thua vì chiếu dai`;
    case 'resign':
      return `${loser} đầu hàng`;
    case 'timeout':
      return `${loser} hết giờ`;
    case 'no_first_move':
      return `${loser} không đi nước đầu tiên trong ${FIRST_MOVE_TIMEOUT_MS / 1000} giây`;
    case 'disconnect':
      return `${loser} mất kết nối quá ${RECONNECT_GRACE_MS / 1000} giây`;
    default:
      return generic;
  }
}

/** Cảnh báo luật (lặp thế cờ, luật 50 nước) → thông báo trên thanh nổi của bàn cờ (có nút ẩn) */
export function warningNotices(game: 'xiangqi' | 'chess', warnings: GameWarning[]): BoardNotice[] {
  return warnings.map((w) => {
    const text = warningText(game, w);
    return { key: `w-${w.type}`, tone: 'info', icon: 'info', text, title: text, dismissible: true };
  });
}

// --------------------------------------------------------------------------- Thành phần dùng chung cho các màn hình ván đấu

/** "10 phút mỗi bên, cộng 5 giây mỗi nước" */
export function timeControlTitle(tc: { initialMs: number; incrementMs: number } | null | undefined): string {
  if (!tc) return 'Không giới hạn thời gian';
  const min = tc.initialMs / 60_000;
  const inc = tc.incrementMs / 1000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} phút mỗi bên${inc ? `, cộng ${inc} giây mỗi nước` : ''}`;
}

/** Chữ trên chip thời gian, đọc được không cần biết ký hiệu "15+10": "15 phút + 10 giây/nước" */
export function timeControlShort(tc: { initialMs: number; incrementMs: number } | null | undefined): string {
  if (!tc) return 'Không giới hạn thời gian';
  const min = tc.initialMs / 60_000;
  const inc = tc.incrementMs / 1000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} phút${inc ? ` + ${inc} giây/nước` : ''}`;
}

/**
 * Thông tin ván: loại ván, game, luật thời gian (máy tính: đầu khung bên phải; điện thoại: thẻ cuối trang).
 * tc: chữ trên chip thời gian (nên dùng timeControlShort); tcTitle: câu đầy đủ (rê chuột / trình đọc màn hình)
 */
export function GameHead({ game, title, sub, tc, tcTitle }: { game: GameType; title: string; sub: ReactNode; tc: string; tcTitle?: string }) {
  return (
    <header className="game-head">
      <span className="gh-icon">
        <GameIcon game={game} size={30} />
      </span>
      <div className="gh-text">
        <h1 className="gh-title">{title}</h1>
        <div className="gh-sub">{sub}</div>
      </div>
      <span className="chip gh-tc" title={tcTitle}>
        <Icon name="clock" size={13} />
        {tc}
      </span>
    </header>
  );
}

export type StatusTone = 'turn' | 'wait' | 'think' | 'check' | 'win' | 'loss' | 'draw' | 'neutral';
const STATUS_ICON: Partial<Record<StatusTone, IconName>> = {
  wait: 'clock',
  check: 'alert',
  win: 'trophy',
  loss: 'flag',
  draw: 'draw',
  neutral: 'flag',
};

/** Ô trạng thái nổi bật: "Đến lượt bạn", "Chiếu!", kết quả ván… */
export function StatusCard({ tone, title, sub, children }: { tone: StatusTone; title: string; sub?: ReactNode; children?: ReactNode }) {
  const icon = STATUS_ICON[tone];
  return (
    <div className={`status-card tone-${tone}`} role="status" aria-live="polite">
      <span className="status-icon" aria-hidden="true">
        {tone === 'think' ? (
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
        ) : icon ? (
          <Icon name={icon} size={20} />
        ) : (
          <span className="live-dot" />
        )}
      </span>
      {/* key theo tiêu đề: chữ đổi thì chạy hiệu ứng xuất hiện, khung aria-live vẫn giữ nguyên */}
      <div className="status-text" key={`${tone}:${title}`}>
        <div className="status-title">{title}</div>
        {sub && <div className="status-sub">{sub}</div>}
      </div>
      {children && <div className="status-extra">{children}</div>}
    </div>
  );
}

/** Phần thân hộp thoại kết quả: lý do, điểm hạng (to, có màu), trước → sau, đổi cấp */
/** Các luật xếp hạng đã áp dụng cho ván vừa xong (5 ván đầu mùa, hệ số trừ theo cấp, chuỗi thắng) */
function ratingRuleNotes(c: RatingChangeDto): string[] {
  const r = c.rules;
  if (!r) return [];
  const dec = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  const notes: string[] = [];
  if (r.placement) notes.push(`${RANKED_RULES.placementGames} ván đầu mùa: điểm cộng ×${dec(RANKED_RULES.placementMultiplier)}`);
  if (r.lossMultiplier > 1) notes.push(`Cấp ${c.tierBefore}: điểm trừ ×${dec(r.lossMultiplier)}`);
  if (r.streakBonus > 0) notes.push(`Chuỗi ${r.winStreak} ván thắng: +${r.streakBonus}`);
  return notes;
}

export function ResultDetails({
  reason,
  change,
  note,
  lost,
}: {
  reason?: string;
  change?: RatingChangeDto | null;
  note?: ReactNode;
  /** Người chơi thua ván này (để giải thích sàn điểm khi thua mà không bị trừ hết) */
  lost?: boolean;
}) {
  // Thua khi điểm chạm sàn: giải thích vì sao bị trừ ít / không bị trừ
  const floorNote =
    lost && change && change.after === RATING_FLOOR
      ? change.before === RATING_FLOOR
        ? `Bạn đang có ${RATING_FLOOR} điểm hạng. Điểm hạng không xuống dưới ${RATING_FLOOR} nên ván thua này không bị trừ điểm.`
        : `Điểm hạng không xuống dưới ${RATING_FLOOR}, nên bạn chỉ bị trừ về ${RATING_FLOOR}.`
      : null;
  return (
    <div className="result-details">
      {reason && (
        <p className="result-reason">
          <Icon name="info" size={16} />
          {reason}
        </p>
      )}
      {change && (
        <div className={`rating-change ${change.delta > 0 ? 'up' : change.delta < 0 ? 'down' : 'zero'}`}>
          <div className="rc-delta num">{signed(change.delta)}</div>
          <div className="rc-detail">
            <div className="rc-label">Điểm hạng</div>
            <div className="rc-range num">
              {change.before}
              <Icon name="arrow-right" size={14} />
              <b>{change.after}</b>
            </div>
          </div>
          {change.change && (
            <div className={`tier-change ${change.change === 'promoted' ? 'up' : 'down'}`}>
              <span className="tc-label">{change.change === 'promoted' ? 'Thăng cấp' : 'Xuống cấp'}</span>
              <TierBadge name={change.tierBefore} level={change.tierLevelBefore} />
              <Icon name="arrow-right" size={14} />
              <TierBadge name={change.tierAfter} level={change.tierLevelAfter} />
            </div>
          )}
        </div>
      )}
      {change && ratingRuleNotes(change).length > 0 && (
        <ul className="rc-rules" aria-label="Luật xếp hạng đã áp dụng">
          {ratingRuleNotes(change).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {floorNote && <p className="result-note">{floorNote}</p>}
      {note && <p className="result-note">{note}</p>}
    </div>
  );
}

/** Hỏi lại trước nước đi khiến người chơi bị xử thua vì chiếu dai (cờ tướng) */
export function PerpetualModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Đi nước này là thua"
      icon="alert"
      tone="warn"
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn btn-primary" onClick={onCancel}>
            Chọn nước khác
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Vẫn đi (chịu thua)
          </button>
        </>
      }
    >
      Nước này làm thế cờ lặp lại lần thứ 3 trong khi bạn chiếu liên tục — đó là <b>chiếu dai</b>, bạn sẽ bị xử thua ngay.
    </Modal>
  );
}

/** Khung chờ khi đang vào bàn cờ: giữ đúng bố cục để trang không bị nhảy */
export function PlaySkeleton({ game, label }: { game: GameType; label: string }) {
  return (
    <div className={`play play-skeleton game-${game}`} aria-busy="true">
      <div className="sk-col">
        <div className="sk-bar skeleton" />
        <div className="sk-board skeleton" />
        <div className="sk-bar skeleton" />
      </div>
      <div className="sk-side">
        <Spinner label={label} />
      </div>
    </div>
  );
}

/** Trang lỗi gọn (không vào được ván, không tải được ván…) */
export function PlayError({ icon, title, message, children }: { icon: IconName; title: string; message: string; children?: ReactNode }) {
  return (
    <div className="play-error">
      <div className="panel">
        <span className="pe-icon">
          <Icon name={icon} size={28} />
        </span>
        <h1 className="panel-title">{title}</h1>
        <p className="muted">{message}</p>
        <div className="pe-actions">{children}</div>
      </div>
    </div>
  );
}

export function resultLook(winner: Color | null, my: Color | null): { tone: 'win' | 'loss' | 'draw' | 'neutral'; icon: IconName; modalTone: 'gold' | 'danger' | 'warn' | 'primary' } {
  if (winner === null) return { tone: 'draw', icon: 'draw', modalTone: 'warn' };
  if (my === null) return { tone: 'neutral', icon: 'flag', modalTone: 'primary' };
  return winner === my ? { tone: 'win', icon: 'trophy', modalTone: 'gold' } : { tone: 'loss', icon: 'flag', modalTone: 'danger' };
}

// --------------------------------------------------------------------------- Khung màn hình ván đấu (GameScreen)

/** Một tab ở giữa khung bên phải (Nước đi, Trò chuyện…) */
export interface GameTab {
  id: string;
  label: string;
  icon?: IconName;
  /** Số nhỏ cạnh nhãn (vd. số nước đã đi) */
  count?: number;
  /** Huy hiệu nổi bật khi tab không mở (vd. số tin chưa đọc) */
  badge?: number;
  /** Điện thoại: thêm nút tắt mở tab này ở thanh thao tác dưới bàn cờ */
  quick?: boolean;
  content: ReactNode;
}

export type NoticeTone = 'warn' | 'info' | 'offer' | 'wait' | 'think';

/** Thông báo trong ván. Máy tính: thanh mảnh nổi ở mép trên bàn cờ; điện thoại: thẻ ngay dưới thanh thao tác. */
export interface BoardNotice {
  key: string;
  tone: NoticeTone;
  icon?: IconName;
  text: ReactNode;
  /** Câu đầy đủ (hiện khi rê chuột, vì trên thanh nổi chữ dài bị cắt) */
  title?: string;
  /** Nút trả lời (vd. Đồng ý / Từ chối) */
  actions?: ReactNode;
  /** Thông báo chỉ để biết: có nút ẩn để không che bàn cờ */
  dismissible?: boolean;
  /** Chỉ hiện trên thanh nổi (máy tính), vd. "Máy đang nghĩ…" — điện thoại đã có chỉ báo ở thanh người chơi */
  overlayOnly?: boolean;
}

export interface GameScreenProps {
  game: GameType;
  /** Lớp thêm cho khung (vd. "replay") */
  className?: string;
  ended?: boolean;
  /** <GameHead> */
  head: ReactNode;
  /** Thanh người chơi phía trên bàn cờ (đối thủ) */
  top: ReactNode;
  /** Thanh người chơi phía dưới bàn cờ (mình) */
  bottom: ReactNode;
  /** <GameBoard> */
  board: ReactNode;
  /** Theo thứ tự ưu tiên (quan trọng nhất trước) */
  notices?: BoardNotice[];
  /** <StatusCard> (+ dòng phụ nếu có) */
  status: ReactNode;
  /** Nút thao tác của ván (Cầu hoà, Đầu hàng… / điều khiển xem lại) */
  toolbar: ReactNode;
  /** Có thì hiện nút "Lật bàn" */
  onFlip?: () => void;
  tabs: GameTab[];
  /** Tab đang mở (điều khiển từ trang); bỏ trống thì khung tự quản lý */
  tab?: string;
  /** byUser = người dùng tự chọn tab (bấm tab / nút tắt) */
  onTabChange?: (id: string, byUser: boolean) => void;
  /** Nằm dưới nội dung tab, luôn hiện (vd. ô nhập tin nhắn) */
  sideBottom?: ReactNode;
  /** Ghi chú nhỏ cuối khung bên */
  sideFooter?: ReactNode;
  /** Hộp thoại (Modal) của trang */
  children?: ReactNode;
}

const NOTICE_CLASS: Record<NoticeTone, string> = {
  warn: 'notice warn',
  info: 'notice info',
  offer: 'notice offer',
  wait: 'notice wait',
  think: 'notice think',
};

function NoticeItem({ n, onDismiss }: { n: BoardNotice; onDismiss?: () => void }) {
  return (
    <div className={`${NOTICE_CLASS[n.tone]}${n.overlayOnly ? ' overlay-only' : ''}`} title={n.title}>
      {n.tone === 'wait' ? (
        <span className="spinner spinner-sm" aria-hidden="true" />
      ) : n.tone === 'think' ? (
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : n.icon ? (
        <Icon name={n.icon} size={18} />
      ) : null}
      <span className="notice-text">{n.text}</span>
      {n.actions && <div className="offer-actions">{n.actions}</div>}
      {onDismiss && (
        <button type="button" className="notice-close" onClick={onDismiss} aria-label="Ẩn thông báo" title="Ẩn thông báo">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

function TabBar({ tabs, active, idBase, onSelect }: { tabs: GameTab[]; active: string; idBase: string; onSelect: (id: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    let j: number;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    else return;
    e.preventDefault();
    onSelect(tabs[j].id);
    refs.current[j]?.focus();
  };
  return (
    <div className="gs-tabs" role="tablist" aria-label="Nội dung khung bên" onKeyDown={onKey}>
      {tabs.map((t, i) => {
        const sel = t.id === active;
        const badge = !sel && t.badge ? t.badge : 0;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-controls={`${idBase}-panel-${t.id}`}
            aria-selected={sel}
            tabIndex={sel ? 0 : -1}
            className={`gs-tab${sel ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            {t.icon && <Icon name={t.icon} size={17} />}
            <span className="gs-tab-label">{t.label}</span>
            {t.count != null && t.count > 0 && <span className="gs-tab-count num">{t.count}</span>}
            {badge > 0 && (
              <span className="gs-tab-badge num" aria-label={`${badge} mới`}>
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Khung chung của màn hình ván đấu (PvP, đấu với máy, xem lại; sau này cờ úp).
 * Máy tính: bàn cờ lớn ở giữa (thông báo nổi ở mép trên, thanh thao tác mảnh ở dưới) + khung bên phải
 * (thông tin ván · đối thủ + đồng hồ · tab Nước đi / Trò chuyện · trạng thái · mình + đồng hồ).
 * Điện thoại: xếp chồng — xem play.css.
 */
export function GameScreen(p: GameScreenProps) {
  const { focus, setFocus } = useFocusMode();
  const idBase = useId().replace(/:/g, '');
  const sideRef = useRef<HTMLElement>(null);
  const [ownTab, setOwnTab] = useState(p.tabs[0]?.id ?? '');
  const active = p.tabs.some((t) => t.id === (p.tab ?? ownTab)) ? (p.tab ?? ownTab) : (p.tabs[0]?.id ?? '');
  const select = (id: string) => {
    setOwnTab(id);
    p.onTabChange?.(id, true);
  };
  const openTab = (id: string) => {
    select(id);
    sideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Thông báo đã ẩn: hiện lại khi thông báo đó mất đi rồi xuất hiện lại
  const notices = p.notices ?? [];
  const [dismissed, setDismissed] = useState<string[]>([]);
  const noticeKeys = notices.map((n) => n.key).join('|');
  useEffect(() => {
    const keys = noticeKeys.split('|');
    setDismissed((d) => (d.every((k) => keys.includes(k)) ? d : d.filter((k) => keys.includes(k))));
  }, [noticeKeys]);
  const shown = notices.filter((n) => !dismissed.includes(n.key));

  const single = p.tabs.length === 1;
  const sideLabel = p.tabs.map((t) => t.label).join(' và ');

  return (
    <div className={['play', 'gs', `game-${p.game}`, p.ended && 'is-ended', p.className].filter(Boolean).join(' ')}>
      {p.head}

      <section className="board-col" aria-label="Bàn cờ">
        {p.top}
        <div className="board-area">{p.board}</div>
        {p.bottom}
      </section>

      {shown.length > 0 && (
        <div className={`gs-notices${shown.every((n) => n.overlayOnly) ? ' overlay-only' : ''}`}>
          <div className="gs-notices-inner">
            {shown.map((n) => (
              <NoticeItem key={n.key} n={n} onDismiss={n.dismissible ? () => setDismissed((d) => [...d, n.key]) : undefined} />
            ))}
          </div>
        </div>
      )}

      <div className="dock">
        <div className="gs-status">{p.status}</div>
        <div className="gs-toolbar">
          <div className="gs-view" role="group" aria-label="Hiển thị">
            {p.onFlip && (
              <button type="button" className="btn btn-quiet btn-sm act act-flip" onClick={p.onFlip} title="Lật bàn cờ: xem từ phía bên kia" aria-label="Lật bàn cờ">
                <Icon name="flip" size={18} />
                <span className="act-label">Lật bàn</span>
              </button>
            )}
            <button
              type="button"
              className={`btn btn-quiet btn-sm act act-focus${focus ? ' on' : ''}`}
              onClick={() => setFocus(!focus)}
              aria-pressed={focus}
              title={focus ? 'Đang ở chế độ tập trung — bấm để hiện lại menu' : 'Chế độ tập trung: ẩn menu bên trái'}
            >
              <Icon name="focus" size={18} />
              <span className="act-label">Chế độ tập trung</span>
            </button>
            {p.tabs
              .filter((t) => t.quick)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="btn btn-ghost btn-sm act act-quick"
                  onClick={() => openTab(t.id)}
                  aria-label={t.badge ? `${t.label}, ${t.badge} mới` : t.label}
                >
                  <span className="act-icon">
                    <Icon name={t.icon ?? 'list'} size={18} />
                    {t.badge ? <span className="act-badge num">{t.badge > 9 ? '9+' : t.badge}</span> : null}
                  </span>
                  <span className="act-label">{t.label}</span>
                </button>
              ))}
          </div>
          {p.toolbar}
        </div>
      </div>

      <aside className="side-col" aria-label={sideLabel} ref={sideRef}>
        {single ? (
          <div className="gs-tabs single">
            <h2 className="gs-tab active" id={`${idBase}-tab-${p.tabs[0].id}`}>
              {p.tabs[0].icon && <Icon name={p.tabs[0].icon} size={17} />}
              <span className="gs-tab-label">{p.tabs[0].label}</span>
              {p.tabs[0].count != null && p.tabs[0].count > 0 && <span className="gs-tab-count num">{p.tabs[0].count}</span>}
            </h2>
          </div>
        ) : (
          <TabBar tabs={p.tabs} active={active} idBase={idBase} onSelect={select} />
        )}
        {p.tabs.map((t) => (
          <div
            key={t.id}
            className={`gs-panel gs-panel-${t.id}`}
            id={`${idBase}-panel-${t.id}`}
            role={single ? undefined : 'tabpanel'}
            aria-labelledby={`${idBase}-tab-${t.id}`}
            hidden={t.id !== active}
          >
            {t.content}
          </div>
        ))}
        {p.sideBottom}
        {p.sideFooter && <div className="gs-foot">{p.sideFooter}</div>}
      </aside>

      {p.children}
    </div>
  );
}

// --------------------------------------------------------------------------- Trang ván đấu PvP

/** Lời nhắc khách đã ẩn (trong thẻ trình duyệt này) */
const GUEST_HINT_KEY = 'cotuong.guestHint.hidden';

function guestHintHidden(): boolean {
  try {
    return sessionStorage.getItem(GUEST_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Khách đang chơi: nhắc nhẹ ở cuối khung bên (không che bàn cờ; không kèm liên kết để khỏi lỡ tay rời ván đang chơi).
 * Bấm ẩn thì không hiện lại nữa trong thẻ trình duyệt này.
 */
function GuestPlayHint() {
  const [hidden, setHidden] = useState(guestHintHidden);
  if (hidden) return null;
  return (
    <p className="side-note guest-hint">
      <Icon name="user" size={15} />
      <span className="grow">Bạn đang chơi với tư cách khách. Đăng nhập để chơi xếp hạng và lưu lịch sử ván.</span>
      <button
        type="button"
        className="notice-close"
        aria-label="Ẩn lời nhắc"
        title="Ẩn lời nhắc"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(GUEST_HINT_KEY, '1');
          } catch {
            /* trình duyệt chặn sessionStorage: chỉ ẩn ở trang này */
          }
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </p>
  );
}

type JoinOutcome = 'ok' | 'conflict' | 'error';

export function PlayPage() {
  const { matchId = '' } = useParams();
  // player: danh tính để chơi (thành viên hoặc khách); me: chỉ thành viên (xem lại ván cần tài khoản)
  const { me, player, refresh } = useAuth();
  const playerId = player?.id;
  const { connected, joinQueue } = useRealtime();
  const { game: selectedGame, setGame } = useGameSelect();
  const toast = useToast();
  const navigate = useNavigate();

  const [state, setState] = useState<MatchStateDto | null>(null);
  const [clockAt, setClockAt] = useState(Date.now());
  const [chat, setChat] = useState<ChatMessageDto[]>([]);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const stateRef = useRef<MatchStateDto | null>(null);
  stateRef.current = state;
  const [ver, setVer] = useState(0);
  const [pending, setPending] = useState(false);
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [flip, setFlip] = useState(false);
  /** Đối thủ vừa từ chối lời mời hoà (thông báo trên bàn cờ, tự ẩn sau vài giây) */
  const [drawDeclined, setDrawDeclined] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!drawDeclined) return;
    const id = window.setTimeout(() => setDrawDeclined(false), 6000);
    return () => window.clearTimeout(id);
  }, [drawDeclined]);

  // Tab này đã vào bàn thành công ít nhất một lần (để phân biệt mở trang mới với kết nối lại)
  const joinedOnceRef = useRef(false);
  /**
   * Bàn cờ đang khớp với máy chủ: false từ lúc mất kết nối cho tới khi vào lại bàn thành công. Trong lúc đó socket mới
   * chưa ở trong phòng của ván nên không nhận nước đi của đối thủ — bàn cờ và đồng hồ trên màn hình có thể đã cũ.
   */
  const [synced, setSynced] = useState(false);
  /** Đang tự thử vào lại bàn (lỗi "ván đang mở ở nơi khác" sau khi kết nối lại) */
  const [rejoining, setRejoining] = useState(false);
  const join = useCallback(async (): Promise<JoinOutcome> => {
    const r = await emit('match:join', { matchId });
    if (!r.ok) {
      const conflict = r.code === ERROR_CODES.SESSION_CONFLICT;
      setError({ message: r.error, conflict });
      return conflict ? 'conflict' : 'error';
    }
    setError(null);
    setSynced(true);
    // Cờ úp: chỉ có thông tin công khai (nước đi + lật quân), không có chuỗi xếp quân
    engineRef.current =
      r.state.variant === 'jieqi' ? replayJieqiPublic(r.state.moves, r.state.reveals ?? []) : replayGame(r.state.game, r.state.moves);
    setState(r.state);
    setClockAt(Date.now());
    setChat(r.chat);
    setVer((v) => v + 1);
    setGame(r.state.game);
    if (r.state.status === 'ended') {
      // Ván đã xong (có thể kết thúc khi mình ở trang khác): đóng hộp thoại hỏi dở, tải lại thông tin "ván đang chơi"
      setConfirmResign(false);
      setConfirmMove(null);
      void refresh();
    }
    return 'ok';
  }, [matchId, setGame, refresh]);

  useEffect(() => {
    if (!connected) setSynced(false);
  }, [connected]);

  // Vào bàn khi mở trang và mỗi lần kết nối lại (để server biết người chơi đã quay lại)
  useEffect(() => {
    if (!connected || !playerId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    // Tab này đã từng vào bàn rồi mà giờ kết nối lại (rớt mạng / đổi mạng): socket cũ của CHÍNH tab này có thể còn được
    // máy chủ coi là đang kết nối tới ~45 giây (hết hạn ping) → thử lại lâu hơn thay vì bỏ cuộc trong khi đồng hồ vẫn chạy
    const reconnecting = joinedOnceRef.current;
    const maxAttempts = reconnecting ? 17 : 2;
    const delay = reconnecting ? 3000 : 1500;
    const attempt = async () => {
      // Đã rời trang / kết nối lại lần nữa: không gửi match:join (sẽ gắn socket của tab đã rời ván vào lại ván)
      if (cancelled) return;
      const res = await join();
      if (cancelled) return;
      if (res === 'ok') joinedOnceRef.current = true;
      // Tab cũ vừa đóng có thể chưa kịp báo ngắt kết nối: thử lại
      const retry = res === 'conflict' && attempts++ < maxAttempts;
      setRejoining(retry);
      if (retry) timer = window.setTimeout(() => void attempt(), delay);
    };
    void attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setRejoining(false);
    };
  }, [connected, playerId, join]);

  useEffect(() => {
    return () => {
      void emit('match:leave', { matchId });
    };
  }, [matchId]);

  useEffect(() => {
    const onMove = (e: MoveEventDto) => {
      if (e.matchId !== matchId) return;
      const eng = engineRef.current;
      if (!eng) return;
      const h = eng.history();
      if (h.length === e.ply - 1) {
        if (!(eng instanceof JieqiGame ? eng.play(e.move, e.reveal ?? null) : eng.play(e.move))) {
          void join();
          return;
        }
      } else if (!(h.length === e.ply && h[h.length - 1] === e.move)) {
        void join();
        return;
      }
      setState((s) =>
        s
          ? {
              ...s,
              moves: eng.history(),
              clock: e.clock,
              firstMoveDeadline: e.firstMoveDeadline,
              warnings: e.warnings,
              drawOfferBy: null,
            }
          : s,
      );
      setClockAt(Date.now());
      setVer((v) => v + 1);
    };
    const onEnded = (e: MatchEndedDto) => {
      if (e.matchId !== matchId) return;
      setState((s) =>
        s
          ? {
              ...s,
              status: 'ended',
              result: e.result,
              clock: { ...e.clock, running: false },
              ratingChanges: e.ratingChanges,
              drawOfferBy: null,
              firstMoveDeadline: null,
              disconnectedUntil: [null, null],
              warnings: [],
            }
          : s,
      );
      setClockAt(Date.now());
      // Đang mở hộp thoại hỏi "Đầu hàng?" / nước phạm luật: ván đã xong nên đóng lại, chỉ còn hộp thoại kết quả
      setConfirmResign(false);
      setConfirmMove(null);
      // Hộp thoại kết quả đã hiện điểm hạng + thăng / xuống cấp → không bật thêm thông báo nổi trùng lặp
      setShowResult(true);
      setDrawDeclined(false);
      void refresh();
    };
    // Lời mời hoà / bị từ chối hiện ngay trên bàn cờ (thanh thông báo) — không bật thông báo nổi che thanh thao tác
    const onDrawOffer = (p: { matchId: string; by: Color }) => {
      if (p.matchId !== matchId) return;
      setState((s) => (s ? { ...s, drawOfferBy: p.by } : s));
      setDrawDeclined(false);
    };
    const onDrawDeclined = (p: { matchId: string; by: Color }) => {
      if (p.matchId !== matchId) return;
      setState((s) => (s ? { ...s, drawOfferBy: null } : s));
      if (p.by !== stateRef.current?.myColor) setDrawDeclined(true);
    };
    const onConnection = (p: { matchId: string; color: Color; disconnectedUntil: number | null }) => {
      if (p.matchId !== matchId) return;
      setState((s) => {
        if (!s) return s;
        const d: [number | null, number | null] = [...s.disconnectedUntil];
        d[p.color] = p.disconnectedUntil;
        return { ...s, disconnectedUntil: d };
      });
      // Không đặt lại mốc đồng hồ ở đây: sự kiện này không kèm giờ máy chủ (đặt lại sẽ làm đồng hồ nhảy lùi)
    };
    const onChat = (m: ChatMessageDto) => {
      if (m.matchId === matchId) setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, m]));
    };
    const onChatDeleted = (p: { matchId: string; messageId: string }) => {
      if (p.matchId === matchId) setChat((c) => c.filter((m) => m.id !== p.messageId));
    };
    socket.on('match:move', onMove);
    socket.on('match:ended', onEnded);
    socket.on('match:drawOffer', onDrawOffer);
    socket.on('match:drawDeclined', onDrawDeclined);
    socket.on('match:connection', onConnection);
    socket.on('chat:message', onChat);
    socket.on('chat:deleted', onChatDeleted);
    return () => {
      socket.off('match:move', onMove);
      socket.off('match:ended', onEnded);
      socket.off('match:drawOffer', onDrawOffer);
      socket.off('match:drawDeclined', onDrawDeclined);
      socket.off('match:connection', onConnection);
      socket.off('chat:message', onChat);
      socket.off('chat:deleted', onChatDeleted);
    };
  }, [matchId, join, refresh, toast]);

  const playing = state?.status === 'playing';
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => tick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [playing]);

  const submitMove = useCallback(
    async (move: string, confirmPerpetual = false) => {
      const eng = engineRef.current;
      const s = stateRef.current;
      if (!eng || !s || s.status !== 'playing') return;
      if (s.game === 'xiangqi' && !confirmPerpetual && eng.isPerpetualCheckLoss(move)) {
        setConfirmMove(move);
        return;
      }
      // Cờ úp: nước dính tới quân úp phải chờ server cho biết quân lộ ra là gì (không đi trước ở máy mình)
      const waitReveal = eng instanceof JieqiGame && eng.needsReveal(move);
      if (!waitReveal) {
        if (!eng.play(move)) return;
        setVer((v) => v + 1);
      } else if (!eng.isLegal(move)) return;
      setPending(true);
      const r = await emit('match:move', { matchId, move, confirmPerpetual });
      setPending(false);
      if (!r.ok) {
        if (r.code === ERROR_CODES.CONFIRM_PERPETUAL) {
          const h = eng.history();
          if (h[h.length - 1] === move) eng.undo();
          setVer((v) => v + 1);
          setConfirmMove(move);
          return;
        }
        toast(r.error, 'error');
        await join();
      }
    },
    [matchId, join, toast],
  );

  const engine = engineRef.current;
  const infos = useMemo(() => engine?.historyInfo() ?? [], [engine, ver]);

  // ------------------------------------------------ Tab "Nước đi" / "Trò chuyện" + tin chưa đọc
  const [tab, setTab] = useState('moves');
  /** Người dùng đã tự chọn tab: từ đó tin nhắn mới chỉ hiện huy hiệu, không tự mở tab Trò chuyện */
  const tabPickedRef = useRef(false);
  const chatLenRef = useRef<number | null>(null);
  useEffect(() => {
    setTab('moves');
    tabPickedRef.current = false;
    chatLenRef.current = null;
  }, [matchId]);
  const loaded = state !== null;
  const meId = playerId;
  // Đối thủ nhắn tin khi người dùng chưa tự chọn tab: mở tab Trò chuyện để thấy ngay
  useEffect(() => {
    if (!loaded) return;
    const prev = chatLenRef.current;
    chatLenRef.current = chat.length;
    if (prev === null || chat.length <= prev || tabPickedRef.current) return;
    if (chat.slice(prev).some((m) => m.userId !== meId)) setTab('chat');
  }, [loaded, chat, meId]);
  const onTabChange = useCallback((id: string, byUser: boolean) => {
    if (byUser) tabPickedRef.current = true;
    setTab(id);
  }, []);
  const openChatTab = useCallback(() => onTabChange('chat', true), [onTabChange]);

  // Đã xem tin = tab Trò chuyện đang mở và ô nhập đang trong tầm nhìn (điện thoại: khung chat nằm dưới màn hình)
  const [chatDockEl, setChatDockEl] = useState<HTMLElement | null>(null);
  const [chatDockInView, setChatDockInView] = useState(true);
  useEffect(() => {
    if (!chatDockEl || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([en]) => setChatDockInView(en.isIntersecting), { threshold: 0.6 });
    io.observe(chatDockEl);
    return () => io.disconnect();
  }, [chatDockEl]);
  const chatInView = tab === 'chat' && chatDockInView;
  const [chatSeen, setChatSeen] = useState<number | null>(null);
  useEffect(() => {
    // (tin bị admin xoá làm danh sách ngắn lại → kéo mốc "đã xem" về theo)
    if (loaded && (chatInView || chatSeen === null || chatSeen > chat.length)) setChatSeen(chat.length);
  }, [loaded, chatInView, chat.length, chatSeen]);
  // Vào ván: đưa bàn cờ lên đầu màn hình (router không tự cuộn về đầu khi chuyển trang)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [matchId]);

  if (!player) return <Spinner />;
  if (error && !state) {
    return (
      <PlayError
        icon={error.conflict ? 'monitor' : 'alert'}
        title={error.conflict ? 'Ván đang mở ở nơi khác' : 'Không vào được ván đấu'}
        message={error.message}
      >
        {error.conflict && (
          <button className="btn btn-primary" onClick={() => void join()}>
            <Icon name="restart" size={18} />
            Thử lại
          </button>
        )}
        <Link className="btn btn-ghost" to="/">
          <Icon name="home" size={18} />
          Về trang chủ
        </Link>
      </PlayError>
    );
  }
  if (!state || !engine) return <PlaySkeleton game={selectedGame} label="Đang vào bàn cờ…" />;

  const myColor = state.myColor;
  const opp: Color = myColor === null ? 1 : otherColor(myColor);
  const bottom: Color = (myColor ?? 0) === 0 ? (flip ? 1 : 0) : flip ? 0 : 1;
  const top: Color = otherColor(bottom);
  const serverNow = state.clock.serverNow + (Date.now() - clockAt);
  const turn = (state.moves.length % 2) as Color;
  const clocks: [number, number] = [state.clock.remaining[0], state.clock.remaining[1]];
  if (state.status === 'playing') clocks[turn] = Math.max(0, clocks[turn] - (serverNow - state.clock.turnStartedAt));
  const secsLeft = (deadline: number | null) => (deadline === null ? null : Math.max(0, Math.ceil((deadline - serverNow) / 1000)));
  const firstMoveSec = state.status === 'playing' ? secsLeft(state.firstMoveDeadline) : null;
  const myChange = myColor !== null ? state.ratingChanges?.[myColor] : null;
  const outcome =
    state.result && myColor !== null
      ? state.result.winner === null
        ? 'Hoà'
        : state.result.winner === myColor
          ? 'Bạn thắng!'
          : 'Bạn thua'
      : null;
  const inCheck = state.status === 'playing' && engine.inCheck();
  // Bên đang phải đi theo bàn cờ (đã gồm nước vừa đi chờ máy chủ xác nhận) — dùng cho báo "Chiếu!"; đồng hồ vẫn theo máy chủ
  const boardTurn = engine.turn() as Color;
  const unread = chatSeen === null ? 0 : chat.slice(chatSeen).filter((m) => m.userId !== player.id).length;
  const sideOf = (c: Color) => COLOR_LABEL[state.game][c];
  const lastInfo = infos.length > 0 ? infos[infos.length - 1] : null;
  const kingWord = state.game === 'xiangqi' ? 'tướng' : 'vua';
  const reasonText = state.result ? endReasonText(state.game, state.result, myColor) : undefined;
  const myRating = myColor !== null ? state.players[myColor].rating : null;
  const lost = !!state.result && myColor !== null && state.result.winner !== null && state.result.winner !== myColor;

  const bar = (c: Color) => {
    const p = state.players[c];
    return (
      <PlayerBar
        game={state.game}
        color={c}
        name={p.username}
        avatarUrl={p.avatarUrl}
        isMe={c === myColor}
        rating={state.ranked && !p.isGuest ? p.rating : null}
        tier={p.isGuest ? null : p.tier}
        tierLevel={p.isGuest ? null : p.tierLevel}
        clockMs={clocks[c]}
        active={state.status === 'playing' && turn === c}
        reconnectSec={state.status === 'playing' ? secsLeft(state.disconnectedUntil[c]) : null}
        inCheck={inCheck && boardTurn === c}
        captured={engine instanceof JieqiGame ? capturedList(engine.capturedPieces()[c === 0 ? 1 : 0]) : undefined}
      />
    );
  };

  /**
   * Sau ván: về đúng nơi bắt đầu ván. Xếp hạng → trang chủ, tự tìm ván xếp hạng mới; Cờ úp ghép ngẫu nhiên → vào hàng
   * chờ cờ úp rồi mở trang Cờ úp (thấy ngay "Đang tìm đối thủ"); Cờ úp phòng riêng → trang Cờ úp; phòng riêng cờ
   * thường → trang chủ, thẻ Phòng riêng (HomePage đọc state.lobbyTab).
   */
  const jieqi = state.variant === 'jieqi';
  const next: { label: ReactNode; full: string; icon: IconName; go: () => void | Promise<void> } = state.ranked
    ? {
        full: 'Tìm ván xếp hạng mới',
        label: (
          <>
            Tìm ván<span className="act-more"> xếp hạng</span> mới
          </>
        ),
        icon: 'search',
        go: () => navigate('/', { state: { autoQueue: state.game } }),
      }
    : jieqi && state.kind === 'casual'
      ? {
          full: 'Tìm ván cờ úp mới',
          label: (
            <>
              Tìm ván<span className="act-more"> cờ úp</span> mới
            </>
          ),
          icon: 'search',
          // Mở trang Cờ úp trước rồi mới vào hàng chờ: nếu ghép được ngay, "match:found" mở ván mới sau cùng
          go: async () => {
            navigate('/co-up');
            await joinQueue('xiangqi', 'jieqi');
          },
        }
      : jieqi
        ? {
            full: 'Về trang Cờ úp',
            label: (
              <>
                Về<span className="act-more"> trang</span> Cờ úp
              </>
            ),
            icon: 'hidden',
            go: () => navigate('/co-up'),
          }
        : {
            full: 'Về Phòng riêng',
            label: 'Về Phòng riêng',
            icon: 'users',
            go: () => navigate('/', { state: { lobbyTab: 'private' } }),
          };
  const playAgain = () => {
    setShowResult(false);
    void next.go();
  };

  // Ô trạng thái
  const look = resultLook(state.result?.winner ?? null, myColor);
  let status: { tone: StatusTone; title: string; sub?: ReactNode; extra?: ReactNode };
  if (state.status === 'playing') {
    if (myColor === null) {
      status = { tone: inCheck ? 'check' : 'wait', title: inCheck ? 'Chiếu!' : `Lượt: ${sideOf(boardTurn)}`, sub: inCheck ? `Lượt: ${sideOf(boardTurn)}` : undefined };
    } else if (boardTurn === myColor) {
      status = inCheck
        ? { tone: 'check', title: 'Chiếu!', sub: `Đến lượt bạn — hãy gỡ chiếu cho ${kingWord}.` }
        : {
            tone: 'turn',
            title: 'Đến lượt bạn',
            sub: lastInfo ? (
              <>
                Đối thủ vừa đi <b>{lastInfo.label}</b>
              </>
            ) : (
              `Bạn cầm quân ${sideOf(myColor)}`
            ),
          };
    } else {
      status = inCheck
        ? { tone: 'check', title: 'Chiếu!', sub: `Bạn đang chiếu ${kingWord} đối thủ.` }
        : { tone: 'wait', title: 'Lượt đối thủ', sub: `Chờ ${state.players[opp].username} đi…` };
    }
  } else {
    status = {
      tone: state.result ? look.tone : 'neutral',
      title: outcome ?? (state.result ? (state.result.winner === null ? 'Hoà' : `${sideOf(state.result.winner)} thắng`) : 'Ván đấu kết thúc'),
      sub: reasonText,
      extra: myChange ? (
        <span
          className={`status-delta num ${myChange.delta > 0 ? 'up' : myChange.delta < 0 ? 'down' : 'zero'}`}
          title={`Điểm hạng: ${myChange.before} → ${myChange.after}`}
          aria-label={`Điểm hạng ${signed(myChange.delta)}, từ ${myChange.before} thành ${myChange.after}`}
        >
          {signed(myChange.delta)}
        </span>
      ) : undefined,
    };
  }

  // Thông báo (theo thứ tự ưu tiên): mình mất kết nối, mời hoà, đối thủ mất kết nối, hạn nước đầu, đã gửi / bị từ chối
  // lời mời hoà, cảnh báo luật
  const notices: BoardNotice[] = [];
  const graceSec = RECONNECT_GRACE_MS / 1000;
  /** Đã kết nối lại nhưng chưa vào lại được bàn: nước đi của đối thủ chưa tới được đây, bàn cờ / đồng hồ có thể đã cũ */
  const stale = state.status === 'playing' && myColor !== null && connected && !synced;
  if (state.status === 'playing' && myColor !== null && !connected) {
    const t = `Mất kết nối tới máy chủ, đang kết nối lại… Bạn có ${graceSec} giây để quay lại ván, quá hạn sẽ bị xử thua.`;
    notices.push({ key: 'me-dc', tone: 'warn', icon: 'wifi-off', text: t, title: t });
  } else if (stale) {
    const t =
      rejoining || !error
        ? 'Đang vào lại ván… Bàn cờ và đồng hồ ở đây chưa cập nhật, bạn chờ một chút nhé.'
        : `Chưa vào lại được ván: ${error.message} Bàn cờ ở đây chưa cập nhật.`;
    notices.push({
      key: 'me-sync',
      tone: 'warn',
      icon: 'wifi-off',
      text: t,
      title: t,
      actions:
        rejoining || !error ? undefined : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void join()}>
            <Icon name="restart" size={16} />
            Thử lại
          </button>
        ),
    });
  }
  if (state.status === 'playing' && state.drawOfferBy !== null && state.drawOfferBy !== myColor && myColor !== null) {
    notices.push({
      key: 'offer',
      tone: 'offer',
      icon: 'draw',
      text: <b>Đối thủ mời hoà. Bạn đồng ý?</b>,
      actions: (
        <>
          <button className="btn btn-sm btn-primary" onClick={() => void emit('match:respondDraw', { matchId, accept: true })}>
            <Icon name="check" size={16} />
            Đồng ý hoà
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => void emit('match:respondDraw', { matchId, accept: false })}>
            Từ chối
          </button>
        </>
      ),
    });
  }
  if (state.status === 'playing' && myColor !== null && state.disconnectedUntil[opp] !== null) {
    const s = secsLeft(state.disconnectedUntil[opp]);
    notices.push({
      key: 'dc',
      tone: 'warn',
      icon: 'wifi-off',
      text: (
        <>
          Đối thủ mất kết nối. Nếu sau <b className="num">{s} giây</b> chưa vào lại, đối thủ bị xử thua.
        </>
      ),
      title: `Đối thủ mất kết nối. Nếu sau ${s} giây chưa vào lại, đối thủ bị xử thua và bạn thắng.`,
    });
  }
  if (firstMoveSec !== null) {
    const mine = turn === myColor;
    const t = mine
      ? `Hãy đi nước đầu tiên trong ${firstMoveSec} giây, nếu không bạn sẽ bị xử thua.`
      : `Đối thủ phải đi nước đầu tiên trong ${firstMoveSec} giây, nếu không sẽ bị xử thua.`;
    notices.push({
      key: 'first',
      tone: 'warn',
      icon: 'clock',
      text: mine ? (
        <>
          Hãy đi nước đầu tiên trong <b className="num">{firstMoveSec} giây</b>, nếu không bạn sẽ bị xử thua.
        </>
      ) : (
        <>
          Đối thủ phải đi nước đầu tiên trong <b className="num">{firstMoveSec} giây</b>, nếu không sẽ bị xử thua.
        </>
      ),
      title: `${t} (Ván xếp hạng: mỗi bên có ${FIRST_MOVE_TIMEOUT_MS / 1000} giây cho nước đầu tiên.)`,
    });
  }
  if (state.status === 'playing' && myColor !== null && state.drawOfferBy === myColor) {
    notices.push({ key: 'sent', tone: 'wait', text: 'Đã gửi lời mời hoà, đang chờ đối thủ trả lời…' });
  }
  if (state.status === 'playing' && drawDeclined && state.drawOfferBy === null) {
    notices.push({ key: 'declined', tone: 'info', icon: 'info', text: 'Đối thủ không đồng ý hoà — ván đấu tiếp tục.', dismissible: true });
  }
  notices.push(...warningNotices(state.game, state.warnings));

  return (
    <GameScreen
      game={state.game}
      ended={state.status === 'ended'}
      className={stale ? 'is-stale' : undefined}
      head={
        <GameHead
          game={state.game}
          title={jieqi ? 'Cờ úp' : state.ranked ? 'Ván xếp hạng' : 'Phòng riêng'}
          sub={
            jieqi ? (
              <>{state.kind === 'casual' ? 'Ghép ngẫu nhiên' : 'Phòng riêng'} · Không tính điểm hạng</>
            ) : (
              <>
                {GAME_LABEL[state.game]} · {state.ranked ? <span className="gh-ranked">Tính điểm hạng</span> : 'Không tính điểm hạng'}
              </>
            )
          }
          tc={timeControlShort(state.timeControl)}
          tcTitle={timeControlTitle(state.timeControl)}
        />
      }
      top={bar(top)}
      bottom={bar(bottom)}
      board={
        <GameBoard
          engine={engine}
          version={ver}
          orientation={bottom}
          movable={state.status === 'playing' && !pending && !stale ? myColor : null}
          onMove={(m) => void submitMove(m)}
          lastMove={lastMoveOf(engine)}
        />
      }
      notices={notices}
      status={
        <StatusCard tone={status.tone} title={status.title} sub={status.sub}>
          {status.extra}
        </StatusCard>
      }
      toolbar={
        <div className="actions">
          {state.status === 'playing' ? (
            <>
              <button
                className="btn btn-ghost btn-sm act"
                disabled={state.drawOfferBy !== null}
                title={
                  state.drawOfferBy === myColor
                    ? 'Đã gửi lời mời hoà, đang chờ đối thủ trả lời'
                    : state.drawOfferBy !== null
                      ? 'Đối thủ đang mời hoà — trả lời ở thông báo trên bàn cờ'
                      : 'Mời đối thủ hoà ván này'
                }
                onClick={async () => {
                  const r = await emit('match:offerDraw', { matchId });
                  if (!r.ok) toast(r.error, 'error');
                }}
              >
                <Icon name="draw" size={18} />
                <span className="act-label">Cầu hoà</span>
              </button>
              <button className="btn btn-danger btn-sm act" onClick={() => setConfirmResign(true)} title="Chịu thua ván này">
                <Icon name="flag" size={18} />
                <span className="act-label">Đầu hàng</span>
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary btn-sm act" onClick={playAgain} title={next.full}>
                <Icon name={next.icon} size={18} />
                <span className="act-label">{next.label}</span>
              </button>
              {/* Xem lại ván cần tài khoản (khách không có lịch sử ván) */}
              {me && (
                <Link className="btn btn-sm act" to={`/replay/${state.id}`} title="Xem lại từng nước của ván này">
                  <Icon name="history" size={18} />
                  <span className="act-label">Xem lại</span>
                </Link>
              )}
            </>
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
          content: <MoveList moves={infos} game={state.game} jieqi={jieqi} />,
        },
        {
          id: 'chat',
          label: 'Trò chuyện',
          icon: 'chat',
          badge: unread,
          quick: true,
          content: (
            <div className="chat chat-log">
              <ChatMessages myId={player.id} messages={chat} />
            </div>
          ),
        },
      ]}
      tab={tab}
      onTabChange={onTabChange}
      sideBottom={
        <div className="chat chat-dock" ref={setChatDockEl}>
          <ChatForm matchId={matchId} onFocus={openChatTab} showHint={tab === 'chat'} />
        </div>
      }
      sideFooter={
        (jieqi && state.status === 'playing') || player.isGuest ? (
          <>
            {jieqi && state.status === 'playing' && (
              <p className="side-note">
                <Icon name="info" size={15} />
                Quân úp đi theo quân gốc của ô nó đứng, đi xong thì lật lên.
              </p>
            )}
            {player.isGuest && <GuestPlayHint />}
          </>
        ) : undefined
      }
    >
      <PerpetualModal
        open={confirmMove !== null && state.status === 'playing'}
        onCancel={() => setConfirmMove(null)}
        onConfirm={() => {
          const m = confirmMove!;
          setConfirmMove(null);
          void submitMove(m, true);
        }}
      />

      <Modal
        open={confirmResign && state.status === 'playing'}
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
              onClick={async () => {
                setConfirmResign(false);
                const r = await emit('match:resign', { matchId });
                if (!r.ok) toast(r.error, 'error');
              }}
            >
              <Icon name="flag" size={18} />
              Đầu hàng
            </button>
          </>
        }
      >
        {!state.ranked
          ? 'Ván này sẽ tính là bạn thua (không ảnh hưởng điểm hạng).'
          : myRating === RATING_FLOOR
            ? `Ván này sẽ tính là bạn thua. Bạn đang có ${RATING_FLOOR} điểm hạng nên không bị trừ thêm (điểm hạng không xuống dưới ${RATING_FLOOR}).`
            : `Ván này sẽ tính là bạn thua và bị trừ điểm hạng (điểm hạng không xuống dưới ${RATING_FLOOR}).`}
      </Modal>

      <Modal
        open={showResult && state.status === 'ended'}
        title={outcome ?? 'Ván đấu kết thúc'}
        icon={look.icon}
        tone={look.modalTone}
        onClose={() => setShowResult(false)}
        actions={
          <>
            {me && (
              <Link className="btn btn-ghost" to={`/replay/${state.id}`}>
                <Icon name="history" size={18} />
                Xem lại ván
              </Link>
            )}
            <button className="btn btn-primary" onClick={playAgain}>
              <Icon name={next.icon} size={18} />
              {next.full}
            </button>
          </>
        }
      >
        <ResultDetails
          reason={reasonText}
          change={myChange}
          lost={lost}
          note={
            !myChange && !state.ranked
              ? `${jieqi ? 'Cờ úp không tính điểm hạng.' : 'Ván phòng riêng không tính điểm hạng.'}${
                  player.isGuest ? ' Đăng nhập để chơi xếp hạng và lưu lịch sử ván.' : ''
                }`
              : undefined
          }
        />
      </Modal>
    </GameScreen>
  );
}
