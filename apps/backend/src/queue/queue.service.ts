import { BadRequestException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  BookingErrorCode,
  BookingStatus,
  ChairStatus,
  QueueEntrySource,
  QueueEntryStatus,
  QueueErrorCode,
  OwnerOpsErrorCode,
  ServiceSessionStatus,
  StaffMemberStatus,
  computeSlotCapacity,
  estimateWaitMinutes,
  estimateWaitRangeMinutes,
  isWaitAlertWorthy,
  queuePhaseOf,
  remainingSessionMinutes,
  TURN_APPROACHING_THRESHOLD_MINUTES,
  type AssignQueueEntryInput,
  type ReassignQueueEntryInput,
  type CapacitySummaryDto,
  type ChairOptionDto,
  type ServiceOptionDto,
  type CreateQueueCustomerInput,
  type DashboardQueueDto,
  type QueueEntryDetailDto,
  type QueueStatusDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { AvailabilityService } from '../bookings/availability.service';
import { ReservationService } from '../bookings/reservation.service';
import { resolveEffectiveBookingServices } from '../bookings/effective-booking-services';
import { zonedDayBounds } from '../common/timezone/timezone';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { QueueAutoAssignTrigger } from './queue-auto-assign.trigger';
import { ServiceCompletedHook } from './service-completed.hook';

// Allowed from 15 minutes before slotStart onward, no upper bound — the automatic no-show sweep
// that would otherwise cap lateness isn't built in this phase (see the plan's explicit scoping).
// Exported (Part 5 completion, arrival guidance): bookings.service.ts snapshots this exact value
// onto Booking.checkInOpensMinutesBefore at creation time, so a customer's "check in from HH:MM"
// guidance always matches what this service will actually accept — never a second, potentially
// drifting hardcoded copy.
export const EARLY_CHECKIN_WINDOW_MINUTES = 15;
// Same generous window as bookings.service.ts's TRANSACTION_OPTIONS, for the same reason (Neon
// serverless cold-start latency can exceed Prisma's default 5s interactive-transaction timeout).
const TRANSACTION_OPTIONS = { timeout: 15_000 };
// Used only when a queue entry has no service yet (an unspecified walk-in) — a reasonable
// salon-wide default rather than leaving the ETA uncomputed.
const DEFAULT_SERVICE_DURATION_MINUTES = 30;

// Selected on any QueueEntry.booking include so the combined (not just primary) service
// selection is always available for ETA/duration math and display — matches
// resolveEffectiveBookingServices' BookingWithServiceSnapshot shape exactly.
const bookingServiceSnapshotSelect = {
  serviceId: true,
  service: { select: { name: true, durationMinutes: true, price: true } },
  services: {
    select: {
      serviceId: true,
      serviceName: true,
      durationMinutes: true,
      price: true,
    },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.BookingSelect;

export const queueEntryDetailInclude = {
  service: { select: { name: true } },
  customer: { select: { phone: true } },
  assignedStaff: { select: { displayName: true } },
  assignedChair: { select: { label: true } },
  serviceSessions: {
    where: { status: ServiceSessionStatus.ACTIVE },
    select: { id: true },
    take: 1,
  },
  // Part 7 — preferredStaffId/preferredStaff alongside the existing service-snapshot fields, so
  // toDetailDto can surface the customer's own barber preference without a second query.
  booking: {
    select: {
      ...bookingServiceSnapshotSelect,
      preferredStaffId: true,
      preferredStaff: { select: { displayName: true } },
    },
  },
} satisfies Prisma.QueueEntryInclude;

type QueueEntryWithDetails = Prisma.QueueEntryGetPayload<{
  include: typeof queueEntryDetailInclude;
}>;

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly reservations: ReservationService,
    private readonly salonAccess: SalonAccessService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    // Optional so unit tests (and any context without the owner-operations module) are unaffected.
    @Optional() private readonly autoAssignTrigger?: QueueAutoAssignTrigger,
    // Inventory Phase 2: salon-approved automatic product deduction after a completed service.
    @Optional() private readonly serviceCompletedHook?: ServiceCompletedHook,
  ) {}

  /** Lets the automatic allocator react to anything that may have freed a barber/chair or added a
   * seatable customer. Fire-and-forget; never affects the caller (see QueueAutoAssignTrigger). */
  private triggerAutoAssign(salonId: string): void {
    this.autoAssignTrigger?.trigger(salonId);
  }

  // ---------- Customer-facing ----------

  async checkIn(
    customerId: string,
    bookingId: string,
  ): Promise<QueueEntryDetailDto> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, customerId },
    });
    if (!booking) {
      throw new AppException(
        BookingErrorCode.BOOKING_NOT_FOUND,
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.createArrivalQueueEntry(booking, customerId);
  }

  /**
   * P0 arrival-alert mission — the owner/staff-triggered twin of checkIn() above, reached from
   * the dashboard's ARRIVED confirmation instead of the customer's own self-check-in. Converges on
   * exactly the same QueueEntry-creation path (createArrivalQueueEntry), so a customer self-check-in
   * racing an operator's Mark Arrived click for the same booking can only ever produce one
   * QueueEntry — bookingId's unique index is the real backstop either way, matching requirement 9.
   */
  async arriveAsOperator(
    userId: string,
    bookingId: string,
  ): Promise<QueueEntryDetailDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) {
      throw new AppException(
        BookingErrorCode.BOOKING_NOT_FOUND,
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.salonAccess.assertAccessOrAdminAccess(userId, booking.salonId);
    return this.createArrivalQueueEntry(booking, booking.customerId);
  }

  private async createArrivalQueueEntry(
    booking: {
      id: string;
      salonId: string;
      slotStart: Date;
      status: BookingStatus;
      serviceId: string;
      // Owner-operations mission — an IN_SHOP appointment has no account: the guest's name/consented
      // phone travel onto the queue entry so staff see who has arrived (never a fabricated user).
      guestName?: string | null;
      guestPhone?: string | null;
      preferredStaffId?: string | null;
    },
    customerId: string | null,
  ): Promise<QueueEntryDetailDto> {
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'Only a confirmed booking can be checked in.',
        HttpStatus.CONFLICT,
      );
    }

    const existingForBooking = await this.prisma.queueEntry.findFirst({
      where: { bookingId: booking.id },
    });
    if (existingForBooking) {
      throw new AppException(
        QueueErrorCode.ALREADY_CHECKED_IN,
        'This booking has already been checked in.',
        HttpStatus.CONFLICT,
      );
    }

    if (customerId) await this.assertNotAlreadyInQueue(customerId);

    const earliestCheckIn =
      booking.slotStart.getTime() - EARLY_CHECKIN_WINDOW_MINUTES * 60_000;
    if (Date.now() < earliestCheckIn) {
      throw new AppException(
        QueueErrorCode.CHECK_IN_TOO_EARLY,
        `Check-in opens ${EARLY_CHECKIN_WINDOW_MINUTES} minutes before your appointment.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    let entryId: string;
    try {
      entryId = await this.prisma.$transaction(async (tx) => {
        const tokenNumber = await this.nextTokenNumber(tx, booking.salonId);
        const created = await tx.queueEntry.create({
          data: {
            salonId: booking.salonId,
            bookingId: booking.id,
            customerId,
            serviceId: booking.serviceId,
            source: QueueEntrySource.APPOINTMENT,
            tokenNumber,
            status: QueueEntryStatus.WAITING,
            ...(customerId === null
              ? {
                  contactName: booking.guestName ?? null,
                  contactPhone: booking.guestPhone ?? null,
                  preferredStaffId: booking.preferredStaffId ?? null,
                }
              : {}),
            // An appointment entry only exists because arrival was confirmed — by the customer's
            // own check-in or the owner's ARRIVED confirmation — so it is arrived from the start.
            arrivedAt: new Date(),
          },
        });
        return created.id;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      // The pre-check above (existingForBooking) is a fast, friendly-error common case, not the
      // actual guarantee — it reads outside any lock, so two concurrent check-ins for the same
      // booking can both pass it before either commits. QueueEntry.bookingId's unique index is
      // the real backstop; a P2002 here means we lost that race, not a system failure.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new AppException(
          QueueErrorCode.ALREADY_CHECKED_IN,
          'This booking has already been checked in.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }

    await this.recomputeEtas(booking.salonId);
    this.realtime.emitQueueUpdated(booking.salonId);
    this.triggerAutoAssign(booking.salonId);
    return this.getDetailOrThrow(entryId);
  }

  async joinWalkIn(
    customerId: string,
    salonId: string,
    serviceId?: string,
    contact?: { name?: string; phone?: string },
  ): Promise<QueueEntryDetailDto> {
    const salon = await this.availability.getSalonOrThrow(salonId);
    if (serviceId)
      await this.availability.getServiceOrThrow(salonId, serviceId);
    await this.assertNotAlreadyInQueue(customerId);

    // A queue entry must always be contactable by the shop. Prefer the number given with this join;
    // otherwise fall back to the account's own phone. Google-sign-in accounts have neither by
    // default, so refuse here rather than silently creating an entry nobody can reach.
    let contactPhone = contact?.phone ?? null;
    if (!contactPhone) {
      const account = await this.prisma.user.findUnique({
        where: { id: customerId },
        select: { phone: true },
      });
      contactPhone = account?.phone ?? null;
    }
    if (!contactPhone) {
      throw new AppException(
        QueueErrorCode.CONTACT_PHONE_REQUIRED,
        'A mobile number is required so the shop can reach you about your turn.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const entryId = await this.prisma.$transaction(async (tx) => {
      const tokenNumber = await this.nextTokenNumber(tx, salonId);
      const created = await tx.queueEntry.create({
        data: {
          salonId,
          customerId,
          serviceId: serviceId ?? null,
          source: QueueEntrySource.WALK_IN,
          tokenNumber,
          status: QueueEntryStatus.WAITING,
          contactName: contact?.name ?? null,
          contactPhone,
        },
      });
      return created.id;
    }, TRANSACTION_OPTIONS);

    await this.recomputeEtas(salonId);
    this.realtime.emitQueueUpdated(salonId);
    this.triggerAutoAssign(salonId);
    await this.notifications.notify(
      salon.ownerUserId,
      'owner.walk_in.joined',
      { salonId },
      `dashboard/salons/${salonId}/queue`,
    );
    return this.getDetailOrThrow(entryId);
  }

  /**
   * No account/Gmail/OTP required: this is an *unverified* walk-in reservation.
   * A bearer capability (never persisted in plaintext) scopes subsequent ticket reads/actions.
   * It cannot authenticate an existing account or prove telephone ownership.
   */
  async joinGuestWalkIn(
    salonId: string,
    serviceId: string,
    contactName: string,
    contactPhone: string,
  ): Promise<QueueEntryDetailDto & { guestAccessToken: string }> {
    const salon = await this.availability.getSalonOrThrow(salonId);
    await this.availability.getServiceOrThrow(salonId, serviceId);
    const guestAccessToken = randomBytes(32).toString('base64url');
    const guestAccessHash = createHash('sha256').update(guestAccessToken).digest('hex');
    const activeStatuses = [
      QueueEntryStatus.WAITING,
      QueueEntryStatus.CALLED,
      QueueEntryStatus.IN_SERVICE,
    ];
    const entryId = await this.prisma.$transaction(async (tx) => {
      // Serialize duplicate check and token allocation for this salon.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${salonId}))`);
      const existing = await tx.queueEntry.findFirst({
        where: { salonId, contactPhone, status: { in: activeStatuses } },
        select: { id: true },
      });
      if (existing) {
        throw new AppException(
          QueueErrorCode.ALREADY_IN_QUEUE,
          'This mobile number already has an active token at this shop.',
          HttpStatus.CONFLICT,
        );
      }
      const activeCount = await tx.queueEntry.count({
        where: { salonId, status: { in: activeStatuses } },
      });
      if (activeCount >= 80) {
        throw new BadRequestException('This Live Queue is at capacity; please contact the shop.');
      }
      const tokenNumber = await this.nextTokenNumber(tx, salonId);
      const row = await tx.queueEntry.create({
        data: {
          salonId,
          serviceId,
          source: QueueEntrySource.WALK_IN,
          tokenNumber,
          status: QueueEntryStatus.WAITING,
          contactName,
          contactPhone,
          guestAccessHash,
          guestAccessExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
        select: { id: true },
      });
      return row.id;
    }, TRANSACTION_OPTIONS);
    // After DB commit, owner notification/ETA provider errors must not destroy the
    // only response containing this guest's otherwise unrecoverable capability.
    try {
      await this.recomputeEtas(salonId);
    } catch (err) {
      this.logger.warn(`Guest queue ETA refresh deferred: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    this.realtime.emitQueueUpdated(salonId);
    this.triggerAutoAssign(salonId);
    try {
      await this.notifications.notify(
        salon.ownerUserId,
        'owner.walk_in.joined',
        { salonId },
        `dashboard/salons/${salonId}/queue`,
      );
    } catch (err) {
      this.logger.warn(`Guest join owner notification failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    return { ...(await this.getDetailOrThrow(entryId)), guestAccessToken };
  }

  private guestHash(guestAccessToken: string): string {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(guestAccessToken)) {
      throw new AppException(
        QueueErrorCode.QUEUE_ENTRY_NOT_FOUND,
        'Live Queue ticket not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return createHash('sha256').update(guestAccessToken).digest('hex');
  }

  async getGuestEntry(
    entryId: string,
    guestAccessToken: string,
  ): Promise<QueueEntryDetailDto> {
    const row = await this.prisma.queueEntry.findFirst({
      where: {
        id: entryId,
        guestAccessHash: this.guestHash(guestAccessToken),
        guestAccessExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!row) {
      throw new AppException(
        QueueErrorCode.QUEUE_ENTRY_NOT_FOUND,
        'Live Queue ticket not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.getDetailOrThrow(entryId);
  }

  async registerGuestPush(
    entryId: string, guestAccessToken: string, expoPushToken: string,
  ): Promise<{ registered: boolean }> {
    // Explicitly accepts Expo's public device-delivery token, never a raw FCM/APNs credential.
    if (!/^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]{10,240}\]$/.test(expoPushToken)) {
      throw new BadRequestException('Invalid Expo push token.');
    }
    await this.getGuestEntry(entryId, guestAccessToken);
    const claim = await this.prisma.queueEntry.updateMany({
      where: {
        id: entryId,
        guestAccessHash: this.guestHash(guestAccessToken),
        guestAccessExpiresAt: { gt: new Date() },
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
      },
      data: { guestExpoPushToken: expoPushToken },
    });
    return { registered: claim.count === 1 };
  }

  async cancelGuestEntry(entryId: string, guestAccessToken: string): Promise<QueueEntryDetailDto> {
    await this.getGuestEntry(entryId, guestAccessToken);
    const row = await this.prisma.queueEntry.findUniqueOrThrow({
      where: { id: entryId },
      select: { salonId: true },
    });
    const claim = await this.prisma.queueEntry.updateMany({
      where: {
        id: entryId,
        guestAccessHash: this.guestHash(guestAccessToken),
        guestAccessExpiresAt: { gt: new Date() },
        bookingId: null,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
      },
      data: { status: QueueEntryStatus.CANCELLED },
    });
    if (claim.count !== 1) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'This Live Queue ticket can no longer be cancelled.',
        HttpStatus.CONFLICT,
      );
    }
    await this.recomputeEtas(row.salonId);
    this.realtime.emitQueueUpdated(row.salonId);
    this.triggerAutoAssign(row.salonId);
    return this.getDetailOrThrow(entryId);
  }

  async respondArrival(
    entryId: string,
    choice: boolean,
    selector: { customerId?: string; guestAccessToken?: string },
  ): Promise<QueueEntryDetailDto> {
    const ownership = selector.customerId
      ? { customerId: selector.customerId }
      : {
          guestAccessHash: this.guestHash(selector.guestAccessToken ?? ''),
          guestAccessExpiresAt: { gt: new Date() },
        };
    const updated = await this.prisma.queueEntry.updateMany({
      where: {
        id: entryId,
        ...ownership,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
        arrivedAt: null,
        arrivalPromptSentAt: { not: null },
        customerArrivalResponseAt: null,
      },
      data: { customerArrivalResponse: choice, customerArrivalResponseAt: new Date() },
    });
    if (updated.count === 0) {
      // Do not reveal any ticket details to a caller without a valid bearer capability.
      const current = await this.prisma.queueEntry.findFirst({
        where: { id: entryId, ...ownership },
        select: { customerArrivalResponseAt: true },
      });
      if (!current) throw new AppException(QueueErrorCode.QUEUE_ENTRY_NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
      if (!current.customerArrivalResponseAt) {
        throw new AppException(QueueErrorCode.INVALID_QUEUE_TRANSITION, 'Arrival response is no longer available.', HttpStatus.CONFLICT);
      }
    }
    const row = await this.getDetailOrThrow(entryId);
    this.realtime.emitQueueUpdated(row.salonId);
    return row;
  }

  async getActiveForCustomer(
    customerId: string,
  ): Promise<QueueEntryDetailDto | null> {
    const existing = await this.prisma.queueEntry.findFirst({
      where: {
        customerId,
        status: {
          in: [
            QueueEntryStatus.WAITING,
            QueueEntryStatus.CALLED,
            QueueEntryStatus.IN_SERVICE,
          ],
        },
      },
      orderBy: { joinedAt: 'desc' },
    });
    if (!existing) return null;

    // Recompute on read, not only after a mutation elsewhere in the salon — a service quietly
    // overrunning its nominal duration would otherwise leave this customer staring at a stale
    // estimate until someone else's action happens to trigger a recompute (Phase 5's "don't
    // silently show stale times" requirement).
    if (existing.status === QueueEntryStatus.WAITING) {
      await this.recomputeEtas(existing.salonId);
    }

    const entry = await this.prisma.queueEntry.findUniqueOrThrow({
      where: { id: existing.id },
      include: queueEntryDetailInclude,
    });
    const position =
      entry.status === QueueEntryStatus.WAITING
        ? await this.computePosition(entry)
        : null;
    return this.toDetailDto(entry, position);
  }

  /**
   * Customer-initiated cancellation of a standalone Live Queue token. This must never
   * cancel an appointment/booking or interrupt a service already in progress.
   * Restrict both the lookup and the atomic claim to the authenticated customer.
   * The status predicate serializes safely against owner call/assign/start/cancel.
   */
  async cancelByCustomer(
    customerId: string,
    entryId: string,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.prisma.queueEntry.findFirst({
      where: { id: entryId, customerId, bookingId: null },
      select: { id: true, salonId: true, status: true },
    });
    if (!entry) {
      throw new AppException(
        QueueErrorCode.QUEUE_ENTRY_NOT_FOUND,
        'Live Queue entry not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    // Idempotent: a retry after a lost response, or a double tap / second device, must end in the
    // same CANCELLED state instead of telling the customer to "contact the shop" about a visit that
    // is already cancelled. No side effects are repeated.
    if (entry.status === QueueEntryStatus.CANCELLED) {
      return this.getDetailOrThrow(entryId);
    }
    if (
      entry.status !== QueueEntryStatus.WAITING &&
      entry.status !== QueueEntryStatus.CALLED
    ) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'This Live Queue token can no longer be cancelled. Please contact the shop.',
        HttpStatus.CONFLICT,
      );
    }

    // A concurrent call/assignment/start must not change an already-cancelled token,
    // and a cancellation must never override a started service.
    const claim = await this.prisma.queueEntry.updateMany({
      where: {
        id: entryId,
        customerId,
        bookingId: null,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
      },
      data: { status: QueueEntryStatus.CANCELLED },
    });
    if (claim.count !== 1) {
      // Lost a race. If another cancel of this same token won (double tap, two devices) the customer
      // already got what they asked for; anything else (e.g. the shop started the service) is a real
      // conflict and must be shown as one.
      const current = await this.prisma.queueEntry.findFirst({
        where: { id: entryId, customerId, bookingId: null },
        select: { status: true },
      });
      if (current?.status === QueueEntryStatus.CANCELLED) {
        return this.getDetailOrThrow(entryId);
      }
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'Your Live Queue status changed. Refresh and try again.',
        HttpStatus.CONFLICT,
      );
    }

    // Keep the row as an auditable CANCELLED visit, not a deleted/fabricated booking.
    // An assigned-but-not-started barber/chair is now free for the next customer.
    await this.recomputeEtas(entry.salonId);
    this.realtime.emitQueueUpdated(entry.salonId);
    this.triggerAutoAssign(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  // Public, no auth — a lightweight wait-time widget, deferred from Phase 3A/3B specifically to
  // this phase (see API.md's Discovery section).
  async getQueueStatus(salonId: string): Promise<QueueStatusDto> {
    await this.availability.getSalonOrThrow(salonId);
    const waitingCount = await this.prisma.queueEntry.count({
      where: { salonId, status: QueueEntryStatus.WAITING },
    });
    const [
      staffCount,
      chairCount,
      manualOccupiedCount,
      avgDuration,
      activeSessions,
    ] = await Promise.all([
      this.prisma.salonStaff.count({
        where: { salonId, status: StaffMemberStatus.ACTIVE },
      }),
      this.prisma.chair.count({
        where: { salonId, status: ChairStatus.ACTIVE },
      }),
      this.prisma.manualChairOccupancy.count({
        where: { salonId, endedAt: null },
      }),
      this.prisma.service.aggregate({
        where: { salonId, isActive: true },
        _avg: { durationMinutes: true },
      }),
      this.prisma.serviceSession.findMany({
        where: { status: ServiceSessionStatus.ACTIVE, chair: { salonId } },
        select: {
          startedAt: true,
          service: { select: { durationMinutes: true } },
        },
      }),
    ]);
    const serverCount = computeSlotCapacity(
      staffCount,
      Math.max(0, chairCount - manualOccupiedCount),
    );
    const avgServiceDurationMinutes =
      avgDuration._avg.durationMinutes ?? DEFAULT_SERVICE_DURATION_MINUTES;
    const activeRemaining = this.averageRemainingMinutes(activeSessions);
    const estimatedWaitMinutes = estimateWaitMinutes(
      serverCount,
      waitingCount,
      avgServiceDurationMinutes,
      activeRemaining,
    );
    return {
      salonId,
      waitingCount,
      estimatedWaitMinutes,
      estimatedWaitRangeMinutes: estimateWaitRangeMinutes(estimatedWaitMinutes),
    };
  }


  /**
   * Salon-scoped history for the Bookings screen. Standalone Live Queue visits are persisted as
   * queue_entries, NOT bookings: listing Booking alone hides them (including completed visits).
   * Exclude booking-linked check-ins to avoid rendering the same visit twice. No writes and no
   * dependence on the live dashboard's today-only snapshot or its ETA recomputation.
   */
  async getStandaloneQueueVisits(
    userId: string,
    salonId: string,
    filterRaw?: string,
    cursor?: string,
    limitRaw?: string,
  ): Promise<{ items: QueueEntryDetailDto[]; nextCursor: string | null }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const filter = filterRaw ?? 'all';
    if (!['today', 'upcoming', 'completed', 'cancelled', 'no_show', 'all'].includes(filter)) {
      throw new BadRequestException('Unknown queue visit filter.');
    }
    const parsedLimit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      throw new BadRequestException('limit must be an integer between 1 and 50.');
    }
    if (cursor && !/^[0-9a-fA-F-]{36}$/.test(cursor)) {
      throw new BadRequestException('Invalid queue visit cursor.');
    }
    // Queue visits have no future appointment slot; future bookings come from the Booking list.
    if (filter === 'upcoming') return { items: [], nextCursor: null };

    const where: Prisma.QueueEntryWhereInput = { salonId, bookingId: null };
    if (filter === 'completed') where.status = QueueEntryStatus.COMPLETED;
    if (filter === 'cancelled') {
      where.status = { in: [QueueEntryStatus.CANCELLED, QueueEntryStatus.EXPIRED] };
    }
    if (filter === 'no_show') where.status = QueueEntryStatus.NO_SHOW;
    if (filter === 'today') {
      const zone = await this.availability.getSalonTimeZone(salonId);
      const start = (zone ? zonedDayBounds(new Date(), zone)?.start : null)
        ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
      where.OR = [
        { joinedAt: { gte: start } },
        { status: QueueEntryStatus.COMPLETED, serviceCompletedAt: { gte: start } },
        {
          status: { in: [QueueEntryStatus.CANCELLED, QueueEntryStatus.EXPIRED, QueueEntryStatus.NO_SHOW] },
          updatedAt: { gte: start },
        },
      ];
    }
    const rows = await this.prisma.queueEntry.findMany({
      where,
      include: queueEntryDetailInclude,
      orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
      take: parsedLimit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > parsedLimit;
    const page = hasMore ? rows.slice(0, parsedLimit) : rows;
    return {
      items: page.map((row) => this.toDetailDto(row, null)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // ---------- Staff/owner dashboard ----------

  async getDashboardQueue(
    userId: string,
    salonId: string,
  ): Promise<DashboardQueueDto> {
    // Part 2 — delegated shop management. Read-only: no AuditLog write for a successful delegated
    // read, unlike the mutation methods below.
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);
    // Captured BEFORE any read: every snapshot is stamped with the instant its reads began, so a
    // client can safely discard an older snapshot that arrives after a newer one.
    const revision = Date.now();

    // Same freshness rationale as getActiveForCustomer above — the owner dashboard shouldn't show
    // a stale ETA for an overrunning service until some unrelated mutation happens to trigger one.
    await this.recomputeEtas(salonId);

    const entries = await this.prisma.queueEntry.findMany({
      where: {
        salonId,
        status: {
          in: [
            QueueEntryStatus.WAITING,
            QueueEntryStatus.CALLED,
            QueueEntryStatus.IN_SERVICE,
          ],
        },
      },
      include: queueEntryDetailInclude,
      orderBy: { joinedAt: 'asc' },
    });
    const waitingIds = entries
      .filter((e) => e.status === QueueEntryStatus.WAITING)
      .map((e) => e.id);
    const detailed = entries.map((e) =>
      this.toDetailDto(
        e,
        e.status === QueueEntryStatus.WAITING
          ? waitingIds.indexOf(e.id) + 1
          : null,
      ),
    );

    // Full roster (both statuses) — an ACTIVE-only filter would make an off-duty staff member
    // invisible here and unable to clock themselves back in via this same dashboard. The assign
    // action itself still separately re-validates ACTIVE + qualified via AvailabilityService.
    const [
      staffRoster,
      chairs,
      services,
      manualOccupancies,
      activeChairSessions,
    ] = await Promise.all([
      this.prisma.salonStaff.findMany({
        where: { salonId },
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.chair.findMany({
        where: { salonId, status: ChairStatus.ACTIVE },
        orderBy: { label: 'asc' },
      }),
      // Lets the assign form offer a service picker for a walk-in that joined without choosing
      // one — assign() rejects with SERVICE_REQUIRED in that case, and this is the only source
      // the frontend has for "what services does this salon even offer."
      this.prisma.service.findMany({
        where: { salonId, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.manualChairOccupancy.findMany({
        where: { salonId, endedAt: null },
        select: { id: true, chairId: true },
      }),
      this.prisma.serviceSession.findMany({
        where: { status: ServiceSessionStatus.ACTIVE, chair: { salonId } },
        select: {
          id: true,
          chairId: true,
          queueEntry: { select: { tokenNumber: true } },
          staff: { select: { displayName: true } },
        },
      }),
    ]);

    const manualByChair = new Map(
      manualOccupancies.map((row) => [row.chairId, row]),
    );
    const fastQueByChair = new Map(
      activeChairSessions.map((row) => [row.chairId, row]),
    );

    // Owner-operations mission - the finished/terminal side of "today", so completed visits and
    // cancelled/expired/no-show outcomes stay visible (and separate) instead of vanishing the
    // moment they leave the active states. "Today" is the salon's own calendar day (24h fallback
    // when no trustworthy timezone exists, never a guess at IST).
    const timeZone = await this.availability.getSalonTimeZone(salonId);
    const dayBounds = timeZone ? zonedDayBounds(new Date(), timeZone) : null;
    const dayStart =
      dayBounds?.start ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [completedRows, terminalRows, salonFlags] = await Promise.all([
      this.prisma.queueEntry.findMany({
        where: {
          salonId,
          status: QueueEntryStatus.COMPLETED,
          serviceCompletedAt: { gte: dayStart },
        },
        include: queueEntryDetailInclude,
        orderBy: { serviceCompletedAt: 'desc' },
        take: 100,
      }),
      this.prisma.queueEntry.findMany({
        where: {
          salonId,
          status: {
            in: [
              QueueEntryStatus.CANCELLED,
              QueueEntryStatus.EXPIRED,
              QueueEntryStatus.NO_SHOW,
            ],
          },
          updatedAt: { gte: dayStart },
        },
        include: queueEntryDetailInclude,
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      this.prisma.salon.findUnique({
        where: { id: salonId },
        select: { queueAutoAssignEnabled: true },
      }),
    ]);
    const completedToday = (completedRows ?? []).map((e) =>
      this.toDetailDto(e, null),
    );
    const historyToday = (terminalRows ?? []).map((e) =>
      this.toDetailDto(e, null),
    );
    const waiting = detailed.filter(
      (e) => e.status === QueueEntryStatus.WAITING,
    );
    // CALLED splits in two: called to the counter with no barber yet, and ASSIGNED (a barber and
    // chair are reserved but the service has not started). An assigned customer is neither waiting
    // for a barber nor in service.
    const called = detailed.filter((e) => queuePhaseOf(e) === 'CALLED');
    const assigned = detailed.filter((e) => queuePhaseOf(e) === 'ASSIGNED');
    const inService = detailed.filter(
      (e) => e.status === QueueEntryStatus.IN_SERVICE,
    );
    const reservedByChair = new Map(
      assigned
        .filter((e) => e.assignedChairId)
        .map((e) => [e.assignedChairId as string, e] as const),
    );

    // Part 9/18/19 — the derived, point-in-time answer to "can this person actually take a
    // customer right now," alongside (not instead of) their own working/clock-in `status`. Bounded
    // by this salon's own staff count (typically a handful), never an unbounded scan.
    const staffAvailability = await Promise.all(
      staffRoster.map((s) =>
        this.reservations.getStaffAvailabilityState(
          this.prisma,
          salonId,
          s.id,
          s.status === StaffMemberStatus.ACTIVE,
        ),
      ),
    );

    return {
      entries: detailed,
      revision,
      serverTime: new Date(revision).toISOString(),
      sections: {
        waiting,
        called,
        assigned,
        inService,
        completedToday,
        historyToday,
      },
      counts: {
        waiting: waiting.length,
        called: called.length,
        assigned: assigned.length,
        inService: inService.length,
        completedToday: completedToday.length,
        historyToday: historyToday.length,
      },
      autoAssignEnabled: salonFlags?.queueAutoAssignEnabled ?? true,
      staffRoster: staffRoster.map((s, i) => ({
        id: s.id,
        displayName: s.displayName,
        status: s.status,
        availabilityState: staffAvailability[i].availabilityState,
        busyUntil: staffAvailability[i].busyUntil?.toISOString() ?? null,
        nextBookingStart:
          staffAvailability[i].nextBookingStart?.toISOString() ?? null,
      })),
      chairs: chairs.map((c): ChairOptionDto => {
        const fastQue = fastQueByChair.get(c.id);
        const manual = manualByChair.get(c.id);
        return {
          id: c.id,
          label: c.label,
          occupancy: fastQue ? 'FASTQUE' : manual ? 'LOCAL' : 'FREE',
          manualOccupancyId: manual?.id ?? null,
          activeServiceSessionId: fastQue?.id ?? null,
          tokenNumber: fastQue?.queueEntry.tokenNumber ?? null,
          assignedStaffName: fastQue?.staff.displayName ?? null,
          reservedForEntryId: reservedByChair.get(c.id)?.id ?? null,
          reservedForTokenNumber:
            reservedByChair.get(c.id)?.tokenNumber ?? null,
        };
      }),
      services: services.map((s): ServiceOptionDto => ({
        id: s.id,
        name: s.name,
      })),
    };
  }

  /**
   * Owner Capacity Dashboard (Phase 6) — a small, decision-oriented operational summary ("what do
   * I do right now"), not a historical/trend report (that's Phase 9's job). "Busy" chairs/staff
   * are whichever ones are attached to a currently-ACTIVE ServiceSession; "available" is
   * active-minus-busy. today/upcoming booking counts are computed in the salon's own IANA
   * timezone and come back null (not a fabricated 0) when it has none set — this is a live
   * operational snapshot, so the rest of it (chairs, staff, queue) stays usable either way rather
   * than failing the whole endpoint over an unset timezone.
   */
  async getCapacitySummary(
    userId: string,
    salonId: string,
  ): Promise<CapacitySummaryDto> {
    // Part 2 — delegated shop management. Read-only, same as getDashboardQueue above.
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);

    const timeZone = await this.availability.getSalonTimeZone(salonId);
    const bounds = timeZone ? zonedDayBounds(new Date(), timeZone) : null;
    const now = new Date();

    const [
      chairs,
      staff,
      activeSessions,
      activeManualOccupancies,
      reservedStaffRows,
      waitingCount,
      queueSize,
      waitingEstimates,
      todaysBookings,
      upcomingBookings,
      assignedHolds,
    ] = await Promise.all([
      this.prisma.chair.findMany({
        where: { salonId },
        select: { id: true, status: true },
      }),
      this.prisma.salonStaff.findMany({
        where: { salonId },
        select: { id: true, status: true },
      }),
      this.prisma.serviceSession.findMany({
        where: { status: ServiceSessionStatus.ACTIVE, chair: { salonId } },
        select: { chairId: true, staffId: true },
      }),
      this.prisma.manualChairOccupancy.findMany({
        where: { salonId, endedAt: null },
        select: { chairId: true },
      }),
      // Part 11 — a named barber whose appointment reservation is active RIGHT NOW must count as
      // busy even before any ServiceSession exists for them (e.g. the appointment hasn't checked
      // in yet, or checked in without staff having assigned a chair). Deduped against
      // activeSessions below via a Set, so a barber with both a reservation and an active session
      // for the same appointment is counted once, not twice.
      this.prisma.booking.findMany({
        where: {
          salonId,
          preferredStaffId: { not: null },
          ...this.reservations.reservingBookingWhere(),
          slotStart: { lt: new Date(now.getTime() + 1) },
          slotEnd: { gt: now },
        },
        select: { preferredStaffId: true },
      }),
      this.prisma.queueEntry.count({
        where: { salonId, status: QueueEntryStatus.WAITING },
      }),
      this.prisma.queueEntry.count({
        where: {
          salonId,
          status: {
            in: [
              QueueEntryStatus.WAITING,
              QueueEntryStatus.CALLED,
              QueueEntryStatus.IN_SERVICE,
            ],
          },
        },
      }),
      this.prisma.queueEntry.findMany({
        where: { salonId, status: QueueEntryStatus.WAITING },
        select: { estimatedWaitMinutes: true },
      }),
      bounds
        ? this.prisma.booking.count({
            where: {
              salonId,
              slotStart: { gte: bounds.start, lt: bounds.end },
            },
          })
        : Promise.resolve(null),
      bounds
        ? this.prisma.booking.count({
            where: {
              salonId,
              slotStart: { gte: bounds.end },
              status: {
                in: [BookingStatus.CONFIRMED, BookingStatus.PENDING_PAYMENT],
              },
            },
          })
        : Promise.resolve(null),
      // An ASSIGNED (not yet started) customer holds their barber and chair: spoken for, so neither
      // counts as available - but it is not a service in progress (currentServices is unchanged).
      this.prisma.queueEntry.findMany({
        where: {
          salonId,
          status: QueueEntryStatus.CALLED,
          assignedStaffId: { not: null },
        },
        select: { assignedStaffId: true, assignedChairId: true },
      }),
    ]);

    const busyChairIds = new Set([
      ...activeSessions.map((s) => s.chairId),
      ...activeManualOccupancies.map((s) => s.chairId),
      ...assignedHolds
        .map((h) => h.assignedChairId)
        .filter((id): id is string => id !== null),
    ]);
    const busyStaffIds = new Set([
      ...activeSessions.map((s) => s.staffId),
      ...reservedStaffRows.map((r) => r.preferredStaffId as string),
      ...assignedHolds
        .map((h) => h.assignedStaffId)
        .filter((id): id is string => id !== null),
    ]);
    const activeChairs = chairs.filter((c) => c.status === ChairStatus.ACTIVE);
    const activeStaff = staff.filter(
      (s) => s.status === StaffMemberStatus.ACTIVE,
    );

    const estimates = waitingEstimates
      .map((e) => e.estimatedWaitMinutes)
      .filter((m): m is number => m !== null);
    const averageEstimatedWaitMinutes =
      estimates.length > 0
        ? Math.round(
            estimates.reduce((sum, m) => sum + m, 0) / estimates.length,
          )
        : null;

    return {
      chairs: {
        active: activeChairs.length,
        busy: activeChairs.filter((c) => busyChairIds.has(c.id)).length,
        available: activeChairs.filter((c) => !busyChairIds.has(c.id)).length,
        maintenance: chairs.filter((c) => c.status === ChairStatus.MAINTENANCE)
          .length,
        inactive: chairs.filter((c) => c.status === ChairStatus.INACTIVE)
          .length,
      },
      staff: {
        active: activeStaff.length,
        busy: activeStaff.filter((s) => busyStaffIds.has(s.id)).length,
        available: activeStaff.filter((s) => !busyStaffIds.has(s.id)).length,
        offDuty: staff.filter((s) => s.status === StaffMemberStatus.INACTIVE)
          .length,
      },
      currentServices: activeSessions.length,
      waitingCustomers: waitingCount,
      queueSize,
      averageEstimatedWaitMinutes,
      todaysBookings,
      upcomingBookings,
    };
  }

  async call(userId: string, entryId: string): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );

    // A conditional UPDATE (WHERE id AND status) is atomic in Postgres — no separate row lock
    // needed for a plain status transition, unlike the ServiceSession insert in assign() below,
    // which genuinely needs the partial-unique-index backstop for a real INSERT race.
    const claim = await this.prisma.queueEntry.updateMany({
      where: { id: entryId, status: QueueEntryStatus.WAITING },
      data: { status: QueueEntryStatus.CALLED, calledAt: new Date() },
    });
    if (claim.count === 0) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'This entry is not waiting to be called.',
        HttpStatus.CONFLICT,
      );
    }
    await this.logAdminQueueAction(
      actor,
      userId,
      'ADMIN_QUEUE_ENTRY_CALLED',
      entryId,
      {
        salonId: entry.salonId,
      },
    );

    await this.recomputeEtas(entry.salonId);
    this.realtime.emitEntryCalled(entry.salonId, entryId, entry.customerId);
    this.realtime.emitQueueUpdated(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  /**
   * Live Queue operations mission — staff/owner acknowledge that a queue customer is physically in
   * the shop. A remote or QR join does not prove presence, so it starts un-arrived; this records
   * the acknowledgement authoritatively (QueueEntry.arrivedAt) rather than as a UI-only label.
   * Idempotent: acknowledging an already-arrived entry returns it unchanged, and two staff
   * tapping at once converge on the first timestamp (the claim only ever fills a NULL).
   */
  async markArrived(
    userId: string,
    entryId: string,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );

    if (
      entry.status !== QueueEntryStatus.WAITING &&
      entry.status !== QueueEntryStatus.CALLED
    ) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'Only a waiting or called entry can be marked arrived.',
        HttpStatus.CONFLICT,
      );
    }

    if (!entry.arrivedAt) {
      const claim = await this.prisma.queueEntry.updateMany({
        where: {
          id: entryId,
          arrivedAt: null,
          status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
        },
        data: { arrivedAt: new Date() },
      });
      if (claim.count > 0) {
        await this.logAdminQueueAction(
          actor,
          userId,
          'ADMIN_QUEUE_ENTRY_ARRIVED',
          entryId,
          {
            salonId: entry.salonId,
          },
        );
        this.realtime.emitQueueUpdated(entry.salonId);
        // Becoming physically present is the eligibility transition for automatic assignment.
        // Trigger only after the successful DB claim; never assign a remote/unarrived customer.
        this.triggerAutoAssign(entry.salonId);
      } else {
        // Lost a race: either another operator acknowledged it first (fine — idempotent) or the
        // entry left the active states underneath us (a real conflict).
        const current = await this.prisma.queueEntry.findUnique({
          where: { id: entryId },
          select: { arrivedAt: true },
        });
        if (!current?.arrivedAt) {
          throw new AppException(
            QueueErrorCode.INVALID_QUEUE_TRANSITION,
            'This entry can no longer be marked arrived.',
            HttpStatus.CONFLICT,
          );
        }
      }
    }
    return this.getDetailOrThrow(entryId);
  }

  async assign(
    userId: string,
    entryId: string,
    input: AssignQueueEntryInput,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );
    // `startService: false` (every current first-party client) only RESERVES the barber and chair;
    // omitted keeps the pre-existing seat-and-start behaviour for already-installed clients that
    // have no Start Service action (see assignQueueEntrySchema).
    return this.assignLoaded(
      entry,
      input,
      { userId, actor },
      { startService: input.startService !== false },
    );
  }

  /**
   * Owner-operations mission - the SAME transaction-safe seating as assign() (identical
   * qualification, reservation-window, chair/barber exclusivity and claim logic, one engine), used
   * by the automatic allocator, which has no signed-in user. Differences: no per-user access check
   * (the allocator only ever runs for a salon whose owner enabled automatic assignment, or on an
   * already-authorized request), and the audit row carries no human actor.
   */
  async assignAsSystem(
    entryId: string,
    input: AssignQueueEntryInput,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    // Owner-approved direct transition: a physically arrived waiting guest goes straight
    // to IN_SERVICE. The shared transaction atomically claims the queue entry and opens its
    // ACTIVE ServiceSession; there is no intermediate CALLED/ASSIGNED hold for this path.
    return this.assignLoaded(entry, input, null, { startService: true });
  }

  private async assignLoaded(
    entry: Awaited<ReturnType<QueueService['getEntryOrThrow']>>,
    input: AssignQueueEntryInput,
    by: { userId: string; actor: 'STAFF_OR_OWNER' | 'PLATFORM_ADMIN' } | null,
    options: { startService: boolean },
  ): Promise<QueueEntryDetailDto> {
    const entryId = entry.id;
    const serviceId = input.serviceId ?? entry.serviceId;
    if (!serviceId) {
      throw new AppException(
        QueueErrorCode.SERVICE_REQUIRED,
        'A service must be specified to assign this walk-in.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.availability.assertStaffQualified(
      entry.salonId,
      serviceId,
      input.staffId,
    );
    // Trusted server-side duration for the reservation-window guard below — never a client value.
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, salonId: entry.salonId },
      select: { durationMinutes: true },
    });
    if (!service) {
      throw new AppException(
        BookingErrorCode.SERVICE_NOT_FOUND,
        'Service not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Part 7 — a customer who explicitly booked a specific barber must not silently receive a
    // different one through the same control a walk-in uses. Normal assignment on an
    // APPOINTMENT-sourced entry is locked to Booking.preferredStaffId when one is set; an
    // explicit override workflow is a deliberate, separately-audited follow-up (see this PR's
    // description), not implemented here.
    let preferredStaffId: string | null = null;
    if (entry.source === QueueEntrySource.APPOINTMENT && entry.bookingId) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: entry.bookingId },
        select: { preferredStaffId: true },
      });
      preferredStaffId = booking?.preferredStaffId ?? null;
    }
    if (preferredStaffId && preferredStaffId !== input.staffId) {
      throw new AppException(
        QueueErrorCode.APPOINTMENT_STAFF_LOCKED,
        'This appointment was booked with a specific barber. Assigning a different barber requires an explicit reassignment.',
        HttpStatus.CONFLICT,
      );
    }

    const chair = await this.prisma.chair.findFirst({
      where: { id: input.chairId, salonId: entry.salonId },
    });
    if (!chair) {
      throw new AppException(
        QueueErrorCode.CHAIR_NOT_FOUND,
        'Chair not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (chair.status !== ChairStatus.ACTIVE) {
      throw new AppException(
        QueueErrorCode.CHAIR_INACTIVE,
        'This chair is not active.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Same per-salon lock key BookingsService.create/reschedule use (Part 6) — a concurrent
      // booking for this salon and this assign() now serialize against each other, so exactly one
      // of a competing "book Ramesh" vs "assign walk-in to Ramesh" can win instead of both reading
      // a stale reservation state.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${entry.salonId}))`,
      );
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`fastque-chair:${input.chairId}`}))`,
      );
      const manualOccupancy = await tx.manualChairOccupancy.findFirst({
        where: { chairId: input.chairId, endedAt: null },
        select: { id: true },
      });
      if (manualOccupancy) {
        throw new AppException(
          QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
          'This chair is occupied by a local customer.',
          HttpStatus.CONFLICT,
        );
      }
      // Part 5 — a queue assignment starts service now; it must not consume a barber through an
      // interval that overlaps their own upcoming/current appointment reservation. This entry's
      // own linked booking (an appointment assigned to its own preferredStaffId — Case O) and its
      // own not-yet-existing session are excluded so an appointment can never conflict with itself.
      const now = new Date();
      const candidateEnd = new Date(
        now.getTime() + service.durationMinutes * 60_000,
      );
      const staffCheck = await this.reservations.isStaffFreeForInterval(
        tx,
        entry.salonId,
        input.staffId,
        now,
        candidateEnd,
        {
          excludeBookingId: entry.bookingId ?? undefined,
          excludeQueueEntryId: entryId,
        },
      );
      if (!staffCheck.free) {
        // Someone else already holds this barber: serving a customer right now, or assigned to a
        // customer who has not started yet.
        if (staffCheck.reason === 'ASSIGNED_CUSTOMER') {
          throw new AppException(
            QueueErrorCode.STAFF_ALREADY_OCCUPIED,
            'This barber is already assigned to another customer.',
            HttpStatus.CONFLICT,
          );
        }
        throw new AppException(
          QueueErrorCode.STAFF_RESERVED_FOR_APPOINTMENT,
          'This barber is reserved for an appointment during that time.',
          HttpStatus.CONFLICT,
        );
      }
      // The chair may already be held by another assigned (not yet started) customer.
      const chairHold = await tx.queueEntry.findFirst({
        where: {
          assignedChairId: input.chairId,
          status: QueueEntryStatus.CALLED,
          id: { not: entryId },
        },
        select: { id: true },
      });
      if (chairHold) {
        throw new AppException(
          QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
          'This chair is already assigned to another customer.',
          HttpStatus.CONFLICT,
        );
      }
      // Claim the entry first — if this UPDATE affects 0 rows, someone else already
      // called/assigned/cancelled it, and we bail out before ever touching ServiceSession.
      const claimedAt = new Date();
      let claim: Prisma.BatchPayload;
      try {
        claim = await tx.queueEntry.updateMany({
          where: {
            id: entryId,
            status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
          },
          data: options.startService
            ? {
                status: QueueEntryStatus.IN_SERVICE,
                serviceStartedAt: claimedAt,
                assignedStaffId: input.staffId,
                assignedChairId: input.chairId,
                assignedAt: claimedAt,
                serviceId,
                // Seating someone in a chair means they are physically in the shop: acknowledge
                // arrival implicitly (never overwriting an earlier explicit acknowledgement).
                ...(entry.arrivedAt ? {} : { arrivedAt: claimedAt }),
              }
            : {
                // Assigned, NOT started: the barber and chair are reserved, no ServiceSession exists
                // and serviceStartedAt stays null until startService() runs. Being assigned says
                // nothing about arrival, so arrivedAt is left exactly as it was.
                status: QueueEntryStatus.CALLED,
                calledAt: entry.calledAt ?? claimedAt,
                assignedStaffId: input.staffId,
                assignedChairId: input.chairId,
                assignedAt: claimedAt,
                serviceId,
              },
        });
      } catch (err) {
        throw this.mapHoldConflict(err) ?? err;
      }
      if (claim.count === 0) {
        throw new AppException(
          QueueErrorCode.INVALID_QUEUE_TRANSITION,
          'This entry can no longer be assigned.',
          HttpStatus.CONFLICT,
        );
      }

      if (options.startService) {
        await this.createActiveSession(
          tx,
          entryId,
          input.staffId,
          input.chairId,
          serviceId,
        );
      }
    }, TRANSACTION_OPTIONS);
    if (by) {
      await this.logAdminQueueAction(
        by.actor,
        by.userId,
        'ADMIN_QUEUE_ENTRY_ASSIGNED',
        entryId,
        {
          salonId: entry.salonId,
          staffId: input.staffId,
          chairId: input.chairId,
          serviceId,
          serviceStarted: options.startService,
        },
      );
    } else {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: null,
          action: 'QUEUE_ENTRY_AUTO_ASSIGNED',
          entityType: 'QueueEntry',
          entityId: entryId,
          metadata: {
            salonId: entry.salonId,
            staffId: input.staffId,
            chairId: input.chairId,
            serviceId,
            serviceStarted: options.startService,
          },
        },
      });
    }

    await this.recomputeEtas(entry.salonId);
    this.realtime.emitQueueUpdated(entry.salonId);
    // An assigned customer is "called to staff": tell their own device so it can say the barber is
    // ready (it never says the service has started).
    if (!options.startService && entry.status === QueueEntryStatus.WAITING) {
      this.realtime.emitEntryCalled(entry.salonId, entryId, entry.customerId);
    }

    const assignedStaff = await this.prisma.salonStaff.findUnique({
      where: { id: input.staffId },
      select: { userId: true },
    });
    if (assignedStaff) {
      await this.notifications.notify(
        assignedStaff.userId,
        'staff.assigned',
        { salonId: entry.salonId, queueEntryId: entryId },
        `dashboard/salons/${entry.salonId}/queue`,
      );
    }

    return this.getDetailOrThrow(entryId);
  }

  /**
   * Owner-operations corrective mission - the barber's (or owner's) explicit "Start service".
   *
   * Assigning a barber only RESERVES them (status CALLED + assignedStaffId/assignedChairId, no
   * serviceStartedAt, no ServiceSession). This is the one place an assigned customer becomes
   * IN_SERVICE: it re-validates the assignment against the CURRENT state of the world (barber still
   * on duty and qualified, chair still active and not locally occupied, no appointment reservation
   * in the way), then - under the same per-salon + per-chair advisory locks assign() takes -
   * atomically claims the entry, stamps the real serviceStartedAt and opens the ACTIVE session. The
   * claim is conditional on the exact assignment still being in place, so a start racing a reassign,
   * a cancellation or a release can never produce a session for the wrong barber.
   *
   * Idempotent for a double tap: an entry that is already IN_SERVICE is returned unchanged.
   */
  async startService(
    userId: string,
    entryId: string,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );

    if (entry.status === QueueEntryStatus.IN_SERVICE)
      return this.getDetailOrThrow(entryId);
    if (
      entry.status !== QueueEntryStatus.CALLED ||
      !entry.assignedStaffId ||
      !entry.assignedChairId
    ) {
      throw new AppException(
        OwnerOpsErrorCode.NOT_ASSIGNED,
        'Assign a barber and a chair to this customer before starting the service.',
        HttpStatus.CONFLICT,
      );
    }
    const assignedStaffId = entry.assignedStaffId;
    const assignedChairId = entry.assignedChairId;

    const staff = await this.prisma.salonStaff.findFirst({
      where: { id: assignedStaffId, salonId: entry.salonId },
      select: {
        id: true,
        userId: true,
        status: true,
        accessRevokedAt: true,
        displayName: true,
      },
    });
    // A barber may only start THEIR OWN assigned customer; the owner (or a delegated admin) may start
    // anyone's, e.g. when the barber has their hands full.
    if (actor === 'STAFF_OR_OWNER') {
      const kind = await this.salonAccess.getActorKind(userId, entry.salonId);
      if (kind === 'STAFF' && staff?.userId !== userId) {
        throw new AppException(
          OwnerOpsErrorCode.NOT_YOUR_ASSIGNMENT,
          'This customer is assigned to another barber.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    if (
      !staff ||
      staff.status !== StaffMemberStatus.ACTIVE ||
      staff.accessRevokedAt
    ) {
      throw new AppException(
        OwnerOpsErrorCode.ASSIGNMENT_NOT_STARTABLE,
        'The assigned barber is no longer on duty. Assign this customer to another barber.',
        HttpStatus.CONFLICT,
      );
    }
    const serviceId = entry.serviceId;
    if (!serviceId) {
      throw new AppException(
        QueueErrorCode.SERVICE_REQUIRED,
        'A service must be chosen before this customer can be started.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.availability.assertStaffQualified(
      entry.salonId,
      serviceId,
      assignedStaffId,
    );
    const [service, chair] = await Promise.all([
      this.prisma.service.findFirst({
        where: { id: serviceId, salonId: entry.salonId },
        select: { durationMinutes: true },
      }),
      this.prisma.chair.findFirst({
        where: { id: assignedChairId, salonId: entry.salonId },
      }),
    ]);
    if (!service) {
      throw new AppException(
        BookingErrorCode.SERVICE_NOT_FOUND,
        'Service not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!chair || chair.status !== ChairStatus.ACTIVE) {
      throw new AppException(
        OwnerOpsErrorCode.ASSIGNMENT_NOT_STARTABLE,
        'The assigned chair is no longer available. Assign this customer to another chair.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${entry.salonId}))`,
      );
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`fastque-chair:${assignedChairId}`}))`,
      );
      const manualOccupancy = await tx.manualChairOccupancy.findFirst({
        where: { chairId: assignedChairId, endedAt: null },
        select: { id: true },
      });
      if (manualOccupancy) {
        throw new AppException(
          QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
          'This chair is occupied by a local customer.',
          HttpStatus.CONFLICT,
        );
      }
      const now = new Date();
      const staffCheck = await this.reservations.isStaffFreeForInterval(
        tx,
        entry.salonId,
        assignedStaffId,
        now,
        new Date(now.getTime() + service.durationMinutes * 60_000),
        // The entry's own booking and its own assignment hold must not conflict with itself.
        {
          excludeBookingId: entry.bookingId ?? undefined,
          excludeQueueEntryId: entryId,
        },
      );
      if (!staffCheck.free) {
        throw new AppException(
          staffCheck.reason === 'BOOKING_RESERVATION'
            ? QueueErrorCode.STAFF_RESERVED_FOR_APPOINTMENT
            : QueueErrorCode.STAFF_ALREADY_OCCUPIED,
          staffCheck.reason === 'BOOKING_RESERVATION'
            ? 'This barber is reserved for an appointment during that time.'
            : 'This barber is already serving another customer.',
          HttpStatus.CONFLICT,
        );
      }
      const startedAt = new Date();
      const claim = await tx.queueEntry.updateMany({
        where: {
          id: entryId,
          status: QueueEntryStatus.CALLED,
          assignedStaffId,
          assignedChairId,
        },
        data: {
          status: QueueEntryStatus.IN_SERVICE,
          serviceStartedAt: startedAt,
          // The customer is being served, so they are physically in the shop.
          ...(entry.arrivedAt ? {} : { arrivedAt: startedAt }),
        },
      });
      if (claim.count === 0) {
        throw new AppException(
          QueueErrorCode.INVALID_QUEUE_TRANSITION,
          'This assignment changed. Refresh and try again.',
          HttpStatus.CONFLICT,
        );
      }
      await this.createActiveSession(
        tx,
        entryId,
        assignedStaffId,
        assignedChairId,
        serviceId,
      );
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'QUEUE_ENTRY_SERVICE_STARTED',
          entityType: 'QueueEntry',
          entityId: entryId,
          metadata: {
            salonId: entry.salonId,
            staffId: assignedStaffId,
            chairId: assignedChairId,
            actor,
          },
        },
      });
    }, TRANSACTION_OPTIONS);

    await this.recomputeEtas(entry.salonId);
    this.realtime.emitQueueUpdated(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  /** The one place an ACTIVE ServiceSession is opened; the partial unique indexes make a second
   * active session for the same barber or chair impossible even under a race. */
  private async createActiveSession(
    tx: Prisma.TransactionClient,
    entryId: string,
    staffId: string,
    chairId: string,
    serviceId: string,
  ): Promise<void> {
    try {
      await tx.serviceSession.create({
        data: {
          queueEntryId: entryId,
          staffId,
          chairId,
          serviceId,
          status: ServiceSessionStatus.ACTIVE,
        },
      });
    } catch (err) {
      // A P2002 here rolls back the whole transaction, including the claim before it, so the entry
      // correctly reverts to its prior status for a retry with a different staff/chair.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = this.uniqueTarget(err);
        if (target.includes('staff')) {
          throw new AppException(
            QueueErrorCode.STAFF_ALREADY_OCCUPIED,
            'This staff member is already serving another customer.',
            HttpStatus.CONFLICT,
          );
        }
        if (target.includes('chair')) {
          throw new AppException(
            QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
            'This chair is already occupied.',
            HttpStatus.CONFLICT,
          );
        }
      }
      throw err;
    }
  }

  /** A unique-index violation raised while RESERVING a barber/chair for an assigned customer (the
   * partial unique indexes on queue_entries): returns the friendly conflict, or null for anything
   * else. */
  private mapHoldConflict(err: unknown): AppException | null {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    )
      return null;
    const target = this.uniqueTarget(err);
    if (target.includes('staff')) {
      return new AppException(
        QueueErrorCode.STAFF_ALREADY_OCCUPIED,
        'This barber is already assigned to another customer.',
        HttpStatus.CONFLICT,
      );
    }
    if (target.includes('chair')) {
      return new AppException(
        QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
        'This chair is already assigned to another customer.',
        HttpStatus.CONFLICT,
      );
    }
    return null;
  }

  private uniqueTarget(err: Prisma.PrismaClientKnownRequestError): string {
    const rawTarget = err.meta?.target;
    return (
      Array.isArray(rawTarget)
        ? rawTarget.filter((t): t is string => typeof t === 'string').join(',')
        : typeof rawTarget === 'string'
          ? rawTarget
          : ''
    ).toLowerCase();
  }

  /**
   * Moves an already in-service visit to another active barber/chair without replacing the queue
   * entry or service session. Updating both rows in one transaction preserves token, join time,
   * queue priority and service history while the partial unique indexes continue to enforce one
   * active visit per barber/chair under concurrent requests.
   */
  async reassign(
    userId: string,
    entryId: string,
    input: ReassignQueueEntryInput,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );
    if (entry.status !== QueueEntryStatus.IN_SERVICE) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'Only an in-service visit can be reassigned.',
        HttpStatus.CONFLICT,
      );
    }

    const session = await this.prisma.serviceSession.findFirst({
      where: { queueEntryId: entryId, status: ServiceSessionStatus.ACTIVE },
    });
    if (!session) {
      throw new AppException(
        QueueErrorCode.SERVICE_SESSION_NOT_FOUND,
        'The active service session could not be found.',
        HttpStatus.CONFLICT,
      );
    }

    const staffId = input.staffId ?? session.staffId;
    const chairId = input.chairId ?? session.chairId;
    await this.availability.assertStaffQualified(
      entry.salonId,
      session.serviceId,
      staffId,
    );
    // Same trusted server-side duration source assign() uses, for the reservation guard below.
    const service = await this.prisma.service.findFirst({
      where: { id: session.serviceId, salonId: entry.salonId },
      select: { durationMinutes: true },
    });
    if (!service) {
      throw new AppException(
        BookingErrorCode.SERVICE_NOT_FOUND,
        'Service not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    const chair = await this.prisma.chair.findFirst({
      where: { id: chairId, salonId: entry.salonId },
    });
    if (!chair) {
      throw new AppException(
        QueueErrorCode.CHAIR_NOT_FOUND,
        'Chair not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (chair.status !== ChairStatus.ACTIVE) {
      throw new AppException(
        QueueErrorCode.CHAIR_INACTIVE,
        'This chair is not active.',
        HttpStatus.CONFLICT,
      );
    }

    if (staffId === session.staffId && chairId === session.chairId) {
      return this.getDetailOrThrow(entryId);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Part 5/6 — reassignment is a queue assignment too: moving this visit to a different
        // barber must not overlap that barber's own appointment reservation, and must serialize
        // against a concurrent booking for this salon the same way assign() does. reassign() is
        // itself the deliberate, explicit staff/owner action Part 7 asks for when a barber genuinely
        // needs to change ("Reassign appointment") — it is not locked to Booking.preferredStaffId.
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${entry.salonId}))`,
        );
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`fastque-chair:${chairId}`}))`,
        );
        if (staffId !== session.staffId) {
          const now = new Date();
          const candidateEnd = new Date(
            now.getTime() + service.durationMinutes * 60_000,
          );
          const staffCheck = await this.reservations.isStaffFreeForInterval(
            tx,
            entry.salonId,
            staffId,
            now,
            candidateEnd,
            {
              excludeBookingId: entry.bookingId ?? undefined,
              excludeQueueEntryId: entryId,
            },
          );
          if (!staffCheck.free) {
            throw new AppException(
              QueueErrorCode.STAFF_RESERVED_FOR_APPOINTMENT,
              'This barber is reserved for an appointment during that time.',
              HttpStatus.CONFLICT,
            );
          }
        }
        const manualOccupancy = await tx.manualChairOccupancy.findFirst({
          where: { chairId, endedAt: null },
          select: { id: true },
        });
        if (manualOccupancy) {
          throw new AppException(
            QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
            'This chair is occupied by a local customer.',
            HttpStatus.CONFLICT,
          );
        }
        const sessionClaim = await tx.serviceSession.updateMany({
          where: {
            id: session.id,
            status: ServiceSessionStatus.ACTIVE,
            staffId: session.staffId,
            chairId: session.chairId,
          },
          data: { staffId, chairId },
        });
        if (sessionClaim.count === 0) {
          throw new AppException(
            QueueErrorCode.INVALID_QUEUE_TRANSITION,
            'This visit was changed in another session. Refresh and try again.',
            HttpStatus.CONFLICT,
          );
        }

        const entryClaim = await tx.queueEntry.updateMany({
          where: {
            id: entryId,
            status: QueueEntryStatus.IN_SERVICE,
            assignedStaffId: entry.assignedStaffId,
            assignedChairId: entry.assignedChairId,
          },
          // Deliberately assignment-only: tokenNumber, joinedAt, status, serviceStartedAt and
          // estimatedWaitMinutes are not written and therefore cannot be reset by reassignment.
          data: { assignedStaffId: staffId, assignedChairId: chairId },
        });
        if (entryClaim.count === 0) {
          throw new AppException(
            QueueErrorCode.INVALID_QUEUE_TRANSITION,
            'This visit was changed in another session. Refresh and try again.',
            HttpStatus.CONFLICT,
          );
        }
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const rawTarget = error.meta?.target;
        const target = (
          Array.isArray(rawTarget)
            ? rawTarget
                .filter((value): value is string => typeof value === 'string')
                .join(',')
            : typeof rawTarget === 'string'
              ? rawTarget
              : ''
        ).toLowerCase();
        if (target.includes('staff')) {
          throw new AppException(
            QueueErrorCode.STAFF_ALREADY_OCCUPIED,
            'This staff member is already serving another customer.',
            HttpStatus.CONFLICT,
          );
        }
        if (target.includes('chair')) {
          throw new AppException(
            QueueErrorCode.CHAIR_ALREADY_OCCUPIED,
            'This chair is already occupied.',
            HttpStatus.CONFLICT,
          );
        }
      }
      throw error;
    }
    await this.logAdminQueueAction(
      actor,
      userId,
      'ADMIN_QUEUE_ENTRY_REASSIGNED',
      entryId,
      {
        salonId: entry.salonId,
        staffId,
        chairId,
      },
    );

    this.realtime.emitQueueEntryReassigned(entry.salonId, entryId);
    this.realtime.emitQueueUpdated(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  /**
   * Owner-operations mission - "New Live Queue customer": an operator adds someone who is standing
   * in the shop and has no FastQue account. It is a real WAITING queue entry (same token numbering,
   * ETA and realtime path as every other join); customerId stays NULL and no account is invented -
   * the name (and, only with the customer's consent, the phone) live on the entry itself. Because
   * the person is physically present, `arrivedAt` is set immediately, which is what makes them
   * eligible for automatic allocation.
   *
   * Distinct from an in-shop APPOINTMENT (a scheduled booking, BookingsService.createInShop): this
   * is a "serve me when it's my turn" visit.
   */
  async createOperatorEntry(
    userId: string,
    salonId: string,
    input: CreateQueueCustomerInput,
  ): Promise<QueueEntryDetailDto> {
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      salonId,
    );
    await this.availability.getSalonOrThrow(salonId);
    if (input.serviceId)
      await this.availability.getServiceOrThrow(salonId, input.serviceId);
    if (input.preferredStaffId) {
      const staff = await this.prisma.salonStaff.findFirst({
        where: { id: input.preferredStaffId, salonId },
        select: { id: true },
      });
      if (!staff) {
        throw new AppException(
          BookingErrorCode.STAFF_NOT_FOUND,
          'Staff member not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (input.serviceId) {
        await this.availability.assertStaffQualified(
          salonId,
          input.serviceId,
          input.preferredStaffId,
        );
      }
    }
    const contactPhone =
      input.contactConsent && input.phone ? input.phone : null;

    const entryId = await this.prisma.$transaction(async (tx) => {
      const tokenNumber = await this.nextTokenNumber(tx, salonId);
      // Two taps on "Add" (or a retry with a fresh key) must not seat the same person twice.
      const duplicate = await tx.queueEntry.findFirst({
        where: {
          salonId,
          customerId: null,
          source: QueueEntrySource.WALK_IN,
          status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
          contactName: { equals: input.name, mode: 'insensitive' },
          joinedAt: { gte: new Date(Date.now() - 2 * 60_000) },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new AppException(
          OwnerOpsErrorCode.QUEUE_ENTRY_ALREADY_ACTIVE,
          'This customer was just added to the Live Queue.',
          HttpStatus.CONFLICT,
        );
      }
      const created = await tx.queueEntry.create({
        data: {
          salonId,
          customerId: null,
          serviceId: input.serviceId ?? null,
          source: QueueEntrySource.WALK_IN,
          tokenNumber,
          status: QueueEntryStatus.WAITING,
          contactName: input.name,
          contactPhone,
          arrivedAt: new Date(),
          createdByUserId: userId,
          preferredStaffId: input.preferredStaffId ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'QUEUE_ENTRY_CREATED_BY_OPERATOR',
          entityType: 'QueueEntry',
          entityId: created.id,
          metadata: {
            salonId,
            actor,
            phoneStored: Boolean(contactPhone),
            serviceId: input.serviceId ?? null,
            preferredStaffId: input.preferredStaffId ?? null,
          },
        },
      });
      return created.id;
    }, TRANSACTION_OPTIONS);

    await this.recomputeEtas(salonId);
    this.realtime.emitQueueUpdated(salonId);
    this.triggerAutoAssign(salonId);
    return this.getDetailOrThrow(entryId);
  }

  async completeSession(
    userId: string,
    sessionId: string,
  ): Promise<QueueEntryDetailDto> {
    const session = await this.prisma.serviceSession.findUnique({
      where: { id: sessionId },
      include: { queueEntry: true },
    });
    if (!session) {
      throw new AppException(
        QueueErrorCode.SERVICE_SESSION_NOT_FOUND,
        'Service session not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      session.queueEntry.salonId,
    );
    // Owner-operations mission: an owner (or delegated admin) may complete any service, but a
    // barber may only complete the service THEY are performing - never a colleague's.
    if (actor === 'STAFF_OR_OWNER') {
      const kind = await this.salonAccess.getActorKind(
        userId,
        session.queueEntry.salonId,
      );
      if (kind === 'STAFF') {
        const performer = await this.prisma.salonStaff.findUnique({
          where: { id: session.staffId },
          select: { userId: true },
        });
        if (performer?.userId !== userId) {
          throw new AppException(
            OwnerOpsErrorCode.NOT_YOUR_SERVICE_SESSION,
            'You can only complete the service you are performing.',
            HttpStatus.FORBIDDEN,
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.serviceSession.updateMany({
        where: { id: sessionId, status: ServiceSessionStatus.ACTIVE },
        data: { status: ServiceSessionStatus.COMPLETED, endedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new AppException(
          QueueErrorCode.INVALID_QUEUE_TRANSITION,
          'This session is no longer active.',
          HttpStatus.CONFLICT,
        );
      }

      await tx.queueEntry.update({
        where: { id: session.queueEntryId },
        data: {
          status: QueueEntryStatus.COMPLETED,
          serviceCompletedAt: new Date(),
        },
      });

      // STATE_MACHINES.md's Booking diagram: "CONFIRMED → COMPLETED: linked QueueEntry's
      // ServiceSession finishes" — the only place a Booking ever reaches COMPLETED.
      //
      // FastQue Credits / Wallet V1: completing a service does NOT automatically grant the
      // customer any credit — an earlier version of this method did, which was a misreading of
      // the product rule (floor(price/50)*10 is a redemption CAP, not an earn rate) caught in
      // independent review before any production use. Credits only ever enter a wallet through an
      // authorized PROMO_GRANT (AdminCreditsController) or a redemption restoration
      // (CustomerCreditsService.restoreForCancelledBooking) — never from here.
      if (session.queueEntry.bookingId) {
        await tx.booking.update({
          where: { id: session.queueEntry.bookingId },
          data: { status: BookingStatus.COMPLETED },
        });
      }
    }, TRANSACTION_OPTIONS);
    await this.logAdminQueueAction(
      actor,
      userId,
      'ADMIN_QUEUE_SESSION_COMPLETED',
      session.queueEntryId,
      { salonId: session.queueEntry.salonId, sessionId },
    );

    this.serviceCompletedHook?.notify({
      salonId: session.queueEntry.salonId,
      queueEntryId: session.queueEntryId,
      sessionId,
      actorUserId: userId,
    });
    await this.recomputeEtas(session.queueEntry.salonId);
    this.realtime.emitQueueUpdated(session.queueEntry.salonId);
    this.triggerAutoAssign(session.queueEntry.salonId);
    return this.getDetailOrThrow(session.queueEntryId);
  }

  async noShow(userId: string, entryId: string): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );

    const claim = await this.prisma.queueEntry.updateMany({
      where: {
        id: entryId,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
        // A waiting visitor already checked in at the shop is not a no-show. Preserve the
        // historical CALLED no-show behavior for previously assigned (unstarted) visitors.
        ...(entry.status === QueueEntryStatus.WAITING ? { arrivedAt: null } : {}),
      },
      data: { status: QueueEntryStatus.NO_SHOW },
    });
    if (claim.count === 0) {
      throw new AppException(
        QueueErrorCode.INVALID_QUEUE_TRANSITION,
        'Only an unarrived waiting or a called customer can be marked no-show.',
        HttpStatus.CONFLICT,
      );
    }
    await this.logAdminQueueAction(
      actor,
      userId,
      'ADMIN_QUEUE_ENTRY_NO_SHOW',
      entryId,
      {
        salonId: entry.salonId,
      },
    );

    await this.recomputeEtas(entry.salonId);
    this.realtime.emitQueueUpdated(entry.salonId);
    // A no-show who held a barber and chair (an assigned customer) frees both for the next customer.
    this.triggerAutoAssign(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  async cancelByStaff(
    userId: string,
    entryId: string,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.getEntryOrThrow(entryId);
    const actor = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );

    const cancellableStatuses = [
      QueueEntryStatus.WAITING,
      QueueEntryStatus.CALLED,
      QueueEntryStatus.IN_SERVICE,
    ];
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.queueEntry.updateMany({
        where: { id: entryId, status: { in: cancellableStatuses } },
        data: { status: QueueEntryStatus.CANCELLED },
      });
      if (claim.count === 0) {
        throw new AppException(
          QueueErrorCode.INVALID_QUEUE_TRANSITION,
          'This entry can no longer be cancelled.',
          HttpStatus.CONFLICT,
        );
      }
      // Cascade: an IN_SERVICE entry's ACTIVE session is aborted too (ServiceSession's own
      // ACTIVE → CANCELLED edge in STATE_MACHINES.md). A no-op updateMany for WAITING/CALLED
      // entries, which never had a session.
      await tx.serviceSession.updateMany({
        where: { queueEntryId: entryId, status: ServiceSessionStatus.ACTIVE },
        data: { status: ServiceSessionStatus.CANCELLED, endedAt: new Date() },
      });
    }, TRANSACTION_OPTIONS);
    await this.logAdminQueueAction(
      actor,
      userId,
      'ADMIN_QUEUE_ENTRY_CANCELLED',
      entryId,
      {
        salonId: entry.salonId,
      },
    );

    await this.recomputeEtas(entry.salonId);
    this.realtime.emitQueueUpdated(entry.salonId);
    // Cancelling an assigned (or in-service) customer frees a barber and chair for the next one.
    this.triggerAutoAssign(entry.salonId);
    return this.getDetailOrThrow(entryId);
  }

  /** A booking cancellation (or anything else outside the queue) freed a barber or chair: give the
   * automatic allocator a chance to seat the next waiting customer. Never fails the caller. */
  onCapacityFreed(salonId: string): void {
    this.triggerAutoAssign(salonId);
  }

  /** Recompute wait estimates + notify all owner/staff clients after a local chair changes. */
  async onChairOccupancyChanged(salonId: string): Promise<void> {
    await this.recomputeEtas(salonId);
    this.realtime.emitQueueUpdated(salonId);
    this.triggerAutoAssign(salonId);
  }

  // ---------- Shared internals ----------

  private async assertNotAlreadyInQueue(customerId: string): Promise<void> {
    const active = await this.prisma.queueEntry.findFirst({
      where: {
        customerId,
        status: {
          in: [
            QueueEntryStatus.WAITING,
            QueueEntryStatus.CALLED,
            QueueEntryStatus.IN_SERVICE,
          ],
        },
      },
    });
    if (active) {
      throw new AppException(
        QueueErrorCode.ALREADY_IN_QUEUE,
        'You already have an active queue token. Please finish or cancel it first.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async computePosition(entry: {
    salonId: string;
    joinedAt: Date;
  }): Promise<number> {
    const ahead = await this.prisma.queueEntry.count({
      where: {
        salonId: entry.salonId,
        status: QueueEntryStatus.WAITING,
        joinedAt: { lt: entry.joinedAt },
      },
    });
    return ahead + 1;
  }

  /** How many of the staff qualified for these services are in `reservationBusyStaffIds` — the
   * intersection ETA math needs to avoid promising a barber who is currently reservation-busy. */
  private async countReservationBusyQualifiedStaff(
    salonId: string,
    serviceIds: string[],
    reservationBusyStaffIds: Set<string>,
  ): Promise<number> {
    if (reservationBusyStaffIds.size === 0) return 0;
    const where = await this.availability.qualifiedStaffWhereForServices(
      this.prisma,
      salonId,
      serviceIds,
    );
    const qualified = await this.prisma.salonStaff.findMany({
      where,
      select: { id: true },
    });
    return qualified.filter((s) => reservationBusyStaffIds.has(s.id)).length;
  }

  private averageRemainingMinutes(
    sessions: { startedAt: Date; service: { durationMinutes: number } }[],
  ): number {
    if (sessions.length === 0) return 0;
    const now = Date.now();
    const remaining = sessions.map((s) =>
      remainingSessionMinutes(
        s.service.durationMinutes,
        (now - s.startedAt.getTime()) / 60_000,
      ),
    );
    return remaining.reduce((sum, m) => sum + m, 0) / remaining.length;
  }

  /**
   * STATE_MACHINES.md: "estimatedWaitMinutes is recomputed whenever any QueueEntry in the salon
   * changes state or any SalonStaff status changes" — called after every mutation in this
   * service. One UPDATE per WAITING entry; fine at seeded-data queue sizes (see the plan's
   * concurrency-handling section for why this isn't batched further in V1.
   */
  async recomputeEtas(salonId: string): Promise<void> {
    const waiting = await this.prisma.queueEntry.findMany({
      where: { salonId, status: QueueEntryStatus.WAITING },
      orderBy: { joinedAt: 'asc' },
      include: {
        service: { select: { durationMinutes: true } },
        booking: { select: bookingServiceSnapshotSelect },
      },
    });
    if (waiting.length === 0) return;

    const now = new Date();
    const [
      liveSessions,
      assignedHolds,
      manualOccupiedCount,
      activeChairCount,
      reservedStaffRows,
    ] = await Promise.all([
      this.prisma.serviceSession.findMany({
        where: { status: ServiceSessionStatus.ACTIVE, chair: { salonId } },
        select: {
          staffId: true,
          startedAt: true,
          service: { select: { durationMinutes: true } },
        },
      }),
      // An assigned (not yet started) customer keeps their barber busy for a whole service, exactly
      // like a session that has just begun.
      this.prisma.queueEntry.findMany({
        where: {
          salonId,
          status: QueueEntryStatus.CALLED,
          assignedStaffId: { not: null },
        },
        select: {
          assignedStaffId: true,
          assignedAt: true,
          calledAt: true,
          service: { select: { durationMinutes: true } },
        },
      }),
      this.prisma.manualChairOccupancy.count({
        where: { salonId, endedAt: null },
      }),
      this.prisma.chair.count({
        where: { salonId, status: ChairStatus.ACTIVE },
      }),
      // Part 12 — a barber currently reservation-busy (an appointment window covering `now`) must
      // not be counted as an available server, even before any ServiceSession has started for
      // them. This is a present-instant, conservative signal (not a full future-interval
      // simulation — see this file's own header rationale for why that's deliberately out of
      // scope), which is what keeps a walk-in from being promised a barber who is mid-reservation.
      this.prisma.booking.findMany({
        where: {
          salonId,
          preferredStaffId: { not: null },
          ...this.reservations.reservingBookingWhere(),
          slotStart: { lt: new Date(now.getTime() + 1) },
          slotEnd: { gt: now },
        },
        select: { preferredStaffId: true },
      }),
    ]);
    const activeSessions = [
      ...liveSessions,
      ...(assignedHolds ?? []).map((h) => ({
        staffId: h.assignedStaffId as string,
        startedAt: h.assignedAt ?? h.calledAt ?? now,
        service: {
          durationMinutes:
            h.service?.durationMinutes ?? DEFAULT_SERVICE_DURATION_MINUTES,
        },
      })),
    ];
    const activeRemaining = this.averageRemainingMinutes(activeSessions);
    const availableOperationalChairs = Math.max(
      0,
      activeChairCount - manualOccupiedCount,
    );
    // Deduped against activeSessions' own staff — a barber already reflected via activeRemaining
    // (an ACTIVE session, walk-in or the same appointment's own check-in) must not ALSO be
    // subtracted a second time as a separate reservation-busy unit.
    const activeSessionStaffIds = new Set(activeSessions.map((s) => s.staffId));
    const reservationBusyStaffIds = new Set(
      reservedStaffRows
        .map((r) => r.preferredStaffId as string)
        .filter((id) => !activeSessionStaffIds.has(id)),
    );

    for (let i = 0; i < waiting.length; i++) {
      const entry = waiting[i];
      const peopleAhead = i;
      let serverCount: number;
      let avgServiceDurationMinutes: number;
      if (entry.booking) {
        // Appointment-sourced entry — use the FULL selected service set (not just the legacy
        // primary Booking.serviceId) so a multi-service appointment's ETA reflects its true
        // combined duration and only counts staff qualified for every selected service.
        const effectiveServices = resolveEffectiveBookingServices(
          entry.booking,
        );
        const serviceIds = effectiveServices.map((s) => s.serviceId);
        const configuredCapacity =
          await this.availability.getSlotCapacityForServices(
            this.prisma,
            salonId,
            serviceIds,
          );
        const reservationBusyCount =
          await this.countReservationBusyQualifiedStaff(
            salonId,
            serviceIds,
            reservationBusyStaffIds,
          );
        serverCount = Math.min(
          Math.max(0, configuredCapacity - reservationBusyCount),
          availableOperationalChairs,
        );
        avgServiceDurationMinutes = effectiveServices.reduce(
          (sum, s) => sum + s.durationMinutes,
          0,
        );
      } else if (entry.serviceId) {
        const configuredCapacity = await this.availability.getSlotCapacity(
          this.prisma,
          salonId,
          entry.serviceId,
        );
        const reservationBusyCount =
          await this.countReservationBusyQualifiedStaff(
            salonId,
            [entry.serviceId],
            reservationBusyStaffIds,
          );
        serverCount = Math.min(
          Math.max(0, configuredCapacity - reservationBusyCount),
          availableOperationalChairs,
        );
        avgServiceDurationMinutes =
          entry.service?.durationMinutes ?? DEFAULT_SERVICE_DURATION_MINUTES;
      } else {
        const staffCount = await this.prisma.salonStaff.count({
          where: { salonId, status: StaffMemberStatus.ACTIVE },
        });
        const adjustedStaffCount = Math.max(
          0,
          staffCount - reservationBusyStaffIds.size,
        );
        serverCount = computeSlotCapacity(
          adjustedStaffCount,
          availableOperationalChairs,
        );
        avgServiceDurationMinutes = DEFAULT_SERVICE_DURATION_MINUTES;
      }
      const eta = estimateWaitMinutes(
        serverCount,
        peopleAhead,
        avgServiceDurationMinutes,
        activeRemaining,
      );
      await this.prisma.queueEntry.update({
        where: { id: entry.id },
        data: { estimatedWaitMinutes: eta },
      });

      // Customer-facing "turn approaching" / "wait changed a lot" alert (Phase 5) — a targeted
      // customer-room event, not the salon-wide queue.updated already emitted by every caller of
      // this method. Only entries with a real customer (an app-joined visit, not a walk-in the
      // owner logged for someone with no account) have anyone to alert. Comparing against
      // entry.estimatedWaitMinutes (the value fetched *before* this loop overwrote it) is what
      // makes this a real state-transition check, not a re-alert on every recompute cycle.
      if (
        entry.customerId &&
        isWaitAlertWorthy(entry.estimatedWaitMinutes, eta)
      ) {
        this.realtime.emitQueueEntryWaitAlert(
          salonId,
          entry.customerId,
          entry.id,
        );
        await this.notifications.notify(
          entry.customerId,
          'queue.turn_approaching',
          { salonId, queueEntryId: entry.id, estimatedWaitMinutes: eta },
        );
      }
    }
  }

  private async nextTokenNumber(
    tx: Prisma.TransactionClient,
    salonId: string,
  ): Promise<number> {
    // Same per-salon advisory-lock pattern as bookings.service.ts's slot-capacity transaction.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${salonId}))`,
    );
    // Token numbering resets once per SALON-LOCAL day — a real, definite answer is required here
    // (unlike the read-only capacity summary above), so this throws rather than guessing IST for
    // a salon with no trustworthy timezone. A plain (non-transaction) read is fine: timezone is
    // effectively immutable within one request's lifetime.
    const timeZone = await this.availability.resolveTimeZoneOrThrow(salonId);
    const bounds = zonedDayBounds(new Date(), timeZone);
    if (!bounds) {
      throw new AppException(
        BookingErrorCode.SALON_TIMEZONE_REQUIRED,
        'Could not resolve today in this salon’s timezone.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const last = await tx.queueEntry.findFirst({
      where: { salonId, joinedAt: { gte: bounds.start, lt: bounds.end } },
      orderBy: { tokenNumber: 'desc' },
    });
    return (last?.tokenNumber ?? 0) + 1;
  }

  // Part 2 — delegated shop management. Called only after a queue mutation's core write has
  // already committed successfully (never inside the same transaction the write itself needs to
  // roll back cleanly on conflict) — a no-op for a real staff/owner actor, an AuditLog row with the
  // real admin actor otherwise.
  private async logAdminQueueAction(
    actor: 'STAFF_OR_OWNER' | 'PLATFORM_ADMIN',
    userId: string,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    if (actor !== 'PLATFORM_ADMIN') return;
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action,
        entityType: 'QueueEntry',
        entityId,
        metadata,
      },
    });
  }

  private async getEntryOrThrow(entryId: string) {
    const entry = await this.prisma.queueEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) {
      throw new AppException(
        QueueErrorCode.QUEUE_ENTRY_NOT_FOUND,
        'Queue entry not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return entry;
  }

  private async getDetailOrThrow(
    entryId: string,
  ): Promise<QueueEntryDetailDto> {
    const entry = await this.prisma.queueEntry.findUnique({
      where: { id: entryId },
      include: queueEntryDetailInclude,
    });
    if (!entry) {
      throw new AppException(
        QueueErrorCode.QUEUE_ENTRY_NOT_FOUND,
        'Queue entry not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const position =
      entry.status === QueueEntryStatus.WAITING
        ? await this.computePosition(entry)
        : null;
    return this.toDetailDto(entry, position);
  }

  toDetailDto(
    entry: QueueEntryWithDetails,
    position: number | null,
  ): QueueEntryDetailDto {
    // Appointment-sourced entries must show every selected service (e.g. "Haircut + Beard
    // Trim"), not just the legacy primary Booking.serviceId — a walk-in entry has no linked
    // booking and keeps showing its single directly-assigned service.
    const serviceName = entry.booking
      ? resolveEffectiveBookingServices(entry.booking)
          .map((s) => s.serviceName)
          .join(' + ')
      : (entry.service?.name ?? null);
    return {
      id: entry.id,
      salonId: entry.salonId,
      bookingId: entry.bookingId,
      source: entry.source,
      tokenNumber: entry.tokenNumber,
      status: entry.status,
      assignedStaffId: entry.assignedStaffId,
      assignedChairId: entry.assignedChairId,
      estimatedWaitMinutes: entry.estimatedWaitMinutes,
      serviceId: entry.serviceId,
      serviceName,
      position,
      customerPhone: entry.contactPhone ?? entry.customer?.phone ?? null,
      customerName: entry.contactName ?? null,
      arrivedAt: entry.arrivedAt?.toISOString() ?? null,
      arrivalPromptSentAt: entry.arrivalPromptSentAt?.toISOString() ?? null,
      customerArrivalResponse: entry.customerArrivalResponse,
      assignedStaffName: entry.assignedStaff?.displayName ?? null,
      assignedChairLabel: entry.assignedChair?.label ?? null,
      preferredStaffId: entry.booking?.preferredStaffId ?? null,
      preferredStaffName: entry.booking?.preferredStaff?.displayName ?? null,
      activeServiceSessionId: entry.serviceSessions[0]?.id ?? null,
      joinedAt: entry.joinedAt.toISOString(),
      calledAt: entry.calledAt?.toISOString() ?? null,
      assignedAt: entry.assignedAt?.toISOString() ?? null,
      // Null until the service ACTUALLY starts - an assigned customer has not started.
      serviceStartedAt: entry.serviceStartedAt?.toISOString() ?? null,
      phase: queuePhaseOf({
        status: entry.status,
        assignedStaffId: entry.assignedStaffId,
      }),
      estimatedWaitRangeMinutes: estimateWaitRangeMinutes(
        entry.estimatedWaitMinutes,
      ),
      turnApproaching:
        entry.estimatedWaitMinutes !== null &&
        entry.estimatedWaitMinutes <= TURN_APPROACHING_THRESHOLD_MINUTES,
    };
  }
}
