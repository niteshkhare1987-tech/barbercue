import { createSalonPhotoSchema } from '@barbercue/shared';
import sharp from 'sharp';
import { SalonPhotosService } from './salon-photos.service';

describe('SalonPhotosService', () => {
  let service: SalonPhotosService;
  let prisma: {
    photo: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    salonStaff: { findFirst: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
    auditLog: { create: jest.Mock };
  };
  let salonAccess: { assertOwnerOrAdminAccess: jest.Mock };
  let storage: {
    isConfigured: boolean;
    putPublicObject: jest.Mock;
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      photo: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { url: 'https://cdn.test/existing.jpg', type: 'GALLERY' },
          ]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'p1',
          url: 'https://cdn.test/a.jpg',
          altText: null,
          type: 'COVER',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      salonStaff: {
        findFirst: jest.fn().mockResolvedValue({ id: 'staff-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    };
    salonAccess = {
      assertOwnerOrAdminAccess: jest.fn().mockResolvedValue('OWNER'),
    };
    storage = {
      isConfigured: true,
      putPublicObject: jest
        .fn()
        .mockResolvedValue('https://cdn.test/uploaded.jpg'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    service = new SalonPhotosService(
      prisma as never,
      salonAccess as never,
      storage as never,
    );
  });

  const input = {
    url: 'https://cdn.test/a.jpg',
    type: 'COVER' as never,
  };

  it('saves a portrait on the scoped barber without adding a salon gallery photo', async () => {
    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#a62351' },
    }).jpeg().toBuffer();
    const file = { buffer, size: buffer.length } as Express.Multer.File;

    await expect(service.uploadStaffPortrait('owner-1', 'salon-1', 'staff-1', file))
      .resolves.toEqual({ photoUrl: 'https://cdn.test/uploaded.jpg' });

    expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith('owner-1', 'salon-1');
    expect(prisma.salonStaff.updateMany).toHaveBeenCalledWith({
      where: { id: 'staff-1', salonId: 'salon-1' },
      data: { photoUrl: 'https://cdn.test/uploaded.jpg' },
    });
    expect(prisma.photo.create).not.toHaveBeenCalled();
  });

  it('rejects a barber outside the session salon before uploading a portrait', async () => {
    prisma.salonStaff.findFirst.mockResolvedValue(null);
    await expect(service.uploadStaffPortrait('owner-1', 'salon-1', 'other-staff', undefined))
      .rejects.toMatchObject({ code: 'STAFF_NOT_FOUND' });
    expect(storage.putPublicObject).not.toHaveBeenCalled();
  });

  it('checks salon access before listing', async () => {
    await service.list('owner-1', 'salon-1');
    expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith(
      'owner-1',
      'salon-1',
    );
  });

  it('refuses to add a photo to another owner’s salon, writing nothing', async () => {
    salonAccess.assertOwnerOrAdminAccess.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
    );
    await expect(
      service.create('intruder', 'someone-elses-salon', input),
    ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
    expect(prisma.photo.create).not.toHaveBeenCalled();
  });

  // Discovery cards and the profile hero both read "the" cover, so two would be ambiguous.
  it('demotes an existing cover to gallery when a new cover is added', async () => {
    await service.create('owner-1', 'salon-1', input);
    expect(prisma.photo.updateMany).toHaveBeenCalledWith({
      where: { salonId: 'salon-1', type: 'COVER' },
      data: { type: 'GALLERY' },
    });
  });

  it('does not touch existing photos when adding a gallery image', async () => {
    await service.create('owner-1', 'salon-1', {
      ...input,
      type: 'GALLERY' as never,
    });
    expect(prisma.photo.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a photo beyond the per-salon cap', async () => {
    prisma.photo.count.mockResolvedValue(12);
    await expect(
      service.create('owner-1', 'salon-1', input),
    ).rejects.toMatchObject({ code: 'PHOTO_LIMIT_REACHED' });
    expect(prisma.photo.create).not.toHaveBeenCalled();
  });

  // An id alone must never be enough — that would be a cross-tenant delete.
  it('scopes deletion by salonId as well as photo id', async () => {
    await service.remove('owner-1', 'salon-1', 'p1');
    expect(prisma.photo.deleteMany).toHaveBeenCalledWith({
      where: { id: 'p1', salonId: 'salon-1' },
    });
  });

  it('404s when the photo does not belong to this salon', async () => {
    // remove() looks the photo up (scoped by salonId) before deleting it — a photo belonging to
    // another salon simply isn't found, same as one that never existed.
    prisma.photo.findMany.mockResolvedValue([]);
    await expect(
      service.remove('owner-1', 'salon-1', 'other-salons-photo'),
    ).rejects.toMatchObject({ code: 'PHOTO_NOT_FOUND' });
    expect(prisma.photo.deleteMany).not.toHaveBeenCalled();
  });

  it('best-effort deletes the underlying storage object after removing the row', async () => {
    await service.remove('owner-1', 'salon-1', 'p1');
    expect(storage.deleteObject).toHaveBeenCalledWith(
      'https://cdn.test/existing.jpg',
    );
  });

  it('removal succeeds even when storage cleanup unexpectedly throws', async () => {
    storage.deleteObject.mockRejectedValue(new Error('disk unavailable'));
    await expect(
      service.remove('owner-1', 'salon-1', 'p1'),
    ).resolves.toBeUndefined();
    expect(prisma.photo.deleteMany).toHaveBeenCalled();
  });

  // The URL is stored and later rendered into an <img src>, so what we accept matters.
  describe('createSalonPhotoSchema', () => {
    const parse = (url: string) =>
      createSalonPhotoSchema.safeParse({ url, type: 'COVER' });

    it('accepts an https image URL', () => {
      expect(parse('https://cdn.test/shop.jpg').success).toBe(true);
    });

    it.each([
      ['http://cdn.test/a.jpg', 'plain http (mixed content on an https page)'],
      ['javascript:alert(1)', 'javascript scheme'],
      ['data:image/png;base64,AAAA', 'data scheme'],
      ['https://user:pass@cdn.test/a.jpg', 'embedded credentials'],
      ['not a url', 'not a URL at all'],
      ['', 'empty'],
    ])('rejects %p (%s)', (url) => {
      expect(parse(url).success).toBe(false);
    });

    it('rejects a URL beyond the length cap', () => {
      expect(parse(`https://cdn.test/${'a'.repeat(2100)}.jpg`).success).toBe(
        false,
      );
    });
  });

  // ---------- Device upload (multipart) ----------

  describe('createFromUpload', () => {
    type TestImage = {
      buffer: Buffer;
      size: number;
      mimetype: string;
      originalname: string;
    };

    // Real decoded image bytes exercise the server's re-encode/metadata-stripping path.
    const image = async (
      format: 'jpeg' | 'png' | 'webp' = 'jpeg',
      withExif = false,
    ) => {
      const pipeline = sharp({
        create: {
          width: 32,
          height: 24,
          channels: 3,
          background: '#ab3f6a',
        },
      });
      if (withExif) {
        pipeline.withExif({ IFD0: { Artist: 'private-test-metadata' } });
      }
      const buffer = await pipeline.toFormat(format).toBuffer();
      return {
        buffer,
        size: buffer.length,
        mimetype: `image/${format}`,
        originalname: `shop.${format}`,
      } satisfies TestImage;
    };

    const meta = { type: 'COVER' as never };

    it('stores the file and saves the returned URL as a normal photo row', async () => {
      await service.createFromUpload(
        'owner-1',
        'salon-1',
        (await image()) as never,
        meta,
      );
      expect(storage.putPublicObject).toHaveBeenCalledTimes(1);
      const [key, storedBytes, contentType] =
        storage.putPublicObject.mock.calls[0];
      // Keyed by salon, never by the client-supplied filename.
      expect(key).toMatch(/^salons\/salon-1\/photos\/[0-9a-f-]{36}\.jpg$/);
      expect(key).not.toContain('shop.jpg');
      // Content-Type is the sniffed value.
      expect(contentType).toBe('image/jpeg');
      await expect(sharp(storedBytes).metadata()).resolves.toMatchObject({
        format: 'jpeg',
        width: 32,
        height: 24,
      });
      expect(prisma.photo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: 'https://cdn.test/uploaded.jpg',
          }),
        }),
      );
    });

    it.each([
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const)(
      're-encodes %s uploads without embedded EXIF metadata',
      async (format, mime) => {
        const original = await image(format, true);
        await expect(sharp(original.buffer).metadata()).resolves.toMatchObject({
          exif: expect.any(Buffer),
        });

        await service.createFromUpload(
          'owner-1',
          'salon-1',
          original as never,
          meta,
        );

        const [, storedBytes, contentType] =
          storage.putPublicObject.mock.calls[0];
        expect(contentType).toBe(mime);
        const storedMetadata = await sharp(storedBytes).metadata();
        expect(storedMetadata.exif).toBeUndefined();
        expect(storedMetadata.xmp).toBeUndefined();
        expect(storedMetadata.icc).toBeUndefined();
      },
    );

    it('rejects a truncated image before writing it to storage', async () => {
      const source = await image();
      const truncated = {
        ...source,
        buffer: source.buffer.subarray(0, 16),
        size: 16,
      } satisfies TestImage;
      await expect(
        service.createFromUpload(
          'owner-1',
          'salon-1',
          truncated as never,
          meta,
        ),
      ).rejects.toMatchObject({ code: 'PHOTO_INVALID_IMAGE' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
      expect(prisma.photo.create).not.toHaveBeenCalled();
    });

    it('rejects a non-image whatever its declared type and filename claim', async () => {
      const disguised = {
        // "MZ" — a Windows executable, uploaded as image/jpeg named .jpg.
        buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]),
        size: 66,
        mimetype: 'image/jpeg',
        originalname: 'innocent.jpg',
      } as never;
      await expect(
        service.createFromUpload('owner-1', 'salon-1', disguised, meta),
      ).rejects.toMatchObject({ code: 'PHOTO_UNSUPPORTED_TYPE' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
      expect(prisma.photo.create).not.toHaveBeenCalled();
    });

    it('requires a file', async () => {
      await expect(
        service.createFromUpload('owner-1', 'salon-1', undefined, meta),
      ).rejects.toMatchObject({ code: 'PHOTO_FILE_REQUIRED' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
    });

    it('rejects an oversized file before uploading it', async () => {
      const huge = {
        buffer: Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          Buffer.alloc(64),
        ]),
        size: 50 * 1024 * 1024,
        mimetype: 'image/jpeg',
        originalname: 'huge.jpg',
      } as never;
      await expect(
        service.createFromUpload('owner-1', 'salon-1', huge, meta),
      ).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
    });

    it('checks salon access before touching storage', async () => {
      salonAccess.assertOwnerOrAdminAccess.mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(
        service.createFromUpload(
          'intruder',
          'someone-elses-salon',
          (await image()) as never,
          meta,
        ),
      ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
    });

    // An upload that cannot be recorded must not leave a file nothing points at.
    it('never uploads when the salon is already at the photo limit', async () => {
      prisma.photo.count.mockResolvedValue(12);
      await expect(
        service.createFromUpload(
          'owner-1',
          'salon-1',
          (await image()) as never,
          meta,
        ),
      ).rejects.toMatchObject({ code: 'PHOTO_LIMIT_REACHED' });
      expect(storage.putPublicObject).not.toHaveBeenCalled();
    });

    it('demotes an existing cover when an uploaded photo becomes the cover', async () => {
      await service.createFromUpload(
        'owner-1',
        'salon-1',
        (await image()) as never,
        meta,
      );
      expect(prisma.photo.updateMany).toHaveBeenCalledWith({
        where: { salonId: 'salon-1', type: 'COVER' },
        data: { type: 'GALLERY' },
      });
    });
  });

  // Part 2 — PLATFORM_ADMIN delegated shop management.
  describe('delegated admin management', () => {
    it('an owner add/remove never writes an AuditLog row', async () => {
      await service.create('owner-1', 'salon-1', input);
      await service.remove('owner-1', 'salon-1', 'p1');
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('PLATFORM_ADMIN linking a photo is recorded under the real admin actor, with no binary content', async () => {
      salonAccess.assertOwnerOrAdminAccess.mockResolvedValue('PLATFORM_ADMIN');
      await service.create('admin-1', 'salon-1', input);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'ADMIN_SALON_PHOTO_ADDED',
          entityType: 'Photo',
          entityId: 'p1',
          metadata: expect.objectContaining({
            salonId: 'salon-1',
            via: 'link',
            url: 'https://cdn.test/a.jpg',
          }),
        }),
      });
    });

    it('PLATFORM_ADMIN uploading a photo is recorded under the real admin actor, with no file bytes in metadata', async () => {
      salonAccess.assertOwnerOrAdminAccess.mockResolvedValue('PLATFORM_ADMIN');
      const jpegFile = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#ab3f6a' },
      })
        .jpeg()
        .toBuffer();
      await service.createFromUpload(
        'admin-1',
        'salon-1',
        {
          buffer: jpegFile,
          size: jpegFile.length,
          mimetype: 'image/jpeg',
          originalname: 'shop.jpg',
        } as never,
        { type: 'COVER' as never },
      );
      const call = prisma.auditLog.create.mock.calls.find(
        (c) => c[0].data.action === 'ADMIN_SALON_PHOTO_ADDED',
      );
      expect(call).toBeDefined();
      // photo.create's mock always resolves the same static row regardless of input — this
      // asserts the actor/action/via triad, not the (mock-fixed) url value.
      expect(call![0].data).toMatchObject({
        actorUserId: 'admin-1',
        metadata: { salonId: 'salon-1', via: 'upload', type: 'COVER' },
      });
    });

    it('PLATFORM_ADMIN removing a photo is recorded under the real admin actor', async () => {
      salonAccess.assertOwnerOrAdminAccess.mockResolvedValue('PLATFORM_ADMIN');
      await service.remove('admin-1', 'salon-1', 'p1');
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'ADMIN_SALON_PHOTO_REMOVED',
          entityType: 'Photo',
          entityId: 'p1',
          metadata: expect.objectContaining({
            salonId: 'salon-1',
            url: 'https://cdn.test/existing.jpg',
          }),
        }),
      });
    });

    it('a normal CUSTOMER is denied and nothing is written', async () => {
      salonAccess.assertOwnerOrAdminAccess.mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(
        service.remove('customer-1', 'salon-1', 'p1'),
      ).rejects.toMatchObject({
        code: 'SALON_ACCESS_DENIED',
      });
      expect(prisma.photo.deleteMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
