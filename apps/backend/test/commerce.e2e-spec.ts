import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Role,
  gtinCheckDigit,
  SalonStatus,
  SessionAudience,
  UserStatus,
} from '@barbercue/shared';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/services/token.service';
import { MarketplaceService } from '../src/commerce/marketplace.service';

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
 * Inventory Phases 4–5 against the real AppModule and a disposable PostgreSQL only (same guard as
 * inventory.e2e-spec.ts): supplier application and admin approval, comparison and minimum order,
 * a purchase order that changes no stock until goods are received (partial deliveries, barcode
 * check, damaged goods, retry-safe receipts), salon-to-salon selling with admin-approved listings
 * and no overselling, customer pickup with a code, returns, expiry releasing reservations, and
 * who may do what.
 */
maybe('Commerce: suppliers, purchase orders, salon and customer selling', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const tok: Record<string, string> = {};
  // A fresh valid EAN-13 per run (prefix 2 = in-store numbering), so runs never collide.
  const body = `2${String(Date.now()).slice(-11)}`;
  const BARCODE = `${body}${gtinCheckDigit(body)}`;

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
  const inv = (salon: 'A' | 'B') => `dashboard/salons/${ids[`salon${salon}`]}/inventory`;
  const stock = async (salonId: string) =>
    (
      await prisma.inventoryProduct.findFirst({
        where: { salonId, globalProductId: ids.product },
        orderBy: { createdAt: 'asc' },
      })
    )?.stockOnHand.toFixed(3) ?? null;

  async function user(label: string, roles: { role: Role; salonId?: string | null }[], audience: SessionAudience) {
    const u = await prisma.user.create({
      data: { email: `commerce-${run}-${label}@example.test`, status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
    });
    for (const r of roles)
      await prisma.userRole.create({ data: { userId: u.id, role: r.role, salonId: r.salonId ?? null } });
    tok[label] = app.get(TokenService).signAccessToken(u.id, roles.map((r) => r.role), audience);
    ids[label] = u.id;
    return u;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    const city = await prisma.city.findFirstOrThrow({});
    ids.city = city.id;
    for (const s of ['A', 'B']) {
      const owner = await prisma.user.create({
        data: { email: `commerce-${run}-owner${s}@example.test`, status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
      });
      const salon = await prisma.salon.create({
        data: { ownerUserId: owner.id, name: `Commerce ${s} ${run}`, slug: `commerce-${s.toLowerCase()}-${run}`, cityId: city.id, addressLine: 'Test address', status: SalonStatus.ACTIVE, timezone: 'Asia/Kolkata', currency: 'INR' },
      });
      await prisma.userRole.create({ data: { userId: owner.id, role: Role.SALON_OWNER, salonId: salon.id } });
      tok[`owner${s}`] = app.get(TokenService).signAccessToken(owner.id, [Role.SALON_OWNER], SessionAudience.STAFF);
      ids[`salon${s}`] = salon.id;
      ids[`owner${s}`] = owner.id;
    }
    await user('supplier', [{ role: Role.CUSTOMER }], SessionAudience.CUSTOMER);
    await user('customer', [{ role: Role.CUSTOMER }], SessionAudience.CUSTOMER);
    await user('customer2', [{ role: Role.CUSTOMER }], SessionAudience.CUSTOMER);
    await user('admin', [{ role: Role.PLATFORM_ADMIN }], SessionAudience.ADMIN);
    // A verified catalog product (100 ml bottle) with a real-format barcode.
    {
      const product = await prisma.globalProduct.create({
        data: {
          name: `Commerce Serum ${run}`, normalizedName: `commerce serum ${run}`, brand: 'QA', category: 'Serum', packSize: 100, packUnit: 'MILLILITER', mrp: 199,
          productType: 'BOTH', dataSource: 'ADMIN', verificationStatus: 'VERIFIED', createdByUserId: ids.admin,
          barcodes: { create: { code: `0${BARCODE}`, display: BARCODE, format: 'GTIN' } },
        },
      });
      ids.product = product.id;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Phase 4: supplier approval, comparison, purchase order and receiving', async () => {
    const application = {
      name: `QA Distributors ${run}`, contactName: 'Ravi', phone: '+91 98765 43210', email: `dist-${run}@example.test`, address: 'Market Road',
      cityId: ids.city, serviceCityIds: [ids.city], defaultLeadTimeDays: 2, deliveryCharge: 40, freeDeliveryAbove: 1000,
    };
    const applied = await api('post', 'supplier/apply', tok.supplier).send(application).expect(201);
    expect(applied.body.status).toBe('PENDING');
    ids.supplierId = applied.body.id;
    await api('post', 'supplier/apply', tok.supplier).send(application).expect(409);
    // Not approved yet: no portal, and salons can't see it.
    await api('get', 'supplier/offers', tok.supplier).expect(403);
    expect((await api('get', `${inv('A')}/marketplace-suppliers`, tok.ownerA).expect(200)).body.some((s: { id: string }) => s.id === ids.supplierId)).toBe(false);

    await api('post', `admin/marketplace-suppliers/${ids.supplierId}/review`, tok.ownerA).send({ action: 'APPROVE' }).expect(403);
    await api('post', `admin/marketplace-suppliers/${ids.supplierId}/review`, tok.admin).send({ action: 'REJECT' }).expect(400);
    await api('post', `admin/marketplace-suppliers/${ids.supplierId}/review`, tok.admin).send({ action: 'APPROVE' }).expect(200);

    await api('put', 'supplier/offers', tok.supplier).send({ globalProductId: ids.product, unitPrice: 50, minOrderQuantity: 6, availableQuantity: 100 }).expect(200);
    const compare = await api('get', `${inv('A')}/compare-suppliers?globalProductId=${ids.product}&quantity=4`, tok.ownerA).expect(200);
    const quote = compare.body.quotes.find((q: { supplierId: string }) => q.supplierId === ids.supplierId);
    expect(quote).toMatchObject({ orderQuantity: 6, itemsTotal: 300, delivery: 40, total: 340, canSupply: true, deliversToShopCity: true });

    const po = { marketplaceSupplierId: ids.supplierId, items: [{ globalProductId: ids.product, quantity: 4, unitPrice: 1 }] };
    await api('post', `${inv('A')}/purchase-orders`, tok.ownerA).send(po).expect(400);
    const draft = await api('post', `${inv('A')}/purchase-orders`, tok.ownerA).send({ ...po, items: [{ globalProductId: ids.product, quantity: 12, unitPrice: 1 }] }).expect(201);
    // The supplier's price is used, not the one sent.
    expect(draft.body).toMatchObject({ status: 'DRAFT', subtotal: '600.00', deliveryCharge: '40.00', total: '640.00', number: 'PO-0001' });
    ids.po = draft.body.id;
    await api('get', `${inv('A')}/purchase-orders/${ids.po}`, tok.ownerB).expect(403);
    await api('post', `${inv('A')}/purchase-orders/${ids.po}/place`, tok.ownerA).expect(200);
    expect(await stock(ids.salonA)).toBeNull(); // placing never adds stock
    expect(await prisma.notification.count({ where: { userId: ids.supplier, type: 'supplier.purchase_order.placed' } })).toBe(1);

    await api('post', `supplier/orders/${ids.po}/dispatch`, tok.supplier).send({}).expect(409);
    await api('post', `supplier/orders/${ids.po}/confirm`, tok.supplier).send({ expectedDeliveryDate: '2026-12-01' }).expect(200);
    await api('post', `supplier/orders/${ids.po}/dispatch`, tok.supplier).send({}).expect(200);
    await api('post', `${inv('A')}/purchase-orders/${ids.po}/cancel`, tok.ownerA).send({ reason: 'too late' }).expect(409);

    const item = draft.body.items[0].id;
    const receipt = (scannedBarcode: string, received: number, damaged = 0) => ({
      lines: [{ purchaseOrderItemId: item, quantityReceived: received, quantityDamaged: damaged, batchNumber: 'SB-1', expiryDate: '2027-12-31', scannedBarcode }],
    });
    await api('post', `${inv('A')}/purchase-orders/${ids.po}/receive`, tok.ownerA, `rc1-${run}`).send(receipt('96385074', 8, 1)).expect(400);
    const part = await api('post', `${inv('A')}/purchase-orders/${ids.po}/receive`, tok.ownerA, `rc1-${run}`).send(receipt(BARCODE, 8, 1)).expect(200);
    expect(part.body.status).toBe('PARTIALLY_RECEIVED');
    expect(await stock(ids.salonA)).toBe('8.000');
    // Same delivery sent again: nothing more is added.
    await api('post', `${inv('A')}/purchase-orders/${ids.po}/receive`, tok.ownerA, `rc1-${run}`).send(receipt(BARCODE, 8, 1)).expect(200);
    expect(await stock(ids.salonA)).toBe('8.000');
    const done = await api('post', `${inv('A')}/purchase-orders/${ids.po}/receive`, tok.ownerA, `rc2-${run}`).send(receipt(BARCODE, 3)).expect(200);
    expect(done.body.status).toBe('RECEIVED');
    expect(await stock(ids.salonA)).toBe('11.000');
    const purchase = await prisma.inventoryMovement.findFirst({ where: { salonId: ids.salonA, kind: 'PURCHASE', reference: 'po:PO-0001' } });
    expect(purchase).toMatchObject({ batchNumber: 'SB-1' });
    expect(purchase!.unitCost!.toFixed(2)).toBe('50.00');
    // The FastQue supplier became the shop's own supplier record, linked.
    expect(await prisma.inventorySupplier.count({ where: { salonId: ids.salonA, marketplaceSupplierId: ids.supplierId } })).toBe(1);
  });

  it('Phase 4: salon-to-salon selling — admin-approved listing, no overselling, stock moves once', async () => {
    const productA = await prisma.inventoryProduct.findFirstOrThrow({ where: { salonId: ids.salonA, globalProductId: ids.product } });
    ids.productA = productA.id;
    const listing = { inventoryProductId: productA.id, channel: 'SALON', quantity: 5, unitPrice: 60, sealed: true, photoUrls: ['https://example.test/p.jpg'], expiryDate: '2027-12-31' };
    await api('post', `${inv('A')}/listings`, tok.ownerA).send(listing).expect(400); // no invoice/provenance
    await api('post', `${inv('A')}/listings`, tok.ownerA).send({ ...listing, quantity: 50, provenanceNote: 'PO-0001' }).expect(400); // more than held
    const created = await api('post', `${inv('A')}/listings`, tok.ownerA).send({ ...listing, provenanceNote: 'Bought on PO-0001' }).expect(201);
    expect(created.body.status).toBe('PENDING_REVIEW');
    ids.listing = created.body.id;
    expect((await api('get', `${inv('B')}/salon-market`, tok.ownerB).expect(200)).body).toHaveLength(0);
    await api('post', `admin/marketplace-listings/${ids.listing}/review`, tok.admin).send({ action: 'APPROVE' }).expect(200);
    const market = await api('get', `${inv('B')}/salon-market`, tok.ownerB).expect(200);
    expect(market.body[0]).toMatchObject({ id: ids.listing, available: 5 });
    // A salon can't buy its own listing.
    await api('post', `${inv('A')}/salon-market/orders`, tok.ownerA, `own-${run}`).send({ items: [{ listingId: ids.listing, quantity: 1 }], paymentMethod: 'INVOICE' }).expect(400);

    const order = await api('post', `${inv('B')}/salon-market/orders`, tok.ownerB, `b1-${run}`).send({ items: [{ listingId: ids.listing, quantity: 3 }], paymentMethod: 'INVOICE' }).expect(201);
    ids.b2bOrder = order.body[0].id;
    await api('post', `${inv('B')}/salon-market/orders`, tok.ownerB, `b2-${run}`).send({ items: [{ listingId: ids.listing, quantity: 3 }], paymentMethod: 'INVOICE' }).expect(409);
    expect((await prisma.marketListing.findUniqueOrThrow({ where: { id: ids.listing } })).quantityReserved).toBe(3);

    await api('post', `${inv('B')}/marketplace-purchases/${ids.b2bOrder}/confirm-receipt`, tok.ownerB).expect(409); // not dispatched yet
    await api('post', `${inv('A')}/sales/${ids.b2bOrder}/accept`, tok.ownerA).expect(200);
    await api('post', `${inv('A')}/sales/${ids.b2bOrder}/dispatch`, tok.ownerA).expect(200);
    expect(await stock(ids.salonA)).toBe('8.000');
    await api('post', `${inv('B')}/marketplace-purchases/${ids.b2bOrder}/confirm-receipt`, tok.ownerB).expect(200);
    await api('post', `${inv('B')}/marketplace-purchases/${ids.b2bOrder}/confirm-receipt`, tok.ownerB).expect(409);
    expect(await stock(ids.salonB)).toBe('3.000');
    const l = await prisma.marketListing.findUniqueOrThrow({ where: { id: ids.listing } });
    expect([l.quantityReserved, l.quantitySold]).toEqual([0, 3]);
  });

  it('Phase 5: customers buy for pickup with a code; returns and expiry release stock correctly', async () => {
    // 8 in stock, 2 still listed to salons → at most 6 can be listed to customers.
    await api('post', `${inv('A')}/listings`, tok.ownerA)
      .send({ inventoryProductId: ids.productA, channel: 'CUSTOMER', quantity: 7, unitPrice: 189, sealed: true, photoUrls: ['https://example.test/p.jpg'] })
      .expect(400);
    await api('post', `${inv('A')}/listings/${ids.listing}/end`, tok.ownerA).expect(200);
    const listing = await api('post', `${inv('A')}/listings`, tok.ownerA)
      .send({ inventoryProductId: ids.productA, channel: 'CUSTOMER', quantity: 3, unitPrice: 189, sealed: true, photoUrls: ['https://example.test/p.jpg'], expiryDate: '2027-12-31' })
      .expect(201);
    ids.shopListing = listing.body.id;
    expect((await api('get', `shop/products?q=Commerce Serum ${run}`).expect(200)).body.items).toHaveLength(0);
    await api('post', `admin/marketplace-listings/${ids.shopListing}/review`, tok.admin).send({ action: 'APPROVE' }).expect(200);
    const shop = await api('get', `shop/products?q=Commerce Serum ${run}`).expect(200);
    expect(shop.body.items[0]).toMatchObject({ globalProductId: ids.product, lowestPrice: '189.00', sellerCount: 1 });
    const detail = await api('get', `shop/products/${ids.product}`).expect(200);
    expect(detail.body.offers[0]).toMatchObject({ salonName: `Commerce A ${run}`, available: 3 });
    // Shop owners and anonymous visitors can't place customer orders; customers can't reach the dashboard.
    await api('post', 'shop/orders', undefined, `x-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 1 }], paymentMethod: 'PAY_AT_PICKUP' }).expect(401);
    await api('get', `${inv('A')}/sales`, tok.customer).expect(403);
    await api('post', 'shop/orders', tok.customer, `c1-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 2 }], paymentMethod: 'UPI_TO_SALON' }).expect(400); // salon has no UPI QR

    const placed = await api('post', 'shop/orders', tok.customer, `c1-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 2 }], paymentMethod: 'PAY_AT_PICKUP' }).expect(201);
    const again = await api('post', 'shop/orders', tok.customer, `c1-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 2 }], paymentMethod: 'PAY_AT_PICKUP' }).expect(201);
    expect(again.body[0].id).toBe(placed.body[0].id); // retry, not a second order
    const order = placed.body[0];
    expect(order.pickupCode).toMatch(/^\d{6}$/);
    await api('post', 'shop/orders', tok.customer2, `c2-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 2 }], paymentMethod: 'PAY_AT_PICKUP' }).expect(409);

    const sales = await api('get', `${inv('A')}/sales`, tok.ownerA).expect(200);
    expect(sales.body.find((o: { id: string }) => o.id === order.id).pickupCode).toBeNull(); // the seller must be told the code
    await api('post', `${inv('A')}/sales/${order.id}/accept`, tok.ownerA).expect(200);
    await api('post', `${inv('A')}/sales/${order.id}/ready`, tok.ownerA).expect(200);
    const wrong = order.pickupCode === '000000' ? '111111' : '000000';
    await api('post', `${inv('A')}/sales/${order.id}/complete`, tok.ownerA).send({ pickupCode: wrong, paid: true }).expect(400);
    await api('post', `${inv('A')}/sales/${order.id}/complete`, tok.ownerA).send({ pickupCode: order.pickupCode, paid: false }).expect(400);
    await api('post', `${inv('A')}/sales/${order.id}/complete`, tok.ownerA).send({ pickupCode: order.pickupCode, paid: true }).expect(200);
    expect(await stock(ids.salonA)).toBe('6.000');
    expect(await prisma.notification.count({ where: { userId: ids.customer, type: 'shop.order.updated' } })).toBeGreaterThanOrEqual(3);

    await api('post', `shop/orders/${order.id}/return`, tok.customer2).send({ reason: 'Not mine' }).expect(404);
    await api('post', `shop/orders/${order.id}/return`, tok.customer).send({ reason: 'Wrong product size' }).expect(200);
    await api('post', `${inv('A')}/sales/${order.id}/return-decision`, tok.ownerA).send({ approve: true }).expect(200);
    expect(await stock(ids.salonA)).toBe('8.000');

    // An order nobody accepts expires and gives its reservation back.
    const late = await api('post', 'shop/orders', tok.customer2, `c3-${run}`).send({ items: [{ listingId: ids.shopListing, quantity: 1 }], paymentMethod: 'PAY_AT_PICKUP' }).expect(201);
    expect((await prisma.marketListing.findUniqueOrThrow({ where: { id: ids.shopListing } })).quantityReserved).toBe(1);
    await prisma.marketOrder.update({ where: { id: late.body[0].id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await app.get(MarketplaceService).expireDue();
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: late.body[0].id } })).status).toBe('EXPIRED');
    expect((await prisma.marketListing.findUniqueOrThrow({ where: { id: ids.shopListing } })).quantityReserved).toBe(0);
    const mine = await api('get', 'shop/orders', tok.customer).expect(200);
    expect(mine.body.map((o: { status: string }) => o.status)).toEqual(['RETURNED']);
  });
});
