import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { GAME_LABEL, PRIVATE_ROOM_TTL_MS, type ProfileDto, type RoomDto, type TimeControl } from '@cotuong/shared';
import { api } from '../api/http';
import { isTransientAck } from '../api/ack';
import { emit } from '../api/socket';
import { GameIcon, Icon } from '../components/icons';
import { Avatar, TierBadge } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useRealtime } from '../state/realtime';

/** Biểu tượng "ngẫu nhiên" (hai mũi tên đan chéo), cùng phong cách với icons.tsx */
const SHUFFLE_PATH = 'M3.5 7.5h2.8c2 0 3.2 1 4.2 2.8l2.9 5c1 1.8 2.2 2.7 4.2 2.7h2.9M3.5 17.9h2.8c1.3 0 2.2-.4 3-1.3M13.9 8.8c.8-.9 1.7-1.3 3-1.3h3.6M18 5l2.5 2.5L18 10M18 15.5l2.5 2.5-2.5 2.5';

function ShuffleIcon({ size = 16 }: { size?: number }) {
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
      <path d={SHUFFLE_PATH} />
    </svg>
  );
}

/** "10 phút mỗi bên" + "Cộng thêm 5 giây sau mỗi nước" */
function describeTimeControl(tc: TimeControl): { main: string; note: string } {
  const min = tc.initialMs / 60_000;
  const inc = tc.incrementMs / 1000;
  const minText = Number.isInteger(min) ? String(min) : min.toFixed(1);
  return { main: `${minText} phút mỗi bên`, note: inc > 0 ? `Cộng thêm ${inc} giây sau mỗi nước` : 'Không cộng thêm giờ sau mỗi nước' };
}

/** Hoạ tiết lưới bàn cờ mảnh trên dải tiêu đề */
function HeroPattern() {
  const xs = Array.from({ length: 13 }, (_, i) => i * 44);
  const ys = Array.from({ length: 5 }, (_, j) => 10 + j * 44);
  const d = [...ys.map((y) => `M0 ${y}H528`), ...xs.map((x) => `M${x} 0V200`)].join('');
  return (
    <svg className="invite-pattern" viewBox="0 0 528 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M220 10L308 98M308 10L220 98" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function InviteSkeleton({ connected, error, onRetry }: { connected: boolean; error?: string | null; onRetry?: () => void }) {
  return (
    <article className="invite-card is-loading" aria-busy={error ? undefined : true}>
      <div className="invite-hero">
        <HeroPattern />
      </div>
      <div className="invite-body">
        <div className="invite-avatar">
          <span className="skeleton invite-skel-avatar" />
        </div>
        <span className="skeleton invite-skel-line" style={{ width: '70%' }} />
        <span className="skeleton invite-skel-line is-thin" style={{ width: '40%' }} />
        <div className="invite-facts">
          <span className="skeleton invite-skel-fact" />
          <span className="skeleton invite-skel-fact" />
        </div>
        {error ? (
          <div className="notice warn invite-notice" role="alert">
            <Icon name="alert" size={18} />
            <div className="grow">
              <div>Chưa mở được lời mời: {error}</div>
              {onRetry && (
                <button type="button" className="link-btn invite-recheck" onClick={onRetry}>
                  Thử lại
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <span className="skeleton invite-skel-btn" />
            <p className="invite-loading-text" role="status">
              {connected ? 'Đang mở lời mời…' : 'Đang kết nối…'}
            </p>
          </>
        )}
      </div>
    </article>
  );
}

/** Không cho bấm "Kiểm tra lại" dồn dập (máy chủ giới hạn số lần hỏi phòng) */
const RECHECK_COOLDOWN_MS = 3_000;

/** Trang mở từ link mời phòng riêng */
export function RoomPage() {
  const { code = '' } = useParams();
  // player: danh tính để chơi (thành viên hoặc khách); me: chỉ thành viên (xem hồ sơ cần tài khoản)
  const { me, player } = useAuth();
  const playerId = player?.id;
  const { setRoom, connected } = useRealtime();
  const { setGame } = useGameSelect();
  const navigate = useNavigate();
  const [room, setRoomInfo] = useState<RoomDto | null>(null);
  /** Phòng chắc chắn không vào được (không còn / mã sai): màn hình lỗi */
  const [error, setError] = useState<string | null>(null);
  /** Lần mở lời mời đầu tiên gặp lỗi tạm thời: báo trên khung chờ, có nút Thử lại */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [host, setHost] = useState<ProfileDto | null>(null);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    setLoadError(null);
    void emit('room:info', { code }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setRoomInfo(r.room);
        setGame(r.room.game);
        // Chủ phòng mở lại đường dẫn của mình: quay về màn hình chờ (phòng Cờ úp ở trang Cờ úp)
        if (playerId && r.room.host.id === playerId) {
          setRoom(r.room);
          navigate(r.room.variant === 'jieqi' ? '/co-up' : '/', { replace: true });
        }
      } else if (isTransientAck(r)) setLoadError(r.error);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [code, connected, playerId, navigate, setGame, setRoom, loadNonce]);

  // Ảnh đại diện và cấp bậc của chủ phòng (chỉ để trang trí — lỗi thì bỏ qua). Xem hồ sơ cần tài khoản: khách bỏ qua
  // (gọi sẽ bị 401); chủ phòng là khách thì không có hồ sơ → không gọi.
  const hostId = room?.host.isGuest ? undefined : room?.host.id;
  const member = !!me;
  useEffect(() => {
    if (!hostId || !member) return;
    let alive = true;
    api
      .get<ProfileDto>(`/api/users/${hostId}/profile`)
      .then((p) => alive && setHost(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hostId, member]);

  // Chủ phòng đang vắng: hỏi lại xem họ đã quay lại chưa. Sau mỗi lần hỏi, nút nghỉ vài giây
  const [checking, setChecking] = useState(false);
  const [cooling, setCooling] = useState(false);
  useEffect(() => {
    if (!cooling) return;
    const t = window.setTimeout(() => setCooling(false), RECHECK_COOLDOWN_MS);
    return () => window.clearTimeout(t);
  }, [cooling]);
  const recheck = async () => {
    setChecking(true);
    const r = await emit('room:info', { code });
    setChecking(false);
    setCooling(true);
    if (r.ok) {
      // Kiểm tra được: bỏ lỗi cũ (vd "thao tác quá nhanh" của lần trước); chủ phòng vẫn vắng thì thẻ tự hiện lời giải thích
      setRoomInfo(r.room);
      setJoinError(null);
    } else if (isTransientAck(r)) setJoinError(r.error);
    else setError(r.error);
  };

  const join = async () => {
    setJoining(true);
    setJoinError(null);
    const r = await emit('room:join', { code });
    // Thành công: sự kiện match:found cũng sẽ chuyển sang bàn cờ
    if (r.ok) {
      setJoining(false);
      navigate(`/play/${r.matchId}`);
      return;
    }
    // Lỗi tạm thời (thao tác quá nhanh, mất kết nối…): phòng có thể vẫn còn → báo trên thẻ để thử lại
    if (isTransientAck(r)) {
      setJoining(false);
      setJoinError(r.error);
      return;
    }
    // Phòng không còn nữa → màn hình lỗi; phòng vẫn còn (vd. đang tìm trận) → báo ngay trên thẻ để thử lại
    const info = await emit('room:info', { code });
    setJoining(false);
    if (info.ok) {
      setRoomInfo(info.room);
      setJoinError(r.error);
    } else if (isTransientAck(info)) setJoinError(r.error);
    else setError(r.error);
  };

  if (error) {
    return (
      <div className="invite">
        <article className="invite-card is-error">
          <div className="invite-state">
            <div className="invite-state-icon">
              <Icon name="link" size={30} />
            </div>
            <span className="invite-state-code">Phòng {code}</span>
            <h1 className="invite-title">Không vào được phòng</h1>
            <p className="invite-state-msg">{error}</p>
            <p className="invite-state-help">Hãy nhờ người mời tạo phòng mới rồi gửi lại đường dẫn, hoặc tự tạo phòng ở trang chủ.</p>
            <Link to="/" className="btn btn-primary btn-lg invite-state-btn">
              <Icon name="home" size={19} />
              Về trang chủ
            </Link>
          </div>
        </article>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="invite">
        <InviteSkeleton connected={connected} error={loadError} onRetry={() => setLoadNonce((n) => n + 1)} />
      </div>
    );
  }

  const hostStats = host?.games.find((g) => g.game === room.game)?.current ?? null;
  const gameLabel = room.variant === 'jieqi' ? 'Cờ úp' : GAME_LABEL[room.game];
  // Phòng chưa có người vào tự huỷ sau PRIVATE_ROOM_TTL_MS kể từ lúc tạo
  const expiresAt = new Date(room.createdAt + PRIVATE_ROOM_TTL_MS).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const jieqi = room.variant === 'jieqi';
  const time = describeTimeControl(room.timeControl);
  const hostAway = room.hostOnline === false;

  return (
    <div className="invite">
      <article className="invite-card">
        <div className="invite-hero">
          <HeroPattern />
          <span className="invite-kicker">
            <Icon name="mail" size={16} />
            Lời mời<span className="invite-kicker-extra"> phòng riêng</span>
          </span>
          <span className="invite-code" title="Mã phòng">
            <span className="invite-code-label">Mã</span>
            {room.code}
          </span>
        </div>

        <div className="invite-body">
          <div className="invite-avatar">
            <Avatar name={room.host.username} url={host?.user.avatarUrl} size={88} />
            <span className="invite-avatar-game" title={gameLabel}>
              {jieqi ? <Icon name="hidden" size={22} /> : <GameIcon game={room.game} size={28} />}
            </span>
          </div>

          <div className="invite-heading">
            <h1 className="invite-title">
              <span className="invite-host">{room.host.username}</span> mời bạn chơi {gameLabel}
            </h1>
            {hostStats && (
              <div className="invite-host-meta">
                <TierBadge name={hostStats.tier} level={hostStats.tierLevel} />
                <span className="invite-dot" aria-hidden="true">
                  ·
                </span>
                <span className="num">{hostStats.rating} điểm hạng mùa này</span>
              </div>
            )}
          </div>

          <ul className="invite-facts">
            <li className="invite-fact">
              <span className="invite-fact-icon">
                {jieqi ? <Icon name="hidden" size={22} /> : <GameIcon game={room.game} size={24} />}
              </span>
              <span className="invite-fact-text">
                <span className="invite-fact-label">Trò chơi</span>
                <span className="invite-fact-value">{gameLabel}</span>
                {jieqi && (
                  <span className="invite-fact-note">
                    Cờ tướng úp quân ·{' '}
                    <Link to="/co-up" className="invite-fact-link">
                      Xem luật
                    </Link>
                  </span>
                )}
              </span>
            </li>
            <li className="invite-fact">
              <span className="invite-fact-icon">
                <Icon name="clock" size={22} />
              </span>
              <span className="invite-fact-text">
                <span className="invite-fact-label">Thời gian</span>
                <span className="invite-fact-value num">{time.main}</span>
                <span className="invite-fact-note">{time.note}</span>
              </span>
            </li>
          </ul>

          <div className="invite-rules" aria-label="Luật phòng">
            <span className="chip invite-chip">
              <ShuffleIcon size={15} />
              Bốc thăm bên cầm quân
            </span>
            <span className="chip invite-chip">
              <Icon name="star" size={14} />
              Không tính điểm hạng
            </span>
          </div>

          {(joinError || hostAway) && (
            <div className={`notice ${joinError ? 'danger' : 'warn'} invite-notice`} role={joinError ? 'alert' : 'status'}>
              <Icon name={hostAway ? 'wifi-off' : 'alert'} size={18} />
              <div className="grow">
                <div>
                  {joinError ??
                    `${room.host.username} đang mất kết nối hoặc đã đóng trang web. Khi họ quay lại, bạn bấm “Vào phòng và bắt đầu” là chơi được.`}
                </div>
                {hostAway && (
                  <button type="button" className="link-btn invite-recheck" onClick={() => void recheck()} disabled={checking || cooling}>
                    {checking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="invite-actions">
            <button className="btn btn-primary btn-lg btn-block invite-join" onClick={join} disabled={joining} aria-busy={joining || undefined}>
              {joining ? <span className="auth-spinner" aria-hidden="true" /> : <Icon name="play" size={19} />}
              {joining ? 'Đang vào phòng…' : 'Vào phòng và bắt đầu'}
            </button>
            <p className="invite-note">
              Ván đấu bắt đầu ngay khi bạn vào phòng.
              <br />
              Lời mời hết hạn lúc <span className="num">{expiresAt}</span>.
            </p>
            <Link to="/" className="btn btn-quiet btn-block">
              Để sau
            </Link>
          </div>
        </div>
      </article>
    </div>
  );
}
