import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { isGameType, type GameType } from '@cotuong/game-core';
import {
  ELO_K,
  GAME_LABEL,
  LEADERBOARD_MIN_GAMES,
  RANKED_RULES,
  RANKED_TIME_CONTROL,
  RATING_FLOOR,
  lossMultiplier,
  START_RATING,
  type LeaderboardEntry,
  type SeasonArchiveDto,
  type SeasonDto,
  type TierDef,
} from '@cotuong/shared';
import { errorMessage } from '../api/http';
import { GameIcon, Icon, type IconName } from '../components/icons';
import { LbMine, LbSkeleton, loadArchive, seasonElapsed, seasonRange, useLeaderboard, useTiers } from '../components/Sidebar';
import { Avatar, EmptyState, GameTabs, TierBadge, tierColor } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';

/** Các mục trên trang có thể mở thẳng bằng đường dẫn (#...) — cuộn tới sau khi dữ liệu phía trên đã tải */
const ANCHORS = ['#quy-truoc', '#cach-tinh-diem'];

const RANKED_MINUTES = RANKED_TIME_CONTROL.initialMs / 60_000;
const RANKED_INC = RANKED_TIME_CONTROL.incrementMs / 1000;

/** Cho phép xuống dòng sau "_", "." và "-" (tên dài không dấu cách sẽ ngắt đẹp hơn: "An_" / "mw6md7r4") */
function softBreaks(name: string) {
  return name.split(/(?<=[_.-])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

/** Đồng hồ của trang: cập nhật mỗi `ms` (chỉ phần đếm ngược dùng, nên chỉ phần đó vẽ lại) */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/* ==========================================================================
   Banner mùa giải: tên mùa, thời gian, đếm ngược trực tiếp, tiến độ quý, lời mời chơi
   ========================================================================== */

const VN_OFFSET_MS = 7 * 3600_000;

/** Mốc đầu 3 tháng của quý (giờ Việt Nam) trên thanh tiến độ, tính theo % thời gian của mùa */
function quarterMonths(s: SeasonDto): Array<{ month: number; at: number; mid: number }> {
  const a = +new Date(s.startAt);
  const b = +new Date(s.endAt);
  if (!(b > a)) return [];
  const pos = (t: number) => Math.max(0, Math.min(100, ((t - a) / (b - a)) * 100));
  return [0, 1, 2].map((i) => {
    const m = (s.quarter - 1) * 3 + i; // 0..11
    const from = Date.UTC(s.year, m, 1) - VN_OFFSET_MS;
    const to = Date.UTC(s.year, m + 1, 1) - VN_OFFSET_MS;
    return { month: m + 1, at: pos(from), mid: (pos(from) + pos(to)) / 2 };
  });
}

function Countdown({ season }: { season: SeasonDto }) {
  const now = useNow(1000);
  const left = +new Date(season.endAt) - now;
  const closing = season.status !== 'active' || left <= 0;
  const elapsed = seasonElapsed(season, now);
  const months = quarterMonths(season);

  const total = Math.max(0, Math.floor(left / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const units: Array<[string, string]> = [
    [String(d), 'Ngày'],
    [String(h).padStart(2, '0'), 'Giờ'],
    [String(m).padStart(2, '0'), 'Phút'],
    [String(sec).padStart(2, '0'), 'Giây'],
  ];

  return (
    <div className="ss-clock">
      <div className="ss-clock-label">
        <Icon name="clock" size={15} />
        {closing ? 'Mùa đã hết giờ' : 'Mùa giải kết thúc sau'}
      </div>
      {closing ? (
        <div className="ss-clock-closing">Đang chốt kết quả</div>
      ) : (
        <div className="ss-clock-units" role="timer" aria-label={`Còn ${d} ngày ${h} giờ ${m} phút`}>
          {units.map(([v, label], i) => (
            <span key={label} className={`ss-unit${i === 3 ? ' is-sec' : ''}`} aria-hidden="true">
              <span className="ss-unit-v">{v}</span>
              <span className="ss-unit-l">{label}</span>
            </span>
          ))}
        </div>
      )}
      <div className="ss-progress">
        <div
          className="ss-progress-track"
          role="progressbar"
          aria-label="Thời gian mùa giải đã qua"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(elapsed)}
          aria-valuetext={`Đã qua ${Math.round(elapsed)}% mùa giải`}
        >
          <span className="ss-progress-fill" style={{ width: `${elapsed}%` }} />
          {months.slice(1).map((mo) => (
            <span key={mo.month} className="ss-progress-tick" style={{ left: `${mo.at}%` }} aria-hidden="true" />
          ))}
          {!closing && <span className="ss-progress-now" style={{ left: `${elapsed}%` }} aria-hidden="true" />}
        </div>
        <div className="ss-progress-months" aria-hidden="true">
          {months.map((mo) => (
            <span key={mo.month} className={elapsed >= mo.at ? 'is-past' : ''} style={{ left: `${mo.mid}%` }}>
              <span className="ss-m-long">Tháng </span>
              <span className="ss-m-short">T</span>
              {mo.month}
            </span>
          ))}
        </div>
        <div className="ss-progress-pct">Đã qua {Math.round(elapsed)}% mùa giải</div>
      </div>
    </div>
  );
}

function SeasonHero({
  game,
  onGame,
  season,
  error,
}: {
  game: GameType;
  onGame: (g: GameType) => void;
  season: SeasonDto | null;
  error: boolean;
}) {
  const { me } = useAuth();
  const location = useLocation();
  const active = !!season && season.status === 'active' && +new Date(season.endAt) > Date.now();

  return (
    <section className={`ss-hero ss-hero-${game}`} aria-labelledby="ss-hero-title">
      <span className="ss-hero-piece" aria-hidden="true">
        <GameIcon game={game} size={240} />
      </span>
      <div className="ss-hero-top">
        <span className="ss-hero-game">
          <GameIcon game={game} size={18} />
          {GAME_LABEL[game]}
        </span>
        {season && (
          <span className={`ss-kicker${active ? '' : ' is-closing'}`}>
            <span className="ss-live-dot" aria-hidden="true" />
            {active ? 'Đang diễn ra' : 'Đang chốt kết quả'}
          </span>
        )}
        <GameTabs withIcons value={game} onChange={onGame} className="ss-tabs" />
      </div>

      <div className="ss-hero-body">
        <div className="ss-hero-text">
          <h1 id="ss-hero-title" className="ss-hero-title">
            Mùa giải{' '}
            {season ? (
              <span className="ss-hero-q">
                Quý {season.quarter}/{season.year}
              </span>
            ) : (
              <span className="ss-hero-q">{GAME_LABEL[game]}</span>
            )}
          </h1>
          {season ? (
            <div className="ss-hero-range">
              <Icon name="calendar" size={16} />
              {seasonRange(season)} <span className="ss-hero-tz">(giờ Việt Nam)</span>
            </div>
          ) : (
            !error && <span className="skeleton ss-s-range" aria-hidden="true" />
          )}
          <p className="ss-hero-lead">
            Mỗi quý là một mùa giải. Chơi đủ <b>{LEADERBOARD_MIN_GAMES} ván xếp hạng</b> trong quý để có tên trong Top 10.
          </p>
          <ul className="ss-hero-facts" aria-label="Thông tin nhanh">
            <li>
              <Icon name="clock" size={14} />
              {RANKED_MINUTES} phút + {RANKED_INC} giây
            </li>
            <li>
              <Icon name="flag" size={14} />
              Bắt đầu từ {START_RATING} điểm
            </li>
            <li>
              <Icon name="users" size={14} />
              Tối thiểu {LEADERBOARD_MIN_GAMES} ván
            </li>
          </ul>
          <div className="ss-hero-cta">
            {me ? (
              active && (
                <Link to="/" className="btn btn-lg ss-btn-gold">
                  <Icon name="swords" size={19} />
                  Chơi ván xếp hạng
                </Link>
              )
            ) : (
              <Link to="/login" state={{ from: location.pathname + location.search }} className="btn btn-lg ss-btn-gold">
                <Icon name="login" size={19} />
                Đăng nhập để chơi xếp hạng
              </Link>
            )}
            <Link to={{ search: location.search, hash: '#cach-tinh-diem' }} className="btn btn-lg ss-btn-glass">
              <Icon name="info" size={18} />
              Cách tính điểm
            </Link>
          </div>
        </div>

        {season ? (
          <Countdown season={season} />
        ) : (
          !error && (
            <div className="ss-clock" aria-hidden="true">
              <span className="skeleton ss-s-clock" />
              <span className="skeleton ss-s-bar" />
            </div>
          )
        )}
      </div>
    </section>
  );
}

/* ==========================================================================
   Top 10: bục 3 hạng đầu + danh sách 4–10
   ========================================================================== */

/** Bục vinh quang cho 3 hạng đầu (thứ tự DOM 1-2-3, hiển thị 2-1-3) */
function Podium({ entries, size, meId }: { entries: LeaderboardEntry[]; size: 'lg' | 'sm'; meId?: string }) {
  return (
    <ol className={`podium podium-${size}`} aria-label="Ba hạng đầu">
      {[1, 2, 3].map((rank) => {
        const e = entries.find((x) => x.rank === rank);
        if (!e) {
          return (
            <li key={rank} className={`podium-spot podium-empty top${rank}`} aria-hidden="true">
              <span className="podium-person">
                <span className="podium-avatar">
                  <span className="podium-ghost">?</span>
                </span>
                <span className="podium-name muted">Còn trống</span>
              </span>
              <span className="podium-step">
                <span className="podium-num">{rank}</span>
              </span>
            </li>
          );
        }
        const isMe = !!meId && e.userId === meId;
        const avatar = size === 'lg' ? (rank === 1 ? 84 : 64) : rank === 1 ? 56 : 46;
        return (
          <li key={rank} className={`lb-row podium-spot top${rank}${isMe ? ' me' : ''}`}>
            <Link
              to={`/profile/${e.userId}`}
              className="podium-person"
              aria-label={`Hạng ${rank}: ${e.username}${isMe ? ' (bạn)' : ''}, ${e.rating} điểm, ${e.tier}, ${e.wins} thắng trong ${e.gamesPlayed} ván`}
            >
              <span className="podium-avatar">
                {rank === 1 && <span className="podium-rays" aria-hidden="true" />}
                {rank === 1 && <Icon name="crown" size={size === 'lg' ? 28 : 22} strokeWidth={2.2} className="podium-crown" />}
                <Avatar name={e.username} url={e.avatarUrl} size={avatar} />
              </span>
              <span className="podium-name" title={e.username}>
                {softBreaks(e.username)}
              </span>
              {isMe && <span className="lb-you">Bạn</span>}
              <TierBadge name={e.tier} level={e.tierLevel} />
              <span className="podium-rating">
                {e.rating}
                <span className="podium-unit"> điểm</span>
              </span>
              <span className="podium-stats">
                {e.wins} thắng · {e.gamesPlayed} ván
              </span>
            </Link>
            <span className="podium-step" aria-hidden="true">
              <span className="podium-num">{rank}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Một dòng hạng 4–10: hạng, avatar, tên + cấp bậc + thành tích, điểm kèm vạch so với người dẫn đầu */
function RestRow({ e, isMe, top, avatarSize }: { e: LeaderboardEntry; isMe: boolean; top: number; avatarSize: number }) {
  const pct = top > 0 ? Math.max(3, Math.min(100, (e.rating / top) * 100)) : 0;
  return (
    <li className={`lb-row ss-row${isMe ? ' me' : ''}`} style={{ '--i': e.rank - 4 } as CSSProperties}>
      <Link
        to={`/profile/${e.userId}`}
        className="lb-link ss-row-link"
        aria-label={`Hạng ${e.rank}: ${e.username}${isMe ? ' (bạn)' : ''}, ${e.rating} điểm, ${e.tier}, ${e.wins} thắng trong ${e.gamesPlayed} ván`}
      >
        <span className="ss-row-rank">{e.rank}</span>
        <Avatar name={e.username} url={e.avatarUrl} size={avatarSize} />
        <span className="lb-name">
          <span className="lb-username">{e.username}</span>
          <span className="lb-sub">
            <TierBadge name={e.tier} level={e.tierLevel} />
            {isMe && <span className="lb-you">Bạn</span>}
            <span className="ss-row-stats">
              {e.wins} thắng · {e.gamesPlayed} ván
            </span>
          </span>
        </span>
        <span className="ss-row-score">
          <span className="lb-rating">{e.rating}</span>
          <span className="ss-row-bar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Bục 3 hạng đầu + danh sách hạng 4–10 */
function Board({ entries, size, meId }: { entries: LeaderboardEntry[]; size: 'lg' | 'sm'; meId?: string }) {
  const rest = entries.filter((e) => e.rank > 3);
  const top = entries.find((e) => e.rank === 1)?.rating ?? 0;
  return (
    <div className={`ss-board ss-board-${size}${rest.length ? '' : ' no-rest'}`}>
      <Podium entries={entries} size={size} meId={meId} />
      {rest.length > 0 && (
        <ol className="lb-list ss-rest" start={4} aria-label="Hạng 4 đến 10">
          {rest.map((e) => (
            <RestRow key={e.userId} e={e} isMe={!!meId && e.userId === meId} top={top} avatarSize={size === 'lg' ? 36 : 28} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** Bảng còn trống: bục mờ + 3 bước để có tên trên bảng (lời mời bấm chơi nằm ở banner phía trên) */
function EmptyBoard({ minGames, gamesDone }: { minGames: number; gamesDone: number | null }) {
  const { me } = useAuth();
  const step1Done = !!me?.emailVerified;
  return (
    <div className="ss-empty-board">
      <div className="ss-ghost-stage" aria-hidden="true">
        <Podium entries={[]} size="lg" />
      </div>
      <div className="ss-empty-copy">
        <h3 className="ss-empty-title">Bục vinh quang còn trống</h3>
        <p className="ss-empty-text">
          Quý này chưa ai chơi đủ {minGames} ván xếp hạng. Ba người nhiều điểm nhất sẽ đứng trên bục này — có thể là bạn.
        </p>
        <ol className="ss-steps" aria-label="Cách có tên trên bảng">
          <li className={step1Done ? 'is-done' : ''}>
            <span className="ss-step-icon" aria-hidden="true">
              <Icon name={step1Done ? 'check' : 'mail'} size={17} />
            </span>
            <span className="ss-step-text">
              <b>Đăng nhập và xác thực email</b>
              <span>{step1Done ? 'Bạn đã xong bước này' : 'Cần xác thực email để chơi ván xếp hạng'}</span>
            </span>
          </li>
          <li>
            <span className="ss-step-icon" aria-hidden="true">
              <Icon name="swords" size={17} />
            </span>
            <span className="ss-step-text">
              <b>Chơi ván xếp hạng</b>
              <span>
                Mỗi bên {RANKED_MINUTES} phút, cộng {RANKED_INC} giây sau mỗi nước
              </span>
            </span>
          </li>
          <li>
            <span className="ss-step-icon" aria-hidden="true">
              <Icon name="trophy" size={17} />
            </span>
            <span className="ss-step-text">
              <b>Đủ {minGames} ván trong quý</b>
              <span>
                {gamesDone !== null
                  ? `Bạn đã chơi ${Math.min(gamesDone, minGames)}/${minGames} ván`
                  : 'Là có thứ hạng; 10 người nhiều điểm nhất vào Top 10'}
              </span>
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function ErrorBox({ text, detail, onRetry }: { text: string; detail: string; onRetry: () => void }) {
  return (
    <div className="notice danger ss-error" role="alert">
      <Icon name="alert" size={18} />
      <div className="grow">
        <div>{text}</div>
        <div className="tiny muted">{detail}</div>
      </div>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
        Thử lại
      </button>
    </div>
  );
}

function PodiumSkeleton({ size }: { size: 'lg' | 'sm' }) {
  return (
    <div className={`podium podium-${size} podium-skel`} aria-hidden="true">
      {[1, 2, 3].map((rank) => (
        <div key={rank} className={`podium-spot top${rank}`}>
          <span className="podium-person">
            <span className="skeleton podium-s-avatar" />
            <span className="skeleton podium-s-line" />
            <span className="skeleton podium-s-line short" />
          </span>
          <span className="podium-step" />
        </div>
      ))}
    </div>
  );
}

/** Mùa đang diễn ra: Top 10 trực tiếp */
function LiveSeason({ live }: { live: ReturnType<typeof useLeaderboard> }) {
  const { me } = useAuth();
  const location = useLocation();
  const { data, error, retry } = live;

  if (!data) {
    return (
      <section className="panel ss-live" aria-busy={!error} aria-label="Top 10 mùa hiện tại">
        {error ? (
          <ErrorBox text="Không tải được bảng xếp hạng mùa này." detail={error} onRetry={retry} />
        ) : (
          <>
            <div className="ss-live-head" aria-hidden="true">
              <span className="skeleton ss-s-title" />
            </div>
            <div className="ss-board ss-board-lg">
              <PodiumSkeleton size="lg" />
              <LbSkeleton rows={7} />
            </div>
          </>
        )}
      </section>
    );
  }

  const { season, entries } = data;
  const mine = data.me;
  const meInTop = !!me && entries.some((e) => e.userId === me.id);
  const minGames = mine?.minGames ?? LEADERBOARD_MIN_GAMES;

  return (
    <section className="panel ss-live" aria-labelledby="ss-live-title">
      <div className="ss-live-head">
        <h2 id="ss-live-title" className="ss-section-title">
          <Icon name="trophy" size={22} />
          Top 10 – Quý {season.quarter}/{season.year}
        </h2>
        <span className="chip ss-live-chip">
          <span className="ss-live-dot" aria-hidden="true" />
          Cập nhật trực tiếp
        </span>
      </div>

      {entries.length === 0 ? (
        <EmptyBoard minGames={minGames} gamesDone={me && mine ? mine.gamesPlayed : null} />
      ) : (
        <Board entries={entries} size="lg" meId={me?.id} />
      )}

      {me && mine && !meInTop && (
        <div className="ss-mine">
          <LbMine user={me} standing={mine} avatarSize={36} />
        </div>
      )}
      {!me && entries.length > 0 && (
        <div className="lb-guest ss-guest">
          <Icon name="user" size={18} />
          <span className="grow">Đăng nhập để chơi ván xếp hạng và ghi tên lên bảng.</span>
          <Link to="/login" state={{ from: location.pathname + location.search }} className="btn btn-sm btn-primary">
            Đăng nhập
          </Link>
        </div>
      )}
    </section>
  );
}

/* ==========================================================================
   Các quý trước
   ========================================================================== */

function ArchiveCard({ s, meId }: { s: SeasonArchiveDto; meId?: string }) {
  const champ = s.entries.find((e) => e.rank === 1);
  return (
    <article className={`panel ss-card${s.entries.length ? '' : ' is-empty'}`} aria-labelledby={`ss-card-${s.season.id}`}>
      <div className="ss-card-head">
        <div className="ss-card-heading">
          <h3 id={`ss-card-${s.season.id}`} className="ss-card-title">
            Quý {s.season.quarter}/{s.season.year}
          </h3>
          <div className="ss-meta">
            <Icon name="calendar" size={14} />
            {seasonRange(s.season)}
          </div>
        </div>
        <span className="chip ss-closed">
          <Icon name="lock" size={12} />
          Đã chốt
        </span>
      </div>
      {champ && (
        <div className="ss-champ">
          <Icon name="crown" size={15} />
          <span>
            Vô địch: <b>{champ.username}</b> · {champ.rating} điểm
          </span>
        </div>
      )}
      {s.entries.length === 0 ? (
        <div className="ss-card-empty">
          <Icon name="users" size={18} />
          Mùa này không ai chơi đủ {LEADERBOARD_MIN_GAMES} ván xếp hạng để vào bảng.
        </div>
      ) : (
        <Board entries={s.entries} size="sm" meId={meId} />
      )}
    </article>
  );
}

function ArchiveSkeleton() {
  return (
    <div className="ss-archive-skel" aria-busy="true">
      <span className="sr-only" role="status">
        Đang tải các quý trước…
      </span>
      {[0, 1].map((i) => (
        <div key={i} className="panel ss-card" aria-hidden="true">
          <div className="ss-card-head">
            <div className="ss-card-heading">
              <span className="skeleton ss-s-title" />
              <span className="skeleton ss-s-meta" />
            </div>
          </div>
          <PodiumSkeleton size="sm" />
          <LbSkeleton rows={3} label="" />
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Cách tính điểm hạng + thang cấp bậc
   ========================================================================== */

/** Khoảng điểm của từng cấp bậc, từ thấp lên cao (tiers xếp từ cao xuống thấp; cấp thấp nhất bắt đầu từ sàn điểm) */
function tierRanges(tiers: TierDef[]): Array<{ name: string; level: number; lo: number; text: string }> {
  const n = tiers.length;
  return tiers
    .map((t, i) => {
      const lo = Number.isFinite(t.min) ? Math.max(t.min, RATING_FLOOR) : RATING_FLOOR;
      const hi = i > 0 ? tiers[i - 1].min - 1 : null;
      return { name: t.name, level: n - 1 - i, lo, text: hi === null ? `từ ${lo} điểm` : `${lo}–${hi} điểm` };
    })
    .reverse();
}

/** Số chấm trên khiên cấp bậc — giống TierBadge */
const stars = (level: number) => Math.max(1, Math.min(3, (level % 3) + 1));

/** Thang cấp bậc: bậc thang cao dần từ Tân thủ tới cấp cao nhất (điện thoại: danh sách dọc, cấp cao ở trên) */
function TierLadder({ tiers, myLevel }: { tiers: TierDef[]; myLevel: number | null }) {
  const ranges = tierRanges(tiers);
  const n = Math.max(1, ranges.length - 1);
  return (
    <div className="ss-ladder-wrap">
      <h3 className="ss-tiers-title">Cấp bậc theo điểm</h3>
      <ol className="ss-ladder">
        {ranges.map((t, i) => {
          const c = tierColor(t.level);
          const mine = myLevel === t.level;
          return (
            <li
              key={t.name}
              className={`ss-rung${mine ? ' is-mine' : ''}`}
              style={{ '--tc': c, '--h': i / n, '--i': i } as CSSProperties}
            >
              {mine && <span className="ss-rung-you">Bạn ở đây</span>}
              <span className="ss-rung-head">
                <svg className="ss-rung-shield" viewBox="0 0 20 22" width="30" height="33" aria-hidden="true">
                  <path d="M10 1 L18 4.5 V11 C18 16 14.5 19.5 10 21 C5.5 19.5 2 16 2 11 V4.5 Z" fill={c} />
                  {t.level >= 6 ? (
                    <path d="M5 9 L7.5 12 L10 7 L12.5 12 L15 9 L14 15 H6 Z" fill="#fff" />
                  ) : (
                    Array.from({ length: stars(t.level) }, (_, k) => (
                      <circle key={k} cx={10 + (k - (stars(t.level) - 1) / 2) * 4.2} cy={11.5} r={1.6} fill="#fff" />
                    ))
                  )}
                </svg>
                <span className="ss-rung-name">{t.name}</span>
                <span className="ss-rung-range">{t.text}</span>
              </span>
              <span className="ss-rung-step" aria-hidden="true" />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Số thập phân kiểu Việt Nam (1,5) */
const decimal = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Các cấp bậc có hệ số trừ điểm khi thua lớn hơn 1, từ thấp lên cao (tính đúng như máy chủ) */
function lossSteps(tiers: readonly TierDef[]): Array<{ name: string; m: number }> {
  return [...tiers]
    .reverse()
    .map((t) => ({ name: t.name, m: lossMultiplier(Number.isFinite(t.min) ? t.min : 0, tiers) }))
    .filter((s) => s.m > 1);
}

function Rule({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li>
      <span className="ss-rule-icon" aria-hidden="true">
        <Icon name={icon} size={17} />
      </span>
      <span>{children}</span>
    </li>
  );
}

/** Giải thích luật điểm hạng — mọi con số lấy từ hằng số dùng chung với máy chủ và cấp bậc từ /api/config */
function RatingRules({ myLevel }: { myLevel: number | null }) {
  const tiers = useTiers();
  return (
    <section className="panel ss-rules" id="cach-tinh-diem" aria-labelledby="ss-rules-title">
      <h2 id="ss-rules-title" className="ss-section-title">
        <Icon name="info" size={20} />
        Cách tính điểm hạng
      </h2>
      <TierLadder tiers={tiers} myLevel={myLevel} />
      <ul className="ss-rule-list">
        <Rule icon="calendar">
          Mỗi quý (theo giờ Việt Nam) là một <b>mùa giải</b>. Đầu mùa, ai cũng bắt đầu từ <b>{START_RATING} điểm</b>.
        </Rule>
        <Rule icon="swords">
          Chỉ <b>ván xếp hạng</b> mới tính điểm (mỗi bên {RANKED_MINUTES} phút, cộng {RANKED_INC} giây sau mỗi nước; cần xác thực
          email để chơi). Phòng riêng, đấu với máy, Cờ úp và Cờ thế không tính điểm.
        </Rule>
        <Rule icon="trophy">
          Thắng được cộng điểm, thua bị trừ điểm (hệ Elo, K = {ELO_K}). Thắng người nhiều điểm hơn mình được cộng nhiều hơn; thua
          người ít điểm hơn bị trừ nhiều hơn. Hoà thì người ít điểm hơn được cộng chút ít.
        </Rule>
        <Rule icon="bolt">
          <b>{RANKED_RULES.placementGames} ván xếp hạng đầu mùa</b>: điểm được cộng nhân ×{decimal(RANKED_RULES.placementMultiplier)} — người
          mới hoặc vào giữa mùa bắt kịp nhanh hơn.
        </Rule>
        <Rule icon="shield">
          <b>Cấp càng cao, thua càng mất nhiều</b>: điểm bị trừ được nhân{' '}
          {lossSteps(tiers)
            .map((s) => `×${decimal(s.m)} (${s.name})`)
            .join(', ')}
          ; các cấp thấp hơn không nhân. Điểm không bao giờ xuống dưới {RATING_FLOOR}.
        </Rule>
        <Rule icon="target">
          <b>Chuỗi thắng</b>: thắng {RANKED_RULES.streakFrom} ván liên tiếp được thưởng thêm +{RANKED_RULES.streakStep}, từ ván thứ{' '}
          {RANKED_RULES.streakFrom + 1} trở đi +{RANKED_RULES.streakMaxBonus} mỗi ván. Thua hoặc hoà thì chuỗi tính lại từ đầu.
        </Rule>
        <Rule icon="clock">
          <b>Không chơi thì tụt điểm</b>: từ {RANKED_RULES.decayMinRating} điểm trở lên mà {RANKED_RULES.decayAfterDays} ngày không
          chơi ván xếp hạng nào, mỗi ngày bị trừ {RANKED_RULES.decayPerDay} điểm — nhưng không tụt khỏi cấp bậc đang có.
        </Rule>
        <Rule icon="users">
          Chơi đủ <b>{LEADERBOARD_MIN_GAMES} ván xếp hạng</b> trong mùa để có tên trong Top 10. Bằng điểm thì ai thắng nhiều ván hơn
          đứng trên, tiếp theo là tỉ lệ thắng cao hơn, rồi tới người đạt mức điểm đó sớm hơn.
        </Rule>
        <Rule icon="star">
          Hết mùa, bảng Top 10 được chốt và lưu ở mục “Các quý trước”; người trong Top 10 nhận huy hiệu mùa trên hồ sơ. Mùa mới, mọi
          người lại bắt đầu từ {START_RATING} điểm.
        </Rule>
      </ul>
    </section>
  );
}

/* ==========================================================================
   Trang
   ========================================================================== */

/** Trang Mùa giải: banner mùa hiện tại + Top 10 (trực tiếp) + cách tính điểm + bảng đã chốt của các quý trước */
export function SeasonsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { me } = useAuth();
  const { game: selected, setGame } = useGameSelect();
  const q = params.get('game');
  const game: GameType = isGameType(q) ? q : selected;
  const navType = useNavigationType();

  // Vào trang từ chỗ khác (đang cuộn dở) thì lên đầu trang, trừ khi đi tới một mục (#...) hoặc bấm Quay lại
  useEffect(() => {
    if (navType !== 'POP' && !ANCHORS.includes(location.hash)) window.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?game= trên URL là nguồn chính: đồng bộ sang nút chọn game trên header (và thẻ Top 10 ở trang chủ)
  useEffect(() => {
    if (isGameType(q) && q !== selected) setGame(q);
  }, [q, selected, setGame]);

  const changeGame = (g: GameType) => {
    setGame(g);
    setParams({ game: g }, { replace: true });
  };

  const [archive, setArchive] = useState<{ game: GameType; seasons: SeasonArchiveDto[] } | null>(null);
  const [archiveError, setArchiveError] = useState<{ game: GameType; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setArchiveError(null);
    loadArchive(game, nonce > 0)
      .then((d) => alive && setArchive({ game, seasons: d }))
      .catch((e) => alive && setArchiveError({ game, message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [game, nonce]);

  const seasons = archive?.game === game ? archive.seasons : null;
  const archiveErr = archiveError?.game === game ? archiveError.message : null;

  // "#quy-truoc" / "#cach-tinh-diem": cuộn tới mục đó sau khi phần phía trên đã tải xong (tránh trang nhảy)
  const live = useLeaderboard(game);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ANCHORS.includes(location.hash) || scrolledFor.current === location.key) return;
    if (!live.data && !live.error) return;
    if (location.hash === '#quy-truoc' && !seasons && !archiveErr) return;
    scrolledFor.current = location.key;
    const id = location.hash.slice(1);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [location.hash, location.key, seasons, archiveErr, live.data, live.error]);

  const mine = me ? live.data?.me ?? null : null;

  return (
    <div className="seasons">
      <SeasonHero game={game} onGame={changeGame} season={live.data?.season ?? null} error={!!live.error} />

      <LiveSeason live={live} />

      <RatingRules myLevel={mine ? mine.tierLevel : null} />

      <section className="ss-archive" id="quy-truoc" aria-labelledby="ss-archive-title">
        <div className="ss-section-head">
          <h2 id="ss-archive-title" className="ss-section-title">
            <Icon name="history" size={20} />
            Các quý trước
          </h2>
          {seasons && seasons.length > 0 && <span className="chip">{seasons.length} mùa đã chốt</span>}
        </div>
        {archiveErr ? (
          <ErrorBox text="Không tải được các quý trước." detail={archiveErr} onRetry={() => setNonce((n) => n + 1)} />
        ) : !seasons ? (
          <ArchiveSkeleton />
        ) : seasons.length === 0 ? (
          <div className="panel ss-archive-empty">
            <EmptyState icon="calendar">
              <div className="ss-empty-title">Chưa có mùa giải nào kết thúc</div>
              <div className="small">Bảng Top 10 của mỗi quý sẽ được lưu lại tại đây khi mùa giải kết thúc.</div>
            </EmptyState>
          </div>
        ) : (
          <div className={`season-grid${seasons.length === 1 ? ' single' : ''}`}>
            {seasons.map((s) => (
              <ArchiveCard key={s.season.id} s={s} meId={me?.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
