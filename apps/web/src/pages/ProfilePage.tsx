import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import type { GameType } from '@cotuong/game-core';
import {
  AI_LEVEL_LABEL,
  AVATAR_LIMITS,
  COLOR_LABEL,
  END_REASON_LABEL,
  GAME_LABEL,
  LEADERBOARD_MIN_GAMES,
  OUTCOME_LABEL,
  START_RATING,
  getTier,
  type MatchSummaryDto,
  type Paginated,
  type PastSeasonDto,
  type ProfileDto,
  type ProfileGameDto,
  type SeasonStats,
  type TierDef,
  RATING_FLOOR,
  type OAuthLinksDto,
  type OAuthProvider,
} from '@cotuong/shared';
import { ApiError, api, errorMessage, messageFor } from '../api/http';
import { Icon, type IconName } from '../components/icons';
import { RATING_RULES_PATH } from '../components/Layout';
import { Meter, daysLeftText, seasonRange, useTiers } from '../components/Sidebar';
import { Avatar, EmptyState, GameTabs, RankMedal, TierBadge, signed, tierColor } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useToast } from '../state/toast';

/** Liên kết tới phần giải thích cách tính điểm (trang Mùa giải) */
function RulesLink({ className = '' }: { className?: string }) {
  return (
    <Link to={RATING_RULES_PATH} className={`pf-rules-link${className ? ` ${className}` : ''}`}>
      <Icon name="info" size={14} />
      Cách tính điểm
    </Link>
  );
}

/** Tiến độ lên cấp kế tiếp (tiers xếp từ cao xuống thấp) */
function tierProgress(rating: number, tiers: TierDef[]) {
  const i = tiers.length - 1 - getTier(rating, tiers).level;
  if (i <= 0) return null;
  const next = tiers[i - 1];
  // Cấp thấp nhất không có mốc dưới: bắt đầu từ sàn điểm (0)
  const lo = Number.isFinite(tiers[i].min) ? tiers[i].min : RATING_FLOOR;
  const pct = Math.max(0, Math.min(100, ((rating - lo) / (next.min - lo)) * 100));
  return { name: next.name, level: tiers.length - i, min: next.min, need: next.min - rating, pct };
}

/* ------------------------------------------------------------------ Định dạng */
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const a = new Date(d);
  a.setHours(0, 0, 0, 0);
  const b = new Date();
  b.setHours(0, 0, 0, 0);
  const diff = Math.round((+b - +a) / 86_400_000);
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  return DATE_FMT.format(d);
}

const timeLabel = (iso: string) => TIME_FMT.format(new Date(iso));

function modeInfo(m: MatchSummaryDto): { label: string; icon: IconName } {
  const jieqi = m.variant === 'jieqi';
  if (m.mode === 'ai') {
    const level = m.aiLevel ? ` (${AI_LEVEL_LABEL[m.aiLevel]})` : '';
    return { label: `${jieqi ? 'Cờ úp với máy' : 'Đấu với máy'}${level}`, icon: 'bot' };
  }
  if (jieqi) return { label: 'Cờ úp', icon: 'hidden' };
  return m.ranked ? { label: 'Ván xếp hạng', icon: 'trophy' } : { label: 'Phòng riêng', icon: 'users' };
}

function outcomeLabel(o: MatchSummaryDto['outcome']): string {
  if (o === 'aborted') return 'Ván bị huỷ';
  return o ? OUTCOME_LABEL[o] : '—';
}

function reasonLabel(r: string | null): string | null {
  if (!r) return null;
  return END_REASON_LABEL[r as keyof typeof END_REASON_LABEL] ?? r;
}

function sideKey(m: MatchSummaryDto): 'red' | 'black' | 'white' {
  if (m.color === 1) return 'black';
  return m.game === 'xiangqi' ? 'red' : 'white';
}

function winRate(w: number, l: number, d: number): number | null {
  const t = w + l + d;
  return t > 0 ? Math.round((w / t) * 100) : null;
}

/* ------------------------------------------------------------------ Thành phần nhỏ */
function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="pf-delta muted">—</span>;
  const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'zero';
  return <span className={`pf-delta ${cls}`}>{signed(value)}</span>;
}

function OutcomeChip({ outcome }: { outcome: MatchSummaryDto['outcome'] }) {
  return <span className={`pf-outcome outcome-${outcome ?? 'none'}`}>{outcomeLabel(outcome)}</span>;
}

function Side({ m }: { m: MatchSummaryDto }) {
  return (
    <span className="pf-side">
      <span className={`pf-side-dot side-${sideKey(m)}`} aria-hidden="true" />
      {COLOR_LABEL[m.game][m.color]}
    </span>
  );
}

function Opponent({ m }: { m: MatchSummaryDto }) {
  if (!m.opponent) {
    // Ván với người mà không còn thông tin đối thủ: tài khoản đó đã bị xoá (tài khoản khách được dọn tự động)
    if (m.mode === 'pvp') {
      return (
        <span className="pf-opp pf-opp-gone" title="Tài khoản của người chơi này không còn nữa">
          <span className="pf-bot" aria-hidden="true">
            <Icon name="user" size={15} />
          </span>
          <span className="pf-opp-name">Người chơi đã rời</span>
        </span>
      );
    }
    return (
      <span className="pf-opp">
        <span className="pf-bot" aria-hidden="true">
          <Icon name="bot" size={15} />
        </span>
        <span className="pf-opp-name">Máy</span>
      </span>
    );
  }
  // Khách không có trang hồ sơ: chỉ hiện tên
  if (m.opponent.isGuest) {
    return (
      <span className="pf-opp" title="Người chơi khách (không có hồ sơ)">
        <Avatar name={m.opponent.username} url={m.opponent.avatarUrl} size={26} />
        <span className="pf-opp-name">{m.opponent.username}</span>
      </span>
    );
  }
  return (
    <Link to={`/profile/${m.opponent.id}`} className="pf-opp">
      <Avatar name={m.opponent.username} url={m.opponent.avatarUrl} size={26} />
      <span className="pf-opp-name">{m.opponent.username}</span>
    </Link>
  );
}

/** Thanh tỉ lệ Thắng / Thua / Hoà */
function WldBar({ w, l, d }: { w: number; l: number; d: number }) {
  const t = w + l + d;
  return (
    <span className={`pf-wld-bar${t ? '' : ' empty'}`} aria-hidden="true">
      {w > 0 && <span className="win" style={{ flexGrow: w }} />}
      {l > 0 && <span className="loss" style={{ flexGrow: l }} />}
      {d > 0 && <span className="draw" style={{ flexGrow: d }} />}
    </span>
  );
}

/** Huy chương mùa giải (Top 1–3: vàng/bạc/đồng; Top 4–10: huy hiệu vàng nhạt) */
function MedalEmblem({ rank }: { rank: number }) {
  const tone = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'top';
  const gid = `pfMedal${useId().replace(/:/g, '')}`;
  return (
    <svg className={`pf-medal pf-medal-${tone}`} viewBox="0 0 48 60" width="48" height="60" aria-hidden="true">
      <defs>
        <radialGradient id={gid} cx="36%" cy="30%" r="75%">
          <stop offset="0" className="s1" />
          <stop offset="0.6" className="s2" />
          <stop offset="1" className="s3" />
        </radialGradient>
      </defs>
      <path className="pf-medal-ribbon a" d="M9 1h11.5l9 21H18Z" />
      <path className="pf-medal-ribbon b" d="M39 1H27.5l-9 21H30Z" />
      <circle className="pf-medal-disc" cx="24" cy="38" r="19" fill={`url(#${gid})`} />
      <circle className="pf-medal-ring" cx="24" cy="38" r="14.5" />
      <text className="pf-medal-num" x="24" y="38" textAnchor="middle" dominantBaseline="central">
        {rank}
      </text>
    </svg>
  );
}

/** Khiên cấp bậc cỡ lớn (cùng hình với TierBadge) */
function TierEmblem({ level, size = 40, className = '' }: { level: number; size?: number; className?: string }) {
  const color = tierColor(level);
  const stars = Math.max(1, Math.min(3, (level % 3) + 1));
  return (
    <svg
      className={`pf-tier-emblem${className ? ` ${className}` : ''}`}
      viewBox="0 0 20 22"
      width={size}
      height={Math.round(size * 1.1)}
      aria-hidden="true"
    >
      <path d="M10 1 L18 4.5 V11 C18 16 14.5 19.5 10 21 C5.5 19.5 2 16 2 11 V4.5 Z" fill={color} />
      <path d="M10 2.6 L16.6 5.5 V11 C16.6 15.1 13.8 18 10 19.4" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="0.8" />
      {level >= 6 ? (
        <path d="M5 9 L7.5 12 L10 7 L12.5 12 L15 9 L14 15 H6 Z" fill="#fff" />
      ) : (
        Array.from({ length: stars }, (_, i) => <circle key={i} cx={10 + (i - (stars - 1) / 2) * 4.2} cy={11.5} r={1.6} fill="#fff" />)
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ Đầu trang hồ sơ */
function bestBadge(profile: ProfileDto): { text: string; game: GameType; rank: number } | null {
  let best: { text: string; game: GameType; rank: number } | null = null;
  for (const g of profile.games) {
    for (const s of g.pastSeasons) {
      if (!s.topBadge) continue;
      const rank = topRankOf(s) ?? 99;
      if (!best || rank < best.rank) best = { text: s.topBadge, game: g.game, rank };
    }
  }
  return best;
}

function topRankOf(s: PastSeasonDto): number | null {
  if (!s.topBadge) return null;
  const m = /Top\s+(\d+)/i.exec(s.topBadge);
  return m ? Number(m[1]) : s.finalRank;
}

/* ------------------------------------------------------------------ Đăng nhập nhanh bằng Google / Facebook */
const PROVIDER_NAME: Record<OAuthProvider, string> = { google: 'Google', facebook: 'Facebook' };

/** Kết quả liên kết trả về qua ?oauthLinked= / ?oauthError= */
const LINK_ERRORS: Record<string, string> = {
  link_taken: 'Tài khoản này đã được dùng để đăng nhập một tài khoản Xe Pháo Mã khác.',
  already_linked: 'Bạn đã liên kết một tài khoản khác của dịch vụ này. Hãy huỷ liên kết cũ trước.',
  denied: 'Bạn đã huỷ hoặc chưa cho phép liên kết.',
  state: 'Lượt liên kết đã hết hạn. Bạn bấm "Liên kết" lại nhé.',
  rate: 'Bạn thử quá nhiều lần, hãy đợi vài phút rồi thử lại.',
  disabled: 'Hình thức này hiện chưa được bật.',
  exchange: 'Chưa liên kết được, bạn thử lại sau ít phút nhé.',
};

/**
 * Liên kết / huỷ liên kết Google, Facebook với tài khoản đang đăng nhập — để lần sau đăng nhập bằng một chạm.
 * Chỉ hiện các dịch vụ server đã cấu hình.
 */
function SocialLinks({ userId }: { userId: string }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<OAuthLinksDto | null>(null);
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  const load = useCallback(() => {
    api
      .get<OAuthLinksDto>('/api/auth/oauth/links')
      .then(setData)
      .catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  // Vừa quay về từ trang Google / Facebook
  useEffect(() => {
    const linked = params.get('oauthLinked');
    const err = params.get('oauthError');
    if (!linked && !err) return;
    if (linked === 'google' || linked === 'facebook') {
      toast(`Đã liên kết ${PROVIDER_NAME[linked]}. Lần sau bạn có thể đăng nhập bằng ${PROVIDER_NAME[linked]}.`, 'success');
    } else if (err) {
      toast(messageFor(LINK_ERRORS, err, LINK_ERRORS.exchange), 'error');
    }
    const next = new URLSearchParams(params);
    next.delete('oauthLinked');
    next.delete('oauthError');
    setParams(next, { replace: true });
  }, [params, setParams, toast]);

  if (!data) return null;
  const providers = (['google', 'facebook'] as const).filter((p) => data.enabled[p]);
  if (!providers.length) return null;

  const unlink = async (p: OAuthProvider) => {
    setBusy(p);
    try {
      await api.del(`/api/auth/oauth/${p}/link`);
      toast(`Đã huỷ liên kết ${PROVIDER_NAME[p]}.`, 'success');
      load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const from = encodeURIComponent(`/profile/${userId}`);
  return (
    <div className="pf-social" aria-label="Đăng nhập nhanh">
      <p className="pf-social-title">Đăng nhập nhanh</p>
      <ul className="pf-social-list">
        {providers.map((p) => (
          <li key={p} className="pf-social-item">
            <span className={`pf-social-mark ${p}`} aria-hidden="true">
              {p === 'google' ? 'G' : 'f'}
            </span>
            <span className="pf-social-name">{PROVIDER_NAME[p]}</span>
            {data.linked[p] ? (
              <>
                <span className="pf-social-state">Đã liên kết</span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p} onClick={() => void unlink(p)}>
                  {busy === p ? 'Đang huỷ…' : 'Huỷ liên kết'}
                </button>
              </>
            ) : (
              <a className="btn btn-sm" href={`/api/auth/oauth/${p}/start?mode=link&from=${from}`}>
                Liên kết {PROVIDER_NAME[p]}
              </a>
            )}
          </li>
        ))}
      </ul>
      <p className="pf-social-note">Liên kết rồi, lần sau bạn bấm “Đăng nhập với {providers.map((p) => PROVIDER_NAME[p]).join(' / ')}” là vào được, không cần mật khẩu.</p>
    </div>
  );
}

function Hero({
  profile,
  isMe,
  game,
  onGame,
  uploading,
  onPickAvatar,
}: {
  profile: ProfileDto;
  isMe: boolean;
  game: GameType;
  onGame: (g: GameType) => void;
  uploading: boolean;
  onPickAvatar: () => void;
}) {
  const u = profile.user;
  const best = bestBadge(profile);
  return (
    <section className={`panel pf-hero game-${game}`}>
      <div className="pf-cover" aria-hidden="true" />
      <div className="pf-hero-body">
        <div className="pf-avatar-wrap">
          {isMe ? (
            <button
              type="button"
              className={`pf-avatar-btn${uploading ? ' is-busy' : ''}`}
              onClick={onPickAvatar}
              disabled={uploading}
              aria-label="Đổi ảnh đại diện"
              title="Đổi ảnh đại diện"
            >
              <Avatar name={u.username} url={u.avatarUrl} size={104} />
              <span className="pf-avatar-overlay" aria-hidden="true">
                {uploading ? <span className="spinner" /> : <Icon name="camera" size={26} />}
                <span>{uploading ? 'Đang tải…' : 'Đổi ảnh'}</span>
              </span>
              <span className="pf-avatar-cam" aria-hidden="true">
                <Icon name="camera" size={17} />
              </span>
            </button>
          ) : (
            <Avatar name={u.username} url={u.avatarUrl} size={104} />
          )}
        </div>

        <div className="pf-ident">
          <h1 className="profile-name">
            <span className="pf-name-text">{u.username}</span>
            {u.role === 'admin' && (
              <span className="role-tag">
                <Icon name="shield" size={12} strokeWidth={2.4} />
                Quản trị viên
              </span>
            )}
          </h1>
          <div className="pf-meta">
            <span className="pf-meta-item">
              <Icon name="calendar" size={15} />
              Tham gia {DATE_FMT.format(new Date(u.createdAt))}
            </span>
            {best && (
              <span className="chip chip-gold pf-best" title="Thành tích cao nhất">
                <Icon name="crown" size={13} strokeWidth={2.4} />
                {best.text} · {GAME_LABEL[best.game]}
              </span>
            )}
          </div>
          {isMe && (
            <p className="pf-hint">
              <Icon name="camera" size={14} />
              Bấm vào ảnh để đổi ảnh đại diện (ảnh JPG, PNG hoặc WebP, tối đa 2 MB; ảnh sẽ được cắt thành hình vuông).
            </p>
          )}
          {isMe && <SocialLinks userId={u.id} />}
        </div>

        <GameTabs value={game} onChange={onGame} withIcons className="pf-tabs" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Mùa hiện tại */
/** Thang cấp bậc: mỗi cấp một đoạn (màu theo cấp), đoạn hiện tại tô theo tiến độ lên cấp kế */
function TierLadder({ rating, tiers }: { rating: number; tiers: TierDef[] }) {
  const n = tiers.length;
  const cur = getTier(rating, tiers).level;
  const next = tierProgress(rating, tiers);
  return (
    <div className="pf-ladder" aria-hidden="true">
      {Array.from({ length: n }, (_, level) => {
        const t = tiers[n - 1 - level];
        const fill = level < cur ? 100 : level > cur ? 0 : next ? next.pct : 100;
        return (
          <span
            key={t.name}
            className={`pf-ladder-seg${level === cur ? ' cur' : ''}${level < cur ? ' done' : ''}`}
            style={{ '--c': tierColor(level) } as CSSProperties}
            title={Number.isFinite(t.min) ? `${t.name}: từ ${t.min} điểm` : t.name}
          >
            <span className="pf-ladder-fill" style={{ width: `${fill}%` }} />
          </span>
        );
      })}
    </div>
  );
}

function StatsGrid({ cur, tiers, seasonLabel }: { cur: SeasonStats; tiers: TierDef[]; seasonLabel: string }) {
  const next = tierProgress(cur.rating, tiers);
  const wr = winRate(cur.wins, cur.losses, cur.draws);
  const done = Math.min(cur.gamesPlayed, LEADERBOARD_MIN_GAMES);
  return (
    <div className="pf-stats">
      <div className="pf-tile pf-rating" style={{ '--tier': tierColor(cur.tierLevel) } as CSSProperties}>
        <TierEmblem level={cur.tierLevel} size={64} className="pf-rating-emblem" />
        <div className="pf-tile-label">Điểm hạng</div>
        <div className="pf-rating-row">
          <span className="pf-rating-value">{cur.rating}</span>
          <span className="pf-tier-pill">
            <TierBadge name={cur.tier} level={cur.tierLevel} />
          </span>
        </div>
        <div className="pf-next">
          {next ? (
            <div className="pf-next-row">
              <span>
                Còn <b>{next.need}</b> điểm để lên{' '}
                <b className="pf-tier-text" style={{ '--tier-c': tierColor(next.level) } as CSSProperties}>
                  {next.name}
                </b>
              </span>
              <span className="pf-next-num">
                {cur.rating}/{next.min}
              </span>
            </div>
          ) : (
            <div className="pf-next-row pf-next-top">
              <span>
                <Icon name="crown" size={16} /> Đã đạt cấp bậc cao nhất
              </span>
            </div>
          )}
          <TierLadder rating={cur.rating} tiers={tiers} />
          {next && <span className="sr-only">{`Tiến độ lên ${next.name}: ${Math.round(next.pct)}%`}</span>}
          <RulesLink />
        </div>
      </div>

      <div className="pf-tile pf-rank">
        <div className="pf-tile-label">Thứ hạng</div>
        {cur.rank ? (
          <>
            <div className="pf-tile-value">
              {cur.rank <= 3 && <RankMedal rank={cur.rank} />}#{cur.rank}
            </div>
            <div className="pf-tile-sub">
              {cur.rank <= 10 ? (
                <span className="chip chip-gold">
                  <Icon name="trophy" size={12} /> Top 10 {seasonLabel}
                </span>
              ) : (
                'Vào Top 10 khi hết mùa để nhận huy hiệu mùa'
              )}
            </div>
          </>
        ) : (
          <>
            <div className="pf-unranked">
              Chưa có hạng{' '}
              <span className="pf-unranked-count">
                ({done}/{LEADERBOARD_MIN_GAMES} ván)
              </span>
            </div>
            <Meter value={(done / LEADERBOARD_MIN_GAMES) * 100} label={`Đã chơi ${done}/${LEADERBOARD_MIN_GAMES} ván xếp hạng`} />
            <div className="pf-tile-sub">Chơi đủ {LEADERBOARD_MIN_GAMES} ván xếp hạng trong quý để có thứ hạng</div>
          </>
        )}
      </div>

      <div className="pf-tile pf-peak">
        <div className="pf-tile-label">Điểm cao nhất mùa này</div>
        <div className="pf-tile-value">{cur.peakRating}</div>
        <div className="pf-tile-sub">
          {cur.peakRating > cur.rating ? `Cao hơn điểm hiện tại ${cur.peakRating - cur.rating} điểm` : 'Đang ở mức cao nhất'}
        </div>
      </div>

      <div className="pf-tile pf-record">
        <div className="pf-tile-label">Thắng / Thua / Hoà</div>
        <div className="pf-wld">
          <span className="pf-wld-item win">
            <b>{cur.wins}</b> thắng
          </span>
          <span className="pf-wld-item loss">
            <b>{cur.losses}</b> thua
          </span>
          <span className="pf-wld-item draw">
            <b>{cur.draws}</b> hoà
          </span>
        </div>
        <WldBar w={cur.wins} l={cur.losses} d={cur.draws} />
        <div className="pf-tile-sub">
          {wr === null ? 'Chưa có kết quả' : (
            <>
              Tỉ lệ thắng <b>{wr}%</b>
            </>
          )}{' '}
          · {cur.gamesPlayed} ván xếp hạng
        </div>
      </div>
    </div>
  );
}

function AllTime({ t }: { t: ProfileGameDto['allTime'] }) {
  const wr = winRate(t.wins, t.losses, t.draws);
  return (
    <div className="pf-alltime">
      <div className="pf-alltime-head">
        <span className="pf-kicker">Ván xếp hạng · tổng mọi mùa</span>
        {wr !== null && (
          <span className="pf-alltime-rate">
            Tỉ lệ thắng <b>{wr}%</b>
          </span>
        )}
      </div>
      <dl className="pf-totals">
        <div>
          <dt>Ván xếp hạng</dt>
          <dd>{t.gamesPlayed}</dd>
        </div>
        <div className="win">
          <dt>Thắng</dt>
          <dd>{t.wins}</dd>
        </div>
        <div className="loss">
          <dt>Thua</dt>
          <dd>{t.losses}</dd>
        </div>
        <div className="draw">
          <dt>Hoà</dt>
          <dd>{t.draws}</dd>
        </div>
      </dl>
    </div>
  );
}

function SeasonPanel({ g, isMe, tiers }: { g: ProfileGameDto; isMe: boolean; tiers: TierDef[] }) {
  const s = g.season;
  const label = `Quý ${s.quarter}/${s.year}`;
  const start = getTier(START_RATING, tiers);
  const urgent = s.status === 'active' && s.daysLeft <= 7;
  return (
    <section className="panel pf-season" aria-labelledby="pf-season-title">
      <div className="pf-sec-head">
        <div className="pf-sec-heading">
          <span className="pf-kicker">Mùa hiện tại · {GAME_LABEL[g.game]}</span>
          <h2 id="pf-season-title" className="pf-sec-title">
            {label}
          </h2>
        </div>
        <span className={`chip pf-days${urgent ? ' chip-primary' : ''}`} title={seasonRange(s)}>
          <Icon name="clock" size={13} />
          {daysLeftText(s)}
        </span>
      </div>

      {g.current ? (
        <StatsGrid cur={g.current} tiers={tiers} seasonLabel={label} />
      ) : (
        <div className="pf-noseason">
          <span className="pf-noseason-icon" aria-hidden="true">
            <Icon name="target" size={26} />
          </span>
          <div className="pf-noseason-text">
            <div className="pf-noseason-title">
              {isMe ? 'Bạn chưa chơi ván xếp hạng nào trong quý này' : 'Chưa chơi ván xếp hạng nào trong quý này'}
            </div>
            <div className="pf-noseason-sub">
              Mùa này {isMe ? 'bạn ' : ''}bắt đầu từ <b>{START_RATING} điểm</b> (<TierBadge name={start.name} level={start.level} />). Chơi đủ{' '}
              {LEADERBOARD_MIN_GAMES} ván xếp hạng để có tên trên bảng xếp hạng. <RulesLink className="pf-rules-inline" />
            </div>
          </div>
          {isMe && (
            <Link to="/" className="btn btn-primary pf-noseason-cta">
              <Icon name="swords" size={18} />
              Chơi ván xếp hạng
            </Link>
          )}
        </div>
      )}

      {/* Chưa từng chơi ván xếp hạng: khối "Tổng các mùa" chỉ lặp lại thông báo phía trên nên ẩn đi */}
      {g.allTime.gamesPlayed > 0 && <AllTime t={g.allTime} />}
    </section>
  );
}

/* ------------------------------------------------------------------ Các quý trước & huy hiệu */
function SeasonBadge({ s }: { s: PastSeasonDto }) {
  const top = topRankOf(s);
  const label = `Quý ${s.season.quarter}/${s.season.year}`;
  const tone = top ? (top <= 3 ? ` top-${top}` : ' top-n') : '';
  return (
    <article className={`season-card${top ? ' is-top' : ''}${tone}`}>
      <div className="pf-emblem">{top ? <MedalEmblem rank={top} /> : <TierEmblem level={s.peakTierLevel} />}</div>
      <div className="pf-badge-body">
        {top ? (
          <>
            <div className="pf-badge-kicker">Huy hiệu mùa</div>
            <h3 className="pf-badge-title">{s.topBadge}</h3>
          </>
        ) : (
          <>
            <div className="pf-badge-kicker">{seasonRange(s.season)}</div>
            <h3 className="pf-badge-title">{label}</h3>
          </>
        )}
        <div className="pf-badge-tier">
          <span className="pf-badge-tier-label">Cấp bậc cao nhất</span>
          <TierBadge name={s.peakTier} level={s.peakTierLevel} />
          <span className="pf-badge-peak">{s.peakRating}</span>
        </div>
        <div className="pf-badge-line">
          Cuối mùa: <b>{s.finalRank ? `hạng ${s.finalRank}` : 'không có thứ hạng'}</b> · <b>{s.rating}</b> điểm
        </div>
        <div className="pf-badge-line pf-badge-wld">
          <span className="win">{s.wins} thắng</span> · <span className="loss">{s.losses} thua</span> ·{' '}
          <span className="draw">{s.draws} hoà</span>
        </div>
      </div>
    </article>
  );
}

function PastSeasons({ list, isMe }: { list: PastSeasonDto[]; isMe: boolean }) {
  const badges = list.filter((s) => s.topBadge).length;
  const sorted = [...list].sort((a, b) => b.season.year - a.season.year || b.season.quarter - a.season.quarter);
  return (
    <section className="panel pf-past" aria-labelledby="pf-past-title">
      <div className="pf-sec-head">
        <div className="pf-sec-heading">
          <span className="pf-kicker">Thành tích</span>
          <h2 id="pf-past-title" className="pf-sec-title">
            Các quý trước &amp; huy hiệu
          </h2>
        </div>
        {list.length > 0 && (
          <span className={`chip${badges ? ' chip-gold' : ''}`}>
            {badges ? (
              <>
                <Icon name="star" size={12} strokeWidth={2.4} /> {badges} huy hiệu Top 10
              </>
            ) : (
              `${list.length} mùa`
            )}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <EmptyState icon="star">
          <div className="pf-empty-title">{isMe ? 'Bạn chưa có mùa giải nào đã kết thúc' : 'Chưa có mùa giải nào đã kết thúc'}</div>
          <div className="small">Huy hiệu Top 10 và cấp bậc cao nhất của mỗi quý sẽ hiển thị tại đây.</div>
        </EmptyState>
      ) : (
        <div className="pf-badges">
          {sorted.map((s) => (
            <SeasonBadge key={s.season.id} s={s} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Lịch sử ván đấu */
function pageWindow(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: Array<number | 'gap'> = [1];
  const lo = Math.max(2, Math.min(page - 1, pages - 4));
  const hi = Math.min(pages - 1, Math.max(page + 1, 5));
  if (lo > 2) out.push('gap');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pages - 1) out.push('gap');
  out.push(pages);
  return out;
}

function Pager({
  page,
  pages,
  total,
  pageSize,
  busy,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  busy: boolean;
  onPage: (p: number) => void;
}) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager pf-pager" aria-label="Phân trang lịch sử ván đấu">
      <span className="pf-pager-info">
        Ván {from}–{to} / {total}
      </span>
      <div className="pf-pager-ctrl">
        <button
          type="button"
          className="btn btn-ghost btn-sm pf-pager-btn"
          disabled={page <= 1 || busy}
          onClick={() => onPage(page - 1)}
          aria-label="Trang trước"
        >
          <Icon name="chevron-left" size={16} />
          <span className="pf-pager-txt">Trước</span>
        </button>
        <span className="pf-pages">
          {pageWindow(page, pages).map((n, i) =>
            n === 'gap' ? (
              <span key={`gap${i}`} className="pf-page-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                className={`pf-page${n === page ? ' active' : ''}`}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Trang ${n}`}
                disabled={busy && n !== page}
                onClick={() => n !== page && onPage(n)}
              >
                {n}
              </button>
            ),
          )}
        </span>
        <span className="pf-pages-compact" aria-live="polite">
          Trang {page}/{pages}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm pf-pager-btn"
          disabled={page >= pages || busy}
          onClick={() => onPage(page + 1)}
          aria-label="Trang sau"
        >
          <span className="pf-pager-txt">Sau</span>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </nav>
  );
}

function HistorySkeleton() {
  return (
    <div className="pf-hist-skel">
      <span className="sr-only" role="status">
        Đang tải lịch sử ván đấu…
      </span>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="pf-hist-srow" aria-hidden="true">
          <span className="skeleton pf-s-chip" />
          <span className="skeleton pf-s-avatar-sm" />
          <span className="pf-s-col">
            <span className="skeleton pf-s-line" style={{ width: `${45 + ((i * 19) % 35)}%` }} />
            <span className="skeleton pf-s-line pf-s-short" />
          </span>
          <span className="skeleton pf-s-btn" />
        </div>
      ))}
    </div>
  );
}

function MatchTable({ items }: { items: MatchSummaryDto[] }) {
  return (
    <div className="table-wrap pf-table-wrap">
      <table className="table pf-table">
        <thead>
          <tr>
            <th scope="col">Thời gian</th>
            <th scope="col">Hình thức</th>
            <th scope="col">Đối thủ</th>
            <th scope="col">Cầm quân</th>
            <th scope="col">Kết quả</th>
            <th scope="col" className="pf-col-num" title="Điểm hạng được cộng / bị trừ (chỉ ván xếp hạng)">
              Điểm hạng
            </th>
            <th scope="col">
              <span className="sr-only">Xem lại</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => {
            const mode = modeInfo(m);
            const reason = reasonLabel(m.endReason);
            return (
              <tr key={m.id}>
                <td className="nowrap">
                  <div className="pf-cell-main">{dayLabel(m.startedAt)}</div>
                  <div className="pf-cell-sub">{timeLabel(m.startedAt)}</div>
                </td>
                <td>
                  <div className="pf-mode">
                    <Icon name={mode.icon} size={15} />
                    {mode.label}
                  </div>
                  {m.timeControl && <div className="pf-cell-sub">{m.timeControl}</div>}
                </td>
                <td>
                  <Opponent m={m} />
                </td>
                <td className="nowrap">
                  <Side m={m} />
                </td>
                <td>
                  <OutcomeChip outcome={m.outcome} />
                  {reason && <div className="pf-cell-sub">{reason}</div>}
                </td>
                <td className="pf-col-num">
                  <Delta value={m.ratingChange} />
                </td>
                <td className="pf-col-action">
                  <Link to={`/replay/${m.id}`} className="btn btn-sm btn-soft pf-replay">
                    <Icon name="play" size={14} />
                    Xem lại
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatchCards({ items }: { items: MatchSummaryDto[] }) {
  return (
    <ul className="pf-mcards">
      {items.map((m) => {
        const mode = modeInfo(m);
        const reason = reasonLabel(m.endReason);
        return (
          <li key={m.id} className={`pf-mcard outcome-${m.outcome ?? 'none'}`}>
            <div className="pf-mcard-top">
              <OutcomeChip outcome={m.outcome} />
              <span className="pf-mcard-mode">
                <Icon name={mode.icon} size={14} />
                {mode.label}
                {m.timeControl ? ` · ${m.timeControl}` : ''}
              </span>
              <Delta value={m.ratingChange} />
            </div>
            <div className="pf-mcard-opp">
              <span className="pf-vs">Gặp</span>
              <Opponent m={m} />
              <span className="pf-mcard-side">
                <Side m={m} />
              </span>
            </div>
            <div className="pf-mcard-foot">
              <span className="pf-mcard-when">
                {dayLabel(m.startedAt)} · {timeLabel(m.startedAt)}
                {reason ? ` · ${reason}` : ''}
              </span>
              <Link to={`/replay/${m.id}`} className="btn btn-sm btn-soft pf-replay">
                <Icon name="play" size={14} />
                Xem lại
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MatchHistory({
  userId,
  game,
  page,
  setPage,
  isMe,
}: {
  userId: string;
  game: GameType;
  page: number;
  setPage: (p: number) => void;
  isMe: boolean;
}) {
  const key = `${userId}|${game}`;
  const [state, setState] = useState<{ key: string; page: number; data: Paginated<MatchSummaryDto> } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get<Paginated<MatchSummaryDto>>(`/api/users/${encodeURIComponent(userId)}/matches?game=${game}&page=${page}`)
      .then((d) => {
        if (!alive) return;
        setState({ key, page, data: d });
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError({ key, message: errorMessage(e) });
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId, game, page, nonce, key]);

  const data = state?.key === key ? state.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  // Số trang trên URL vượt quá số trang thực tế (ví dụ link cũ)
  useEffect(() => {
    if (data && data.total > 0 && page > pages) setPage(pages);
  }, [data, page, pages, setPage]);

  const goPage = (p: number) => {
    setPage(p);
    const el = ref.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const err = error?.key === key ? error.message : null;
  let body;
  if (err && !data) {
    body = (
      <div className="notice danger pf-error-inline" role="alert">
        <Icon name="alert" size={18} />
        <div className="grow">
          <div>Không tải được lịch sử ván đấu.</div>
          <div className="tiny muted">{err}</div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNonce((n) => n + 1)}>
          Thử lại
        </button>
      </div>
    );
  } else if (!data) {
    body = <HistorySkeleton />;
  } else if (data.items.length === 0) {
    body = (
      <EmptyState icon="history">
        <div className="pf-empty-title">Chưa có ván {GAME_LABEL[game]} nào</div>
        <div className="small">
          {isMe ? 'Các ván bạn chơi xong sẽ được lưu tại đây để xem lại.' : 'Các ván đã chơi xong sẽ được lưu tại đây.'}
        </div>
      </EmptyState>
    );
  } else {
    const stale = loading || state?.page !== page;
    body = (
      <div className={`pf-hist-body${stale ? ' is-loading' : ''}`} aria-busy={stale}>
        {err && (
          <div className="notice danger pf-error-inline" role="alert">
            <Icon name="alert" size={18} />
            <div className="grow">Không tải được trang {page}.</div>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNonce((n) => n + 1)}>
              Thử lại
            </button>
          </div>
        )}
        <MatchTable items={data.items} />
        <MatchCards items={data.items} />
        {pages > 1 && (
          <Pager page={Math.min(page, pages)} pages={pages} total={data.total} pageSize={data.pageSize} busy={loading} onPage={goPage} />
        )}
      </div>
    );
  }

  return (
    <section className="panel pf-history" ref={ref} aria-labelledby="pf-history-title">
      <div className="pf-sec-head">
        <div className="pf-sec-heading">
          <span className="pf-kicker">{GAME_LABEL[game]}</span>
          <h2 id="pf-history-title" className="pf-sec-title">
            Lịch sử ván đấu
          </h2>
          <p className="pf-sec-note">
            Mọi ván đã chơi xong: ván xếp hạng, phòng riêng, đấu với máy{game === 'xiangqi' ? ', Cờ úp' : ''}.
          </p>
        </div>
        {data && data.total > 0 && (
          <span className="chip" title="Tổng số ván đã chơi xong, gồm mọi hình thức">
            Tất cả: {data.total} ván
          </span>
        )}
      </div>
      {body}
    </section>
  );
}

/* ------------------------------------------------------------------ Trạng thái tải / lỗi */
function ProfileSkeleton() {
  return (
    <div className="profile" aria-busy="true">
      <span className="sr-only" role="status">
        Đang tải hồ sơ…
      </span>
      <section className="panel pf-hero" aria-hidden="true">
        <div className="pf-cover" />
        <div className="pf-hero-body">
          <div className="pf-avatar-wrap">
            <span className="skeleton pf-s-avatar" />
          </div>
          <div className="pf-ident pf-ident-skel">
            <span className="skeleton pf-s-name" />
            <span className="skeleton pf-s-meta" />
          </div>
        </div>
      </section>
      <section className="panel" aria-hidden="true">
        <span className="skeleton pf-s-title" />
        <div className="pf-stats pf-stats-skel">
          <span className="skeleton pf-s-tile" style={{ gridArea: 'rating' }} />
          <span className="skeleton pf-s-tile" style={{ gridArea: 'rank' }} />
          <span className="skeleton pf-s-tile" style={{ gridArea: 'peak' }} />
          <span className="skeleton pf-s-tile" style={{ gridArea: 'record' }} />
        </div>
      </section>
    </div>
  );
}

function ProfileError({ status, message, onRetry }: { status: number; message: string; onRetry: () => void }) {
  if (status === 404) {
    return (
      <div className="panel pf-fatal">
        <EmptyState icon="user">
          <div className="pf-empty-title">Không tìm thấy người chơi</div>
          <div className="small">Tài khoản này không tồn tại hoặc đường dẫn không đúng.</div>
          <Link to="/" className="btn btn-ghost btn-sm pf-empty-cta">
            Về trang chủ
          </Link>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="panel pf-fatal">
      <EmptyState icon="alert">
        <div className="pf-empty-title">Không tải được hồ sơ</div>
        <div className="small">{message}</div>
        <button type="button" className="btn btn-primary btn-sm pf-empty-cta" onClick={onRetry}>
          <Icon name="restart" size={16} />
          Thử lại
        </button>
      </EmptyState>
    </div>
  );
}

/* ------------------------------------------------------------------ Trang */
export function ProfilePage() {
  const { userId = '' } = useParams();
  const { me, refresh } = useAuth();
  const { game, setGame } = useGameSelect();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const tiers = useTiers();
  const [state, setState] = useState<{ userId: string; profile: ProfileDto } | null>(null);
  const [error, setError] = useState<{ userId: string; status: number; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isMe = me?.id === userId;
  const navType = useNavigationType();

  // Mở hồ sơ mới (kể cả từ hồ sơ khác, ví dụ bấm tên đối thủ) thì lên đầu trang; nút Quay lại giữ vị trí của trình duyệt
  useEffect(() => {
    if (navType !== 'POP') window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .get<ProfileDto>(`/api/users/${encodeURIComponent(userId)}/profile`)
      .then((p) => alive && setState({ userId, profile: p }))
      .catch(
        (e) => alive && setError({ userId, status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) }),
      );
    return () => {
      alive = false;
    };
  }, [userId, nonce]);

  // Trang lịch sử nằm trên URL (?page=) để quay lại từ trang xem lại vẫn đúng trang
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const setPage = useCallback(
    (p: number) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (p > 1) next.set('page', String(p));
          else next.delete('page');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // Đổi game (tab trong hồ sơ hoặc nút chọn game trên header) thì về trang 1
  const prevGame = useRef(game);
  useEffect(() => {
    if (prevGame.current === game) return;
    prevGame.current = game;
    setPage(1);
  }, [game, setPage]);

  const upload = async (file: File) => {
    if (file.size > AVATAR_LIMITS.maxBytes) {
      toast('Ảnh tối đa 2 MB', 'error');
      return;
    }
    if (!AVATAR_LIMITS.mimeTypes.includes(file.type)) {
      toast('Chỉ chấp nhận ảnh JPG, PNG hoặc WebP', 'error');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    try {
      await api.upload('/api/me/avatar', form);
      toast('Đã cập nhật ảnh đại diện', 'success');
      await refresh();
      setNonce((n) => n + 1);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setUploading(false);
    }
  };

  const profile = state?.userId === userId ? state.profile : null;
  const err = error?.userId === userId ? error : null;
  if (err && !profile) return <ProfileError status={err.status} message={err.message} onRetry={() => setNonce((n) => n + 1)} />;
  if (!profile) return <ProfileSkeleton />;

  const g = profile.games.find((x) => x.game === game) ?? profile.games[0];

  return (
    <div className="profile">
      <Hero
        profile={profile}
        isMe={isMe}
        game={g.game}
        onGame={setGame}
        uploading={uploading}
        onPickAvatar={() => fileRef.current?.click()}
      />
      {isMe && (
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      )}
      <SeasonPanel g={g} isMe={isMe} tiers={tiers} />
      <PastSeasons list={g.pastSeasons} isMe={isMe} />
      <MatchHistory userId={userId} game={g.game} page={page} setPage={setPage} isMe={isMe} />
    </div>
  );
}
