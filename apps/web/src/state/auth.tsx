import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeDto } from '@cotuong/shared';
import { ApiError, api, errorMessage, setUnauthorizedHandler } from '../api/http';
import { reconnectSocket, socket } from '../api/socket';
import { useToast } from './toast';

interface AuthContextValue {
  /**
   * Tài khoản THÀNH VIÊN đang đăng nhập (không bao giờ là khách). Mọi chỗ cần tài khoản thật (hồ sơ, xếp hạng,
   * lịch sử ván, xác thực email, quản trị…) dùng `me`.
   */
  me: MeDto | null;
  /** Danh tính KHÁCH (isGuest = true) của trình duyệt này, nếu có — chỉ để chơi phòng riêng / Cờ úp */
  guest: MeDto | null;
  /** Danh tính dùng để CHƠI (ván đấu, phòng riêng, hàng chờ Cờ úp): thành viên nếu đã đăng nhập, không thì khách */
  player: MeDto | null;
  /** true cho tới khi biết chắc là đã đăng nhập hay chưa (kể cả khi đang chờ kết nối lại) */
  loading: boolean;
  /**
   * Lần hỏi trạng thái đăng nhập gần nhất thất bại vì mạng / máy chủ (KHÔNG phải vì chưa đăng nhập).
   * Khi đó giữ nguyên trạng thái cũ và tự thử lại.
   */
  offline: boolean;
  /** Thời điểm (ms) sẽ tự thử lại khi offline; null nếu đang thử */
  retryAt: number | null;
  /**
   * Hỏi lại máy chủ; trả về danh tính hiện tại (thành viên HOẶC khách — xem isGuest), hoặc null nếu chưa có /
   * không hỏi được (khi đó `offline` = true, trạng thái giữ nguyên)
   */
  refresh: () => Promise<MeDto | null>;
  login: (email: string, password: string) => Promise<MeDto>;
  /** Bước 3 của đăng ký bằng mã email: tạo tài khoản từ phiếu (ticket) và đăng nhập */
  completeRegistration: (ticket: string, username: string, password: string) => Promise<MeDto>;
  /**
   * Đăng xuất (thành viên) hoặc thoát chế độ khách. Chỉ đổi trạng thái khi máy chủ đã huỷ phiên (hoặc phiên vốn đã hết);
   * lỗi mạng / máy chủ thì ném ApiError và GIỮ NGUYÊN trạng thái — nơi gọi báo cho người dùng thử lại.
   */
  logout: () => Promise<void>;
  /**
   * Hỏi lại máy chủ sau một thao tác có thể làm đổi phiên của trình duyệt này (vd. đặt lại mật khẩu: chỉ huỷ phiên nếu
   * đó là tài khoản đang đăng nhập ở đây). Danh tính đổi thì kết nối lại socket. Không báo "bị đăng xuất ở nơi khác".
   */
  resync: () => Promise<void>;
  /**
   * Bảo đảm có danh tính để chơi: đã có (thành viên / khách) thì trả lại luôn; chưa có thì vào với tư cách khách
   * (POST /api/auth/guest), kết nối lại socket bằng phiên mới và chờ socket kết nối xong. Gọi nhiều lần cùng lúc
   * chỉ tạo một phiên. Lỗi (quá nhiều khách, mạng…) thì ném ApiError.
   */
  ensureGuest: () => Promise<MeDto>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Chờ lâu dần giữa các lần tự thử lại: 2 s, 4 s, 8 s, 15 s rồi 30 s */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
/** Chờ socket kết nối lại (bằng phiên khách mới) tối đa chừng này rồi vẫn trả về — lệnh gửi sau đó tự chờ thêm */
const SOCKET_WAIT_MS = 8_000;
/** Trong khoảng này sau khi chính trình duyệt này đổi danh tính, việc máy chủ ngắt socket là do mình → không báo */
const SELF_CHANGE_GRACE_MS = 5_000;

/** Chờ socket kết nối (true) hoặc hết thời gian (false) */
function waitForSocket(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.connected) {
      resolve(true);
      return;
    }
    const done = (ok: boolean) => {
      window.clearTimeout(t);
      socket.off('connect', onConnect);
      resolve(ok);
    };
    const onConnect = () => done(true);
    const t = window.setTimeout(() => done(false), timeoutMs);
    socket.on('connect', onConnect);
  });
}

/**
 * Chạy `fn` độc quyền giữa các tab cùng trình duyệt (Web Locks). Hai tab cùng mở trang chơi lúc chưa có phiên sẽ không
 * tạo hai khách: tab sau chờ tab trước xong (cookie phiên khách đã có) rồi mới gửi — máy chủ trả lại đúng khách đó.
 * Trình duyệt không hỗ trợ (trang http thường, trình duyệt cũ) thì chạy luôn.
 */
function acrossTabs<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(name, fn) as Promise<T>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [me, setMember] = useState<MeDto | null>(null);
  const [guest, setGuest] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  /** Số lần thất bại liên tiếp (mỗi lần tăng → hẹn lần thử kế tiếp) */
  const [failures, setFailures] = useState(0);
  const player = me ?? guest;
  /** Danh tính mới nhất (cho các hàm không muốn đổi mỗi lần render) */
  const playerRef = useRef(player);
  playerRef.current = player;
  /**
   * Tăng mỗi lần danh tính đổi do chính trình duyệt này (đăng nhập, đăng ký, đăng xuất, vào với tư cách khách):
   * câu trả lời /me gửi đi TRƯỚC lúc đó là cũ, không được ghi đè (vd /me "chưa đăng nhập" về sau khi vừa tạo khách).
   */
  const epoch = useRef(0);
  const guestPromise = useRef<Promise<MeDto> | null>(null);
  /** Số thao tác đổi phiên do trình duyệt này đang chạy (đăng xuất, đặt lại mật khẩu…) */
  const selfBusy = useRef(0);
  /** Lúc gần nhất trình duyệt này tự đổi phiên */
  const selfChangedAt = useRef(0);

  /** Đặt danh tính theo đúng loại: khách không bao giờ nằm trong `me` */
  const applyUser = useCallback((u: MeDto | null) => {
    if (u?.isGuest) {
      setGuest(u);
      setMember(null);
    } else {
      setMember(u);
      setGuest(null);
    }
    playerRef.current = u;
  }, []);

  /**
   * Hỏi /api/auth/me. ok = có câu trả lời chắc chắn (đăng nhập / chưa đăng nhập); user = danh tính hiện tại (câu trả lời
   * đã cũ vì trình duyệt vừa tự đổi danh tính thì trả danh tính mới nhất).
   */
  const query = useCallback(async (): Promise<{ ok: boolean; user: MeDto | null }> => {
    const at = epoch.current;
    try {
      const r = await api.get<{ user: MeDto | null }>('/api/auth/me');
      // Trong lúc chờ, danh tính đã đổi ở trình duyệt này: câu trả lời đã cũ
      if (at === epoch.current) applyUser(r.user);
      setFailures(0);
      setOffline(false);
      setLoading(false);
      return { ok: true, user: at === epoch.current ? r.user : playerRef.current };
    } catch (e) {
      // Chỉ 401 nghĩa là "chưa đăng nhập"; lỗi mạng / máy chủ thì chưa biết → giữ nguyên, báo offline và tự thử lại
      if (e instanceof ApiError && e.status === 401) {
        if (at === epoch.current) applyUser(null);
        setFailures(0);
        setOffline(false);
        setLoading(false);
        return { ok: true, user: at === epoch.current ? null : playerRef.current };
      }
      setFailures((n) => n + 1);
      setOffline(true);
      // Giữ nguyên danh tính đang có; trả null như trước đây (nơi gọi hiểu là "không có thông tin mới")
      return { ok: false, user: null };
    }
  }, [applyUser]);

  const refresh = useCallback(async () => (await query()).user, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Offline: tự thử lại (chờ lâu dần); thử ngay khi máy có mạng trở lại hoặc người dùng quay lại trang
  useEffect(() => {
    if (!offline || failures === 0) {
      setRetryAt(null);
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
    setRetryAt(Date.now() + delay);
    const t = window.setTimeout(() => void refresh(), delay);
    const now = () => {
      window.clearTimeout(t);
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') now();
    };
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [offline, failures, refresh]);

  // Phiên bị huỷ phía máy chủ (đặt lại mật khẩu ở nơi khác, bị khoá, hết hạn…): tải lại trạng thái đăng nhập
  useEffect(() => {
    let pending = false;
    setUnauthorizedHandler(() => {
      if (pending) return;
      pending = true;
      void refresh().finally(() => {
        pending = false;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  /**
   * Máy chủ chủ động ngắt socket ("io server disconnect"): phiên có thể vừa bị huỷ (đăng xuất ở tab / thiết bị khác,
   * đặt lại mật khẩu, bị khoá). Hỏi lại ngay để giao diện không còn "đã đăng nhập" giả (socket tự kết nối lại — xem
   * api/socket.ts); mất danh tính mà không phải do trình duyệt này làm thì báo rõ.
   */
  useEffect(() => {
    const onDisconnect = (reason: string) => {
      if (reason !== 'io server disconnect') return;
      const before = playerRef.current;
      const at = epoch.current;
      void query().then(({ ok, user }) => {
        const self = selfBusy.current > 0 || Date.now() - selfChangedAt.current < SELF_CHANGE_GRACE_MS;
        if (!ok || self || at !== epoch.current || !before || user?.id === before.id) return;
        toast(
          before.isGuest
            ? 'Phiên chơi với tư cách khách đã kết thúc (có thể bạn vừa thoát ở trang khác).'
            : 'Bạn đã bị đăng xuất (có thể do đăng xuất ở trang hoặc thiết bị khác, hoặc mật khẩu vừa được đổi). Bạn đăng nhập lại nhé.',
          'info',
          8000,
        );
      });
    };
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('disconnect', onDisconnect);
    };
  }, [query, toast]);

  /** Vừa có danh tính mới từ máy chủ (đăng nhập / đăng ký / khách): ghi lại, bỏ trạng thái offline */
  const adopt = useCallback(
    (u: MeDto) => {
      epoch.current++;
      selfChangedAt.current = Date.now();
      applyUser(u);
      setOffline(false);
      setFailures(0);
      setLoading(false);
    },
    [applyUser],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<{ user: MeDto }>('/api/auth/login', { email, password });
      // Đang là khách thì phiên khách được thay bằng phiên tài khoản (danh tính khách bỏ lại)
      adopt(r.user);
      reconnectSocket();
      return r.user;
    },
    [adopt],
  );

  const completeRegistration = useCallback(
    async (ticket: string, username: string, password: string) => {
      const r = await api.post<{ user: MeDto }>('/api/auth/register/complete', { ticket, username, password });
      adopt(r.user);
      reconnectSocket();
      return r.user;
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    const before = playerRef.current;
    selfBusy.current++;
    try {
      try {
        await api.post('/api/auth/logout');
      } catch (e) {
        // Lỗi mạng / máy chủ (5xx, 429…): CHƯA đăng xuất — giữ nguyên trạng thái, nơi gọi báo để người dùng thử lại
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        // 401: phiên thường đã hết (đăng xuất ở nơi khác, hết hạn) → coi như đã đăng xuất. Hỏi lại cho chắc: máy chủ
        // cũ trả 401 cho khách dù phiên khách vẫn còn
        const still = await api.get<{ user: MeDto | null }>('/api/auth/me').then(
          (r) => r.user,
          () => null,
        );
        if (still && before && still.id === before.id) throw new ApiError('Chưa đăng xuất được. Bạn thử lại sau ít phút nhé.', 401);
      }
      epoch.current++;
      applyUser(null);
      reconnectSocket();
    } finally {
      selfBusy.current--;
      selfChangedAt.current = Date.now();
    }
  }, [applyUser]);

  const resync = useCallback(async () => {
    const before = playerRef.current?.id ?? null;
    selfBusy.current++;
    try {
      const { ok, user } = await query();
      if (ok && (user?.id ?? null) !== before) {
        epoch.current++;
        reconnectSocket();
      }
    } finally {
      selfBusy.current--;
      selfChangedAt.current = Date.now();
    }
  }, [query]);

  const ensureGuest = useCallback(() => {
    const have = playerRef.current;
    if (have) return Promise.resolve(have);
    guestPromise.current ??= (async () => {
      try {
        // Máy chủ: đã có phiên (thành viên hoặc khách) thì trả lại đúng người đó, không tạo gì. Khoá giữa các tab để
        // hai tab mở cùng lúc không cùng tạo khách (tab sau gửi khi cookie của tab trước đã có)
        const r = await acrossTabs('cotuong-guest', () => api.post<{ user: MeDto }>('/api/auth/guest'));
        // Kết nối lại socket TRƯỚC khi báo có danh tính: trang mở ra sẽ thấy "đang kết nối" rồi mới gửi lệnh
        reconnectSocket();
        adopt(r.user);
        await waitForSocket(SOCKET_WAIT_MS);
        return r.user;
      } finally {
        guestPromise.current = null;
      }
    })();
    return guestPromise.current;
  }, [adopt]);

  const value = useMemo(
    () => ({ me, guest, player, loading, offline, retryAt, refresh, login, completeRegistration, logout, resync, ensureGuest }),
    [me, guest, player, loading, offline, retryAt, refresh, login, completeRegistration, logout, resync, ensureGuest],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải dùng trong AuthProvider');
  return ctx;
}

/**
 * Cho các nút "Tìm đối thủ", "Tạo phòng", "Vào phòng"…: bảo đảm có danh tính để chơi (tạo phiên khách nếu chưa đăng
 * nhập). Lỗi thì báo bằng thông báo nổi và trả null (nơi gọi dừng lại).
 */
export function useEnsurePlayer(): () => Promise<MeDto | null> {
  const { ensureGuest } = useAuth();
  const toast = useToast();
  return useCallback(async () => {
    try {
      return await ensureGuest();
    } catch (e) {
      toast(errorMessage(e), 'error', 7000);
      return null;
    }
  }, [ensureGuest, toast]);
}
