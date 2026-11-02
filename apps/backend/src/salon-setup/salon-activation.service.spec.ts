import { Prisma } from '@prisma/client';
import { SalonActivationService } from './salon-activation.service';

describe('SalonActivationService', () => {
  let service: SalonActivationService;
  let prisma: {
    salon: { findUnique: jest.Mock; update: jest.Mock };
    photo: { findMany: jest.Mock };
    service: { count: jest.Mock };
    chair: { count: jest.Mock };
    salonStaff: { count: jest.Mock };
    auditLog: { create: jest.Mock };
    salonOnboardingApplication: { findUnique: jest.Mock; update: jest.Mock };
    salonOnboardingStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let salonAccess: {
    assertOwnerAccess: jest.Mock;
    assertOwnerOrAdminAccess: jest.Mock;
    assertPlatformAdminAccess: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      salon: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'salon-1',
            ownerUserId: 'owner-1',
            status: 'PENDING',
            shopPhotoRequirementGrandfathered: false,
            isClosedForToday: false,
          }),
        update: jest
          .fn()
          .mockResolvedValue({
            id: 'salon-1',
            status: 'ACTIVE',
            isClosedForToday: false,
          }),
      },
      photo: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { url: 'https://photos.example/one.jpg' },
            { url: 'https://photos.example/two.jpg' },
            { url: 'https://photos.example/three.jpg' },
          ]),
      },
      // Default to a fully set-up shop, so each readiness test states only the one thing it
      // removes rather than restating the whole fixture.
      service: { count: jest.fn().mockResolvedValue(1) },
      chair: { count: jest.fn().mockResolvedValue(1) },
      salonStaff: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback(prisma),
      ),
      auditLog: { create: jest.fn() },
      // Self-registered shops have no onboarding application, so the onboarding gate is a no-op.
      salonOnboardingApplication: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      salonOnboardingStatusHistory: { create: jest.fn() },
    };
    salonAccess = {
      assertOwnerAccess: jest.fn().mockResolvedValue(undefined),
      assertOwnerOrAdminAccess: jest.fn().mockResolvedValue('OWNER'),
      assertPlatformAdminAccess: jest.fn().mockResolvedValue('PLATFORM_ADMIN'),
    };
    service = new SalonActivationService(prisma as never, salonAccess as never);
  });

  it('activates a PENDING salon — the fix that makes a self-registered shop usable', async () => {
    const result = await service.updateStatus('owner-1', 'salon-1', {
      status: 'ACTIVE' as never,
    });
    expect(prisma.salon.update).toHaveBeenCalledWith({
      where: { id: 'salon-1' },
      data: {
        status: 'ACTIVE',
        isClosedForToday: false,
        shopPhotoRequirementGrandfathered: true,
      },
    });
    expect(result).toEqual({
      id: 'salon-1',
      status: 'ACTIVE',
      isClosedForToday: false,
    });
  });

  it('closes an ACTIVE owner shop for today without changing its discoverable lifecycle status', async () => {
    prisma.salon.findUnique.mockResolvedValue({
      id: 'salon-1',
      status: 'ACTIVE',
      isClosedForToday: false,
    });
    prisma.salon.update.mockResolvedValue({
      id: 'salon-1',
      status: 'ACTIVE',
      isClosedForToday: true,
    });
    const result = await service.updateStatus('owner-1', 'salon-1', {
      status: 'SUSPENDED' as never,
    });
    expect(prisma.salon.update).toHaveBeenCalledWith({
      where: { id: 'salon-1' },
      data: { isClosedForToday: true },
    });
    expect(result).toEqual({
      id: 'salon-1',
      status: 'ACTIVE',
      isClosedForToday: true,
    });
  });

  it('checks salon access first', async () => {
    await service.updateStatus('owner-1', 'salon-1', {
      status: 'ACTIVE' as never,
    });
    expect(salonAccess.assertOwnerAccess).toHaveBeenCalledWith(
      'owner-1',
      'salon-1',
    );
  });

  it('refuses to activate a salon the caller does not own, and writes nothing', async () => {
    salonAccess.assertOwnerAccess.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
    );
    await expect(
      service.updateStatus('intruder', 'someone-elses-salon', {
        status: 'ACTIVE' as never,
      }),
    ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
    expect(prisma.salon.update).not.toHaveBeenCalled();
  });

  it('404s for a salon that does not exist', async () => {
    prisma.salon.findUnique.mockResolvedValue(null);
    await expect(
      service.updateStatus('owner-1', 'missing', { status: 'ACTIVE' as never }),
    ).rejects.toMatchObject({ code: 'SALON_NOT_FOUND' });
    expect(prisma.salon.update).not.toHaveBeenCalled();
  });

  it('requires three distinct valid photo URLs before first activation', async () => {
    prisma.photo.findMany.mockResolvedValueOnce([
      { url: 'https://photos.example/one.jpg?size=small' },
      { url: 'https://photos.example/one.jpg?size=large' },
      { url: 'javascript:alert(1)' },
    ]);
    await expect(
      service.updateStatus('owner-1', 'salon-1', { status: 'ACTIVE' as never }),
    ).rejects.toMatchObject({
      code: 'SHOP_PHOTOS_REQUIRED',
      details: {
        required: 3,
        current: 1,
        ready: false,
        grandfathered: false,
        reasons: ['THREE_VALID_PHOTOS_REQUIRED'],
      },
    });
    expect(prisma.salon.update).not.toHaveBeenCalled();
  });

  it('returns a retryable conflict when activation requirements change concurrently', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Serialization conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.updateStatus('owner-1', 'salon-1', { status: 'ACTIVE' as never }),
    ).rejects.toMatchObject({ code: 'SALON_ACTIVATION_REQUIREMENTS_CHANGED' });
    expect(prisma.salon.update).not.toHaveBeenCalled();
  });

  it('grandfathers an existing active shop in its readiness response', async () => {
    prisma.salon.findUnique.mockResolvedValueOnce({
      id: 'salon-1',
      status: 'ACTIVE',
      shopPhotoRequirementGrandfathered: null,
    });
    prisma.photo.findMany.mockResolvedValueOnce([]);
    await expect(
      service.getPhotoReadiness('owner-1', 'salon-1'),
    ).resolves.toEqual({
      required: 3,
      current: 0,
      ready: true,
      grandfathered: true,
      reasons: [],
    });
    expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith(
      'owner-1',
      'salon-1',
    );
  });

  // A PENDING shop that opens with nothing set up is a dead end for the customer who finds it:
  // the page loads, but there is no service to pick, no chair to sit in, or nobody to cut hair.
  describe('setup gate on the first opening (PENDING -> ACTIVE)', () => {
    it('rejects activation when there is no active service', async () => {
      prisma.service.count.mockResolvedValue(0);
      await expect(
        service.updateStatus('owner-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({
        code: 'SALON_SETUP_INCOMPLETE',
        details: {
          hasActiveService: false,
          hasActiveChair: true,
          hasActiveStaff: true,
        },
      });
      expect(prisma.salon.update).not.toHaveBeenCalled();
    });

    it('rejects activation when there is no active chair', async () => {
      prisma.chair.count.mockResolvedValue(0);
      await expect(
        service.updateStatus('owner-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({
        code: 'SALON_SETUP_INCOMPLETE',
        details: {
          hasActiveService: true,
          hasActiveChair: false,
          hasActiveStaff: true,
        },
      });
      expect(prisma.salon.update).not.toHaveBeenCalled();
    });

    it('rejects activation when there is no active barber', async () => {
      prisma.salonStaff.count.mockResolvedValue(0);
      await expect(
        service.updateStatus('owner-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({
        code: 'SALON_SETUP_INCOMPLETE',
        details: {
          hasActiveService: true,
          hasActiveChair: true,
          hasActiveStaff: false,
        },
      });
      expect(prisma.salon.update).not.toHaveBeenCalled();
    });

    it('activates when all three are present', async () => {
      const result = await service.updateStatus('owner-1', 'salon-1', {
        status: 'ACTIVE' as never,
      });
      expect(result).toEqual({
        id: 'salon-1',
        status: 'ACTIVE',
        isClosedForToday: false,
      });
      expect(prisma.salon.update).toHaveBeenCalled();
    });

    it('counts only usable rows — a deactivated service/chair/barber does not satisfy the gate', async () => {
      await service.updateStatus('owner-1', 'salon-1', {
        status: 'ACTIVE' as never,
      });
      expect(prisma.service.count).toHaveBeenCalledWith({
        where: { salonId: 'salon-1', isActive: true },
      });
      expect(prisma.chair.count).toHaveBeenCalledWith({
        where: { salonId: 'salon-1', status: 'ACTIVE' },
      });
      expect(prisma.salonStaff.count).toHaveBeenCalledWith({
        where: { salonId: 'salon-1', status: 'ACTIVE' },
      });
    });

    it('names every missing item in one message, not just the first', async () => {
      prisma.service.count.mockResolvedValue(0);
      prisma.chair.count.mockResolvedValue(0);
      prisma.salonStaff.count.mockResolvedValue(0);
      await expect(
        service.updateStatus('owner-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({
        message:
          'Complete your shop setup before opening it: add at least one service, one chair and one barber.',
      });
    });

    it('still enforces ownership before running any readiness count', async () => {
      salonAccess.assertOwnerAccess.mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(
        service.updateStatus('intruder', 'someone-elses-salon', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
      expect(prisma.service.count).not.toHaveBeenCalled();
      expect(prisma.chair.count).not.toHaveBeenCalled();
      expect(prisma.salonStaff.count).not.toHaveBeenCalled();
    });
  });

  // The gate guards the FIRST opening only. Once a shop has traded, its owner keeps full control
  // of pausing and reopening, and losing the last chair never silently closes it.
  describe('the gate does not apply outside PENDING -> ACTIVE', () => {
    it('reopens a SUSPENDED salon even with nothing active — reopening after a pause is not first-time setup', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 'salon-1',
        status: 'SUSPENDED',
        isClosedForToday: false,
      });
      prisma.salon.update.mockResolvedValue({
        id: 'salon-1',
        status: 'ACTIVE',
        isClosedForToday: false,
      });
      prisma.service.count.mockResolvedValue(0);
      prisma.chair.count.mockResolvedValue(0);
      prisma.salonStaff.count.mockResolvedValue(0);

      const result = await service.updateStatus('owner-1', 'salon-1', {
        status: 'ACTIVE' as never,
      });

      expect(result.status).toBe('ACTIVE');
      expect(prisma.service.count).not.toHaveBeenCalled();
    });

    it('leaves an already-ACTIVE salon unchanged and ungated', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 'salon-1',
        status: 'ACTIVE',
      });
      prisma.service.count.mockResolvedValue(0);
      prisma.chair.count.mockResolvedValue(0);
      prisma.salonStaff.count.mockResolvedValue(0);

      const result = await service.updateStatus('owner-1', 'salon-1', {
        status: 'ACTIVE' as never,
      });

      expect(result.status).toBe('ACTIVE');
      expect(prisma.service.count).not.toHaveBeenCalled();
      expect(prisma.salon.update).toHaveBeenCalledWith({
        where: { id: 'salon-1' },
        data: { status: 'ACTIVE', isClosedForToday: false },
      });
    });

    it('never gates a PENDING salon daily-close request and does not turn it into an admin suspension', async () => {
      prisma.service.count.mockResolvedValue(0);
      prisma.salon.update.mockResolvedValue({
        id: 'salon-1',
        status: 'PENDING',
        isClosedForToday: true,
      });

      const result = await service.updateStatus('owner-1', 'salon-1', {
        status: 'SUSPENDED' as never,
      });

      expect(result.status).toBe('PENDING');
      expect(result.isClosedForToday).toBe(true);
      expect(prisma.service.count).not.toHaveBeenCalled();
    });
  });

  describe('platform-admin lifecycle transitions', () => {
    beforeEach(() => {
      prisma.auditLog.create.mockClear();
    });

    it('opens a ready pending salon and records the admin actor', async () => {
      const result = await service.updateStatusAsAdmin('admin-1', 'salon-1', {
        status: 'ACTIVE' as never,
      });
      expect(result.status).toBe('ACTIVE');
      expect(salonAccess.assertPlatformAdminAccess).toHaveBeenCalledWith(
        'admin-1',
        'salon-1',
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          action: 'ADMIN_SALON_OPENED',
          entityId: 'salon-1',
        }),
      });
    });

    it('rejects an incomplete pending salon with readiness details', async () => {
      prisma.service.count.mockResolvedValue(0);
      await expect(
        service.updateStatusAsAdmin('admin-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({
        code: 'SALON_SETUP_INCOMPLETE',
        details: { hasActiveService: false },
      });
      expect(prisma.salon.update).not.toHaveBeenCalled();
    });

    it('suspends active and reopens suspended shops with valid transitions only', async () => {
      prisma.salon.findUnique
        .mockResolvedValueOnce({
          id: 'salon-1',
          status: 'ACTIVE',
          shopPhotoRequirementGrandfathered: null,
        })
        .mockResolvedValueOnce({
          id: 'salon-1',
          status: 'ACTIVE',
          shopPhotoRequirementGrandfathered: null,
        });
      prisma.salon.update.mockResolvedValueOnce({
        id: 'salon-1',
        status: 'SUSPENDED',
      });
      await expect(
        service.updateStatusAsAdmin('admin-1', 'salon-1', {
          status: 'SUSPENDED' as never,
        }),
      ).resolves.toEqual({ id: 'salon-1', status: 'SUSPENDED' });
      prisma.salon.findUnique
        .mockResolvedValueOnce({
          id: 'salon-1',
          status: 'SUSPENDED',
          shopPhotoRequirementGrandfathered: true,
        })
        .mockResolvedValueOnce({
          id: 'salon-1',
          status: 'SUSPENDED',
          shopPhotoRequirementGrandfathered: true,
        });
      prisma.salon.update.mockResolvedValueOnce({
        id: 'salon-1',
        status: 'ACTIVE',
      });
      await expect(
        service.updateStatusAsAdmin('admin-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).resolves.toEqual({ id: 'salon-1', status: 'ACTIVE' });
    });

    it('rejects invalid transitions without writing', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 'salon-1',
        status: 'ACTIVE',
      });
      await expect(
        service.updateStatusAsAdmin('admin-1', 'salon-1', {
          status: 'ACTIVE' as never,
        }),
      ).rejects.toMatchObject({ code: 'SALON_STATUS_TRANSITION_INVALID' });
      expect(prisma.salon.update).not.toHaveBeenCalled();
    });
  });
});
