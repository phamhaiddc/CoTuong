import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { createJieqiGame } from '@cotuong/game-core';
import {
  AI_LEVEL_LABEL,
  CUSTOM_TIME_LIMITS,
  GAME_LABEL,
  JIEQI_CASUAL_TIME_CONTROL,
  PRIVATE_ROOM_TTL_MS,
  validateCustomTimeControl,
  type AiLevel,
  type RoomDto,
} from '@cotuong/shared';
import { emit } from '../api/socket';
import { GameBoard } from '../components/Board';
import { Icon, type IconName } from '../components/icons';
import { Modal, ROOM_TTL_MINUTES, formatClock, normalizeRoomCode, roomGameLabel, timeControlText, useNow } from '../components/ui';
import { useAuth, useEnsurePlayer } from '../state/auth';
import { useRealtime } from '../state/realtime';
import { useToast } from '../state/toast';
import type { AiSetup } from './HomePage';

type Tab = 'people' | 'ai';

const CASUAL_MIN = JIEQI_CASUAL_TIME_CONTROL.initialMs / 60_000;
const CASUAL_INC = JIEQI_CASUAL_TIME_CONTROL.incrementMs / 1000;
/** Chờ ghép Cờ úp quá lâu (không có máy cho Cờ úp): gợi ý đấu với máy / mời bạn bè */
const SUGGEST_AFTER_MS = 30_000;

/** Luật cờ úp (đã đối chiếu 2 nguồn; xem README) */
const RULES: Array<{ icon: IconName; text: string }> = [
  { icon: 'hidden', text: 'Chỉ hai Tướng lộ mặt. 15 quân còn lại của mỗi bên được úp và xáo ngẫu nhiên trên các vị trí xuất phát.' },
  { icon: 'arrow-right', text: 'Quân úp đi nước đầu theo luật của quân vốn đứng ở ô đó (ô Xe đi như Xe, ô Pháo đi như Pháo…), đi xong thì lật lên.' },
  { icon: 'flip', text: 'Sau khi lật, quân đi theo loại thật. Sĩ và Tượng đã lật được đi khắp bàn: ra khỏi cung, qua sông.' },
  { icon: 'eye', text: 'Không ai biết quân úp là gì, kể cả chủ quân và máy. Quân úp bị ăn thì lộ mặt cho cả hai bên.' },
  { icon: 'trophy', text: 'Cờ úp không tính điểm hạng, không ảnh hưởng Top 10.' },
];

const LEVELS: Array<{ id: AiLevel; hint: string }> = [
  { id: 'easy', hint: 'Mới làm quen' },
  { id: 'medium', hint: 'Chơi thường xuyên' },
  { id: 'hard', hint: 'Chơi mạnh' },
];

function TimeFields({ minutes, inc, onChange }: { minutes: number; inc: number; onChange: (m: number, i: number) => void }) {
  return (
    <div className="cu-time">
      <label>
        <span>Phút mỗi bên</span>
        <input
          type="number"
          inputMode="numeric"
          min={CUSTOM_TIME_LIMITS.minMinutes}
          max={CUSTOM_TIME_LIMITS.maxMinutes}
          value={minutes}
          onChange={(e) => onChange(Math.round(Number(e.target.value)), inc)}
        />
      </label>
      <label>
        <span>Giây cộng mỗi nước</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={CUSTOM_TIME_LIMITS.maxIncrementSec}
          value={inc}
          onChange={(e) => onChange(minutes, Math.round(Number(e.target.value)))}
        />
      </label>
    </div>
  );
}

/** Thẻ phòng Cờ úp đang chờ bạn bè vào */
function JieqiRoomWaiting({ room }: { room: RoomDto }) {
  const { cancelRoom } = useRealtime();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const link = `${window.location.origin}/room/${room.code}`;
  const expiresAt = new Date(room.createdAt + PRIVATE_ROOM_TTL_MS).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done, 'success');
    } catch {
      toast('Không tự sao chép được. Bạn hãy bôi đen đường dẫn rồi sao chép bằng tay nhé.', 'warn');
    }
  };
  return (
    <div className="cu-wait">
      <p className="cu-wait-title" role="status">
        Đang chờ bạn bè vào phòng…
      </p>
      <p className="muted small cu-center">Gửi mã hoặc đường dẫn bên dưới cho bạn bè. Bạn bè vào phòng là ván bắt đầu ngay.</p>
      <div className="section-label">Mã phòng Cờ úp</div>
      <div className="cu-code-row">
        <div className="room-code cu-code">{room.code}</div>
        <button
          type="button"
          className="btn btn-quiet btn-icon"
          aria-label="Sao chép mã phòng"
          title="Sao chép mã phòng"
          onClick={() => void copy(room.code, 'Đã sao chép mã phòng')}
        >
          <Icon name="copy" size={18} />
        </button>
      </div>
      <div className="cu-chips">
        <span className="chip">
          <Icon name="clock" size={13} /> {timeControlText(room.timeControl)}
        </span>
        <span className="chip">Bốc thăm bên cầm quân</span>
        <span className="chip">Không tính điểm hạng</span>
      </div>
      <div className="cu-link">
        <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Đường dẫn mời" />
        <button type="button" className="btn btn-sm" aria-label="Sao chép đường dẫn mời" onClick={() => void copy(link, 'Đã sao chép đường dẫn mời')}>
          <Icon name="link" size={16} /> Sao chép
        </button>
      </div>
      <p className="muted small cu-note">
        <Icon name="info" size={14} />
        <span>
          Mã có hiệu lực {ROOM_TTL_MINUTES} phút (đến <span className="num">{expiresAt}</span>). Hãy giữ trang web này mở để vào ván
          ngay khi bạn bè tới.
        </span>
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-block"
        disabled={cancelling}
        onClick={async () => {
          setCancelling(true);
          await cancelRoom();
          setCancelling(false);
        }}
      >
        Huỷ phòng
      </button>
    </div>
  );
}

function PeoplePanel({ onPlayAi }: { onPlayAi: () => void }) {
  // Không cần tài khoản: chưa có danh tính thì bấm Tìm đối thủ / Tạo phòng / Vào phòng sẽ vào với tư cách khách
  const { player } = useAuth();
  const ensurePlayer = useEnsurePlayer();
  const { queue, joinQueue, leaveQueue, room, setRoom, cancelRoom } = useRealtime();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(CASUAL_MIN);
  const [inc, setInc] = useState(CASUAL_INC);
  const [code, setCode] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [focusCreate, setFocusCreate] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const searching = queue?.variant === 'jieqi';
  const now = useNow(searching);

  // "Mời bạn bè" từ gợi ý khi chờ lâu: đưa người chơi tới nút tạo phòng
  useEffect(() => {
    if (!focusCreate || searching) return;
    setFocusCreate(false);
    createRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    createRef.current?.focus({ preventScroll: true });
  }, [focusCreate, searching]);

  const otherQueue = !!queue && !searching;
  const jieqiRoom = room?.variant === 'jieqi' ? room : null;
  const otherRoom = room && !jieqiRoom ? room : null;
  const timeErr = validateCustomTimeControl(minutes, inc);

  // Đang tìm đối thủ thì chắc chắn không có ván dở (máy chủ không cho vào hàng chờ khi đang chơi): xét trước, để thông tin
  // ván dở đã cũ (ván kết thúc lúc đang ở trang khác) không che mất thẻ "Đang tìm đối thủ" và nút Huỷ
  if (searching) {
    const waited = now - queue!.since;
    return (
      <div className="cu-search">
        <span className="cu-spin" aria-hidden="true">
          <Icon name="hidden" size={30} />
        </span>
        <div className="cu-search-title" role="status">
          Đang tìm đối thủ Cờ úp…
        </div>
        <div className="cu-search-time num">
          <span className="sr-only">Đã chờ </span>
          {formatClock(waited)}
        </div>
        <p className="muted small cu-center">
          Ghép với người khác đang chờ, ai đến trước ghép trước · {CASUAL_MIN} phút + {CASUAL_INC} giây/nước. Tìm thấy là ván tự
          mở.
        </p>
        {waited >= SUGGEST_AFTER_MS && (
          <div className="notice info cu-suggest" role="status">
            <Icon name="users" size={18} />
            <div className="grow">
              <div>
                <b>Chưa có ai khác đang chờ chơi Cờ úp.</b> Bạn có thể chờ thêm, hoặc:
              </div>
              <div className="cu-suggest-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await leaveQueue();
                    onPlayAi();
                  }}
                >
                  <Icon name="bot" size={16} /> Đấu với máy
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await leaveQueue();
                    setFocusCreate(true);
                  }}
                >
                  <Icon name="link" size={16} /> Mời bạn bè
                </button>
              </div>
            </div>
          </div>
        )}
        <button type="button" className="btn btn-ghost btn-block" onClick={() => void leaveQueue()}>
          Huỷ tìm đối thủ
        </button>
      </div>
    );
  }

  if (player?.activeMatchId) {
    return (
      <div className="stack">
        <p className="notice info">
          <Icon name="play" size={18} />
          <span>Bạn đang có một ván chưa kết thúc. Hãy chơi xong ván đó trước khi bắt đầu ván mới.</span>
        </p>
        <Link className="btn btn-primary btn-lg btn-block" to={`/play/${player.activeMatchId}`}>
          <Icon name="play" size={20} /> Vào lại ván đang chơi
        </Link>
      </div>
    );
  }

  if (jieqiRoom) return <JieqiRoomWaiting room={jieqiRoom} />;

  const createRoom = async () => {
    setBusy(true);
    try {
      if (!(await ensurePlayer())) return;
      const r = await emit('room:create', { game: 'xiangqi', minutes, incrementSec: inc, variant: 'jieqi' });
      if (r.ok) setRoom(r.room);
      else toast(r.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {otherQueue && (
        <div className="notice info" role="status">
          <Icon name="search" size={18} />
          <div className="grow">
            <div>
              Bạn đang tìm đối thủ <b>{queue!.game ? GAME_LABEL[queue!.game] : ''}</b> (ván xếp hạng). Tìm đối thủ Cờ úp sẽ dừng lượt
              tìm đó.
            </div>
            <div className="cu-notice-actions">
              <button type="button" className="link-btn" onClick={() => void leaveQueue()}>
                Huỷ tìm đối thủ
              </button>
            </div>
          </div>
        </div>
      )}
      {otherRoom && (
        <div className="notice info" role="status">
          <Icon name="users" size={18} />
          <div className="grow">
            <div>
              Bạn đang có <b>phòng riêng {roomGameLabel(otherRoom)}</b> (mã <b className="num">{otherRoom.code}</b>) chờ bạn bè vào. Huỷ
              phòng đó nếu muốn chơi Cờ úp với người khác.
            </div>
            <div className="cu-notice-actions">
              <Link className="link-btn" to="/">
                Xem phòng
              </Link>
              <button type="button" className="link-btn" onClick={() => void cancelRoom()}>
                Huỷ phòng
              </button>
            </div>
          </div>
        </div>
      )}
      <section className="cu-block">
        <div className="cu-block-head">
          <Icon name="search" size={18} />
          <b>Tìm đối thủ</b>
          <span className="chip">
            {CASUAL_MIN} phút + {CASUAL_INC} giây/nước
          </span>
        </div>
        <p className="muted small">Ghép ngay với người khác đang chờ chơi Cờ úp. Không tính điểm hạng.</p>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={busy || !!otherRoom}
          onClick={async () => {
            setBusy(true);
            try {
              if (await ensurePlayer()) await joinQueue('xiangqi', 'jieqi');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="swords" size={20} /> Tìm đối thủ Cờ úp
        </button>
      </section>

      <div className="divider">hoặc chơi với bạn bè</div>

      <section className="cu-block">
        <div className="cu-block-head">
          <Icon name="users" size={18} />
          <b>Phòng riêng</b>
        </div>
        <p className="muted small">Tạo phòng rồi gửi mã hoặc đường dẫn mời cho bạn bè. Bên cầm quân được bốc thăm.</p>
        <TimeFields
          minutes={minutes}
          inc={inc}
          onChange={(m, i) => {
            setMinutes(m);
            setInc(i);
          }}
        />
        {timeErr && (
          <div className="error small" role="alert">
            {timeErr}
          </div>
        )}
        <button
          ref={createRef}
          type="button"
          className="btn btn-block"
          disabled={!!timeErr || busy || otherQueue}
          onClick={() => (otherRoom ? setConfirmReplace(true) : void createRoom())}
        >
          <Icon name="plus" size={18} /> Tạo phòng Cờ úp
        </button>
        {otherQueue && <p className="muted tiny cu-center">Huỷ tìm đối thủ trước khi tạo phòng.</p>}
        <p className="muted small cu-join-label">Bạn bè đã gửi mã phòng cho bạn? Nhập vào đây:</p>
        <form
          className="cu-join"
          aria-label="Vào phòng bằng mã"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!/^[A-Z0-9]{6}$/.test(code)) {
              toast('Mã phòng gồm đúng 6 chữ hoặc số', 'warn');
              return;
            }
            setBusy(true);
            const ok = await ensurePlayer();
            setBusy(false);
            if (ok) navigate(`/room/${code}`);
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
            placeholder="VD: K7P2QX"
            aria-label="Mã phòng (6 ký tự)"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="btn" type="submit" disabled={busy}>
            Vào phòng
          </button>
        </form>
      </section>

      <Modal
        open={confirmReplace && !!otherRoom}
        title="Huỷ phòng đang chờ?"
        icon="alert"
        tone="warn"
        onClose={() => setConfirmReplace(false)}
        actions={
          <>
            <button type="button" className="btn btn-ghost" data-autofocus onClick={() => setConfirmReplace(false)}>
              Giữ phòng cũ
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setConfirmReplace(false);
                await cancelRoom();
                await createRoom();
              }}
            >
              Huỷ phòng cũ, tạo phòng Cờ úp
            </button>
          </>
        }
      >
        <p>
          Bạn đang có phòng riêng {otherRoom ? roomGameLabel(otherRoom) : ''} (mã <b>{otherRoom?.code}</b>) chờ bạn bè vào. Mỗi lúc chỉ
          có một phòng chờ — tạo phòng Cờ úp sẽ huỷ phòng đó, mã và đường dẫn mời cũ sẽ không dùng được nữa.
        </p>
      </Modal>
    </div>
  );
}

function AiPanel() {
  // Chỉ tài khoản thành viên mới lưu ván với máy vào lịch sử
  const { me } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [level, setLevel] = useState<AiLevel>('medium');
  const [side, setSide] = useState<0 | 1 | 'random'>(0);
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [inc, setInc] = useState(5);
  const err = timed ? validateCustomTimeControl(minutes, inc) : null;
  return (
    <div className="stack">
      <p className="muted small">
        {me ? (
          'Ván với máy không tính điểm hạng. Kết quả vẫn được lưu vào lịch sử ván đấu của bạn.'
        ) : (
          <>
            Ván với máy không tính điểm hạng.{' '}
            <Link to="/login" state={{ from: location.pathname }}>
              Đăng nhập
            </Link>{' '}
            để lưu ván vào lịch sử.
          </>
        )}
      </p>
      <fieldset className="cu-choices">
        <legend className="section-label">Mức độ</legend>
        <div className="cu-grid3">
          {LEVELS.map((l) => (
            <label key={l.id} className={`choice cu-choice${level === l.id ? ' active' : ''}`}>
              <input type="radio" name="cu-level" checked={level === l.id} onChange={() => setLevel(l.id)} />
              <b>{AI_LEVEL_LABEL[l.id]}</b>
              <span className="muted tiny">{l.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="cu-choices">
        <legend className="section-label">Bạn cầm quân</legend>
        <div className="cu-grid3">
          {([0, 1, 'random'] as const).map((s) => (
            <label key={String(s)} className={`choice cu-choice${side === s ? ' active' : ''}`}>
              <input type="radio" name="cu-side" checked={side === s} onChange={() => setSide(s)} />
              <b>{s === 'random' ? 'Ngẫu nhiên' : s === 0 ? 'Đỏ' : 'Đen'}</b>
              <span className="muted tiny">{s === 'random' ? 'Bốc thăm' : s === 0 ? 'Đi trước' : 'Đi sau'}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check cu-check">
        <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Giới hạn thời gian
      </label>
      {timed ? (
        <TimeFields
          minutes={minutes}
          inc={inc}
          onChange={(m, i) => {
            setMinutes(m);
            setInc(i);
          }}
        />
      ) : (
        <p className="muted tiny cu-hint">Đang tắt — không tính giờ, bạn suy nghĩ bao lâu cũng được.</p>
      )}
      {err && (
        <div className="error small" role="alert">
          {err}
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={!!err}
        onClick={() => {
          const setup: AiSetup = {
            game: 'xiangqi',
            level,
            side,
            timeControl: timed ? { initialMs: minutes * 60_000, incrementMs: inc * 1000 } : null,
            variant: 'jieqi',
          };
          navigate('/ai', { state: setup });
        }}
      >
        <Icon name="play" size={20} /> Bắt đầu ván với máy
      </button>
      <p className="muted tiny cu-center">Máy chỉ biết những gì bạn thấy trên bàn — nó cũng không biết quân úp là gì.</p>
    </div>
  );
}

/** Sảnh Cờ úp: luật chơi, đấu với người (tìm đối thủ / phòng riêng), đấu với máy */
export function CoUpPage() {
  // Ai cũng chơi được (không cần tài khoản); chỉ chờ biết đã đăng nhập hay chưa để khỏi nhấp nháy
  const { loading } = useAuth();
  const [tab, setTab] = useState<Tab>('people');
  const preview = useMemo(() => createJieqiGame(), []);

  return (
    <div className="cu">
      <div className="cu-main">
        <section className="panel cu-lobby">
          <header className="cu-head">
            <span className="cu-emblem" aria-hidden="true">
              <Icon name="hidden" size={22} />
            </span>
            <div>
              <h1 className="cu-title">Cờ úp</h1>
              <p className="muted small">Cờ tướng úp quân · không tính điểm</p>
            </div>
          </header>
          {loading ? null : (
            <>
              <div className="seg seg-block cu-tabs" role="tablist" aria-label="Chế độ cờ úp">
                <button
                  type="button"
                  role="tab"
                  id="cu-tab-people"
                  aria-controls="cu-panel"
                  aria-selected={tab === 'people'}
                  className={tab === 'people' ? 'active' : ''}
                  onClick={() => setTab('people')}
                >
                  <Icon name="users" size={16} /> Đấu với người
                </button>
                <button
                  type="button"
                  role="tab"
                  id="cu-tab-ai"
                  aria-controls="cu-panel"
                  aria-selected={tab === 'ai'}
                  className={tab === 'ai' ? 'active' : ''}
                  onClick={() => setTab('ai')}
                >
                  <Icon name="bot" size={16} /> Đấu với máy
                </button>
              </div>
              <div className="cu-body" role="tabpanel" id="cu-panel" aria-labelledby={`cu-tab-${tab}`}>
                {tab === 'people' ? <PeoplePanel onPlayAi={() => setTab('ai')} /> : <AiPanel />}
              </div>
            </>
          )}
        </section>

        <section className="panel cu-rules" aria-labelledby="cu-rules-title">
          <h2 id="cu-rules-title" className="panel-title">
            Luật cờ úp
          </h2>
          <ul className="cu-rule-list">
            {RULES.map((r) => (
              <li key={r.text}>
                <span className="cu-rule-ico" aria-hidden="true">
                  <Icon name={r.icon} size={16} />
                </span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <figure className="cu-board">
        <GameBoard engine={preview} version={0} orientation={0} movable={null} />
        <figcaption className="muted small">Thế bắt đầu: chỉ hai Tướng lộ mặt</figcaption>
      </figure>
    </div>
  );
}
