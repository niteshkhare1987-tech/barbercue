import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Role,
  SalonStatus,
  SessionAudience,
  UserStatus,
} from '@barbercue/shared';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/services/token.service';
import { ServiceUsageService } from '../src/inventory/service-usage.service';

process.env.JWT_ACCESS_SECRET ??=
  'inventory-e2e-only-jwt-secret-not-production';
process.env.TOTP_ENCRYPTION_KEY ??=
  'inventory-e2e-only-encryption-secret-not-production';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
let isDisposableInventoryDatabase = false;
try {
  const parsed = new URL(DATABASE_URL);
  const dbName = decodeURIComponent(
    parsed.pathname.replace(/^\//, '').split('/')[0] ?? '',
  );
  isDisposableInventoryDatabase =
    ['127.0.0.1', 'localhost'].includes(parsed.hostname) &&
    ['owner_ops_chain', 'inventory_certification'].includes(dbName);
} catch {
  isDisposableInventoryDatabase = false;
}
const maybe = isDisposableInventoryDatabase ? describe : describe.skip;

/**
 * Inventory Phase 2 (service consumption) against the real AppModule and a disposable PostgreSQL
 * only (same guard as inventory.e2e-spec.ts): recipes, the barber's photo-picker options, recording
 * products used with unit conversion, at-most-once per service per visit, all-or-nothing stock
 * checks, owner corrections, salon-approved automatic deduction on completion, and permissions.
 */
maybe('Service consumption (authenticated disposable PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const tok: Record<string, string> = {};

  const api = (
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    token?: string,
    key?: string,
  ) => {
    const req = request(app.getHttpServer())[method](`/api/v1/${path}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    if (key) req.set('Idempotency-Key', key);
    return req;
  };
  const inv = () => `dashboard/salons/${ids.salon}/inventory`;
  const visit = (entryId: string) =>
    `dashboard/queue-entries/${entryId}/product-usage`;
  const stock = async (productId: string) =>
    (
      await prisma.inventoryProduct.findUniqueOrThrow({
        where: { id: productId },
      })
    ).stockOnHand.toFixed(3);

  async function user(label: string, role: Role, salonId: string) {
    const u = await prisma.user.create({
      data: {
        email: `usage-${run}-${label}@example.test`,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userRole.create({ data: { userId: u.id, role, salonId } });
    tok[label] = tokens.signAccessToken(u.id, [role], SessionAudience.STAFF);
    ids[label] = u.id;
    return u;
  }

  /** A walk-in being served by `staffLabel` right now (IN_SERVICE with an ACTIVE session). */
  async function visitInService(staffLabel: string, token: number) {
    // One active service per barber and chair: finish whatever this barber was doing before.
    await prisma.serviceSession.updateMany({
      where: { status: 'ACTIVE', chairId: ids.chair },
      data: { status: 'COMPLETED', endedAt: new Date() },
    });
    const entry = await prisma.queueEntry.create({
      data: {
        salonId: ids.salon,
        serviceId: ids.shave,
        source: 'WALK_IN',
        tokenNumber: token,
        status: 'IN_SERVICE',
        contactName: `Customer ${token}`,
        assignedStaffId: ids[`${staffLabel}Staff`],
        assignedChairId: ids.chair,
        serviceStartedAt: new Date(),
      },
    });
    const session = await prisma.serviceSession.create({
      data: {
        queueEntryId: entry.id,
        staffId: ids[`${staffLabel}Staff`],
        chairId: ids.chair,
        serviceId: ids.shave,
      },
    });
    return { entryId: entry.id, sessionId: session.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const city = await prisma.city.findFirstOrThrow({});
    const salons: string[] = [];
    for (const label of ['owner', 'otherOwner']) {
      const owner = await prisma.user.create({
        data: {
          email: `usage-${run}-${label}@example.test`,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });
      const salon = await prisma.salon.create({
        data: {
          ownerUserId: owner.id,
          name: `Usage ${label} ${run}`,
          slug: `usage-${label}-${run}`,
          cityId: city.id,
          addressLine: 'Disposable certification address',
          status: SalonStatus.ACTIVE,
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        },
      });
      await prisma.userRole.create({
        data: { userId: owner.id, role: Role.SALON_OWNER, salonId: salon.id },
      });
      tok[label] = tokens.signAccessToken(
        owner.id,
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
      );
      salons.push(salon.id);
    }
    ids.salon = salons[0];
    ids.otherSalon = salons[1];
    for (const label of ['barber', 'barber2']) {
      const u = await user(label, Role.SALON_STAFF, ids.salon);
      const staff = await prisma.salonStaff.create({
        data: {
          salonId: ids.salon,
          userId: u.id,
          displayName: `Barber ${label}`,
          roleInSalon: 'BARBER',
        },
      });
      ids[`${label}Staff`] = staff.id;
    }
    ids.chair = (
      await prisma.chair.create({ data: { salonId: ids.salon, label: 'C1' } })
    ).id;
    ids.shave = (
      await prisma.service.create({
        data: {
          salonId: ids.salon,
          name: 'Classic Shave',
          durationMinutes: 20,
          price: '150.00',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records products used for a visit once, converts units, checks stock for the whole visit, and corrects', async () => {
    const cream = await api('post', `${inv()}/categories`, tok.owner)
      .send({ name: 'Shaving cream' })
      .expect(201);
    const blades = await api('post', `${inv()}/categories`, tok.owner)
      .send({ name: 'Blades' })
      .expect(201);
    // A 200 ml tube counted in pieces, and blades counted in pieces.
    const gel = await api('post', `${inv()}/products`, tok.owner)
      .send({
        name: 'Shave gel',
        unit: 'EACH',
        categoryId: cream.body.id,
        contentSize: 200,
        contentUnit: 'MILLILITER',
      })
      .expect(201);
    const blade = await api('post', `${inv()}/products`, tok.owner)
      .send({ name: 'Blade', unit: 'EACH', categoryId: blades.body.id })
      .expect(201);
    ids.gel = gel.body.id;
    ids.blade = blade.body.id;
    await api(
      'post',
      `${inv()}/products/${ids.gel}/movements`,
      tok.owner,
      `open-gel-${run}`,
    )
      .send({ kind: 'OPENING', quantity: 2, unitCost: 200 })
      .expect(201);
    await api(
      'post',
      `${inv()}/products/${ids.blade}/movements`,
      tok.owner,
      `open-blade-${run}`,
    )
      .send({ kind: 'OPENING', quantity: 3, unitCost: 5 })
      .expect(201);

    // Recipe: barbers can't edit it; the owner sets gel 10 ml + 1 blade (no automatic deduction).
    const recipe = {
      lines: [
        {
          inventoryCategoryId: cream.body.id,
          quantity: 10,
          unit: 'MILLILITER',
          defaultProductId: ids.gel,
        },
        { inventoryCategoryId: blades.body.id, quantity: 1, unit: 'EACH' },
      ],
    };
    await api('put', `${inv()}/service-recipes/${ids.shave}`, tok.barber)
      .send(recipe)
      .expect(403);
    const saved = await api(
      'put',
      `${inv()}/service-recipes/${ids.shave}`,
      tok.owner,
    )
      .send(recipe)
      .expect(200);
    expect(saved.body.lines).toHaveLength(2);
    expect(saved.body.suggestions).toContain('Aftershave');

    const v1 = await visitInService('barber', 1);
    // Only the barber serving this customer (and the owner) may see or record it.
    await api('get', visit(v1.entryId), tok.barber2).expect(403);
    await api('get', visit(v1.entryId), tok.otherOwner).expect(403);
    const options = await api('get', visit(v1.entryId), tok.barber).expect(
      200,
    );
    expect(options.body.hasAnythingToRecord).toBe(true);
    expect(options.body.services[0].lines[0]).toMatchObject({
      categoryName: 'Shaving cream',
      productIds: [ids.gel],
    });

    const used = {
      services: [
        {
          serviceId: ids.shave,
          items: [
            { productId: ids.gel, quantity: 10, unit: 'MILLILITER' },
            { productId: ids.blade, quantity: 1, unit: 'EACH' },
          ],
        },
      ],
    };
    const first = await api('post', visit(v1.entryId), tok.barber)
      .send(used)
      .expect(200);
    expect(first.body.services[0].created).toBe(true);
    // 10 ml of a 200 ml tube = 0.05 of a piece.
    expect(await stock(ids.gel)).toBe('1.950');
    expect(await stock(ids.blade)).toBe('2.000');

    // The same save again (retry / double tap) deducts nothing more; a different save is refused.
    const again = await api('post', visit(v1.entryId), tok.barber)
      .send(used)
      .expect(200);
    expect(again.body.services[0].created).toBe(false);
    expect(await stock(ids.gel)).toBe('1.950');
    await api('post', visit(v1.entryId), tok.barber)
      .send({
        services: [
          {
            serviceId: ids.shave,
            items: [{ productId: ids.blade, quantity: 2, unit: 'EACH' }],
          },
        ],
      })
      .expect(409);

    // Units that can't be converted are refused with a reason.
    const v2 = await visitInService('barber', 2);
    const badUnit = await api('post', visit(v2.entryId), tok.barber)
      .send({
        services: [
          {
            serviceId: ids.shave,
            items: [{ productId: ids.blade, quantity: 5, unit: 'MILLILITER' }],
          },
        ],
      })
      .expect(400);
    expect(badUnit.body.error.message).toMatch(/Blade/);

    // Not enough blades: nothing at all is deducted (the gel stays as it was).
    await api('post', visit(v2.entryId), tok.barber)
      .send({
        services: [
          {
            serviceId: ids.shave,
            items: [
              { productId: ids.gel, quantity: 10, unit: 'MILLILITER' },
              { productId: ids.blade, quantity: 5, unit: 'EACH' },
            ],
          },
        ],
      })
      .expect(409);
    expect(await stock(ids.gel)).toBe('1.950');
    expect(await stock(ids.blade)).toBe('2.000');

    // Owner correction puts the stock back; the visit can then be recorded again.
    const usageId = first.body.services[0].usage.id as string;
    await api(
      'post',
      `${inv()}/service-usage/${usageId}/reverse`,
      tok.barber,
    )
      .send({ reason: 'Wrong product' })
      .expect(403);
    await api('post', `${inv()}/service-usage/${usageId}/reverse`, tok.owner)
      .send({ reason: 'Wrong product' })
      .expect(200);
    expect(await stock(ids.gel)).toBe('2.000');
    expect(await stock(ids.blade)).toBe('3.000');
    await api('post', `${inv()}/service-usage/${usageId}/reverse`, tok.owner)
      .send({ reason: 'Wrong product' })
      .expect(409);
    await api('post', visit(v1.entryId), tok.barber)
      .send({
        services: [
          {
            serviceId: ids.shave,
            items: [{ productId: ids.blade, quantity: 1, unit: 'EACH' }],
          },
        ],
      })
      .expect(200);
    expect(await stock(ids.blade)).toBe('2.000');

    // Every stock change is an ordinary ledger entry tied to its usage.
    const movements = await prisma.inventoryMovement.findMany({
      where: { salonId: ids.salon, reference: `service-usage:${usageId}` },
      orderBy: { recordedAt: 'asc' },
    });
    expect(movements.map((m) => [m.kind, m.quantityDelta.toFixed(3)])).toEqual(
      expect.arrayContaining([
        ['CONSUMPTION', '-0.050'],
        ['CONSUMPTION', '-1.000'],
        ['ADJUSTMENT', '0.050'],
        ['ADJUSTMENT', '1.000'],
      ]),
    );
  });

  it('deducts salon-approved defaults automatically when the service is completed, exactly once', async () => {
    const recipes = await api(
      'get',
      `${inv()}/service-recipes`,
      tok.owner,
    ).expect(200);
    const shave = recipes.body.find(
      (r: { serviceId: string }) => r.serviceId === ids.shave,
    );
    const blades = shave.lines.find(
      (l: { categoryName: string }) => l.categoryName === 'Blades',
    );
    const creamLine = shave.lines.find(
      (l: { categoryName: string }) => l.categoryName === 'Shaving cream',
    );
    await api('put', `${inv()}/service-recipes/${ids.shave}`, tok.owner)
      .send({
        lines: [
          {
            inventoryCategoryId: creamLine.inventoryCategoryId,
            quantity: 10,
            unit: 'MILLILITER',
            defaultProductId: ids.gel,
            autoDeduct: true,
          },
          {
            inventoryCategoryId: blades.inventoryCategoryId,
            quantity: 1,
            unit: 'EACH',
            defaultProductId: ids.blade,
            autoDeduct: true,
          },
        ],
      })
      .expect(200);

    const gelBefore = Number(await stock(ids.gel));
    const bladeBefore = Number(await stock(ids.blade));
    const v = await visitInService('barber', 3);
    await api(
      'post',
      `dashboard/service-sessions/${v.sessionId}/complete`,
      tok.barber,
    ).expect(201);

    // The deduction runs right after completion; wait for it.
    let usage: { source: string } | null = null;
    for (let i = 0; i < 40 && !usage; i += 1) {
      usage = await prisma.serviceUsage.findFirst({
        where: { queueEntryId: v.entryId, status: 'RECORDED' },
      });
      if (!usage) await new Promise((r) => setTimeout(r, 100));
    }
    expect(usage).toMatchObject({ source: 'AUTO' });
    expect(Number(await stock(ids.gel))).toBeCloseTo(gelBefore - 0.05, 3);
    expect(Number(await stock(ids.blade))).toBeCloseTo(bladeBefore - 1, 3);

    // The same completion event delivered again changes nothing.
    await app.get(ServiceUsageService).autoRecord({
      salonId: ids.salon,
      queueEntryId: v.entryId,
      sessionId: v.sessionId,
      actorUserId: ids.barber,
    });
    expect(
      await prisma.serviceUsage.count({ where: { queueEntryId: v.entryId } }),
    ).toBe(1);
    expect(Number(await stock(ids.blade))).toBeCloseTo(bladeBefore - 1, 3);
  });

  it('gives the owner the visits list and dashboard, and keeps barbers out of them', async () => {
    await api('get', `${inv()}/service-visits`, tok.barber).expect(403);
    await api('get', `${inv()}/dashboard`, tok.barber).expect(403);
    const visits = await api(
      'get',
      `${inv()}/service-visits?filter=all`,
      tok.owner,
    ).expect(200);
    expect(visits.body.items.length).toBeGreaterThanOrEqual(1);
    const dashboard = await api('get', `${inv()}/dashboard`, tok.owner).expect(
      200,
    );
    expect(dashboard.body.totals.activeProducts).toBe(2);
    expect(dashboard.body.usageByDay).toHaveLength(30);
    expect(Number(dashboard.body.usage.today)).toBeGreaterThan(0);
    expect(dashboard.body.byService30Days[0]).toMatchObject({
      serviceName: 'Classic Shave',
    });
    await api(
      'get',
      `dashboard/salons/${ids.otherSalon}/inventory/dashboard`,
      tok.owner,
    ).expect(403);
  });
});
