import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { QueueEntryStatus, QueueEntrySource } from '@barbercue/shared';
import { QueueService } from './queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { AvailabilityService } from '../bookings/availability.service';
import { ReservationService } from '../bookings/reservation.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { PushDispatchService } from '../push-notifications/push-dispatch.service';

function lastCallData(
  mock: jest.Mock<Promise<unknown>, [unknown]>,
): Record<string, unknown> {
  const calls = mock.mock.calls;
  const [call] = calls.slice(-1);
  return (call[0] as { data: Record<string, unknown> }).data;
}

function makeRawEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    salonId: 's1',
    bookingId: null,
    customerId: 'c1',
    serviceId: 'sv1',
    source: QueueEntrySource.WALK_IN,
    tokenNumber: 1,
    status: QueueEntryStatus.WAITING,
    assignedStaffId: null,
    assignedChairId: null,
    contactName: null,
    contactPhone: null,
    arrivedAt: null,
    joinedAt: new Date(),
    calledAt: null,
    ...overrides,
  };
}

function makeDetailEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...makeRawEntry(),
    service: { name: 'Haircut' },
    customer: { phone: '+919999999999' },
    assignedStaff: null,
    assignedChair: null,
    serviceSessions: [],
    ...overrides,
  };
}

interface PrismaMock {
  queueEntry: {
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    findUniqueOrThrow: jest.Mock<Promise<unknown>, [unknown]>;
    count: jest.Mock<Promise<number>, [unknown]>;
    create: jest.Mock<Promise<unknown>, [unknown]>;
    update: jest.Mock<Promise<unknown>, [unknown]>;
    updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
  };
  serviceSession: {
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    create: jest.Mock<Promise<unknown>, [unknown]>;
    updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
  };
  chair: {
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    count: jest.Mock<Promise<number>, [unknown]>;
  };
  manualChairOccupancy: {
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    count: jest.Mock<Promise<number>, [unknown]>;
  };
  salonStaff: {
    count: jest.Mock<Promise<number>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
  };
  service: {
    aggregate: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    // Booking/queue resource-reservation mission — assign()/reassign() now fetch the trusted
    // server-side duration for the reservation-window guard.
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
  };
  booking: {
    findFirst: jest.Mock<Promise<unknown>, [unknown]>;
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    update: jest.Mock<Promise<unknown>, [unknown]>;
    count: jest.Mock<Promise<number>, [unknown]>;
  };
  auditLog: {
    create: jest.Mock<Promise<unknown>, [unknown]>;
  };
  salon: {
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
  };
  user: {
    findUnique: jest.Mock<Promise<unknown>, [unknown]>;
  };
  // Live-visit add-on mission.
  operatingHours: {
    findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
  };
  queueEntryAddOn: {
    create: jest.Mock<Promise<unknown>, [unknown]>;
    delete: jest.Mock<Promise<unknown>, [unknown]>;
  };
  $executeRaw: jest.Mock<Promise<unknown>, [unknown]>;
  $transaction: jest.Mock;
}

describe('QueueService', () => {
  let service: QueueService;
  let prisma: PrismaMock;
  let availability: {
    getSalonOrThrow: jest.Mock<Promise<unknown>, [string]>;
    getServiceOrThrow: jest.Mock<Promise<unknown>, [string, string]>;
    getServicesOrThrow: jest.Mock;
    assertStaffQualified: jest.Mock<Promise<void>, [string, string, string]>;
    getSlotCapacity: jest.Mock<Promise<number>, [unknown, string, string]>;
    getSlotCapacityForServices: jest.Mock<Promise<number>, [unknown, string, string[]]>;
    getSalonTimeZone: jest.Mock<Promise<string | null>, [string]>;
    resolveTimeZoneOrThrow: jest.Mock<Promise<string>, [string]>;
    getServiceBufferMinutes: jest.Mock<Promise<number>, [unknown, string]>;
  };
  let salonAccess: {
    assertOwnerOrAdminAccess: jest.Mock<Promise<unknown>, [string, string]>;
    assertAccessOrAdminAccess: jest.Mock<Promise<'STAFF_OR_OWNER' | 'PLATFORM_ADMIN'>, [string, string]>;
    getActorKind: jest.Mock<Promise<'OWNER' | 'STAFF' | 'PLATFORM_ADMIN' | null>, [string, string]>;
  };
  let realtime: {
    emitQueueUpdated: jest.Mock;
    emitEntryCalled: jest.Mock;
    emitStaffStatusChanged: jest.Mock;
    emitQueueEntryReassigned: jest.Mock;
    emitQueueEntryWaitAlert: jest.Mock;
    emitQueueEntryJoined: jest.Mock;
  };
  let pushDispatch: { dispatchLocalizedToUser: jest.Mock };
  let notifications: { notify: jest.Mock<Promise<void>, [string, string, unknown?, string?]> };

  beforeEach(async () => {
    prisma = {
      queueEntry: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>(),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        findUnique: jest.fn<Promise<unknown>, [unknown]>(),
        findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
        create: jest.fn<Promise<unknown>, [unknown]>(),
        update: jest.fn<Promise<unknown>, [unknown]>(),
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      serviceSession: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>(),
        findUnique: jest.fn<Promise<unknown>, [unknown]>(),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        create: jest.fn<Promise<unknown>, [unknown]>(),
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      chair: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>(),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(4),
      },
      manualChairOccupancy: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      },
      salonStaff: {
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(3),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ userId: 'staff-user-1' }),
        // startService() re-validates the assigned barber: on duty, access intact.
        findFirst: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
          id: 'st1',
          userId: 'staff-user-1',
          status: 'ACTIVE',
          accessRevokedAt: null,
          displayName: 'Ramesh',
        }),
      },
      service: {
        aggregate: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ _avg: { durationMinutes: 30 } }),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        findFirst: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ durationMinutes: 30 }),
      },
      booking: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>(),
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
        findUnique: jest.fn<Promise<unknown>, [unknown]>(),
        update: jest.fn<Promise<unknown>, [unknown]>(),
        count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      },
      auditLog: {
        create: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
      },
      // getDashboardQueue reads the shop's opt-in flag for the additive `autoAssignEnabled` field.
      salon: {
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ queueAutoAssignEnabled: true }),
      },
      // The customer's own account - has a phone by default so pre-existing join tests keep
      // exercising the unchanged happy path.
      user: {
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ phone: '+919000000001' }),
      },
      // No opening hours configured by default: joins behave exactly as before this mission.
      operatingHours: {
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
      },
      queueEntryAddOn: {
        create: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
        delete: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
      },
      $executeRaw: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(undefined),
      $transaction: jest.fn(),
    };
    // Same interactive-transaction mock pattern as bookings.service.spec.ts — run the callback
    // against `prisma` itself since every tx.* method the callback touches is mocked directly above.
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );

    availability = {
      getSalonOrThrow: jest
        .fn<Promise<unknown>, [string]>()
        .mockResolvedValue({ id: 's1', status: 'ACTIVE', ownerUserId: 'owner1' }),
      getServicesOrThrow: jest.fn(),
      getServiceOrThrow: jest
        .fn<Promise<unknown>, [string, string]>()
        .mockResolvedValue({ id: 'sv1', salonId: 's1' }),
      assertStaffQualified: jest
        .fn<Promise<void>, [string, string, string]>()
        .mockResolvedValue(undefined),
      getSlotCapacity: jest
        .fn<Promise<number>, [unknown, string, string]>()
        .mockResolvedValue(3),
      getSlotCapacityForServices: jest
        .fn<Promise<number>, [unknown, string, string[]]>()
        .mockResolvedValue(3),
      // Asia/Kolkata by default — every existing IST-day-boundary assertion in this file stays
      // valid as-is; timezone-specific correctness itself is covered in availability.service.spec.ts.
      getSalonTimeZone: jest
        .fn<Promise<string | null>, [string]>()
        .mockResolvedValue('Asia/Kolkata'),
      resolveTimeZoneOrThrow: jest
        .fn<Promise<string>, [string]>()
        .mockResolvedValue('Asia/Kolkata'),
      // Buffer 0 by default = the exact pre-mission reservation behaviour.
      getServiceBufferMinutes: jest
        .fn<Promise<number>, [unknown, string]>()
        .mockResolvedValue(0),
    };
    salonAccess = {
      assertOwnerOrAdminAccess: jest.fn<Promise<unknown>, [string, string]>().mockResolvedValue('OWNER'),
      assertAccessOrAdminAccess: jest
        .fn<Promise<'STAFF_OR_OWNER' | 'PLATFORM_ADMIN'>, [string, string]>()
        .mockResolvedValue('STAFF_OR_OWNER'),
      // Owner by default: the pre-existing completeSession tests complete as the shop owner.
      getActorKind: jest
        .fn<Promise<'OWNER' | 'STAFF' | 'PLATFORM_ADMIN' | null>, [string, string]>()
        .mockResolvedValue('OWNER'),
    };
    realtime = {
      emitQueueUpdated: jest.fn(),
      emitEntryCalled: jest.fn(),
      emitStaffStatusChanged: jest.fn(),
      emitQueueEntryReassigned: jest.fn(),
      emitQueueEntryWaitAlert: jest.fn(),
      emitQueueEntryJoined: jest.fn(),
    };
    pushDispatch = { dispatchLocalizedToUser: jest.fn().mockResolvedValue(undefined) };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        QueueService,
        { provide: PrismaService, useValue: prisma },
        { provide: AvailabilityService, useValue: availability },
        ReservationService,
        { provide: SalonAccessService, useValue: salonAccess },
        { provide: RealtimeGateway, useValue: realtime },
        { provide: NotificationsService, useValue: notifications },
        { provide: PushDispatchService, useValue: pushDispatch },
      ],
    }).compile();
    service = moduleRef.get(QueueService);

    // getDetailOrThrow is called at the end of nearly every mutating method — give it a default
    // resolved entry so each test only needs to override what it specifically cares about.
    prisma.queueEntry.findUnique.mockResolvedValue(makeDetailEntry());
  });

  describe('checkIn', () => {
    function makeCheckInBooking(overrides: Record<string, unknown> = {}) {
      return {
        id: 'bk1',
        salonId: 's1',
        serviceId: 'sv1',
        status: 'CONFIRMED',
        slotStart: new Date(),
        ...overrides,
      };
    }

    // Regression for the final-seven hardening review's confirmed race: the pre-check
    // (existingForBooking, a plain read before the transaction) is a fast, friendly-error common
    // case, not the actual guarantee -- two concurrent check-ins for the same booking can both
    // pass it before either commits. QueueEntry.bookingId's unique index (added alongside this
    // fix) is the real backstop; losing that race must surface as the same ALREADY_CHECKED_IN
    // error a client already knows how to handle, never a raw 500.
    it('translates a P2002 race on QueueEntry.bookingId to ALREADY_CHECKED_IN, not a raw error', async () => {
      prisma.booking.findFirst.mockResolvedValueOnce(makeCheckInBooking());
      prisma.queueEntry.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['queue_entries_bookingId_key'] },
        }),
      );
      await expect(service.checkIn('c1', 'bk1')).rejects.toMatchObject({
        code: 'ALREADY_CHECKED_IN',
      });
    });

    it('creates an appointment entry that is already acknowledged as arrived', async () => {
      prisma.booking.findFirst.mockResolvedValueOnce(makeCheckInBooking());
      prisma.queueEntry.create.mockResolvedValueOnce({ id: 'q-new' });
      await service.checkIn('c1', 'bk1');
      expect(lastCallData(prisma.queueEntry.create).arrivedAt).toBeInstanceOf(Date);
    });

    it('creates the entry normally when nothing else has raced it', async () => {
      prisma.booking.findFirst.mockResolvedValueOnce(makeCheckInBooking());
      prisma.queueEntry.create.mockResolvedValueOnce({ id: 'q-new' });
      await service.checkIn('c1', 'bk1');
      expect(prisma.queueEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bookingId: 'bk1', customerId: 'c1' }),
        }),
      );
    });

    it('re-throws a non-P2002 error from the transaction unchanged', async () => {
      prisma.booking.findFirst.mockResolvedValueOnce(makeCheckInBooking());
      prisma.queueEntry.create.mockRejectedValueOnce(new Error('db is down'));
      await expect(service.checkIn('c1', 'bk1')).rejects.toThrow('db is down');
    });
  });

  // P0 arrival-alert mission — the owner/staff-triggered twin of checkIn(), reached from the
  // dashboard's ARRIVED confirmation. Converges on the exact same createArrivalQueueEntry path.
  describe('arriveAsOperator', () => {
    function makeArrivalBooking(overrides: Record<string, unknown> = {}) {
      return {
        id: 'bk1',
        salonId: 's1',
        serviceId: 'sv1',
        customerId: 'c1',
        status: 'CONFIRMED',
        slotStart: new Date(),
        ...overrides,
      };
    }

    it('checks salon access for the calling operator before doing anything else', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(makeArrivalBooking());
      prisma.queueEntry.create.mockResolvedValueOnce({ id: 'q-new' });
      await service.arriveAsOperator('op-1', 'bk1');
      expect(salonAccess.assertAccessOrAdminAccess).toHaveBeenCalledWith('op-1', 's1');
    });

    it('creates exactly one QueueEntry for the booking\'s own customer, same as self-check-in', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(makeArrivalBooking());
      prisma.queueEntry.create.mockResolvedValueOnce({ id: 'q-new' });
      await service.arriveAsOperator('op-1', 'bk1');
      expect(prisma.queueEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bookingId: 'bk1', customerId: 'c1', source: 'APPOINTMENT' }),
        }),
      );
    });

    it('requirement 9 (arrival race): a customer self-check-in racing this exact operator click converges on one QueueEntry — the loser gets ALREADY_CHECKED_IN, not a raw error', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(makeArrivalBooking());
      prisma.queueEntry.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['queue_entries_bookingId_key'] },
        }),
      );
      await expect(service.arriveAsOperator('op-1', 'bk1')).rejects.toMatchObject({
        code: 'ALREADY_CHECKED_IN',
      });
    });

    it('rejects a booking that is not CONFIRMED', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(makeArrivalBooking({ status: 'NO_SHOW' }));
      await expect(service.arriveAsOperator('op-1', 'bk1')).rejects.toMatchObject({
        code: 'INVALID_QUEUE_TRANSITION',
      });
    });

    it('throws BOOKING_NOT_FOUND for an unknown booking', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(service.arriveAsOperator('op-1', 'nope')).rejects.toMatchObject({
        code: 'BOOKING_NOT_FOUND',
      });
    });
  });

  describe('joinWalkIn', () => {
    it('creates one queue ticket with all selected services and their extra duration', async () => {
      availability.getServicesOrThrow.mockResolvedValue([
        { id: 'sv1', name: 'Haircut', durationMinutes: 30, price: 300 },
        { id: 'sv2', name: 'Beard trim', durationMinutes: 15, price: 150 },
      ]);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });

      await service.joinWalkIn('c1', 's1', ['sv1', 'sv2']);

      expect(availability.getServicesOrThrow).toHaveBeenCalledWith('s1', ['sv1', 'sv2']);
      expect(prisma.queueEntry.create).toHaveBeenCalledTimes(1);
      expect(lastCallData(prisma.queueEntry.create)).toMatchObject({
        serviceId: 'sv1',
        addOnMinutes: 15,
        addOns: { create: [
          { serviceId: 'sv2', name: 'Beard trim', durationMinutes: 15, price: 150 },
        ] },
      });
    });

    it('rejects with ALREADY_IN_QUEUE when the customer already has an active entry', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(makeRawEntry());
      await expect(service.joinWalkIn('c1', 's1')).rejects.toMatchObject({
        code: 'ALREADY_IN_QUEUE',
      });
      expect(prisma.queueEntry.create).not.toHaveBeenCalled();
    });

    it('assigns the next token number per salon, advisory-locked, from the last entry of the IST day', async () => {
      prisma.queueEntry.findFirst
        .mockResolvedValueOnce(null) // assertNotAlreadyInQueue
        .mockResolvedValueOnce({ tokenNumber: 5 }); // nextTokenNumber's last-entry lookup
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });

      await service.joinWalkIn('c1', 's1', 'sv1');

      expect(prisma.$executeRaw).toHaveBeenCalled();
      const data = lastCallData(prisma.queueEntry.create);
      expect(data.tokenNumber).toBe(6);
      expect(data.source).toBe(QueueEntrySource.WALK_IN);
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('alerts the owner on every screen and by OS push once the join has committed (owner report, 13 Nov)', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q9' });
      const detail = await service.joinWalkIn('c1', 's1', 'sv1');

      expect(realtime.emitQueueEntryJoined).toHaveBeenCalledWith(detail.salonId, detail.id, detail.tokenNumber, detail.serviceName ?? null);
      const [ownerId, kind, , data] = pushDispatch.dispatchLocalizedToUser.mock.calls[0];
      expect(kind).toBe('queueJoined');
      expect(typeof ownerId).toBe('string');
      // Ids only - never the customer's name or phone in a push payload.
      expect(data).toEqual({ type: 'queue.joined', salonId: detail.salonId, queueEntryId: detail.id });
    });

    it('never fails a successful join when the alert itself fails', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q10' });
      realtime.emitQueueEntryJoined.mockImplementation(() => { throw new Error('socket down'); });
      pushDispatch.dispatchLocalizedToUser.mockRejectedValue(new Error('expo down'));
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeTruthy();
    });

    describe('contact details (Live Queue operations)', () => {
      function primeJoin() {
        prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        prisma.queueEntry.create.mockResolvedValue({ id: 'q-contact' });
      }

      it('persists the contact name and phone given with the join, but starts NOT arrived', async () => {
        primeJoin();
        await service.joinWalkIn('c1', 's1', undefined, { name: 'Ravi Kumar', phone: '+919811122233' });
        const data = lastCallData(prisma.queueEntry.create);
        expect(data.contactName).toBe('Ravi Kumar');
        expect(data.contactPhone).toBe('+919811122233');
        expect(data).not.toHaveProperty('arrivedAt'); // a remote/QR join is not proof of presence
      });

      it('prefers the number given with the join over the account phone', async () => {
        primeJoin();
        await service.joinWalkIn('c1', 's1', undefined, { phone: '+919811122233' });
        expect(lastCallData(prisma.queueEntry.create).contactPhone).toBe('+919811122233');
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      });

      it('falls back to the account phone when none is given, so older clients keep working', async () => {
        primeJoin();
        await service.joinWalkIn('c1', 's1');
        const data = lastCallData(prisma.queueEntry.create);
        expect(data.contactPhone).toBe('+919000000001');
        expect(data.contactName).toBeNull();
      });

      it('refuses to create an uncontactable entry when neither a join phone nor an account phone exists', async () => {
        prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
        prisma.user.findUnique.mockResolvedValue({ phone: null }); // e.g. a Google-sign-in account
        await expect(service.joinWalkIn('c1', 's1', undefined, { name: 'Ravi' })).rejects.toMatchObject({
          code: 'CONTACT_PHONE_REQUIRED',
        });
        expect(prisma.queueEntry.create).not.toHaveBeenCalled();
        expect(realtime.emitQueueUpdated).not.toHaveBeenCalled();
      });
    });

    it('starts numbering at 1 when no entries exist yet for the salon today', async () => {
      prisma.queueEntry.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q3' });

      await service.joinWalkIn('c1', 's1');

      const data = lastCallData(prisma.queueEntry.create);
      expect(data.tokenNumber).toBe(1);
    });
  });

  describe('call', () => {
    it('throws INVALID_QUEUE_TRANSITION when the entry is no longer WAITING (lost race)', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.call('staff1', 'q1')).rejects.toMatchObject({
        code: 'INVALID_QUEUE_TRANSITION',
      });
    });

    it('enforces salon access before calling an entry', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      salonAccess.assertAccessOrAdminAccess.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(service.call('staff1', 'q1')).rejects.toMatchObject({
        code: 'SALON_ACCESS_DENIED',
      });
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
    });

    it('calls a WAITING entry and emits both queue.updated and queue.entry.called', async () => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry())
        .mockResolvedValueOnce(
          makeDetailEntry({ status: QueueEntryStatus.CALLED }),
        );

      await service.call('staff1', 'q1');

      expect(salonAccess.assertAccessOrAdminAccess).toHaveBeenCalledWith('staff1', 's1');
      expect(realtime.emitEntryCalled).toHaveBeenCalledWith('s1', 'q1', 'c1');
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    // Part 2 — delegated shop management.
    it('a delegated PLATFORM_ADMIN calling an entry is recorded under the real admin actor', async () => {
      salonAccess.assertAccessOrAdminAccess.mockResolvedValueOnce('PLATFORM_ADMIN');
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry())
        .mockResolvedValueOnce(makeDetailEntry({ status: QueueEntryStatus.CALLED }));

      await service.call('admin1', 'q1');

      expect(salonAccess.assertAccessOrAdminAccess).toHaveBeenCalledWith('admin1', 's1');
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin1',
          action: 'ADMIN_QUEUE_ENTRY_CALLED',
          entityType: 'QueueEntry',
          entityId: 'q1',
          metadata: { salonId: 's1' },
        },
      });
    });
  });

  describe('markArrived (Live Queue arrival acknowledgement)', () => {
    it('enforces salon access before touching the entry', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      salonAccess.assertAccessOrAdminAccess.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(service.markArrived('stranger', 'q1')).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
    });

    it('records arrival only by filling a NULL arrivedAt on a still-active entry', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await service.markArrived('staff1', 'q1');
      const call = prisma.queueEntry.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(call.where).toMatchObject({ id: 'q1', arrivedAt: null });
      expect(call.where.status).toEqual({ in: ['WAITING', 'CALLED'] });
      expect(call.data.arrivedAt).toBeInstanceOf(Date);
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('is idempotent: an already-arrived entry is returned unchanged with no write and no realtime noise', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ arrivedAt: new Date() }));
      await expect(service.markArrived('staff1', 'q1')).resolves.toBeDefined();
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
      expect(realtime.emitQueueUpdated).not.toHaveBeenCalled();
    });

    it('treats losing a race to another operator as success, not an error', async () => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry()) // initial read: not yet arrived
        .mockResolvedValueOnce({ arrivedAt: new Date() }); // re-read after the lost claim
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.markArrived('staff1', 'q1')).resolves.toBeDefined();
    });

    it('reports a real conflict when the entry left the active states underneath the request', async () => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry())
        .mockResolvedValueOnce({ arrivedAt: null });
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.markArrived('staff1', 'q1')).rejects.toMatchObject({ code: 'INVALID_QUEUE_TRANSITION' });
    });

    it.each(['IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'])(
      'refuses to mark a %s entry arrived',
      async (status) => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ status }));
        await expect(service.markArrived('staff1', 'q1')).rejects.toMatchObject({ code: 'INVALID_QUEUE_TRANSITION' });
        expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
      },
    );
  });

  describe('queue detail DTO - contact + arrival', () => {
    it('exposes the join contact name/phone and arrival time to the (authorized) dashboard caller', async () => {
      const arrivedAt = new Date('2026-09-20T10:00:00.000Z');
      prisma.queueEntry.findUnique.mockResolvedValue(
        makeDetailEntry({ contactName: 'Ravi Kumar', contactPhone: '+919811122233', arrivedAt }),
      );
      const dto = await service.markArrived('staff1', 'q1');
      expect(dto.customerName).toBe('Ravi Kumar');
      expect(dto.customerPhone).toBe('+919811122233');
      expect(dto.arrivedAt).toBe(arrivedAt.toISOString());
    });

    it('falls back to the account phone when the entry has no join phone', async () => {
      prisma.queueEntry.findUnique.mockResolvedValue(
        makeDetailEntry({ contactPhone: null, arrivedAt: new Date(), customer: { phone: '+919000000001' } }),
      );
      expect((await service.markArrived('staff1', 'q1')).customerPhone).toBe('+919000000001');
    });

    it('never invents a name: a null contactName stays null (no email/phone-derived display name)', async () => {
      prisma.queueEntry.findUnique.mockResolvedValue(
        makeDetailEntry({ contactName: null, arrivedAt: new Date(), customer: { phone: '+919000000001', email: 'x@y.com' } }),
      );
      const dto = await service.markArrived('staff1', 'q1');
      expect(dto.customerName).toBeNull();
      expect(JSON.stringify(dto)).not.toContain('x@y.com');
    });

    it('reports null arrivedAt for a remote join that has not been acknowledged', async () => {
      prisma.queueEntry.findUnique.mockResolvedValue(makeDetailEntry({ arrivedAt: null }));
      const dto = await service.markArrived('staff1', 'q1');
      expect(dto.arrivedAt).toBeNull();
    });
  });

  describe('assign', () => {
    const input = { staffId: 'st1', chairId: 'ch1' };

    beforeEach(() => {
      prisma.chair.findFirst.mockResolvedValue({
        id: 'ch1',
        salonId: 's1',
        status: 'ACTIVE',
      });
    });

    it('throws SERVICE_REQUIRED when neither the entry nor the request specifies a service', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ serviceId: null }),
      );
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'SERVICE_REQUIRED',
        },
      );
      expect(availability.assertStaffQualified).not.toHaveBeenCalled();
    });

    it('implicitly acknowledges arrival when seating an entry that was never marked arrived', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ arrivedAt: null }));
      await service.assign('staff1', 'q1', input);
      const claim = prisma.queueEntry.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(claim.data.status).toBe('IN_SERVICE');
      expect(claim.data.arrivedAt).toBeInstanceOf(Date);
    });

    it('never overwrites an earlier explicit arrival time when assigning', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ arrivedAt: new Date('2026-09-20T09:00:00Z') }));
      await service.assign('staff1', 'q1', input);
      const claim = prisma.queueEntry.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(claim.data).not.toHaveProperty('arrivedAt');
    });

    it('reuses AvailabilityService.assertStaffQualified for the qualification check', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await service.assign('staff1', 'q1', input);
      expect(availability.assertStaffQualified).toHaveBeenCalledWith(
        's1',
        'sv1',
        'st1',
      );
    });

    it('throws CHAIR_NOT_FOUND when the chair does not belong to the salon', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.chair.findFirst.mockResolvedValueOnce(null);
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'CHAIR_NOT_FOUND',
        },
      );
    });

    it('throws CHAIR_INACTIVE when the chair is not ACTIVE', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.chair.findFirst.mockResolvedValueOnce({
        id: 'ch1',
        salonId: 's1',
        status: 'INACTIVE',
      });
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'CHAIR_INACTIVE',
        },
      );
    });

    it('throws INVALID_QUEUE_TRANSITION when the entry is no longer WAITING/CALLED (lost race)', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'INVALID_QUEUE_TRANSITION',
        },
      );
      expect(prisma.serviceSession.create).not.toHaveBeenCalled();
    });

    it('maps a P2002 on the staff partial-unique-index to 409 STAFF_ALREADY_OCCUPIED', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.serviceSession.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['service_session_staff_active_uq'] },
        }),
      );
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'STAFF_ALREADY_OCCUPIED',
        },
      );
    });

    it('maps a P2002 on the chair partial-unique-index to 409 CHAIR_ALREADY_OCCUPIED', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.serviceSession.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['service_session_chair_active_uq'] },
        }),
      );
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject(
        {
          code: 'CHAIR_ALREADY_OCCUPIED',
        },
      );
    });

    it('rethrows an unrelated database error unchanged', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      const boom = new Error('connection lost');
      prisma.serviceSession.create.mockRejectedValueOnce(boom);
      await expect(service.assign('staff1', 'q1', input)).rejects.toThrow(
        'connection lost',
      );
    });

    it('creates the ServiceSession and moves the entry to IN_SERVICE on success', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await service.assign('staff1', 'q1', input);
      const sessionData = lastCallData(prisma.serviceSession.create);
      expect(sessionData).toMatchObject({
        queueEntryId: 'q1',
        staffId: 'st1',
        chairId: 'ch1',
        serviceId: 'sv1',
        status: 'ACTIVE',
      });
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Owner-operations corrective mission: ASSIGNED is not IN SERVICE.
  //   WAITING -> ASSIGNED (CALLED + barber + chair, no session) -> IN_SERVICE (explicit start)
  // ---------------------------------------------------------------------------------------------
  describe('assignment is separate from the start of service', () => {
    const input = { staffId: 'st1', chairId: 'ch1' };

    beforeEach(() => {
      prisma.chair.findFirst.mockResolvedValue({ id: 'ch1', salonId: 's1', status: 'ACTIVE' });
    });

    function claimOf(index = 0) {
      return prisma.queueEntry.updateMany.mock.calls[index][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
    }

    it('assign with startService:false reserves the barber and chair but does NOT start the service', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ arrivedAt: null }));
      await service.assign('staff1', 'q1', { ...input, startService: false });
      const claim = claimOf();
      expect(claim.data.status).toBe('CALLED');
      expect(claim.data.assignedStaffId).toBe('st1');
      expect(claim.data.assignedChairId).toBe('ch1');
      expect(claim.data.assignedAt).toBeInstanceOf(Date);
      expect(claim.data).not.toHaveProperty('serviceStartedAt');
      // Being assigned says nothing about arrival.
      expect(claim.data).not.toHaveProperty('arrivedAt');
      expect(prisma.serviceSession.create).not.toHaveBeenCalled();
    });

    it('tells the customer\'s device they were called when a WAITING customer is assigned', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await service.assign('staff1', 'q1', { ...input, startService: false });
      expect(realtime.emitEntryCalled).toHaveBeenCalledWith('s1', 'q1', 'c1');
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('keeps an earlier calledAt when an already CALLED customer is assigned', async () => {
      const earlier = new Date('2026-10-13T05:00:00Z');
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ status: QueueEntryStatus.CALLED, calledAt: earlier }),
      );
      await service.assign('staff1', 'q1', { ...input, startService: false });
      expect(claimOf().data.calledAt).toBe(earlier);
      expect(realtime.emitEntryCalled).not.toHaveBeenCalled();
    });

    it('assignAsSystem atomically opens one ACTIVE session and moves an arrived guest straight IN_SERVICE', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ arrivedAt: new Date() }));
      await service.assignAsSystem('q1', input);
      expect(claimOf().data.status).toBe('IN_SERVICE');
      expect(claimOf().data.serviceStartedAt).toBeInstanceOf(Date);
      expect(prisma.serviceSession.create).toHaveBeenCalledTimes(1);
      const audit = lastCallData(prisma.auditLog.create);
      expect(audit).toMatchObject({ action: 'QUEUE_ENTRY_AUTO_ASSIGNED' });
      expect((audit.metadata as Record<string, unknown>).serviceStarted).toBe(true);
    });

    it('without the flag, assign keeps the pre-existing seat-and-start behaviour for already-installed clients', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await service.assign('staff1', 'q1', input);
      expect(claimOf().data.status).toBe('IN_SERVICE');
      expect(claimOf().data.serviceStartedAt).toBeInstanceOf(Date);
      expect(prisma.serviceSession.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a barber who is already assigned to another customer', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.findFirst.mockImplementation(((args: { where: { assignedStaffId?: string } }) =>
        Promise.resolve(args.where.assignedStaffId === 'st1' ? { assignedAt: new Date(), calledAt: null, service: { durationMinutes: 30 } } : null)) as never);
      await expect(
        service.assign('staff1', 'q1', { ...input, startService: false }),
      ).rejects.toMatchObject({ code: 'STAFF_ALREADY_OCCUPIED' });
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a chair that is already reserved for another assigned customer', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.findFirst.mockImplementation(((args: { where: { assignedChairId?: string } }) =>
        Promise.resolve(args.where.assignedChairId === 'ch1' ? { id: 'q-other' } : null)) as never);
      await expect(
        service.assign('staff1', 'q1', { ...input, startService: false }),
      ).rejects.toMatchObject({ code: 'CHAIR_ALREADY_OCCUPIED' });
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
    });

    it('maps the database backstop (partial unique index on the held barber) to STAFF_ALREADY_OCCUPIED', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.updateMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: 'queue_entries_assigned_staff_hold_key' },
        }),
      );
      await expect(
        service.assign('staff1', 'q1', { ...input, startService: false }),
      ).rejects.toMatchObject({ code: 'STAFF_ALREADY_OCCUPIED' });
    });

    it('maps the database backstop (partial unique index on the held chair) to CHAIR_ALREADY_OCCUPIED', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.queueEntry.updateMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: 'queue_entries_assigned_chair_hold_key' },
        }),
      );
      await expect(
        service.assign('staff1', 'q1', { ...input, startService: false }),
      ).rejects.toMatchObject({ code: 'CHAIR_ALREADY_OCCUPIED' });
    });

    describe('startService', () => {
      const assigned = () =>
        makeRawEntry({
          status: QueueEntryStatus.CALLED,
          assignedStaffId: 'st1',
          assignedChairId: 'ch1',
          assignedAt: new Date(),
          calledAt: new Date(),
          arrivedAt: new Date(),
        });

      it('refuses a customer nobody has been assigned to (WAITING)', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'NOT_ASSIGNED' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('refuses a CALLED customer that has no barber yet', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.CALLED }));
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'NOT_ASSIGNED' });
      });

      it('is idempotent for a double tap: an entry already IN_SERVICE is returned unchanged', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }));
        await service.startService('owner1', 'q1');
        expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('starts the service: claims the exact assignment, stamps serviceStartedAt and opens the ACTIVE session', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await service.startService('owner1', 'q1');
        const claim = claimOf();
        expect(claim.where).toMatchObject({ id: 'q1', status: 'CALLED', assignedStaffId: 'st1', assignedChairId: 'ch1' });
        expect(claim.data.status).toBe('IN_SERVICE');
        expect(claim.data.serviceStartedAt).toBeInstanceOf(Date);
        expect(lastCallData(prisma.serviceSession.create)).toMatchObject({
          queueEntryId: 'q1',
          staffId: 'st1',
          chairId: 'ch1',
          serviceId: 'sv1',
          status: 'ACTIVE',
        });
        expect(lastCallData(prisma.auditLog.create)).toMatchObject({ action: 'QUEUE_ENTRY_SERVICE_STARTED', actorUserId: 'owner1' });
        expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
      });

      it('re-validates qualification, not just the stored assignment', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await service.startService('owner1', 'q1');
        expect(availability.assertStaffQualified).toHaveBeenCalledWith('s1', 'sv1', 'st1');
      });

      it('takes the per-salon and per-chair advisory locks before claiming', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await service.startService('owner1', 'q1');
        expect(prisma.$executeRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      it('a barber can start only THEIR OWN assigned customer', async () => {
        salonAccess.getActorKind.mockResolvedValueOnce('STAFF');
        prisma.salonStaff.findFirst.mockResolvedValueOnce({
          id: 'st1',
          userId: 'someone-else',
          status: 'ACTIVE',
          accessRevokedAt: null,
          displayName: 'Ramesh',
        });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('staff-user-2', 'q1')).rejects.toMatchObject({ code: 'NOT_YOUR_ASSIGNMENT' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('the assigned barber starts their own customer', async () => {
        salonAccess.getActorKind.mockResolvedValueOnce('STAFF');
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await service.startService('staff-user-1', 'q1');
        expect(prisma.serviceSession.create).toHaveBeenCalledTimes(1);
      });

      it('refuses when the assigned barber has since gone off duty', async () => {
        prisma.salonStaff.findFirst.mockResolvedValueOnce({
          id: 'st1',
          userId: 'staff-user-1',
          status: 'INACTIVE',
          accessRevokedAt: null,
          displayName: 'Ramesh',
        });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_STARTABLE' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('refuses when the assigned barber\'s access was removed', async () => {
        prisma.salonStaff.findFirst.mockResolvedValueOnce({
          id: 'st1',
          userId: 'staff-user-1',
          status: 'ACTIVE',
          accessRevokedAt: new Date(),
          displayName: 'Ramesh',
        });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_STARTABLE' });
      });

      it('refuses when the assigned chair is no longer active', async () => {
        prisma.chair.findFirst.mockResolvedValue({ id: 'ch1', salonId: 's1', status: 'MAINTENANCE' });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_STARTABLE' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('refuses when a local customer now occupies the chair', async () => {
        prisma.manualChairOccupancy.findFirst.mockResolvedValueOnce({ id: 'm1' });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'CHAIR_ALREADY_OCCUPIED' });
        expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
      });

      it('refuses when the barber has since been booked for an appointment in the way', async () => {
        prisma.booking.count.mockResolvedValue(1);
        prisma.booking.findFirst.mockResolvedValue({ slotEnd: new Date(Date.now() + 20 * 60_000) });
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'STAFF_RESERVED_FOR_APPOINTMENT' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('loses cleanly when the assignment changed underneath (cancelled, reassigned or released)', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'INVALID_QUEUE_TRANSITION' });
        expect(prisma.serviceSession.create).not.toHaveBeenCalled();
      });

      it('maps a barber who is already serving someone (session unique index) to STAFF_ALREADY_OCCUPIED', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce(assigned());
        prisma.serviceSession.create.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.0.0',
            meta: { target: ['service_session_staff_active_uq'] },
          }),
        );
        await expect(service.startService('owner1', 'q1')).rejects.toMatchObject({ code: 'STAFF_ALREADY_OCCUPIED' });
      });

      it('implicitly acknowledges arrival if staff start someone who was never marked arrived', async () => {
        prisma.queueEntry.findUnique.mockResolvedValueOnce({ ...assigned(), arrivedAt: null });
        await service.startService('owner1', 'q1');
        expect(claimOf().data.arrivedAt).toBeInstanceOf(Date);
      });
    });

    describe('the live board keeps Waiting, Assigned and In service apart', () => {
      it('puts an assigned customer in `assigned`, not in `waiting`, `called` or `inService`, with exact counts', async () => {
        prisma.queueEntry.findMany.mockResolvedValueOnce([]); // recomputeEtas
        prisma.queueEntry.findMany.mockResolvedValueOnce([
          makeDetailEntry({ id: 'q1', status: QueueEntryStatus.WAITING }),
          makeDetailEntry({ id: 'q2', status: QueueEntryStatus.CALLED }),
          makeDetailEntry({
            id: 'q3',
            tokenNumber: 3,
            status: QueueEntryStatus.CALLED,
            assignedStaffId: 'st1',
            assignedChairId: 'ch1',
            assignedAt: new Date(),
            assignedStaff: { displayName: 'Ramesh' },
            assignedChair: { label: 'Chair 1' },
          }),
          makeDetailEntry({ id: 'q4', status: QueueEntryStatus.IN_SERVICE, assignedStaffId: 'st2', serviceStartedAt: new Date() }),
        ]);
        prisma.chair.findMany.mockResolvedValueOnce([{ id: 'ch1', label: 'Chair 1' }]);
        const board = await service.getDashboardQueue('owner1', 's1');
        const ids = (rows: { id: string }[] | undefined) => (rows ?? []).map((e) => e.id);
        expect(ids(board.sections?.waiting)).toEqual(['q1']);
        expect(ids(board.sections?.called)).toEqual(['q2']);
        expect(ids(board.sections?.assigned)).toEqual(['q3']);
        expect(ids(board.sections?.inService)).toEqual(['q4']);
        expect(board.counts).toMatchObject({ waiting: 1, called: 1, assigned: 1, inService: 1 });
        // The flat list is unchanged for clients that predate sections.
        expect(ids(board.entries)).toEqual(['q1', 'q2', 'q3', 'q4']);
      });

      it('reports each customer\'s phase and a null serviceStartedAt until the service really starts', async () => {
        prisma.queueEntry.findMany.mockResolvedValueOnce([]);
        prisma.queueEntry.findMany.mockResolvedValueOnce([
          makeDetailEntry({ id: 'q3', status: QueueEntryStatus.CALLED, assignedStaffId: 'st1', assignedChairId: 'ch1', assignedAt: new Date() }),
          makeDetailEntry({ id: 'q4', status: QueueEntryStatus.IN_SERVICE, assignedStaffId: 'st2', serviceStartedAt: new Date() }),
        ]);
        const board = await service.getDashboardQueue('owner1', 's1');
        const byId = Object.fromEntries(board.entries.map((e) => [e.id, e]));
        expect(byId.q3.phase).toBe('ASSIGNED');
        expect(byId.q3.serviceStartedAt).toBeNull();
        expect(byId.q3.assignedAt).not.toBeNull();
        expect(byId.q4.phase).toBe('IN_SERVICE');
        expect(byId.q4.serviceStartedAt).not.toBeNull();
      });

      it('marks the chair held by an assigned customer as reserved (and not free to another)', async () => {
        prisma.queueEntry.findMany.mockResolvedValueOnce([]);
        prisma.queueEntry.findMany.mockResolvedValueOnce([
          makeDetailEntry({ id: 'q3', tokenNumber: 7, status: QueueEntryStatus.CALLED, assignedStaffId: 'st1', assignedChairId: 'ch1' }),
        ]);
        prisma.chair.findMany.mockResolvedValueOnce([
          { id: 'ch1', label: 'Chair 1' },
          { id: 'ch2', label: 'Chair 2' },
        ]);
        const board = await service.getDashboardQueue('owner1', 's1');
        expect(board.chairs.find((c) => c.id === 'ch1')).toMatchObject({ reservedForEntryId: 'q3', reservedForTokenNumber: 7 });
        expect(board.chairs.find((c) => c.id === 'ch2')).toMatchObject({ reservedForEntryId: null });
      });
    });
  });

  describe('reassign', () => {
    const activeEntry = makeRawEntry({
      status: QueueEntryStatus.IN_SERVICE,
      assignedStaffId: 'st1',
      assignedChairId: 'ch1',
      tokenNumber: 42,
      joinedAt: new Date('2026-08-28T05:00:00.000Z'),
    });
    const activeSession = {
      id: 'sess1',
      queueEntryId: 'q1',
      staffId: 'st1',
      chairId: 'ch1',
      serviceId: 'sv1',
      status: 'ACTIVE',
      startedAt: new Date('2026-08-28T05:15:00.000Z'),
    };

    // Booking/queue resource-reservation mission — serviceSession.findFirst is now called from
    // two different places with two different shapes: reassign()'s own "find the current active
    // session for this queue entry" (where.queueEntryId) and ReservationService's own guard "does
    // the NEW target staff already have an active session" (where.staffId). The default here
    // answers the first with the fixture and the second with "no session" (st2 is free), which is
    // what every pre-existing test in this block already assumed.
    function mockServiceSessionFindFirst(currentSession: unknown) {
      prisma.serviceSession.findFirst.mockImplementation((args: unknown) => {
        // Only ReservationService's own guard query filters by staffId; reassign()'s "find the
        // current session for this queue entry" lookup never does.
        const where = (args as { where?: { staffId?: string } })?.where;
        return Promise.resolve(where?.staffId ? null : currentSession);
      });
    }

    beforeEach(() => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(activeEntry)
        .mockResolvedValue(
          makeDetailEntry({
            ...activeEntry,
            assignedStaffId: 'st2',
            assignedChairId: 'ch2',
          }),
        );
      mockServiceSessionFindFirst(activeSession);
      prisma.chair.findFirst.mockResolvedValue({
        id: 'ch2',
        salonId: 's1',
        status: 'ACTIVE',
      });
    });

    it('moves barber and chair atomically while preserving token, join time and priority fields', async () => {
      await service.reassign('owner1', 'q1', {
        staffId: 'st2',
        chairId: 'ch2',
      });

      expect(availability.assertStaffQualified).toHaveBeenCalledWith(
        's1',
        'sv1',
        'st2',
      );
      const sessionData = lastCallData(prisma.serviceSession.updateMany);
      expect(sessionData).toEqual({ staffId: 'st2', chairId: 'ch2' });
      const queueData = lastCallData(prisma.queueEntry.updateMany);
      expect(queueData).toEqual({
        assignedStaffId: 'st2',
        assignedChairId: 'ch2',
      });
      expect(queueData).not.toHaveProperty('tokenNumber');
      expect(queueData).not.toHaveProperty('joinedAt');
      expect(queueData).not.toHaveProperty('status');
      expect(queueData).not.toHaveProperty('estimatedWaitMinutes');
      expect(realtime.emitQueueEntryReassigned).toHaveBeenCalledWith(
        's1',
        'q1',
      );
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('supports barber-only and chair-only changes without replacing the service session', async () => {
      await service.reassign('owner1', 'q1', { staffId: 'st2' });
      expect(lastCallData(prisma.serviceSession.updateMany)).toEqual({
        staffId: 'st2',
        chairId: 'ch1',
      });
      expect(prisma.serviceSession.create).not.toHaveBeenCalled();

      jest.clearAllMocks();
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(activeEntry)
        .mockResolvedValue(makeDetailEntry(activeEntry));
      mockServiceSessionFindFirst(activeSession);
      prisma.chair.findFirst.mockResolvedValue({
        id: 'ch2',
        salonId: 's1',
        status: 'ACTIVE',
      });
      prisma.serviceSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.queueEntry.updateMany.mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
      );
      availability.assertStaffQualified.mockResolvedValue(undefined);

      await service.reassign('owner1', 'q1', { chairId: 'ch2' });
      expect(lastCallData(prisma.serviceSession.updateMany)).toEqual({
        staffId: 'st1',
        chairId: 'ch2',
      });
    });

    it('constrains reassignment to active in-service visits with an active session', async () => {
      prisma.queueEntry.findUnique
        .mockReset()
        .mockResolvedValue(makeRawEntry({ status: QueueEntryStatus.CALLED }));
      await expect(
        service.reassign('owner1', 'q1', { staffId: 'st2' }),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_TRANSITION' });

      prisma.queueEntry.findUnique.mockReset().mockResolvedValue(activeEntry);
      prisma.serviceSession.findFirst.mockResolvedValue(null);
      await expect(
        service.reassign('owner1', 'q1', { staffId: 'st2' }),
      ).rejects.toMatchObject({ code: 'SERVICE_SESSION_NOT_FOUND' });
    });

    it('maps concurrent staff occupancy to a clear conflict and rolls back the entry update', async () => {
      prisma.serviceSession.updateMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: 'service_session_staff_active_uq' },
        }),
      );
      await expect(
        service.reassign('owner1', 'q1', { staffId: 'st2' }),
      ).rejects.toMatchObject({ code: 'STAFF_ALREADY_OCCUPIED' });
      expect(realtime.emitQueueEntryReassigned).not.toHaveBeenCalled();
    });
  });

  describe('completeSession - a barber may only complete their own service (owner-operations mission)', () => {
    const session = () => ({
      id: 'sess1',
      queueEntryId: 'q1',
      staffId: 'staff-row-1',
      queueEntry: makeRawEntry({ bookingId: null }),
    });

    it('lets the barber who is performing the service complete it', async () => {
      salonAccess.getActorKind.mockResolvedValueOnce('STAFF');
      prisma.salonStaff.findUnique.mockResolvedValueOnce({ userId: 'barber-user' });
      prisma.serviceSession.findUnique.mockResolvedValueOnce(session());
      await service.completeSession('barber-user', 'sess1');
      expect(prisma.serviceSession.updateMany).toHaveBeenCalled();
    });

    it("rejects a colleague completing someone else's service with NOT_YOUR_SERVICE_SESSION and changes nothing", async () => {
      salonAccess.getActorKind.mockResolvedValueOnce('STAFF');
      prisma.salonStaff.findUnique.mockResolvedValueOnce({ userId: 'someone-else' });
      prisma.serviceSession.findUnique.mockResolvedValueOnce(session());
      await expect(service.completeSession('barber-user', 'sess1')).rejects.toMatchObject({
        code: 'NOT_YOUR_SERVICE_SESSION',
      });
      expect(prisma.serviceSession.updateMany).not.toHaveBeenCalled();
    });

    it('lets the owner complete any service without a roster lookup', async () => {
      salonAccess.getActorKind.mockResolvedValueOnce('OWNER');
      prisma.serviceSession.findUnique.mockResolvedValueOnce(session());
      await service.completeSession('owner-user', 'sess1');
      expect(prisma.salonStaff.findUnique).not.toHaveBeenCalled();
      expect(prisma.serviceSession.updateMany).toHaveBeenCalled();
    });

    it('lets a delegated platform admin complete any service', async () => {
      salonAccess.assertAccessOrAdminAccess.mockResolvedValueOnce('PLATFORM_ADMIN');
      prisma.serviceSession.findUnique.mockResolvedValueOnce(session());
      await service.completeSession('admin-user', 'sess1');
      expect(salonAccess.getActorKind).not.toHaveBeenCalled();
      expect(prisma.serviceSession.updateMany).toHaveBeenCalled();
    });
  });

  describe('completeSession', () => {
    it('throws SERVICE_SESSION_NOT_FOUND when the session does not exist', async () => {
      prisma.serviceSession.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.completeSession('staff1', 'sess1'),
      ).rejects.toMatchObject({ code: 'SERVICE_SESSION_NOT_FOUND' });
    });

    it('marks the Booking COMPLETED when the session traces back to an appointment-sourced entry', async () => {
      prisma.serviceSession.findUnique.mockResolvedValueOnce({
        id: 'sess1',
        queueEntryId: 'q1',
        queueEntry: makeRawEntry({ bookingId: 'b1' }),
      });
      await service.completeSession('staff1', 'sess1');
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('does not touch Booking for a walk-in-sourced entry (no bookingId)', async () => {
      prisma.serviceSession.findUnique.mockResolvedValueOnce({
        id: 'sess1',
        queueEntryId: 'q1',
        queueEntry: makeRawEntry({ bookingId: null }),
      });
      await service.completeSession('staff1', 'sess1');
      expect(prisma.booking.update).not.toHaveBeenCalled();
    });

    it('throws INVALID_QUEUE_TRANSITION when the session is no longer ACTIVE (lost race)', async () => {
      prisma.serviceSession.findUnique.mockResolvedValueOnce({
        id: 'sess1',
        queueEntryId: 'q1',
        queueEntry: makeRawEntry(),
      });
      prisma.serviceSession.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.completeSession('staff1', 'sess1'),
      ).rejects.toMatchObject({ code: 'INVALID_QUEUE_TRANSITION' });
      expect(prisma.queueEntry.update).not.toHaveBeenCalled();
    });

    // FastQue Credits / Wallet V1 (post-review correction): completing a service must NEVER
    // automatically grant the customer any credit — an earlier version of this method did, which
    // was a misreading of the product rule (floor(price/50)*10 is a redemption cap, not an earn
    // rate). Regression guard: no credits service is even wired into QueueService's constructor
    // any more (see the providers list above), so there is no code path left that could reintroduce
    // this by accident without a compile error.
    it('never touches CustomerCreditAccount/CustomerCreditTransaction on completion', async () => {
      prisma.serviceSession.findUnique.mockResolvedValueOnce({
        id: 'sess1',
        queueEntryId: 'q1',
        queueEntry: makeRawEntry({ bookingId: 'b1', customerId: 'c1' }),
      });
      await service.completeSession('staff1', 'sess1');
      expect(prisma.booking.update).toHaveBeenCalledTimes(1);
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'COMPLETED' },
      });
    });
  });

  describe('cancelByCustomer', () => {
    const owned = { id: 'q1', salonId: 's1', status: QueueEntryStatus.WAITING };

    it('lets the signed-in owner cancel a WAITING standalone token without deleting history', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(owned);
      await service.cancelByCustomer('c1', 'q1');
      expect(prisma.queueEntry.findFirst).toHaveBeenCalledWith({
        where: { id: 'q1', customerId: 'c1', bookingId: null },
        select: { id: true, salonId: true, status: true },
      });
      expect(prisma.queueEntry.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'q1',
          customerId: 'c1',
          bookingId: null,
          status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED] },
        },
        data: { status: QueueEntryStatus.CANCELLED },
      });
      expect(prisma.serviceSession.updateMany).not.toHaveBeenCalled();
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('permits CALLED/assigned-but-not-started and frees the position', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce({
        ...owned,
        status: QueueEntryStatus.CALLED,
      });
      await service.cancelByCustomer('c1', 'q1');
      expect(prisma.queueEntry.updateMany).toHaveBeenCalledTimes(1);
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('rejects another customer and booking-linked check-ins without a mutation', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      await expect(service.cancelByCustomer('attacker', 'q1')).rejects.toMatchObject({
        code: 'QUEUE_ENTRY_NOT_FOUND',
      });
      expect(prisma.queueEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q1', customerId: 'attacker', bookingId: null },
        }),
      );
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
    });

    it('treats a repeat cancel of an already CANCELLED token as success with no repeated side effects', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce({
        ...owned,
        status: QueueEntryStatus.CANCELLED,
      });
      await expect(service.cancelByCustomer('c1', 'q1')).resolves.toBeDefined();
      expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
      expect(realtime.emitQueueUpdated).not.toHaveBeenCalled();
    });

    it('succeeds when the compare-and-set loses to a concurrent cancel of the same token', async () => {
      prisma.queueEntry.findFirst
        .mockResolvedValueOnce(owned)
        .mockResolvedValueOnce({ status: QueueEntryStatus.CANCELLED });
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancelByCustomer('c1', 'q1')).resolves.toBeDefined();
      expect(realtime.emitQueueUpdated).not.toHaveBeenCalled();
    });

    it.each([QueueEntryStatus.IN_SERVICE, QueueEntryStatus.COMPLETED])(
      'refuses started or completed state %s',
      async (status) => {
        prisma.queueEntry.findFirst.mockResolvedValueOnce({ ...owned, status });
        await expect(service.cancelByCustomer('c1', 'q1')).rejects.toMatchObject({
          code: 'INVALID_QUEUE_TRANSITION',
        });
        expect(prisma.queueEntry.updateMany).not.toHaveBeenCalled();
      },
    );

    it('returns a conflict when the compare-and-set loses to service start', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(owned);
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancelByCustomer('c1', 'q1')).rejects.toMatchObject({
        code: 'INVALID_QUEUE_TRANSITION',
      });
      expect(realtime.emitQueueUpdated).not.toHaveBeenCalled();
    });
  });

  describe('cancelByStaff', () => {
    it("cascades to cancel an IN_SERVICE entry's ACTIVE ServiceSession", async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }),
      );
      await service.cancelByStaff('staff1', 'q1');
      expect(prisma.serviceSession.updateMany.mock.calls[0][0]).toMatchObject({
        where: { queueEntryId: 'q1', status: 'ACTIVE' },
      });
      expect(lastCallData(prisma.serviceSession.updateMany).status).toBe(
        'CANCELLED',
      );
    });

    it('throws INVALID_QUEUE_TRANSITION for an entry already in a terminal state', async () => {
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ status: QueueEntryStatus.COMPLETED }),
      );
      prisma.queueEntry.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancelByStaff('staff1', 'q1')).rejects.toMatchObject(
        {
          code: 'INVALID_QUEUE_TRANSITION',
        },
      );
    });

    // Part 2 — delegated shop management. This mutation is transaction-wrapped (unlike call()'s
    // plain updateMany above) — the audit write still only happens after the transaction commits.
    it('a delegated PLATFORM_ADMIN cancelling an entry is recorded under the real admin actor', async () => {
      salonAccess.assertAccessOrAdminAccess.mockResolvedValueOnce('PLATFORM_ADMIN');
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ status: QueueEntryStatus.WAITING }),
      );
      await service.cancelByStaff('admin1', 'q1');
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin1',
          action: 'ADMIN_QUEUE_ENTRY_CANCELLED',
          entityType: 'QueueEntry',
          entityId: 'q1',
          metadata: { salonId: 's1' },
        },
      });
    });
  });

  describe('getDashboardQueue', () => {
    it('enforces salon access (UserRole-based, not SalonStaff-based)', async () => {
      salonAccess.assertAccessOrAdminAccess.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(
        service.getDashboardQueue('outsider', 's1'),
      ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
      expect(prisma.queueEntry.findMany).not.toHaveBeenCalled();
    });

    it('assigns 1-based positions only to WAITING entries, in join order', async () => {
      // getDashboardQueue now recomputes ETAs (Phase 5, "don't show a stale estimate") before
      // reading — that's a separate queryEntry.findMany call (WAITING-only, for recomputeEtas)
      // ahead of the actual display fetch below; an empty result makes recomputeEtas a no-op.
      prisma.queueEntry.findMany.mockResolvedValueOnce([]);
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeDetailEntry({ id: 'q1', status: QueueEntryStatus.WAITING }),
        makeDetailEntry({ id: 'q2', status: QueueEntryStatus.CALLED }),
        makeDetailEntry({ id: 'q3', status: QueueEntryStatus.WAITING }),
      ]);
      const result = await service.getDashboardQueue('owner1', 's1');
      const positions = Object.fromEntries(
        result.entries.map((e) => [e.id, e.position]),
      );
      expect(positions).toEqual({ q1: 1, q2: null, q3: 2 });
    });

    it('includes the salon\'s active services, for the assign form\'s "walk-in with no chosen service" picker', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([]);
      prisma.queueEntry.findMany.mockResolvedValueOnce([]);
      prisma.service.findMany.mockResolvedValueOnce([
        { id: 'svc1', name: 'Haircut' },
        { id: 'svc2', name: 'Beard Trim' },
      ]);
      const result = await service.getDashboardQueue('owner1', 's1');
      expect(result.services).toEqual([
        { id: 'svc1', name: 'Haircut' },
        { id: 'svc2', name: 'Beard Trim' },
      ]);
      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { salonId: 's1', isActive: true } }),
      );
    });
  });

  describe('getQueueStatus (public) - privacy', () => {
    it('never carries any customer contact or arrival detail', async () => {
      prisma.salonStaff.count.mockResolvedValueOnce(3);
      prisma.chair.count.mockResolvedValueOnce(4);
      const result = await service.getQueueStatus('s1');
      const json = JSON.stringify(result);
      for (const forbidden of ['customerName', 'customerPhone', 'contactName', 'contactPhone', 'arrivedAt', 'email']) {
        expect(json).not.toContain(forbidden);
      }
    });
  });

  describe('getQueueStatus (public)', () => {
    it('returns null estimatedWaitMinutes when there are no active staff/chairs', async () => {
      prisma.salonStaff.count.mockResolvedValueOnce(0);
      prisma.chair.count.mockResolvedValueOnce(0);
      const result = await service.getQueueStatus('s1');
      expect(result.estimatedWaitMinutes).toBeNull();
      expect(result.estimatedWaitRangeMinutes).toBeNull();
    });

    it('includes a matching estimatedWaitRangeMinutes whenever a point estimate exists', async () => {
      prisma.salonStaff.count.mockResolvedValueOnce(3);
      prisma.chair.count.mockResolvedValueOnce(4);
      const result = await service.getQueueStatus('s1');
      expect(result.estimatedWaitMinutes).not.toBeNull();
      expect(result.estimatedWaitRangeMinutes).not.toBeNull();
      expect(result.estimatedWaitRangeMinutes!.min).toBeLessThanOrEqual(result.estimatedWaitMinutes!);
      expect(result.estimatedWaitRangeMinutes!.max).toBeGreaterThanOrEqual(result.estimatedWaitMinutes!);
    });
  });

  describe('listHistoryForCustomer (owner report 14 Nov)', () => {
    it("returns only the customer's own walk-in joins, newest first, without contact details", async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        {
          id: 'q2',
          salonId: 's1',
          tokenNumber: 7,
          status: QueueEntryStatus.COMPLETED,
          joinedAt: new Date('2026-11-13T10:00:00.000Z'),
          serviceCompletedAt: new Date('2026-11-13T10:40:00.000Z'),
          contactPhone: '+919999999999',
          service: { name: 'Haircut' },
          salon: { name: 'Demo Studio', slug: 'demo', timezone: 'Asia/Kolkata', city: { slug: 'noida', countryCode: 'IN' } },
        },
      ]);
      const items = await service.listHistoryForCustomer('c1', 500);
      expect(prisma.queueEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customerId: 'c1', bookingId: null },
          orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
          take: 50,
        }),
      );
      expect(items).toEqual([
        {
          id: 'q2',
          salonId: 's1',
          salonName: 'Demo Studio',
          salonSlug: 'demo',
          citySlug: 'noida',
          countryCode: 'IN',
          salonTimezone: 'Asia/Kolkata',
          tokenNumber: 7,
          status: QueueEntryStatus.COMPLETED,
          serviceName: 'Haircut',
          joinedAt: '2026-11-13T10:00:00.000Z',
          serviceCompletedAt: '2026-11-13T10:40:00.000Z',
        },
      ]);
    });
  });

  describe('getActiveForCustomer (Phase 5 — recompute on read)', () => {
    it('returns null when the customer has no active entry', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      expect(await service.getActiveForCustomer('c1')).toBeNull();
    });

    it('recomputes ETAs before returning a WAITING entry, not just a stale stored value', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(
        makeRawEntry({ id: 'q1', salonId: 's1', status: QueueEntryStatus.WAITING }),
      );
      // First findMany call is recomputeEtas' own WAITING-only fetch.
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q1', customerId: 'c1', serviceId: null }),
      ]);
      prisma.queueEntry.findUniqueOrThrow.mockResolvedValueOnce(
        makeDetailEntry({ id: 'q1', status: QueueEntryStatus.WAITING }),
      );
      await service.getActiveForCustomer('c1');
      expect(prisma.queueEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'q1' } }),
      );
      expect(prisma.queueEntry.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'q1' } }),
      );
    });

    it('skips the recompute for a CALLED/IN_SERVICE entry (recomputeEtas only ever touches WAITING rows)', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(
        makeRawEntry({ id: 'q1', salonId: 's1', status: QueueEntryStatus.IN_SERVICE }),
      );
      prisma.queueEntry.findUniqueOrThrow.mockResolvedValueOnce(
        makeDetailEntry({ id: 'q1', status: QueueEntryStatus.IN_SERVICE }),
      );
      await service.getActiveForCustomer('c1');
      expect(prisma.queueEntry.update).not.toHaveBeenCalled();
    });

    it('includes estimatedWaitRangeMinutes and turnApproaching on the returned entry', async () => {
      prisma.queueEntry.findFirst.mockResolvedValueOnce(
        makeRawEntry({ id: 'q1', salonId: 's1', status: QueueEntryStatus.WAITING }),
      );
      prisma.queueEntry.findMany.mockResolvedValueOnce([]); // recomputeEtas no-op
      prisma.queueEntry.findUniqueOrThrow.mockResolvedValueOnce(
        makeDetailEntry({ id: 'q1', status: QueueEntryStatus.WAITING, estimatedWaitMinutes: 3 }),
      );
      const result = await service.getActiveForCustomer('c1');
      expect(result?.turnApproaching).toBe(true);
      expect(result?.estimatedWaitRangeMinutes).toEqual({ min: 0, max: 8 });
    });
  });

  describe('recomputeEtas — Smart Queue wait alerts (Phase 5)', () => {
    it('emits a wait alert when a customer-linked entry crosses into the turn-approaching window', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q1', customerId: 'c1', serviceId: null, estimatedWaitMinutes: 20 }),
      ]);
      // Default staffCount(3)/chairCount(4)/activeRemaining(0) with a single WAITING entry (0
      // people ahead) computes eta 0 — well inside the approaching window, down from 20.
      await service.recomputeEtas('s1');
      expect(realtime.emitQueueEntryWaitAlert).toHaveBeenCalledWith('s1', 'c1', 'q1');
    });

    it('does not emit for a walk-in entry with no linked customer account', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q1', customerId: null, serviceId: null, estimatedWaitMinutes: 20 }),
      ]);
      await service.recomputeEtas('s1');
      expect(realtime.emitQueueEntryWaitAlert).not.toHaveBeenCalled();
    });

    it('does not emit when the estimate is already near its previous value (no new information)', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        // Old estimate (3) is already within the approaching window and close to the new one (0).
        makeRawEntry({ id: 'q1', customerId: 'c1', serviceId: null, estimatedWaitMinutes: 3 }),
      ]);
      await service.recomputeEtas('s1');
      expect(realtime.emitQueueEntryWaitAlert).not.toHaveBeenCalled();
    });

    it('emits for a large swing even when the new estimate is outside the approaching window', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q1', customerId: 'c1', serviceId: null, estimatedWaitMinutes: 5 }),
      ]);
      // A session that just started with a long nominal duration pushes the computed estimate up
      // well past the approaching window and far from the old value (5) — a genuine large swing.
      prisma.serviceSession.findMany.mockResolvedValueOnce([
        { startedAt: new Date(Date.now() - 60_000), service: { durationMinutes: 60 } },
      ]);
      await service.recomputeEtas('s1');
      expect(realtime.emitQueueEntryWaitAlert).toHaveBeenCalledWith('s1', 'c1', 'q1');
    });
  });

  describe('recomputeEtas — multi-service booking duration (Issue 5 fix)', () => {
    it('resolves capacity from the FULL combined service selection, not just the primary Booking.serviceId', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({
          id: 'q1',
          serviceId: 'sv1',
          bookingId: 'bk1',
          booking: {
            serviceId: 'sv1',
            service: { name: 'Haircut', durationMinutes: 30, price: 300 },
            services: [
              { serviceId: 'sv1', serviceName: 'Haircut', durationMinutes: 30, price: 300 },
              { serviceId: 'sv2', serviceName: 'Beard Trim', durationMinutes: 15, price: 150 },
            ],
          },
        }),
      ]);
      await service.recomputeEtas('s1');
      expect(availability.getSlotCapacityForServices).toHaveBeenCalledWith(
        prisma,
        's1',
        ['sv1', 'sv2'],
      );
      expect(availability.getSlotCapacity).not.toHaveBeenCalled();
    });

    it('computes ETA from the SUM of every selected service\'s duration, not just the primary one', async () => {
      availability.getSlotCapacityForServices.mockResolvedValueOnce(1);
      // Two WAITING entries so the second has peopleAhead=1 and serverCount=1 — batchesAhead=1,
      // making the combined-vs-primary duration difference (45 vs 30) observable in the eta itself.
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q0', serviceId: null }),
        makeRawEntry({
          id: 'q1',
          serviceId: 'sv1',
          bookingId: 'bk1',
          booking: {
            serviceId: 'sv1',
            service: { name: 'Haircut', durationMinutes: 30, price: 300 },
            services: [
              { serviceId: 'sv1', serviceName: 'Haircut', durationMinutes: 30, price: 300 },
              { serviceId: 'sv2', serviceName: 'Beard Trim', durationMinutes: 15, price: 150 },
            ],
          },
        }),
      ]);
      await service.recomputeEtas('s1');
      const q1Update = prisma.queueEntry.update.mock.calls.find(
        (call) => (call[0] as { where: { id: string } }).where.id === 'q1',
      );
      expect((q1Update?.[0] as { data: { estimatedWaitMinutes: number } }).data.estimatedWaitMinutes).toBe(45);
    });

    it('falls back to the single serviceId FK for a walk-in entry with no linked booking', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q1', serviceId: 'sv1', bookingId: null }),
      ]);
      await service.recomputeEtas('s1');
      expect(availability.getSlotCapacity).toHaveBeenCalledWith(prisma, 's1', 'sv1');
      expect(availability.getSlotCapacityForServices).not.toHaveBeenCalled();
    });
  });

  describe('toDetailDto — combined service name for multi-service appointments (Issue 5 fix)', () => {
    it('shows every selected service, not just the primary one, for a booking-linked entry', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([]); // recomputeEtas no-op
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeDetailEntry({
          id: 'q1',
          bookingId: 'bk1',
          booking: {
            serviceId: 'sv1',
            service: { name: 'Haircut', durationMinutes: 30, price: 300 },
            services: [
              { serviceId: 'sv1', serviceName: 'Haircut', durationMinutes: 30, price: 300 },
              { serviceId: 'sv2', serviceName: 'Beard Trim', durationMinutes: 15, price: 150 },
            ],
          },
        }),
      ]);
      const result = await service.getDashboardQueue('owner1', 's1');
      expect(result.entries[0].serviceName).toBe('Haircut + Beard Trim');
    });

    it('keeps showing the single service name for a walk-in entry with no linked booking', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([]); // recomputeEtas no-op
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeDetailEntry({ id: 'q1', bookingId: null, service: { name: 'Haircut' } }),
      ]);
      const result = await service.getDashboardQueue('owner1', 's1');
      expect(result.entries[0].serviceName).toBe('Haircut');
    });
  });

  describe('getCapacitySummary (Phase 6 — Owner Capacity Dashboard)', () => {
    it('checks salon access before returning anything', async () => {
      salonAccess.assertAccessOrAdminAccess.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      await expect(
        service.getCapacitySummary('outsider', 's1'),
      ).rejects.toMatchObject({ code: 'SALON_ACCESS_DENIED' });
      expect(prisma.chair.findMany).not.toHaveBeenCalled();
    });

    it('splits chairs into active/busy/available/maintenance/inactive using ACTIVE service sessions', async () => {
      prisma.chair.findMany.mockResolvedValueOnce([
        { id: 'ch1', status: 'ACTIVE' },
        { id: 'ch2', status: 'ACTIVE' },
        { id: 'ch3', status: 'MAINTENANCE' },
        { id: 'ch4', status: 'INACTIVE' },
      ]);
      prisma.salonStaff.findMany.mockResolvedValueOnce([]);
      prisma.serviceSession.findMany.mockResolvedValueOnce([
        { chairId: 'ch1', staffId: 'st1' },
      ]);

      const result = await service.getCapacitySummary('owner1', 's1');

      expect(result.chairs).toEqual({
        active: 2,
        busy: 1,
        available: 1,
        maintenance: 1,
        inactive: 1,
      });
    });

    it('splits staff into active/busy/available/offDuty using ACTIVE service sessions', async () => {
      prisma.chair.findMany.mockResolvedValueOnce([]);
      prisma.salonStaff.findMany.mockResolvedValueOnce([
        { id: 'st1', status: 'ACTIVE' },
        { id: 'st2', status: 'ACTIVE' },
        { id: 'st3', status: 'INACTIVE' },
      ]);
      prisma.serviceSession.findMany.mockResolvedValueOnce([
        { chairId: 'ch1', staffId: 'st1' },
      ]);

      const result = await service.getCapacitySummary('owner1', 's1');

      expect(result.staff).toEqual({ active: 2, busy: 1, available: 1, offDuty: 1 });
    });

    it('averages only the WAITING entries that already have an estimate', async () => {
      prisma.chair.findMany.mockResolvedValueOnce([]);
      prisma.salonStaff.findMany.mockResolvedValueOnce([]);
      prisma.serviceSession.findMany.mockResolvedValueOnce([]);
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        { estimatedWaitMinutes: 10 },
        { estimatedWaitMinutes: 20 },
        { estimatedWaitMinutes: null },
      ]);

      const result = await service.getCapacitySummary('owner1', 's1');

      expect(result.averageEstimatedWaitMinutes).toBe(15);
    });

    it('reports a null average when no WAITING entry has an estimate yet', async () => {
      prisma.chair.findMany.mockResolvedValueOnce([]);
      prisma.salonStaff.findMany.mockResolvedValueOnce([]);
      prisma.serviceSession.findMany.mockResolvedValueOnce([]);
      prisma.queueEntry.findMany.mockResolvedValueOnce([]);

      const result = await service.getCapacitySummary('owner1', 's1');

      expect(result.averageEstimatedWaitMinutes).toBeNull();
    });

    it('reports currentServices as the count of ACTIVE service sessions', async () => {
      prisma.chair.findMany.mockResolvedValueOnce([]);
      prisma.salonStaff.findMany.mockResolvedValueOnce([]);
      prisma.serviceSession.findMany.mockResolvedValueOnce([
        { chairId: 'ch1', staffId: 'st1' },
        { chairId: 'ch2', staffId: 'st2' },
      ]);

      const result = await service.getCapacitySummary('owner1', 's1');

      expect(result.currentServices).toBe(2);
    });
  });

  describe('standalone Live Queue visit history for the Bookings screen', () => {
    it('scopes records to the selected salon and excludes booking-linked check-ins', async () => {
      const completed = makeDetailEntry({ id: 'queue-visit-1', bookingId: null, status: QueueEntryStatus.COMPLETED, estimatedWaitMinutes: null });
      prisma.queueEntry.findMany.mockResolvedValueOnce([completed]);
      const result = await service.getStandaloneQueueVisits('owner1', 's1', 'completed');
      expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith('owner1', 's1');
      const options = prisma.queueEntry.findMany.mock.calls.slice(-1)[0]?.[0] as {
        where: { salonId: string; bookingId: null; status: QueueEntryStatus };
        orderBy: unknown[];
      };
      expect(options.where).toMatchObject({ salonId: 's1', bookingId: null, status: QueueEntryStatus.COMPLETED });
      expect(options.orderBy).toEqual([{ joinedAt: 'desc' }, { id: 'desc' }]);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('queue-visit-1');
    });

    it('paginates historical standalone queue visits without an arbitrary today-only limit', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeDetailEntry({ id: 'visit-1', bookingId: null, estimatedWaitMinutes: null }),
        makeDetailEntry({ id: 'visit-2', bookingId: null, estimatedWaitMinutes: null }),
        makeDetailEntry({ id: 'visit-3', bookingId: null, estimatedWaitMinutes: null }),
      ]);
      const result = await service.getStandaloneQueueVisits('owner1', 's1', 'all', undefined, '2');
      expect(result.items.map((item) => item.id)).toEqual(['visit-1', 'visit-2']);
      expect(result.nextCursor).toBe('visit-2');
      const options = prisma.queueEntry.findMany.mock.calls.slice(-1)[0]?.[0] as { take: number; where: { bookingId: null } };
      expect(options.take).toBe(3);
      expect(options.where.bookingId).toBeNull();
    });

    it('refuses invalid filters before querying queue data', async () => {
      await expect(service.getStandaloneQueueVisits('owner1', 's1', 'not-a-filter')).rejects.toThrow();
      await expect(service.getStandaloneQueueVisits('owner1', 's1', 'all', undefined, '500')).rejects.toThrow();
      expect(prisma.queueEntry.findMany).not.toHaveBeenCalled();
    });

    it('treats queued visits as non-upcoming and restricts today to the salon-local day', async () => {
      expect(await service.getStandaloneQueueVisits('owner1', 's1', 'upcoming')).toEqual({ items: [], nextCursor: null });
      await service.getStandaloneQueueVisits('owner1', 's1', 'today');
      expect(availability.getSalonTimeZone).toHaveBeenCalledWith('s1');
      const options = prisma.queueEntry.findMany.mock.calls.slice(-1)[0]?.[0] as { where: { OR: unknown[]; salonId: string; bookingId: null } };
      expect(options.where.salonId).toBe('s1');
      expect(options.where.bookingId).toBeNull();
      expect(options.where.OR).toHaveLength(3);
    });
  });

  // ---------- Live-visit add-on mission (17 Nov 2026) ----------

  describe('add-on services on a live visit', () => {
    const beard = {
      id: 'sv2',
      salonId: 's1',
      name: 'Beard Trim',
      durationMinutes: 15,
      price: new Prisma.Decimal('150.00'),
      isActive: true,
    };

    function inTx(overrides: Record<string, unknown> = {}) {
      return {
        status: QueueEntryStatus.IN_SERVICE,
        serviceId: 'sv1',
        booking: null,
        addOns: [],
        ...overrides,
      };
    }

    it('records the add-on with a price/duration snapshot, updates the visit minutes, audits and refreshes every screen', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE })) // getEntryOrThrow
        .mockResolvedValueOnce(inTx()) // inside the transaction
        .mockResolvedValueOnce(
          makeDetailEntry({
            status: QueueEntryStatus.IN_SERVICE,
            addOnMinutes: 15,
            addOns: [
              {
                serviceId: 'sv2',
                name: 'Beard Trim',
                durationMinutes: 15,
                price: new Prisma.Decimal('150.00'),
                createdAt: new Date('2026-11-17T10:00:00.000Z'),
              },
            ],
          }),
        );

      const dto = await service.addAddOn('staff-user', 'q1', 'sv2');

      expect(salonAccess.assertAccessOrAdminAccess).toHaveBeenCalledWith('staff-user', 's1');
      expect(prisma.$executeRaw).toHaveBeenCalled(); // per-salon lock
      expect(prisma.queueEntryAddOn.create).toHaveBeenCalledWith({
        data: {
          queueEntryId: 'q1',
          serviceId: 'sv2',
          name: 'Beard Trim',
          durationMinutes: 15,
          price: beard.price,
          addedByUserId: 'staff-user',
        },
      });
      expect(prisma.queueEntry.update).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { addOnMinutes: 15 },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'QUEUE_ENTRY_ADD_ON_ADDED', entityId: 'q1' }),
        }),
      );
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
      expect(dto.addOnMinutes).toBe(15);
      expect(dto.addOns).toEqual([
        {
          serviceId: 'sv2',
          name: 'Beard Trim',
          durationMinutes: 15,
          price: 150,
          addedAt: '2026-11-17T10:00:00.000Z',
        },
      ]);
    });

    it('adds to the minutes of add-ons already on the visit', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.WAITING }))
        .mockResolvedValueOnce(
          inTx({
            status: QueueEntryStatus.WAITING,
            addOns: [{ serviceId: 'sv3', durationMinutes: 20 }],
          }),
        );
      await service.addAddOn('staff-user', 'q1', 'sv2');
      expect(prisma.queueEntry.update).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { addOnMinutes: 35 },
      });
    });

    it('refuses the visit\'s own service as an add-on', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce({ ...beard, id: 'sv1' });
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }))
        .mockResolvedValueOnce(inTx());
      await expect(service.addAddOn('staff-user', 'q1', 'sv1')).rejects.toMatchObject({
        code: 'ADD_ON_DUPLICATE',
      });
      expect(prisma.queueEntryAddOn.create).not.toHaveBeenCalled();
    });

    it('refuses a service that is one of the appointment\'s booked services', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE, bookingId: 'bk1' }))
        .mockResolvedValueOnce(
          inTx({
            booking: {
              serviceId: 'sv1',
              service: { name: 'Haircut', durationMinutes: 30, price: 300 },
              services: [
                { serviceId: 'sv1', serviceName: 'Haircut', durationMinutes: 30, price: 300 },
                { serviceId: 'sv2', serviceName: 'Beard Trim', durationMinutes: 15, price: 150 },
              ],
            },
          }),
        );
      await expect(service.addAddOn('staff-user', 'q1', 'sv2')).rejects.toMatchObject({
        code: 'ADD_ON_DUPLICATE',
      });
    });

    it('refuses the same add-on twice', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }))
        .mockResolvedValueOnce(inTx({ addOns: [{ serviceId: 'sv2', durationMinutes: 15 }] }));
      await expect(service.addAddOn('staff-user', 'q1', 'sv2')).rejects.toMatchObject({
        code: 'ADD_ON_DUPLICATE',
      });
    });

    it('refuses more than the maximum number of add-ons', async () => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }))
        .mockResolvedValueOnce(
          inTx({
            addOns: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ serviceId: id, durationMinutes: 5 })),
          }),
        );
      await expect(service.addAddOn('staff-user', 'q1', 'sv2')).rejects.toMatchObject({
        code: 'ADD_ON_LIMIT',
      });
    });

    it.each([
      QueueEntryStatus.COMPLETED,
      QueueEntryStatus.CANCELLED,
      QueueEntryStatus.NO_SHOW,
      QueueEntryStatus.EXPIRED,
    ])('refuses an add-on on a %s visit', async (status) => {
      availability.getServiceOrThrow.mockResolvedValueOnce(beard);
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status }))
        .mockResolvedValueOnce(inTx({ status }));
      await expect(service.addAddOn('staff-user', 'q1', 'sv2')).rejects.toMatchObject({
        code: 'ADD_ON_NOT_ALLOWED',
      });
      expect(prisma.queueEntryAddOn.create).not.toHaveBeenCalled();
    });

    it('never lets someone without access to the shop add a service', async () => {
      salonAccess.assertAccessOrAdminAccess.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'SALON_ACCESS_DENIED' }),
      );
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      await expect(service.addAddOn('stranger', 'q1', 'sv2')).rejects.toMatchObject({
        code: 'SALON_ACCESS_DENIED',
      });
      expect(prisma.queueEntryAddOn.create).not.toHaveBeenCalled();
    });

    it('removes an add-on and recomputes the visit minutes', async () => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }))
        .mockResolvedValueOnce({
          status: QueueEntryStatus.IN_SERVICE,
          addOns: [
            { serviceId: 'sv2', durationMinutes: 15 },
            { serviceId: 'sv3', durationMinutes: 20 },
          ],
        });
      await service.removeAddOn('staff-user', 'q1', 'sv2');
      expect(prisma.queueEntryAddOn.delete).toHaveBeenCalledWith({
        where: { queueEntryId_serviceId: { queueEntryId: 'q1', serviceId: 'sv2' } },
      });
      expect(prisma.queueEntry.update).toHaveBeenCalledWith({
        where: { id: 'q1' },
        data: { addOnMinutes: 20 },
      });
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });

    it('treats removing an add-on that is already gone as a no-op (double tap)', async () => {
      prisma.queueEntry.findUnique
        .mockResolvedValueOnce(makeRawEntry({ status: QueueEntryStatus.IN_SERVICE }))
        .mockResolvedValueOnce({ status: QueueEntryStatus.IN_SERVICE, addOns: [] });
      await expect(service.removeAddOn('staff-user', 'q1', 'sv2')).resolves.toBeDefined();
      expect(prisma.queueEntryAddOn.delete).not.toHaveBeenCalled();
    });

    it('a customer in the chair who adds a service pushes the wait of everyone behind them', async () => {
      prisma.queueEntry.findMany.mockResolvedValueOnce([
        makeRawEntry({ id: 'q2', customerId: null, serviceId: null, estimatedWaitMinutes: null, addOnMinutes: 0 }),
      ]);
      // One barber/chair busy: started 1 minute ago, 30 min haircut + 15 min beard trim added.
      prisma.salonStaff.count.mockResolvedValue(1);
      prisma.chair.count.mockResolvedValue(1);
      prisma.serviceSession.findMany.mockResolvedValueOnce([
        {
          staffId: 'st1',
          startedAt: new Date(Date.now() - 60_000),
          service: { durationMinutes: 30 },
          queueEntry: { addOnMinutes: 15 },
        },
      ]);
      await service.recomputeEtas('s1');
      const update = prisma.queueEntry.update.mock.calls[0][0] as {
        data: { estimatedWaitMinutes: number };
      };
      expect(update.data.estimatedWaitMinutes).toBe(44);
    });
  });

  describe('setServiceBuffer', () => {
    it('is owner/admin only, saves the minutes, audits and refreshes the queue', async () => {
      (prisma.salon as unknown as { update: jest.Mock }).update = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementationOnce(async (ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma),
      );
      await expect(service.setServiceBuffer('owner1', 's1', 15)).resolves.toEqual({
        serviceBufferMinutes: 15,
      });
      expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith('owner1', 's1');
      expect((prisma.salon as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { serviceBufferMinutes: 15 },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'SALON_SERVICE_BUFFER_CHANGED' }),
        }),
      );
      expect(realtime.emitQueueUpdated).toHaveBeenCalledWith('s1');
    });
  });

  describe('opening hours guard on Live Queue joins', () => {
    // Tuesday 17 Nov 2026 in Asia/Kolkata (UTC+05:30); the shop is open 09:00-21:00.
    const tuesdayHours = [
      { dayOfWeek: 2, isClosed: false, openTime: '09:00', closeTime: '21:00' },
    ];

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
      });
      availability.getServiceOrThrow.mockResolvedValue({
        id: 'sv1',
        salonId: 's1',
        durationMinutes: 30,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('refuses a join after closing time with QUEUE_CLOSED', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z')); // 21:30 IST
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).rejects.toMatchObject({
        code: 'QUEUE_CLOSED',
      });
      expect(prisma.queueEntry.create).not.toHaveBeenCalled();
    });

    it('refuses a join before opening time', async () => {
      jest.setSystemTime(new Date('2026-11-17T02:00:00.000Z')); // 07:30 IST
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).rejects.toMatchObject({
        code: 'QUEUE_CLOSED',
      });
    });

    it('refuses a join on a day the shop is closed', async () => {
      jest.setSystemTime(new Date('2026-11-17T06:30:00.000Z')); // 12:00 IST
      prisma.operatingHours.findMany.mockResolvedValue([
        { dayOfWeek: 2, isClosed: true, openTime: '09:00', closeTime: '21:00' },
      ]);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).rejects.toMatchObject({
        code: 'QUEUE_CLOSED',
      });
    });

    it('refuses a join the shop cannot finish before closing with QUEUE_CLOSING', async () => {
      jest.setSystemTime(new Date('2026-11-17T15:10:00.000Z')); // 20:40 IST, 20 min to close
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).rejects.toMatchObject({
        code: 'QUEUE_CLOSING',
      });
      expect(prisma.queueEntry.create).not.toHaveBeenCalled();
    });

    it('accepts a join that can finish before closing', async () => {
      jest.setSystemTime(new Date('2026-11-17T14:00:00.000Z')); // 19:30 IST
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeDefined();
      expect(prisma.queueEntry.create).toHaveBeenCalled();
    });

    it('keeps accepting joins when the shop has no opening hours set (unchanged behaviour)', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z'));
      prisma.operatingHours.findMany.mockResolvedValue([]);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeDefined();
    });

    it('treats a 23:59 close as open until midnight, with no closing projection (24-hour shops)', async () => {
      jest.setSystemTime(new Date('2026-11-17T18:29:30.000Z')); // 23:59:30 IST
      prisma.operatingHours.findMany.mockResolvedValue([
        { dayOfWeek: 2, isClosed: false, openTime: '00:00', closeTime: '23:59' },
      ]);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeDefined();
    });

    it('never guesses "closed" from hours it cannot interpret', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z'));
      prisma.operatingHours.findMany.mockResolvedValue([
        { dayOfWeek: 2, isClosed: false, openTime: '22:00', closeTime: '02:00' },
      ]);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeDefined();
    });

    it('keeps accepting joins when the shop has no trustworthy time zone', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z'));
      availability.getSalonTimeZone.mockResolvedValue(null);
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q2' });
      await expect(service.joinWalkIn('c1', 's1', 'sv1')).resolves.toBeDefined();
    });

    it('applies the same rule to a guest join', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z'));
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      await expect(
        service.joinGuestWalkIn('s1', 'sv1', 'Guest', '+919000000002'),
      ).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
      expect(prisma.queueEntry.create).not.toHaveBeenCalled();
    });

    it('the shop itself cannot add a customer after hours either', async () => {
      jest.setSystemTime(new Date('2026-11-17T16:00:00.000Z'));
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      await expect(
        service.createOperatorEntry('owner1', 's1', {
          name: 'Ravi',
          contactConsent: false,
        } as never),
      ).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
      expect(prisma.queueEntry.create).not.toHaveBeenCalled();
    });

    it('the shop may add a customer late in the day (no closing projection for the owner)', async () => {
      jest.setSystemTime(new Date('2026-11-17T15:25:00.000Z')); // 20:55 IST
      prisma.operatingHours.findMany.mockResolvedValue(tuesdayHours);
      prisma.queueEntry.findFirst.mockResolvedValue(null);
      prisma.queueEntry.create.mockResolvedValue({ id: 'q3' });
      await expect(
        service.createOperatorEntry('owner1', 's1', {
          name: 'Ravi',
          contactConsent: false,
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('assign — walk-in placement keeps the buffer and the visit\'s add-ons', () => {
    const input = { staffId: 'st1', chairId: 'ch1' };

    beforeEach(() => {
      prisma.chair.findFirst.mockResolvedValue({ id: 'ch1', salonId: 's1', status: 'ACTIVE' });
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
      });
      jest.setSystemTime(new Date('2026-11-17T06:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('checks the barber for service + add-ons + buffer before their next appointment', async () => {
      availability.getServiceBufferMinutes.mockResolvedValueOnce(10);
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry({ addOnMinutes: 15 }));
      await service.assign('staff1', 'q1', input);
      const where = prisma.booking.count.mock.calls[0][0] as {
        where: { slotStart: { lt: Date }; slotEnd: { gt: Date } };
      };
      // now 06:00Z + 30 haircut + 15 add-on + 10 buffer = 06:55Z; start widened by the buffer.
      expect(where.where.slotStart.lt).toEqual(new Date('2026-11-17T06:55:00.000Z'));
      expect(where.where.slotEnd.gt).toEqual(new Date('2026-11-17T05:50:00.000Z'));
    });

    it('refuses the barber when the buffer would run into their next appointment', async () => {
      availability.getServiceBufferMinutes.mockResolvedValueOnce(10);
      prisma.queueEntry.findUnique.mockResolvedValueOnce(makeRawEntry());
      prisma.booking.count.mockResolvedValueOnce(1);
      prisma.booking.findFirst.mockResolvedValueOnce({ slotEnd: new Date('2026-11-17T07:05:00.000Z') });
      await expect(service.assign('staff1', 'q1', input)).rejects.toMatchObject({
        code: 'STAFF_RESERVED_FOR_APPOINTMENT',
      });
    });

    it('an appointment customer is checked exactly as before (no buffer, no add-on minutes)', async () => {
      availability.getServiceBufferMinutes.mockResolvedValue(10);
      prisma.queueEntry.findUnique.mockResolvedValueOnce(
        makeRawEntry({ bookingId: 'bk1', source: QueueEntrySource.APPOINTMENT, addOnMinutes: 15 }),
      );
      prisma.booking.findUnique.mockResolvedValueOnce({ preferredStaffId: null });
      await service.assign('staff1', 'q1', input);
      const where = prisma.booking.count.mock.calls[0][0] as {
        where: { slotStart: { lt: Date }; slotEnd: { gt: Date } };
      };
      expect(where.where.slotStart.lt).toEqual(new Date('2026-11-17T06:30:00.000Z'));
      expect(where.where.slotEnd.gt).toEqual(new Date('2026-11-17T06:00:00.000Z'));
      expect(availability.getServiceBufferMinutes).not.toHaveBeenCalled();
    });
  });
});
