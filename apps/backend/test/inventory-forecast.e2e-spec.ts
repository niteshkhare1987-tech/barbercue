import { createHash, randomUUID } from 'crypto';
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
import { InventoryForecastService } from '../src/inventory/inventory-forecast.service';

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
 * Inventory Phase 3 (smart prediction) against the real AppModule and a disposable PostgreSQL only
 * (same guard as inventory.e2e-spec.ts): predictions from 4 weeks of ledger history, settings and
 * supplier lead time moving the reorder date, alerts created once and resolved when the problem
 * goes away, expiring batches, the owner's in-app notification, analytics and permissions.
 */
maybe('Inventory predictions (authenticated disposable PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const tok: Record<string, string> = {};

  const api = (
    method: 'get' | 'post' | 'put',
    path: string,
    token?: string,
  ) => {
    const req = request(app.getHttpServer())[method](`/api/v1/${path}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };
  const inv = () => `dashboard/salons/${ids.salon}/inventory`;

  async function movement(
    kind: 'OPENING' | 'PURCHASE' | 'CONSUMPTION',
    quantity: number,
    daysAgo: number,
    extra: { unitCost?: number; batchNumber?: string; expiryDate?: Date } = {},
  ) {
    const key = `fc-${run}-${kind}-${daysAgo}-${randomUUID().slice(0, 6)}`;
    await prisma.inventoryMovement.create({
      data: {
        salonId: ids.salon,
        productId: ids.gel,
        actorUserId: ids.owner,
        kind,
        quantityDelta: kind === 'CONSUMPTION' ? -quantity : quantity,
        unitCost: extra.unitCost ?? null,
        batchNumber: extra.batchNumber ?? null,
        expiryDate: extra.expiryDate ?? null,
        recordedAt: new Date(Date.now() - daysAgo * 864e5),
        idempotencyKey: key,
        requestHash: createHash('sha256').update(key).digest('hex'),
      },
    });
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
    const tokens = app.get(TokenService);
    const city = await prisma.city.findFirstOrThrow({});
    for (const label of ['owner', 'otherOwner']) {
      const user = await prisma.user.create({
        data: {
          email: `forecast-${run}-${label}@example.test`,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });
      const salon = await prisma.salon.create({
        data: {
          ownerUserId: user.id,
          name: `Forecast ${label} ${run}`,
          slug: `forecast-${label}-${run}`,
          cityId: city.id,
          addressLine: 'Disposable certification address',
          status: SalonStatus.ACTIVE,
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        },
      });
      await prisma.userRole.create({
        data: { userId: user.id, role: Role.SALON_OWNER, salonId: salon.id },
      });
      tok[label] = tokens.signAccessToken(
        user.id,
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
      );
      ids[label] = user.id;
      ids[`${label}Salon`] = salon.id;
    }
    ids.salon = ids.ownerSalon;
    const staff = await prisma.user.create({
      data: {
        email: `forecast-${run}-staff@example.test`,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userRole.create({
      data: { userId: staff.id, role: Role.SALON_STAFF, salonId: ids.salon },
    });
    tok.staff = tokens.signAccessToken(
      staff.id,
      [Role.SALON_STAFF],
      SessionAudience.STAFF,
    );
    const supplier = await api('post', `${inv()}/suppliers`, tok.owner)
      .send({ name: `Ravi Traders ${run}`, leadTimeDays: 5 })
      .expect(201);
    expect(supplier.body.leadTimeDays).toBe(5);
    ids.supplier = supplier.body.id;
    const gel = await api('post', `${inv()}/products`, tok.owner)
      .send({ name: 'Shave gel', unit: 'MILLILITER', supplierId: ids.supplier })
      .expect(201);
    ids.gel = gel.body.id;
    // 4 weeks of history: 1200 ml opened, then 25 ml a day for 27 days → 525 ml left.
    await movement('OPENING', 1200, 28, { unitCost: 2 });
    for (let d = 27; d >= 1; d -= 1) await movement('CONSUMPTION', 25, d);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('predicts days left and the reorder date from ledger history, and alerts once', async () => {
    await api('get', `${inv()}/predictions`, tok.staff).expect(403);
    await api('get', `${inv()}/predictions`, tok.otherOwner).expect(403);
    const first = await api('get', `${inv()}/predictions`, tok.owner).expect(
      200,
    );
    const gel = first.body.products[0];
    expect(gel).toMatchObject({
      name: 'Shave gel',
      stockOnHand: '525.000',
      confidence: 'MEDIUM',
      status: 'OK',
      leadTimeDays: 5,
    });
    // 27 days of 25 ml over a 28-day history (the opening day had none), recent days weighted more.
    expect(gel.dailyRate).toBeGreaterThan(24);
    expect(gel.dailyRate).toBeLessThanOrEqual(25);
    expect(gel.daysLeft).toBeCloseTo(525 / gel.dailyRate, 0);
    expect(first.body.suppliers[0]).toMatchObject({ leadTimeDays: 5 });

    // A 20-day delivery makes it urgent: reorder now, and say how much.
    await api(
      'put',
      `${inv()}/suppliers/${ids.supplier}/lead-time`,
      tok.owner,
    )
      .send({ leadTimeDays: 20 })
      .expect(200);
    const urgent = await api('get', `${inv()}/predictions`, tok.owner).expect(
      200,
    );
    expect(urgent.body.products[0]).toMatchObject({
      status: 'ORDER_NOW',
      leadTimeDays: 20,
    });
    // rate × (20 days delivery + 14 days cover + 3 days cushion) − 525 ml on hand, rounded up.
    const rate = urgent.body.products[0].dailyRate as number;
    expect(urgent.body.products[0].suggestedOrderQuantity).toBe(
      Math.ceil(rate * 37 - 525),
    );

    const ran = await api('post', `${inv()}/alerts/run`, tok.owner).expect(
      200,
    );
    expect(ran.body).toEqual({ created: 1, resolved: 0 });
    const again = await api('post', `${inv()}/alerts/run`, tok.owner).expect(
      200,
    );
    expect(again.body).toEqual({ created: 0, resolved: 0 });
    const notes = await prisma.notification.findMany({
      where: { userId: ids.owner, type: 'owner.inventory.reorder' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].deepLink).toBe(
      `dashboard/salons/${ids.salon}/inventory/predictions`,
    );

    // Back to a 5-day delivery: the problem is gone, so the alert resolves itself.
    await api(
      'put',
      `${inv()}/suppliers/${ids.supplier}/lead-time`,
      tok.owner,
    )
      .send({ leadTimeDays: 5 })
      .expect(200);
    const resolved = await api(
      'post',
      `${inv()}/alerts/run`,
      tok.owner,
    ).expect(200);
    expect(resolved.body).toEqual({ created: 0, resolved: 1 });
  });

  it('flags a batch that expires before it can be used, and lets the owner dismiss it', async () => {
    // 100 ml expiring in 3 days arrives on top: at 25 ml/day the older 525 ml goes first.
    await movement('PURCHASE', 100, 0, {
      unitCost: 2,
      batchNumber: 'B-77',
      expiryDate: new Date(Date.now() + 3 * 864e5),
    });
    const p = await api('get', `${inv()}/predictions`, tok.owner).expect(200);
    expect(p.body.products[0].expiry[0]).toMatchObject({
      batchNumber: 'B-77',
      remaining: 100,
      atRisk: 100,
    });
    expect(p.body.summary.expiringAtRisk).toBe(1);
    await api('post', `${inv()}/alerts/run`, tok.owner).expect(200);
    const withAlert = await api(
      'get',
      `${inv()}/predictions`,
      tok.owner,
    ).expect(200);
    const alert = withAlert.body.alerts.find(
      (a: { kind: string }) => a.kind === 'EXPIRING',
    );
    expect(alert.title).toMatch(/B-77/);
    await api(
      'post',
      `${inv()}/alerts/${alert.id}/dismiss`,
      tok.owner,
    ).expect(204);
    const after = await api('get', `${inv()}/predictions`, tok.owner).expect(
      200,
    );
    expect(
      after.body.alerts.some((a: { id: string }) => a.id === alert.id),
    ).toBe(false);
    // Dismissed but not resolved: the next run does not raise it again.
    expect(
      (await api('post', `${inv()}/alerts/run`, tok.owner).expect(200)).body
        .created,
    ).toBe(0);
  });

  it('settings validate, the daily job covers due shops, and analytics add up', async () => {
    await api('put', `${inv()}/forecast-settings`, tok.owner)
      .send({ leadTimeDays: 5, safetyDays: 3, coverDays: 0, alertsEnabled: true })
      .expect(400);
    await api('put', `${inv()}/forecast-settings`, tok.owner)
      .send({ leadTimeDays: 7, safetyDays: 2, coverDays: 21, alertsEnabled: true })
      .expect(200);

    await prisma.inventorySettings.update({
      where: { salonId: ids.salon },
      data: { lastAlertRunAt: new Date(Date.now() - 2 * 864e5) },
    });
    await app.get(InventoryForecastService).runDueAlerts();
    const settings = await prisma.inventorySettings.findUniqueOrThrow({
      where: { salonId: ids.salon },
    });
    expect(Date.now() - settings.lastAlertRunAt!.getTime()).toBeLessThan(
      60_000,
    );

    const a = await api(
      'get',
      `${inv()}/analytics?from=2000-01-01&to=2000-01-02`,
      tok.owner,
    ).expect(200);
    expect(a.body.products[0]).toMatchObject({ usedQuantity: '0.000' });
    const month = await api('get', `${inv()}/analytics`, tok.owner).expect(
      200,
    );
    const row = month.body.products[0];
    // Within the last 30 days: 27 × 25 ml used at ₹2, 100 ml bought (the opening is 28 days ago).
    expect(row.usedQuantity).toBe('675.000');
    expect(row.usedValue).toBe('1350.00');
    expect(Number(row.receivedQuantity)).toBeGreaterThanOrEqual(100);
    expect(month.body.byWeek.length).toBeGreaterThanOrEqual(4);
  });
});
