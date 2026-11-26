import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Role,
  SessionAudience,
  UserStatus,
} from '@barbercue/shared';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/services/token.service';
import { CommerceIntelService } from '../src/commerce/commerce-intel.service';
import { toXlsx } from '../src/commerce/commerce-ops.service';
import { readXlsx } from '../src/inventory/upload/spreadsheet-reader';

process.env.JWT_ACCESS_SECRET ??= 'commerce-e2e-only-jwt-secret';
process.env.TOTP_ENCRYPTION_KEY ??= 'commerce-e2e-only-encryption-secret';
process.env.PRIVATE_STORAGE_DIR ??= join(tmpdir(), 'fastque-commerce-e2e');
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
const phoneBase = 7_000_000_000 + Math.floor(Math.random() * 900_000) * 1000;
const newPhone = () => `+91${phoneBase + ++phoneSerial}`;

maybe('FastQue direct commerce extras (real AppModule, disposable PostgreSQL)', () => {
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
          email: `dx-${run}-${label}@example.test`,
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

  // ---------- Helpers for this file ----------
  const place = async (items: Array<{ listingId: string; quantity: number }>, total: string, opt: Parameters<typeof order>[2] = {}) => {
    const r = await order(items, total, opt).expect(201);
    const n = r.body.fastque.orderNumber as string;
    return { n, id: await orderId(n), token: r.body.fastque.accessToken as string };
  };
  const quote = (items: Array<{ listingId: string; quantity: number }>, extra = {}) =>
    api('post', 'commerce/quote').send({ items, pincode: '201310', ...extra }).expect(200);
  const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'));
  let png: Buffer;
  beforeAll(async () => {
    png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).png().toBuffer();
  });

  it('hides every new route while the flag is off', async () => {
    setFlags(false);
    for (const p of ['commerce/banners', 'commerce/listings?ids=' + randomUUID(), `commerce/products/${randomUUID()}/reviews`])
      await api('get', p).expect(404);
    for (const p of ['reviews', 'tickets', 'promotions', 'audits', 'settlements', 'purchase-requests', 'pickups', 'reports'])
      await admin('get', p).expect(404);
    await api('get', 'customer/commerce/bag', 'customer').expect(404);
  });

  it('refuses owners, customers and ungranted admins on every new admin route', async () => {
    for (const p of ['reviews', 'tickets', 'audits', 'settlements', 'purchase-requests', 'supplier-returns', 'pickups', 'forecast', 'price-suggestions', 'risk-signals', 'warehouse-grants', 'stock-alerts', 'export/orders-xlsx'])
      for (const who of ['owner', 'customer', 'viewer']) await admin('get', p, who).expect(403);
    await api('get', 'admin/commerce/reviews').expect(401);
  });

  it('accepts reviews only for delivered purchases, once, and publishes them only after moderation', async () => {
    const a = await listing('Reviewed', '500');
    await stock(a.id, 5, 'R1').expect(201);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const item = (await prisma.commerceOrderItem.findFirstOrThrow({ where: { orderId: o.id } })).id;
    const send = (body: object, token = o.token) => api('post', `commerce/orders/${o.n}/reviews?token=${token}`).send({ orderItemId: item, displayName: 'Asha', rating: 4, body: 'Good', ...body });
    await send({}).expect(409);
    await deliver(o.id);
    await send({}, 'x'.repeat(43)).expect(404);
    await send({ rating: 6 }).expect(400);
    const other = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const otherItem = (await prisma.commerceOrderItem.findFirstOrThrow({ where: { orderId: other.id } })).id;
    await send({ orderItemId: otherItem }).expect(404);
    const all = await Promise.all([send({}), send({}), send({})]);
    expect(all.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const url = `commerce/products/${a.globalProductId}/reviews`;
    expect((await api('get', url).expect(200)).body).toMatchObject({ count: 0, average: null });
    const id = all.find((r) => r.status === 201)!.body.id as string;
    await admin('post', `reviews/${id}`).send({ status: 'PUBLISHED', reply: 'Thank you' }).expect(200);
    expect((await api('get', url)).body).toMatchObject({ count: 1, average: 4, items: [{ displayName: 'Asha', reply: 'Thank you', verifiedPurchase: true }] });
    expect((await api('get', `commerce/products/${a.globalProductId}/offer`)).body.offer.rating).toEqual({ average: 4, count: 1 });
    await admin('post', `reviews/${id}`).send({ status: 'HIDDEN' }).expect(200);
    expect((await api('get', url)).body.count).toBe(0);
  });

  it('links support requests to the order and never shows internal notes to the customer', async () => {
    const a = await listing('Support', '500');
    await stock(a.id, 5, 'S1').expect(201);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00', { who: 'customer' });
    const base = `customer/commerce/orders/${o.n}/tickets`;
    const t = (await api('post', base, 'customer').send({ category: 'DELIVERY', subject: 'Where is it', body: 'Please check' }).expect(201)).body[0];
    await api('get', base, 'other').expect(404);
    await api('post', `${base}/${t.id}`, 'other').send({ body: 'hi' }).expect(404);
    await admin('post', `tickets/${t.id}`).send({ body: 'Customer sounds upset', internal: true }).expect(200);
    await admin('post', `tickets/${t.id}`).send({ body: 'It ships today', assignToMe: true, priority: 'HIGH' }).expect(200);
    const seen = (await api('get', base, 'customer').expect(200)).body[0];
    expect(seen.status).toBe('WAITING_CUSTOMER');
    expect(seen.messages.map((m: { body: string }) => m.body)).toEqual(['Please check', 'It ships today']);
    const staff = (await admin('get', `tickets?q=${t.number}`)).body.items[0];
    expect(staff.messages).toHaveLength(3);
    expect(staff).toMatchObject({ orderNumber: o.n, priority: 'HIGH' });
    expect(await prisma.commerceOutbox.count({ where: { userId: ids.customer, type: 'commerce.ticket.updated' } })).toBe(1);
    const s = (await admin('get', `tickets/${t.id}/suggestion`).expect(200)).body;
    expect(s.reply).toContain(o.n);
    expect(await prisma.commerceTicketMessage.count({ where: { ticketId: t.id } })).toBe(3); // a suggestion sends nothing
    await expect(prisma.commerceTicketMessage.deleteMany({ where: { ticketId: t.id } })).rejects.toThrow();
    for (let i = 0; i < 4; i++) await api('post', base, 'customer').send({ category: 'OTHER', subject: 'More', body: 'Another question' }).expect(201);
    await api('post', base, 'customer').send({ category: 'OTHER', subject: 'More', body: 'Another question' }).expect(409);
  });

  it('applies buy-one-get-one, bundles and area offers on the server, without stacking, and refunds them fairly', async () => {
    const a = await listing('Bogo', '400');
    const b = await listing('Plain', '600');
    await stock(a.id, 20, 'P1', 400, '100').expect(201);
    await stock(b.id, 20, 'P2', 400, '100').expect(201);
    const save = (body: object) => admin('post', 'promotions').send({ name: 'Offer', kind: 'BUY_X_GET_Y', listingIds: [a.id], buyQty: 1, getQty: 1, ...body });
    await save({ getQty: 0 }).expect(400);
    await save({ kind: 'PERCENT', value: '80' }).expect(409); // below cost
    const bogo = (await save({ name: 'Buy 1 get 1' }).expect(201)).body;
    await save({ name: 'Elsewhere', kind: 'PERCENT', value: '50', pinRules: ['56'] }).expect(201);
    let q = (await quote([{ listingId: a.id, quantity: 3 }, { listingId: b.id, quantity: 1 }])).body;
    expect(q).toMatchObject({ subtotal: '1800.00', discountTotal: '400.00', promotions: [{ name: 'Buy 1 get 1', amount: '400.00' }], total: '1440.00' });
    await save({ name: 'Pair', kind: 'BUNDLE', listingIds: [a.id, b.id], value: '700' }).expect(201); // saves 300 < 400
    q = (await quote([{ listingId: a.id, quantity: 2 }, { listingId: b.id, quantity: 1 }])).body;
    expect(q.promotions).toEqual([{ name: 'Buy 1 get 1', amount: '400.00' }]);
    q = (await quote([{ listingId: a.id, quantity: 1 }, { listingId: b.id, quantity: 1 }])).body;
    expect(q.promotions).toEqual([{ name: 'Pair', amount: '300.00' }]);
    // A coupon works on what is left after the offer.
    await admin('post', 'coupons').send({ code: `TEN${run.toUpperCase()}`, kind: 'PERCENT', value: '10' }).expect(201);
    q = (await quote([{ listingId: a.id, quantity: 2 }], { couponCode: `TEN${run}` })).body;
    expect(q).toMatchObject({ discountTotal: '440.00', total: '400.00' });
    await order([{ listingId: a.id, quantity: 2 }], '840.00').expect(409); // the server's price wins
    const o = await place([{ listingId: a.id, quantity: 2 }, { listingId: b.id, quantity: 1 }], '1040.00');
    const got = (await api('get', `commerce/orders/${o.n}?token=${o.token}`)).body;
    expect(got.promotions).toEqual([{ name: 'Buy 1 get 1', amount: '400.00' }]);
    await admin('put', `promotions/${bogo.id}`).send({ name: 'Buy 1 get 1', kind: 'BUY_X_GET_Y', listingIds: [a.id], buyQty: 1, getQty: 1, isActive: false }).expect(200);
    await deliver(o.id);
    await admin('post', `orders/${o.id}/cod`, 'admin', randomUUID()).send({ kind: 'COLLECTED', amount: '1040', occurredOn: day(0) }).expect(204);
    // Only the undiscounted product goes back: full price, the offer is not spread onto it.
    const items = got.items as Array<{ id: string; productId: string }>;
    const back = async (productId: string, quantity: number) => {
      const r = (await api('post', `commerce/orders/${o.n}/returns?token=${o.token}`).send({ items: [{ orderItemId: items.find((i) => i.productId === productId)!.id, quantity }], reason: 'DEFECTIVE', resolution: 'REFUND' }).expect(201)).body.returns[0];
      await admin('post', `returns/${r.id}`).send({ to: 'APPROVED' }).expect(200);
      await admin('post', `returns/${r.id}`).send({ to: 'RECEIVED' }).expect(200);
      await admin('post', `returns/${r.id}`).send({ to: 'INSPECTED', dispositions: [{ returnItemId: r.items[0].id, disposition: 'DAMAGED' }] }).expect(200);
      await admin('post', `returns/${r.id}`).send({ to: 'REFUNDED' }).expect(200);
      return (await prisma.commerceCodEntry.findFirstOrThrow({ where: { idempotencyKey: `refund:${r.id}` } })).amount.toFixed(2);
    };
    expect(await back(b.globalProductId, 1)).toBe('600.00');
    expect(await back(a.globalProductId, 1)).toBe('200.00'); // paid 400 for two
  });

  it('shows product details, variants and banners, and applies the stricter return rule', async () => {
    const a = await listing('Shade1', '500');
    const b = await listing('Shade2', '550');
    const c2 = `Cat ${run}`;
    await prisma.globalProduct.update({ where: { id: a.globalProductId }, data: { category: c2 } });
    for (const [l, label] of [[a, 'Red'], [b, 'Blue']] as const)
      await admin('put', `listings/${l.id}/detail`).send({ ingredients: 'Water', countryOfOrigin: 'India', variantGroup: `G${run}`, variantLabel: label }).expect(200);
    const d = (await api('get', `commerce/products/${a.globalProductId}/details`).expect(200)).body;
    expect(d).toMatchObject({ ingredients: 'Water', countryOfOrigin: 'India', usage: null });
    expect(d.variants.map((v: { label: string }) => v.label).sort()).toEqual(['Blue', 'Red']);
    await admin('post', 'banners').send({ title: 'Bad', linkPath: 'https://evil.example' }).expect(400);
    await admin('post', 'banners').send({ title: 'Bad', linkPath: '//evil.example' }).expect(400);
    await admin('post', 'banners').send({ title: `Sale ${run}`, linkPath: '/shop/fastque', sortOrder: 1 }).expect(201);
    await admin('post', 'banners').send({ title: `Later ${run}`, linkPath: '/shop', startsAt: new Date(Date.now() + 864e5).toISOString(), sortOrder: 1 }).expect(201);
    const titles = (await api('get', 'commerce/banners')).body.map((x: { title: string }) => x.title);
    expect(titles).toContain(`Sale ${run}`);
    expect(titles).not.toContain(`Later ${run}`);
    await admin('put', 'return-policies').send({ category: c2, returnable: true, windowDays: 2 }).expect(200);
    expect((await api('get', `commerce/products/${a.globalProductId}/offer`)).body.offer).toMatchObject({ returnable: true, returnWindowDays: 2 });
    await admin('put', 'return-policies').send({ category: c2, returnable: false, windowDays: 2 }).expect(200);
    await stock(a.id, 3, 'V1').expect(201);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    await deliver(o.id);
    const item = (await prisma.commerceOrderItem.findFirstOrThrow({ where: { orderId: o.id } })).id;
    await api('post', `commerce/orders/${o.n}/returns?token=${o.token}`).send({ items: [{ orderItemId: item, quantity: 1 }], reason: 'OTHER', resolution: 'REFUND' }).expect(409);
  });

  it('keeps return photos and delivery proof private, real and limited', async () => {
    const a = await listing('Photo', '500');
    await stock(a.id, 5, 'F1').expect(201);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    await admin('post', `orders/${o.id}/proof`).attach('file', png, 'p.png').expect(400);
    await deliver(o.id);
    await admin('post', `orders/${o.id}/proof`).attach('file', png, 'p.png').expect(201);
    const item = (await prisma.commerceOrderItem.findFirstOrThrow({ where: { orderId: o.id } })).id;
    const r = (await api('post', `commerce/orders/${o.n}/returns?token=${o.token}`).send({ items: [{ orderItemId: item, quantity: 1 }], reason: 'DAMAGED', resolution: 'REFUND' }).expect(201)).body.returns[0];
    const up = (buf: Buffer, name: string, token = o.token) => api('post', `commerce/orders/${o.n}/returns/${r.id}/photos?token=${token}`).attach('file', buf, name);
    await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.jpg').expect(400);
    await up(Buffer.concat([png.subarray(0, 30), Buffer.from('junk')]), 'x.png').expect(400);
    await up(png, 'x.png', 'y'.repeat(43)).expect(404);
    for (let i = 0; i < 5; i++) await up(png, 'x.png').expect(201);
    await up(png, 'x.png').expect(409);
    const files = (await admin('get', `orders/${o.id}/files`).expect(200)).body as Array<{ id: string }>;
    expect(files).toHaveLength(6);
    const f = await admin('get', `files/${files[0].id}`).expect(200);
    expect(f.headers['content-type']).toBe('image/jpeg');
    for (const who of ['owner', 'customer', 'viewer']) await admin('get', `files/${files[0].id}`, who).expect(403);
  });

  it('imports stock from CSV and Excel after a preview, all or nothing, once', async () => {
    const a = await listing('Import', '500');
    const wh = `W${run}`;
    const head = ['SKU', 'Warehouse', 'Batch', 'Expiry', 'Cost', 'Qty'];
    const sku = `SKU-Import-${run}`;
    const good = csv([head, [sku, wh, 'I1', '31/12/2028', '250', '7'], [sku, wh, 'I2', '2028-11-30', '₹260.50', '3']]);
    const bad = csv([head, [sku, wh, 'I1', '31/12/2028', '250', '7'], ['NOPE', 'ZZ', '', '31/02/2028', 'abc', '1.5']]);
    const up = (buf: Buffer, name: string, apply: boolean, who = 'admin') => admin('post', `stock/import?apply=${apply}`, who).attach('file', buf, name);
    const p = (await up(bad, 's.csv', false).expect(200)).body;
    expect(p.problems).toBe(1);
    expect(p.rows[1].problems).toHaveLength(6);
    await up(bad, 's.csv', true).expect(409);
    expect(await prisma.commerceBatch.count({ where: { listingId: a.id } })).toBe(0);
    await up(csv([['a', 'b'], ['1', '2']]), 's.csv', false).expect(400);
    const both = await Promise.all([up(good, 's.csv', true), up(good, 's.csv', true)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await batch(a.id, 'I1')).toMatchObject({ onHand: 7 });
    expect((await batch(a.id, 'I2')).unitCost.toFixed(2)).toBe('260.50');
    const x = toXlsx([{ SKU: sku, Warehouse: wh, Batch: 'I3', Expiry: '2028-10-31', Cost: 200, Qty: 4 }]);
    expect((await up(x, 's.xlsx', true).expect(200)).body.applied).toBe(true);
    expect(await batch(a.id, 'I3')).toMatchObject({ onHand: 4 });
    // Opening balances stay explained by the ledger.
    const led = await prisma.commerceStockMovement.aggregate({ where: { batch: { listingId: a.id } }, _sum: { onHandDelta: true } });
    expect(led._sum.onHandDelta).toBe(14);
  });

  it('matches courier settlement files, records cash once and never signs off by itself', async () => {
    const a = await listing('Settle', '500');
    await stock(a.id, 10, 'C1').expect(201);
    const one = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const two = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const open = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    await deliver(one.id);
    await deliver(two.id);
    await prisma.commerceShipment.updateMany({ where: { orderId: two.id }, data: { trackingNumber: `AWB${run}` } });
    const file = csv([['AWB No', 'COD Amount', 'Charges', 'UTR'], [one.n, '540', '12', 'U1'], [`AWB${run}`, '500', '0', 'U1'], [open.n, '540', '0', 'U1'], ['FQD-UNKNOWN', '1', '0', ''], [one.n, '540', '0', 'U1']]);
    const s = (await admin('post', 'settlements?courier=Demo').attach('file', file, 'c.csv').expect(201)).body;
    expect(s.lines.map((l: { state: string }) => l.state)).toEqual(['MATCHED', 'PROBLEM', 'PROBLEM', 'PROBLEM', 'PROBLEM']);
    await admin('post', 'settlements?courier=Demo').attach('file', file, 'c.csv').expect(409);
    expect(await prisma.commerceCodEntry.count({ where: { orderId: one.id } })).toBe(0); // preview records nothing
    await Promise.all([admin('post', `settlements/${s.id}/apply`), admin('post', `settlements/${s.id}/apply`)]);
    await admin('post', `settlements/${s.id}/apply`).expect(200);
    const cod = await prisma.commerceCodEntry.findMany({ where: { orderId: one.id }, orderBy: { createdAt: 'asc' } });
    expect(cod.map((c) => [c.kind, c.amount.toFixed(2), c.deductions.toFixed(2)])).toEqual([['COLLECTED', '540.00', '0.00'], ['SETTLED', '540.00', '12.00']]);
    expect((await prisma.commerceOrder.findUniqueOrThrow({ where: { id: one.id } })).paymentStatus).toBe('SETTLEMENT_PENDING');
    expect((await admin('get', 'settlements')).body.find((x: { id: string }) => x.id === s.id).lines[0].state).toBe('APPLIED');
    await admin('post', `orders/${one.id}/reconcile`).expect(204);
  });

  it('moves many orders at once with a result for each, and exports a readable workbook', async () => {
    const a = await listing('Bulk', '500');
    await stock(a.id, 10, 'B1').expect(201);
    const o1 = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const o2 = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    await move(o2.id, { to: 'CANCELLED' }).expect(200);
    const r = (await admin('post', 'orders-bulk').send({ orderIds: [o1.id, o2.id, randomUUID()], to: 'CONFIRMED' }).expect(200)).body;
    expect(r.done).toBe(1);
    expect(r.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, false]);
    await admin('post', 'orders-bulk').send({ orderIds: [o1.id], to: 'DELIVERED' }).expect(400); // not a bulk step
    const x = await admin('get', 'export/orders-xlsx').buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    const sheet = readXlsx(x.body as Buffer).sheets[0].rows;
    expect(sheet[0][0].text).toBe('order');
    expect(sheet.some((row) => row[0]?.text === o1.n)).toBe(true);
  });

  it('limits staff to their warehouses on every stock route', async () => {
    const a = await listing('Scoped', '500');
    const wh2 = (await admin('post', 'warehouses').send({ code: `Z${run}`, name: 'Other' }).expect(201)).body.id as string;
    await stock(a.id, 5, 'M1').expect(201);
    await stock(a.id, 5, 'O1', 400, '300', wh2).expect(201);
    await admin('put', 'grants').send({ userId: ids.viewer, permission: 'view', granted: true });
    await admin('put', 'grants').send({ userId: ids.viewer, permission: 'warehouse', granted: true });
    await admin('put', 'warehouse-grants').send({ userId: ids.viewer, warehouseIds: [wh2] }).expect(204);
    await admin('put', 'warehouse-grants', 'viewer').send({ userId: ids.viewer, warehouseIds: [] }).expect(403);
    const mine = await batch(a.id, 'O1');
    const theirs = await batch(a.id, 'M1');
    const list = (await admin('get', `batches?q=SKU-Scoped-${run}`, 'viewer').expect(200)).body.items as Array<{ id: string }>;
    expect(list.map((b) => b.id)).toEqual([mine.id]);
    const adj = (id: string) => admin('post', `batches/${id}/adjust`, 'viewer', randomUUID()).send({ kind: 'DAMAGE', quantity: 1, note: 'Broken' });
    await adj(theirs.id).expect(403);
    await adj(mine.id).expect(200);
    await admin('get', `batches/${theirs.id}/movements`, 'viewer').expect(403);
    await admin('post', `batches/${mine.id}/transfer`, 'viewer', randomUUID()).send({ toWarehouseId: ids.wh, quantity: 1 }).expect(403);
    await admin('post', 'stock', 'viewer', randomUUID()).send({ listingId: a.id, warehouseId: ids.wh, batchNumber: 'X', expiresOn: day(90), unitCost: '1', quantity: 1 }).expect(403);
    await admin('post', 'warehouses', 'viewer').send({ code: `Q${run}`, name: 'New one' }).expect(403);
    await admin('put', `warehouses/${ids.wh}`, 'viewer').send({ code: `W${run}`, name: 'Renamed' }).expect(403);
    await admin('post', 'audits', 'viewer').send({ warehouseId: ids.wh }).expect(403);
    const imp = await admin('post', 'stock/import?apply=false', 'viewer').attach('file', csv([['SKU', 'Warehouse', 'Batch', 'Expiry', 'Cost', 'Qty'], [`SKU-Scoped-${run}`, `W${run}`, 'K1', '2028-01-01', '1', '1']]), 'a.csv').expect(200);
    expect(imp.body.rows[0].problems).toContain('Not your warehouse');
    ids.wh2 = wh2;
  });

  it('counts stock blind, needs a second person, and posts the difference once', async () => {
    const wh = (await admin('post', 'warehouses').send({ code: `C${run}`, name: 'Count' }).expect(201)).body.id as string;
    const a = await listing('Counted', '500');
    await stock(a.id, 10, 'A1', 400, '300', wh).expect(201);
    await stock(a.id, 4, 'A2', 400, '300', wh).expect(201);
    const s = (await admin('post', 'audits').send({ warehouseId: wh }).expect(201)).body;
    expect(s.lines.every((l: { systemQty: unknown }) => l.systemQty === null)).toBe(true);
    const b1 = await batch(a.id, 'A1');
    const b2 = await batch(a.id, 'A2');
    const count = (lines: object[]) => admin('put', `audits/${s.id}/count`).send({ lines });
    await count([{ batchId: randomUUID(), counted: 1 }]).expect(404);
    await count([{ batchId: b1.id, counted: 8 }]).expect(200);
    await admin('post', `audits/${s.id}/approve`, 'admin2').expect(409);
    const done = (await count([{ batchId: b2.id, counted: 5 }]).expect(200)).body;
    expect(done.status).toBe('SUBMITTED');
    // Stock added after counting must not be wiped out by the approval.
    await stock(a.id, 3, 'A1', 400, '300', wh).expect(201);
    await admin('post', `audits/${s.id}/approve`).expect(403);
    await Promise.all([admin('post', `audits/${s.id}/approve`, 'admin2'), admin('post', `audits/${s.id}/approve`, 'admin2')]);
    expect((await admin('post', `audits/${s.id}/approve`, 'admin2').expect(200)).body.approved).toBe(true);
    expect((await batch(a.id, 'A1')).onHand).toBe(11);
    expect((await batch(a.id, 'A2')).onHand).toBe(5);
    await admin('post', `audits/${s.id}/cancel`).expect(409);
  });

  it('runs purchase requests, quotations and supplier returns through to the balance', async () => {
    const a = await listing('Request', '500');
    const sup = (await admin('post', 'suppliers').send({ name: `Req supplier ${run}` }).expect(201)).body.id as string;
    const rq = (await admin('post', 'purchase-requests').send({ listingId: a.id, warehouseId: ids.wh, quantity: 10, reason: 'Running low' }).expect(201)).body.id as string;
    const q = (await admin('post', `purchase-requests/${rq}/quotations`).send({ supplierId: sup, unitCost: '200', leadTimeDays: 3 }).expect(201)).body.id as string;
    const old = (await admin('post', `purchase-requests/${rq}/quotations`).send({ supplierId: sup, unitCost: '150', validUntil: day(-2) }).expect(201)).body.id as string;
    const act = (body: object, who = 'admin') => admin('post', `purchase-requests/${rq}/action`, who).send(body);
    await act({ action: 'ORDER', quotationId: q }).expect(409); // not approved yet
    await act({ action: 'APPROVE' }).expect(200);
    await act({ action: 'ORDER', quotationId: old }).expect(409);
    const both = await Promise.all([act({ action: 'ORDER', quotationId: q }), act({ action: 'ORDER', quotationId: q })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const po = await prisma.commercePurchaseOrder.findFirstOrThrow({ where: { supplierId: sup }, include: { items: true } });
    expect(po).toMatchObject({ status: 'DRAFT' });
    const doc = (await admin('get', `purchase-orders/${po.id}/document`).expect(200)).body;
    expect(doc).toMatchObject({ total: '2000.00', items: [{ quantity: 10, unitCost: '200.00' }] });
    for (const x of ['APPROVE', 'ORDER']) await admin('post', `purchase-orders/${po.id}/action`).send({ action: x }).expect(204);
    await admin('post', `purchase-orders/${po.id}/receive`, 'admin', randomUUID()).send({ lines: [{ poItemId: po.items[0].id, accepted: 10, rejected: 0, batchNumber: 'SR1', expiresOn: day(300) }] }).expect(200);
    const b = await batch(a.id, 'SR1');
    const back = (quantity: number, source: string, key = randomUUID()) => admin('post', 'supplier-returns', 'admin', key).send({ supplierId: sup, batchId: b.id, source, quantity, reason: 'Faulty caps' });
    await back(11, 'ON_HAND').expect(409);
    await back(1, 'DAMAGED').expect(409);
    const key = randomUUID();
    const r = (await back(2, 'ON_HAND', key).expect(201)).body;
    expect((await back(2, 'ON_HAND', key).expect(201)).body.id).toBe(r.id);
    expect((await batch(a.id, 'SR1')).onHand).toBe(8);
    await admin('post', `supplier-returns/${r.id}/credit`).send({ amount: '400', reference: 'CN1' }).expect(204);
    await admin('post', `supplier-returns/${r.id}/credit`).send({ amount: '400' }).expect(409);
    const s = ((await admin('get', 'suppliers')).body as Array<{ id: string }>).find((x) => x.id === sup);
    expect(s).toMatchObject({ billed: '2000.00', credited: '400.00', outstanding: '1600.00' });
  });

  it('schedules pickups only for packed orders of that warehouse', async () => {
    const a = await listing('Pickup', '500');
    await stock(a.id, 5, 'U1').expect(201);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00');
    const book = (extra = {}) => admin('post', 'pickups').send({ warehouseId: ids.wh, courier: 'Demo', pickupOn: day(1), orderIds: [o.id], ...extra });
    await book().expect(409);
    await move(o.id, { to: 'CONFIRMED' });
    await move(o.id, { to: 'PACKED' }).expect(200);
    await book({ pickupOn: day(-2) }).expect(400);
    const both = await Promise.all([book(), book()]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const id = both.find((r) => r.status === 201)!.body.id as string;
    await admin('post', `pickups/${id}`).send({ status: 'PICKED_UP' }).expect(204);
    await admin('post', `pickups/${id}`).send({ status: 'CANCELLED' }).expect(409);
  });

  it('syncs the bag per customer, recommends from real purchases and counts anonymously', async () => {
    const a = await listing('Bag', '500');
    const b = await listing('Similar', '450');
    await stock(a.id, 5, 'G1').expect(201);
    await stock(b.id, 5, 'G2').expect(201);
    await api('put', 'customer/commerce/bag', 'customer').send({ items: [{ listingId: a.id, quantity: 2 }, { listingId: randomUUID(), quantity: 1 }] }).expect(204);
    expect((await api('get', 'customer/commerce/bag', 'customer')).body).toMatchObject([{ quantity: 2, product: { listingId: a.id } }]);
    expect((await api('get', 'customer/commerce/bag', 'other')).body).toEqual([]);
    expect((await api('get', 'customer/commerce/recommendations', 'other')).body).toEqual([]);
    await api('post', 'commerce/events').send({ metric: 'PRODUCT_VIEW' }).expect(204);
    await api('post', 'commerce/events').send({ metric: 'ANYTHING' }).expect(400);
    expect((await api('get', `commerce/listings?ids=${b.id},${a.id}`)).body.map((p: { listingId: string }) => p.listingId)).toEqual([b.id, a.id]);
  });

  it('forecasts only with enough history, suggests without acting, and protects cost', async () => {
    const a = await listing('Forecast', '500');
    await stock(a.id, 50, 'Q1', 30, '300').expect(201);
    let row = ((await admin('get', 'forecast').expect(200)).body as Array<{ listingId: string; forecast: unknown }>).find((x) => x.listingId === a.id)!;
    expect(row.forecast).toBeNull();
    for (let w = 0; w < 6; w++) {
      const o = await place([{ listingId: a.id, quantity: 2 }], '1040.00');
      await prisma.commerceOrder.update({ where: { id: o.id }, data: { placedAt: new Date(Date.now() - (w * 7 + 1) * 864e5) } });
    }
    row = ((await admin('get', 'forecast')).body as Array<{ listingId: string; forecast: unknown }>).find((x) => x.listingId === a.id)!;
    expect(row).toMatchObject({ forecast: { weeklyAverage: 2, weeksOfHistory: 6 } });
    const p = ((await admin('get', 'price-suggestions').expect(200)).body as Array<{ listingId: string; suggestedPrice: string }>).find((x) => x.listingId === a.id)!;
    expect(p).toMatchObject({ currentPrice: '500.00', suggestedPrice: '400.00' });
    expect((await prisma.commerceListing.findUniqueOrThrow({ where: { id: a.id } })).price.toFixed(2)).toBe('500.00');
    await admin('get', 'risk-signals').expect(200);
    const full = (await admin('get', 'reports').expect(200)).body;
    expect(full.customerValue).not.toBeNull();
    expect(full.warehouses.length).toBeGreaterThan(0);
    const limited = (await admin('get', 'reports', 'viewer').expect(200)).body;
    expect(limited.customerValue).toBeNull();
    expect(limited.warehouses.every((w: { stockValue: unknown }) => w.stockValue === null)).toBe(true);
    process.env.FASTQUE_COMMERCE_AI_ENABLED = 'false';
    await admin('get', 'forecast').expect(404);
  });

  it('alerts stock staff once a day and gives invoices only to the order holder', async () => {
    const a = await listing('Alerted', '500', { reorderLevel: 5 });
    await stock(a.id, 2, 'L1', 20).expect(201);
    const alerts = (await admin('get', 'stock-alerts').expect(200)).body;
    expect(alerts.low.some((x: string) => x.startsWith(`Alerted ${run}`))).toBe(true);
    expect(alerts.expiring.some((x: string) => x.includes('L1'))).toBe(true);
    const intel = app.get(CommerceIntelService);
    await intel.sendStockAlerts();
    await intel.sendStockAlerts();
    expect(await prisma.commerceOutbox.count({ where: { userId: ids.admin, type: 'commerce.stock.alert' } })).toBe(1);
    expect(await prisma.commerceOutbox.count({ where: { userId: ids.customer, type: 'commerce.stock.alert' } })).toBe(0);
    const o = await place([{ listingId: a.id, quantity: 1 }], '540.00', { who: 'customer' });
    expect((await api('get', `customer/commerce/orders/${o.n}/invoice`, 'customer').expect(200)).body).toMatchObject({ orderNumber: o.n, total: '540.00' });
    await api('get', `customer/commerce/orders/${o.n}/invoice`, 'other').expect(404);
    await api('get', `commerce/orders/${o.n}/invoice?token=${'z'.repeat(43)}`).expect(404);
  });
});
