/**
 * Cấp quyền admin cho một tài khoản: npm run admin:promote -w @cotuong/server -- <email>
 * (Thêm --revoke để thu hồi.)
 */
import { PrismaClient } from '@prisma/client';
import { normalizeEmail } from '@cotuong/shared';
import { AppConfig } from '../config';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith('--'));
  const revoke = args.includes('--revoke');
  if (!email) {
    console.error('Cách dùng: npm run admin:promote -w @cotuong/server -- <email> [--revoke]');
    process.exit(1);
  }
  const cfg = new AppConfig();
  const prisma = new PrismaClient({ datasources: { db: { url: cfg.databaseUrl } } });
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (!user) {
      console.error(`Không tìm thấy tài khoản với email ${email}`);
      process.exitCode = 1;
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: revoke ? 'player' : 'admin' } });
    console.log(`${revoke ? 'Đã thu hồi' : 'Đã cấp'} quyền admin cho ${user.username} (${user.email})`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
