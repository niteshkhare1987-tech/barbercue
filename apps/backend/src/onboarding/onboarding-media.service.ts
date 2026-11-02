import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Prisma } from '@prisma/client';
import {
  ONBOARDING_MEDIA_LIMITS,
  OnboardingErrorCode,
  onboardingServiceKey,
  type MenuExtractionResultDto,
  type OnboardingApplicationDto,
  type OnboardingMediaCategory,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { PrivateObjectStorageService } from '../storage/private-object-storage.service';
import { detectImageMimeType } from '../storage/image-signature';
import { OnboardingService, onboardingNotFound } from './onboarding.service';
import { toServiceDto } from './onboarding.mapper';
import {
  MENU_EXTRACTOR,
  MenuExtractorUnavailableError,
  type ExtractedMenuItem,
  type MenuExtractor,
} from './menu-extraction/menu-extractor';

const MAX_INPUT_PIXELS = 50_000_000;
/** Archival copies keep enough resolution to read a menu, without storing 50 MP originals. */
const ARCHIVE_MAX_EDGE = 3000;

export interface StoredFile {
  body: Buffer;
  mimeType: string;
  filename: string;
}

function mediaError(
  code: string,
  message: string,
  status: HttpStatus,
): AppException {
  return new AppException(code, message, status);
}

/**
 * Onboarding photos and menu cards. Bytes are sniffed (never trusting the filename or declared
 * type), decoded and re-encoded through sharp (which strips EXIF, including phone GPS tags, and
 * normalizes orientation), and written to PRIVATE storage. Files are only ever read back through
 * the authenticated routes below.
 */
@Injectable()
export class OnboardingMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PrivateObjectStorageService,
    private readonly onboarding: OnboardingService,
    @Inject(MENU_EXTRACTOR) private readonly extractor: MenuExtractor,
  ) {}

  async upload(
    userId: string,
    applicationId: string,
    file: Express.Multer.File | undefined,
    category: OnboardingMediaCategory,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.onboarding.requireProfile(userId);
    if (!file || !file.buffer?.length) {
      throw mediaError(
        OnboardingErrorCode.MEDIA_INVALID,
        'Choose a photo to upload.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      file.size > ONBOARDING_MEDIA_LIMITS.maxBytes ||
      file.buffer.length > ONBOARDING_MEDIA_LIMITS.maxBytes
    ) {
      throw mediaError(
        OnboardingErrorCode.MEDIA_INVALID,
        'That photo is larger than 10 MB. Choose a smaller photo.',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const detected = detectImageMimeType(file.buffer);
    if (!detected) {
      throw mediaError(
        OnboardingErrorCode.MEDIA_INVALID,
        'Only JPG, PNG or WebP photos are accepted. iPhone HEIC photos are converted automatically when taken with the camera button; otherwise export them as JPG first.',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    const archived = await this.reencode(file.buffer, detected);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    // Validate ownership/editability before touching storage, so a rejected request never
    // leaves an orphaned file behind.
    await this.prisma.$transaction(async (tx) => {
      await this.onboarding.lockEditable(tx, profile, applicationId);
      const existing = await tx.salonOnboardingMedia.findMany({
        where: { applicationId, deletedAt: null },
        select: { sha256: true },
      });
      if (existing.length >= ONBOARDING_MEDIA_LIMITS.maxFilesPerApplication) {
        throw mediaError(
          OnboardingErrorCode.MEDIA_LIMIT,
          `An application can hold at most ${ONBOARDING_MEDIA_LIMITS.maxFilesPerApplication} photos. Remove one first.`,
          HttpStatus.CONFLICT,
        );
      }
      if (existing.some((m) => m.sha256 === sha256)) {
        throw mediaError(
          OnboardingErrorCode.MEDIA_DUPLICATE,
          'This photo is already uploaded to this application.',
          HttpStatus.CONFLICT,
        );
      }
    });

    const storageKey = `onboarding/${applicationId}/${randomUUID()}.${archived.ext}`;
    await this.storage.put(storageKey, archived.body, archived.mime);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.onboarding.lockEditable(tx, profile, applicationId);
        await tx.salonOnboardingMedia.create({
          data: {
            applicationId,
            storageKey,
            category,
            originalFilename: sanitizeFilename(file.originalname),
            mimeType: archived.mime,
            fileSize: archived.body.length,
            sha256,
            width: archived.width,
            height: archived.height,
            uploadedById: userId,
          },
        });
        await tx.salonOnboardingApplication.update({
          where: { id: applicationId },
          data: { version: { increment: 1 } },
        });
      });
    } catch (err) {
      // Failure recovery: the DB write failed after the file was stored, so remove the file.
      await this.storage.delete(storageKey);
      throw err;
    }
    return this.onboarding.get(userId, applicationId);
  }

  async remove(
    userId: string,
    applicationId: string,
    mediaId: string,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.onboarding.requireProfile(userId);
    const removed = await this.prisma.$transaction(async (tx) => {
      await this.onboarding.lockEditable(tx, profile, applicationId);
      const media = await tx.salonOnboardingMedia.findFirst({
        where: { id: mediaId, applicationId, deletedAt: null },
      });
      if (!media) throw onboardingNotFound();
      // Soft delete keeps the audit row; services extracted from it keep their values but lose
      // the image link.
      await tx.salonOnboardingMedia.update({
        where: { id: mediaId },
        data: { deletedAt: new Date() },
      });
      await tx.salonOnboardingService.updateMany({
        where: { applicationId, sourceMediaId: mediaId },
        data: { sourceMediaId: null },
      });
      await tx.salonOnboardingApplication.update({
        where: { id: applicationId },
        data: { version: { increment: 1 } },
      });
      return media;
    });
    await this.storage.delete(removed.storageKey);
    return this.onboarding.get(userId, applicationId);
  }

  /** Employee read: own or territory-shared applications only. */
  async readForEmployee(
    userId: string,
    applicationId: string,
    mediaId: string,
  ): Promise<StoredFile> {
    const profile = await this.onboarding.requireProfile(userId);
    await this.onboarding.loadReadable(profile, applicationId);
    return this.read(applicationId, mediaId);
  }

  /** Caller must already have checked admin authorization (role guard on the admin route). */
  async read(applicationId: string, mediaId: string): Promise<StoredFile> {
    const media = await this.prisma.salonOnboardingMedia.findFirst({
      where: { id: mediaId, applicationId, deletedAt: null },
    });
    if (!media) throw onboardingNotFound();
    const body = await this.storage.get(media.storageKey);
    if (!body) {
      throw mediaError(
        'ONBOARDING_MEDIA_MISSING',
        'This file is no longer available.',
        HttpStatus.GONE,
      );
    }
    return { body, mimeType: media.mimeType, filename: media.originalFilename };
  }

  /**
   * Reads a MENU photo with the configured AI provider and appends the rows as UNCONFIRMED
   * services (confirmedByEmployee=false, uncertain fields highlighted). Nothing extracted can be
   * submitted until the employee confirms each row. Durations absent from the photo stay null.
   */
  async extract(
    userId: string,
    applicationId: string,
    mediaId: string,
  ): Promise<MenuExtractionResultDto> {
    const profile = await this.onboarding.requireProfile(userId);
    await this.prisma.$transaction((tx) =>
      this.onboarding.lockEditable(tx, profile, applicationId),
    );
    const media = await this.prisma.salonOnboardingMedia.findFirst({
      where: { id: mediaId, applicationId, deletedAt: null },
    });
    if (!media) throw onboardingNotFound();
    if (media.category !== 'MENU') {
      throw mediaError(
        OnboardingErrorCode.MEDIA_INVALID,
        'Only photos uploaded as a menu card can be read for services.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!this.extractor.isConfigured) {
      await this.logExtraction(
        applicationId,
        mediaId,
        userId,
        'UNAVAILABLE',
        0,
        OnboardingErrorCode.AI_NOT_CONFIGURED,
      );
      throw mediaError(
        OnboardingErrorCode.AI_NOT_CONFIGURED,
        'Automatic menu reading is not set up yet. The photo is saved; please type the services in manually.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const file = await this.read(applicationId, mediaId);
    let items: ExtractedMenuItem[];
    try {
      items = await this.extractor.extract(file.body, file.mimeType);
    } catch (err) {
      const code =
        err instanceof MenuExtractorUnavailableError
          ? OnboardingErrorCode.AI_NOT_CONFIGURED
          : OnboardingErrorCode.AI_FAILED;
      await this.logExtraction(
        applicationId,
        mediaId,
        userId,
        'FAILED',
        0,
        code,
      );
      throw mediaError(
        code,
        'The menu could not be read automatically. The photo is saved; please enter the services manually.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.onboarding.lockEditable(tx, profile, applicationId);
      const existing = await tx.salonOnboardingService.findMany({
        where: { applicationId },
        select: { normalizedKey: true, sortOrder: true },
      });
      const seen = new Set(existing.map((s) => s.normalizedKey));
      let sortOrder =
        existing.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;
      let merged = 0;
      const created: string[] = [];
      for (const item of items) {
        const key = onboardingServiceKey(item.name, item.gender);
        if (seen.has(key)) {
          merged += 1;
          continue;
        }
        seen.add(key);
        const row = await tx.salonOnboardingService.create({
          data: {
            applicationId,
            serviceName: item.name,
            normalizedKey: key,
            category: item.category,
            applicableGender: item.gender,
            basePrice: item.price,
            priceType: item.priceType,
            durationMinutes: item.durationMinutes,
            description: item.description,
            sourceType: 'AI_EXTRACTED',
            sourceMediaId: mediaId,
            sourcePage: 1,
            extractionConfidence: item.confidence,
            uncertainFields: item.uncertainFields,
            confirmedByEmployee: false,
            sortOrder: sortOrder++,
          },
          select: { id: true },
        });
        created.push(row.id);
      }
      await tx.salonOnboardingExtraction.create({
        data: {
          applicationId,
          mediaId,
          provider: this.extractor.provider,
          status: 'SUCCEEDED',
          serviceCount: items.length,
          result: items as unknown as Prisma.InputJsonValue,
          requestedById: userId,
        },
      });
      await tx.salonOnboardingApplication.update({
        where: { id: applicationId },
        data: { version: { increment: 1 } },
      });
      return { created, merged };
    });
    const rows = await this.prisma.salonOnboardingService.findMany({
      where: { id: { in: result.created } },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      provider: this.extractor.provider,
      added: result.created.length,
      mergedDuplicates: result.merged,
      services: rows.map(toServiceDto),
    };
  }

  private async logExtraction(
    applicationId: string,
    mediaId: string,
    userId: string,
    status: string,
    count: number,
    errorCode: string,
  ): Promise<void> {
    await this.prisma.salonOnboardingExtraction.create({
      data: {
        applicationId,
        mediaId,
        provider: this.extractor.provider,
        status,
        serviceCount: count,
        errorCode,
        requestedById: userId,
      },
    });
  }

  private async reencode(
    buffer: Buffer,
    detected: string,
  ): Promise<{
    body: Buffer;
    mime: string;
    ext: string;
    width: number;
    height: number;
  }> {
    try {
      const pipeline = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: MAX_INPUT_PIXELS,
      });
      const meta = await pipeline.metadata();
      const expected =
        detected === 'image/jpeg' ? 'jpeg' : detected.slice('image/'.length);
      if (meta.format !== expected || !meta.width || !meta.height)
        throw new Error('format mismatch');
      const { data, info } = await pipeline
        .rotate()
        .resize({
          width: ARCHIVE_MAX_EDGE,
          height: ARCHIVE_MAX_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      return {
        body: data,
        mime: 'image/jpeg',
        ext: 'jpg',
        width: info.width,
        height: info.height,
      };
    } catch {
      throw mediaError(
        OnboardingErrorCode.MEDIA_INVALID,
        'That image could not be processed safely. Choose a different JPG, PNG or WebP photo.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }
}

export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? 'photo').split(/[\\/]/).pop() ?? 'photo';
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'photo';
}
