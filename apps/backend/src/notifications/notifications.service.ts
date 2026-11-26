import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationStatus,
  type NotificationChannelPreferenceDto,
  type NotificationDto,
  type NotificationPreferencesDto,
  type NotificationType,
  type PaginatedResult,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_PAGE_SIZE = 20;

// Every NotificationType maps to exactly one category — see NotificationCategory's own doc
// comment in schema.prisma. A type missing here is a bug (the TS types keep this exhaustive since
// TYPE_CATEGORY is declared as Record<NotificationType, ...>).
const TYPE_CATEGORY: Record<NotificationType, NotificationCategory> = {
  'booking.confirmed': NotificationCategory.BOOKING_UPDATES,
  'booking.cancelled': NotificationCategory.BOOKING_UPDATES,
  'booking.no_show': NotificationCategory.BOOKING_UPDATES,
  'booking.expired': NotificationCategory.BOOKING_UPDATES,
  'booking.reminder': NotificationCategory.REMINDERS,
  'booking.corrected': NotificationCategory.BOOKING_UPDATES,
  'queue.turn_approaching': NotificationCategory.QUEUE_UPDATES,
  'queue.arrival_check': NotificationCategory.QUEUE_UPDATES,
  'owner.booking.created': NotificationCategory.BOOKING_UPDATES,
  'owner.booking.cancelled': NotificationCategory.BOOKING_UPDATES,
  'owner.booking.no_show': NotificationCategory.BOOKING_UPDATES,
  'owner.booking.expired': NotificationCategory.BOOKING_UPDATES,
  'owner.walk_in.joined': NotificationCategory.QUEUE_UPDATES,
  'staff.assigned': NotificationCategory.QUEUE_UPDATES,
  'owner.booking.arrival_check': NotificationCategory.BOOKING_UPDATES,
  'booking.cancelled_by_shop': NotificationCategory.BOOKING_UPDATES,
  'booking.rescheduled_by_shop': NotificationCategory.BOOKING_UPDATES,
  // Inventory Phase 3 — stock reminders for the owner (no inventory category exists yet).
  'owner.inventory.reorder': NotificationCategory.REMINDERS,
  'owner.inventory.expiring': NotificationCategory.REMINDERS,
  // Salon onboarding workflow notices are operational, so they ride the default-on category.
  'onboarding.submitted': NotificationCategory.BOOKING_UPDATES,
  'onboarding.changes_requested': NotificationCategory.BOOKING_UPDATES,
  'onboarding.approved': NotificationCategory.BOOKING_UPDATES,
  'onboarding.rejected': NotificationCategory.BOOKING_UPDATES,
  'onboarding.owner_activated': NotificationCategory.BOOKING_UPDATES,
  'onboarding.published': NotificationCategory.BOOKING_UPDATES,
  // FastQue Work: assignments are the marketplace's bookings, so they share that preference.
  'work.assignment.accepted': NotificationCategory.BOOKING_UPDATES,
  'work.offer.received': NotificationCategory.BOOKING_UPDATES,
  'work.submission.received': NotificationCategory.BOOKING_UPDATES,
  'work.submission.approved': NotificationCategory.BOOKING_UPDATES,
  'work.rework.requested': NotificationCategory.BOOKING_UPDATES,
  'work.payout.sent': NotificationCategory.BOOKING_UPDATES,
  'work.payout.failed': NotificationCategory.BOOKING_UPDATES,
  'work.dispute.updated': NotificationCategory.BOOKING_UPDATES,
  'home.booking.update': NotificationCategory.BOOKING_UPDATES,
  'home.professional.update': NotificationCategory.BOOKING_UPDATES,
  'home.provider.update': NotificationCategory.BOOKING_UPDATES,
  'commerce.order.updated': NotificationCategory.BOOKING_UPDATES,
  'commerce.return.updated': NotificationCategory.BOOKING_UPDATES,
  'commerce.ticket.updated': NotificationCategory.BOOKING_UPDATES,
  'commerce.stock.alert': NotificationCategory.BOOKING_UPDATES,
  'shop.order.updated': NotificationCategory.BOOKING_UPDATES,
};

// ---------- Auto-expiry (live-visit add-on mission, 17 Nov 2026) ----------
// Owner rule: "after crossing the service time, all notification should auto expire. Never ever send
// the expired notification on customer and owner devices." These types announce something about ONE
// upcoming/ongoing visit; once that visit is over they are hidden from the notification centre and
// the unread badge (rows are kept, never deleted). Outcome notices written after the visit (no-show,
// expired, corrected) and inventory reminders are not in these lists, so they always stay.
/** Retired once the linked queue visit (payload.queueEntryId) is completed/cancelled/no-show/expired. */
export const QUEUE_VISIT_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'queue.turn_approaching',
  'queue.arrival_check',
  'owner.walk_in.joined',
  'staff.assigned',
];
/** Retired once the linked booking (payload.bookingId) has ended (slotEnd passed) or is closed. */
export const BOOKING_VISIT_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'booking.confirmed',
  'booking.reminder',
  'booking.cancelled',
  'booking.cancelled_by_shop',
  'booking.rescheduled_by_shop',
  'owner.booking.created',
  'owner.booking.cancelled',
  'owner.booking.arrival_check',
];
// A queue-visit notice from before queueEntryId was recorded in its payload can't be matched to a
// visit; no Live Queue visit outlives a working day, so it retires after this many hours.
const UNLINKED_QUEUE_NOTICE_MAX_AGE_HOURS = 12;

/**
 * SQL predicate (alias `n`) that is TRUE while a notification is still current. Ids in the payload
 * are compared as text; a payload without the id simply never matches the EXISTS (stays visible),
 * except the unlinked-queue-notice age rule above. Timestamp columns are TIMESTAMP(3) holding UTC,
 * so "now" is taken in UTC explicitly (correct whatever the session time zone is).
 */
function stillCurrentSql(): Prisma.Sql {
  // CRM 2.0 notifications ("crm.*") belong to the employee CRM's own inbox, not this list.
  return Prisma.sql`n."type" NOT LIKE 'crm.%' AND NOT (
      n."type" IN (${Prisma.join([...QUEUE_VISIT_NOTIFICATION_TYPES])})
      AND (
        EXISTS (
          SELECT 1 FROM "queue_entries" q
          WHERE q."id" = n."payload"->>'queueEntryId'
            AND q."status"::text IN ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')
        )
        OR (
          (n."payload"->>'queueEntryId') IS NULL
          AND n."createdAt" < (NOW() AT TIME ZONE 'UTC') - (${UNLINKED_QUEUE_NOTICE_MAX_AGE_HOURS} * INTERVAL '1 hour')
        )
      )
    )
    AND NOT (
      n."type" IN (${Prisma.join([...BOOKING_VISIT_NOTIFICATION_TYPES])})
      AND EXISTS (
        SELECT 1 FROM "bookings" b
        WHERE b."id" = n."payload"->>'bookingId'
          AND (
            b."slotEnd" <= (NOW() AT TIME ZONE 'UTC')
            OR b."status"::text IN ('COMPLETED', 'NO_SHOW', 'EXPIRED')
          )
      )
    )`;
}

const ALL_CATEGORIES: NotificationCategory[] = [
  NotificationCategory.BOOKING_UPDATES,
  NotificationCategory.QUEUE_UPDATES,
  NotificationCategory.REMINDERS,
  NotificationCategory.PROMOTIONAL,
];
const ALL_CHANNELS: NotificationChannel[] = [
  NotificationChannel.IN_APP,
  NotificationChannel.PUSH,
  NotificationChannel.EMAIL,
  NotificationChannel.SMS,
  NotificationChannel.WHATSAPP,
];
// Native PUSH is now a configured provider alongside the in-app notification center. Email/SMS/
// WhatsApp remain unavailable until their delivery providers are wired. This is the single source
// of truth for getPreferences()'s `available` field; each channel is gated independently by its
// own preference row.
const AVAILABLE_CHANNELS = new Set<NotificationChannel>([
  NotificationChannel.IN_APP,
  NotificationChannel.PUSH,
]);

/**
 * Notification Center (Phase 11) — reuses the existing Notification model (channel/type/payload/
 * status already existed for outbound SMS/PUSH/EMAIL delivery attempts) rather than building a
 * parallel system, per the mission's explicit instruction. Every IN_APP row is created already
 * SENT (there is nothing to fail to deliver) and starts unread (readAt: null).
 *
 * Injected directly into whichever service actually knows a notification-worthy event just
 * happened (BookingsService, QueueService, ...) rather than listening for realtime socket events —
 * a notification must exist even for a user who wasn't connected when the event fired.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(
    userId: string,
    type: NotificationType,
    payload?: Record<string, unknown>,
    deepLink?: string,
  ): Promise<boolean> {
    return this.notifyWithDb(this.prisma, userId, type, payload, deepLink);
  }

  /** Used when the event marker and notification must commit together (appointment reminders).
   * Keeping the preference read and notification insert on the caller's transaction prevents a
   * claimed reminder from being lost when insertion fails. */
  async notifyInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    type: NotificationType,
    payload?: Record<string, unknown>,
    deepLink?: string,
  ): Promise<boolean> {
    return this.notifyWithDb(tx, userId, type, payload, deepLink);
  }

  private async notifyWithDb(
    db: PrismaService | Prisma.TransactionClient,
    userId: string,
    type: NotificationType,
    payload?: Record<string, unknown>,
    deepLink?: string,
  ): Promise<boolean> {
    const category = TYPE_CATEGORY[type];
    const enabled = await this.isEnabled(
      db,
      userId,
      category,
      NotificationChannel.IN_APP,
    );
    if (!enabled) return false;

    await db.notification.create({
      data: {
        userId,
        channel: NotificationChannel.IN_APP,
        type,
        payload: payload as Prisma.InputJsonValue | undefined,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        deepLink: deepLink ?? null,
      },
    });
    return true;
  }

  /**
   * Newest first, expired visit notices left out (see stillCurrentSql). Keyset pagination on
   * (createdAt, id); `cursor` is still the id of the last item of the previous page, so the API and
   * every client are unchanged. An unknown cursor yields an empty page rather than restarting.
   */
  async listMine(
    userId: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<PaginatedResult<NotificationDto>> {
    let after: Prisma.Sql = Prisma.empty;
    if (cursor) {
      const anchor = await this.prisma.notification.findFirst({
        where: { id: cursor, userId, channel: NotificationChannel.IN_APP },
        select: { id: true },
      });
      if (!anchor) return { items: [], nextCursor: null };
      // Compared in SQL against the anchor row itself (no timestamp round-trip through JS).
      after = Prisma.sql`AND (n."createdAt", n."id") < (
        SELECT a."createdAt", a."id" FROM "notifications" a WHERE a."id" = ${anchor.id}
      )`;
    }
    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT n."id"
      FROM "notifications" n
      WHERE n."userId" = ${userId}
        AND n."channel"::text = ${NotificationChannel.IN_APP}
        AND ${stillCurrentSql()}
        ${after}
      ORDER BY n."createdAt" DESC, n."id" DESC
      LIMIT ${limit + 1}
    `);
    const hasMore = idRows.length > limit;
    const pageIds = (hasMore ? idRows.slice(0, limit) : idRows).map((r) => r.id);
    if (pageIds.length === 0) return { items: [], nextCursor: null };
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: pageIds } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const page = pageIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: hasMore ? pageIds[pageIds.length - 1] : null,
    };
  }

  /** The unread badge: unread IN_APP notifications that are still current. */
  async unreadCount(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM "notifications" n
      WHERE n."userId" = ${userId}
        AND n."channel"::text = ${NotificationChannel.IN_APP}
        AND n."readAt" IS NULL
        AND ${stillCurrentSql()}
    `);
    return Number(rows[0]?.count ?? 0);
  }

  /** Scoped by userId in the WHERE, not just the id — a no-op (not an error) if the notification
   * doesn't belong to this user or doesn't exist, so this can never be used to probe other users'
   * notification ids. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId,
        channel: NotificationChannel.IN_APP,
      },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** No stored row = default enabled (see NotificationPreference's schema.prisma doc comment) —
   * an unconfigured channel/category the user never touched behaves exactly like the mission's
   * default expectations, not "silently off." */
  private async isEnabled(
    db: PrismaService | Prisma.TransactionClient,
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const row = await db.notificationPreference.findUnique({
      where: { userId_category_channel: { userId, category, channel } },
    });
    return row?.enabled ?? true;
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });
    const byKey = new Map(
      rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]),
    );

    return {
      categories: ALL_CATEGORIES.map((category) => ({
        category,
        channels: ALL_CHANNELS.map(
          (channel): NotificationChannelPreferenceDto => ({
            channel,
            enabled: byKey.get(`${category}:${channel}`) ?? true,
            available: AVAILABLE_CHANNELS.has(channel),
          }),
        ),
      })),
    };
  }

  async setPreference(
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<NotificationPreferencesDto> {
    await this.prisma.notificationPreference.upsert({
      where: { userId_category_channel: { userId, category, channel } },
      update: { enabled },
      create: { userId, category, channel, enabled },
    });
    return this.getPreferences(userId);
  }

  private toDto(row: {
    id: string;
    type: string;
    payload: Prisma.JsonValue;
    deepLink: string | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      type: row.type as NotificationType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      deepLink: row.deepLink,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
