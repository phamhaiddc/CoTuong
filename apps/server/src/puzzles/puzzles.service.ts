import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, type PuzzleProgress } from '@prisma/client';
import { otherColor, replayGame, type Color, type GameEngine } from '@cotuong/game-core';
import {
  getPuzzle,
  puzzleMoveCount,
  PUZZLE_LIMITS,
  type PuzzleAttemptResultDto,
  type PuzzleProgressDto,
  type PuzzleProgressResponse,
} from '@cotuong/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';

/** Nước đi ICCS chữ thường, ví dụ "h2e2" */
const MOVE_RE = /^[a-i][0-9][a-i][0-9]$/;

function toDto(row: PuzzleProgress): PuzzleProgressDto {
  return {
    puzzleId: row.puzzleId,
    attempts: row.attempts,
    solvedAt: row.solvedAt ? row.solvedAt.toISOString() : null,
    bestMoves: row.bestMoves,
  };
}

/**
 * Nước đỡ của bên phòng thủ (Đen) có giống cách trang Cờ thế đỡ không. Đen do máy cầm nhưng chạy trong trình duyệt,
 * nên server không tin các nước Đen được gửi lên (tự chọn nước Đen "chịu thua" thì thế nào cũng giải được rất nhanh):
 *  1) Thế đã chứng minh, ván còn nằm trên đường giải: trang luôn cho Đen đi đúng nước đỡ trong lời giải → bắt buộc.
 *  2) Nước cuối cùng của Đen không được tự đưa vào thế thua ngay (để Đỏ thắng ở nước kế tiếp) trong khi Đen còn nước
 *     khác tránh được — máy đỡ ở mức Khó luôn thấy và tránh nước như vậy.
 * Không kiểm được hết: các nước Đen trước đó (ra khỏi đường giải) vẫn do trình duyệt chọn, nên tiến độ cờ thế vẫn là số
 * liệu riêng của người chơi (không dùng cho xếp hạng).
 * `engine` đang ở cuối ván (đã đi hết `moves`); hàm trả engine về đúng trạng thái đó.
 */
export function defenceLooksReal(
  engine: GameEngine,
  moves: readonly string[],
  attacker: Color,
  solution: readonly string[] | undefined,
): boolean {
  // (1) Đường giải đã lưu: Đỏ và Đen xen kẽ, nước Đen ở vị trí lẻ
  if (solution?.length) {
    for (let i = 1; i < moves.length && i < solution.length; i += 2) {
      if (moves[i - 1] !== solution[i - 1]) break; // Đỏ đã rời đường giải: từ đây Đen do AI chọn
      if (moves[i] !== solution[i]) return false;
    }
  }
  // (2) Nước cuối của Đen (vị trí lẻ lớn nhất)
  const last = moves.length % 2 === 0 ? moves.length - 1 : moves.length - 2;
  if (last < 1) return true;
  const back = moves.length - last;
  const undone: string[] = [];
  for (let i = 0; i < back; i++) undone.unshift(engine.undo()!);
  try {
    // Nước Đen lặp lại thế cũ: máy chấm nước lặp như hoà nên có thể đi vào nước để thua ngay — không xét (tránh bắt nhầm)
    engine.play(moves[last]);
    const repeated = engine.warnings().some((w) => w.type === 'repetition');
    engine.undo();
    if (repeated) return true;
    for (const alt of engine.legalMoves()) {
      if (alt === moves[last]) continue;
      engine.play(alt);
      try {
        const st = engine.status();
        if (st.over) {
          if (st.result.winner !== attacker) return false; // nước này không thua ngay (Đen thắng / hoà)
          continue;
        }
        let losesNow = false;
        for (const reply of engine.legalMoves()) {
          engine.play(reply);
          const s2 = engine.status();
          engine.undo();
          if (s2.over && s2.result.winner === attacker) {
            losesNow = true;
            break;
          }
        }
        if (!losesNow) return false; // Đen còn nước tránh được thua ngay mà lại không đi
      } finally {
        engine.undo();
      }
    }
    return true;
  } finally {
    for (const m of undone) engine.play(m);
  }
}

/**
 * Tiến độ giải cờ thế. Kết quả "đã giải" do server quyết định: đi lại các nước từ FEN của thế bằng game-core, chỉ ghi
 * nhận khi ván kết thúc với bên đi trước thắng VÀ nước đỡ của Đen giống cách trang đỡ (defenceLooksReal). Các nước Đen
 * vẫn do trình duyệt gửi nên đây là tiến độ cá nhân, không phải kết quả đã được chứng thực hoàn toàn.
 */
@Injectable()
export class PuzzlesService {
  constructor(private readonly moduleRef: ModuleRef) {}

  // Prisma / Redis là provider của AppModule: lấy đúng thể hiện dùng chung (xem giải thích ở puzzles-auth.guard.ts)
  private get prisma(): PrismaService {
    return this.moduleRef.get(PrismaService, { strict: false });
  }

  private get redis(): RedisService {
    return this.moduleRef.get(RedisService, { strict: false });
  }

  async progress(userId: string): Promise<PuzzleProgressResponse> {
    const rows = await this.prisma.puzzleProgress.findMany({ where: { userId }, orderBy: { puzzleId: 'asc' } });
    return { items: rows.filter((r) => getPuzzle(r.puzzleId)).map(toDto) };
  }

  async attempt(userId: string, idParam: string, body: unknown): Promise<PuzzleAttemptResultDto> {
    const puzzle = /^\d{1,3}$/.test(idParam) ? getPuzzle(Number(idParam)) : undefined;
    if (!puzzle) throw new NotFoundException('Không tìm thấy thế cờ');

    if ((await this.redis.hit(`rl:puzzle:${userId}`, 60)) > PUZZLE_LIMITS.attemptsPerMinute) {
      throw new HttpException('Bạn gửi kết quả quá nhiều lần, hãy thử lại sau ít phút', HttpStatus.TOO_MANY_REQUESTS);
    }

    const moves = (body as { moves?: unknown } | null)?.moves;
    if (
      !Array.isArray(moves) ||
      moves.length === 0 ||
      moves.length > PUZZLE_LIMITS.maxPlies ||
      !moves.every((m) => typeof m === 'string' && MOVE_RE.test(m))
    ) {
      throw new BadRequestException('Danh sách nước đi không hợp lệ');
    }

    let engine: GameEngine;
    try {
      engine = replayGame('xiangqi', moves as string[], puzzle.fen);
    } catch (e) {
      // "Nước thứ N không hợp lệ: ..." (game-core), kể cả khi gửi thêm nước sau lúc ván đã kết thúc
      throw new BadRequestException((e as Error).message);
    }
    // Bên đi trước của thế cờ (mọi thế hiện có đều là Đỏ)
    const attacker: Color = moves.length % 2 === 0 ? engine.turn() : otherColor(engine.turn());
    const st = engine.status();
    // Thắng nhưng Đen đỡ khác cách trang đỡ (nước Đen tự chọn để thua nhanh): chỉ tính là một lần thử
    const solved =
      st.over &&
      st.result.winner === attacker &&
      defenceLooksReal(engine, moves as string[], attacker, puzzle.mateIn ? puzzle.solution : undefined);
    const redMoves = puzzleMoveCount(moves.length);

    const row = await this.record(userId, puzzle.id, solved, redMoves);
    return { solved, result: st.over ? st.result : null, moves: redMoves, progress: toDto(row) };
  }

  /** +1 lần thử; nếu giải được: ghi lần giải đầu tiên và số nước ít nhất (các câu lệnh có điều kiện nên an toàn khi gửi đồng thời) */
  private async record(userId: string, puzzleId: number, solved: boolean, redMoves: number): Promise<PuzzleProgress> {
    const now = new Date();
    const where = { userId_puzzleId: { userId, puzzleId } };
    const upsert = () =>
      this.prisma.puzzleProgress.upsert({
        where,
        create: { userId, puzzleId, attempts: 1, solvedAt: solved ? now : null, bestMoves: solved ? redMoves : null },
        update: { attempts: { increment: 1 } },
      });
    let row: PuzzleProgress;
    try {
      row = await upsert();
    } catch (e) {
      // Hai lần gửi đầu tiên cùng lúc: một bên tạo dòng trước → bên kia cập nhật
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') row = await upsert();
      else throw e;
    }
    if (!solved) return row;
    if (row.solvedAt && row.bestMoves !== null && row.bestMoves <= redMoves) return row;
    await this.prisma.puzzleProgress.updateMany({
      where: { userId, puzzleId, OR: [{ bestMoves: null }, { bestMoves: { gt: redMoves } }] },
      data: { bestMoves: redMoves },
    });
    await this.prisma.puzzleProgress.updateMany({ where: { userId, puzzleId, solvedAt: null }, data: { solvedAt: now } });
    return this.prisma.puzzleProgress.findUniqueOrThrow({ where });
  }
}
