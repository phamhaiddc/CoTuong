import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { Link, NavigationType, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import {
  mailboxKey,
  normalizeEmail,
  validateEmail,
  validatePassword,
  validateUsername,
  type OAuthProvider,
  type RegisterStartRequest,
  type RegisterStartResponse,
  type RegisterVerifyRequest,
  type RegisterVerifyResponse,
  type ResetPasswordResponse,
} from '@cotuong/shared';
import { ApiError, api, errorMessage, friendlyMessage, isTransientError, loadAppConfig, messageFor } from '../api/http';
import { BrandLogo } from '../components/Layout';
import { GameIcon, Icon, type IconName } from '../components/icons';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

/* ==========================================================================
   Khung chung cho các trang tài khoản
   ========================================================================== */

/** Biểu tượng "ẩn mật khẩu" (cùng phong cách với bộ icons.tsx) */
const EYE_OFF_PATH =
  'M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.8-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2';

function EyeOffIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={EYE_OFF_PATH} />
    </svg>
  );
}

/** Hoạ tiết bàn cờ tướng (nét vàng mảnh) làm nền cho cột trang trí */
function BoardPattern() {
  const xs = Array.from({ length: 9 }, (_, i) => -8 + i * 52);
  const ys = Array.from({ length: 10 }, (_, j) => 46 + j * 52);
  const d: string[] = [];
  for (const y of ys) d.push(`M${xs[0]} ${y}H${xs[8]}`);
  xs.forEach((x, i) => {
    if (i === 0 || i === 8) d.push(`M${x} ${ys[0]}V${ys[9]}`);
    else d.push(`M${x} ${ys[0]}V${ys[4]}M${x} ${ys[5]}V${ys[9]}`);
  });
  // Hai cung tướng
  d.push(`M${xs[3]} ${ys[0]}L${xs[5]} ${ys[2]}M${xs[5]} ${ys[0]}L${xs[3]} ${ys[2]}`);
  d.push(`M${xs[3]} ${ys[7]}L${xs[5]} ${ys[9]}M${xs[5]} ${ys[7]}L${xs[3]} ${ys[9]}`);
  return (
    <svg className="auth-pattern" viewBox="0 0 400 560" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      <path d={d.join('')} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** Vài quân cờ "trượt" khỏi góc bàn — hình minh hoạ vật lý nên dùng màu cố định */
function PiecesArt() {
  const uid = useId().replace(/:/g, '');
  const face = `authFace${uid}`;
  const pieces: Array<{ x: number; y: number; r: number; ch: string; red: boolean }> = [
    { x: 132, y: 112, r: 46, ch: '帥', red: true },
    { x: 40, y: 152, r: 33, ch: '車', red: false },
    { x: 188, y: 30, r: 27, ch: '炮', red: true },
  ];
  return (
    <svg className="auth-pieces" viewBox="0 0 220 220" aria-hidden="true">
      <defs>
        <radialGradient id={face} cx="38%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#fff7e6" />
          <stop offset="100%" stopColor="#e6c38a" />
        </radialGradient>
      </defs>
      {pieces.map((p) => {
        const ink = p.red ? '#b3261e' : '#2a211a';
        return (
          <g key={p.ch} transform={`translate(${p.x} ${p.y})`}>
            <circle r={p.r} cy={4} fill="#9c6f35" />
            <circle r={p.r} fill={`url(#${face})`} stroke="#c9a165" strokeWidth="1.5" />
            <circle r={p.r * 0.8} fill="none" stroke={ink} strokeWidth={p.r > 40 ? 2.2 : 1.8} />
            <text
              y={p.r * 0.37}
              textAnchor="middle"
              fontSize={p.r * 1.06}
              fontWeight="700"
              fill={ink}
              fontFamily="KaiTi, STKaiti, 'Kaiti SC', SimSun, serif"
            >
              {p.ch}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const FEATURES: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'trophy', title: 'Ván xếp hạng', text: 'Mỗi quý một mùa giải: leo cấp bậc, tranh suất Top 10.' },
  { icon: 'users', title: 'Phòng riêng', text: 'Gửi đường dẫn hoặc mã phòng để mời bạn bè vào chơi.' },
  { icon: 'bot', title: 'Đấu với máy', text: 'Ba mức Dễ, Trung bình, Khó — có gợi ý nước đi.' },
  { icon: 'puzzle', title: 'Cờ úp & Cờ thế', text: 'Cờ tướng quân úp, và các thế cờ cổ để luyện tập.' },
];

function AuthAside() {
  return (
    <aside className="auth-aside">
      <BoardPattern />
      <div className="auth-aside-body">
        <div className="auth-aside-top">
          <div className="auth-aside-brand">
            <BrandLogo size={48} className="auth-aside-logo" />
            <span className="auth-aside-brand-text">
              <span className="auth-aside-name">Xe Pháo Mã</span>
              <span className="auth-aside-sub">Cờ tướng · Cờ vua</span>
            </span>
          </div>
          <p className="auth-aside-title">Đấu trí trên bàn cờ, leo hạng mỗi mùa giải.</p>
        </div>
        <ul className="auth-features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="auth-feature-icon">
                <Icon name={f.icon} size={18} />
              </span>
              <span>
                <b>{f.title}</b>
                <span>{f.text}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="auth-aside-games">
          <span>
            <GameIcon game="xiangqi" size={22} /> Cờ tướng
          </span>
          <span>
            <GameIcon game="chess" size={22} /> Cờ vua
          </span>
        </div>
      </div>
      <PiecesArt />
    </aside>
  );
}

/** Khung thẻ: có cột trang trí bên trái trên máy tính/máy tính bảng, một cột gọn trên điện thoại */
function AuthShell({ children, aside = true }: { children: ReactNode; aside?: boolean }) {
  return (
    <div className={`auth${aside ? '' : ' auth-compact'}`}>
      <div className={`auth-card${aside ? ' has-aside' : ''}`}>
        {aside && <AuthAside />}
        <div className="auth-main">{children}</div>
      </div>
    </div>
  );
}

function AuthHead({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <header className="auth-head">
      <BrandLogo size={52} className="auth-logo" />
      <h1 className="auth-title">{title}</h1>
      {subtitle && <p className="auth-sub">{subtitle}</p>}
    </header>
  );
}

type Tone = 'ok' | 'danger' | 'info' | 'primary';

/** Màn hình trạng thái (thành công / lỗi / đang xử lý) bên trong thẻ */
function AuthStatus({
  tone,
  icon,
  title,
  titleRef,
  children,
  actions,
  busy = false,
}: {
  tone: Tone;
  icon: IconName;
  title: string;
  /** Có ref: tiêu đề nhận được con trỏ bằng lập trình (tabIndex -1) để đưa con trỏ tới khi màn hình này hiện ra */
  titleRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="auth-status" role={tone === 'danger' ? 'alert' : 'status'}>
      <div className={`auth-status-icon is-${tone}${busy ? ' is-busy' : ''}`}>
        {busy ? <span className="auth-spinner auth-spinner-lg" aria-hidden="true" /> : <Icon name={icon} size={30} />}
      </div>
      <h1 className="auth-title" ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
        {title}
      </h1>
      {children && <div className="auth-status-body">{children}</div>}
      {actions && <div className="auth-status-actions">{actions}</div>}
    </div>
  );
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice danger auth-notice" role="alert">
      <Icon name="alert" size={18} />
      <div>{children}</div>
    </div>
  );
}

function SubmitButton({ busy, busyLabel, children, disabled }: { busy: boolean; busyLabel: string; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" className="btn btn-primary btn-lg btn-block auth-submit" disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <span className="auth-spinner" aria-hidden="true" />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

type FieldStatus = 'ok' | 'error' | null;

/** Ô nhập có nhãn, biểu tượng, gợi ý/lỗi ngay dưới ô và nút hiện/ẩn mật khẩu */
function TextField({
  label,
  icon,
  value,
  onValue,
  hint,
  status = null,
  extra,
  revealable = false,
  inputRef,
  type = 'text',
  ...rest
}: {
  label: string;
  icon: IconName;
  value: string;
  onValue: (v: string) => void;
  hint?: ReactNode;
  status?: FieldStatus;
  /** Nội dung bên phải nhãn, ví dụ liên kết "Quên mật khẩu?" */
  extra?: ReactNode;
  revealable?: boolean;
  inputRef?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>) {
  const id = useId();
  const hintId = `${id}hint`;
  const [shown, setShown] = useState(false);
  return (
    <div className={`auth-field${status ? ` is-${status}` : ''}`}>
      <label htmlFor={id} className="auth-label">
        {label}
      </label>
      <div className={`auth-input${revealable ? ' has-reveal' : ''}`}>
        <Icon name={icon} size={18} className="auth-input-icon" />
        <input
          {...rest}
          id={id}
          ref={inputRef}
          type={revealable && shown ? 'text' : type}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          aria-invalid={status === 'error' ? true : undefined}
          aria-describedby={hint ? hintId : undefined}
        />
        {revealable && (
          <button
            type="button"
            className="auth-reveal"
            onClick={() => setShown((v) => !v)}
            aria-label="Hiện mật khẩu"
            aria-pressed={shown}
            title={shown ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
          >
            {shown ? <EyeOffIcon size={19} /> : <Icon name="eye" size={19} />}
          </button>
        )}
      </div>
      {/* Đứng sau ô nhập trong DOM (Tab đi thẳng email → mật khẩu) nhưng hiển thị cạnh nhãn */}
      {extra && <div className="auth-label-extra">{extra}</div>}
      {hint && (
        <div className="auth-hint" id={hintId}>
          <Icon name={status === 'ok' ? 'check' : status === 'error' ? 'alert' : 'info'} size={14} />
          <span>{hint}</span>
        </div>
      )}
    </div>
  );
}

/** Trạng thái hiển thị của một ô: báo đúng ngay khi hợp lệ, chỉ báo lỗi sau khi rời ô hoặc bấm gửi */
function fieldStatus(value: string, err: string | null, reveal: boolean): FieldStatus {
  if (!err) return value ? 'ok' : null;
  return reveal ? 'error' : null;
}

/** Ô "nhập lại mật khẩu": báo khớp khi mật khẩu đã hợp lệ, báo lệch sau khi rời ô hoặc bấm gửi */
function confirmFieldStatus(confirm: string, confirmErr: string | null, passErr: string | null, reveal: boolean, submitted: boolean): FieldStatus {
  if (!confirm) return submitted && confirmErr ? 'error' : null;
  if (confirmErr) return reveal ? 'error' : null;
  return passErr ? null : 'ok';
}

/** Thông báo trùng lặp của máy chủ khi đăng ký → ô tương ứng + lời nhắn dễ hiểu hơn */
const TAKEN_MESSAGES = new Map<string, { field: 'username' | 'email'; text: string }>([
  ['Email đã được sử dụng', { field: 'email', text: 'Email này đã có tài khoản. Bạn đăng nhập, hoặc dùng “Quên mật khẩu” nếu không nhớ.' }],
  ['Tên hiển thị đã có người dùng', { field: 'username', text: 'Tên này đã có người dùng, bạn chọn tên khác nhé.' }],
]);

/** Lỗi kiểm tra ô nhập (dùng chung với máy chủ) — vài câu nói lại cho rõ hơn */
function fieldError(err: string | null): string | null {
  if (err === 'Thiếu email') return 'Bạn nhập email nhé';
  if (err === 'Email không hợp lệ') return 'Email chưa đúng, ví dụ: ten@gmail.com';
  if (err === 'Thiếu tên hiển thị') return 'Bạn nhập tên hiển thị nhé';
  return err && friendlyMessage(err, 400);
}

function fromOf(state: unknown): string | null {
  const from = (state as { from?: string } | null)?.from;
  // Chỉ đường dẫn nội bộ: "/..." nhưng không phải "//..." (sang trang khác) và không chứa "\" (trình duyệt hiểu thành "/")
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.includes('\\') ? from : null;
}

/* ==========================================================================
   Đăng nhập bằng Google / Facebook (chỉ hiện khi server đã cấu hình mã ứng dụng)
   ========================================================================== */
type Providers = Partial<Record<OAuthProvider, boolean>>;
function loadProviders(): Promise<Providers> {
  return loadAppConfig()
    .then((c) => c.oauth ?? {})
    .catch(() => ({}));
}

/** Thông báo cho mã lỗi ?oauthError= do server chuyển về */
const OAUTH_ERRORS: Record<string, string> = {
  disabled: 'Hiện chưa đăng nhập được bằng cách này. Bạn dùng email và mật khẩu nhé.',
  state: 'Lượt đăng nhập vừa rồi bị gián đoạn hoặc đã quá lâu. Bạn bấm đăng nhập lại nhé.',
  denied: 'Bạn đã huỷ đăng nhập, hoặc chưa cho phép Xe Pháo Mã dùng tài khoản đó.',
  exchange: 'Chưa đăng nhập được bằng Google/Facebook. Bạn thử lại sau ít phút nhé.',
  no_email: 'Tài khoản Google/Facebook này không cho biết email nên chưa tạo được tài khoản. Bạn đăng ký bằng email và mật khẩu nhé.',
  // Cũng gặp khi Google bị từ chối vì tài khoản cùng email chỉ được tin nhờ Facebook (có thể do người khác tạo): chủ hộp
  // thư thật lấy lại bằng "Quên mật khẩu" — đặt lại mật khẩu gỡ các liên kết cũ, sau đó Google liên kết được
  email_exists:
    'Email này đã có tài khoản trên Xe Pháo Mã. Bạn đăng nhập theo cách đã dùng trước đây (email + mật khẩu, hoặc Google), rồi vào Hồ sơ → “Đăng nhập nhanh” để liên kết Facebook/Google cho lần sau. Chưa đặt mật khẩu hoặc không nhớ? Bấm “Quên mật khẩu?” để lấy lại tài khoản qua email nhé.',
  login_required: 'Bạn cần đăng nhập trước, rồi vào Hồ sơ để liên kết Google/Facebook.',
  banned: 'Tài khoản này đã bị khoá nên không đăng nhập được.',
  in_match: 'Tài khoản đang chơi một ván ở trang hoặc thiết bị khác. Bạn đăng nhập ở đây được khi ván đó kết thúc.',
  rate: 'Bạn thử đăng nhập quá nhiều lần. Đợi ít phút rồi thử lại nhé.',
};

function SocialLogin({ from, verb }: { from: string; verb: string }) {
  const [providers, setProviders] = useState<Providers>({});
  useEffect(() => {
    let alive = true;
    void loadProviders().then((p) => alive && setProviders(p));
    return () => {
      alive = false;
    };
  }, []);
  if (!providers.google && !providers.facebook) return null;
  const href = (p: OAuthProvider) => `/api/auth/oauth/${p}/start?from=${encodeURIComponent(from)}`;
  return (
    <div className="auth-social">
      <div className="divider">hoặc</div>
      {providers.google && (
        <a className="btn btn-block auth-social-btn google" href={href('google')}>
          <span className="auth-social-mark" aria-hidden="true">
            G
          </span>
          {verb} với Google
        </a>
      )}
      {providers.facebook && (
        <a className="btn btn-block auth-social-btn facebook" href={href('facebook')}>
          <span className="auth-social-mark" aria-hidden="true">
            f
          </span>
          {verb} với Facebook
        </a>
      )}
    </div>
  );
}

/**
 * Khách đang có ván dở: đăng nhập / tạo tài khoản sẽ thay phiên khách bằng tài khoản (danh tính khách bị bỏ lại),
 * nên nhắc trước để khỏi mất ván.
 */
function GuestMatchNotice({ verb }: { verb: string }) {
  const { me, guest } = useAuth();
  if (me || !guest?.activeMatchId) return null;
  return (
    <div className="notice warn auth-notice" role="status">
      <Icon name="alert" size={18} />
      <div>
        Bạn đang có một ván chưa kết thúc (chơi với tư cách khách). Nếu {verb} bây giờ, bạn sẽ không quay lại ván đó được nữa.{' '}
        <Link to={`/play/${guest.activeMatchId}`}>Quay lại ván</Link>
      </div>
    </div>
  );
}

/* ==========================================================================
   Đăng nhập
   ========================================================================== */
export function LoginPage() {
  const { login, me } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = fromOf(location.state) ?? '/';
  const [params] = useSearchParams();
  const oauthError = params.get('oauthError');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() => (oauthError ? messageFor(OAUTH_ERRORS, oauthError, OAUTH_ERRORS.exchange) : null));
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (me) navigate(from === '/login' ? '/' : from, { replace: true });
  }, [me, from, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Bạn nhập email và mật khẩu nhé.');
      (email.trim() ? passwordRef : emailRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      passwordRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  const toRoom = from.startsWith('/room/');
  // Tới đây vì chưa vào được với tư cách khách (quá nhiều khách, mạng…): lúc đó mới thật sự cần tài khoản để vào phòng
  const guestFailed = (location.state as { guestFailed?: unknown } | null)?.guestFailed === true;

  return (
    <AuthShell>
      <AuthHead title="Đăng nhập" subtitle="Chào mừng bạn trở lại! Đăng nhập để chơi ván xếp hạng và lưu lịch sử ván đấu." />
      <GuestMatchNotice verb="đăng nhập" />
      {toRoom && (
        <div className="notice info auth-notice">
          <Icon name="users" size={18} />
          {guestFailed ? (
            <div>Bạn được mời vào một phòng riêng — đăng nhập (hoặc tạo tài khoản ở cuối trang) để vào phòng.</div>
          ) : (
            <div>
              Bạn được mời vào một phòng riêng. Bạn vào phòng ngay được mà không cần tài khoản, hoặc đăng nhập để lưu ván vào lịch
              sử. <Link to={from}>Vào phòng ngay</Link>
            </div>
          )}
        </div>
      )}
      <form onSubmit={submit} className="form auth-form" noValidate>
        <TextField
          label="Email"
          icon="mail"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="ban@vidu.com"
          value={email}
          onValue={setEmail}
          inputRef={emailRef}
          required
        />
        <TextField
          label="Mật khẩu"
          icon="lock"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Nhập mật khẩu"
          value={password}
          onValue={setPassword}
          inputRef={passwordRef}
          revealable
          required
          extra={
            <Link to="/forgot-password" className="auth-label-link">
              Quên mật khẩu?
            </Link>
          }
        />
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <SubmitButton busy={busy} busyLabel="Đang đăng nhập…">
          Đăng nhập
          <Icon name="arrow-right" size={19} />
        </SubmitButton>
      </form>
      <SocialLogin from={from === '/login' ? '/' : from} verb="Đăng nhập" />
      <p className="auth-foot">
        Chưa có tài khoản?{' '}
        <Link to="/register" state={location.state}>
          Đăng ký ngay
        </Link>
      </p>
    </AuthShell>
  );
}

/* ==========================================================================
   Đăng ký: 3 bước — 1. email → 2. mã 6 chữ số gửi qua email → 3. tên hiển thị + mật khẩu
   - Tiến độ lưu trong sessionStorage của tab (email, regId, phiếu…): tải lại trang, Back/Forward hay rời trang rồi
     quay lại vẫn làm tiếp được, không phải xin mã mới.
   - Lịch sử trình duyệt: 1→2 thêm một mục (Back ở bước 2/3 về bước 1, email vẫn còn), 2→3 thay mục đó (mã đã dùng),
     "Đổi email" và đăng ký xong cũng thay mục. Một lần Back ở bước 1 là rời trang đăng ký.
   ========================================================================== */
type RegStep = 1 | 2 | 3;
const REG_STEPS: readonly string[] = ['Email', 'Nhập mã', 'Tài khoản'];
const OTP_LEN = 6;
const emptyCode = () => Array<string>(OTP_LEN).fill('');

const MSG_MAIL_UNAVAILABLE = 'Chưa gửi được email chứa mã. Bạn thử lại sau ít phút nhé.';
const MSG_CODE_JUST_SENT = 'Mã vừa được gửi tới email này. Bạn nhập mã trong thư, hoặc chờ một chút rồi bấm Gửi lại mã.';
const MSG_NEW_CODE = 'Đã gửi mã mới. Mã cũ không dùng được nữa.';
const MSG_RESEND_WAIT = 'Bạn chờ một chút rồi bấm Gửi lại mã nhé.';
const MSG_VERIFIED = 'Đã xác thực email. Bước cuối: chọn tên hiển thị và mật khẩu.';
const waitMessage = (sec: number) => `Bạn vừa yêu cầu mã cho email này. Chờ ${sec} giây rồi bấm Gửi mã nhé.`;

/** Thanh bước 1-2-3 */
function RegSteps({ step }: { step: RegStep }) {
  return (
    <ol className="reg-steps" aria-label="Các bước đăng ký">
      {REG_STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <li key={label} className={`reg-step is-${state}`} aria-current={n === step ? 'step' : undefined}>
            <span className="reg-step-dot" aria-hidden="true">
              {n < step ? <Icon name="check" size={14} /> : n}
            </span>
            <span className="reg-step-label">
              {label}
              {state === 'done' && <span className="sr-only"> (đã xong)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Ô đang có chữ số `old` nhận thêm chữ khi con trỏ không bôi đen chữ số đó (gõ thêm; hoặc bàn phím gợi ý / tự điền
 * chèn cả mã mà không qua sự kiện dán): chỉ lấy phần vừa chèn, bỏ chữ số cũ.
 */
function insertedText(value: string, old: string, data: string | null, caret: number | null): string {
  // Trình duyệt cho biết đúng phần vừa chèn
  if (data && value.includes(data)) return data;
  // Đủ 6 chữ số: cả mã đã thay chỗ chữ số cũ
  if (value.replace(/\D/g, '').length === OTP_LEN) return value;
  if (caret === value.length && value.startsWith(old)) return value.slice(old.length); // chèn sau chữ số cũ
  if (value.endsWith(old)) return value.slice(0, value.length - old.length); // chèn trước chữ số cũ
  return value;
}

/**
 * 6 ô nhập mã, mỗi ô một chữ số: gõ là tự sang ô kế, Backspace ở ô trống thì lùi về ô trước, dán (hoặc điện thoại tự
 * điền từ tin nhắn/thư) cả 6 số thì điền hết. Bàn phím số trên điện thoại (inputMode numeric).
 */
function OtpInput({
  digits,
  onDigits,
  onComplete,
  busy,
  locked,
  invalid,
  labelId,
  describedBy,
  inputsRef,
}: {
  digits: string[];
  onDigits: (d: string[]) => void;
  onComplete: (code: string) => void;
  /** Đang gửi mã lên máy chủ: khoá ô (chỉ đọc, KHÔNG disabled để không mất con trỏ) */
  busy?: boolean;
  /** Mã đã bị khoá / hết hạn: ô chỉ đọc, không tự gửi (phải bấm "Gửi lại mã") */
  locked?: boolean;
  invalid?: boolean;
  labelId: string;
  describedBy?: string;
  inputsRef: MutableRefObject<Array<HTMLInputElement | null>>;
}) {
  const frozen = !!busy || !!locked;
  const focusAt = (i: number) => {
    const el = inputsRef.current[Math.max(0, Math.min(OTP_LEN - 1, i))];
    el?.focus();
    el?.select();
  };
  /** Ghi chuỗi chữ số bắt đầu từ ô `start` (đủ 6 số thì ghi lại từ ô đầu) */
  const fill = (start: number, text: string) => {
    if (frozen) return;
    const only = text.replace(/\D/g, '');
    if (!only) return;
    const next = [...digits];
    const from = only.length >= OTP_LEN ? 0 : start;
    let i = from;
    for (const ch of only.slice(0, OTP_LEN - from)) next[i++] = ch;
    onDigits(next);
    focusAt(Math.min(i, OTP_LEN - 1));
    if (next.every(Boolean)) onComplete(next.join(''));
  };
  return (
    <div className={`otp${invalid ? ' is-error' : ''}`} role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            inputsRef.current[i] = el;
          }}
          className={`otp-box${d ? ' is-filled' : ''}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          enterKeyHint={i === OTP_LEN - 1 ? 'done' : 'next'}
          aria-label={`Chữ số thứ ${i + 1} trên ${OTP_LEN}`}
          aria-invalid={invalid || undefined}
          value={d}
          readOnly={frozen}
          aria-busy={busy || undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            if (frozen) return;
            const el = e.currentTarget;
            const v = el.value;
            if (v === '') {
              const next = [...digits];
              next[i] = '';
              onDigits(next);
              return;
            }
            // Ô đã có số mà con trỏ không bôi đen: chỉ lấy phần mới gõ / mới chèn
            const data = e.nativeEvent instanceof InputEvent ? e.nativeEvent.data : null;
            fill(i, d && v.length > 1 ? insertedText(v, d, data, el.selectionEnd) : v);
          }}
          onKeyDown={(e) => {
            if (busy) return;
            if (e.key === 'Backspace' && !d && i > 0) {
              e.preventDefault();
              if (locked) return;
              const next = [...digits];
              next[i - 1] = '';
              onDigits(next);
              focusAt(i - 1);
            } else if (e.key === 'ArrowLeft' && i > 0) {
              e.preventDefault();
              focusAt(i - 1);
            } else if (e.key === 'ArrowRight' && i < OTP_LEN - 1) {
              e.preventDefault();
              focusAt(i + 1);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            fill(i, e.clipboardData.getData('text'));
          }}
        />
      ))}
    </div>
  );
}

/** Số giây trong câu "Bạn chờ 42 giây…" của máy chủ (khi thân lỗi thiếu retryAfterSec) */
function secondsIn(msg: string): number | null {
  const m = /(\d+)\s*giây/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Số giây còn lại tới mốc `until` (ms): tự cập nhật mỗi giây và dừng hẳn khi về 0 */
function useSecondsLeft(until: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const ms = until - Date.now();
      if (ms <= 0) return;
      // Hẹn đúng lúc số giây hiển thị đổi; hết giờ thì thôi (không để bộ đếm chạy mãi)
      timer = window.setTimeout(() => {
        setTick((n) => n + 1);
        schedule();
      }, ms % 1000 || 1000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [until]);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** Tiến độ đăng ký của tab này, lưu trong sessionStorage (mỗi tab một bản, đóng tab là mất). Mốc thời gian tính bằng ms */
interface RegSaved {
  /** Email (đã chuẩn hoá) đang đăng ký */
  email: string;
  /** Mã phiên của mã đang chờ nhập (máy chủ cấp mỗi lần gửi mã) */
  regId?: string;
  /** Bước đang hiện */
  step: RegStep;
  /** Lúc được bấm "Gửi lại mã" */
  resendAt: number;
  /** Lúc mã hết hạn; 0 = mã không dùng được nữa (đã dùng / bị khoá / hết hạn) */
  codeExpiresAt: number;
  /** Phiếu dùng một lần cho bước 3 (có sau khi nhập đúng mã) */
  ticket?: string;
  ticketExpiresAt?: number;
  /** Trang đang xem trước khi vào đăng ký (nút "Tiếp tục" quay lại đó) */
  from?: string;
}
/** Dữ liệu đăng ký đang giữ (không gồm bước đang hiện) */
type RegSession = Omit<RegSaved, 'step'>;

const REG_STORE_KEY = 'cotuong.register';
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;

function loadReg(): RegSaved | null {
  try {
    const raw = sessionStorage.getItem(REG_STORE_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.email !== 'string' || validateEmail(o.email)) return null;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    const token = (x: unknown) => (typeof x === 'string' && TOKEN_RE.test(x) ? x : undefined);
    const ticket = token(o.ticket);
    return {
      email: normalizeEmail(o.email),
      regId: token(o.regId),
      step: o.step === 2 || o.step === 3 ? o.step : 1,
      resendAt: num(o.resendAt),
      codeExpiresAt: num(o.codeExpiresAt),
      ticket,
      ticketExpiresAt: ticket ? num(o.ticketExpiresAt) : undefined,
      from: fromOf(o) ?? undefined,
    };
  } catch {
    return null;
  }
}

function saveReg(s: RegSaved | null): void {
  try {
    if (s) sessionStorage.setItem(REG_STORE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(REG_STORE_KEY);
  } catch {
    /* Trình duyệt chặn bộ nhớ (chế độ riêng tư…): vẫn đăng ký được, chỉ không khôi phục được khi tải lại trang */
  }
}

const codeLive = (s: RegSession | null) => !!s?.regId && s.codeExpiresAt > Date.now();
const ticketLive = (s: RegSession | null) => !!s?.ticket && (s.ticketExpiresAt ?? 0) > Date.now();
/** Bước mở lại được từ dữ liệu đang giữ: 3 khi phiếu còn hạn, 2 khi mã còn hạn, còn lại 1 */
const liveStep = (s: RegSession | null): RegStep => (ticketLive(s) ? 3 : codeLive(s) ? 2 : 1);

/** location.state của trang đăng ký: trang gốc (from) và bước của mục lịch sử này (không có regStep = bước 1) */
function regNavState(from: string | null, step: RegStep): { from?: string; regStep?: 2 | 3 } | null {
  if (step === 1) return from ? { from } : null;
  return from ? { from, regStep: step } : { regStep: step };
}
function entryStep(state: unknown): RegStep {
  const s = (state as { regStep?: unknown } | null)?.regStep;
  return s === 2 || s === 3 ? s : 1;
}
/** Vị trí của mục lịch sử đang mở (React Router ghi trong history.state.idx) */
function historyIdx(): number | null {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
}
/** Trang để quay lại sau khi đăng ký xong (bỏ trang chủ và chính các trang đăng nhập / đăng ký) */
function returnPath(from: string | null | undefined): string | null {
  return from && from !== '/' && !from.startsWith('/login') && !from.startsWith('/register') ? from : null;
}

/**
 * Vào trang: khôi phục tiến độ của tab này.
 * - Tải lại trang / Back / Forward: theo bước của mục lịch sử, nếu mã / phiếu còn dùng được.
 * - Bấm liên kết tới trang đăng ký khi đang làm dở: mở lại đúng bước, thêm một mục lịch sử để Back về bước 1.
 */
function initRegister(state: unknown, navType: NavigationType): { reg: RegSession | null; step: RegStep; nav: 'push' | 'replace' | null } {
  const saved = loadReg();
  let reg: RegSession | null = saved && {
    email: saved.email,
    regId: saved.regId,
    resendAt: saved.resendAt,
    codeExpiresAt: saved.codeExpiresAt,
    ticket: saved.ticket,
    ticketExpiresAt: saved.ticketExpiresAt,
    from: saved.from,
  };
  const live = liveStep(reg);
  // Mã và phiếu đều không dùng được nữa: chỉ giữ email để khỏi gõ lại
  if (reg && live === 1) reg = { email: reg.email, resendAt: 0, codeExpiresAt: 0 };
  const want = entryStep(state);
  if (navType === NavigationType.Pop) {
    if (want === 1) return { reg, step: 1, nav: null };
    return { reg, step: live, nav: live === want ? null : 'replace' };
  }
  if (saved && saved.step !== 1 && live !== 1) return { reg, step: live, nav: 'push' };
  return { reg, step: 1, nav: want === 1 ? null : 'replace' };
}

export function RegisterPage() {
  const { completeRegistration, me, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const [init] = useState(() => initRegister(location.state, navType));
  const [reg, setReg] = useState<RegSession | null>(init.reg);
  const [step, setStep] = useState<RegStep>(init.step);
  const [email, setEmail] = useState(init.reg?.email ?? '');
  const [digits, setDigits] = useState<string[]>(emptyCode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Lời báo (không phải lỗi) ở bước 2 */
  const [info, setInfo] = useState<string | null>(null);
  /** Lỗi của chính mã vừa nhập (sai / thiếu số): tô đỏ 6 ô. Lỗi khác (mạng, gửi lại mã…) không tô */
  const [codeError, setCodeError] = useState(false);
  /** Mã đã bị khoá / hết hạn: phải gửi mã mới */
  const [codeDead, setCodeDead] = useState(false);
  /** Máy chủ bảo chờ rồi mới gửi mã tới hộp thư này (tab này không giữ mã nào của email đó) */
  const [waitFor, setWaitFor] = useState<{ box: string; until: number } | null>(null);
  /** Câu cho trình đọc màn hình; id đổi mỗi lần để câu giống hệt lần trước vẫn được đọc lại */
  const [live, setLive] = useState({ id: 0, text: '' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState<Record<RegStep, boolean>>({ 1: false, 2: false, 3: false });
  /** Lỗi "đã có người dùng" từ máy chủ, gắn vào đúng ô cho tới khi người dùng sửa giá trị */
  const [taken, setTaken] = useState<{ field: 'username' | 'email'; value: string; message: string } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const resendRef = useRef<HTMLButtonElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const otpLabelId = useId();
  const otpHintId = useId();
  /** Còn trên trang (không điều hướng khi câu trả lời về sau lúc người dùng đã đi trang khác) */
  const alive = useRef(true);
  /** Lần gọi /register/complete gần nhất lỗi mạng / máy chủ: có thể tài khoản đã được tạo mà mất câu trả lời */
  const completeLost = useRef(false);
  /** Mục lịch sử đã xử lý gần nhất (key + vị trí) */
  const seenKey = useRef(location.key);
  const seenIdx = useRef(historyIdx());
  const shownStep = useRef(init.step);
  const mountNav = useRef(init.nav);

  const from = returnPath(fromOf(location.state)) ?? returnPath(reg?.from);
  const fromState = from ? { from } : undefined;
  const path = location.pathname + location.search;
  const success = done && !!me;
  /** Bước hiển thị (phòng khi thiếu dữ liệu cho bước 2/3 thì về bước 1, không kẹt) */
  const view: RegStep = (step === 2 && !reg) || (step === 3 && !reg?.ticket) ? 1 : step;

  const announce = (text: string) => setLive((l) => ({ id: l.id + 1, text }));
  /** Câu trả lời về khi người dùng đã sang mục lịch sử khác / trang khác: chỉ lưu dữ liệu, không đổi giao diện */
  const stale = (key: string) => !alive.current || seenKey.current !== key;
  /** Đổi dữ liệu đang giữ và ghi ngay vào sessionStorage (kể cả khi trang đã đóng trước lúc câu trả lời về) */
  const saveNow = (next: RegSession | null, s: RegStep) => {
    setReg(next);
    saveReg(next ? { ...next, step: s } : null);
  };
  /** Đổi bước và ghi vào lịch sử: push (1→2) để Back về bước 1; replace cho các trường hợp còn lại */
  const goStep = (next: RegStep, push: boolean) => {
    setStep(next);
    if (alive.current) navigate(path, { replace: !push, state: regNavState(from, next) });
  };
  /** Tạo tài khoản xong: xoá tiến độ đã lưu, thay mục lịch sử (Back không quay lại bước 3) */
  const finish = () => {
    completeLost.current = false;
    saveNow(null, 1);
    setDone(true);
    if (alive.current) navigate(path, { replace: true, state: regNavState(from, 1) });
  };

  useEffect(() => {
    alive.current = true;
    // Vào trang khi đang làm dở: sửa mục lịch sử cho khớp bước đang hiện (StrictMode chạy effect 2 lần: chỉ làm 1 lần)
    const nav = mountNav.current;
    mountNav.current = null;
    if (nav === 'push') {
      if (entryStep(location.state) !== 1) navigate(path, { replace: true, state: regNavState(from, 1) });
      navigate(path, { state: regNavState(from, init.step) });
    } else if (nav === 'replace') navigate(path, { replace: true, state: regNavState(from, init.step) });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy khi vào trang
  }, []);

  // Lưu tiến độ vào sessionStorage mỗi khi đổi
  useEffect(() => saveReg(reg ? { ...reg, step } : null), [reg, step]);

  useEffect(() => {
    if (!me || done) return;
    // Lần tạo tài khoản trước lỗi mạng nhưng thật ra đã xong (giờ mới biết đã đăng nhập đúng email này): báo thành công
    if (completeLost.current && reg && normalizeEmail(me.email) === reg.email) finish();
    else navigate('/', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, done, navigate]);

  // Back / Forward / liên kết tới chính trang này: đưa bước đang hiện về đúng mục lịch sử
  useLayoutEffect(() => {
    if (seenKey.current === location.key) return;
    seenKey.current = location.key;
    const idx = historyIdx();
    const back = navType === NavigationType.Pop && idx !== null && seenIdx.current !== null && idx < seenIdx.current;
    seenIdx.current = idx;
    const want = entryStep(location.state);
    // Back từ bước 1 (hoặc từ màn hình đăng ký xong) mà gặp một mục khác của trang này: lùi tiếp, để một lần Back là
    // rời trang đăng ký
    if (back && (success || (view === 1 && want === 1))) {
      navigate(-1);
      return;
    }
    if (success) return;
    const next = want === 1 ? 1 : liveStep(reg);
    // Mục lịch sử cũ không dùng được nữa (mã hết hạn, đã đổi email…): ghi lại cho khớp
    if (next !== want) navigate(path, { replace: true, state: regNavState(from, next) });
    if (next === view) return;
    setStep(next);
    setError(null);
    setInfo(null);
    setCodeError(false);
    setCodeDead(false);
    setDigits(emptyCode());
    if (next === 1) setEmail((v) => v || reg?.email || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Đổi bước: đưa con trỏ vào ô đầu tiên của bước mới — chỉ khi bước thật sự đổi (lúc vào trang thì không), như nhau
  // ở bản dev (StrictMode chạy effect 2 lần) và bản build
  useEffect(() => {
    if (shownStep.current === view) return;
    shownStep.current = view;
    if (view === 1) emailRef.current?.focus();
    else if (view === 2) otpRefs.current[0]?.focus();
    else userRef.current?.focus();
  }, [view]);

  // Màn hình "Đăng ký thành công" thay biểu mẫu: đưa con trỏ tới tiêu đề (không rơi về đầu trang)
  useEffect(() => {
    if (success) successRef.current?.focus();
  }, [success]);

  // Đếm ngược "Gửi lại mã" (bước 2) và "Gửi mã" (bước 1, khi máy chủ bảo chờ)
  const resendLeft = useSecondsLeft(view === 2 && reg ? reg.resendAt : 0);
  const waitLeft = useSecondsLeft(view === 1 && waitFor ? waitFor.until : 0);
  const waiting = !!waitFor && waitLeft > 0 && waitFor.box === mailboxKey(email);

  // Mã bị khoá / hết hạn: khi "Gửi lại mã" bấm được thì đưa con trỏ tới nút đó
  const canResend = view === 2 && !busy && resendLeft === 0;
  useEffect(() => {
    if (codeDead && canResend) resendRef.current?.focus();
  }, [codeDead, canResend]);

  const takenFor = (field: 'username' | 'email', value: string) =>
    taken && taken.field === field && taken.value === value ? taken.message : null;
  const emailErr = fieldError(validateEmail(email)) ?? takenFor('email', email);
  const userErr = fieldError(validateUsername(username)) ?? takenFor('username', username);
  const passErr = fieldError(validatePassword(password));
  const confirmErr = password !== confirm ? 'Mật khẩu nhập lại chưa khớp' : null;
  const reveal = (k: string, s: RegStep) => submitted[s] || !!touched[k];
  const blur = (k: string) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const markSubmitted = (s: RegStep) => setSubmitted((v) => (v[s] ? v : { ...v, [s]: true }));

  const emailStatus = fieldStatus(email, emailErr, reveal('email', 1));
  const userStatus = fieldStatus(username, userErr, reveal('username', 3));
  const passStatus = fieldStatus(password, passErr, reveal('password', 3));
  const confirmStatus = confirmFieldStatus(confirm, confirmErr, passErr, reveal('confirm', 3), submitted[3]);

  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Gửi mã không được: báo theo mã lỗi của máy chủ */
  const startFailed = (er: unknown, norm: string, mine: RegSession | null, resend: boolean) => {
    const msg = errorMessage(er);
    const code = er instanceof ApiError ? er.code : undefined;
    const tk = TAKEN_MESSAGES.get(msg);
    if (tk?.field === 'email') {
      // Email đã có tài khoản (có thể vừa được tạo trong lúc chờ mã): báo ngay dưới ô email ở bước 1
      const shown = email || norm;
      setEmail(shown);
      setTaken({ field: 'email', value: shown, message: tk.text });
      markSubmitted(1);
      if (resend) {
        saveNow(mine && { email: mine.email, resendAt: 0, codeExpiresAt: 0, from: mine.from }, 1);
        setDigits(emptyCode());
        setCodeError(false);
        setCodeDead(false);
        goStep(1, false);
      } else emailRef.current?.focus();
      return;
    }
    if (code === 'reg_resend_wait') {
      const sec = (er instanceof ApiError ? er.retryAfterSec : undefined) ?? secondsIn(msg) ?? 60;
      const until = Date.now() + sec * 1000;
      if (mine && codeLive(mine)) {
        // Tab này đang giữ mã còn hạn của chính email này: nhập mã đó (hết giờ chờ thì gửi lại được)
        saveNow({ ...mine, resendAt: until }, 2);
        setInfo(MSG_CODE_JUST_SENT);
        announce(MSG_CODE_JUST_SENT);
        if (!resend) {
          setDigits(emptyCode());
          setCodeError(false);
          setCodeDead(false);
          goStep(2, true);
        }
      } else if (resend) {
        // Mã đang hiện không dùng được nữa: chờ hết giờ trên nút rồi gửi lại
        if (mine) saveNow({ ...mine, resendAt: until }, 2);
        setInfo(MSG_RESEND_WAIT);
        announce(MSG_RESEND_WAIT);
      } else {
        // Tab này không giữ mã nào của email này: không nói là "đã có mã", chỉ báo chờ rồi bấm gửi
        setWaitFor({ box: mailboxKey(norm), until });
        announce(waitMessage(sec));
        // Nút "Gửi mã" sắp bị khoá trong lúc chờ: đưa tiêu điểm về ô email để bàn phím / trình đọc màn hình không rơi về
        // đầu trang (như các lỗi khác ở bước này)
        emailRef.current?.focus();
      }
      return;
    }
    // reg_mail_quota / reg_ip_limit: lời nhắn của máy chủ đã nói cần chờ bao lâu. mail_unavailable kèm retryAfterSec (trang
    // đã gửi hết phần thư mã đăng ký): lời nhắn của máy chủ nói thời gian chờ thật (có khi vài giờ) và gợi ý Google /
    // Facebook → dùng nguyên văn; không kèm (gửi thư lỗi) thì báo chung "thử lại sau ít phút"
    const capWait = code === 'mail_unavailable' && er instanceof ApiError && er.retryAfterSec !== undefined;
    setError(capWait ? msg : code === 'mail_unavailable' ? MSG_MAIL_UNAVAILABLE : fieldError(msg));
    if (!resend) emailRef.current?.focus();
  };

  /** Gửi (hoặc gửi lại) mã tới `addr` */
  const sendCode = (addr: string, resend: boolean) => {
    const key = location.key;
    return run(async () => {
      setError(null);
      setInfo(null);
      const norm = normalizeEmail(addr);
      const mine = reg && reg.email === norm ? reg : null;
      // Gửi kèm regId của lần trước (cùng email): máy chủ huỷ mã cũ đó
      const body: RegisterStartRequest = mine?.regId ? { email: addr, regId: mine.regId } : { email: addr };
      let r: RegisterStartResponse;
      try {
        r = await api.post<RegisterStartResponse>('/api/auth/register/start', body);
      } catch (er) {
        if (!stale(key)) startFailed(er, norm, mine, resend);
        return;
      }
      const t = Date.now();
      saveNow(
        {
          email: r.email,
          regId: r.regId,
          resendAt: t + r.resendAfterSec * 1000,
          codeExpiresAt: t + r.expiresInSec * 1000,
          from: from ?? undefined,
        },
        2,
      );
      if (stale(key)) return;
      setWaitFor(null);
      setDigits(emptyCode());
      setCodeError(false);
      setCodeDead(false);
      setSubmitted((v) => ({ ...v, 2: false }));
      if (resend) {
        setInfo(MSG_NEW_CODE);
        announce(MSG_NEW_CODE);
        otpRefs.current[0]?.focus();
      } else {
        announce(`Đã gửi mã gồm 6 chữ số tới ${r.email}.`);
        goStep(2, true);
      }
    });
  };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    markSubmitted(1);
    if (emailErr) {
      setError(null);
      emailRef.current?.focus();
      return;
    }
    if (waiting || busyRef.current) return;
    if (reg && reg.email === normalizeEmail(email) && ticketLive(reg)) {
      // Email này vừa được xác thực trong tab này (Back từ bước 3): sang thẳng bước 3, không cần mã mới
      setError(null);
      goStep(3, true);
      return;
    }
    void sendCode(email, false);
  };

  const verify = (code: string) => {
    const cur = reg;
    const regId = cur?.regId;
    const key = location.key;
    if (!cur || !regId || codeDead) return;
    void run(async () => {
      setError(null);
      setInfo(null);
      setCodeError(false);
      try {
        const body: RegisterVerifyRequest = { email: cur.email, regId, code };
        const r = await api.post<RegisterVerifyResponse>('/api/auth/register/verify', body);
        // Mã đã dùng: giữ phiếu cho bước 3 (tải lại trang, Back rồi Forward vẫn về được bước 3)
        saveNow({ ...cur, regId: undefined, codeExpiresAt: 0, ticket: r.ticket, ticketExpiresAt: Date.now() + r.expiresInSec * 1000 }, 3);
        if (stale(key)) return;
        announce(MSG_VERIFIED);
        goStep(3, false);
      } catch (er) {
        const c = er instanceof ApiError ? er.code : undefined;
        const dead = c === 'reg_code_locked' || c === 'reg_code_expired';
        if (dead) saveNow({ ...cur, codeExpiresAt: 0 }, 2);
        if (stale(key)) return;
        setError(errorMessage(er));
        if (dead || c === 'reg_code_wrong') {
          setDigits(emptyCode());
          if (dead) setCodeDead(true);
          else setCodeError(true);
          otpRefs.current[0]?.focus();
        }
        // Lỗi khác (mạng, máy chủ, thử quá nhiều lần từ một nơi): mã chưa được kiểm tra — giữ nguyên 6 số để thử lại
      }
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (codeDead) return;
    markSubmitted(2);
    const code = digits.join('');
    if (code.length < OTP_LEN) {
      setError('Bạn nhập đủ 6 chữ số trong thư nhé.');
      setCodeError(true);
      otpRefs.current[digits.findIndex((d) => !d)]?.focus();
      return;
    }
    verify(code);
  };

  const changeEmail = () => {
    setError(null);
    setInfo(null);
    setDigits(emptyCode());
    setCodeError(false);
    setCodeDead(false);
    // Bỏ mã / phiếu đang giữ, giữ lại email để sửa
    if (reg) saveNow({ email: reg.email, resendAt: 0, codeExpiresAt: 0, from: reg.from }, 1);
    setEmail((v) => v || reg?.email || '');
    goStep(1, false);
  };

  const submitAccount = (e: FormEvent) => {
    e.preventDefault();
    markSubmitted(3);
    const err = userErr ?? passErr ?? confirmErr;
    if (err) {
      setError(null);
      (userErr ? userRef : passErr ? passRef : confirmRef).current?.focus();
      return;
    }
    const cur = reg;
    const ticket = cur?.ticket;
    const key = location.key;
    if (!cur || !ticket) return;
    void run(async () => {
      setError(null);
      setInfo(null);
      setDone(true);
      try {
        await completeRegistration(ticket, username, password);
        finish();
      } catch (er) {
        const code = er instanceof ApiError ? er.code : undefined;
        const transient = isTransientError(er);
        // Có thể tài khoản đã được tạo nhưng mất câu trả lời: hỏi lại máy chủ trước khi báo lỗi
        if (transient || (code === 'reg_ticket_expired' && completeLost.current)) {
          const u = await refresh();
          if (u && normalizeEmail(u.email) === cur.email) {
            finish();
            return;
          }
        }
        completeLost.current = transient;
        setDone(false);
        const msg = errorMessage(er);
        const tk = TAKEN_MESSAGES.get(msg);
        const back = code === 'reg_ticket_expired' || tk?.field === 'email';
        // Phiếu hết hạn / email vừa có người dùng: bỏ phiếu, về bước 1 (giữ email)
        if (back) saveNow({ email: cur.email, resendAt: cur.resendAt, codeExpiresAt: 0, from: cur.from }, 1);
        if (stale(key)) return;
        if (code === 'reg_ticket_expired') {
          setDigits(emptyCode());
          setError(msg);
          goStep(1, false);
        } else if (tk?.field === 'email') {
          const shown = email || cur.email;
          setEmail(shown);
          setTaken({ field: 'email', value: shown, message: tk.text });
          markSubmitted(1);
          goStep(1, false);
        } else if (tk) {
          setTaken({ field: 'username', value: username, message: tk.text });
          userRef.current?.focus();
        } else setError(fieldError(msg));
      }
    });
  };

  if (success && me) {
    return (
      <AuthShell>
        <AuthStatus
          tone="ok"
          icon="check"
          title="Đăng ký thành công"
          titleRef={successRef}
          actions={
            from ? (
              <>
                <Link className="btn btn-primary btn-lg" to={from}>
                  Tiếp tục
                  <Icon name="arrow-right" size={19} />
                </Link>
                <Link className="btn btn-ghost btn-lg" to="/">
                  Về trang chủ
                </Link>
              </>
            ) : (
              <Link className="btn btn-primary btn-lg" to="/">
                Về trang chủ
                <Icon name="arrow-right" size={19} />
              </Link>
            )
          }
        >
          <p>
            Chào <b>{me.username}</b>! Tài khoản của bạn đã sẵn sàng, email <b className="auth-break">{me.email}</b> đã được xác thực.
          </p>
          <ul className="auth-steps">
            <li>
              <span className="auth-step-icon">
                <Icon name="trophy" size={18} />
              </span>
              <span>
                Bạn chơi được ngay mọi chế độ, kể cả <b>ván xếp hạng</b>.
              </span>
            </li>
            <li>
              <span className="auth-step-icon">
                <Icon name="play" size={18} />
              </span>
              <span>Phòng riêng, đấu với máy, Cờ úp và Cờ thế đều đang chờ bạn.</span>
            </li>
          </ul>
        </AuthStatus>
      </AuthShell>
    );
  }

  const sub =
    view === 1
      ? 'Nhập email của bạn, Xe Pháo Mã sẽ gửi mã xác thực gồm 6 chữ số.'
      : view === 2
        ? 'Kiểm tra hộp thư của bạn.'
        : 'Bước cuối: chọn tên hiển thị và mật khẩu.';

  return (
    <AuthShell>
      <AuthHead title="Tạo tài khoản" subtitle={sub} />
      <RegSteps step={view} />
      <GuestMatchNotice verb="tạo tài khoản" />
      {/* Vùng đọc cho trình đọc màn hình: luôn có mặt (ngoài các bước) để lời báo mới được đọc */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live.text && <span key={live.id}>{live.text}</span>}
      </p>

      {view === 1 && (
        <form onSubmit={submitEmail} className="form auth-form" noValidate>
          <TextField
            label="Email"
            icon="mail"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="ban@vidu.com"
            value={email}
            onValue={setEmail}
            onBlur={blur('email')}
            inputRef={emailRef}
            status={emailStatus}
            hint={
              emailStatus === 'error' ? (
                <>
                  {emailErr}
                  {takenFor('email', email) && (
                    <>
                      {' '}
                      <Link to="/login" state={fromState}>
                        Đăng nhập
                      </Link>
                      {' · '}
                      <Link to="/forgot-password">Quên mật khẩu</Link>
                    </>
                  )}
                </>
              ) : (
                'Dùng để xác thực tài khoản và lấy lại mật khẩu khi quên. Người khác không thấy email này.'
              )
            }
            required
          />
          {waiting && (
            <div className="notice info auth-notice" aria-hidden="true">
              <Icon name="clock" size={18} />
              <div>{waitMessage(waitLeft)}</div>
            </div>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <SubmitButton busy={busy} busyLabel="Đang gửi mã…" disabled={waiting}>
            {waiting ? (
              `Gửi mã xác thực (${waitLeft} giây)`
            ) : (
              <>
                Gửi mã xác thực
                <Icon name="arrow-right" size={19} />
              </>
            )}
          </SubmitButton>
        </form>
      )}

      {view === 2 && reg && (
        <form onSubmit={submitCode} className="form auth-form" noValidate>
          <div className="reg-sent">
            <span className="reg-sent-icon" aria-hidden="true">
              <Icon name="mail" size={20} />
            </span>
            <p>
              Chúng tôi đã gửi mã gồm 6 chữ số tới <b className="auth-break">{reg.email}</b>. Mã dùng được trong 10 phút.
            </p>
          </div>
          <div className="reg-otp-field">
            <div className="reg-otp-head">
              <span className="auth-label" id={otpLabelId}>
                Mã xác thực
              </span>
              <button type="button" className="link-btn reg-change" onClick={changeEmail} disabled={busy}>
                Đổi email
              </button>
            </div>
            <OtpInput
              digits={digits}
              onDigits={(d) => {
                setDigits(d);
                setCodeError(false);
                if (error && !codeDead) setError(null);
              }}
              onComplete={verify}
              busy={busy}
              locked={codeDead}
              invalid={codeError}
              labelId={otpLabelId}
              describedBy={otpHintId}
              inputsRef={otpRefs}
            />
            <p className="auth-hint reg-otp-hint" id={otpHintId}>
              <Icon name="info" size={14} />
              <span>Không thấy thư? Bạn xem cả mục Thư rác (Spam) hoặc Quảng cáo nhé.</span>
            </p>
          </div>
          {/* Đã đọc qua vùng aria-live ở trên: khung này chỉ để nhìn */}
          {info && !error && (
            <div className="notice info auth-notice" aria-hidden="true">
              <Icon name="check" size={18} />
              <div>{info}</div>
            </div>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <SubmitButton busy={busy} busyLabel="Đang kiểm tra…" disabled={codeDead}>
            Xác nhận mã
            <Icon name="arrow-right" size={19} />
          </SubmitButton>
          <div className="reg-resend">
            <span>Chưa nhận được mã?</span>
            <button
              ref={resendRef}
              type="button"
              className={`btn ${codeDead && resendLeft === 0 ? 'btn-primary' : 'btn-ghost'} reg-resend-btn`}
              onClick={() => void sendCode(reg.email, true)}
              disabled={busy || resendLeft > 0}
            >
              <Icon name="restart" size={16} />
              {resendLeft > 0 ? `Gửi lại mã (${resendLeft} giây)` : 'Gửi lại mã'}
            </button>
          </div>
        </form>
      )}

      {view === 3 && reg && (
        <form onSubmit={submitAccount} className="form auth-form" noValidate>
          <div className="reg-verified">
            <Icon name="check" size={16} />
            <span>
              Đã xác thực <b className="auth-break">{reg.email}</b>
            </span>
          </div>
          <TextField
            label="Tên hiển thị"
            icon="user"
            name="username"
            autoComplete="nickname"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="VD: KyThu_123"
            maxLength={20}
            value={username}
            onValue={setUsername}
            onBlur={blur('username')}
            inputRef={userRef}
            status={userStatus}
            hint={userStatus === 'error' ? userErr : 'Tên người khác sẽ thấy: 3–20 ký tự (chữ, số, dấu cách, dấu _ . -)'}
            required
          />
          {/* Giúp trình quản lý mật khẩu lưu đúng email cho mật khẩu mới */}
          <input type="email" name="email" autoComplete="username" value={reg.email} readOnly hidden />
          <TextField
            label="Mật khẩu"
            icon="lock"
            type="password"
            name="password"
            autoComplete="new-password"
            placeholder="Ít nhất 8 ký tự"
            value={password}
            onValue={setPassword}
            onBlur={blur('password')}
            inputRef={passRef}
            status={passStatus}
            hint={passStatus === 'error' ? passErr : 'Ít nhất 8 ký tự (chữ, số, ký hiệu đều được)'}
            revealable
            required
          />
          <TextField
            label="Nhập lại mật khẩu"
            icon="lock"
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            placeholder="Nhập lại mật khẩu ở trên"
            value={confirm}
            onValue={setConfirm}
            onBlur={blur('confirm')}
            inputRef={confirmRef}
            status={confirmStatus}
            hint={confirmStatus === 'error' ? confirmErr : confirmStatus === 'ok' ? 'Mật khẩu khớp' : undefined}
            revealable
            required
          />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <SubmitButton busy={busy} busyLabel="Đang tạo tài khoản…">
            Tạo tài khoản
          </SubmitButton>
        </form>
      )}

      {view === 1 && <SocialLogin from={from ?? '/'} verb="Đăng ký" />}
      <p className="auth-foot">
        Đã có tài khoản?{' '}
        <Link to="/login" state={fromState}>
          Đăng nhập
        </Link>
      </p>
    </AuthShell>
  );
}

/* ==========================================================================
   Xác thực email
   ========================================================================== */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { me, refresh } = useAuth();
  const toast = useToast();
  const token = params.get('token');
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [message, setMessage] = useState('');
  /** Lỗi do mạng / máy chủ tạm thời: cho thử lại thay vì bảo gửi thư mới */
  const [transient, setTransient] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const started = useRef(-1);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    if (!token) {
      setState('error');
      setTransient(false);
      setMessage('Liên kết xác thực bị thiếu hoặc bị cắt mất một phần.');
      return;
    }
    setState('loading');
    api
      .post('/api/auth/verify-email', { token })
      .then(async () => {
        setState('ok');
        await refresh();
      })
      .catch((e) => {
        setState('error');
        setTransient(isTransientError(e));
        setMessage(errorMessage(e));
      });
  }, [token, refresh, attempt]);

  const resend = async () => {
    if (!me) return;
    setSending(true);
    try {
      await api.post('/api/auth/resend-verification');
      toast(`Đã gửi thư xác thực mới tới ${me.email}. Nếu không thấy, bạn xem cả mục Thư rác (Spam).`, 'success', 6000);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthShell aside={false}>
      {state === 'loading' && (
        <AuthStatus tone="primary" icon="mail" title="Đang xác thực email…" busy>
          <p>Bạn chờ một chút nhé.</p>
        </AuthStatus>
      )}
      {state === 'ok' && (
        <AuthStatus
          tone="ok"
          icon="check"
          title="Email đã được xác thực"
          actions={
            <>
              <Link className="btn btn-primary btn-lg" to="/">
                Bắt đầu chơi
                <Icon name="arrow-right" size={19} />
              </Link>
              {!me && (
                <Link className="btn btn-ghost btn-lg" to="/login">
                  Đăng nhập
                </Link>
              )}
            </>
          }
        >
          <p>
            {me
              ? 'Tài khoản của bạn đã sẵn sàng. Bạn có thể chơi ván xếp hạng ngay bây giờ.'
              : 'Email đã được xác thực. Bạn đăng nhập để chơi ván xếp hạng nhé.'}
          </p>
        </AuthStatus>
      )}
      {state === 'error' && transient && (
        <AuthStatus
          tone="danger"
          icon="wifi-off"
          title="Chưa xác thực được email"
          actions={
            <>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => setAttempt((n) => n + 1)}>
                <Icon name="restart" size={18} />
                Thử lại
              </button>
              <Link className="btn btn-ghost btn-lg" to="/">
                Về trang chủ
              </Link>
            </>
          }
        >
          <p className="auth-status-msg">{message}</p>
          <p className="muted small">Khi có mạng trở lại, bạn bấm “Thử lại” nhé.</p>
        </AuthStatus>
      )}
      {state === 'error' && !transient && (
        <AuthStatus
          tone="danger"
          icon="alert"
          title="Không xác thực được email"
          actions={
            <>
              {me && !me.emailVerified ? (
                <button type="button" className="btn btn-primary btn-lg" onClick={resend} disabled={sending}>
                  {sending ? <span className="auth-spinner" aria-hidden="true" /> : <Icon name="send" size={18} />}
                  {sending ? 'Đang gửi…' : 'Gửi thư xác thực mới'}
                </button>
              ) : !me ? (
                <Link className="btn btn-primary btn-lg" to="/login">
                  Đăng nhập
                </Link>
              ) : null}
              <Link className="btn btn-ghost btn-lg" to="/">
                Về trang chủ
              </Link>
            </>
          }
        >
          <p className="auth-status-msg">{message}</p>
          <p className="muted small">
            {me && !me.emailVerified
              ? 'Bạn mở liên kết trong thư xác thực mới nhất, hoặc bấm nút bên dưới để nhận thư mới.'
              : !me
                ? 'Bạn mở liên kết trong thư xác thực mới nhất, hoặc đăng nhập để nhận thư mới.'
                : 'Bạn mở liên kết trong thư xác thực mới nhất nhé.'}
          </p>
        </AuthStatus>
      )}
    </AuthShell>
  );
}

/* ==========================================================================
   Quên mật khẩu
   ========================================================================== */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const emailErr = fieldError(validateEmail(email));
  const emailStatus = fieldStatus(email, emailErr, submitted);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (emailErr) {
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (er) {
      setError(errorMessage(er));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthShell>
        <AuthStatus
          tone="ok"
          icon="mail"
          title="Hãy kiểm tra hộp thư"
          actions={
            <Link className="btn btn-primary btn-lg" to="/login">
              <Icon name="arrow-left" size={19} />
              Quay lại đăng nhập
            </Link>
          }
        >
          <p>
            Nếu <b className="auth-break">{email.trim()}</b> là email đã đăng ký ở Xe Pháo Mã, bạn sẽ nhận được thư có liên kết đặt lại mật
            khẩu. Liên kết dùng được trong 1 giờ.
          </p>
          <p className="muted small">
            Không thấy thư? Bạn xem cả mục Thư rác (Spam), hoặc đợi khoảng 1 phút rồi{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setSent(false);
                setSubmitted(false);
              }}
            >
              gửi lại
            </button>
            .
          </p>
        </AuthStatus>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHead title="Quên mật khẩu" subtitle="Nhập email bạn đã dùng để đăng ký. Xe Pháo Mã sẽ gửi thư có liên kết để bạn đặt mật khẩu mới." />
      <form onSubmit={submit} className="form auth-form" noValidate>
        <TextField
          label="Email đã đăng ký"
          icon="mail"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="ban@vidu.com"
          value={email}
          onValue={setEmail}
          inputRef={emailRef}
          status={emailStatus}
          hint={emailStatus === 'error' ? emailErr : undefined}
          required
        />
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <SubmitButton busy={busy} busyLabel="Đang gửi…">
          <Icon name="send" size={18} />
          Gửi thư đặt lại mật khẩu
        </SubmitButton>
      </form>
      <p className="auth-foot">
        <Link to="/login" className="auth-back">
          <Icon name="arrow-left" size={16} />
          Quay lại đăng nhập
        </Link>
      </p>
    </AuthShell>
  );
}

/* ==========================================================================
   Đặt lại mật khẩu
   ========================================================================== */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { resync } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** Liên kết Google / Facebook máy chủ vừa gỡ khi đặt lại mật khẩu (báo cho người dùng biết để liên kết lại) */
  const [removedLinks, setRemovedLinks] = useState<OAuthProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const passRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const passErr = fieldError(validatePassword(password));
  const confirmErr = password !== confirm ? 'Mật khẩu nhập lại chưa khớp' : null;
  const reveal = (k: string) => submitted || !!touched[k];
  const blur = (k: string) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const passStatus = fieldStatus(password, passErr, reveal('password'));
  const confirmStatus = confirmFieldStatus(confirm, confirmErr, passErr, reveal('confirm'), submitted);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const err = passErr ?? confirmErr;
    if (err) {
      (passErr ? passRef : confirmRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ResetPasswordResponse>('/api/auth/reset-password', { token, password });
      setRemovedLinks(Array.isArray(r?.removedLinks) ? r.removedLinks : []);
      // Đặt lại mật khẩu huỷ mọi phiên của tài khoản ĐÓ. Trình duyệt này có thể đang đăng nhập một tài khoản khác (máy dùng
      // chung) — phiên đó vẫn còn: hỏi lại máy chủ thay vì tự coi là đã đăng xuất
      void resync();
      setDone(true);
    } catch (er) {
      setError(errorMessage(er));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell>
        <AuthStatus
          tone="danger"
          icon="link"
          title="Liên kết không hợp lệ"
          actions={
            <>
              <Link className="btn btn-primary btn-lg" to="/forgot-password">
                <Icon name="send" size={18} />
                Gửi thư mới
              </Link>
              <Link className="btn btn-ghost btn-lg" to="/login">
                Quay lại đăng nhập
              </Link>
            </>
          }
        >
          <p>Liên kết này bị thiếu hoặc bị cắt mất một phần. Bạn mở lại liên kết trong thư, hoặc yêu cầu gửi thư mới.</p>
        </AuthStatus>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <AuthStatus
          tone="ok"
          icon="key"
          title="Đã đổi mật khẩu"
          actions={
            <Link className="btn btn-primary btn-lg" to="/login">
              Đăng nhập
              <Icon name="arrow-right" size={19} />
            </Link>
          }
        >
          <p>Mật khẩu mới đã có hiệu lực. Để an toàn, tài khoản đã được đăng xuất trên mọi thiết bị — bạn đăng nhập lại bằng mật khẩu mới nhé.</p>
          {removedLinks.length > 0 && (
            <p>
              Đăng nhập bằng {removedLinks.map((p) => (p === 'google' ? 'Google' : 'Facebook')).join(' và ')} cũng đã được gỡ
              khỏi tài khoản (để chắc rằng chỉ chủ email vào được). Nếu đó là của bạn, hãy đăng nhập rồi liên kết lại trong
              Hồ sơ nhé.
            </p>
          )}
        </AuthStatus>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHead title="Đặt lại mật khẩu" subtitle="Chọn mật khẩu mới cho tài khoản của bạn." />
      <form onSubmit={submit} className="form auth-form" noValidate>
        <TextField
          label="Mật khẩu mới"
          icon="lock"
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder="Ít nhất 8 ký tự"
          value={password}
          onValue={setPassword}
          onBlur={blur('password')}
          inputRef={passRef}
          status={passStatus}
          hint={passStatus === 'error' ? passErr : 'Ít nhất 8 ký tự (chữ, số, ký hiệu đều được)'}
          revealable
          required
        />
        <TextField
          label="Nhập lại mật khẩu mới"
          icon="lock"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          placeholder="Nhập lại mật khẩu ở trên"
          value={confirm}
          onValue={setConfirm}
          onBlur={blur('confirm')}
          inputRef={confirmRef}
          status={confirmStatus}
          hint={confirmStatus === 'error' ? confirmErr : confirmStatus === 'ok' ? 'Mật khẩu khớp' : undefined}
          revealable
          required
        />
        {error && (
          <ErrorNotice>
            {error}{' '}
            <Link to="/forgot-password" className="auth-inline-link">
              Gửi thư mới
            </Link>
          </ErrorNotice>
        )}
        <SubmitButton busy={busy} busyLabel="Đang đổi mật khẩu…">
          Đổi mật khẩu
        </SubmitButton>
      </form>
      <p className="auth-foot">
        <Link to="/login" className="auth-back">
          <Icon name="arrow-left" size={16} />
          Quay lại đăng nhập
        </Link>
      </p>
    </AuthShell>
  );
}
