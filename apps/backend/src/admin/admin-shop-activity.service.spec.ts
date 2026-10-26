import {
  ADMIN_SHOP_ACTIVITY_MAX_DAYS,
  BookingStatus,
  QueueEntryStatus,
  SalonStatus,
  adminShopActivityQuerySchema,
} from '@barbercue/shared';
import { AdminShopActivityService } from './admin-shop-activity.service';
import type { PrismaService } from '../prisma/prisma.service';

const group = (salonId: string, status: string | null, count: number) => ({
  salonId,
  ...(status ? { status } : {}),
  _count: { _all: count },
});

function makeService(
  rows: {
    bookings?: ReturnType<typeof group>[];
    queue?: ReturnType<typeof group>[];
    live?: ReturnType<typeof group>[];
    salons?: {
      id: string;
      publicId: string;
      name: string;
      status: SalonStatus;
    }[];
  } = {},
) {
  const prisma = {
    booking: { groupBy: jest.fn().mockResolvedValue(rows.bookings ?? []) },
    queueEntry: {
      groupBy: jest
        .fn()
        .mockResolvedValueOnce(rows.queue ?? [])
        .mockResolvedValueOnce(rows.live ?? []),
    },
    salon: { findMany: jest.fn().mockResolvedValue(rows.salons ?? []) },
  };
  return {
    prisma,
    service: new AdminShopActivityService(prisma as unknown as PrismaService),
  };
}

const salon = (id: string, name: string) => ({
  id,
  publicId: `BC-${id}`,
  name,
  status: SalonStatus.ACTIVE,
});

describe('AdminShopActivityService', () => {
  it('filters bookings by appointment time and queue entries by join time across whole IST days', async () => {
    const { service, prisma } = makeService();
    await service.getActivity({ from: '2026-10-20', to: '2026-10-26' });

    // 2026-10-20 00:00 IST = 2026-10-19 18:30 UTC; the end is the start of 2026-10-27 IST.
    const window = {
      gte: new Date('2026-10-19T18:30:00.000Z'),
      lt: new Date('2026-10-26T18:30:00.000Z'),
    };
    expect(prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slotStart: window } }),
    );
    expect(prisma.queueEntry.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { joinedAt: window } }),
    );
    // "Live now" is the present moment, never date-filtered.
    expect(prisma.queueEntry.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          status: {
            in: [
              QueueEntryStatus.WAITING,
              QueueEntryStatus.CALLED,
              QueueEntryStatus.IN_SERVICE,
            ],
          },
        },
      }),
    );
  });

  it('breaks counts down per shop, totals them, and lists the busiest shop first', async () => {
    const { service } = makeService({
      bookings: [
        group('a', BookingStatus.CONFIRMED, 2),
        group('a', BookingStatus.COMPLETED, 3),
        group('a', BookingStatus.PENDING_PAYMENT, 1),
        group('b', BookingStatus.CANCELLED, 1),
        group('b', BookingStatus.NO_SHOW, 1),
      ],
      queue: [
        group('b', QueueEntryStatus.COMPLETED, 4),
        group('b', QueueEntryStatus.NO_SHOW, 1),
        group('b', QueueEntryStatus.EXPIRED, 1),
        group('b', QueueEntryStatus.WAITING, 2),
      ],
      live: [group('b', null, 2), group('c', null, 1)],
      salons: [salon('a', 'Alpha'), salon('b', 'Bravo'), salon('c', 'Charlie')],
    });

    const result = await service.getActivity({
      from: '2026-10-26',
      to: '2026-10-26',
    });

    expect(result.timeZone).toBe('Asia/Kolkata');
    expect(result.bookings).toEqual({
      total: 8,
      confirmed: 2,
      completed: 3,
      cancelled: 1,
      noShow: 1,
    });
    expect(result.queue).toEqual({
      joined: 8,
      served: 4,
      dropped: 2,
      liveNow: 3,
    });
    expect(result.shops.map((s) => s.name)).toEqual([
      'Bravo',
      'Alpha',
      'Charlie',
    ]);
    expect(result.shops[0]).toMatchObject({
      id: 'b',
      publicId: 'BC-b',
      bookings: {
        total: 2,
        confirmed: 0,
        completed: 0,
        cancelled: 1,
        noShow: 1,
      },
      queue: { joined: 8, served: 4, dropped: 2, liveNow: 2 },
    });
    expect(result.shops[1].bookings).toEqual({
      total: 6,
      confirmed: 2,
      completed: 3,
      cancelled: 0,
      noShow: 0,
    });
    expect(result.shops[2].queue).toEqual({
      joined: 0,
      served: 0,
      dropped: 0,
      liveNow: 1,
    });
  });

  it('returns zero totals and skips the shop lookup when nothing happened', async () => {
    const { service, prisma } = makeService();
    const result = await service.getActivity({
      from: '2026-10-26',
      to: '2026-10-26',
    });
    expect(result.shops).toEqual([]);
    expect(result.bookings.total).toBe(0);
    expect(result.queue.liveNow).toBe(0);
    expect(prisma.salon.findMany).not.toHaveBeenCalled();
  });
});

describe('adminShopActivityQuerySchema', () => {
  const parse = (from: string, to: string) =>
    adminShopActivityQuerySchema.safeParse({ from, to }).success;

  it('accepts a single day and a range up to the cap', () => {
    expect(parse('2026-10-26', '2026-10-26')).toBe(true);
    expect(parse('2026-08-01', '2026-10-31')).toBe(
      ADMIN_SHOP_ACTIVITY_MAX_DAYS >= 92,
    );
  });

  it('rejects malformed or impossible dates, reversed ranges and ranges over the cap', () => {
    expect(parse('26-10-2026', '2026-10-26')).toBe(false);
    expect(parse('2026-02-30', '2026-03-01')).toBe(false);
    expect(parse('2026-10-27', '2026-10-26')).toBe(false);
    expect(parse('2026-01-01', '2026-10-26')).toBe(false);
  });
});
