import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfig } from './config';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { MailService } from './common/mail.service';
import { PresenceService } from './common/presence.service';
import { PrismaService } from './common/prisma.service';
import { RealtimeService } from './common/realtime.service';
import { RedisService } from './common/redis.service';
import { StorageService } from './common/storage.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { AuthController } from './auth/auth.controller';
import { AdminGuard, AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { OAuthController } from './auth/oauth.controller';
import { OAuthService } from './auth/oauth.service';
import { GuestCleanupService } from './auth/guest-cleanup.service';
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { RatingDecayService } from './seasons/rating-decay.service';
import { SessionService } from './auth/session.service';
import { ChatService } from './game/chat.service';
import { GameGateway } from './game/game.gateway';
import { LiveMatchService } from './game/live-match.service';
import { MatchmakingService } from './game/matchmaking.service';
import { BotsService } from './bots/bots.service';
import { RoomsService } from './game/rooms.service';
import { LeaderboardController } from './leaderboard/leaderboard.controller';
import { LeaderboardService } from './leaderboard/leaderboard.service';
import { MatchesController } from './matches/matches.controller';
import { MatchesService } from './matches/matches.service';
import { PuzzlesModule } from './puzzles/puzzles.module';
import { RatingsService } from './seasons/ratings.service';
import { SeasonJobService } from './seasons/season-job.service';
import { SeasonsService } from './seasons/seasons.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [ScheduleModule.forRoot(), PuzzlesModule],
  controllers: [AuthController, OAuthController, UsersController, MatchesController, LeaderboardController, AdminController, AnalyticsController],
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    PrismaService,
    RedisService,
    RealtimeService,
    MailService,
    StorageService,
    PresenceService,
    SessionService,
    AuthService,
    OAuthService,
    GuestCleanupService,
    AnalyticsService,
    RatingDecayService,
    AuthGuard,
    AdminGuard,
    SeasonsService,
    RatingsService,
    LeaderboardService,
    SeasonJobService,
    LiveMatchService,
    BotsService,
    MatchmakingService,
    RoomsService,
    ChatService,
    GameGateway,
    UsersService,
    MatchesService,
    AdminService,
  ],
})
export class AppModule {}
