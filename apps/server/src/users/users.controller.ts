import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { isGameType } from '@cotuong/game-core';
import { AVATAR_LIMITS } from '@cotuong/shared';
import { StorageService } from '../common/storage.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type AuthUser } from '../auth/auth.types';
import { UsersService } from './users.service';
import { isUuid, pageParam } from '../common/ids';

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly storage: StorageService,
  ) {}

  @Get('users/:id/profile')
  @UseGuards(AuthGuard)
  profile(@Param('id') id: string) {
    return this.users.profile(id);
  }

  @Get('users/:id/matches')
  @UseGuards(AuthGuard)
  matches(@Param('id') id: string, @Query('game') game: string, @Query('page') page: string) {
    if (!isUuid(id)) throw new NotFoundException('Không tìm thấy người chơi');
    if (!isGameType(game)) throw new BadRequestException('Không rõ loại cờ (cờ tướng hay cờ vua). Bạn tải lại trang rồi thử lại.');
    return this.users.matches(id, game, pageParam(page));
  }

  @Post('me/avatar')
  @UseGuards(AuthGuard)
  // Giới hạn cả trường chữ trong form (mặc định multer không giới hạn số trường → có thể dồn bộ nhớ)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_LIMITS.maxBytes, files: 1, fields: 2, fieldSize: 1024, parts: 3 } }))
  async uploadAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: { buffer: Buffer; size: number; mimetype: string } | undefined,
  ) {
    return { avatarUrl: await this.users.setAvatar(user, file) };
  }

  /** Phục vụ avatar từ object storage (bucket không cần mở công khai) */
  @Get('avatars/:userId/:file')
  async avatar(@Param('userId') userId: string, @Param('file') file: string, @Res() res: Response) {
    if (!isUuid(userId) || !/^[0-9a-f]{16}\.webp$/.test(file)) {
      throw new NotFoundException('Không tìm thấy ảnh');
    }
    const obj = await this.storage.get(`avatars/${userId}/${file}`);
    if (!obj) throw new NotFoundException('Không tìm thấy ảnh');
    // Server chỉ lưu ảnh WebP do chính nó mã hoá lại → luôn trả image/webp, không tin Content-Type lưu trong kho
    // (nếu kho bị ghi bậy, nội dung HTML cũng không chạy được trên tên miền của trang)
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (obj.length) res.setHeader('Content-Length', String(obj.length));
    obj.body.pipe(res);
  }
}
