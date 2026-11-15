import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { GameError, type GameErrorExtra } from './errors';

/**
 * Lỗi phía người gửi do thư viện ngoài Nest ném ra (vd body-parser: thân JSON quá lớn → status 413,
 * type 'entity.too.large'): không phải HttpException nhưng có status / statusCode 4xx. Trả về mã đó, ngược lại null.
 */
function clientErrorStatus(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { status?: unknown; statusCode?: unknown };
  const s = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : null;
  return s !== null && Number.isInteger(s) && s >= 400 && s <= 499 ? s : null;
}

/** Trả lỗi dạng { statusCode, message, code?, retryAfterSec?, attemptsLeft? } với thông báo tiếng Việt */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Lỗi hệ thống, vui lòng thử lại sau';
    let code: string | undefined;
    let extra: GameErrorExtra = {};
    const clientStatus = clientErrorStatus(exception);
    if (exception instanceof GameError) {
      status = exception.status;
      message = exception.message;
      code = exception.code;
      extra = exception.extra;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else {
        const m = (body as { message?: unknown }).message;
        message = Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : exception.message;
      }
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) message = 'Tệp quá lớn (ảnh tối đa 2 MB)';
      if (status === HttpStatus.NOT_FOUND && /^Cannot (GET|POST|PUT|PATCH|DELETE)/.test(message)) message = 'Không tìm thấy';
    } else if (clientStatus !== null) {
      // Lỗi đọc thân yêu cầu (body-parser…): lỗi của người gửi — không ghi stack vào log
      status = clientStatus;
      message = clientStatus === HttpStatus.PAYLOAD_TOO_LARGE ? 'Dữ liệu gửi lên quá lớn' : 'Dữ liệu gửi lên không hợp lệ';
    } else {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    if (res.headersSent) return;
    if (typeof extra.retryAfterSec === 'number' && Number.isFinite(extra.retryAfterSec)) {
      res.setHeader('Retry-After', String(Math.max(0, Math.ceil(extra.retryAfterSec))));
    }
    res.status(status).json({ statusCode: status, message, code, ...extra });
  }
}
