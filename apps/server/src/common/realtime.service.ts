import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@cotuong/shared';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
type Args<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>;

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  session: (sid: string) => `sess:${sid}`,
  match: (matchId: string) => `match:${matchId}`,
};

/**
 * Gửi sự kiện realtime. Nhờ Redis adapter, sự kiện tới được socket ở mọi instance server.
 */
@Injectable()
export class RealtimeService {
  private io: IoServer | null = null;

  setServer(io: IoServer): void {
    this.io = io;
  }

  toRoom<E extends keyof ServerToClientEvents>(room: string, event: E, ...args: Args<E>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.io?.to(room) as any)?.emit(event, ...args);
  }

  toUser<E extends keyof ServerToClientEvents>(userId: string, event: E, ...args: Args<E>): void {
    this.toRoom(rooms.user(userId), event, ...args);
  }

  toMatch<E extends keyof ServerToClientEvents>(matchId: string, event: E, ...args: Args<E>): void {
    this.toRoom(rooms.match(matchId), event, ...args);
  }

  /**
   * Gửi tới phòng ván VÀ mọi tab của các người chơi (socket thuộc nhiều phòng chỉ nhận một lần) — vd ván kết thúc khi
   * người chơi đang ở trang khác (tab đã rời phòng ván) thì tab đó vẫn biết để cập nhật "ván đang chơi"
   */
  toMatchAndPlayers<E extends keyof ServerToClientEvents>(matchId: string, userIds: string[], event: E, ...args: Args<E>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.io?.to([rooms.match(matchId), ...userIds.map(rooms.user)]) as any)?.emit(event, ...args);
  }

  /**
   * Socket `socketId` (ở bất kỳ instance nào) có trả lời "conn:probe" trong `timeoutMs` không. Socket không còn ở đâu
   * hoặc không trả lời kịp (kết nối treo nửa vời, instance treo) → false. Chưa có máy chủ realtime → true (không kết
   * luận được gì).
   */
  async socketResponds(socketId: string, timeoutMs: number): Promise<boolean> {
    if (!this.io) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replies = (await (this.io.timeout(timeoutMs).to(socketId) as any).emitWithAck('conn:probe')) as unknown[];
      return Array.isArray(replies) && replies.length > 0;
    } catch {
      return false;
    }
  }

  /** Ngắt một socket (ở bất kỳ instance nào) */
  disconnectSocket(socketId: string): void {
    this.io?.in(socketId).disconnectSockets(true);
  }

  broadcast<E extends keyof ServerToClientEvents>(event: E, ...args: Args<E>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.io as any)?.emit(event, ...args);
  }

  disconnectUser(userId: string): void {
    this.io?.in(rooms.user(userId)).disconnectSockets(true);
  }

  disconnectSession(sid: string): void {
    this.io?.in(rooms.session(sid)).disconnectSockets(true);
  }
}
