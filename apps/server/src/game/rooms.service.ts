import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import type { GameType } from '@cotuong/game-core';
import {
  ERROR_CODES,
  PRIVATE_ROOM_TTL_MS,
  START_RATING,
  validateCustomTimeControl,
  type GameVariant,
  type RoomDto,
  type TimeControl,
} from '@cotuong/shared';
import { GameError } from '../common/errors';
import { PresenceService } from '../common/presence.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { RatingsService } from '../seasons/ratings.service';
import { SeasonsService } from '../seasons/seasons.service';
import { LiveMatchService } from './live-match.service';

interface RoomState {
  code: string;
  game: GameType;
  tc: TimeControl;
  hostId: string;
  hostName: string;
  hostAvatar: string | null;
  hostIsGuest?: boolean;
  createdAt: number;
  /** Thiếu = 'standard' */
  variant?: GameVariant;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_GONE = 'Phòng này không còn nữa: có thể đã hết hạn, đã bị huỷ hoặc đã có người khác vào';
const K = {
  room: (code: string) => `room:${code}`,
  userRoom: (userId: string) => `u:room:${userId}`,
  queuedUser: (userId: string) => `mm:u:${userId}`,
};

export interface RoomUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  /** Khách (chưa đăng nhập) — phòng riêng không xếp hạng nên khách tạo / vào được */
  isGuest?: boolean;
}

/**
 * Phòng riêng: chủ phòng chọn thời gian tuỳ ý, gửi link/mã mời bạn; bên cầm quân ngẫu nhiên;
 * không tính điểm hạng; không có người xem.
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly redis: RedisService,
    private readonly live: LiveMatchService,
    private readonly realtime: RealtimeService,
    private readonly seasons: SeasonsService,
    private readonly ratings: RatingsService,
    private readonly presence: PresenceService,
  ) {}

  private toDto(r: RoomState): RoomDto {
    return {
      code: r.code,
      game: r.game,
      timeControl: r.tc,
      host: { id: r.hostId, username: r.hostName, ...(r.hostIsGuest ? { isGuest: true } : {}) },
      createdAt: r.createdAt,
      variant: r.variant ?? 'standard',
    };
  }

  static normalizeCode(code: unknown): string | null {
    if (typeof code !== 'string') return null;
    const c = code.trim().toUpperCase();
    return /^[A-Z0-9]{6}$/.test(c) ? c : null;
  }

  async create(user: RoomUser, game: GameType, minutes: number, incrementSec: number, variant: GameVariant = 'standard'): Promise<RoomDto> {
    const err = validateCustomTimeControl(minutes, incrementSec);
    if (err) throw new GameError(err);
    if (variant === 'jieqi' && game !== 'xiangqi') throw new GameError('Cờ úp chỉ dùng bàn cờ tướng');
    if (await this.live.activeMatchOf(user.id)) {
      throw new GameError('Bạn đang có một ván chưa kết thúc. Hãy vào lại ván đó trước.', ERROR_CODES.IN_MATCH);
    }
    if ((await this.redis.client.exists(K.queuedUser(user.id))) === 1) {
      throw new GameError('Bạn đang tìm đối thủ. Hãy bấm "Huỷ tìm" trước khi tạo phòng.');
    }
    // Mỗi người chỉ có một phòng chờ: phòng cũ (nếu có) bị huỷ — báo cho mọi tab để đường dẫn mời cũ không treo trên màn hình
    const old = await this.redis.client.get(K.userRoom(user.id));
    if (old && (await this.redis.client.del(K.room(old))) === 1) {
      this.realtime.toUser(user.id, 'room:closed', { code: old, reason: `Đã huỷ phòng cũ (mã ${old}) để tạo phòng mới` });
    }
    const ttlSec = Math.round(PRIVATE_ROOM_TTL_MS / 1000);
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
      const room: RoomState = {
        code,
        game,
        tc: { initialMs: minutes * 60_000, incrementMs: incrementSec * 1000 },
        hostId: user.id,
        hostName: user.username,
        hostAvatar: user.avatarUrl,
        ...(user.isGuest ? { hostIsGuest: true } : {}),
        createdAt: Date.now(),
        variant,
      };
      const ok = await this.redis.client.set(K.room(code), JSON.stringify(room), 'EX', ttlSec, 'NX');
      if (ok === 'OK') {
        await this.redis.client.set(K.userRoom(user.id), code, 'EX', ttlSec);
        return this.toDto(room);
      }
    }
    throw new GameError('Không tạo được phòng, vui lòng thử lại');
  }

  async info(code: unknown): Promise<RoomDto> {
    const c = RoomsService.normalizeCode(code);
    const room = c ? await this.redis.getJson<RoomState>(K.room(c)) : null;
    if (!room) throw new GameError(ROOM_GONE);
    return { ...this.toDto(room), hostOnline: await this.presence.isUserOnline(room.hostId) };
  }

  /**
   * Phòng đang chờ của chính người dùng (client gọi mỗi lần kết nối / kết nối lại để hiện lại thẻ phòng sau khi tải lại
   * trang). Con trỏ u:room trỏ tới phòng đã mất (hết hạn / đã có người vào) thì gỡ luôn.
   */
  async mine(userId: string): Promise<RoomDto | null> {
    const code = await this.redis.client.get(K.userRoom(userId));
    if (!code) return null;
    const room = await this.redis.getJson<RoomState>(K.room(code));
    if (!room || room.hostId !== userId) {
      await this.redis.delIfEquals(K.userRoom(userId), code);
      return null;
    }
    return this.toDto(room);
  }

  /** Người được mời vào phòng: tạo ván ngay */
  async join(user: RoomUser, code: unknown): Promise<string> {
    const c = RoomsService.normalizeCode(code);
    if (!c) throw new GameError('Mã phòng gồm 6 chữ hoặc số, bạn kiểm tra lại nhé');
    const room = await this.redis.getJson<RoomState>(K.room(c));
    if (!room) throw new GameError(ROOM_GONE);
    if (room.hostId === user.id) throw new GameError('Đây là phòng của bạn — hãy gửi mã hoặc đường dẫn mời cho bạn bè');
    if (await this.live.activeMatchOf(user.id)) {
      throw new GameError('Bạn đang có một ván chưa kết thúc. Hãy vào lại ván đó trước.', ERROR_CODES.IN_MATCH);
    }
    if ((await this.redis.client.exists(K.queuedUser(user.id))) === 1) {
      throw new GameError('Bạn đang tìm đối thủ. Hãy bấm "Huỷ tìm" trước khi vào phòng.');
    }
    // Chủ phòng không còn kết nối (đóng trang, mất mạng): không tạo ván — họ sẽ không biết ván đã bắt đầu và bị xử thua
    if (!(await this.presence.isUserOnline(room.hostId))) {
      throw new GameError(
        `${room.hostName} (chủ phòng) đang mất kết nối hoặc đã đóng trang web nên chưa vào ván được. Bạn chờ ít phút rồi thử lại nhé.`,
        ERROR_CODES.HOST_OFFLINE,
      );
    }
    // Giành phòng nguyên tử: chỉ một người vào được
    const claimed = await this.redis.client.getdel(K.room(c));
    if (!claimed) throw new GameError('Rất tiếc, vừa có người khác vào phòng này trước bạn');
    await this.redis.delIfEquals(K.userRoom(room.hostId), c);
    try {
      // Phòng riêng không tính điểm; điểm quý hiện tại chỉ để hiện cấp bậc cạnh tên người chơi
      const season = await this.seasons.current(room.game);
      const [hostRating, guestRating] = await Promise.all([
        this.ratings.find(room.hostId, season.id),
        this.ratings.find(user.id, season.id),
      ]);
      const match = await this.live.create({
        game: room.game,
        kind: 'private',
        players: [
          room.hostIsGuest
            ? { userId: room.hostId, username: room.hostName, avatarUrl: room.hostAvatar, rating: null, isGuest: true }
            : { userId: room.hostId, username: room.hostName, avatarUrl: room.hostAvatar, rating: hostRating?.rating ?? START_RATING },
          user.isGuest
            ? { userId: user.id, username: user.username, avatarUrl: user.avatarUrl, rating: null, isGuest: true }
            : { userId: user.id, username: user.username, avatarUrl: user.avatarUrl, rating: guestRating?.rating ?? START_RATING },
        ],
        timeControl: room.tc,
        seasonId: null,
        variant: room.variant ?? 'standard',
      });
      const found = { matchId: match.id, game: room.game, variant: room.variant ?? 'standard' };
      this.realtime.toUser(room.hostId, 'match:found', found);
      this.realtime.toUser(user.id, 'match:found', found);
      // Người vào phòng cũng đang có phòng chờ của riêng mình: huỷ luôn (không thì bạn của họ vào sau sẽ gặp lỗi)
      const own = await this.redis.client.get(K.userRoom(user.id));
      if (own && (await this.redis.client.del(K.room(own))) === 1) {
        await this.redis.delIfEquals(K.userRoom(user.id), own);
        this.realtime.toUser(user.id, 'room:closed', { code: own, reason: `Phòng chờ của bạn (mã ${own}) đã được huỷ vì bạn đã vào ván khác` });
      }
      return match.id;
    } catch (e) {
      this.realtime.toUser(room.hostId, 'room:closed', {
        code: c,
        reason: e instanceof GameError ? e.message : 'Không bắt đầu được ván, phòng đã đóng. Bạn hãy tạo phòng mới.',
      });
      throw e;
    }
  }

  async cancel(userId: string, code: unknown): Promise<void> {
    const c = RoomsService.normalizeCode(code);
    if (!c) return;
    const room = await this.redis.getJson<RoomState>(K.room(c));
    if (!room || room.hostId !== userId) return;
    await this.redis.client.del(K.room(c));
    await this.redis.delIfEquals(K.userRoom(userId), c);
    this.realtime.toUser(userId, 'room:closed', { code: c, reason: 'Đã huỷ phòng riêng' });
  }
}
