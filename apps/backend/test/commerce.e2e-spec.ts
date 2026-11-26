import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
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
import { CommerceOutboxService } from '../src/commerce/commerce-outbox.service';
import { CommerceStockService } from '../src/commerce/commerce-stock.service';

process.env.JWT_ACCESS_SECRET ??= 'commerce-e2e-only-jwt-secret';
process.env.TOTP_ENCRYPTION_KEY ??= 'commerce-e2e-only-encryption-secret';
const FLAGS = [
  'FASTQUE_DIRECT_COMMERCE_ENABLED',
  'MULTI_SELLER_CART_ENABLED',
  'FASTQUE_COD_ENABLED',
  'FASTQUE_DELIVERY_ENABLED',
  'FASTQUE_RETURNS_ENABLED',
  'FASTQUE_COMMERCE_AI_ENABLED',
];
const setFlags = (on: boolean) =>
  FLAGS.forEach((f) => {
    if (on) process.env[f] = 'true';
    else delete process.env[f];
  });

let disposable = false;
try {
  const u = new URL(process.env.DATABASE_URL ?? '');
  disposable =
    ['127.0.0.1', 'localhost'].includes(u.hostname) &&
    ['owner_ops_chain', 'commerce_ci'].includes(u.pathname.replace(/^\//, ''));
} catch {
  disposable = false;
}
const maybe = disposable ? describe : describe.skip;
const run = randomUUID().slice(0, 6);
const day = (n: number) =>
  new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
let phoneSerial = 0;
const phoneBase = 6_000_000_000 + Math.floor(Math.random() * 900_000) * 1000;
const newPhone = () => `+91${phoneBase + ++phoneSerial}`;

maybe('FastQue direct commerce (real AppModule, disposable PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tok: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const api = (
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    path: string,
    who?: string,
    key?: string,
  ) => {
    const r = request(app.getHttpServer())[method](`/api/v1/${path}`);
    if (who) r.set('Authorization', `Bearer ${tok[who]}`);
    if (key) r.set('Idempotency-Key', key);
    return r;
  };
  const admin = (
    method: 'get' | 'post' | 'put',
    path: string,
    who = 'admin',
    key?: string,
  ) => api(method, `admin/commerce/${path}`, who, key);
  const address = (pincode = '201310') => ({
    name: 'Test Shopper',
    phone: '+919876543210',
    line1: 'Flat 1, Demo Block',
    city: 'Greater Noida',
    state: 'Uttar Pradesh',
    pincode,
  });
  const order = (
    items: Array<{ listingId: string; quantity: number }>,
    expectedTotal: string,
    opt: {
      key?: string;
      who?: string;
      phone?: string;
      pin?: string;
      coupon?: string;
      salons?: unknown[];
    } = {},
  ) =>
    api(
      'post',
      opt.who ? 'customer/commerce/checkout' : 'commerce/checkout',
      opt.who,
      opt.key ?? randomUUID(),
    ).send({
      contactName: 'Test Shopper',
      contactPhone: opt.phone ?? newPhone(),
      fastque: {
        items,
        address: address(opt.pin),
        expectedTotal,
        ...(opt.coupon ? { couponCode: opt.coupon } : {}),
      },
      salons: opt.salons ?? [],
    });
  async function product(name: string, over: Record<string, unknown> = {}) {
    const p = await prisma.globalProduct.create({
      data: {
        name: `${name} ${run}`,
        normalizedName: `${name} ${run}`.toLowerCase(),
        brand: `Brand ${run}`,
        category: 'Hair Care',
        dataSource: 'ADMIN',
        verificationStatus: 'VERIFIED',
        gstRatePercent: 18,
        hsnCode: '3305',
        createdByUserId: ids.admin,
        ...over,
      } as never,
    });
    return p.id;
  }
  async function listing(name: string, price: string, over = {}) {
    const globalProductId = await product(name);
    const r = await admin('post', 'listings')
      .send({
        globalProductId,
        sku: `SKU-${name}-${run}`,
        mrp: '1000',
        price,
        status: 'ACTIVE',
        maxPerOrder: 10,
        ...over,
      })
      .expect(201);
    return { id: r.body.id as string, globalProductId };
  }
  const stock = (
    listingId: string,
    quantity: number,
    batchNumber: string,
    expires = 400,
    unitCost = '300',
    warehouseId = ids.wh,
  ) =>
    admin('post', 'stock', 'admin', randomUUID()).send({
      listingId,
      warehouseId,
      batchNumber,
      expiresOn: day(expires),
      unitCost,
      quantity,
    });
  const batch = (listingId: string, batchNumber: string) =>
    prisma.commerceBatch.findFirstOrThrow({ where: { listingId, batchNumber } });
  const orderId = async (n: string) =>
    (await prisma.commerceOrder.findUniqueOrThrow({ where: { orderNumber: n } }))
      .id;
  const move = (id: string, body: Record<string, unknown>, who = 'admin') =>
    admin('post', `orders/${id}/transition`, who).send(body);
  async function deliver(id: string) {
    for (const body of [
      { to: 'CONFIRMED' },
      { to: 'PACKED', packagingCost: '10' },
      { to: 'SHIPPED', shipment: { courier: 'Demo Courier', courierCost: '50', codFee: '5' } },
      { to: 'OUT_FOR_DELIVERY' },
      { to: 'DELIVERED', proofNote: 'Handed to customer' },
    ])
      await move(id, body).expect(200);
  }

  beforeAll(async () => {
    setFlags(true);
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      // Checkout allows 10 requests a minute per client; this file makes more than that on purpose.
      .overrideProvider(ThrottlerStorage)
      .useValue({ increment: () => Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }) })
      .compile();
    app = ref.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);
    const user = async (label: string, roles: Role[], audience: SessionAudience) => {
      const u = await prisma.user.create({
        data: {
          email: `dc-${run}-${label}@example.test`,
          status: UserStatus.ACTIVE,
          roles: { create: roles.map((role) => ({ role })) },
        },
      });
      ids[label] = u.id;
      tok[label] = tokens.signAccessToken(u.id, roles, audience);
    };
    await user('admin', [Role.PLATFORM_ADMIN], SessionAudience.ADMIN);
    await user('admin2', [Role.PLATFORM_ADMIN], SessionAudience.ADMIN);
    await user('viewer', [Role.PLATFORM_VIEWER], SessionAudience.ADMIN);
    await user('owner', [Role.SALON_OWNER], SessionAudience.STAFF);
    await user('customer', [Role.CUSTOMER], SessionAudience.CUSTOMER);
    await user('other', [Role.CUSTOMER], SessionAudience.CUSTOMER);
    const wh = await admin('post', 'warehouses')
      .send({ code: `W${run}`, name: 'Demo warehouse', pincode: '201310' })
      .expect(201);
    ids.wh = wh.body.id as string;
    // Zones are matched by PIN, so this run takes PINs starting 2013 at top priority.
    await prisma.commerceZone.updateMany({ data: { isActive: false } });
    await admin('post', 'zones')
      .send({
        name: 'NCR',
        warehouseId: ids.wh,
        priority: 1,
        deliveryCharge: '40',
        freeAbove: '2000',
        minDays: 2,
        maxDays: 4,
        maxCodAmount: '5000',
        pinRules: ['2013'],
        blockedPins: ['201399'],
      })
      .expect(201);
  }, 90000);
  afterAll(async () => {
    setFlags(false);
    await app?.close();
  });
  beforeEach(() => setFlags(true));

  it('is invisible when the flag is off, and config still answers', async () => {
    setFlags(false);
    const cfg = await api('get', 'commerce/config').expect(200);
    expect(cfg.body).toMatchObject({ enabled: false, multiSellerCart: false, seller: null });
    await api('get', 'commerce/home').expect(404);
    await api('get', 'customer/commerce/orders', 'customer').expect(404);
    await admin('get', 'overview').expect(404);
    await api('get', 'shop/home').expect(200);
    setFlags(true);
    delete process.env.MULTI_SELLER_CART_ENABLED;
    expect((await api('get', 'commerce/config')).body).toMatchObject({ enabled: true, multiSellerCart: false });
  });

  it('keeps FastQue a real seller and refuses other roles, ungranted admins and salon owners', async () => {
    const seller = await prisma.commerceSeller.findUniqueOrThrow({ where: { code: 'FASTQUE' } });
    expect(seller).toMatchObject({ type: 'FASTQUE', salonId: null });
    for (const path of ['overview', 'suppliers', 'orders', 'cod', 'listings', 'batches'])
      for (const who of ['owner', 'customer'])
        await admin('get', path, who).expect(403);
    await api('get', 'admin/commerce/overview').expect(401);
    await admin('get', 'overview', 'viewer').expect(403);
    await admin('put', 'grants').send({ userId: ids.viewer, permission: 'view', granted: true }).expect(200);
    const seen = await admin('get', 'overview', 'viewer').expect(200);
    expect(seen.body.finance).toBeNull();
    for (const path of ['suppliers', 'cod', 'orders']) await admin('get', path, 'viewer').expect(403);
    await admin('put', 'grants').send({ userId: ids.viewer, permission: 'settings', granted: true }).expect(400);
    await admin('put', 'seller', 'viewer').send({ displayName: 'Hacked' }).expect(403);
  });

  it('only sells verified, non-test products and hides cost and exact stock from customers', async () => {
    const testProduct = await product('TestOnly', { isTestData: true });
    await admin('post', 'listings')
      .send({ globalProductId: testProduct, sku: `T-${run}`, mrp: '100', price: '90', status: 'ACTIVE' })
      .expect(409);
    const a = await listing('Shampoo', '500');
    await stock(a.id, 500, 'B1').expect(201);
    const found = await api('get', `commerce/products?q=shampoo%20${run}`).expect(200);
    const item = found.body.items.find((i: { listingId: string }) => i.listingId === a.id);
    expect(item).toMatchObject({ sellerName: 'FastQue', price: '500.00', discountPercent: 50, availableQuantity: 10 });
    expect(JSON.stringify(found.body)).not.toMatch(/unitCost|costTotal|supplier|"300/);
    await prisma.globalProduct.update({ where: { id: a.globalProductId }, data: { isTestData: true } });
    await api('get', `commerce/products/${a.globalProductId}`).expect(404);
    const q = await api('post', 'commerce/quote').send({ items: [{ listingId: a.id, quantity: 1 }] }).expect(200);
    expect(q.body.blocking.join()).toContain('No longer sold');
  });

  it('answers PIN serviceability and refuses unsupported or blocked PINs', async () => {
    expect((await api('get', 'commerce/serviceability?pin=201310')).body).toMatchObject({ serviceable: true, cod: true, deliveryCharge: '40.00' });
    expect((await api('get', 'commerce/serviceability?pin=201399')).body.serviceable).toBe(false);
    expect((await api('get', 'commerce/serviceability?pin=560001')).body.serviceable).toBe(false);
    await api('get', 'commerce/serviceability?pin=12').expect(400);
    const a = await listing('PinItem', '500');
    await stock(a.id, 5, 'B1').expect(201);
    const r = await order([{ listingId: a.id, quantity: 1 }], '540', { pin: '560001' }).expect(409);
    expect(r.body.error.message).toContain('does not deliver');
    delete process.env.FASTQUE_DELIVERY_ENABLED;
    await order([{ listingId: a.id, quantity: 1 }], '540').expect(409);
    setFlags(true);
    delete process.env.FASTQUE_COD_ENABLED;
    await order([{ listingId: a.id, quantity: 1 }], '540').expect(409);
    expect(await prisma.commerceOrderItem.count({ where: { listingId: a.id } })).toBe(0);
  });

  it('places a guest COD order once, reserves FEFO, snapshots it and keeps it private', async () => {
    const a = await listing('Serum', '500');
    await stock(a.id, 2, 'LATE', 300, '310').expect(201);
    await stock(a.id, 2, 'SOON', 100, '290').expect(201);
    const key = randomUUID();
    const phone = newPhone();
    const first = await order([{ listingId: a.id, quantity: 3 }], '1540', { key, phone }).expect(201);
    const again = await order([{ listingId: a.id, quantity: 3 }], '1540', { key, phone }).expect(200);
    expect(again.body.fastque).toEqual(first.body.fastque);
    await order([{ listingId: a.id, quantity: 2 }], '1040', { key, phone }).expect(409);
    expect(await batch(a.id, 'SOON')).toMatchObject({ onHand: 2, reserved: 2 });
    expect(await batch(a.id, 'LATE')).toMatchObject({ onHand: 2, reserved: 1 });
    const { orderNumber, accessToken } = first.body.fastque;
    expect(orderNumber).toMatch(/^FQD-/);
    const seen = await api('get', `commerce/orders/${orderNumber}?token=${accessToken}`).expect(200);
    expect(seen.body).toMatchObject({ sellerType: 'FASTQUE', sellerName: 'FastQue', paymentStatus: 'COD_PENDING', subtotal: '1500.00', deliveryCharge: '40.00', total: '1540.00', amountDue: '1540.00' });
    expect(seen.body.taxIncluded).toBe('228.81');
    expect(JSON.stringify(seen.body)).not.toContain('cost');
    await api('get', `commerce/orders/${orderNumber}?token=${'x'.repeat(43)}`).expect(404);
    await api('get', `commerce/orders/${orderNumber}`).expect(400);
    // History does not change when the product does.
    await prisma.commerceListing.update({ where: { id: a.id }, data: { price: 700 } });
    await prisma.globalProduct.update({ where: { id: a.globalProductId }, data: { name: 'Renamed' } });
    const later = await api('get', `commerce/orders/${orderNumber}?token=${accessToken}`).expect(200);
    expect(later.body.items[0]).toMatchObject({ unitPrice: '500.00', name: `Serum ${run}` });
    // It is not a salon order.
    expect(await prisma.shopOrder.count({ where: { contactPhone: phone } })).toBe(0);
    // Cancelling frees the stock exactly once.
    await api('post', `commerce/orders/${orderNumber}/cancel?token=${accessToken}`).send({}).expect(200);
    await api('post', `commerce/orders/${orderNumber}/cancel?token=${accessToken}`).send({}).expect(200);
    expect(await batch(a.id, 'SOON')).toMatchObject({ onHand: 2, reserved: 0 });
    expect(await batch(a.id, 'LATE')).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it('never oversells the last unit and never duplicates a concurrent retry', async () => {
    const a = await listing('LastOne', '500');
    await stock(a.id, 1, 'B1').expect(201);
    const res = await Promise.all(
      Array.from({ length: 6 }, () => order([{ listingId: a.id, quantity: 1 }], '540')),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 1, reserved: 1 });
    const b = await listing('Retry', '500');
    await stock(b.id, 10, 'B1').expect(201);
    const key = randomUUID();
    const phone = newPhone();
    const same = await Promise.all(
      Array.from({ length: 4 }, () => order([{ listingId: b.id, quantity: 1 }], '540', { key, phone })),
    );
    expect(same.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(same.map((r) => r.body.fastque.orderNumber)).size).toBe(1);
    expect(await batch(b.id, 'B1')).toMatchObject({ reserved: 1 });
    await expect(
      prisma.commerceBatch.updateMany({ where: { listingId: a.id }, data: { onHand: -1 } }),
    ).rejects.toThrow();
    await expect(
      prisma.commerceStockMovement.deleteMany({ where: { batch: { listingId: a.id } } }),
    ).rejects.toThrow(/append-only/);
  }, 30000);

  it('refuses changed prices, per-order limits, the COD cap and too many open orders', async () => {
    const a = await listing('Limits', '500', { maxPerOrder: 2 });
    await stock(a.id, 100, 'B1').expect(201);
    const changed = await order([{ listingId: a.id, quantity: 1 }], '500').expect(409);
    expect(changed.body.error.code).toBe('COMMERCE_PRICE_CHANGED');
    await order([{ listingId: a.id, quantity: 3 }], '1540').expect(409);
    await prisma.commerceListing.update({ where: { id: a.id }, data: { maxPerOrder: 50 } });
    const cap = await order([{ listingId: a.id, quantity: 11 }], '5500').expect(409);
    expect(cap.body.error.message).toContain('limited to');
    const phone = newPhone();
    for (let i = 0; i < 5; i++)
      await order([{ listingId: a.id, quantity: 1 }], '540', { phone, who: 'customer' }).expect(201);
    const sixth = await order([{ listingId: a.id, quantity: 1 }], '540', { phone, who: 'customer' }).expect(409);
    expect(sixth.body.error.message).toContain('several Cash on Delivery');
  }, 30000);

  it('never reserves or ships expired stock', async () => {
    const a = await listing('Expiry', '500');
    await stock(a.id, 5, 'OLD', -1).expect(400);
    await stock(a.id, 3, 'B1', 20).expect(201);
    const placed = await order([{ listingId: a.id, quantity: 1 }], '540').expect(201);
    const id = await orderId(placed.body.fastque.orderNumber);
    await prisma.commerceBatch.updateMany({ where: { listingId: a.id }, data: { expiresOn: new Date(day(-1)) } });
    await order([{ listingId: a.id, quantity: 1 }], '540').expect(409);
    await move(id, { to: 'CONFIRMED' }).expect(200);
    await move(id, { to: 'PACKED' }).expect(200);
    const ship = await move(id, { to: 'SHIPPED', shipment: { courier: 'Demo' } }).expect(409);
    expect(ship.body.error.code).toBe('COMMERCE_BATCH_EXPIRED');
    await app.get(CommerceStockService).expireBatches();
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 1, reserved: 1, expired: 2 });
    await move(id, { to: 'CANCELLED', note: 'expired' }).expect(200);
  });

  it('enforces the order state machine, hides staff notes and dispatches stock once', async () => {
    const a = await listing('States', '500');
    await stock(a.id, 10, 'B1').expect(201);
    const placed = await order([{ listingId: a.id, quantity: 2 }], '1040', { who: 'customer' }).expect(201);
    const n = placed.body.fastque.orderNumber as string;
    const id = await orderId(n);
    await move(id, { to: 'DELIVERED' }).expect(409);
    await move(id, { to: 'CONFIRMED', note: 'internal: call first' }).expect(200);
    const mine = await api('get', `customer/commerce/orders/${n}`, 'customer').expect(200);
    expect(JSON.stringify(mine.body)).not.toContain('call first');
    await api('get', `customer/commerce/orders/${n}`, 'other').expect(404);
    await move(id, { to: 'PACKED' }).expect(200);
    await api('post', `customer/commerce/orders/${n}/cancel`, 'customer').send({}).expect(409);
    await move(id, { to: 'SHIPPED' }).expect(400);
    const two = await Promise.all([1, 2].map(() => move(id, { to: 'SHIPPED', shipment: { courier: 'Demo', trackingNumber: 'T1' } })));
    expect(two.every((r) => r.status === 200)).toBe(true);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 8, reserved: 0 });
    expect(await prisma.commerceShipment.count({ where: { orderId: id } })).toBe(1);
    // Failed, rescheduled, then returned to origin: the units come back to quarantine, not to sale.
    await move(id, { to: 'OUT_FOR_DELIVERY' }).expect(200);
    await move(id, { to: 'DELIVERY_FAILED', note: 'not home' }).expect(200);
    await move(id, { to: 'OUT_FOR_DELIVERY' }).expect(200);
    await move(id, { to: 'DELIVERY_FAILED' }).expect(200);
    await move(id, { to: 'RETURN_TO_ORIGIN' }).expect(200);
    await move(id, { to: 'RETURNED' }).expect(200);
    const b = await batch(a.id, 'B1');
    expect(b).toMatchObject({ onHand: 8, quarantined: 2 });
    expect((await prisma.commerceOrder.findUniqueOrThrow({ where: { id } })).paymentStatus).toBe('VOID');
    const adj = admin('post', `batches/${b.id}/adjust`, 'admin', randomUUID());
    await adj.send({ kind: 'QUARANTINE_OUT', quantity: 2, note: 'Checked, sealed' }).expect(200);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 10, quarantined: 0 });
    await app.get(CommerceOutboxService).deliver();
    const notes = await prisma.notification.findMany({ where: { userId: ids.customer, type: 'commerce.order.updated' } });
    expect(notes.length).toBeGreaterThan(4);
    const before = notes.length;
    await app.get(CommerceOutboxService).deliver();
    expect(await prisma.notification.count({ where: { userId: ids.customer, type: 'commerce.order.updated' } })).toBe(before);
  }, 30000);

  it('reconciles COD only with evidence and a second person for adjustments', async () => {
    const a = await listing('Cod', '500');
    await stock(a.id, 10, 'B1').expect(201);
    const id = await orderId((await order([{ listingId: a.id, quantity: 1 }], '540').expect(201)).body.fastque.orderNumber);
    const cod = (body: Record<string, unknown>, key = randomUUID(), who = 'admin') =>
      admin('post', `orders/${id}/cod`, who, key).send({ occurredOn: day(0), ...body });
    await cod({ kind: 'COLLECTED', amount: '540' }).expect(409); // not delivered yet
    await deliver(id);
    const status = async () => (await prisma.commerceOrder.findUniqueOrThrow({ where: { id } })).paymentStatus;
    expect(await status()).toBe('COD_PENDING'); // delivery never means paid
    const key = randomUUID();
    await cod({ kind: 'COLLECTED', amount: '540' }, key).expect(204);
    await cod({ kind: 'COLLECTED', amount: '540' }, key).expect(204);
    expect(await status()).toBe('COD_COLLECTED');
    await cod({ kind: 'COLLECTED', amount: '1' }).expect(409);
    await cod({ kind: 'SETTLED', amount: '600' }).expect(409);
    await cod({ kind: 'SETTLED', amount: '500', deductions: '25', reference: 'S1' }).expect(204);
    expect(await status()).toBe('PARTIALLY_SETTLED');
    await admin('post', `orders/${id}/reconcile`).expect(409);
    await cod({ kind: 'ADJUSTMENT', amount: '40' }).expect(400); // needs a reason
    await cod({ kind: 'ADJUSTMENT', amount: '40', note: 'Courier short-paid, accepted' }).expect(204);
    expect(await status()).toBe('SETTLEMENT_PENDING');
    await admin('post', `orders/${id}/reconcile`).expect(403);
    await admin('post', `orders/${id}/reconcile`, 'admin2').expect(204);
    expect(await status()).toBe('RECONCILED');
    const list = await admin('get', 'cod?status=RECONCILED&limit=100').expect(200);
    expect(list.body.items.find((x: { id: string }) => x.id === id)).toMatchObject({ settled: '500.00', deductions: '25.00', netReceived: '475.00', adjusted: '40.00', outstanding: '0.00' });
  }, 30000);

  it('handles returns: window, quantity, quarantine, inspection rules, refund and replacement', async () => {
    const a = await listing('Return', '500');
    await stock(a.id, 10, 'B1').expect(201);
    const placed = await order([{ listingId: a.id, quantity: 3 }], '1540', { who: 'customer' }).expect(201);
    const n = placed.body.fastque.orderNumber as string;
    const id = await orderId(n);
    const item = (await prisma.commerceOrderItem.findFirstOrThrow({ where: { orderId: id } })).id;
    const ask = (quantity: number, reason: string, resolution: string, who = 'customer') =>
      api('post', `customer/commerce/orders/${n}/returns`, who).send({ items: [{ orderItemId: item, quantity }], reason, resolution });
    await ask(1, 'OTHER', 'REFUND').expect(409); // not delivered
    await deliver(id);
    await ask(1, 'OTHER', 'REFUND', 'other').expect(404);
    await ask(4, 'OTHER', 'REFUND').expect(409);
    delete process.env.FASTQUE_RETURNS_ENABLED;
    await ask(1, 'OTHER', 'REFUND').expect(409);
    setFlags(true);
    const r1 = (await ask(1, 'OTHER', 'REFUND').expect(201)).body.returns[0];
    await ask(3, 'OTHER', 'REFUND').expect(409); // only two left
    const act = (rid: string, body: Record<string, unknown>) => admin('post', `returns/${rid}`).send(body);
    await act(r1.id, { to: 'REJECTED' }).expect(400);
    await act(r1.id, { to: 'REFUNDED' }).expect(409);
    await act(r1.id, { to: 'APPROVED' }).expect(200);
    await act(r1.id, { to: 'RECEIVED' }).expect(200);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 7, quarantined: 1 });
    await act(r1.id, { to: 'INSPECTED' }).expect(400);
    await act(r1.id, { to: 'INSPECTED', dispositions: [{ returnItemId: r1.items[0].id, disposition: 'RESTOCK' }] }).expect(200);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 8, quarantined: 0 });
    await act(r1.id, { to: 'REFUNDED' }).expect(409); // cash not recorded yet
    await admin('post', `orders/${id}/cod`, 'admin', randomUUID()).send({ kind: 'COLLECTED', amount: '1540', occurredOn: day(0) }).expect(204);
    await act(r1.id, { to: 'REFUNDED', refundAmount: '900' }).expect(409);
    await act(r1.id, { to: 'REFUNDED', refundReference: 'UPI-REF' }).expect(200);
    expect(Number((await prisma.commerceCodEntry.findFirstOrThrow({ where: { orderId: id, kind: 'REFUND' } })).amount)).toBe(500);
    const r2 = (await ask(1, 'DAMAGED', 'REPLACEMENT').expect(201)).body.returns[0];
    await act(r2.id, { to: 'APPROVED' }).expect(200);
    await act(r2.id, { to: 'RECEIVED' }).expect(200);
    await act(r2.id, { to: 'INSPECTED', dispositions: [{ returnItemId: r2.items[0].id, disposition: 'RESTOCK' }] }).expect(409);
    await act(r2.id, { to: 'INSPECTED', dispositions: [{ returnItemId: r2.items[0].id, disposition: 'DAMAGED' }] }).expect(200);
    await act(r2.id, { to: 'REPLACED' }).expect(200);
    expect(await batch(a.id, 'B1')).toMatchObject({ onHand: 7, reserved: 0, quarantined: 0, damaged: 1 });
    await prisma.commerceOrder.update({ where: { id }, data: { deliveredAt: new Date(Date.now() - 30 * 86400_000) } });
    await ask(1, 'OTHER', 'REFUND').expect(409);
  }, 40000);

  it('applies coupons by rule, once per customer, and gives them back on cancellation', async () => {
    const a = await listing('Coupon', '500');
    await stock(a.id, 20, 'B1').expect(201);
    const code = `SAVE${run}`.toUpperCase();
    await admin('post', 'coupons').send({ code, kind: 'PERCENT', value: '20', maxDiscount: '60', minOrder: '400', firstOrderOnly: true }).expect(201);
    const phone = newPhone();
    const first = await order([{ listingId: a.id, quantity: 1 }], '480', { phone, coupon: code }).expect(201);
    await order([{ listingId: a.id, quantity: 1 }], '480', { phone, coupon: code }).expect(409);
    const f = first.body.fastque;
    await api('post', `commerce/orders/${f.orderNumber}/cancel?token=${f.accessToken}`).send({}).expect(200);
    await order([{ listingId: a.id, quantity: 1 }], '480', { phone, coupon: code }).expect(201);
    await order([{ listingId: a.id, quantity: 1 }], '540', { coupon: 'NOPE99' }).expect(409);
    const below = await admin('put', `listings/${a.id}`).send({ globalProductId: a.globalProductId, sku: `SKU-Coupon-${run}`, mrp: '1000', price: '100', status: 'ACTIVE' }).expect(409);
    expect(below.body.error.code).toBe('COMMERCE_BELOW_COST');
  });

  it('buys through purchase orders: approval, partial receipt, rejections and balances', async () => {
    const a = await listing('Procure', '500');
    const sup = await admin('post', 'suppliers').send({ name: `Supplier ${run}`, leadTimeDays: 4 }).expect(201);
    await admin('put', `suppliers/${sup.body.id}/products`).send({ listingId: a.id, unitCost: '250', minQty: 5 }).expect(200);
    const po = await admin('post', 'purchase-orders').send({ supplierId: sup.body.id, warehouseId: ids.wh, items: [{ listingId: a.id, quantity: 10, unitCost: '250' }] }).expect(201);
    const line = (await prisma.commercePoItem.findFirstOrThrow({ where: { poId: po.body.id } })).id;
    const receive = (accepted: number, rejected: number, key = randomUUID()) =>
      admin('post', `purchase-orders/${po.body.id}/receive`, 'admin', key).send({ invoiceNumber: 'INV1', lines: [{ poItemId: line, accepted, rejected, batchNumber: 'PB1', expiresOn: day(300) }] });
    const act = (action: string) => admin('post', `purchase-orders/${po.body.id}/action`).send({ action });
    await receive(5, 0).expect(409);
    await act('ORDER').expect(409);
    await act('APPROVE').expect(204);
    await act('ORDER').expect(204);
    const key = randomUUID();
    await receive(6, 2, key).expect(200);
    await receive(6, 2, key).expect(200); // retry receives nothing twice
    expect(await batch(a.id, 'PB1')).toMatchObject({ onHand: 6 });
    await receive(5, 0).expect(409);
    expect((await receive(4, 0).expect(200)).body.status).toBe('RECEIVED');
    await admin('post', `suppliers/${sup.body.id}/payments`, 'admin', randomUUID()).send({ poId: po.body.id, amount: '1000', paidOn: day(0) }).expect(201);
    const list = await admin('get', 'suppliers').expect(200);
    expect(list.body.find((s: { id: string }) => s.id === sup.body.id)).toMatchObject({ billed: '2500.00', paid: '1000.00', outstanding: '1500.00', rejectionRate: '16.7' });
    // Transfer keeps the total and cannot take reserved units.
    const wh2 = await admin('post', 'warehouses').send({ code: `X${run}`, name: 'Second' }).expect(201);
    const b = await batch(a.id, 'PB1');
    await admin('post', `batches/${b.id}/transfer`, 'admin', randomUUID()).send({ toWarehouseId: wh2.body.id, quantity: 11 }).expect(409);
    await admin('post', `batches/${b.id}/transfer`, 'admin', randomUUID()).send({ toWarehouseId: wh2.body.id, quantity: 4 }).expect(204);
    const sum = await prisma.commerceBatch.aggregate({ where: { listingId: a.id }, _sum: { onHand: true } });
    expect(sum._sum.onHand).toBe(10);
    // The ledger always explains the balance.
    const led = await prisma.commerceStockMovement.aggregate({ where: { batch: { listingId: a.id } }, _sum: { onHandDelta: true } });
    expect(led._sum.onHandDelta).toBe(10);
  });

  it('checks out FastQue and salon products together, or nothing at all', async () => {
    const city = await prisma.city.findFirstOrThrow();
    const salon = async (label: string) => {
      const s = await prisma.salon.create({
        data: { ownerUserId: ids.owner, name: `Salon ${label} ${run}`, slug: `dc-${label}-${run}`, cityId: city.id, addressLine: 'Demo', status: SalonStatus.ACTIVE },
      });
      await prisma.userRole.create({ data: { userId: ids.owner, role: Role.SALON_OWNER, salonId: s.id } });
      const gp = await product(`Salon${label}`);
      const inv = await prisma.inventoryProduct.create({
        data: { salonId: s.id, name: `Inv ${label}`, normalizedName: `inv ${label}`, unit: 'EACH', globalProductId: gp, usage: 'RETAIL' },
      });
      await prisma.inventoryMovement.create({
        data: { salonId: s.id, productId: inv.id, actorUserId: ids.owner, kind: 'OPENING', quantityDelta: 2, unitCost: 50, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64) },
      });
      const l = await prisma.shopListing.create({
        data: { salonId: s.id, inventoryProductId: inv.id, globalProductId: gp, price: 200, status: 'APPROVED' },
      });
      return { salonId: s.id, listingId: l.id };
    };
    const A = await salon('a');
    const B = await salon('b');
    const a = await listing('Mixed', '500');
    await stock(a.id, 5, 'B1').expect(201);
    const group = (l: { listingId: string }, q = 1) => ({ items: [{ listingId: l.listingId, quantity: q }], expectedTotal: String(200 * q) });
    const lines = [{ listingId: a.id, quantity: 1 }];

    delete process.env.MULTI_SELLER_CART_ENABLED;
    await order(lines, '540', { salons: [group(A)] }).expect(409);
    setFlags(true);

    // One salon cannot supply: nothing is placed anywhere.
    const bad = await order(lines, '540', { salons: [group(A), group(B, 3)] }).expect(409);
    expect(bad.body.error.message).toContain(`Salon b ${run}`);
    expect(await batch(a.id, 'B1')).toMatchObject({ reserved: 0 });
    expect(await prisma.shopOrder.count({ where: { salonId: { in: [A.salonId, B.salonId] } } })).toBe(0);

    const key = randomUUID();
    const phone = newPhone();
    const ok = await order(lines, '540', { salons: [group(A), group(B)], who: 'customer', key, phone }).expect(201);
    expect(ok.body.salons).toHaveLength(2);
    const replay = await order(lines, '540', { salons: [group(A), group(B)], who: 'customer', key, phone }).expect(200);
    expect(replay.body.salons).toEqual(ok.body.salons);
    const s0 = ok.body.salons[0];
    // The salon order is an ordinary marketplace order with its own lifecycle and link.
    const shop = await api('get', `shop/orders/${s0.orderNumber}?token=${s0.accessToken}`).expect(200);
    expect(shop.body).toMatchObject({ status: 'PLACED', fulfillment: 'PICKUP', paymentMethod: 'PAY_AT_SALON', total: '200.00' });
    expect(await prisma.shopOrder.count({ where: { salonId: { in: [A.salonId, B.salonId] } } })).toBe(2);
    // The salon owner never sees the FastQue part.
    const ownerView = await api('get', `dashboard/salons/${A.salonId}/shop/orders`, 'owner').expect(200);
    expect(JSON.stringify(ownerView.body)).not.toContain('FQD-');
    expect(JSON.stringify(ownerView.body)).not.toContain('Flat 1, Demo Block');

    // Salon sold out between preflight and placing is compensated: run two racing mixed checkouts.
    const race = await Promise.all([1, 2].map(() => order(lines, '540', { salons: [group(A)] })));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    const open = await prisma.commerceOrder.count({ where: { items: { some: { listingId: a.id } }, status: 'PLACED' } });
    expect(await batch(a.id, 'B1')).toMatchObject({ reserved: open });
    expect(open).toBe(2);
    await app.get(CommerceOutboxService).deliver();
    expect(await prisma.notification.count({ where: { userId: ids.owner, type: 'shop.order.updated' } })).toBeGreaterThanOrEqual(2);
  }, 40000);

  it('reports FastQue and salon sales separately, protects cost, and explains every insight', async () => {
    const full = await admin('get', 'overview').expect(200);
    expect(full.body.finance.netRevenue).toBeDefined();
    expect(full.body.salonMarketplace.note).toContain('Not FastQue revenue');
    expect(Number(full.body.finance.grossProfit)).toBeCloseTo(Number(full.body.finance.netRevenue) - Number(full.body.finance.costOfGoods), 2);
    const limited = await admin('get', 'listings?limit=1', 'viewer').expect(200);
    expect(JSON.stringify(limited.body)).not.toMatch(/averageCost|marginPercent/);
    const batches = await admin('get', 'batches?limit=1', 'viewer').expect(200);
    expect(JSON.stringify(batches.body)).not.toContain('unitCost');
    const ins = await admin('get', 'insights').expect(200);
    expect(ins.body.every((i: { basis: string }) => i.basis.length > 5)).toBe(true);
    delete process.env.FASTQUE_COMMERCE_AI_ENABLED;
    await admin('get', 'insights').expect(404);
    const csv = await admin('get', 'export/orders').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
  });

  it('finds unmarked sample products and hides them reversibly without deleting anything', async () => {
    const mock = await product('Mocky', { brand: 'BeautyMock' });
    const dq = await admin('get', 'data-quality').expect(200);
    expect(dq.body.suspect.some((s: { id: string }) => s.id === mock)).toBe(true);
    await admin('post', 'data-quality/test-data', 'viewer').send({ productIds: [mock], isTestData: true }).expect(403);
    await admin('post', 'data-quality/test-data').send({ productIds: [mock], isTestData: true }).expect(200);
    expect((await prisma.globalProduct.findUniqueOrThrow({ where: { id: mock } })).isTestData).toBe(true);
    await admin('post', 'data-quality/test-data').send({ productIds: [mock], isTestData: false }).expect(200);
    expect((await prisma.globalProduct.findUniqueOrThrow({ where: { id: mock } })).isTestData).toBe(false);
  });

  it('keeps saved addresses private to their customer', async () => {
    const r = await api('post', 'customer/commerce/addresses', 'customer').send(address()).expect(201);
    await api('put', `customer/commerce/addresses/${r.body.id}`, 'other').send(address()).expect(404);
    await api('delete', `customer/commerce/addresses/${r.body.id}`, 'other').expect(204);
    expect((await api('get', 'customer/commerce/addresses', 'customer')).body).toHaveLength(1);
    await api('post', 'customer/commerce/addresses', 'customer').send(address('000000')).expect(400);
  });
});
