import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ADMIN_PATHS,
  COMMERCE_PATHS as P,
  Role,
  commerceAddressSchema,
  commerceCheckoutSchema,
  commerceCodEntrySchema,
  commerceCouponSchema,
  commerceGrantSchema,
  commerceListQuerySchema,
  commerceListingSchema,
  commerceMarkTestDataSchema,
  commercePinQuerySchema,
  commercePoActionSchema,
  commercePoSchema,
  commerceProductsQuerySchema,
  commerceQuoteSchema,
  commerceReceiptSchema,
  commerceReturnActionSchema,
  commerceReturnRequestSchema,
  commerceSellerSettingsSchema,
  commerceStockAdjustSchema,
  commerceStockInSchema,
  commerceSupplierPaymentSchema,
  commerceSupplierProductSchema,
  commerceSupplierSchema,
  commerceTransferSchema,
  commerceTransitionSchema,
  commerceWarehouseSchema,
  commerceZoneSchema,
  type AuthenticatedUser,
  type CommerceAddressInput,
  type CommerceCheckoutInput,
  type CommerceCodEntryInput,
  type CommerceListQuery,
  type CommerceListingInput,
  type CommerceProductsQuery,
  type CommerceQuoteInput,
  type CommerceReceiptInput,
  type CommerceReturnActionInput,
  type CommerceReturnRequestInput,
  type CommerceStockAdjustInput,
  type CommerceStockInInput,
  type CommerceTransitionInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceAdminService } from './commerce-admin.service';
import { CommerceCatalogService } from './commerce-catalog.service';
import { CommerceOpsService } from './commerce-ops.service';
import {
  CommerceOrdersService,
  toCommerceOrderDto,
} from './commerce-orders.service';
import { CommerceStockService } from './commerce-stock.service';
import {
  COMMERCE_STAFF_ROLES,
  CommerceEnabledGuard,
  CommercePermissionGuard,
  CommercePermit,
  fail,
  flag,
  notFound,
  permissionsOf,
  toCsv,
} from './commerce-support';

const pipe = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) =>
  new ZodValidationPipe(schema);
const CHECKOUT = { default: { limit: 10, ttl: 60_000 } };
const LOOKUP = { default: { limit: 30, ttl: 60_000 } };
const tokenSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/) })
  .strict();
const cancelSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();
const searchSchema = z
  .object({ q: z.string().trim().max(120).default('') })
  .strict();
function orderNumber(v: string): string {
  if (!/^FQD-[0-9A-F]{10}$/.test(v)) throw notFound('The order');
  return v;
}
function requestKey(v: string | undefined): string {
  if (!v || !/^[A-Za-z0-9_:-]{8,90}$/.test(v))
    throw fail(
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (8–90 letters, digits, - _ :) is required.',
    );
  return v;
}

/** Says whether direct commerce is on. The only commerce route that answers while it is off. */
@Controller(P.root)
@Public()
export class CommerceConfigController {
  constructor(private readonly catalog: CommerceCatalogService) {}
  @Get('config')
  @Header('Cache-Control', 'public, max-age=30')
  config() {
    return this.catalog.config();
  }
}

@Controller(P.root)
@Public()
@UseGuards(CommerceEnabledGuard)
export class CommercePublicController {
  constructor(
    private readonly catalog: CommerceCatalogService,
    private readonly orders: CommerceOrdersService,
  ) {}

  @Get('home')
  @Header('Cache-Control', 'public, max-age=60')
  home() {
    return this.catalog.home();
  }
  @Get('products')
  @Header('Cache-Control', 'public, max-age=30')
  products(@Query(pipe(commerceProductsQuerySchema)) q: CommerceProductsQuery) {
    return this.catalog.search(q);
  }
  @Get('sitemap-products')
  @Header('Cache-Control', 'public, max-age=3600')
  sitemap() {
    return this.catalog.sitemapIds();
  }
  @Get('products/:id/offer')
  @Header('Cache-Control', 'public, max-age=30')
  async offer(@Param('id', ParseUUIDPipe) id: string) {
    return { offer: await this.catalog.offer(id) };
  }
  @Get('products/:id')
  @Header('Cache-Control', 'public, max-age=30')
  product(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.product(id);
  }
  @Get('serviceability')
  @Throttle(LOOKUP)
  serviceability(@Query(pipe(commercePinQuerySchema)) q: { pin: string }) {
    return this.catalog.serviceability(q.pin);
  }
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @Throttle(LOOKUP)
  quote(@Body(pipe(commerceQuoteSchema)) body: CommerceQuoteInput) {
    return this.orders.publicQuote(body);
  }
  @Post('checkout')
  @Throttle(CHECKOUT)
  async checkout(
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(pipe(commerceCheckoutSchema)) body: CommerceCheckoutInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.orders.checkout(body, key, null);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    res.setHeader('Cache-Control', 'no-store');
    return r;
  }
  @Get('orders/:number')
  @Throttle(LOOKUP)
  @Header('Cache-Control', 'private, no-store')
  async order(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: { token: string },
  ) {
    return toCommerceOrderDto(
      await this.orders.forGuest(orderNumber(n), q.token),
      'CUSTOMER',
    );
  }
  @Post('orders/:number/cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle(CHECKOUT)
  async cancel(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: { token: string },
    @Body(pipe(cancelSchema)) body: { reason?: string },
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.orders.transition(
      o.id,
      { to: 'CANCELLED', note: body.reason || 'Cancelled by the customer' },
      'CUSTOMER',
      null,
    );
  }
  @Post('orders/:number/returns')
  @Throttle(CHECKOUT)
  async returns(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: { token: string },
    @Body(pipe(commerceReturnRequestSchema)) body: CommerceReturnRequestInput,
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.orders.requestReturn(o, body, null);
  }
}

@Controller(P.customer)
@Roles(Role.CUSTOMER)
@UseGuards(CommerceEnabledGuard)
export class CommerceCustomerController {
  constructor(
    private readonly orders: CommerceOrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('checkout')
  @Throttle(CHECKOUT)
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(pipe(commerceCheckoutSchema)) body: CommerceCheckoutInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.orders.checkout(body, key, user.id);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return r;
  }
  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForCustomer(user.id);
  }
  @Get('orders/:number')
  @Header('Cache-Control', 'private, no-store')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
  ) {
    return toCommerceOrderDto(
      await this.orders.forCustomer(user.id, orderNumber(n)),
      'CUSTOMER',
    );
  }
  @Post('orders/:number/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Body(pipe(cancelSchema)) body: { reason?: string },
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.orders.transition(
      o.id,
      { to: 'CANCELLED', note: body.reason || 'Cancelled by the customer' },
      'CUSTOMER',
      user.id,
    );
  }
  @Post('orders/:number/returns')
  async returns(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Body(pipe(commerceReturnRequestSchema)) body: CommerceReturnRequestInput,
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.orders.requestReturn(o, body, user.id);
  }

  @Get('addresses')
  @Header('Cache-Control', 'private, no-store')
  addresses(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.commerceAddress.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });
  }
  @Post('addresses')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceAddressSchema)) body: CommerceAddressInput,
  ) {
    return this.save(user.id, null, body);
  }
  @Put('addresses/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceAddressSchema)) body: CommerceAddressInput,
  ) {
    return this.save(user.id, id, body);
  }
  @Delete('addresses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.prisma.commerceAddress.deleteMany({
      where: { id, userId: user.id },
    });
  }
  private save(userId: string, id: string | null, body: CommerceAddressInput) {
    return this.prisma.$transaction(async (tx) => {
      if (
        id &&
        !(await tx.commerceAddress.findFirst({ where: { id, userId } }))
      )
        throw notFound('The address');
      const count = await tx.commerceAddress.count({ where: { userId } });
      if (!id && count >= 20)
        throw fail('COMMERCE_ADDRESS', 'You can save up to 20 addresses.');
      const isDefault = body.isDefault ?? (!id && count === 0);
      if (isDefault)
        await tx.commerceAddress.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      return id
        ? tx.commerceAddress.update({
            where: { id },
            data: { ...body, isDefault },
          })
        : tx.commerceAddress.create({ data: { ...body, isDefault, userId } });
    });
  }
}

type Body<T extends z.ZodTypeAny> = z.infer<T>;

/** FastQue Commerce admin. Every route needs an explicit permission, checked on the server. */
@Controller(`${ADMIN_PATHS.admin}/${P.admin}`)
@Roles(...COMMERCE_STAFF_ROLES)
@UseGuards(CommerceEnabledGuard, CommercePermissionGuard)
@CommercePermit('view')
export class CommerceAdminController {
  constructor(
    private readonly admin: CommerceAdminService,
    private readonly orders: CommerceOrdersService,
    private readonly stock: CommerceStockService,
    private readonly ops: CommerceOpsService,
    private readonly prisma: PrismaService,
  ) {}
  private async can(
    user: AuthenticatedUser,
    permission: 'finance' | 'procurement',
  ) {
    return (await permissionsOf(this.prisma, user)).includes(permission);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return { permissions: await permissionsOf(this.prisma, user) };
  }
  @Get('overview')
  @Header('Cache-Control', 'private, no-store')
  async overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
  ) {
    return this.admin.overview(q, await this.can(user, 'finance'));
  }
  @Get('insights')
  insights() {
    if (!flag('FASTQUE_COMMERCE_AI_ENABLED')) throw notFound('This page');
    return this.admin.insights();
  }
  @Get('data-quality')
  dataQuality() {
    return this.admin.dataQuality();
  }
  @Post('data-quality/test-data')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('settings')
  markTest(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceMarkTestDataSchema))
    body: Body<typeof commerceMarkTestDataSchema>,
  ) {
    return this.admin.markTestData(body.productIds, body.isTestData, user.id);
  }

  // Settings
  @Get('seller')
  seller() {
    return this.admin.fastque();
  }
  @Put('seller')
  @CommercePermit('settings')
  saveSeller(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceSellerSettingsSchema))
    body: Body<typeof commerceSellerSettingsSchema>,
  ) {
    return this.admin.saveSeller(body, user.id);
  }
  @Get('grants')
  @CommercePermit('settings')
  grants() {
    return this.admin.grants();
  }
  @Put('grants')
  @CommercePermit('settings')
  setGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceGrantSchema)) body: Body<typeof commerceGrantSchema>,
  ) {
    return this.admin.setGrant(body, user.id);
  }

  // Products
  @Get('catalog')
  @CommercePermit('catalog')
  catalog(@Query(pipe(searchSchema)) q: { q: string }) {
    return this.admin.catalogSearch(q.q);
  }
  @Get('listings')
  async listings(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
  ) {
    return this.admin.listings(q, await this.can(user, 'finance'));
  }
  @Post('listings')
  @CommercePermit('catalog')
  createListing(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceListingSchema)) body: CommerceListingInput,
  ) {
    return this.admin.saveListing(null, body, user.id);
  }
  @Put('listings/:id')
  @CommercePermit('catalog')
  updateListing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceListingSchema)) body: CommerceListingInput,
  ) {
    return this.admin.saveListing(id, body, user.id);
  }

  // Warehouses & stock
  @Get('warehouses')
  warehouses() {
    return this.admin.warehouses();
  }
  @Post('warehouses')
  @CommercePermit('warehouse')
  async createWarehouse(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceWarehouseSchema))
    body: Body<typeof commerceWarehouseSchema>,
  ) {
    // Someone limited to certain warehouses cannot add another one.
    await this.ops.assertWarehouse(user, 'new');
    return this.admin.saveWarehouse(null, body, user.id);
  }
  @Put('warehouses/:id')
  @CommercePermit('warehouse')
  async updateWarehouse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceWarehouseSchema))
    body: Body<typeof commerceWarehouseSchema>,
  ) {
    await this.ops.assertWarehouse(user, id);
    return this.admin.saveWarehouse(id, body, user.id);
  }
  @Get('batches')
  async batches(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
  ) {
    return this.admin.batches(
      q,
      await this.can(user, 'procurement'),
      await this.ops.scope(user),
    );
  }
  @Get('batches/:id/movements')
  @CommercePermit('warehouse')
  async movements(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.ops.assertBatch(user, id);
    return this.admin.movements(id);
  }
  @Post('stock')
  @CommercePermit('warehouse')
  async stockIn(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(pipe(commerceStockInSchema)) body: CommerceStockInInput,
  ) {
    await this.ops.assertWarehouse(user, body.warehouseId);
    const b = await this.admin.openingStock(
      body,
      user.id,
      `in:${requestKey(key)}`,
    );
    return { id: b.id, onHand: b.onHand };
  }
  @Post('batches/:id/adjust')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('warehouse')
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceStockAdjustSchema)) body: CommerceStockAdjustInput,
  ) {
    await this.ops.assertBatch(user, id);
    const { unitCost, supplierId, ...b } = await this.stock.adjust(
      id,
      body,
      user.id,
      `adj:${requestKey(key)}`,
    );
    // Cost and supplier stay with procurement.
    void unitCost;
    void supplierId;
    return b;
  }
  @Post('batches/:id/transfer')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('warehouse')
  async transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceTransferSchema))
    body: Body<typeof commerceTransferSchema>,
  ) {
    await this.ops.assertBatch(user, id);
    await this.ops.assertWarehouse(user, body.toWarehouseId);
    return this.stock.transfer(
      id,
      body.toWarehouseId,
      body.quantity,
      body.note ?? null,
      user.id,
      `trf:${requestKey(key)}`,
    );
  }

  // Delivery & promotions
  @Get('zones')
  zones() {
    return this.admin.zones();
  }
  @Post('zones')
  @CommercePermit('delivery')
  createZone(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceZoneSchema)) body: Body<typeof commerceZoneSchema>,
  ) {
    return this.admin.saveZone(null, body, user.id);
  }
  @Put('zones/:id')
  @CommercePermit('delivery')
  updateZone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceZoneSchema)) body: Body<typeof commerceZoneSchema>,
  ) {
    return this.admin.saveZone(id, body, user.id);
  }
  @Get('coupons')
  coupons() {
    return this.admin.coupons();
  }
  @Post('coupons')
  @CommercePermit('catalog')
  createCoupon(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceCouponSchema)) body: Body<typeof commerceCouponSchema>,
  ) {
    return this.admin.saveCoupon(null, body, user.id);
  }
  @Put('coupons/:id')
  @CommercePermit('catalog')
  updateCoupon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceCouponSchema)) body: Body<typeof commerceCouponSchema>,
  ) {
    return this.admin.saveCoupon(id, body, user.id);
  }

  // Orders
  @Get('orders')
  @CommercePermit('orders')
  @Header('Cache-Control', 'private, no-store')
  orderList(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.admin.orders(q);
  }
  @Get('orders/:id')
  @CommercePermit('orders')
  @Header('Cache-Control', 'private, no-store')
  async order(@Param('id', ParseUUIDPipe) id: string) {
    return toCommerceOrderDto(await this.orders.byId(id), 'STAFF');
  }
  @Get('orders/:id/invoice')
  @CommercePermit('orders')
  @Header('Cache-Control', 'private, no-store')
  invoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.invoice(id);
  }
  @Post('orders/:id/transition')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('orders')
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceTransitionSchema)) body: CommerceTransitionInput,
  ) {
    return this.orders.transition(id, body, 'STAFF', user.id);
  }
  @Get('export/orders')
  @CommercePermit('orders')
  async exportOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
    @Res() res: Response,
  ) {
    const rows = await this.admin.exportOrders(
      q,
      await this.can(user, 'finance'),
    );
    res
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        'attachment; filename="fastque-orders.csv"',
      )
      .setHeader('Cache-Control', 'private, no-store')
      .send(String.fromCharCode(0xfeff) + toCsv(rows));
  }

  // Cash on Delivery
  @Get('cod')
  @CommercePermit('finance')
  @Header('Cache-Control', 'private, no-store')
  cod(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.admin.cod(q);
  }
  @Post('orders/:id/cod')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('finance')
  codEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceCodEntrySchema)) body: CommerceCodEntryInput,
  ) {
    return this.orders.recordCod(id, body, user.id, `cod:${requestKey(key)}`);
  }
  @Post('orders/:id/reconcile')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('finance')
  reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.reconcile(id, user.id);
  }

  // Returns
  @Get('returns')
  @CommercePermit('support')
  returns(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.admin.returns(q);
  }
  @Post('returns/:id')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('support')
  async actOnReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceReturnActionSchema)) body: CommerceReturnActionInput,
  ) {
    if (body.to === 'REFUNDED' && !(await this.can(user, 'finance')))
      throw fail(
        'COMMERCE_FORBIDDEN',
        'Only finance staff can record a refund.',
        HttpStatus.FORBIDDEN,
      );
    return this.orders.actOnReturn(id, body, user.id);
  }

  // Suppliers & procurement
  @Get('suppliers')
  @CommercePermit('procurement')
  suppliers() {
    return this.admin.suppliers();
  }
  @Post('suppliers')
  @CommercePermit('procurement')
  createSupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceSupplierSchema))
    body: Body<typeof commerceSupplierSchema>,
  ) {
    return this.admin.saveSupplier(null, body, user.id);
  }
  @Put('suppliers/:id')
  @CommercePermit('procurement')
  updateSupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceSupplierSchema))
    body: Body<typeof commerceSupplierSchema>,
  ) {
    return this.admin.saveSupplier(id, body, user.id);
  }
  @Put('suppliers/:id/products')
  @CommercePermit('procurement')
  supplierProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceSupplierProductSchema))
    body: Body<typeof commerceSupplierProductSchema>,
  ) {
    return this.admin.saveSupplierProduct(id, body);
  }
  @Post('suppliers/:id/payments')
  @CommercePermit('finance')
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceSupplierPaymentSchema))
    body: Body<typeof commerceSupplierPaymentSchema>,
  ) {
    return this.admin.paySupplier(id, body, user.id, `pay:${requestKey(key)}`);
  }
  @Get('purchase-orders')
  @CommercePermit('procurement')
  purchaseOrders(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.admin.purchaseOrders(q);
  }
  @Post('purchase-orders')
  @CommercePermit('procurement')
  createPo(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commercePoSchema)) body: Body<typeof commercePoSchema>,
  ) {
    return this.admin.createPo(body, user.id);
  }
  @Post('purchase-orders/:id/action')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('procurement')
  async poAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commercePoActionSchema))
    body: Body<typeof commercePoActionSchema>,
  ) {
    if (body.action === 'APPROVE' && !(await this.can(user, 'finance')))
      throw fail(
        'COMMERCE_FORBIDDEN',
        'Only finance staff can approve a purchase order.',
        HttpStatus.FORBIDDEN,
      );
    return this.admin.actOnPo(id, body.action, user.id);
  }
  @Post('purchase-orders/:id/receive')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('warehouse')
  async receive(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceReceiptSchema)) body: CommerceReceiptInput,
  ) {
    const head = await this.prisma.commercePurchaseOrder.findUnique({
      where: { id },
      select: { warehouseId: true },
    });
    if (!head) throw notFound('The purchase order');
    await this.ops.assertWarehouse(user, head.warehouseId);
    const po = await this.admin.receive(
      id,
      body,
      user.id,
      `po:${requestKey(key)}`,
    );
    return { id: po.id, status: po.status };
  }
}
