import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { GameType } from '@cotuong/game-core';
import {
  DEFAULT_TIERS,
  GAME_LABEL,
  LEADERBOARD_MIN_GAMES,
  deserializeTiers,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type MyStanding,
  type PublicUser,
  type SeasonArchiveDto,
  type SeasonDto,
  type TierDef,
} from '@cotuong/shared';
import { api, errorMessage, loadAppConfig } from '../api/http';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import { useRealtime } from '../state/realtime';
import { Icon } from './icons';
import { Avatar, EmptyState, GameTabs, RankMedal, TierBadge } from './ui';

/* ==========================================================================
   Khối dựng bảng xếp hạng dùng chung (thẻ Top 10 ở trang chủ, trang Mùa giải, hồ sơ)
   ========================================================================== */

/** Ngày theo giờ Việt Nam (mùa giải chốt theo GMT+7), luôn dạng dd/mm hoặc dd/mm/yyyy */
const VN_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });

function vnDate(t: string | number, withYear: boolean): string {
  const parts = VN_DATE.formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return withYear ? `${get('day')}/${get('month')}/${get('year')}` : `${get('day')}/${get('month')}`;
}

/** Khoảng thời gian của mùa, ví dụ "01/10 – 31/12/2026" (giờ Việt Nam; endAt là 00:00 ngày đầu quý sau) */
export function seasonRange(s: Pick<SeasonDto, 'startAt' | 'endAt'>): string {
  return `${vnDate(s.startAt, false)} – ${vnDate(+new Date(s.endAt) - 1, true)}`;
}

/** Phần trăm thời gian của mùa đã trôi qua (0–100) */
export function seasonElapsed(s: Pick<SeasonDto, 'startAt' | 'endAt'>, now = Date.now()): number {
  const a = +new Date(s.startAt);
  const b = +new Date(s.endAt);
  return b > a ? Math.max(0, Math.min(100, ((now - a) / (b - a)) * 100)) : 100;
}

/** "Còn 54 ngày" — hoặc "Đang chốt kết quả" khi mùa đã hết giờ */
export function daysLeftText(s: Pick<SeasonDto, 'status' | 'daysLeft'>): string {
  if (s.status !== 'active' || s.daysLeft <= 0) return 'Đang chốt kết quả';
  return `Còn ${s.daysLeft} ngày`;
}

/** Thanh tiến độ mảnh */
export function Meter({
  value,
  label,
  className,
  decorative = false,
}: {
  value: number;
  label: string;
  className?: string;
  /** true: chỉ để trang trí (đã có chữ mô tả bên cạnh) */
  decorative?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) };
  return (
    <span className={`lb-meter${className ? ` ${className}` : ''}`} {...a11y} title={decorative ? undefined : label}>
      <span className="lb-meter-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/* ------------------------------------------------------------------ Cấp bậc (từ /api/config, dự phòng: bảng mặc định) */
let tiersPromise: Promise<TierDef[]> | null = null;

function loadTiers(): Promise<TierDef[]> {
  tiersPromise ??= loadAppConfig()
    .then((c) => deserializeTiers(c.tiers))
    .catch(() => {
      tiersPromise = null;
      return DEFAULT_TIERS;
    });
  return tiersPromise;
}

/** Danh sách cấp bậc máy chủ đang dùng (từ cao xuống thấp) */
export function useTiers(): TierDef[] {
  const [tiers, setTiers] = useState<TierDef[]>(DEFAULT_TIERS);
  useEffect(() => {
    let alive = true;
    void loadTiers().then((t) => alive && setTiers(t));
    return () => {
      alive = false;
    };
  }, []);
  return tiers;
}

/* ------------------------------------------------------------------ Bảng đã chốt của các quý trước */
const archiveCache = new Map<GameType, Promise<SeasonArchiveDto[]>>();

/** Các mùa đã chốt của một game (dùng chung cho trang Mùa giải và thẻ Top 10); `fresh` = bỏ qua dữ liệu đã tải */
export function loadArchive(game: GameType, fresh = false): Promise<SeasonArchiveDto[]> {
  let p = fresh ? undefined : archiveCache.get(game);
  if (!p) {
    const req = api.get<SeasonArchiveDto[]>(`/api/leaderboard/${game}/archive`);
    archiveCache.set(game, req);
    // Lỗi thì quên đi để lần sau tải lại
    req.catch(() => archiveCache.get(game) === req && archiveCache.delete(game));
    p = req;
  }
  return p;
}

/** Đã có mùa nào kết thúc chưa (null = đang tải / không tải được) */
function useHasArchive(game: GameType): boolean | null {
  const [state, setState] = useState<{ game: GameType; has: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    loadArchive(game)
      .then((list) => alive && setState({ game, has: list.length > 0 }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [game]);
  return state?.game === game ? state.has : null;
}

const lbCache = new Map<string, LeaderboardResponse>();
/** Yêu cầu đang chạy: trang chủ cần cùng một bảng ở hai chỗ (thẻ người chơi + Top 10) — chỉ gọi API một lần */
const lbInflight = new Map<string, Promise<LeaderboardResponse>>();

function fetchLeaderboard(game: GameType, requestKey: string): Promise<LeaderboardResponse> {
  let req = lbInflight.get(requestKey);
  if (!req) {
    req = api.get<LeaderboardResponse>(`/api/leaderboard/${game}`).finally(() => lbInflight.delete(requestKey));
    lbInflight.set(requestKey, req);
  }
  return req;
}

/**
 * Top 10 quý hiện tại của một game. Tự tải lại khi bảng thay đổi (realtime) hoặc khi đổi tài khoản;
 * trong lúc tải lại vẫn giữ dữ liệu cũ để không nhấp nháy.
 */
export function useLeaderboard(game: GameType) {
  const { me, loading } = useAuth();
  const { lbVersion } = useRealtime();
  const version = lbVersion[game];
  const key = `${game}|${me?.id ?? ''}`;
  const [state, setState] = useState<{ key: string; data: LeaderboardResponse } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Chờ biết đã đăng nhập hay chưa: tránh tải bảng hai lần (khách rồi người dùng) và nhấp nháy khung xương
    if (loading) return;
    let alive = true;
    const cached = lbCache.get(key);
    if (cached) setState({ key, data: cached });
    setError(null); // "Thử lại": hiện lại khung xương trong lúc tải
    fetchLeaderboard(game, `${key}|${version}|${nonce}`)
      .then((d) => {
        lbCache.set(key, d);
        if (!alive) return;
        setState({ key, data: d });
        setError(null);
      })
      .catch((e) => alive && setError({ key, message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [key, game, version, nonce, loading]);

  const data = (state?.key === key ? state.data : lbCache.get(key)) ?? null;
  return {
    data,
    error: !data && error?.key === key ? error.message : null,
    retry: () => setNonce((n) => n + 1),
  };
}

/** Một dòng trong bảng xếp hạng (giữ class .lb-row cho kiểm thử tự động) */
export function LbRow({
  entry,
  isMe = false,
  avatarSize = 30,
}: {
  entry: LeaderboardEntry;
  isMe?: boolean;
  avatarSize?: number;
}) {
  return (
    <li className={`lb-row${entry.rank <= 3 ? ` top${entry.rank}` : ''}${isMe ? ' me' : ''}`}>
      <Link
        to={`/profile/${entry.userId}`}
        className="lb-link"
        aria-label={`Hạng ${entry.rank}: ${entry.username}${isMe ? ' (bạn)' : ''}, ${entry.rating} điểm, ${entry.tier}`}
      >
        <RankMedal rank={entry.rank} />
        <Avatar name={entry.username} url={entry.avatarUrl} size={avatarSize} />
        <span className="lb-name">
          <span className="lb-username">{entry.username}</span>
          <span className="lb-sub">
            <TierBadge name={entry.tier} level={entry.tierLevel} />
            {isMe && <span className="lb-you">Bạn</span>}
          </span>
        </span>
        <span className="lb-rating">{entry.rating}</span>
      </Link>
    </li>
  );
}

/** Khung xương trong lúc tải danh sách */
export function LbSkeleton({ rows = 10, label = 'Đang tải bảng xếp hạng…' }: { rows?: number; label?: string }) {
  return (
    <div className="lb-skeleton">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="lb-srow" aria-hidden="true">
          <span className="skeleton lb-s-rank" />
          <span className="skeleton lb-s-avatar" />
          <span className="lb-s-text">
            <span className="skeleton lb-s-line" style={{ width: `${58 + ((i * 23) % 32)}%` }} />
            <span className="skeleton lb-s-line lb-s-short" />
          </span>
          <span className="skeleton lb-s-num" />
        </div>
      ))}
    </div>
  );
}

/** Vị trí của người đang đăng nhập khi không nằm trong Top 10 */
export function LbMine({
  user,
  standing,
  compact = false,
  avatarSize = 30,
}: {
  user: PublicUser;
  standing: MyStanding;
  /** Một dòng gọn (thẻ Top 10 ở trang chủ): số ván đã chơi thành nhãn nhỏ thay cho dòng tiến độ bên dưới */
  compact?: boolean;
  avatarSize?: number;
}) {
  const ranked = standing.rank !== null;
  const done = Math.min(standing.gamesPlayed, standing.minGames);
  const pct = standing.minGames > 0 ? (done / standing.minGames) * 100 : 0;
  return (
    <div className="lb-mine">
      <div className="lb-mine-label">Vị trí của bạn</div>
      <Link
        to={`/profile/${user.id}`}
        className="lb-link lb-mine-link"
        aria-label={
          ranked
            ? `Vị trí của bạn: hạng ${standing.rank}, ${standing.rating} điểm, ${standing.tier}`
            : `Vị trí của bạn: chưa có hạng (đã chơi ${done}/${standing.minGames} ván xếp hạng), ${standing.rating} điểm`
        }
      >
        <span className={`rank-num${ranked && String(standing.rank).length > 2 ? ' rank-num-long' : ''}`}>
          {ranked ? standing.rank : '–'}
        </span>
        <Avatar name={user.username} url={user.avatarUrl} size={avatarSize} />
        <span className="lb-name">
          <span className="lb-username">{user.username}</span>
          {ranked ? (
            <span className="lb-sub">
              <TierBadge name={standing.tier} level={standing.tierLevel} />
            </span>
          ) : (
            compact && (
              <span className="lb-sub">
                <span
                  className="lb-mine-games"
                  style={{ '--pct': `${pct}%` } as CSSProperties}
                  title={`Chơi đủ ${standing.minGames} ván xếp hạng trong quý để có thứ hạng (đã chơi ${done})`}
                >
                  {done}/{standing.minGames} ván
                </span>
              </span>
            )
          )}
        </span>
        <span className="lb-rating">{standing.rating}</span>
        {!ranked && !compact && (
          <span className="lb-mine-progress">
            <span className="lb-mine-sub">
              Chưa có hạng ({done}/{standing.minGames} ván)
            </span>
            <Meter value={pct} label="" decorative className="lb-mine-meter" />
          </span>
        )}
      </Link>
    </div>
  );
}

/**
 * Thẻ Top 10 của quý hiện tại — chỉ có ở trang chủ, ngay dưới bảng tìm trận.
 * Hai thẻ Cờ tướng / Cờ vua dùng chung trạng thái với nút chọn game trên header (đổi ở đâu cũng đổi cả trang).
 */
export function Top10Card({ titleId }: { titleId?: string }) {
  const { game, setGame } = useGameSelect();
  const { me, loading } = useAuth();
  const location = useLocation();
  const { data, error, retry } = useLeaderboard(game);
  const season = data?.season ?? null;
  const entries = data?.entries ?? [];
  const mine = data?.me ?? null;
  const meInTop = !!me && entries.some((e) => e.userId === me.id);
  const urgent = !!season && season.status === 'active' && season.daysLeft <= 7;
  const hasArchive = useHasArchive(game);

  let body;
  if (!data) {
    body = error ? (
      <div className="notice danger lb-error" role="alert">
        <Icon name="alert" size={18} />
        <div className="grow">
          <div>Không tải được bảng xếp hạng.</div>
          <div className="tiny muted">{error}</div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={retry}>
          Thử lại
        </button>
      </div>
    ) : (
      <LbSkeleton />
    );
  } else if (entries.length === 0) {
    body = (
      <div className="lb-empty">
        <EmptyState icon="trophy">
          <div className="lb-empty-title">Chưa có ai trên bảng</div>
          <div className="small">Chơi đủ {mine?.minGames ?? LEADERBOARD_MIN_GAMES} ván xếp hạng trong quý để có tên trong Top 10.</div>
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <ol className="lb-list" aria-label={season ? `Top 10 ${GAME_LABEL[game]} quý ${season.quarter}/${season.year}` : 'Top 10'}>
        {entries.map((e) => (
          <LbRow key={e.userId} entry={e} isMe={me?.id === e.userId} avatarSize={24} />
        ))}
      </ol>
    );
  }

  return (
    <div className="lb lb-card">
      <div className="lb-head">
        <div className="lb-heading">
          <h2 className="lb-title" id={titleId}>
            <Icon name="trophy" size={18} className="lb-title-icon" />
            Top 10
          </h2>
          {season ? (
            <p className="lb-meta" title={`Mùa giải ${seasonRange(season)} (giờ Việt Nam)`}>
              <span>
                Quý {season.quarter}/{season.year}
              </span>
              <span className={`lb-days${urgent ? ' is-urgent' : ''}`}>
                <Icon name="clock" size={12} />
                {daysLeftText(season)}
              </span>
            </p>
          ) : (
            !error && <span className="skeleton lb-s-meta" aria-hidden="true" />
          )}
        </div>
        <GameTabs value={game} onChange={setGame} size="sm" className="lb-tabs" />
      </div>

      {body}

      {me && mine && !meInTop && <LbMine user={me} standing={mine} compact avatarSize={24} />}

      {!me && !loading && (
        <Link to="/login" state={{ from: location.pathname + location.search }} className="lb-guest lb-guest-link">
          <Icon name="login" size={16} />
          <span className="grow">
            <b>Đăng nhập</b> để ghi tên lên bảng
          </span>
          <Icon name="chevron-right" size={16} className="lb-guest-arrow" />
        </Link>
      )}

      <div className="lb-foot">
        <Link className="lb-archive" to={`/seasons?game=${game}#cach-tinh-diem`}>
          <Icon name="info" size={15} />
          <span>Cách tính điểm</span>
        </Link>
        {/* Chỉ hiện khi đã có mùa giải kết thúc (trước đó trang "các quý trước" trống) */}
        {hasArchive && (
          <Link className="lb-archive" to={`/seasons?game=${game}#quy-truoc`}>
            <Icon name="history" size={15} />
            <span>Các quý trước</span>
            <Icon name="arrow-right" size={15} className="lb-archive-arrow" />
          </Link>
        )}
      </div>
    </div>
  );
}
