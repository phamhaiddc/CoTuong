import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameType } from '@cotuong/game-core';
import { ERROR_CODES, PRIVATE_ROOM_TTL_MS, type GameVariant, type QueueStatusDto, type RoomDto } from '@cotuong/shared';
import { emit, socket } from '../api/socket';
import { useAuth } from './auth';
import { useToast } from './toast';

interface QueueState extends QueueStatusDto {
  /** Thời điểm (giờ máy) bắt đầu tìm, để hiển thị đồng hồ chờ */
  since: number;
}

interface RealtimeValue {
  connected: boolean;
  queue: QueueState | null;
  /** variant 'jieqi' = hàng chờ Cờ úp (ghép thường, không tính điểm) */
  joinQueue: (game: GameType, variant?: GameVariant) => Promise<boolean>;
  leaveQueue: () => Promise<void>;
  room: RoomDto | null;
  setRoom: (r: RoomDto | null) => void;
  /** Huỷ phòng riêng đang chờ của mình */
  cancelRoom: () => Promise<void>;
  /** Tăng mỗi khi Top 10 của game thay đổi (để thẻ Top 10 ở trang chủ tải lại) */
  lbVersion: Record<GameType, number>;
}

const Ctx = createContext<RealtimeValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { player, refresh } = useAuth();
  const playerId = player?.id ?? null;
  const [connected, setConnected] = useState(socket.connected);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [lbVersion, setLbVersion] = useState<Record<GameType, number>>({ xiangqi: 0, chess: 0 });

  // Giá trị mới nhất cho các handler socket (đăng ký một lần)
  const roomRef = useRef(room);
  roomRef.current = room;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  /** Lúc mất kết nối đang chờ ván (tìm đối thủ / phòng riêng chờ bạn bè) — khi kết nối lại cần kiểm tra ván đã bắt đầu chưa */
  const waitingRef = useRef<{ queue: boolean; room: RoomDto | null; playerId: string | null } | null>(null);
  const everConnected = useRef(socket.connected);
  const playerIdRef = useRef(playerId);
  playerIdRef.current = playerId;
  const activeMatchRef = useRef(player?.activeMatchId ?? null);
  activeMatchRef.current = player?.activeMatchId ?? null;
  /**
   * Tăng mỗi khi trang tự đặt phòng (tạo / huỷ / vào ván…): câu trả lời room:mine gửi đi trước đó đã cũ, không được
   * ghi đè (vd. vừa vào với tư cách khách: socket kết nối lại hỏi room:mine cùng lúc với lệnh tạo phòng).
   */
  const roomVer = useRef(0);
  const setRoomNow = useCallback((r: RoomDto | null | ((cur: RoomDto | null) => RoomDto | null)) => {
    roomVer.current++;
    setRoom(r);
  }, []);

  /**
   * Đồng bộ phòng riêng đang chờ với máy chủ (sau khi tải lại trang / kết nối lại / phòng hết hạn).
   * Trả về phòng hiện tại, hoặc undefined nếu không hỏi được (chưa đăng nhập, mất kết nối).
   */
  const syncRoom = useCallback(async (): Promise<RoomDto | null | undefined> => {
    const at = roomVer.current;
    const r = await emit('room:mine', {});
    // Trong lúc chờ, trang đã tự đặt phòng (tạo / huỷ…): câu trả lời đã cũ → bỏ qua, coi như không hỏi được
    if (!r.ok || at !== roomVer.current) return undefined;
    setRoom(r.room);
    return r.room;
  }, []);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      const reconnect = everConnected.current;
      everConnected.current = true;
      const waiting = waitingRef.current;
      waitingRef.current = null;
      void (async () => {
        const current = await syncRoom();
        if (!reconnect) return;
        // Kết nối lại: tải lại thông tin tài khoản (ván đang chơi) — sự kiện "đã tìm thấy đối thủ" có thể đã bị lỡ
        const u = await refresh();
        // Đổi danh tính (khách vừa đăng nhập tài khoản…): hàng chờ / phòng cũ là của danh tính trước, không báo gì
        if (!waiting || !u || u.id !== waiting.playerId) return;
        if (u?.activeMatchId) {
          // Đang chờ ván thì ván đã bắt đầu trong lúc mất kết nối: vào thẳng bàn cờ
          setQueue(null);
          setRoomNow(null);
          toast('Ván đấu của bạn đã bắt đầu trong lúc mất kết nối — vào bàn cờ ngay!', 'info');
          navigate(`/play/${u.activeMatchId}`);
          return;
        }
        if (waiting.room && current === null) {
          toast(`Phòng riêng ${waiting.room.code} đã đóng trong lúc bạn mất kết nối.`, 'info');
        } else if (waiting.queue) {
          toast('Kết nối bị gián đoạn nên việc tìm đối thủ đã dừng. Bạn hãy bấm tìm lại.', 'warn');
        }
      })();
    };
    const onDisconnect = () => {
      setConnected(false);
      if (queueRef.current || roomRef.current) {
        waitingRef.current = { queue: !!queueRef.current, room: roomRef.current, playerId: playerIdRef.current };
      }
      // Server tự đưa người chơi ra khỏi hàng chờ khi socket ngắt
      setQueue(null);
    };
    const onFound = (p: { matchId: string }) => {
      setQueue(null);
      setRoomNow(null);
      void refresh();
      navigate(`/play/${p.matchId}`);
    };
    const onQueue = (s: QueueStatusDto) => {
      setQueue(s.searching ? { ...s, since: Date.now() - s.waitedMs } : null);
    };
    const onLb = (p: { game: GameType }) => setLbVersion((v) => ({ ...v, [p.game]: v[p.game] + 1 }));
    const onRoomClosed = (p: { code: string; reason: string }) => {
      setRoomNow((r) => (r && r.code === p.code ? null : r));
      toast(p.reason, 'info');
    };
    // Ván dở của mình kết thúc trong lúc tab này ở trang khác (nếu máy chủ báo tới tab này): tải lại thông tin để banner
    // "quay lại ván" và nút "Vào lại ván" không treo. Trang bàn cờ của ván đó tự tải lại khi nhận tin này.
    const onMatchEnded = (e: { matchId: string }) => {
      if (e.matchId !== activeMatchRef.current || window.location.pathname === `/play/${e.matchId}`) return;
      void refresh();
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('match:found', onFound);
    socket.on('queue:status', onQueue);
    socket.on('leaderboard:changed', onLb);
    socket.on('room:closed', onRoomClosed);
    socket.on('match:ended', onMatchEnded);
    return () => {
      socket.off('match:ended', onMatchEnded);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('match:found', onFound);
      socket.off('queue:status', onQueue);
      socket.off('leaderboard:changed', onLb);
      socket.off('room:closed', onRoomClosed);
    };
  }, [navigate, refresh, toast, syncRoom, setRoomNow]);

  // Socket đã kết nối trước khi provider gắn handler: vẫn lấy lại phòng đang chờ (chỉ một lần khi mở trang)
  useEffect(() => {
    if (socket.connected) void syncRoom();
  }, [syncRoom]);

  // Không còn danh tính để chơi (đăng xuất…) hoặc đổi sang danh tính khác (khách → đăng nhập tài khoản): xoá trạng thái
  // tìm trận / phòng của danh tính cũ (máy chủ bỏ chúng khi socket kết nối lại). Lần đầu biết danh tính (mở trang) thì
  // giữ nguyên: phòng vừa lấy lại bằng room:mine là của chính người này.
  const prevPlayerId = useRef(playerId);
  useEffect(() => {
    const prev = prevPlayerId.current;
    prevPlayerId.current = playerId;
    if (!playerId || (prev && prev !== playerId)) {
      setQueue(null);
      // Không tăng roomVer: lần hỏi room:mine sau khi socket kết nối lại (bằng phiên mới) vẫn phải được ghi
      setRoom(null);
    }
  }, [playerId]);

  // Phòng riêng tự huỷ sau PRIVATE_ROOM_TTL_MS: tới hạn thì hỏi lại máy chủ để thẻ phòng không treo trên màn hình
  useEffect(() => {
    if (!room) return;
    const left = room.createdAt + PRIVATE_ROOM_TTL_MS - Date.now();
    // Đồng hồ máy lệch với máy chủ thì phòng có thể còn sau "hạn": hỏi lại thưa (30 giây) thay vì liên tục
    const t = window.setTimeout(
      () => {
        void syncRoom().then((r) => {
          if (r === null) toast(`Phòng riêng ${room.code} đã hết hạn sau ${PRIVATE_ROOM_TTL_MS / 60_000} phút. Bạn có thể tạo phòng mới.`, 'info');
        });
      },
      left > 0 ? left + 2_000 : 30_000,
    );
    return () => window.clearTimeout(t);
  }, [room, syncRoom, toast]);

  const joinQueue = useCallback(
    async (game: GameType, variant: GameVariant = 'standard') => {
      const r = await emit('queue:join', { game, variant });
      if (!r.ok) {
        toast(r.error, 'error');
        // Phòng riêng mở ở tab khác / trước khi tải lại trang: hiện lại thẻ phòng để bạn huỷ được
        if (r.code === ERROR_CODES.HAS_ROOM) void syncRoom();
        if (r.code === ERROR_CODES.IN_MATCH) void refresh();
        return false;
      }
      setQueue({ ...r.status, since: Date.now() - r.status.waitedMs });
      return true;
    },
    [toast, syncRoom, refresh],
  );

  const leaveQueue = useCallback(async () => {
    await emit('queue:leave', {});
    setQueue(null);
  }, []);

  const cancelRoom = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const res = await emit('room:cancel', { code: r.code });
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setRoomNow((cur) => (cur && cur.code === r.code ? null : cur));
  }, [toast, setRoomNow]);

  const value = useMemo(
    () => ({ connected, queue, joinQueue, leaveQueue, room, setRoom: setRoomNow, cancelRoom, lbVersion }),
    [connected, queue, joinQueue, leaveQueue, room, setRoomNow, cancelRoom, lbVersion],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRealtime phải dùng trong RealtimeProvider');
  return ctx;
}
