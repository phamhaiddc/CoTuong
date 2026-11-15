import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { AdminDayStatDto, AdminStatsDto } from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { Icon, type IconName } from '../components/icons';

/* ==========================================================================
   Tab "Tổng quan" của trang quản trị: số tài khoản, người đang online, lượt truy cập, ván đấu.
   Số liệu từ GET /api/admin/stats (tự làm mới mỗi phút khi tab đang mở).
   ========================================================================== */

const REFRESH_MS = 60_000;
const nf = new Intl.NumberFormat('vi-VN');
const fmt = (n: number) => nf.format(n);
const compact = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
/** Trục số: dưới 10.000 ghi đủ, từ 10.000 ghi gọn (vd "12 N") */
const fmtAxis = (n: number, max: number) => (max >= 10_000 ? compact.format(n) : fmt(n));

const PAGE_LABELS: Record<string, string> = {
  '/': 'Trang chủ',
  '/login': 'Đăng nhập',
  '/register': 'Đăng ký',
  '/verify-email': 'Xác thực email',
  '/forgot-password': 'Quên mật khẩu',
  '/reset-password': 'Đặt lại mật khẩu',
  '/seasons': 'Mùa giải',
  '/co-up': 'Cờ úp',
  '/co-the': 'Cờ thế — danh sách',
  '/co-the/:id': 'Cờ thế — giải một thế',
  '/ai': 'Đấu với máy',
  '/admin': 'Quản trị',
  '/play/:id': 'Bàn cờ (đang chơi)',
  '/room/:code': 'Phòng riêng (lời mời)',
  '/profile/:id': 'Hồ sơ người chơi',
  '/replay/:id': 'Xem lại ván',
  '(khác)': 'Trang khác',
};

type MetricKey = 'visitors' | 'pageViews' | 'members' | 'newAccounts' | 'matches';
const METRICS: ReadonlyArray<{ key: MetricKey; label: string; unit: string; hint: string }> = [
  { key: 'visitors', label: 'Người xem', unit: 'người xem', hint: 'Số trình duyệt khác nhau đã mở web (ước lượng, sai số khoảng 1%)' },
  { key: 'pageViews', label: 'Lượt xem trang', unit: 'lượt xem', hint: 'Mỗi lần mở một trang tính một lượt' },
  { key: 'members', label: 'Thành viên hoạt động', unit: 'thành viên', hint: 'Tài khoản thật (không gồm khách) có mở web trong ngày' },
  { key: 'newAccounts', label: 'Tài khoản mới', unit: 'tài khoản mới', hint: 'Đăng ký mới trong ngày (không gồm khách, máy)' },
  { key: 'matches', label: 'Ván đấu', unit: 'ván', hint: 'Ván bắt đầu trong ngày (mọi loại; ván với máy chỉ tính khi đã lưu)' },
];

const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const weekday = (d: string) =>
  new Date(`${d}T12:00:00+07:00`).toLocaleDateString('vi-VN', { weekday: 'long', timeZone: 'Asia/Ho_Chi_Minh' });

/** Thang trục y: bước tròn (1, 2, 5 × 10ⁿ), tối đa khoảng 4 vạch, số nguyên */
function yScale(maxValue: number): { max: number; ticks: number[] } {
  const target = Math.max(maxValue, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? 10 * pow);
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return { max, ticks };
}

function Tile({ icon, tone, label, value, sub }: { icon: IconName; tone: string; label: string; value: number; sub?: ReactNode }) {
  return (
    <div className="adm-tile">
      <span className={`adm-tile-ico is-${tone}`} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div className="adm-tile-body">
        <div className="adm-tile-label">{label}</div>
        <div className="adm-tile-value">{fmt(value)}</div>
        {sub && <div className="adm-tile-sub">{sub}</div>}
      </div>
    </div>
  );
}

function Section({ title, icon, children, note }: { title: string; icon: IconName; children: ReactNode; note?: ReactNode }) {
  const id = useId();
  return (
    <section className="panel adm-dash-card" aria-labelledby={id}>
      <h2 id={id} className="adm-dash-title">
        <Icon name={icon} size={18} />
        {title}
      </h2>
      {children}
      {note && <p className="adm-dash-note">{note}</p>}
    </section>
  );
}

/** Nhãn trục ngang: mỗi 7 ngày tính lùi từ hôm nay (cùng thứ trong tuần) — nhãn rộng "Hôm nay" cách nhãn kế 7 cột nên không
 *  đè lên nhau kể cả trên điện thoại 360 px */
const X_LABEL_EVERY = 7;

/**
 * Biểu đồ cột 30 ngày, một số liệu mỗi lần (chọn bằng nút); rê chuột / phím mũi tên để xem từng ngày. Màn hình cảm ứng:
 * chạm (hoặc trượt ngang) lên cột để xem, chú giải giữ nguyên sau khi nhấc tay; chạm ra ngoài hoặc bấm Esc để ẩn.
 */
function DailyChart({ days }: { days: AdminDayStatDto[] }) {
  const [metric, setMetric] = useState<MetricKey>('visitors');
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const m = METRICS.find((x) => x.key === metric)!;
  const values = days.map((d) => d[metric]);
  const { max, ticks } = yScale(Math.max(0, ...values));
  const total = values.reduce((a, b) => a + b, 0);
  const n = days.length;
  const chartRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);

  /** Cảm ứng / bút: chọn cột theo vị trí ngón tay (không có rê chuột để báo cột nào) */
  const pickAt = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    const box = colsRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const i = Math.floor(((e.clientX - box.left) / box.width) * n);
    if (i >= 0 && i < n) setActive(i);
  };

  // Chạm ra ngoài biểu đồ thì ẩn chú giải (trên cảm ứng chú giải không tự ẩn khi nhấc tay)
  useEffect(() => {
    if (active === null) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (chartRef.current && !chartRef.current.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [active]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = active === null ? n - 1 : Math.max(0, active - 1);
    else if (e.key === 'ArrowRight') next = active === null ? n - 1 : Math.min(n - 1, active + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  const tip = active !== null ? days[active] : null;
  // Chú giải bám theo cột, nhưng không tràn khỏi khung ở hai đầu
  const tipAlign = active === null ? '' : active < 4 ? ' is-start' : active > n - 5 ? ' is-end' : '';

  return (
    <section className="panel adm-dash-card adm-chart-card" aria-labelledby={titleId}>
      <div className="adm-chart-head">
        <h2 id={titleId} className="adm-dash-title">
          <Icon name="chart" size={18} />
          {m.label} — 30 ngày gần nhất
        </h2>
        <div className="adm-seg" role="group" aria-label="Chọn số liệu cho biểu đồ">
          {METRICS.map((x) => (
            <button key={x.key} type="button" aria-pressed={x.key === metric} className={x.key === metric ? 'active' : ''} onClick={() => setMetric(x.key)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <p className="adm-chart-sub">
        {m.hint}. Tổng 30 ngày: <b>{fmt(total)}</b> · Hôm nay: <b>{fmt(values[n - 1] ?? 0)}</b>
      </p>

      <div
        className="adm-chart"
        tabIndex={0}
        role="group"
        aria-label={`Biểu đồ cột: ${m.label} theo ngày. Dùng phím mũi tên trái, phải để nghe từng ngày.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        // Cảm ứng: trình duyệt báo pointerleave ngay khi nhấc tay → chỉ ẩn khi chuột rời biểu đồ
        onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
        onPointerDown={pickAt}
        onPointerMove={pickAt}
        ref={chartRef}
      >
        <div className="adm-chart-plot">
          {ticks.map((t) => (
            <div key={t} className="adm-grid-line" style={{ bottom: `${(t / max) * 100}%` }} aria-hidden="true">
              <span>{fmtAxis(t, max)}</span>
            </div>
          ))}
          <div className="adm-chart-cols" ref={colsRef}>
            {days.map((d, i) => (
              <div key={d.date} className={`adm-col${active === i ? ' is-active' : ''}`} onPointerEnter={() => setActive(i)} aria-hidden="true">
                <div className="adm-bar" style={{ height: `${(values[i] / max) * 100}%` }} />
              </div>
            ))}
          </div>
          {tip && (
            <div className={`adm-tip${tipAlign}`} style={{ left: `${((active! + 0.5) / n) * 100}%` }} aria-hidden="true">
              <b>{fmt(values[active!])}</b> {m.unit}
              <span>
                {weekday(tip.date)} {dayLabel(tip.date)}
              </span>
            </div>
          )}
        </div>
        <div className="adm-chart-x" aria-hidden="true">
          {days.map((d, i) => (
            <span key={d.date} className={(n - 1 - i) % X_LABEL_EVERY === 0 ? '' : 'is-hidden'}>
              {i === n - 1 ? 'Hôm nay' : dayLabel(d.date)}
            </span>
          ))}
        </div>
        {/* Đọc cho trình đọc màn hình khi chọn ngày bằng bàn phím */}
        <span className="sr-only" aria-live="polite">
          {tip ? `${weekday(tip.date)} ${dayLabel(tip.date)}: ${fmt(values[active!])} ${m.unit}` : ''}
        </span>
      </div>

      <details className="adm-table-toggle">
        <summary>Xem bảng số liệu theo ngày</summary>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Ngày</th>
                {METRICS.map((x) => (
                  <th key={x.key} scope="col">
                    {x.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.date}>
                  <th scope="row">{dayLabel(d.date)}</th>
                  {METRICS.map((x) => (
                    <td key={x.key}>{fmt(d[x.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/**
 * Dòng phụ của ô "Khách": số ngày giữ khách lấy từ máy chủ (theo cấu hình hạn phiên — không ghi cứng). Máy chủ cũ chưa
 * gửi số này thì không nêu số ngày.
 */
function guestSub(a: AdminStatsDto['accounts']): string {
  const days = (a as AdminStatsDto['accounts'] & { guestTtlDays?: unknown }).guestTtlDays;
  return typeof days === 'number' && Number.isFinite(days) && days > 0
    ? `Chơi không cần tài khoản, tự xoá sau ${fmt(days)} ngày`
    : 'Chơi không cần tài khoản, tự xoá sau khi phiên hết hạn';
}

function TopPages({ pages }: { pages: AdminStatsDto['topPages'] }) {
  const top = pages[0]?.views ?? 0;
  if (!pages.length) return <p className="adm-empty">Hôm nay chưa có lượt xem nào.</p>;
  return (
    <ol className="adm-pages">
      {pages.map((p) => (
        <li key={p.path}>
          <span className="adm-page-name">{PAGE_LABELS[p.path] ?? p.path}</span>
          <span className="adm-page-track" aria-hidden="true">
            <span className="adm-page-bar" style={{ width: `${top ? Math.max(2, (p.views / top) * 100) : 0}%` }} />
          </span>
          <span className="adm-page-num">{fmt(p.views)}</span>
        </li>
      ))}
    </ol>
  );
}

export function AdminDashboard() {
  const [data, setData] = useState<AdminStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<AdminStatsDto>('/api/admin/stats'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Tải ngay, rồi tự làm mới mỗi phút khi tab trình duyệt đang hiện
  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  if (!data) {
    return error ? (
      <div className="panel adm-dash-error" role="alert">
        <Icon name="alert" size={22} />
        <div>
          <b>Chưa tải được số liệu.</b> {error}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Thử lại
        </button>
      </div>
    ) : (
      <div className="panel adm-dash-loading" aria-busy="true">
        Đang tải số liệu…
      </div>
    );
  }

  const a = data.accounts;
  const tr = data.traffic;
  const pct = (x: number) => (a.members ? Math.round((x / a.members) * 100) : 0);
  const updated = new Date(data.generatedAt).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  return (
    <div className="adm-dash">
      <div className="adm-dash-bar">
        <span className="adm-dash-updated">
          Cập nhật lúc {updated} (giờ Việt Nam) · tự làm mới mỗi phút
          {error && <span className="adm-dash-stale"> · lần làm mới gần nhất bị lỗi: {error}</span>}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
          <Icon name="restart" size={16} /> {loading ? 'Đang tải…' : 'Làm mới'}
        </button>
      </div>

      <Section title="Đang hoạt động" icon="wifi">
        <div className="adm-tiles">
          <Tile icon="wifi" tone="ok" label="Đang kết nối" value={data.online.connected} sub="Thành viên + khách đang mở web (không gồm máy)" />
          <Tile icon="eye" tone="info" label="Đang xem web" value={data.online.visitorsNow} sub="Trình duyệt mở trang trong 5 phút qua" />
          <Tile icon="swords" tone="primary" label="Ván đang diễn ra" value={data.matches.live} sub="Ván người với người chưa kết thúc" />
        </div>
      </Section>

      <Section title="Tài khoản" icon="users">
        <div className="adm-tiles">
          <Tile icon="users" tone="primary" label="Thành viên" value={a.members} sub={`+${fmt(a.newToday)} hôm nay`} />
          <Tile icon="plus" tone="ok" label="Mới trong 7 ngày" value={a.new7d} sub={`${fmt(a.new30d)} trong 30 ngày`} />
          <Tile icon="mail" tone="info" label="Đã xác thực email" value={a.verified} sub={`${pct(a.verified)}% thành viên`} />
          <Tile icon="link" tone="info" label="Liên kết Google" value={a.viaGoogle} />
          <Tile icon="link" tone="info" label="Liên kết Facebook" value={a.viaFacebook} />
          <Tile icon="lock" tone="danger" label="Bị khoá" value={a.banned} />
          <Tile icon="user" tone="muted" label="Khách (tạm thời)" value={a.guests} sub={guestSub(a)} />
          <Tile icon="bot" tone="muted" label="Máy chơi" value={a.bots} />
          <Tile icon="shield" tone="gold" label="Quản trị viên" value={a.admins} />
        </div>
      </Section>

      <Section
        title="Lượt truy cập"
        icon="eye"
        note="Chỉ đếm trình duyệt thật (bỏ qua bot, công cụ tự động). Không lưu địa chỉ IP. Người xem đếm không trùng trong cả khoảng thời gian."
      >
        <div className="adm-table-wrap">
          <table className="adm-table adm-traffic">
            <thead>
              <tr>
                <th scope="col">Khoảng thời gian</th>
                <th scope="col">Lượt xem trang</th>
                <th scope="col">Người xem</th>
                <th scope="col">Thành viên hoạt động</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Hôm nay', tr.today],
                  ['7 ngày gần nhất', tr.last7d],
                  ['30 ngày gần nhất', tr.last30d],
                ] as const
              ).map(([label, v]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{fmt(v.pageViews)}</td>
                  <td>{fmt(v.visitors)}</td>
                  <td>{fmt(v.members)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <DailyChart days={data.days} />

      <div className="adm-dash-2col">
        <Section title="Ván đấu hôm nay" icon="swords" note={`Tổng số ván đã lưu: ${fmt(data.matches.total)}`}>
          <div className="adm-tiles is-compact">
            <Tile icon="trophy" tone="gold" label="Xếp hạng" value={data.matches.today.ranked} />
            <Tile icon="users" tone="primary" label="Không xếp hạng" value={data.matches.today.unranked} sub="Phòng riêng, Cờ úp" />
            <Tile icon="bot" tone="info" label="Với máy (đã lưu)" value={data.matches.today.ai} />
          </div>
        </Section>
        <Section title="Trang xem nhiều hôm nay" icon="list">
          <TopPages pages={data.topPages} />
        </Section>
      </div>
    </div>
  );
}
