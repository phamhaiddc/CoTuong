import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import type { GameType } from '@cotuong/game-core';
import { GAME_LABEL } from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useRealtime } from '../state/realtime';
import { useTheme, type ThemePref } from '../state/theme';
import { useToast } from '../state/toast';
import { ErrorBoundary } from './ErrorBoundary';
import { GameIcon, Icon, type IconName } from './icons';
import { Avatar, GameTabs, Modal, Spinner } from './ui';

/** Trang giải thích cách tính điểm hạng (mục trên trang Mùa giải) */
export const RATING_RULES_PATH = '/seasons#cach-tinh-diem';

export function BrandLogo({ size = 36, className = 'brand-logo' }: { size?: number; className?: string }) {
  const gid = `brandFace${useId().replace(/:/g, '')}`;
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id={gid} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#fff6e3" />
          <stop offset="100%" stopColor="#e9c88f" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="#b3261e" />
      <circle cx="32" cy="32" r="26.5" fill={`url(#${gid})`} />
      <circle cx="32" cy="32" r="21.5" fill="none" stroke="#b3261e" strokeWidth="2" />
      <text x="32" y="43" textAnchor="middle" fontSize="29" fontWeight="700" fill="#b3261e" fontFamily="KaiTi, STKaiti, SimSun, serif">
        帥
      </text>
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Xe Pháo Mã – trang chủ">
      <BrandLogo />
      <span className="brand-text">
        <span className="brand-name">Xe Pháo Mã</span>
        <span className="brand-sub">Cờ tướng · Cờ vua</span>
      </span>
    </Link>
  );
}

/**
 * Nhắc xác thực email. Không hiện ở màn hình ván đấu (chiếm chỗ của bàn cờ) và ở trang xác thực email;
 * trên điện thoại chỉ một dòng ngắn.
 */
function VerifyBanner({ hidden }: { hidden: boolean }) {
  const { me } = useAuth();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  if (hidden || !me || me.emailVerified) return null;
  const resend = async () => {
    setSending(true);
    try {
      await api.post('/api/auth/resend-verification');
      toast(`Đã gửi thư xác thực tới ${me.email}. Nếu không thấy, bạn xem cả mục Thư rác (Spam).`, 'success', 6000);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="banner banner-warn banner-compact" role="status">
      <Icon name="mail" size={18} />
      <span className="banner-long">
        Xác thực email <b>{me.email}</b> để chơi ván xếp hạng: mở thư Xe Pháo Mã đã gửi và bấm vào liên kết trong thư.
      </span>
      <span className="banner-short">Xác thực email để chơi xếp hạng.</span>
      <button type="button" className="link-btn" onClick={resend} disabled={sending}>
        {sending ? 'Đang gửi…' : 'Gửi lại thư xác thực'}
      </button>
    </div>
  );
}

/** Không hỏi lại trạng thái ván dở dày hơn mức này khi chuyển trang liên tục */
const ACTIVE_MATCH_RECHECK_MS = 2_000;
/** Có ván dở mà đang ở trang khác: hỏi lại máy chủ mỗi chừng này (ván có thể đã kết thúc) */
const ACTIVE_MATCH_POLL_MS = 15_000;

function ActiveMatchBanner() {
  // Khách cũng có ván dở (phòng riêng, Cờ úp)
  const { player, refresh } = useAuth();
  const location = useLocation();
  const activeId = player?.activeMatchId ?? null;
  const onBoard = activeId !== null && location.pathname === `/play/${activeId}`;
  // Ván có thể đã kết thúc trong lúc người chơi ở trang khác (tin "ván kết thúc" chỉ tới người đang mở bàn cờ): mỗi lần
  // chuyển trang thì hỏi lại máy chủ để banner và nút "Vào lại ván" (trang chủ, Cờ úp) không treo theo ván đã xong
  const lastCheck = useRef(0);
  useEffect(() => {
    if (!activeId || onBoard || Date.now() - lastCheck.current < ACTIVE_MATCH_RECHECK_MS) return;
    lastCheck.current = Date.now();
    void refresh();
  }, [activeId, onBoard, location.pathname, refresh]);
  // Đứng yên ở một trang khác: thỉnh thoảng hỏi lại (chỉ khi đang có ván dở và trang đang hiện)
  useEffect(() => {
    if (!activeId || onBoard) return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      lastCheck.current = Date.now();
      void refresh();
    }, ACTIVE_MATCH_POLL_MS);
    return () => window.clearInterval(t);
  }, [activeId, onBoard, refresh]);
  if (!activeId || onBoard) return null;
  return (
    <div className="banner banner-info banner-compact" role="status">
      <Icon name="clock" size={18} />
      <span className="banner-long">Bạn đang có một ván chưa kết thúc — quay lại ngay để không bị xử thua vì hết giờ.</span>
      <span className="banner-short">Bạn có một ván chưa kết thúc.</span>
      <Link to={`/play/${activeId}`} className="btn btn-primary btn-sm">
        Quay lại ván
      </Link>
    </div>
  );
}

/** Đếm ngược tới thời điểm `at` (giây, làm tròn lên) — cập nhật mỗi giây */
function useSecondsUntil(at: number | null): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Chưa hỏi được trạng thái đăng nhập vì mạng / máy chủ lỗi: KHÔNG coi là khách (không đẩy về trang đăng nhập),
 * báo rõ và tự thử lại.
 */
function OfflineBanner() {
  const { loading, offline, retryAt, refresh } = useAuth();
  const secs = useSecondsUntil(offline ? retryAt : null);
  const [busy, setBusy] = useState(false);
  if (!loading || !offline) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const waiting = busy || secs === null || secs <= 0;
  return (
    <div className="banner banner-danger" role="alert">
      <Icon name="wifi-off" size={18} />
      <span>
        <b>Không kết nối được tới Xe Pháo Mã.</b>{' '}
        {waiting ? 'Đang thử lại…' : `Tự thử lại sau ${secs} giây.`} Bạn kiểm tra mạng giúp nhé.
      </span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={retry} disabled={busy}>
        <Icon name="restart" size={16} />
        Thử lại ngay
      </button>
    </div>
  );
}

/**
 * Chỉ báo "đang kết nối lại" khi mất kết nối kéo dài quá `delayMs` — tránh nhấp nháy mỗi lần mở trang
 * (socket cần một chút thời gian để kết nối) hoặc khi đăng nhập / đăng xuất (socket kết nối lại ngay).
 */
function useLongDisconnect(delayMs = 2000): boolean {
  const { connected } = useRealtime();
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (connected) {
      setLong(false);
      return;
    }
    const t = window.setTimeout(() => setLong(true), delayMs);
    return () => window.clearTimeout(t);
  }, [connected, delayMs]);
  return !connected && long;
}

const CONN_TITLE = 'Mất kết nối. Xe Pháo Mã đang tự kết nối lại, bạn không cần làm gì.';

const THEME_OPTIONS: Array<[ThemePref, string]> = [
  ['light', 'Sáng'],
  ['dark', 'Tối'],
  ['system', 'Tự động'],
];

function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  return (
    <div className="theme-switch">
      <span className="section-label">Giao diện</span>
      <div className="seg seg-sm" role="radiogroup" aria-label="Giao diện">
        {THEME_OPTIONS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={pref === v}
            className={pref === v ? 'active' : ''}
            onClick={() => setPref(v)}
            title={v === 'system' ? 'Tự đổi sáng / tối theo cài đặt của điện thoại hoặc máy tính' : undefined}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Nút đổi sáng/tối nhanh (cho khách chưa đăng nhập, trên máy tính) */
function ThemeToggle() {
  const { resolved, setPref } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="icon-btn header-theme"
      onClick={() => setPref(next)}
      title={resolved === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
      aria-label={resolved === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
    >
      <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={20} />
    </button>
  );
}

/**
 * Đăng xuất / thoát chế độ khách rồi về trang chủ. Không được (mất mạng, máy chủ lỗi) thì giữ nguyên trạng thái và báo
 * để bấm lại — tránh tưởng đã đăng xuất trên máy dùng chung. Trả true nếu đã xong.
 */
function useSignOut(): (asGuest: boolean) => Promise<boolean> {
  const { logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  return useCallback(
    async (asGuest: boolean) => {
      try {
        await logout();
      } catch {
        toast(
          asGuest
            ? 'Chưa thoát chế độ khách được. Bạn kiểm tra mạng rồi thử lại nhé.'
            : 'Chưa đăng xuất được. Bạn kiểm tra mạng rồi bấm Đăng xuất lại nhé.',
          'error',
          7000,
        );
        return false;
      }
      navigate('/');
      if (asGuest) toast('Đã thoát chế độ khách.', 'success');
      return true;
    },
    [logout, toast, navigate],
  );
}

/** Menu thả xuống của header: đóng khi bấm ra ngoài, bấm Esc hoặc chuyển trang */
function useDropdown(): { open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void; ref: RefObject<HTMLDivElement> } {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * Khách (chơi không cần tài khoản): menu nhỏ có tên khách, chọn giao diện và "Thoát chế độ khách" — trên máy dùng chung,
 * người dùng sau không chơi tiếp bằng tên khách (và ván dở) của người trước.
 */
function GuestMenu() {
  const { guest } = useAuth();
  const signOut = useSignOut();
  const { open, setOpen, ref } = useDropdown();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!guest) return null;
  const leave = async () => {
    setBusy(true);
    const ok = await signOut(true);
    setBusy(false);
    if (ok) setConfirm(false);
  };
  return (
    <div className="user-menu guest-menu" ref={ref}>
      <button
        type="button"
        className="user-btn guest-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Bạn đang chơi với tư cách khách: ${guest.username}`}
        title="Bạn đang chơi với tư cách khách"
      >
        <span className="guest-avatar" aria-hidden="true">
          <Icon name="user" size={18} />
        </span>
        <span className="user-name">{guest.username}</span>
        <Icon name="chevron-down" size={16} className="chevron" />
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-head">
            <span className="guest-avatar is-lg" aria-hidden="true">
              <Icon name="user" size={20} />
            </span>
            <div className="grow">
              <div className="ellipsis">{guest.username}</div>
              <div className="muted small">Đang chơi với tư cách khách</div>
            </div>
          </div>
          <p className="dropdown-note">Đăng nhập để chơi xếp hạng và lưu lịch sử ván.</p>
          <ThemeSwitch />
          <div className="dropdown-sep" />
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setConfirm(true);
            }}
          >
            <Icon name="logout" size={18} /> Thoát chế độ khách
          </button>
        </div>
      )}
      <Modal
        open={confirm}
        title="Thoát chế độ khách?"
        icon="logout"
        tone="warn"
        onClose={() => setConfirm(false)}
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
              Ở lại
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void leave()} disabled={busy}>
              <Icon name="logout" size={18} />
              {busy ? 'Đang thoát…' : 'Thoát'}
            </button>
          </>
        }
      >
        {guest.activeMatchId
          ? 'Bạn đang có một ván chưa kết thúc. Nếu thoát, bạn sẽ không quay lại ván đó được nữa và sẽ bị xử thua khi hết giờ.'
          : `Tên ${guest.username} sẽ không dùng được nữa. Người dùng máy này sau bạn sẽ không chơi tiếp bằng tên của bạn.`}
      </Modal>
    </div>
  );
}

function UserMenu() {
  const { me } = useAuth();
  const signOut = useSignOut();
  const { open, setOpen, ref } = useDropdown();

  if (!me) return null;
  return (
    <div className="user-menu" ref={ref}>
      <button className="user-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" aria-label="Tài khoản">
        <Avatar name={me.username} url={me.avatarUrl} size={34} />
        <span className="user-name">{me.username}</span>
        <Icon name="chevron-down" size={16} className="chevron" />
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown-head">
            <Avatar name={me.username} url={me.avatarUrl} size={40} />
            <div className="grow">
              <div className="ellipsis">{me.username}</div>
              <div className="muted small ellipsis">{me.email}</div>
            </div>
          </div>
          <Link to={`/profile/${me.id}`} role="menuitem">
            <Icon name="user" size={18} /> Hồ sơ của tôi
          </Link>
          <Link to="/seasons" role="menuitem">
            <Icon name="calendar" size={18} /> Mùa giải &amp; xếp hạng
          </Link>
          {me.role === 'admin' && (
            <Link to="/admin" role="menuitem">
              <Icon name="shield" size={18} /> Quản trị
            </Link>
          )}
          <div className="dropdown-sep" />
          <ThemeSwitch />
          <div className="dropdown-sep" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut(false);
            }}
          >
            <Icon name="logout" size={18} /> Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}

/** Các mục điều hướng chính (dùng chung cho header, menu trái màn hình ván đấu và thanh dưới điện thoại) */
interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /** Mô tả ngắn: hiện khi rê chuột (và đọc cho trình đọc màn hình) */
  hint: string;
}

const NAV_PLAY: NavItem = { to: '/', label: 'Chơi', icon: 'play', end: true, hint: 'Ván xếp hạng, phòng riêng với bạn bè, đấu với máy' };
const NAV_COUP: NavItem = { to: '/co-up', label: 'Cờ úp', icon: 'hidden', hint: 'Cờ tướng với quân úp, lật dần khi đi — không tính điểm' };
const NAV_COTHE: NavItem = { to: '/co-the', label: 'Cờ thế', icon: 'puzzle', hint: 'Giải các thế cờ tướng cổ' };
const NAV_SEASONS: NavItem = { to: '/seasons', label: 'Mùa giải', icon: 'calendar', hint: 'Top 10 mỗi quý và cách tính điểm hạng' };

function profileItem(id: string): NavItem {
  return { to: `/profile/${id}`, label: 'Hồ sơ', icon: 'user', hint: 'Điểm hạng, cấp bậc và các ván đã chơi của bạn' };
}

function useNavItems(): NavItem[] {
  const { me } = useAuth();
  const items: NavItem[] = [NAV_PLAY, NAV_COUP, NAV_COTHE, NAV_SEASONS];
  if (me) items.push(profileItem(me.id));
  if (me?.role === 'admin') items.push({ to: '/admin', label: 'Quản trị', icon: 'shield', hint: 'Quản lý tài khoản và tin nhắn bị báo cáo' });
  return items;
}

/** Điện thoại: thanh điều hướng dưới (ẩn trong màn hình ván đấu) */
function BottomNav() {
  const { me } = useAuth();
  const location = useLocation();
  const path = location.pathname;
  const items: NavItem[] = [
    NAV_PLAY,
    NAV_COUP,
    NAV_COTHE,
    NAV_SEASONS,
    me ? profileItem(me.id) : { to: '/login', label: 'Đăng nhập', icon: 'login', hint: 'Đăng nhập hoặc tạo tài khoản' },
  ];
  return (
    <nav className="bottom-nav" aria-label="Điều hướng chính">
      {items.map((it) => {
        const active = it.end ? path === it.to : path === it.to || path.startsWith(it.to + '/');
        return (
          <Link
            key={it.to}
            to={it.to}
            state={it.to === '/login' ? { from: path } : undefined}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
            title={it.hint}
          >
            <span className="nav-ico">
              <Icon name={it.icon} size={20} />
            </span>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

const GNAV_KEY = 'cotuong.gamenav.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(GNAV_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Màn hình ván đấu trên máy tính: menu dọc bên trái (thay cho header), thu gọn được thành cột biểu tượng.
 * Trên điện thoại không hiện (dùng header gọn như các trang khác).
 */
function GameNav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me } = useAuth();
  const signOut = useSignOut();
  const { resolved, setPref } = useTheme();
  const disconnected = useLongDisconnect();
  const location = useLocation();
  const items = useNavItems();
  return (
    <aside className={`gnav${collapsed ? ' collapsed' : ''}`} aria-label="Menu">
      <Link to="/" className="gnav-brand" aria-label="Xe Pháo Mã – trang chủ" title="Trang chủ">
        <BrandLogo size={36} className="gnav-logo" />
        <span className="gnav-brand-text">
          <span className="brand-name">Xe Pháo Mã</span>
          <span className="brand-sub">Cờ tướng · Cờ vua</span>
        </span>
      </Link>
      <nav className="gnav-items" aria-label="Điều hướng">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end} className="gnav-item" title={`${it.label} — ${it.hint}`}>
            <Icon name={it.icon} size={20} />
            <span className="gnav-label">{it.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="gnav-spacer" />
      {disconnected && (
        <div className="gnav-conn" role="status" title={CONN_TITLE}>
          <Icon name="wifi-off" size={18} />
          <span className="gnav-label">Đang kết nối lại…</span>
        </div>
      )}
      <div className="gnav-bottom">
        <button
          type="button"
          className="gnav-item"
          onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
          title={resolved === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}
        >
          <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={20} />
          <span className="gnav-label">{resolved === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}</span>
        </button>
        <button type="button" className="gnav-item gnav-collapse" onClick={onToggle} aria-expanded={!collapsed} title={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}>
          <Icon name="panel-left" size={20} />
          <span className="gnav-label">Thu gọn</span>
        </button>
        {me ? (
          <>
            <Link to={`/profile/${me.id}`} className="gnav-item gnav-user" title={collapsed ? me.username : undefined}>
              <Avatar name={me.username} url={me.avatarUrl} size={28} />
              <span className="gnav-label ellipsis">{me.username}</span>
            </Link>
            <button
              type="button"
              className="gnav-item"
              onClick={() => void signOut(false)}
              title={collapsed ? 'Đăng xuất' : undefined}
            >
              <Icon name="logout" size={20} />
              <span className="gnav-label">Đăng xuất</span>
            </button>
          </>
        ) : (
          <Link to="/login" state={{ from: location.pathname }} className="gnav-item" title={collapsed ? 'Đăng nhập' : undefined}>
            <Icon name="login" size={20} />
            <span className="gnav-label">Đăng nhập</span>
          </Link>
        )}
      </div>
    </aside>
  );
}

/**
 * "Chế độ tập trung" trên màn hình ván đấu: ẩn menu trái để chỉ còn bàn cờ và khung bên.
 * Trang ván đấu gọi useFocusMode() để bật/tắt; tự tắt khi rời màn hình ván đấu.
 */
const FocusCtx = createContext<{ focus: boolean; setFocus: (v: boolean) => void }>({ focus: false, setFocus: () => undefined });

export function useFocusMode() {
  return useContext(FocusCtx);
}

/** Các trang là "màn hình ván đấu": dùng menu trái thay header trên máy tính, ẩn thanh dưới trên điện thoại */
function isGameRoute(path: string): boolean {
  return path.startsWith('/play/') || path === '/ai' || path.startsWith('/replay/') || /^\/co-the\/[^/]+/.test(path);
}

/**
 * Trang mà loại cờ đã cố định (Cờ úp / Cờ thế chỉ có cờ tướng; trong ván, phòng chờ, xem lại thì theo ván đó):
 * nút Cờ tướng / Cờ vua trên header không đổi được gì → thay bằng nhãn cho biết đang ở game nào, kèm lời giải thích.
 * Ván / phòng / xem lại: các trang đó tự đặt game đang chọn theo ván khi tải xong.
 */
function fixedGameOf(path: string, current: GameType): { game: GameType; why: string } | null {
  if (path === '/co-up' || path.startsWith('/co-up/')) return { game: 'xiangqi', why: 'Cờ úp chơi trên bàn cờ tướng' };
  if (path === '/co-the' || path.startsWith('/co-the/')) return { game: 'xiangqi', why: 'Cờ thế hiện chỉ có cờ tướng' };
  const label = GAME_LABEL[current];
  if (path.startsWith('/play/')) return { game: current, why: `Bạn đang trong một ván ${label}. Muốn chơi loại cờ khác, hãy về trang chủ sau khi ván kết thúc.` };
  if (path === '/ai') return { game: current, why: `Bạn đang đấu với máy (${label}). Muốn chơi loại cờ khác, hãy về trang chủ.` };
  if (path.startsWith('/replay/')) return { game: current, why: `Đang xem lại một ván ${label}` };
  if (path.startsWith('/room/')) return { game: current, why: `Phòng này chơi ${label}` };
  return null;
}

/** Nhãn thay cho nút chọn game ở các trang đã cố định loại cờ */
function FixedGameLabel({ game, why }: { game: GameType; why: string }) {
  return (
    <span className="header-games header-game-fixed" title={why} aria-label={`${GAME_LABEL[game]}. ${why}`} role="note">
      <GameIcon game={game} size={18} />
      <span aria-hidden="true">{GAME_LABEL[game]}</span>
    </span>
  );
}

export function Layout() {
  const { me, guest, loading } = useAuth();
  const { game, setGame } = useGameSelect();
  const disconnected = useLongDisconnect();
  const navigate = useNavigate();
  const location = useLocation();
  const items = useNavItems();
  const gameRoute = isGameRoute(location.pathname);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleNav = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(GNAV_KEY, c ? '0' : '1');
      } catch {
        /* bỏ qua */
      }
      return !c;
    });
  }, []);

  const navType = useNavigationType();
  useEffect(() => {
    // Sang trang mới thì về đầu trang (Back/Forward giữ nguyên vị trí cuộn của trình duyệt)
    if (navType !== 'POP') window.scrollTo(0, 0);
  }, [location.pathname, navType]);

  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!gameRoute) setFocus(false);
  }, [gameRoute]);
  const focusValue = useMemo(() => ({ focus: gameRoute && focus, setFocus }), [gameRoute, focus]);
  const fixedGame = fixedGameOf(location.pathname, game);

  return (
    <FocusCtx.Provider value={focusValue}>
    <div
      className={`app${gameRoute ? ' in-game game-frame' : ''}${gameRoute && collapsed ? ' gnav-collapsed' : ''}${
        gameRoute && focus ? ' focus-mode' : ''
      }`}
    >
      {gameRoute && <GameNav collapsed={collapsed} onToggle={toggleNav} />}
      <div className="app-main">
        <header className="header">
          <div className="header-inner">
            <Brand />
            {fixedGame ? (
              <FixedGameLabel game={fixedGame.game} why={fixedGame.why} />
            ) : (
              <GameTabs
                className="header-games"
                withIcons
                value={game}
                onChange={(g) => {
                  setGame(g);
                  if (location.pathname === '/seasons') navigate(`/seasons?game=${g}`);
                }}
              />
            )}
            <nav className="header-nav" aria-label="Điều hướng">
              {items
                .filter((it) => !it.to.startsWith('/profile/'))
                .map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.end} className="nav-link" title={`${it.label} — ${it.hint}`}>
                    <Icon name={it.icon} size={18} />
                    <span className="nav-text">{it.label}</span>
                  </NavLink>
                ))}
            </nav>
            <div className="header-spacer" />
            <div className="header-actions">
              {disconnected && (
                <span className="conn-status" title={CONN_TITLE} role="status">
                  <Icon name="wifi-off" size={16} />
                  <span className="conn-text">Đang kết nối lại…</span>
                </span>
              )}
              {me ? (
                <UserMenu />
              ) : loading ? null : (
                <>
                  {/* Khách: menu nhỏ (tên khách, giao diện, thoát chế độ khách); người chưa vào chơi: nút đổi sáng / tối */}
                  {guest ? <GuestMenu /> : <ThemeToggle />}
                  <div className="auth-links">
                    <Link to="/login" state={{ from: location.pathname }} className="btn btn-ghost btn-sm">
                      Đăng nhập
                    </Link>
                    <Link to="/register" state={{ from: location.pathname }} className="btn btn-primary btn-sm guest-register">
                      Đăng ký
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        <OfflineBanner />
        <VerifyBanner hidden={gameRoute || location.pathname === '/verify-email'} />
        <ActiveMatchBanner />
        <div className="layout">
          <main className="content" id="main">
            {/* Mỗi lần chuyển trang (kể cả cùng đường dẫn, vd. bấm lại liên kết trên header) thì thoát trạng thái lỗi */}
            <ErrorBoundary resetKey={location.key}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
        <footer className="footer">
          <span>Xe Pháo Mã · Cờ tướng &amp; Cờ vua · Mỗi quý một mùa giải mới (giờ Việt Nam)</span>
          <span aria-hidden="true"> · </span>
          <Link to={RATING_RULES_PATH}>Cách tính điểm hạng</Link>
        </footer>
      </div>
      <BottomNav />
    </div>
    </FocusCtx.Provider>
  );
}

/** Chưa vào được với tư cách khách (quá nhiều khách, mạng…): báo rõ, cho thử lại hoặc đăng nhập */
function GuestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const location = useLocation();
  // guestFailed: trang đăng nhập nói rõ là cần tài khoản mới vào được (chưa vào được với tư cách khách)
  const from = { from: location.pathname + location.search, guestFailed: true };
  return (
    <div className="narrow">
      <div className="panel empty guest-error" role="alert">
        <Icon name="alert" size={36} />
        <h1 className="guest-error-title">Chưa vào chơi được</h1>
        <p className="guest-error-msg">{message}</p>
        <div className="guest-error-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            <Icon name="restart" size={18} />
            Thử lại
          </button>
          <Link to="/login" state={from} className="btn btn-ghost">
            <Icon name="login" size={18} />
            Đăng nhập
          </Link>
          <Link to="/register" state={from} className="btn btn-ghost">
            Đăng ký
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Trang chơi được không cần tài khoản (phòng riêng, ván đấu): đã có danh tính (thành viên / khách) thì mở luôn;
 * chưa có thì tự vào với tư cách khách. Trang đang có danh tính mà mất (đăng xuất, phiên hết hạn) thì như trước:
 * về trang đăng nhập, không tự tạo khách mới.
 */
function GuestGate({ children }: { children: JSX.Element }) {
  const { player, ensureGuest } = useAuth();
  const location = useLocation();
  const [hadPlayer, setHadPlayer] = useState(!!player);
  if (player && !hadPlayer) setHadPlayer(true);
  const lost = !player && hadPlayer;
  /** Đang tạo phiên khách / chờ socket kết nối lại bằng phiên đó */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const need = !player && !lost && error === null;
  useEffect(() => {
    if (!need) return;
    setBusy(true);
    // Gọi hai lần (StrictMode) vẫn chỉ tạo một phiên khách: ensureGuest dùng chung lần gọi đang chạy
    ensureGuest().then(
      () => {
        if (mounted.current) setBusy(false);
      },
      (e: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        setError(errorMessage(e));
      },
    );
  }, [need, ensureGuest]);

  if (player && !busy) return children;
  if (lost) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (error !== null) return <GuestError message={error} onRetry={() => setError(null)} />;
  return <Spinner label="Đang vào với tư cách khách…" />;
}

/**
 * Trang ai cũng mở được nhưng phải biết đã đăng nhập hay chưa rồi mới hiện (vd. Đấu với máy: ván dở được giữ theo
 * tài khoản, chỉ thành viên mới lưu ván vào lịch sử).
 */
export function AuthReady({ children }: { children: JSX.Element }) {
  const { loading, offline } = useAuth();
  if (loading) return <Spinner label={offline ? 'Đang chờ kết nối lại để mở trang này…' : 'Đang tải…'} />;
  return children;
}

/**
 * Trang yêu cầu đăng nhập TÀI KHOẢN (khách và người chưa đăng nhập → trang đăng nhập).
 * guest: trang chơi được với tư cách khách (phòng riêng, ván đấu) — xem GuestGate.
 */
export function RequireAuth({ children, admin = false, guest = false }: { children: JSX.Element; admin?: boolean; guest?: boolean }) {
  const { me, loading, offline } = useAuth();
  const location = useLocation();
  // Chưa biết đã đăng nhập hay chưa (đang tải, hoặc mất kết nối — thanh báo phía trên có nút Thử lại): chờ, KHÔNG đẩy về trang đăng nhập
  if (loading) return <Spinner label={offline ? 'Đang chờ kết nối lại để mở trang này…' : 'Đang tải…'} />;
  if (guest) return <GuestGate>{children}</GuestGate>;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (admin && me.role !== 'admin') {
    return (
      <div className="narrow">
        <div className="panel empty">
          <Icon name="lock" size={36} />
          <div>Trang này chỉ dành cho người quản trị.</div>
          <Link to="/" className="btn btn-ghost">
            Về trang chủ
          </Link>
        </div>
      </div>
    );
  }
  return children;
}
