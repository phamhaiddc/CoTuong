/**
 * Tạo / cập nhật 14 tài khoản máy chơi (7 cờ tướng + 7 cờ vua): npm run bots:seed -w @cotuong/server
 *
 * Máy chơi được ghép với người chờ lâu ở hàng chờ xếp hạng (xem BOT_FALLBACK_SEC trong .env.example).
 * Chạy lại nhiều lần không tạo trùng: nhận diện theo email botNN@bots.invalid (tên miền .invalid không bao giờ nhận
 * thư, và server không cho người dùng đăng ký bằng tên miền này); tài khoản máy đã có thì chỉ sửa lại mức / xác thực
 * email, giữ nguyên tên và mật khẩu. Email đó mà đang là tài khoản NGƯỜI thì báo lỗi và bỏ qua (không bao giờ đổi
 * người thành máy).
 * Mật khẩu là chuỗi ngẫu nhiên không ai biết, và server từ chối mọi kiểu đăng nhập của tài khoản máy.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'crypto';
import { AI_LEVEL_LABEL, normalizeUsername, usernameKey, validateUsername, type AiLevel } from '@cotuong/shared';
import { AppConfig } from '../config';
import { BOT_ROSTER, botEmail, botGameOfEmail } from '../bots/bot-accounts';

/** Danh sách máy (tên, loại cờ, mức): bots/bot-accounts.ts — dùng chung với server */
const BOTS = BOT_ROSTER;

const DAY = 86_400_000;

async function freeUsername(prisma: PrismaClient, wanted: string): Promise<string> {
  const base = normalizeUsername(wanted);
  for (let i = 0; i < 30; i++) {
    const sfx = String(randomInt(10, 1000));
    const name = i === 0 ? base : `${base.slice(0, 19 - sfx.length).trim()} ${sfx}`;
    if (validateUsername(name)) continue;
    if (!(await prisma.user.findUnique({ where: { usernameKey: usernameKey(name) } }))) return name;
  }
  throw new Error(`Không tìm được tên trống cho "${wanted}"`);
}

async function main(): Promise<void> {
  for (const b of BOTS) {
    const err = validateUsername(b.username);
    if (err) throw new Error(`Tên "${b.username}" không hợp lệ: ${err}`);
  }
  const cfg = new AppConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: cfg.databaseUrl } } });
  try {
    for (const b of BOTS) {
      const email = botEmail(b.n);
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && !existing.isBot) {
        // Không bao giờ biến tài khoản người thật thành máy (vd ai đó đã đăng ký trước bằng email này)
        console.error(`LỖI: ${email} đang là tài khoản người chơi (${existing.username}), không đổi thành máy — bỏ qua`);
        process.exitCode = 1;
        continue;
      }
      if (existing) {
        const needs = existing.botLevel !== b.level || existing.role !== 'player' || existing.emailVerifiedAt === null;
        if (needs) {
          await prisma.user.update({
            where: { id: existing.id },
            data: { botLevel: b.level, role: 'player', emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
          });
          console.log(`Đã cập nhật ${existing.username} (${email}) → mức ${AI_LEVEL_LABEL[b.level]}`);
        } else {
          console.log(`Đã có ${existing.username} (${email}), mức ${AI_LEVEL_LABEL[b.level]}`);
        }
        continue;
      }
      const username = await freeUsername(prisma, b.username);
      // Ngày tham gia rải trong ~3 tháng gần đây để hồ sơ trông như người chơi bình thường
      const createdAt = new Date(Date.now() - randomInt(3, 90) * DAY - randomInt(0, DAY));
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
      await prisma.user.create({
        data: {
          username,
          usernameKey: usernameKey(username),
          email,
          passwordHash,
          role: 'player',
          isBot: true,
          botLevel: b.level,
          createdAt,
          emailVerifiedAt: new Date(createdAt.getTime() + randomInt(60_000, 30 * 60_000)),
        },
      });
      console.log(`Đã tạo ${username} (${email}), mức ${AI_LEVEL_LABEL[b.level]}${username !== b.username ? ` — tên "${b.username}" đã có người dùng` : ''}`);
    }
    const all = await prisma.user.findMany({ where: { isBot: true }, orderBy: { email: 'asc' } });
    const GAME_NAME = { xiangqi: 'Cờ tướng', chess: 'Cờ vua' } as const;
    for (const g of ['xiangqi', 'chess'] as const) {
      const list = all.filter((u) => botGameOfEmail(u.email) === g);
      const count = (l: AiLevel) => list.filter((u) => u.botLevel === l).length;
      console.log(`\n${GAME_NAME[g]}: ${list.length} máy — Trung bình ${count('medium')}, Khó ${count('hard')}`);
      for (const u of list) {
        const lv = u.botLevel as AiLevel | null;
        console.log(`  ${u.email.padEnd(22)} ${u.username.padEnd(20)} ${lv ? AI_LEVEL_LABEL[lv] : '?'}${u.isBanned ? ' (bị khoá)' : ''}`);
      }
    }
    const orphan = all.filter((u) => !botGameOfEmail(u.email));
    if (orphan.length) {
      console.log(`\nCảnh báo: ${orphan.length} tài khoản máy không có trong danh sách (không được ghép trận): ${orphan.map((u) => u.email).join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
