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
};

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

  async listMine(
    userId: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<PaginatedResult<NotificationDto>> {
    const rows = await this.prisma.notification.findMany({
      where: { userId, channel: NotificationChannel.IN_APP },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
    });
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
