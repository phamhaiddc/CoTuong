import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config';
import { RedisService } from './redis.service';

const presKey = (userId: string) => `pres:${userId}`;
const instKey = (instanceId: string) => `inst:${instanceId}`;
/** Người thật đang kết nối vào instance này (làm mới theo nhịp tim) */
const onlineKey = (instanceId: string) => `onl:${instanceId}`;
/** Như onlineKey nhưng chỉ thành viên (có tài khoản, không tính khách) */
const memberKey = (instanceId: string) => `onlm:${instanceId}`;
/** Các instance từng ghi danh sách online (dọn instance chết khi đếm) */
const INSTANCES_KEY = 'onl:instances';
const HEARTBEAT_MS = 5_000;
const INSTANCE_TTL_MS = 15_000;
const ONLINE_CACHE_MS = 3_000;
/** Hạn của pres:<user> — được gia hạn ở mỗi nhịp tim khi còn kết nối */
const PRESENCE_TTL_SEC = 86_400;
/** Socket ảo của tài khoản máy (BotsService) — không tính là người online */
export const isBotSocket = (socketId: string) => socketId.startsWith('bot~');

/**
 * Theo dõi socket nào của người chơi đang kết nối, trên instance nào.
 * Mỗi instance gửi nhịp tim lên Redis; instance chết thì socket của nó coi như mất kết nối.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly cfg: AppConfig,
  ) {}

  get instanceId(): string {
    return this.cfg.instanceId;
  }

  onModuleInit(): void {
    void this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.redis.client.del(instKey(this.cfg.instanceId)).catch(() => undefined);
  }

  private async heartbeat(): Promise<void> {
    const id = this.cfg.instanceId;
    const humans = this.localHumans(false);
    const members = this.localHumans(true);
    const multi = this.redis.client.multi().set(instKey(id), '1', 'PX', INSTANCE_TTL_MS).del(onlineKey(id)).del(memberKey(id));
    if (humans.size) multi.sadd(onlineKey(id), ...humans).pexpire(onlineKey(id), INSTANCE_TTL_MS);
    if (members.size) multi.sadd(memberKey(id), ...members).pexpire(memberKey(id), INSTANCE_TTL_MS);
    // Gia hạn presence của mọi người/máy đang kết nối vào instance này: kết nối giữ quá 24 giờ không được coi là đã mất
    for (const uid of new Set(this.localSockets.values())) multi.expire(presKey(uid), PRESENCE_TTL_SEC);
    await multi.sadd(INSTANCES_KEY, id).exec().catch(() => undefined);
    // Dọn danh sách instance (không thì mỗi lần khởi động lại để thừa một mục) — khoảng mỗi phút một lần
    if (++this.beats % 12 === 0) await this.pruneInstances().catch(() => undefined);
  }

  private beats = 0;

  private async pruneInstances(): Promise<string[]> {
    const ids = await this.redis.client.smembers(INSTANCES_KEY);
    const alive: string[] = [];
    for (const id of ids) {
      if (await this.isInstanceAlive(id)) alive.push(id);
      else await this.redis.client.srem(INSTANCES_KEY, id);
    }
    return alive;
  }

  /** socketId → userId của mọi socket (người và socket ảo của máy) đang kết nối vào instance này */
  private readonly localSockets = new Map<string, string>();
  /** Các socket (trong localSockets) của phiên khách */
  private readonly guestSockets = new Set<string>();
  private onlineCache: { at: number; n: number } | null = null;
  private memberCache: { at: number; n: number } | null = null;

  /** `guest`: socket của phiên khách — vẫn là người online, nhưng không tính vào onlineMembers() */
  async add(userId: string, socketId: string, opts: { guest?: boolean } = {}): Promise<void> {
    this.localSockets.set(socketId, userId);
    if (opts.guest) this.guestSockets.add(socketId);
    else this.guestSockets.delete(socketId);
    await this.redis.client
      .multi()
      .hset(presKey(userId), socketId, this.cfg.instanceId)
      .expire(presKey(userId), PRESENCE_TTL_SEC)
      .exec();
  }

  async remove(userId: string, socketId: string): Promise<void> {
    this.localSockets.delete(socketId);
    this.guestSockets.delete(socketId);
    await this.redis.client.hdel(presKey(userId), socketId);
  }

  /** Người thật đang kết nối vào instance này (không tính socket ảo của máy); `membersOnly` = bỏ khách */
  private localHumans(membersOnly: boolean): Set<string> {
    const users = new Set<string>();
    for (const [sid, uid] of this.localSockets) {
      if (isBotSocket(sid) || (membersOnly && this.guestSockets.has(sid))) continue;
      users.add(uid);
    }
    return users;
  }

  /** Đếm người dùng khác nhau ở mọi instance còn sống: instance này theo dữ liệu tại chỗ, nơi khác theo tập ở Redis */
  private async countOnline(membersOnly: boolean): Promise<number> {
    const alive = await this.pruneInstances();
    // Instance này luôn tính theo dữ liệu tại chỗ (kể cả trước nhịp tim đầu tiên)
    const users = this.localHumans(membersOnly);
    const others = alive.filter((id) => id !== this.cfg.instanceId).map(membersOnly ? memberKey : onlineKey);
    if (others.length) for (const u of await this.redis.client.sunion(...others)) users.add(u);
    return users.size;
  }

  /**
   * Số người thật (không tính tài khoản máy, có tính khách) đang kết nối trên toàn hệ thống (mọi instance còn sống); một
   * người mở nhiều tab / thiết bị chỉ tính 1. Có độ trễ tối đa ~5 giây (nhịp tim) và được nhớ tạm 3 giây.
   */
  async onlineHumans(): Promise<number> {
    if (this.onlineCache && Date.now() - this.onlineCache.at < ONLINE_CACHE_MS) return this.onlineCache.n;
    const n = await this.countOnline(false);
    this.onlineCache = { at: Date.now(), n };
    return n;
  }

  /**
   * Như onlineHumans() nhưng chỉ thành viên (không tính khách): khách không bao giờ là đối thủ xếp hạng, nên không được
   * làm tắt việc ghép máy cho người chờ ở hàng xếp hạng.
   */
  async onlineMembers(): Promise<number> {
    if (this.memberCache && Date.now() - this.memberCache.at < ONLINE_CACHE_MS) return this.memberCache.n;
    const n = await this.countOnline(true);
    this.memberCache = { at: Date.now(), n };
    return n;
  }

  async isSocketAlive(userId: string, socketId: string): Promise<boolean> {
    const inst = await this.redis.client.hget(presKey(userId), socketId);
    if (!inst) return false;
    return this.isInstanceAlive(inst);
  }

  /** Người dùng còn ít nhất một socket đang kết nối (trên instance còn sống) không */
  async isUserOnline(userId: string): Promise<boolean> {
    const socks = await this.redis.client.hgetall(presKey(userId));
    for (const inst of new Set(Object.values(socks))) if (await this.isInstanceAlive(inst)) return true;
    return false;
  }

  /** Instance server còn gửi nhịp tim không */
  async isInstanceAlive(instanceId: string): Promise<boolean> {
    return (await this.redis.client.exists(instKey(instanceId))) === 1;
  }
}
