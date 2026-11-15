import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import type { GameType } from '@cotuong/game-core';
import {
  AVATAR_LIMITS,
  getTier,
  seasonLabel,
  type MatchSummaryDto,
  type Paginated,
  type PastSeasonDto,
  type ProfileDto,
  type ProfileGameDto,
} from '@cotuong/shared';
import type { Match, User } from '@prisma/client';
import { AppConfig } from '../config';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { GAMES, SeasonsService } from '../seasons/seasons.service';
import { isUuid } from '../common/ids';

const AVATAR_URL_RE = /^\/api\/avatars\/([0-9a-f-]{36})\/([0-9a-f]{16}\.webp)$/;
export const PAGE_SIZE = 20;

export function publicUser(u: Pick<User, 'id' | 'username' | 'avatarUrl'> & { isGuest?: boolean }) {
  return { id: u.id, username: u.username, avatarUrl: u.avatarUrl, ...(u.isGuest ? { isGuest: true } : {}) };
}

type MatchWithPlayers = Match & {
  player1: Pick<User, 'id' | 'username' | 'avatarUrl'> | null;
  player2: Pick<User, 'id' | 'username' | 'avatarUrl'> | null;
};

export function matchSummary(m: MatchWithPlayers, viewerId: string): MatchSummaryDto {
  const color = m.player1Id === viewerId ? 0 : 1;
  const opponent = color === 0 ? m.player2 : m.player1;
  let outcome: MatchSummaryDto['outcome'] = null;
  if (m.result === 'aborted') outcome = 'aborted';
  else if (m.result === 'draw') outcome = 'draw';
  else if (m.result) outcome = (m.result === 'p1') === (color === 0) ? 'win' : 'loss';
  return {
    id: m.id,
    game: m.game,
    mode: m.mode,
    ranked: m.ranked,
    aiLevel: (m.aiLevel as MatchSummaryDto['aiLevel']) ?? null,
    timeControl: m.timeControl,
    color,
    opponent: opponent ? publicUser(opponent) : null,
    outcome,
    endReason: m.endReason,
    ratingChange: m.ranked && m.ratingChange !== null ? (color === 0 ? m.ratingChange : (m.ratingChange2 ?? -m.ratingChange)) : null,
    moveCount: m.moves.length,
    startedAt: m.startedAt.toISOString(),
    endedAt: m.endedAt?.toISOString() ?? null,
    variant: m.variant === 'jieqi' ? 'jieqi' : 'standard',
  };
}

/** Số điểm ảnh tối đa của ảnh tải lên (trước khi thu nhỏ) */
const MAX_AVATAR_PIXELS = 4096 * 4096;

/** Nhận diện JPEG / PNG / WebP theo các byte đầu tệp */
function isJpegPngWebp(b: Buffer): boolean {
  if (b.length < 12) return false;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
  const webp = b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
  return jpeg || png || webp;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly seasons: SeasonsService,
    private readonly leaderboard: LeaderboardService,
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
  ) {}

  async profile(userId: string): Promise<ProfileDto> {
    if (!isUuid(userId)) throw new NotFoundException('Không tìm thấy người chơi');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // Khách (chưa đăng nhập) không có trang hồ sơ
    if (!user || user.isGuest) throw new NotFoundException('Không tìm thấy người chơi');
    const games: ProfileGameDto[] = [];
    for (const game of GAMES) games.push(await this.gameStats(user.id, game));
    return {
      user: { ...publicUser(user), createdAt: user.createdAt.toISOString(), role: user.role },
      games,
    };
  }

  private async gameStats(userId: string, game: GameType): Promise<ProfileGameDto> {
    const season = await this.seasons.current(game);
    const current = await this.prisma.rating.findUnique({ where: { userId_seasonId: { userId, seasonId: season.id } } });
    const standing = current ? await this.leaderboard.standingOf(season.id, userId) : null;
    const total = await this.prisma.rating.aggregate({
      where: { userId, season: { game } },
      _sum: { wins: true, losses: true, draws: true, gamesPlayed: true },
    });
    const past = await this.prisma.rating.findMany({
      where: { userId, gamesPlayed: { gt: 0 }, season: { game, status: 'closed' } },
      include: { season: true },
      orderBy: { season: { startAt: 'desc' } },
    });
    const tops = await this.prisma.seasonResult.findMany({ where: { userId, season: { game } } });
    const pastSeasons: PastSeasonDto[] = past.map((r) => {
      const peak = getTier(r.peakRating, this.cfg.tiers);
      const top = tops.find((t) => t.seasonId === r.seasonId);
      return {
        season: this.seasons.toDto(r.season),
        finalRank: r.finalRank,
        rating: r.rating,
        peakRating: r.peakRating,
        peakTier: peak.name,
        peakTierLevel: peak.level,
        topBadge: top ? `Top ${top.rank} – ${seasonLabel({ year: r.season.year, quarter: r.season.quarter as 1 | 2 | 3 | 4 })}` : null,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        gamesPlayed: r.gamesPlayed,
      };
    });
    const tier = current ? getTier(current.rating, this.cfg.tiers) : null;
    return {
      game,
      season: this.seasons.toDto(season),
      current:
        current && tier
          ? {
              rating: current.rating,
              peakRating: current.peakRating,
              tier: tier.name,
              tierLevel: tier.level,
              rank: standing?.rank ?? null,
              wins: current.wins,
              losses: current.losses,
              draws: current.draws,
              gamesPlayed: current.gamesPlayed,
            }
          : null,
      allTime: {
        wins: total._sum.wins ?? 0,
        losses: total._sum.losses ?? 0,
        draws: total._sum.draws ?? 0,
        gamesPlayed: total._sum.gamesPlayed ?? 0,
      },
      pastSeasons,
    };
  }

  async matches(userId: string, game: GameType, page: number): Promise<Paginated<MatchSummaryDto>> {
    const where = {
      game,
      endedAt: { not: null },
      OR: [{ player1Id: userId }, { player2Id: userId }],
    };
    const p = Math.max(1, Math.floor(page) || 1);
    const [total, rows] = await Promise.all([
      this.prisma.match.count({ where }),
      this.prisma.match.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (p - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          player1: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
          player2: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
        },
      }),
    ]);
    return { items: rows.map((m) => matchSummary(m, userId)), total, page: p, pageSize: PAGE_SIZE };
  }

  /** Nhận ảnh JPG/PNG/WebP ≤ 2 MB, cắt về ảnh vuông 256px (WebP) rồi lưu lên S3 */
  async setAvatar(user: User, file: { buffer: Buffer; size: number; mimetype: string } | undefined): Promise<string> {
    if (!this.storage.enabled) throw new BadRequestException('Hiện chưa đổi được ảnh đại diện. Bạn thử lại sau nhé.');
    if (!file?.buffer?.length) throw new BadRequestException('Chưa chọn ảnh');
    if (file.size > AVATAR_LIMITS.maxBytes) throw new BadRequestException('Ảnh tối đa 2 MB');
    if (!AVATAR_LIMITS.mimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Chỉ chấp nhận ảnh JPG, PNG hoặc WebP');
    }
    // Xử lý ảnh tốn CPU/bộ nhớ: tối đa 10 lần tải / giờ mỗi tài khoản
    if ((await this.redis.hit(`rl:avatar:${user.id}`, 3600)) > 10) {
      throw new HttpException('Bạn đổi ảnh quá nhiều lần, hãy thử lại sau', HttpStatus.TOO_MANY_REQUESTS);
    }
    let out: Buffer;
    try {
      // Kiểm tra "chữ ký" tệp TRƯỚC khi đưa cho sharp: chỉ JPEG/PNG/WebP mới tới bộ giải mã (SVG, HEIF… không chạm tới
      // các thư viện giải mã khác của libvips)
      if (!isJpegPngWebp(file.buffer)) throw new BadRequestException('Chỉ chấp nhận ảnh JPG, PNG hoặc WebP');
      const meta = await sharp(file.buffer).metadata();
      if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
        throw new BadRequestException('Chỉ chấp nhận ảnh JPG, PNG hoặc WebP');
      }
      // Ảnh nén nhỏ nhưng kích thước điểm ảnh rất lớn ("bom ảnh") → từ chối trước khi giải nén
      if (!meta.width || !meta.height || meta.width * meta.height > MAX_AVATAR_PIXELS) {
        throw new BadRequestException('Ảnh quá lớn. Bạn chọn ảnh nhỏ hơn (tối đa khoảng 4000 × 4000 điểm ảnh).');
      }
      out = await sharp(file.buffer, { limitInputPixels: MAX_AVATAR_PIXELS })
        .rotate()
        .resize(AVATAR_LIMITS.outputSize, AVATAR_LIMITS.outputSize, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toBuffer();
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Không đọc được ảnh');
    }
    const fileName = `${randomBytes(8).toString('hex')}.webp`;
    await this.storage.put(`avatars/${user.id}/${fileName}`, out, 'image/webp');
    const url = `/api/avatars/${user.id}/${fileName}`;
    await this.prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
    await this.removeAvatarObject(user.avatarUrl);
    await this.leaderboard.refreshUser(user.id);
    return url;
  }

  async removeAvatarObject(url: string | null): Promise<void> {
    const m = url ? AVATAR_URL_RE.exec(url) : null;
    if (m) await this.storage.remove(`avatars/${m[1]}/${m[2]}`);
  }

  /** Admin: xoá avatar không phù hợp, đưa về ảnh mặc định */
  async clearAvatar(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Không tìm thấy người chơi');
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    await this.removeAvatarObject(user.avatarUrl);
    await this.leaderboard.refreshUser(userId);
  }
}
