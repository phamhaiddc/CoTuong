import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { AppConfig } from '../config';

/** Mã HTTP của lỗi từ S3 (undefined nếu không phải lỗi phản hồi từ dịch vụ, vd lỗi mạng) */
function s3Status(e: unknown): number | undefined {
  const s = (e as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return typeof s === 'number' ? s : undefined;
}

/**
 * Lưu avatar trên object storage chuẩn S3 (mặc định, chưa được xác nhận — mục Review).
 * Ảnh được phục vụ lại qua /api/avatars/... nên bucket không cần mở công khai.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  private readonly client: S3Client | null;
  private readonly bucket: string;
  /** Bucket đã sẵn sàng (đang kiểm tra / tạo); lỗi thì đặt lại null để lần sau thử lại */
  private bucketReady: Promise<void> | null = null;

  constructor(cfg: AppConfig) {
    const s3 = cfg.s3;
    this.bucket = s3?.bucket ?? '';
    this.client = s3
      ? new S3Client({
          region: s3.region,
          endpoint: s3.endpoint ?? undefined,
          forcePathStyle: s3.forcePathStyle,
          credentials: s3.accessKeyId ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } : undefined,
        })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      this.logger.warn('Chưa cấu hình S3_BUCKET — tính năng upload avatar bị tắt');
      return;
    }
    await this.ensureBucket().catch((e: Error) =>
      // Dịch vụ S3 có thể khởi động chậm hơn server (vd docker compose): không dừng server, thử lại khi có ảnh tải lên
      this.logger.error(`Không truy cập được bucket ${this.bucket}: ${e.message} — sẽ thử lại ở lần tải ảnh kế tiếp`),
    );
  }

  /**
   * Bucket có sẵn (chưa có thì tạo). Chỉ tạo khi HeadBucket báo bucket KHÔNG tồn tại (404): khoá S3 chỉ có quyền đọc /
   * ghi object (không có s3:ListBucket) bị từ chối HeadBucket (403) dù bucket vẫn dùng được — khi đó coi như sẵn sàng.
   * Lỗi khác (mạng, dịch vụ chưa chạy…) thì báo lỗi và lần gọi sau thử lại từ đầu.
   */
  private ensureBucket(): Promise<void> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('Object storage chưa được cấu hình'));
    this.bucketReady ??= (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (e) {
        const status = s3Status(e);
        if (status === 403) {
          // 403 có thể là khoá chỉ thiếu quyền s3:ListBucket (bucket vẫn dùng được) HOẶC khoá S3 sai — không phân biệt được
          // ở đây; lần ghi ảnh đầu tiên sẽ cho biết (put() ghi lỗi rõ nếu ghi thất bại)
          this.logger.warn(
            `HeadBucket ${this.bucket} bị từ chối (403): khoá S3 không có quyền s3:ListBucket, hoặc khoá / mật khẩu S3 sai — ` +
              'sẽ biết khi tải ảnh lên lần đầu',
          );
          return;
        }
        if (status !== 404 && (e as { name?: string })?.name !== 'NotFound' && (e as { name?: string })?.name !== 'NoSuchBucket') {
          throw e;
        }
        await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Đã tạo bucket ${this.bucket}`);
      }
    })().catch((e: unknown) => {
      this.bucketReady = null;
      throw e;
    });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!this.client) throw new Error('Object storage chưa được cấu hình');
    // Kiểm tra / tạo bucket lỗi thì vẫn thử ghi ảnh: PutObject tự báo lỗi thật nếu bucket không dùng được
    await this.ensureBucket().catch((e: Error) =>
      this.logger.warn(`Kiểm tra bucket ${this.bucket} thất bại (${e.message}) — vẫn thử ghi ảnh`),
    );
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    } catch (e) {
      // Ghi lỗi rõ ràng (vd khoá S3 sai → 403 InvalidAccessKeyId / SignatureDoesNotMatch) rồi để nơi gọi báo lỗi như cũ
      const status = s3Status(e);
      this.logger.error(
        `Ghi ảnh vào bucket ${this.bucket} thất bại${status ? ` (HTTP ${status})` : ''}: ${(e as { name?: string })?.name ?? 'Error'} — ` +
          `${(e as Error).message}. Kiểm tra S3_ENDPOINT / S3_BUCKET / khoá S3.`,
      );
      throw e;
    }
  }

  async get(key: string): Promise<{ body: Readable; contentType: string | undefined; length: number | undefined } | null> {
    if (!this.client) return null;
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return { body: out.Body as Readable, contentType: out.ContentType, length: out.ContentLength };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      this.logger.warn(`Xoá ${key} thất bại: ${(e as Error).message}`);
    }
  }
}
