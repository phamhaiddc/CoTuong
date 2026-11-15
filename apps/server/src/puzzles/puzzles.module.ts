import { Module } from '@nestjs/common';
import { PuzzlesAuthGuard } from './puzzles-auth.guard';
import { PuzzlesController } from './puzzles.controller';
import { PuzzlesService } from './puzzles.service';

/**
 * Cờ thế: GET /api/puzzles/progress, POST /api/puzzles/:id/attempt.
 * Dùng Prisma / Redis / AuthService của AppModule qua ModuleRef (xem puzzles-auth.guard.ts).
 */
@Module({
  controllers: [PuzzlesController],
  providers: [PuzzlesService, PuzzlesAuthGuard],
})
export class PuzzlesModule {}
