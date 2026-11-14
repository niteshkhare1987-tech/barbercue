import {
  RecentlyViewedService,
  recentlyViewedLimit,
} from './recently-viewed.service';
import { mapBounds } from './salons.service';

function makePrisma() {
  return {
    salon: { findFirst: jest.fn() },
    customerRecentSalonView: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe('recentlyViewedLimit', () => {
  it('defaults, clamps and ignores junk', () => {
    expect(recentlyViewedLimit(undefined)).toBe(20);
    expect(recentlyViewedLimit('abc')).toBe(20);
    expect(recentlyViewedLimit('5')).toBe(5);
    expect(recentlyViewedLimit('0')).toBe(1);
    expect(recentlyViewedLimit('5000')).toBe(100);
  });
});

describe('mapBounds', () => {
  it('needs all four edges', () => {
    expect(mapBounds({ minLat: 1, maxLat: 2, minLng: 3 })).toBeNull();
    expect(mapBounds({ minLat: 1, maxLat: 2, minLng: 3, maxLng: 4 })).toEqual({
      minLat: 1,
      maxLat: 2,
      minLng: 3,
      maxLng: 4,
    });
  });
});

describe('RecentlyViewedService', () => {
  const salonId = '11111111-1111-4111-8111-111111111111';

  it('records a view scoped to the customer and prunes beyond the cap', async () => {
    const prisma = makePrisma();
    prisma.salon.findFirst.mockResolvedValue({ id: salonId });
    prisma.customerRecentSalonView.findMany.mockResolvedValue([{ id: 'old' }]);
    const service = new RecentlyViewedService(prisma as never, {} as never);

    await service.record('user-1', salonId);

    expect(prisma.customerRecentSalonView.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_salonId: { userId: 'user-1', salonId } },
      }),
    );
    expect(prisma.customerRecentSalonView.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { in: ['old'] } },
    });
  });

  it('refuses inactive or unknown salons', async () => {
    const prisma = makePrisma();
    prisma.salon.findFirst.mockResolvedValue(null);
    const service = new RecentlyViewedService(prisma as never, {} as never);
    await expect(service.record('user-1', salonId)).rejects.toThrow();
    expect(prisma.customerRecentSalonView.upsert).not.toHaveBeenCalled();
  });

  it('lists only the caller’s rows, most recent first, with viewedAt', async () => {
    const prisma = makePrisma();
    const viewedAt = new Date('2026-11-10T10:00:00Z');
    prisma.customerRecentSalonView.findMany.mockResolvedValue([
      { salonId, viewedAt },
    ]);
    const salons = {
      listItemsByIds: jest.fn().mockResolvedValue([{ id: salonId, name: 'A' }]),
    };
    const service = new RecentlyViewedService(prisma as never, salons as never);

    const items = await service.list('user-1');

    expect(prisma.customerRecentSalonView.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1' }),
        orderBy: { viewedAt: 'desc' },
      }),
    );
    expect(items).toEqual([
      { id: salonId, name: 'A', viewedAt: viewedAt.toISOString() },
    ]);
  });

  it('clear and remove only touch the caller’s rows', async () => {
    const prisma = makePrisma();
    const service = new RecentlyViewedService(prisma as never, {} as never);
    await service.remove('user-1', salonId);
    await service.clear('user-1');
    expect(prisma.customerRecentSalonView.deleteMany).toHaveBeenNthCalledWith(
      1,
      {
        where: { userId: 'user-1', salonId },
      },
    );
    expect(prisma.customerRecentSalonView.deleteMany).toHaveBeenNthCalledWith(
      2,
      {
        where: { userId: 'user-1' },
      },
    );
  });
});
