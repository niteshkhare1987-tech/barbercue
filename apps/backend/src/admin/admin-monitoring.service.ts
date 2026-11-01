import { Injectable } from '@nestjs/common';
import {
  CustomerSubscriptionStatus,
  QueueEntryStatus,
  Role,
  summarizeServiceNames,
  type PlatformAdminOverviewDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEffectiveBookingServices } from '../bookings/effective-booking-services';

const MONITORING_LIMIT = 100;
const RECENT_ACTIVITY_LIMIT = 50;
const LIVE_QUEUE_STATUSES = [
  QueueEntryStatus.WAITING,
  QueueEntryStatus.CALLED,
  QueueEntryStatus.IN_SERVICE,
];

function maskEmail(value: string | null): string | null {
  if (!value) return value;
  const [local, domain] = value.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}***@${domain}`;
}

export function maskPhone(value: string | null): string | null {
  if (!value) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  const suffix = digits.slice(-2);
  const prefix = value.trim().startsWith('+') ? '+' : '';
  return `${prefix}******${suffix}`;
}

/** Bounded, read-only operational snapshot. No auth internals or credentials are selected. */
@Injectable()
export class AdminMonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(
    options: { maskPii?: boolean } = {},
  ): Promise<PlatformAdminOverviewDto> {
    const maskPii = options.maskPii === true;
    const now = new Date();
    const [
      shopCount,
      ownerCount,
      staffUserCount,
      customerCount,
      bookingCount,
      liveQueueCount,
      premiumCount,
      visitorStats,
      shops,
      staff,
      customers,
      recentBookings,
      recentQueue,
      premiumSubscriptions,
    ] = await Promise.all([
      this.prisma.salon.count(),
      this.prisma.user.count({
        where: { roles: { some: { role: Role.SALON_OWNER } } },
      }),
      this.prisma.user.count({
        where: { roles: { some: { role: Role.SALON_STAFF } } },
      }),
      this.prisma.user.count({
        where: { roles: { some: { role: Role.CUSTOMER } } },
      }),
      this.prisma.booking.count(),
      this.prisma.queueEntry.count({
        where: { status: { in: LIVE_QUEUE_STATUSES } },
      }),
      this.prisma.customerSubscription.count({
        where: {
          status: CustomerSubscriptionStatus.ACTIVE,
          periodEnd: { gt: now },
        },
      }),
      this.prisma.siteVisitor.aggregate({
        _count: { _all: true },
        _min: { firstSeenAt: true },
      }),
      this.prisma.salon.findMany({
        take: MONITORING_LIMIT,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { email: true, phone: true } },
          _count: {
            select: {
              staff: true,
              bookings: true,
              queueEntries: { where: { status: { in: LIVE_QUEUE_STATUSES } } },
            },
          },
        },
      }),
      this.prisma.salonStaff.findMany({
        take: MONITORING_LIMIT,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { email: true, phone: true } },
          salon: { select: { name: true, publicId: true } },
        },
      }),
      this.prisma.user.findMany({
        where: { roles: { some: { role: Role.CUSTOMER } } },
        take: MONITORING_LIMIT,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true,
          _count: { select: { bookings: true, queueEntries: true } },
          premiumSubscriptions: {
            where: {
              status: CustomerSubscriptionStatus.ACTIVE,
              periodEnd: { gt: now },
            },
            select: { id: true },
            take: 1,
          },
        },
      }),
      this.prisma.booking.findMany({
        take: RECENT_ACTIVITY_LIMIT,
        orderBy: { createdAt: 'desc' },
        include: {
          salon: { select: { name: true } },
          service: {
            select: { name: true, durationMinutes: true, price: true },
          },
          services: { orderBy: { sortOrder: 'asc' } },
          customer: { select: { email: true, phone: true } },
        },
      }),
      this.prisma.queueEntry.findMany({
        take: RECENT_ACTIVITY_LIMIT,
        orderBy: { joinedAt: 'desc' },
        include: {
          salon: { select: { name: true } },
          service: { select: { name: true } },
          customer: { select: { phone: true } },
          assignedStaff: { select: { displayName: true } },
          assignedChair: { select: { label: true } },
        },
      }),
      this.prisma.customerSubscription.findMany({
        take: RECENT_ACTIVITY_LIMIT,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { email: true, phone: true } },
          plan: { select: { name: true } },
        },
      }),
    ]);

    return {
      generatedAt: now.toISOString(),
      visitorTrackingStartedAt:
        visitorStats._min.firstSeenAt?.toISOString() ?? null,
      counts: {
        shops: shopCount,
        owners: ownerCount,
        staff: staffUserCount,
        customers: customerCount,
        bookings: bookingCount,
        websiteVisitors: visitorStats._count._all,
        liveQueueEntries: liveQueueCount,
        activePremiumSubscriptions: premiumCount,
      },
      shops: shops.map((shop) => ({
        id: shop.id,
        publicId: shop.publicId,
        name: shop.name,
        status: shop.status,
        subscriptionStatus: shop.subscriptionStatus,
        ownerEmail: maskPii ? maskEmail(shop.owner.email) : shop.owner.email,
        ownerPhone: maskPii ? maskPhone(shop.owner.phone) : shop.owner.phone,
        staffCount: shop._count.staff,
        bookingCount: shop._count.bookings,
        liveQueueCount: shop._count.queueEntries,
        createdAt: shop.createdAt.toISOString(),
      })),
      staff: staff.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        status: member.status,
        salonName: member.salon.name,
        salonPublicId: member.salon.publicId,
        email: maskPii ? maskEmail(member.user.email) : member.user.email,
        phone: maskPii ? maskPhone(member.user.phone) : member.user.phone,
      })),
      customers: customers.map((customer) => ({
        id: customer.id,
        status: customer.status,
        email: maskPii ? maskEmail(customer.email) : customer.email,
        phone: maskPii ? maskPhone(customer.phone) : customer.phone,
        bookingCount: customer._count.bookings,
        queueEntryCount: customer._count.queueEntries,
        isPremium: customer.premiumSubscriptions.length > 0,
        createdAt: customer.createdAt.toISOString(),
      })),
      recentBookings: recentBookings.map((booking) => ({
        id: booking.id,
        status: booking.status,
        slotStart: booking.slotStart.toISOString(),
        salonName: booking.salon.name,
        serviceName: summarizeServiceNames(
          resolveEffectiveBookingServices(booking).map(
            (service) => service.serviceName,
          ),
        ),
        // An IN_SHOP appointment has no account (customer is null): the guest contact is shown
        // only through the same masking rules and never invented.
        customerEmail: maskPii
          ? maskEmail(booking.customer?.email ?? null)
          : (booking.customer?.email ?? null),
        customerPhone: maskPii
          ? maskPhone(booking.customer?.phone ?? booking.guestPhone ?? null)
          : (booking.customer?.phone ?? booking.guestPhone ?? null),
      })),
      recentQueue: recentQueue.map((entry) => ({
        id: entry.id,
        tokenNumber: entry.tokenNumber,
        status: entry.status,
        joinedAt: entry.joinedAt.toISOString(),
        salonName: entry.salon.name,
        serviceName: entry.service?.name ?? null,
        customerPhone: maskPii
          ? maskPhone(entry.customer?.phone ?? null)
          : (entry.customer?.phone ?? null),
        assignedStaffName: entry.assignedStaff?.displayName ?? null,
        assignedChairLabel: entry.assignedChair?.label ?? null,
      })),
      premiumSubscriptions: premiumSubscriptions.map((subscription) => ({
        id: subscription.id,
        status: subscription.status,
        planName: subscription.plan.name,
        periodEnd: subscription.periodEnd.toISOString(),
        customerEmail: maskPii
          ? maskEmail(subscription.user.email)
          : subscription.user.email,
        customerPhone: maskPii
          ? maskPhone(subscription.user.phone)
          : subscription.user.phone,
      })),
    };
  }
}
