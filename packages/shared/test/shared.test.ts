import { describe, expect, it } from 'vitest';
import {
  compareStandings,
  daysLeft,
  decayedRating,
  eloDelta,
  lossMultiplier,
  nextWinStreak,
  rankedDelta,
  streakBonus,
  formatTimeControl,
  getTier,
  mailboxKey,
  matchmakingRange,
  parseTimeControl,
  quarterBounds,
  quarterOf,
  ratingAfter,
  START_RATING,
  tierChange,
  validateEmail,
  validatePassword,
  usernameKey,
  validateUsername,
} from '../src';

describe('Elo (K = 32)', () => {
  it('khớp ví dụ trong đặc tả', () => {
    expect(eloDelta(1200, 1200, 1)).toBe(16);
    expect(eloDelta(1200, 1400, 1)).toBe(24);
    expect(eloDelta(1400, 1200, 0)).toBe(-24);
  });

  it('khớp bảng cộng/trừ điểm', () => {
    // [chênh lệch của bạn so với đối thủ, thắng, hoà, thua]
    const table: Array<[number, number, number, number]> = [
      [-400, 29, 13, -3],
      [-200, 24, 8, -8],
      [0, 16, 0, -16],
      [200, 8, -8, -24],
      [400, 3, -13, -29],
    ];
    for (const [diff, w, d, l] of table) {
      const me = 1500 + diff;
      expect(eloDelta(me, 1500, 1)).toBe(w);
      expect(eloDelta(me, 1500, 0.5)).toBe(d);
      expect(eloDelta(me, 1500, 0)).toBe(l);
    }
  });

  it('không trả về -0', () => {
    expect(Object.is(eloDelta(1200, 1200, 0.5), 0)).toBe(true);
  });
});

describe('Cấp bậc', () => {
  it('đúng mốc điểm (đầu mùa 0 điểm = Tân thủ)', () => {
    expect(getTier(START_RATING).name).toBe('Tân thủ');
    expect(getTier(0).name).toBe('Tân thủ');
    expect(getTier(99).name).toBe('Tân thủ');
    expect(getTier(100).name).toBe('Sơ cấp');
    expect(getTier(200).name).toBe('Trung cấp');
    expect(getTier(350).name).toBe('Cao cấp');
    expect(getTier(500).name).toBe('Cao thủ');
    expect(getTier(699).name).toBe('Cao thủ');
    expect(getTier(700).name).toBe('Đại cao thủ');
    expect(getTier(900).name).toBe('Kỳ vương');
    expect(getTier(0).level).toBe(0);
    expect(getTier(2500).level).toBe(6);
  });

  it('thăng / xuống cấp', () => {
    expect(tierChange(95, 111)).toBe('promoted');
    expect(tierChange(205, 190)).toBe('demoted');
    expect(tierChange(250, 266)).toBeNull();
  });
});

describe('Sàn điểm 0', () => {
  it('đầu mùa 0 điểm, thua vẫn giữ 0, thắng nhận đủ', () => {
    expect(START_RATING).toBe(0);
    const elo = eloDelta(START_RATING, START_RATING, 1);
    expect(elo).toBe(16);
    expect(ratingAfter(START_RATING, elo)).toBe(16);
    expect(ratingAfter(START_RATING, -elo)).toBe(0);
    expect(ratingAfter(10, -16)).toBe(0);
    expect(ratingAfter(40, -16)).toBe(24);
  });
});

describe('Mùa giải theo quý (GMT+7)', () => {
  it('00:00 GMT+7 ngày 1/4 đã sang Q2', () => {
    // 2026-03-31T17:00:00Z = 2026-04-01 00:00 GMT+7
    expect(quarterOf(Date.parse('2026-03-31T16:59:59Z'))).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf(Date.parse('2026-03-31T17:00:00Z'))).toEqual({ year: 2026, quarter: 2 });
  });

  it('mốc quý', () => {
    const { startAt, endAt } = quarterBounds({ year: 2026, quarter: 4 });
    expect(startAt.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(endAt.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  it('số ngày còn lại', () => {
    expect(daysLeft('2026-12-31T17:00:00Z', Date.parse('2026-12-30T17:00:00Z'))).toBe(1);
    expect(daysLeft('2026-12-31T17:00:00Z', Date.parse('2026-12-30T17:00:01Z'))).toBe(1);
    expect(daysLeft('2026-12-31T17:00:00Z', Date.parse('2027-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('Ghép trận', () => {
  it('±100, mỗi 10 giây +50, tối đa ±400', () => {
    expect(matchmakingRange(0)).toBe(100);
    expect(matchmakingRange(9_999)).toBe(100);
    expect(matchmakingRange(10_000)).toBe(150);
    expect(matchmakingRange(60_000)).toBe(400);
    expect(matchmakingRange(600_000)).toBe(400);
  });
});

describe('Xếp thứ hạng khi bằng điểm', () => {
  it('ưu tiên: điểm, số ván thắng, tỉ lệ thắng, đạt điểm sớm hơn', () => {
    const base = { rating: 1500, wins: 10, gamesPlayed: 20, ratingUpdatedAt: 1000 };
    expect(compareStandings({ ...base, rating: 1510 }, base)).toBeLessThan(0);
    expect(compareStandings({ ...base, wins: 11 }, base)).toBeLessThan(0);
    expect(compareStandings({ ...base, gamesPlayed: 15 }, base)).toBeLessThan(0);
    expect(compareStandings({ ...base, ratingUpdatedAt: 500 }, base)).toBeLessThan(0);
    expect(compareStandings(base, { ...base })).toBe(0);
  });
});

describe('Kiểm tra dữ liệu', () => {
  it('tên hiển thị', () => {
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('Nhật Hải')).toBeNull();
    expect(validateUsername('player_01')).toBeNull();
    expect(validateUsername('bad<script>')).not.toBeNull();
  });
  it('email và mật khẩu', () => {
    expect(validateEmail('a@b.vn')).toBeNull();
    expect(validateEmail('nope')).not.toBeNull();
    expect(validatePassword('1234567')).not.toBeNull();
    expect(validatePassword('12345678')).toBeNull();
  });
  it('khoá hộp thư cho giới hạn gửi thư (gộp biến thể +nhãn, dấu chấm Gmail)', () => {
    expect(mailboxKey(' Ban+abc@Example.VN ')).toBe('ban@example.vn');
    expect(mailboxKey('ban+1@test.local')).toBe(mailboxKey('ban+2@test.local'));
    expect(mailboxKey('N.g.u.y.e.n+x@gmail.com')).toBe('nguyen@gmail.com');
    expect(mailboxKey('nguyen@googlemail.com')).toBe('nguyen@gmail.com');
    // Ngoài Gmail giữ nguyên dấu chấm; '+' ở đầu không phải nhãn
    expect(mailboxKey('a.b@outlook.com')).toBe('a.b@outlook.com');
    expect(mailboxKey('+abc@x.vn')).toBe('+abc@x.vn');
  });
  it('thời gian ván', () => {
    expect(formatTimeControl({ initialMs: 900_000, incrementMs: 10_000 })).toBe('15+10');
    expect(parseTimeControl('15+10')).toEqual({ initialMs: 900_000, incrementMs: 10_000 });
    expect(formatTimeControl(null)).toBe('Không giới hạn');
  });
});

describe('Tên hiển thị: chặn tên vô hình / giả mạo', () => {
  it('nhận tiếng Việt, chữ Hán, số', () => {
    expect(validateUsername('Nguyễn Văn An')).toBeNull();
    expect(validateUsername('将军123')).toBeNull();
    expect(validateUsername('Đặng Ơ Ư')).toBeNull();
  });
  it('chặn ký tự vô hình và chữ Kirin trông như Latin', () => {
    expect(validateUsername('ㅤㅤㅤ')).not.toBeNull();
    expect(validateUsername('ﾠﾠﾠ')).not.toBeNull();
    expect(validateUsername('ab​c')).not.toBeNull();
    expect(validateUsername('аdmin')).not.toBeNull();
    // chữ Latin "lạ" trông như chữ thường
    for (const n of ['haıdang.dn', 'hɑidang.dn', 'haidanɡ.dn', 'ʜaidang.dn', 'haidang.dnǀ']) expect(validateUsername(n)).not.toBeNull();
  });
  it('chữ toàn khổ trùng khoá với chữ thường (không chiếm được tên của người khác)', () => {
    expect(usernameKey('ａdmin')).toBe(usernameKey('Admin'));
  });
});

describe('Luật giúp người đến sau leo hạng', () => {
  const base = { opponent: 0, gamesPlayed: 10, winStreak: 0 } as const;
  it('5 ván đầu mùa: điểm cộng ×1,5; điểm trừ không nhân', () => {
    expect(rankedDelta({ ...base, rating: 0, score: 1, gamesPlayed: 0 }).delta).toBe(24);
    expect(rankedDelta({ ...base, rating: 0, score: 1, gamesPlayed: 4 }).placement).toBe(true);
    expect(rankedDelta({ ...base, rating: 0, score: 1, gamesPlayed: 5 }).delta).toBe(16);
    expect(rankedDelta({ ...base, rating: 0, score: 0, gamesPlayed: 0 }).delta).toBe(-16);
  });
  it('thua: hệ số theo cấp bậc (Tân thủ, Sơ cấp ×1; Trung cấp ×1,1 … Kỳ vương ×1,5)', () => {
    expect(lossMultiplier(0)).toBe(1);
    expect(lossMultiplier(150)).toBe(1);
    expect(lossMultiplier(250)).toBe(1.1);
    expect(lossMultiplier(400)).toBe(1.2);
    expect(lossMultiplier(600)).toBe(1.3);
    expect(lossMultiplier(800)).toBe(1.4);
    expect(lossMultiplier(950)).toBe(1.5);
    // Kỳ vương thua người ngang điểm: -16 × 1,5 = -24; thắng vẫn +16
    expect(rankedDelta({ ...base, rating: 950, opponent: 950, score: 0 }).delta).toBe(-24);
    expect(rankedDelta({ ...base, rating: 950, opponent: 950, score: 1 }).delta).toBe(16);
  });
  it('chuỗi thắng: ván thứ 3 +3, từ ván thứ 4 +6; thua / hoà mất chuỗi', () => {
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(1)).toBe(0);
    expect(streakBonus(2)).toBe(3);
    expect(streakBonus(3)).toBe(6);
    expect(streakBonus(10)).toBe(6);
    expect(rankedDelta({ ...base, rating: 100, opponent: 100, score: 1, winStreak: 2 }).delta).toBe(19);
    expect(rankedDelta({ ...base, rating: 100, opponent: 100, score: 0.5, winStreak: 5 }).streakBonus).toBe(0);
    expect(nextWinStreak(4, 1)).toBe(5);
    expect(nextWinStreak(4, 0.5)).toBe(0);
    expect(nextWinStreak(4, 0)).toBe(0);
  });
  it('không chơi thì tụt: -5/ngày từ 350 điểm, không dưới mốc cấp bậc hiện tại', () => {
    expect(decayedRating(349)).toBe(349);
    expect(decayedRating(360)).toBe(355);
    expect(decayedRating(352)).toBe(350);
    expect(decayedRating(350)).toBe(350);
    expect(decayedRating(903)).toBe(900);
    expect(decayedRating(1000)).toBe(995);
  });
});
