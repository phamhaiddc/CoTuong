import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AI_LEVEL_LABEL, GAME_LABEL, type AdminReportDto, type AdminUserDto, type Paginated, type ReportStatus } from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { Icon, type IconName } from '../components/icons';
import { Avatar, Modal, formatDate } from '../components/ui';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { AdminDashboard } from './AdminDashboard';

/* ==========================================================================
   Phần dùng chung
   ========================================================================== */

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pager admin-pager" aria-label="Phân trang">
      <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <Icon name="chevron-left" size={16} />
        Trước
      </button>
      <span className="admin-pager-info">
        Trang <b>{page}</b>/{pages}
        <span className="admin-pager-total"> · {total} mục</span>
      </span>
      <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Sau
        <Icon name="chevron-right" size={16} />
      </button>
    </nav>
  );
}

/** Nội dung hộp thoại xác nhận cho một thao tác quản trị */
interface ConfirmSpec {
  title: string;
  body: ReactNode;
  icon: IconName;
  tone: 'danger' | 'ok' | 'warn' | 'primary';
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  ok: string;
}

/** Hộp thoại xác nhận dùng chung: chạy thao tác, báo kết quả bằng toast rồi tải lại danh sách */
function useConfirm(onDone: () => void) {
  const toast = useToast();
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const close = useCallback(() => {
    if (!busyRef.current) setSpec(null);
  }, []);
  const confirm = async () => {
    if (!spec || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await spec.run();
      toast(spec.ok, 'success');
      setSpec(null);
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const modal = (
    <Modal
      open={!!spec}
      title={spec?.title ?? ''}
      icon={spec?.icon}
      tone={spec?.tone}
      onClose={close}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Huỷ
          </button>
          <button type="button" className={`btn ${spec?.danger ? 'btn-danger' : 'btn-primary'}`} onClick={confirm} disabled={busy}>
            {busy && <span className="auth-spinner" aria-hidden="true" />}
            {busy ? spec?.busyLabel : spec?.confirmLabel}
          </button>
        </>
      }
    >
      {spec?.body}
    </Modal>
  );
  return { ask: setSpec, modal };
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="admin-state">
      <div className="admin-state-icon is-danger">
        <Icon name="wifi-off" size={26} />
      </div>
      <b>Không tải được dữ liệu</b>
      <span className="muted small">{message}</span>
      <button className="btn btn-sm" onClick={onRetry}>
        <Icon name="restart" size={16} />
        Thử lại
      </button>
    </div>
  );
}

function EmptyBlock({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="admin-state">
      <div className="admin-state-icon">
        <Icon name={icon} size={26} />
      </div>
      <b>{title}</b>
      {children && <span className="muted small">{children}</span>}
    </div>
  );
}

/* ==========================================================================
   Tab người dùng
   ========================================================================== */

function UserChips({ u }: { u: AdminUserDto }) {
  return (
    <div className="admin-chips">
      {u.role === 'admin' && (
        <span className="chip chip-primary">
          <Icon name="shield" size={12} strokeWidth={2.4} />
          Quản trị viên
        </span>
      )}
      {u.botLevel && (
        <span className="chip" title="Tài khoản máy chơi: tự vào ván xếp hạng khi người chơi chờ lâu (chỉ người quản trị thấy)">
          <Icon name="bot" size={12} strokeWidth={2.4} />
          Máy ({u.botGame ? `${GAME_LABEL[u.botGame]} · ` : ''}{AI_LEVEL_LABEL[u.botLevel]})
        </span>
      )}
      {u.isBanned && (
        <span className="chip chip-danger">
          <Icon name="lock" size={12} strokeWidth={2.4} />
          Bị khoá
        </span>
      )}
      {u.emailVerified ? (
        <span className="chip chip-ok">
          <Icon name="check" size={12} strokeWidth={2.6} />
          Đã xác thực
        </span>
      ) : (
        <span className="chip chip-gold">
          <Icon name="mail" size={12} strokeWidth={2.4} />
          Chưa xác thực
        </span>
      )}
    </div>
  );
}

function UserIdentity({ u, isMe, size = 38, showCreated = false }: { u: AdminUserDto; isMe: boolean; size?: number; showCreated?: boolean }) {
  return (
    <div className="admin-user">
      <Avatar name={u.username} url={u.avatarUrl} size={size} />
      <div className="admin-user-text">
        <div className="admin-user-line">
          <Link to={`/profile/${u.id}`} className="admin-user-name">
            {u.username}
          </Link>
          {isMe && <span className="chip admin-me">Bạn</span>}
        </div>
        <div className="admin-user-email" title={u.email}>
          {u.email}
        </div>
        {/* Chỉ hiện khi bảng hẹp và cột "Ngày tạo" bị ẩn */}
        {showCreated && <div className="admin-user-created">Tạo lúc {formatDate(u.createdAt)}</div>}
      </div>
    </div>
  );
}

function UserActions({
  u,
  canBan,
  onBan,
  onUnban,
  onAvatar,
}: {
  u: AdminUserDto;
  canBan: boolean;
  onBan: () => void;
  onUnban: () => void;
  onAvatar: () => void;
}) {
  if (!canBan && !u.avatarUrl) {
    return (
      <span className="admin-no-action" title={u.role === 'admin' ? 'Không thể khoá tài khoản quản trị' : undefined}>
        —
      </span>
    );
  }
  return (
    <div className="admin-actions">
      {canBan &&
        (u.isBanned ? (
          <button className="btn btn-sm" onClick={onUnban}>
            <Icon name="unlock" size={16} />
            Mở khoá
          </button>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={onBan}>
            <Icon name="lock" size={16} />
            Khoá
          </button>
        ))}
      {u.avatarUrl && (
        <button className="btn btn-ghost btn-sm" onClick={onAvatar}>
          <Icon name="trash" size={16} />
          Xoá ảnh đại diện
        </button>
      )}
    </div>
  );
}

function UsersSkeleton() {
  return (
    <ul className="admin-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i}>
          <span className="skeleton admin-skel-avatar" />
          <span className="admin-skel-lines">
            <span className="skeleton" style={{ width: `${46 + ((i * 17) % 30)}%` }} />
            <span className="skeleton" style={{ width: `${30 + ((i * 11) % 22)}%` }} />
          </span>
          <span className="skeleton admin-skel-chip" />
        </li>
      ))}
    </ul>
  );
}

function UsersTab({ onTotal }: { onTotal: (n: number) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<AdminUserDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    api
      .get<Paginated<AdminUserDto>>(`/api/admin/users?q=${encodeURIComponent(query)}&page=${page}`)
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setLoadError(null);
        if (!query) onTotal(d.total);
      })
      .catch((e) => {
        if (id !== seq.current) return;
        toast(errorMessage(e), 'error');
        setLoadError(errorMessage(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [query, page, toast, onTotal]);
  useEffect(load, [load]);

  // Tìm ngay khi gõ (chờ người dùng ngừng gõ một chút)
  useEffect(() => {
    const v = q.trim();
    if (v === query) return;
    const t = window.setTimeout(() => {
      setPage(1);
      setQuery(v);
    }, 400);
    return () => window.clearTimeout(t);
  }, [q, query]);

  const { ask, modal } = useConfirm(load);

  const ban = (u: AdminUserDto) =>
    ask({
      title: `Khoá tài khoản ${u.username}?`,
      icon: 'lock',
      tone: 'danger',
      danger: true,
      confirmLabel: 'Khoá tài khoản',
      busyLabel: 'Đang khoá…',
      body: (
        <p className="admin-modal-text">
          Người này sẽ bị đăng xuất khỏi mọi thiết bị và không thể đăng nhập cho tới khi được mở khoá. Nếu đang trong ván đấu, họ sẽ
          bị xử thua khi mất kết nối quá 60 giây.
        </p>
      ),
      run: () => api.post(`/api/admin/users/${u.id}/ban`),
      ok: 'Đã khoá tài khoản',
    });
  const unban = (u: AdminUserDto) =>
    ask({
      title: `Mở khoá tài khoản ${u.username}?`,
      icon: 'unlock',
      tone: 'ok',
      confirmLabel: 'Mở khoá',
      busyLabel: 'Đang mở khoá…',
      body: <p className="admin-modal-text">Người này có thể đăng nhập và chơi lại bình thường.</p>,
      run: () => api.post(`/api/admin/users/${u.id}/unban`),
      ok: 'Đã mở khoá',
    });
  const clearAvatar = (u: AdminUserDto) =>
    ask({
      title: `Xoá ảnh đại diện của ${u.username}?`,
      icon: 'trash',
      tone: 'danger',
      danger: true,
      confirmLabel: 'Xoá ảnh đại diện',
      busyLabel: 'Đang xoá…',
      body: (
        <div className="admin-modal-avatar">
          <Avatar name={u.username} url={u.avatarUrl} size={56} />
          <p className="admin-modal-text">Ảnh đại diện hiện tại sẽ bị xoá và thay bằng chữ cái đầu của tên.</p>
        </div>
      ),
      run: () => api.del(`/api/admin/users/${u.id}/avatar`),
      ok: 'Đã xoá ảnh đại diện',
    });

  const canBanUser = (u: AdminUserDto) => u.role !== 'admin' && u.id !== me?.id;
  const searching = !!query;

  return (
    <section className="panel admin-panel" aria-busy={loading || undefined}>
      <div className="admin-toolbar">
        <form
          className="admin-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <div className="admin-search-field">
            <Icon name="search" size={18} className="admin-search-icon" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm theo tên hoặc email…"
              aria-label="Tìm tài khoản"
              enterKeyHint="search"
            />
            {q && (
              <button
                type="button"
                className="admin-search-clear"
                aria-label="Xoá từ khoá"
                onClick={() => {
                  setQ('');
                  setPage(1);
                  setQuery('');
                }}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
          <button className="btn">Tìm</button>
        </form>
        <div className="admin-summary" role="status">
          {loading && !data ? (
            'Đang tải…'
          ) : data ? (
            searching ? (
              <>
                <b>{data.total}</b> kết quả cho “{query}”
              </>
            ) : (
              <>
                <b>{data.total}</b> tài khoản
              </>
            )
          ) : null}
          {loading && data && <span className="auth-spinner admin-inline-spinner" aria-hidden="true" />}
        </div>
      </div>

      {loadError && !data ? (
        <LoadError message={loadError} onRetry={load} />
      ) : !data ? (
        <UsersSkeleton />
      ) : data.items.length === 0 ? (
        <EmptyBlock icon="search" title={searching ? 'Không tìm thấy tài khoản nào' : 'Chưa có tài khoản nào'}>
          {searching && <>Không có tên hoặc email nào chứa “{query}”.</>}
        </EmptyBlock>
      ) : (
        <div className={`admin-results${loading ? ' is-stale' : ''}`}>
          {/* Máy tính & máy tính bảng: bảng */}
          <div className="table-wrap admin-table-wrap">
            <table className="table admin-table">
              <thead>
                <tr>
                  <th>Người dùng</th>
                  <th>Trạng thái</th>
                  <th className="admin-col-date">Ngày tạo</th>
                  <th className="admin-th-actions">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id} className={u.isBanned ? 'is-banned' : undefined}>
                    <td>
                      <UserIdentity u={u} isMe={u.id === me?.id} showCreated />
                    </td>
                    <td>
                      <UserChips u={u} />
                    </td>
                    <td className="admin-date admin-col-date">{formatDate(u.createdAt)}</td>
                    <td>
                      <UserActions
                        u={u}
                        canBan={canBanUser(u)}
                        onBan={() => ban(u)}
                        onUnban={() => unban(u)}
                        onAvatar={() => clearAvatar(u)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Điện thoại: thẻ */}
          <ul className="admin-cards">
            {data.items.map((u) => (
              <li key={u.id} className={`admin-card${u.isBanned ? ' is-banned' : ''}`}>
                <UserIdentity u={u} isMe={u.id === me?.id} size={44} />
                <UserChips u={u} />
                <div className="admin-card-foot">
                  <span className="admin-card-date">
                    <Icon name="calendar" size={14} />
                    {formatDate(u.createdAt)}
                  </span>
                  <UserActions
                    u={u}
                    canBan={canBanUser(u)}
                    onBan={() => ban(u)}
                    onUnban={() => unban(u)}
                    onAvatar={() => clearAvatar(u)}
                  />
                </div>
              </li>
            ))}
          </ul>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </div>
      )}
      {modal}
    </section>
  );
}

/* ==========================================================================
   Tab tin nhắn bị báo cáo
   ========================================================================== */

const STATUS_LABEL: Record<ReportStatus, string> = { open: 'Chờ xử lý', resolved: 'Đã xoá tin', dismissed: 'Đã bỏ qua' };
const EMPTY_TEXT: Record<ReportStatus, [string, string]> = {
  open: ['Không có báo cáo nào đang chờ xử lý', 'Khi người chơi báo cáo tin nhắn trong ván, báo cáo sẽ hiện ở đây.'],
  resolved: ['Chưa có tin nhắn nào bị xoá', 'Các báo cáo đã xử lý bằng cách xoá tin nhắn sẽ hiện ở đây.'],
  dismissed: ['Chưa có báo cáo nào bị bỏ qua', 'Các báo cáo bạn đã bỏ qua sẽ hiện ở đây.'],
};

function ReportsSkeleton() {
  return (
    <div className="adm-reports" aria-hidden="true">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="adm-report">
          <div className="adm-report-head">
            <span className="skeleton admin-skel-avatar" />
            <span className="admin-skel-lines">
              <span className="skeleton" style={{ width: '45%' }} />
              <span className="skeleton" style={{ width: '30%' }} />
            </span>
          </div>
          <span className="skeleton adm-skel-quote" />
        </div>
      ))}
    </div>
  );
}

function ReportsTab({ openCount, onOpenCount }: { openCount: number | null; onOpenCount: (n: number) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ReportStatus>('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<AdminReportDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    api
      .get<Paginated<AdminReportDto>>(`/api/admin/reports?status=${status}&page=${page}`)
      .then((d) => {
        if (id !== seq.current) return;
        // Vừa xử lý hết mục của trang cuối → lùi về trang trước
        if (d.items.length === 0 && d.page > 1) {
          setPage(d.page - 1);
          return;
        }
        setData(d);
        setLoadError(null);
        if (status === 'open') onOpenCount(d.total);
      })
      .catch((e) => {
        if (id !== seq.current) return;
        toast(errorMessage(e), 'error');
        setLoadError(errorMessage(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [status, page, toast, onOpenCount]);
  useEffect(load, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(key);
    try {
      await fn();
      toast(ok, 'success');
      load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const { ask, modal } = useConfirm(load);
  const deleteMessage = (r: AdminReportDto) =>
    ask({
      title: 'Xoá tin nhắn này?',
      icon: 'trash',
      tone: 'danger',
      danger: true,
      confirmLabel: 'Xoá tin nhắn',
      busyLabel: 'Đang xoá…',
      body: (
        <>
          <blockquote className="adm-report-quote adm-modal-quote">“{r.message.content}”</blockquote>
          <p className="admin-modal-text">
            Tin nhắn của <b>{r.message.author.username}</b> sẽ bị ẩn khỏi khung chat của ván đấu, và mọi báo cáo về tin này được đánh dấu
            đã xử lý.
          </p>
        </>
      ),
      run: () => api.post(`/api/admin/messages/${r.message.id}/delete`),
      ok: 'Đã xoá tin nhắn',
    });

  return (
    <section className="panel admin-panel" aria-busy={loading || undefined}>
      <div className="admin-toolbar">
        <div className="seg seg-sm admin-status-seg" role="group" aria-label="Lọc theo trạng thái">
          {(['open', 'resolved', 'dismissed'] as const).map((s) => (
            <button
              key={s}
              className={status === s ? 'active' : ''}
              aria-pressed={status === s}
              onClick={() => {
                if (s === status) return;
                setStatus(s);
                setPage(1);
                setData(null);
              }}
            >
              {STATUS_LABEL[s]}
              {s === 'open' && !!openCount && <span className="admin-seg-count">{openCount}</span>}
            </button>
          ))}
        </div>
        {data && data.total > 0 && (
          <div className="admin-summary" role="status">
            <b>{data.total}</b> báo cáo
            {loading && <span className="auth-spinner admin-inline-spinner" aria-hidden="true" />}
          </div>
        )}
      </div>

      {loadError && !data ? (
        <LoadError message={loadError} onRetry={load} />
      ) : !data ? (
        <ReportsSkeleton />
      ) : data.items.length === 0 ? (
        <EmptyBlock icon={status === 'open' ? 'check' : 'flag'} title={EMPTY_TEXT[status][0]}>
          {EMPTY_TEXT[status][1]}
        </EmptyBlock>
      ) : (
        <div className={`admin-results${loading ? ' is-stale' : ''}`}>
          <ul className="adm-reports">
            {data.items.map((r) => {
              const author = r.message.author;
              return (
                <li key={r.id} className={`adm-report${r.status === 'open' ? ' is-open' : ''}`}>
                  <div className="adm-report-head">
                    <Avatar name={author.username} url={author.avatarUrl} size={38} />
                    <div className="adm-report-who">
                      {author.isGuest ? (
                        <span className="admin-user-name">{author.username} (khách)</span>
                      ) : (
                        <Link to={`/profile/${author.id}`} className="admin-user-name">
                          {author.username}
                        </Link>
                      )}
                      <span className="adm-report-time">Gửi lúc {formatDate(r.message.createdAt)}</span>
                    </div>
                  </div>
                  <blockquote className={`adm-report-quote${r.message.isDeleted ? ' is-deleted' : ''}`}>
                    “{r.message.content}”
                    {r.message.isDeleted && <span className="adm-deleted-tag">Đã xoá khỏi ván</span>}
                  </blockquote>
                  <div className="adm-report-meta">
                    <span>
                      <Icon name="flag" size={14} />
                      Báo cáo bởi{' '}
                      {r.reporter.isGuest ? (
                        <span>{r.reporter.username} (khách)</span>
                      ) : (
                        <Link to={`/profile/${r.reporter.id}`} className="adm-report-link">
                          {r.reporter.username}
                        </Link>
                      )}
                    </span>
                    <span>
                      <Icon name="clock" size={14} />
                      {formatDate(r.createdAt)}
                    </span>
                    <Link to={`/replay/${r.message.matchId}`} className="adm-report-match">
                      <Icon name="history" size={14} />
                      Xem ván đấu
                    </Link>
                  </div>
                  {r.status === 'open' && (
                    <div className="adm-report-foot">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => act(r.id, () => api.post(`/api/admin/reports/${r.id}/dismiss`), 'Đã bỏ qua báo cáo')}
                      >
                        {busyId === r.id && <span className="auth-spinner" aria-hidden="true" />}
                        Bỏ qua
                      </button>
                      {!r.message.isDeleted && (
                        <button className="btn btn-danger btn-sm" onClick={() => deleteMessage(r)}>
                          <Icon name="trash" size={16} />
                          Xoá tin nhắn
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </div>
      )}
      {modal}
    </section>
  );
}

/* ==========================================================================
   Trang quản trị
   ========================================================================== */
export function AdminPage() {
  const [tab, setTab] = useState<'overview' | 'users' | 'reports'>('overview');
  const [userTotal, setUserTotal] = useState<number | null>(null);
  const [openReports, setOpenReports] = useState<number | null>(null);

  // Số báo cáo đang chờ để hiện trên tab (tab báo cáo tự cập nhật lại khi xử lý)
  useEffect(() => {
    let alive = true;
    api
      .get<Paginated<AdminReportDto>>('/api/admin/reports?status=open&page=1')
      .then((d) => alive && setOpenReports(d.total))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const tabs: Array<{ id: 'overview' | 'users' | 'reports'; label: string; icon: IconName; count: number | null; alert?: boolean }> = [
    { id: 'overview', label: 'Tổng quan', icon: 'chart', count: null },
    { id: 'users', label: 'Người dùng', icon: 'users', count: userTotal },
    { id: 'reports', label: 'Tin nhắn bị báo cáo', icon: 'flag', count: openReports, alert: true },
  ];

  return (
    <div className="admin">
      <header className="admin-head">
        <span className="admin-head-icon">
          <Icon name="shield" size={24} />
        </span>
        <div className="admin-head-text">
          <h1 className="page-title">Quản trị</h1>
          <p>Theo dõi số tài khoản và lượt truy cập, quản lý người chơi, xử lý tin nhắn bị báo cáo.</p>
        </div>
      </header>

      <div
        className="admin-tabs"
        role="tablist"
        aria-label="Khu vực quản trị"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
          e.preventDefault();
          const i = tabs.findIndex((t) => t.id === tab);
          const next =
            e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          setTab(tabs[next].id);
          document.getElementById(`admin-tab-${tabs[next].id}`)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`admin-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="admin-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`admin-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={18} className="admin-tab-icon" />
            <span className="admin-tab-label">{t.label}</span>
            {t.count !== null && (t.count > 0 || !t.alert) && (
              <span className={`admin-count${t.alert && t.count > 0 ? ' is-alert' : ''}`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="admin-tabpanel" aria-labelledby={`admin-tab-${tab}`}>
        {tab === 'overview' ? (
          <AdminDashboard />
        ) : tab === 'users' ? (
          <UsersTab onTotal={setUserTotal} />
        ) : (
          <ReportsTab openCount={openReports} onOpenCount={setOpenReports} />
        )}
      </div>
    </div>
  );
}
