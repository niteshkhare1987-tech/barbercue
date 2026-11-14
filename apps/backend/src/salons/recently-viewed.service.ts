import { HttpStatus, Injectable } from '@nestjs/common';
import {
  RECENTLY_VIEWED_DEFAULT_LIMIT,
  SalonStatus,
  type RecentSalonDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';
import { SalonsService } from './salons.service';

/** Per-customer cap, configurable with RECENTLY_VIEWED_LIMIT (1–100). */
export function recentlyViewedLimit(
  raw: string | undefined = process.env.RECENTLY_VIEWED_LIMIT,
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed)) return RECENTLY_VIEWED_DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), 100);
}

/**
 * Customer dashboard "Recently viewed". Private to the signed-in customer: every query is scoped
 * by userId, there is no owner/admin read path, and rows are deleted with the account.
 */
@Injectable()
export class RecentlyViewedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salons: SalonsService,
  ) {}

  async list(userId: string): Promise<RecentSalonDto[]> {
    const rows = await this.prisma.customerRecentSalonView.findMany({
      where: { userId, salon: { status: SalonStatus.ACTIVE } },
      orderBy: { viewedAt: 'desc' },
      take: recentlyViewedLimit(),
      select: { salonId: true, viewedAt: true },
    });
    const items = await this.salons.listItemsByIds(rows.map((r) => r.salonId));
    const viewedAt = new Map(
      rows.map((r) => [r.salonId, r.viewedAt.toISOString()]),
    );
    return items.map((item) => ({ ...item, viewedAt: viewedAt.get(item.id)! }));
  }

  /** Records (or bumps) one view, then prunes the customer's history to the cap. Idempotent. */
  async record(userId: string, salonId: string): Promise<{ salonId: string }> {
    const salon = await this.prisma.salon.findFirst({
      where: { id: salonId, status: SalonStatus.ACTIVE },
      select: { id: true },
    });
    if (!salon) {
      throw new AppException(
        'SALON_NOT_FOUND',
        'That shop is not available.',
        HttpStatus.NOT_FOUND,
      );
    }
    const now = new Date();
    await this.prisma.customerRecentSalonView.upsert({
      where: { userId_salonId: { userId, salonId } },
      create: { userId, salonId, viewedAt: now },
      update: { viewedAt: now },
    });
    const stale = await this.prisma.customerRecentSalonView.findMany({
      where: { userId },
      orderBy: { viewedAt: 'desc' },
      skip: recentlyViewedLimit(),
      select: { id: true },
    });
    if (stale.length > 0) {
      await this.prisma.customerRecentSalonView.deleteMany({
        where: { userId, id: { in: stale.map((s) => s.id) } },
      });
    }
    return { salonId };
  }

  async remove(userId: string, salonId: string): Promise<{ salonId: string }> {
    await this.prisma.customerRecentSalonView.deleteMany({
      where: { userId, salonId },
    });
    return { salonId };
  }

  async clear(userId: string): Promise<{ cleared: number }> {
    const result = await this.prisma.customerRecentSalonView.deleteMany({
      where: { userId },
    });
    return { cleared: result.count };
  }
}
