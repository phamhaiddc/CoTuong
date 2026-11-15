import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { JieqiGame, replayGame, replayJieqi, type Color, type GameEngine } from '@cotuong/game-core';
import { AI_LEVEL_LABEL, COLOR_LABEL, END_REASON_LABEL, GAME_LABEL, parseTimeControl, type MatchDetailDto } from '@cotuong/shared';
import { api, errorMessage } from '../api/http';
import { GameBoard, lastMoveOf } from '../components/Board';
import { Icon } from '../components/icons';
import { MoveList } from '../components/MoveList';
import { PlayerBar, capturedList } from '../components/PlayerBar';
import { formatDate } from '../components/ui';
import { useAuth } from '../state/auth';
import { useGameSelect } from '../state/game-select';
import {
  GameHead,
  GameScreen,
  PlayError,
  PlaySkeleton,
  StatusCard,
  endReasonText,
  resultLook,
  timeControlShort,
  timeControlTitle,
  type StatusTone,
} from './PlayPage';

/** Thời gian giữa hai nước khi tự động phát */
const AUTOPLAY_MS = 900;

export function ReplayPage() {
  const { matchId = '' } = useParams();
  const { me } = useAuth();
  const { game: selectedGame, setGame } = useGameSelect();
  const [detail, setDetail] = useState<MatchDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ply, setPly] = useState(0);
  const [flip, setFlip] = useState(false);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<MatchDetailDto>(`/api/matches/${encodeURIComponent(matchId)}`)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setPly(d.moves.length);
        setGame(d.game);
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [matchId, setGame]);

  // Cờ úp: ván đã kết thúc nên server trả chuỗi xếp quân — quân úp vẫn hiện úp cho tới nước nó được lật
  const build = (moves: string[]): GameEngine | null =>
    !detail ? null : detail.variant === 'jieqi' && detail.setup ? replayJieqi(detail.setup, moves) : replayGame(detail.game, moves);
  const full = useMemo(() => build(detail?.moves ?? []), [detail]);
  const view = useMemo(() => build(detail?.moves.slice(0, ply) ?? []), [detail, ply]);
  const fullInfos = useMemo(() => full?.historyInfo() ?? [], [full]);
  const total = detail?.moves.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') setPly((p) => Math.max(0, p - 1));
      else if (e.key === 'ArrowRight') setPly((p) => Math.min(total, p + 1));
      else if (e.key === 'Home') setPly(0);
      else if (e.key === 'End') setPly(total);
      else return;
      setAuto(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  // Mở trang: đưa bàn cờ lên đầu màn hình (router không tự cuộn về đầu khi chuyển trang)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [matchId]);

  // Tự động phát: mỗi AUTOPLAY_MS tiến một nước, dừng ở cuối ván
  useEffect(() => {
    if (!auto) return;
    if (ply >= total) {
      setAuto(false);
      return;
    }
    const id = window.setTimeout(() => setPly((p) => Math.min(total, p + 1)), AUTOPLAY_MS);
    return () => window.clearTimeout(id);
  }, [auto, ply, total]);

  if (error) {
    return (
      <PlayError icon="alert" title="Không tải được ván đấu" message={error}>
        <Link to="/" className="btn btn-ghost">
          <Icon name="home" size={18} />
          Về trang chủ
        </Link>
      </PlayError>
    );
  }
  if (!detail || !full || !view) return <PlaySkeleton game={selectedGame} label="Đang tải ván đấu…" />;

  const myColor: Color | null = detail.players[0]?.id === me?.id ? 0 : detail.players[1]?.id === me?.id ? 1 : null;
  const base: Color = myColor ?? 0;
  const bottom: Color = flip ? (base === 0 ? 1 : 0) : base;
  const winner = detail.result === 'p1' ? 0 : detail.result === 'p2' ? 1 : null;
  type Reason = keyof typeof END_REASON_LABEL;
  const knownReason = !!detail.endReason && detail.endReason in END_REASON_LABEL;
  // Người xem là người chơi của ván: lý do theo góc nhìn của họ ("Đối thủ đầu hàng", "Bạn hết giờ"…)
  const reason = !detail.endReason
    ? ''
    : knownReason && detail.result !== 'aborted'
      ? endReasonText(detail.game, { winner, reason: detail.endReason as Reason }, myColor, detail.mode === 'ai' ? 'Máy' : 'Đối thủ')
      : (END_REASON_LABEL[detail.endReason as Reason] ?? detail.endReason);
  const resultText =
    detail.result === 'aborted'
      ? 'Ván bị huỷ'
      : detail.result === 'draw'
        ? 'Hoà'
        : winner !== null
          ? `${COLOR_LABEL[detail.game][winner]} thắng`
          : '';
  const modeText =
    detail.mode === 'ai' ? 'Đấu với máy' : detail.ranked ? 'Ván xếp hạng' : detail.variant === 'jieqi' ? 'Không tính điểm hạng' : 'Phòng riêng';

  const go = (p: number) => {
    setAuto(false);
    setPly(Math.max(0, Math.min(total, p)));
  };
  const toggleAuto = () => {
    if (auto) {
      setAuto(false);
      return;
    }
    if (ply >= total) setPly(0);
    setAuto(true);
  };

  // Ô kết quả
  let tone: StatusTone = 'neutral';
  if (detail.result === 'draw') tone = 'draw';
  else if (winner !== null) tone = myColor === null ? 'win' : resultLook(winner, myColor).tone;
  const personal = myColor !== null && winner !== null ? (winner === myColor ? 'Bạn thắng' : 'Bạn thua') : null;

  const bar = (c: Color) => {
    const p = detail.players[c];
    // Ván với người mà thiếu người chơi: tài khoản đó đã bị xoá (tài khoản khách được dọn tự động) — không phải máy
    const gone = !p && detail.mode === 'pvp';
    const change = detail.ranked && detail.ratingChange !== null ? (c === 0 ? detail.ratingChange : (detail.ratingChange2 ?? -detail.ratingChange)) : null;
    return (
      <PlayerBar
        game={detail.game}
        color={c}
        name={p ? p.username : gone ? 'Người chơi đã rời' : `Máy (${detail.aiLevel ? AI_LEVEL_LABEL[detail.aiLevel] : '?'})`}
        avatarUrl={p?.avatarUrl}
        isBot={!p && !gone}
        gone={gone}
        isMe={c === myColor}
        active={view.turn() === c && ply < total}
        delta={change}
        winner={winner === c}
        captured={view instanceof JieqiGame ? capturedList(view.capturedPieces()[c === 0 ? 1 : 0]) : undefined}
      />
    );
  };

  return (
    <GameScreen
      game={detail.game}
      className="replay"
      ended
      head={
        <GameHead
          game={detail.game}
          title="Xem lại ván đấu"
          sub={
            <>
              {detail.variant === 'jieqi' ? 'Cờ úp' : GAME_LABEL[detail.game]} · {modeText} · {formatDate(detail.startedAt)}
            </>
          }
          tc={timeControlShort(parseTimeControl(detail.timeControl))}
          tcTitle={timeControlTitle(parseTimeControl(detail.timeControl))}
        />
      }
      top={bar(bottom === 0 ? 1 : 0)}
      bottom={bar(bottom)}
      board={<GameBoard engine={view} version={ply} orientation={bottom} movable={null} lastMove={lastMoveOf(view)} />}
      status={<StatusCard tone={tone} title={resultText || 'Ván đấu'} sub={[personal, reason].filter(Boolean).join(' · ') || undefined} />}
      toolbar={
        <div className="replay-wrap">
          <div className="replay-controls" role="toolbar" aria-label="Điều khiển xem lại">
            <button className="btn btn-ghost" onClick={() => go(0)} disabled={ply === 0} aria-label="Về thế ban đầu" title="Về thế ban đầu (phím Home)">
              <Icon name="chevron-first" size={20} />
            </button>
            <button className="btn btn-ghost" onClick={() => go(ply - 1)} disabled={ply === 0} aria-label="Lùi một nước" title="Lùi một nước (phím ←)">
              <Icon name="chevron-left" size={20} />
            </button>
            <button
              className={`btn ${auto ? 'btn-soft' : 'btn-primary'} rc-play`}
              onClick={toggleAuto}
              disabled={total === 0}
              aria-label={auto ? 'Dừng tự chạy' : 'Tự chạy từng nước'}
              aria-pressed={auto}
              title={auto ? 'Dừng tự chạy' : 'Tự chạy từng nước'}
            >
              <Icon name={auto ? 'pause' : 'play'} size={20} />
            </button>
            <button className="btn btn-ghost" onClick={() => go(ply + 1)} disabled={ply === total} aria-label="Tiến một nước" title="Tiến một nước (phím →)">
              <Icon name="chevron-right" size={20} />
            </button>
            <button className="btn btn-ghost" onClick={() => go(total)} disabled={ply === total} aria-label="Tới nước cuối" title="Tới nước cuối (phím End)">
              <Icon name="chevron-last" size={20} />
            </button>
          </div>
          <div className="replay-progress">
            <span className="rc-counter num" aria-live="polite" title={`Đang xem nước ${ply} trên tổng ${total} nước`}>
              {ply}/{total}
            </span>
            <input
              type="range"
              className="replay-scrub"
              min={0}
              max={total}
              value={ply}
              onChange={(e) => go(Number(e.target.value))}
              disabled={total === 0}
              aria-label="Kéo để chọn nước muốn xem"
            />
          </div>
        </div>
      }
      onFlip={() => setFlip((f) => !f)}
      tabs={[{ id: 'moves', label: 'Nước đi', icon: 'list', count: total, content: <MoveList moves={fullInfos} current={ply} onSelect={go} game={detail.game} jieqi={detail.variant === 'jieqi'} /> }]}
      sideFooter={
        <div className="replay-info">
          <div className="kbd-hint">
            <span>Phím tắt:</span>
            <kbd className="key">←</kbd>
            <kbd className="key">→</kbd>
            <span>chuyển nước ·</span>
            <kbd className="key">Home</kbd>
            <kbd className="key">End</kbd>
            <span>về đầu / cuối</span>
          </div>
          <div className="replay-links">
            <Link to="/" className="btn btn-ghost btn-sm">
              <Icon name="home" size={16} />
              Về trang chủ
            </Link>
            {me && (
              <Link to={`/profile/${me.id}`} className="btn btn-quiet btn-sm">
                <Icon name="history" size={16} />
                Lịch sử ván đấu
              </Link>
            )}
          </div>
        </div>
      }
    />
  );
}
