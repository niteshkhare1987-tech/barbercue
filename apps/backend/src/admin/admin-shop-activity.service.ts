import { Injectable } from '@nestjs/common';
import {
  BookingStatus,
  QueueEntryStatus,
  type AdminShopActivityCountsDto,
  type AdminShopActivityDto,
  type AdminShopActivityQuery,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { addZonedCalendarDays } from '../common/timezone/timezone';
import { localRange } from '../owner-ops/local-time';

// FastQue operates in India, so the admin date filter speaks IST calendar days.
export const ADMIN_SHOP_ACTIVITY_TIME_ZONE = 'Asia/Kolkata';

const LIVE_QUEUE_STATUSES = [
  QueueEntryStatus.WAITING,
  QueueEntryStatus.CALLED,
  QueueEntryStatus.IN_SERVICE,
];
const DROPPED_QUEUE_STATUSES: string[] = [
  QueueEntryStatus.NO_SHOW,
  QueueEntryStatus.CANCELLED,
  QueueEntryStatus.EXPIRED,
];

function emptyCounts(): AdminShopActivityCountsDto {
  return {
    bookings: { total: 0, confirmed: 0, completed: 0, cancelled: 0, noShow: 0 },
    queue: { joined: 0, served: 0, dropped: 0, liveNow: 0 },
  };
}

function addBooking(
  counts: AdminShopActivityCountsDto,
  status: string,
  n: number,
): void {
  counts.bookings.total += n;
  if (status === BookingStatus.CONFIRMED) counts.bookings.confirmed += n;
  else if (status === BookingStatus.COMPLETED) counts.bookings.completed += n;
  else if (status === BookingStatus.CANCELLED) counts.bookings.cancelled += n;
  else if (status === BookingStatus.NO_SHOW) counts.bookings.noShow += n;
}

function addQueue(
  counts: AdminShopActivityCountsDto,
  status: string,
  n: number,
): void {
  counts.queue.joined += n;
  if (status === QueueEntryStatus.COMPLETED) counts.queue.served += n;
  else if (DROPPED_QUEUE_STATUSES.includes(status)) counts.queue.dropped += n;
}

const activityOf = (c: AdminShopActivityCountsDto) =>
  c.bookings.total + c.queue.joined + c.queue.liveNow;

/** Read-only, count-only shop-wise activity for the platform admin dashboard. No PII. */
@Injectable()
export class AdminShopActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async getActivity(
    query: AdminShopActivityQuery,
  ): Promise<AdminShopActivityDto> {
    const range = localRange(
      query.from,
      addZonedCalendarDays(query.to, 1),
      ADMIN_SHOP_ACTIVITY_TIME_ZONE,
    );
    // Unreachable with a fixed zone and schema-validated dates; guarded rather than asserted.
    if (!range) throw new Error('Could not resolve the IST date range');

    const [bookingGroups, queueGroups, liveGroups] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['salonId', 'status'],
        where: { slotStart: { gte: range.start, lt: range.end } },
        _count: { _all: true },
      }),
      this.prisma.queueEntry.groupBy({
        by: ['salonId', 'status'],
        where: { joinedAt: { gte: range.start, lt: range.end } },
        _count: { _all: true },
      }),
      this.prisma.queueEntry.groupBy({
        by: ['salonId'],
        where: { status: { in: LIVE_QUEUE_STATUSES } },
        _count: { _all: true },
      }),
    ]);

    const totals = emptyCounts();
    const perShop = new Map<string, AdminShopActivityCountsDto>();
    const shopCounts = (salonId: string) => {
      let counts = perShop.get(salonId);
      if (!counts) {
        counts = emptyCounts();
        perShop.set(salonId, counts);
      }
      return counts;
    };

    for (const group of bookingGroups) {
      addBooking(shopCounts(group.salonId), group.status, group._count._all);
      addBooking(totals, group.status, group._count._all);
    }
    for (const group of queueGroups) {
      addQueue(shopCounts(group.salonId), group.status, group._count._all);
      addQueue(totals, group.status, group._count._all);
    }
    for (const group of liveGroups) {
      shopCounts(group.salonId).queue.liveNow += group._count._all;
      totals.queue.liveNow += group._count._all;
    }

    const salons = perShop.size
      ? await this.prisma.salon.findMany({
          where: { id: { in: [...perShop.keys()] } },
          select: { id: true, publicId: true, name: true, status: true },
        })
      : [];

    const shops = salons
      .map((salon) => ({ ...salon, ...perShop.get(salon.id)! }))
      .sort(
        (a, b) => activityOf(b) - activityOf(a) || a.name.localeCompare(b.name),
      );

    return {
      from: query.from,
      to: query.to,
      timeZone: ADMIN_SHOP_ACTIVITY_TIME_ZONE,
      generatedAt: new Date().toISOString(),
      ...totals,
      shops,
    };
  }
}
