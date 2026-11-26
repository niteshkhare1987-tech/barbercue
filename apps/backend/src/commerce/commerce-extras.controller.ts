import {
  Body,
  Controller,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import {
  ADMIN_PATHS,
  COMMERCE_PATHS as P,
  Role,
  commerceAuditCountSchema,
  commerceAuditSchema,
  commerceBannerSchema,
  commerceBulkTransitionSchema,
  commerceIdsQuerySchema,
  commerceListQuerySchema,
  commerceListingDetailSchema,
  commerceMetricSchema,
  commercePickupActionSchema,
  commercePickupSchema,
  commercePromotionSchema,
  commercePurchaseRequestSchema,
  commerceQuotationSchema,
  commerceRequestActionSchema,
  commerceReturnPolicySchema,
  commerceReviewModerateSchema,
  commerceReviewSchema,
  commerceSavedBagSchema,
  commerceSupplierCreditSchema,
  commerceSupplierReturnSchema,
  commerceTicketReplySchema,
  commerceTicketSchema,
  commerceTicketStaffSchema,
  commerceWarehouseGrantSchema,
  type AuthenticatedUser,
  type CommerceListQuery,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceAdminService } from './commerce-admin.service';
import { CommerceCatalogService } from './commerce-catalog.service';
import { CommerceEngageService } from './commerce-engage.service';
import { CommerceIntelService } from './commerce-intel.service';
import { CommerceOpsService, toXlsx } from './commerce-ops.service';
import { CommerceOrdersService } from './commerce-orders.service';
import {
  COMMERCE_STAFF_ROLES,
  CommerceEnabledGuard,
  CommercePermissionGuard,
  CommercePermit,
  fail,
  flag,
  notFound,
  permissionsOf,
} from './commerce-support';

const pipe = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) =>
  new ZodValidationPipe(schema);
type Of<T extends z.ZodTypeAny> = z.infer<T>;
const WRITE = { default: { limit: 10, ttl: 60_000 } };
const LOOKUP = { default: { limit: 60, ttl: 60_000 } };
const upload = (megabytes: number) =>
  FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: megabytes * 1024 * 1024, files: 1 },
  });
const tokenSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/) })
  .strict();
type Token = { token: string };
const courierSchema = z
  .object({ courier: z.string().trim().min(2).max(80) })
  .strict();
const applySchema = z
  .object({ apply: z.enum(['true', 'false']).default('false') })
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
function sendPrivate(
  res: Response,
  f: { body: Buffer; mimeType: string },
): void {
  res
    .setHeader('Content-Type', f.mimeType)
    .setHeader('Cache-Control', 'private, no-store')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .send(f.body);
}

@Controller(P.root)
@Public()
@UseGuards(CommerceEnabledGuard)
export class CommercePublicExtrasController {
  constructor(
    private readonly engage: CommerceEngageService,
    private readonly catalog: CommerceCatalogService,
    private readonly orders: CommerceOrdersService,
    private readonly admin: CommerceAdminService,
  ) {}

  @Get('banners')
  @Header('Cache-Control', 'public, max-age=60')
  banners() {
    return this.engage.banners();
  }
  @Get('listings')
  listings(@Query(pipe(commerceIdsQuerySchema)) q: { ids: string }) {
    return this.catalog.byListingIds(q.ids.split(','));
  }
  @Get('products/:id/reviews')
  @Header('Cache-Control', 'public, max-age=60')
  reviews(@Param('id', ParseUUIDPipe) id: string) {
    return this.engage.reviews(id);
  }
  @Get('products/:id/details')
  @Header('Cache-Control', 'public, max-age=60')
  details(@Param('id', ParseUUIDPipe) id: string) {
    return this.engage.productExtras(id);
  }
  @Post('events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(LOOKUP)
  event(
    @Body(pipe(commerceMetricSchema)) body: Of<typeof commerceMetricSchema>,
  ) {
    return this.engage.count(body.metric);
  }

  // Guest order links: the private token is checked on every call.
  @Get('orders/:number/invoice')
  @Throttle(LOOKUP)
  @Header('Cache-Control', 'private, no-store')
  async invoice(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: Token,
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.admin.invoice(o.id);
  }
  @Post('orders/:number/reviews')
  @Throttle(WRITE)
  async review(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: Token,
    @Body(pipe(commerceReviewSchema)) body: Of<typeof commerceReviewSchema>,
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.engage.review(o, body, null);
  }
  @Get('orders/:number/tickets')
  @Throttle(LOOKUP)
  @Header('Cache-Control', 'private, no-store')
  async tickets(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: Token,
  ) {
    return this.engage.ticketsFor(
      await this.orders.forGuest(orderNumber(n), q.token),
    );
  }
  @Post('orders/:number/tickets')
  @Throttle(WRITE)
  async open(
    @Param('number') n: string,
    @Query(pipe(tokenSchema)) q: Token,
    @Body(pipe(commerceTicketSchema)) body: Of<typeof commerceTicketSchema>,
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.engage.openTicket(o, body, null);
  }
  @Post('orders/:number/tickets/:id')
  @Throttle(WRITE)
  async reply(
    @Param('number') n: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(pipe(tokenSchema)) q: Token,
    @Body(pipe(commerceTicketReplySchema)) body: { body: string },
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.engage.customerReply(o, id, body.body, null);
  }
  @Post('orders/:number/returns/:id/photos')
  @Throttle(WRITE)
  @UseInterceptors(upload(5))
  async photo(
    @Param('number') n: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(pipe(tokenSchema)) q: Token,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const o = await this.orders.forGuest(orderNumber(n), q.token);
    return this.engage.addPhoto(o, 'RETURN_PHOTO', file, id, null);
  }
}

@Controller(P.customer)
@Roles(Role.CUSTOMER)
@UseGuards(CommerceEnabledGuard)
export class CommerceCustomerExtrasController {
  constructor(
    private readonly engage: CommerceEngageService,
    private readonly orders: CommerceOrdersService,
    private readonly admin: CommerceAdminService,
  ) {}

  @Get('bag')
  @Header('Cache-Control', 'private, no-store')
  bag(@CurrentUser() user: AuthenticatedUser) {
    return this.engage.bag(user.id);
  }
  @Put('bag')
  @HttpCode(HttpStatus.NO_CONTENT)
  saveBag(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceSavedBagSchema)) body: Of<typeof commerceSavedBagSchema>,
  ) {
    return this.engage.saveBag(user.id, body.items);
  }
  @Get('recommendations')
  @Header('Cache-Control', 'private, no-store')
  recommendations(@CurrentUser() user: AuthenticatedUser) {
    return this.engage.recommendations(user.id);
  }
  @Get('orders/:number/invoice')
  @Header('Cache-Control', 'private, no-store')
  async invoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.admin.invoice(o.id);
  }
  @Post('orders/:number/reviews')
  @Throttle(WRITE)
  async review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Body(pipe(commerceReviewSchema)) body: Of<typeof commerceReviewSchema>,
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.engage.review(o, body, user.id);
  }
  @Get('orders/:number/tickets')
  @Header('Cache-Control', 'private, no-store')
  async tickets(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
  ) {
    return this.engage.ticketsFor(
      await this.orders.forCustomer(user.id, orderNumber(n)),
    );
  }
  @Post('orders/:number/tickets')
  @Throttle(WRITE)
  async open(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Body(pipe(commerceTicketSchema)) body: Of<typeof commerceTicketSchema>,
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.engage.openTicket(o, body, user.id);
  }
  @Post('orders/:number/tickets/:id')
  @Throttle(WRITE)
  async reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceTicketReplySchema)) body: { body: string },
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.engage.customerReply(o, id, body.body, user.id);
  }
  @Post('orders/:number/returns/:id/photos')
  @Throttle(WRITE)
  @UseInterceptors(upload(5))
  async photo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('number') n: string,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const o = await this.orders.forCustomer(user.id, orderNumber(n));
    return this.engage.addPhoto(o, 'RETURN_PHOTO', file, id, user.id);
  }
}

/** Back-office extras. Every route needs an explicit permission, checked on the server. */
@Controller(`${ADMIN_PATHS.admin}/${P.admin}`)
@Roles(...COMMERCE_STAFF_ROLES)
@UseGuards(CommerceEnabledGuard, CommercePermissionGuard)
@CommercePermit('view')
export class CommerceAdminExtrasController {
  constructor(
    private readonly engage: CommerceEngageService,
    private readonly ops: CommerceOpsService,
    private readonly intel: CommerceIntelService,
    private readonly prisma: PrismaService,
  ) {}
  private async can(user: AuthenticatedUser, permission: 'finance') {
    return (await permissionsOf(this.prisma, user)).includes(permission);
  }

  // Reviews and support
  @Get('reviews')
  @CommercePermit('support')
  reviews(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.engage.reviewList(q);
  }
  @Post('reviews/:id')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('support')
  moderate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceReviewModerateSchema))
    body: Of<typeof commerceReviewModerateSchema>,
  ) {
    return this.engage.moderateReview(id, body, user.id);
  }
  @Get('tickets')
  @CommercePermit('support')
  @Header('Cache-Control', 'private, no-store')
  tickets(@Query(pipe(commerceListQuerySchema)) q: CommerceListQuery) {
    return this.engage.tickets(q);
  }
  @Post('tickets/:id')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('support')
  ticket(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceTicketStaffSchema))
    body: Of<typeof commerceTicketStaffSchema>,
  ) {
    return this.engage.staffTicket(id, body, user.id);
  }
  @Get('tickets/:id/suggestion')
  @CommercePermit('support')
  suggestion(@Param('id', ParseUUIDPipe) id: string) {
    if (!flag('FASTQUE_COMMERCE_AI_ENABLED')) throw notFound('This page');
    return this.engage.suggestReply(id);
  }

  // Offers, details, banners, policies
  @Get('promotions')
  promotions() {
    return this.engage.promotions();
  }
  @Post('promotions')
  @CommercePermit('catalog')
  addPromotion(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commercePromotionSchema))
    body: Of<typeof commercePromotionSchema>,
  ) {
    return this.engage.savePromotion(null, body, user.id);
  }
  @Put('promotions/:id')
  @CommercePermit('catalog')
  editPromotion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commercePromotionSchema))
    body: Of<typeof commercePromotionSchema>,
  ) {
    return this.engage.savePromotion(id, body, user.id);
  }
  @Get('listings/:id/detail')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { detail: await this.engage.detail(id) };
  }
  @Put('listings/:id/detail')
  @CommercePermit('catalog')
  saveDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceListingDetailSchema))
    body: Of<typeof commerceListingDetailSchema>,
  ) {
    return this.engage.saveDetail(id, body, user.id);
  }
  @Get('banners')
  banners() {
    return this.engage.allBanners();
  }
  @Post('banners')
  @CommercePermit('catalog')
  addBanner(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceBannerSchema)) body: Of<typeof commerceBannerSchema>,
  ) {
    return this.engage.saveBanner(null, body, user.id);
  }
  @Put('banners/:id')
  @CommercePermit('catalog')
  editBanner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceBannerSchema)) body: Of<typeof commerceBannerSchema>,
  ) {
    return this.engage.saveBanner(id, body, user.id);
  }
  @Get('return-policies')
  policies() {
    return this.engage.policies();
  }
  @Put('return-policies')
  @CommercePermit('settings')
  policy(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceReturnPolicySchema))
    body: Of<typeof commerceReturnPolicySchema>,
  ) {
    return this.engage.savePolicy(body, user.id);
  }

  // Photos
  @Get('orders/:id/files')
  @CommercePermit('orders')
  files(@Param('id', ParseUUIDPipe) id: string) {
    return this.engage.files(id);
  }
  @Get('files/:id')
  @CommercePermit('orders')
  async file(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPrivate(res, await this.engage.file(id));
  }
  @Post('orders/:id/proof')
  @CommercePermit('delivery')
  @UseInterceptors(upload(5))
  async proof(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const o = await this.prisma.commerceOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!o) throw notFound('The order');
    if (!['OUT_FOR_DELIVERY', 'DELIVERED'].includes(o.status))
      throw fail(
        'COMMERCE_PHOTO',
        'Delivery proof can be added once the parcel is out for delivery.',
      );
    return this.engage.addPhoto(o, 'DELIVERY_PROOF', file, null, user.id);
  }

  // Warehouse limits, imports, audits
  @Get('warehouse-grants')
  @CommercePermit('settings')
  warehouseGrants() {
    return this.ops.warehouseGrants();
  }
  @Put('warehouse-grants')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('settings')
  setWarehouseGrants(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceWarehouseGrantSchema))
    body: Of<typeof commerceWarehouseGrantSchema>,
  ) {
    return this.ops.setWarehouseGrants(body, user.id);
  }
  @Post('stock/import')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('warehouse')
  @UseInterceptors(upload(5))
  importStock(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(applySchema)) q: { apply: string },
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.ops.importStock(user, file, q.apply === 'true');
  }
  @Get('audits')
  @CommercePermit('warehouse')
  audits(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.audits(user);
  }
  @Post('audits')
  @CommercePermit('warehouse')
  openAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceAuditSchema)) body: Of<typeof commerceAuditSchema>,
  ) {
    return this.ops.openAudit(body.warehouseId, user);
  }
  @Get('audits/:id')
  @CommercePermit('warehouse')
  audit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.auditSheet(id, user);
  }
  @Put('audits/:id/count')
  @CommercePermit('warehouse')
  count(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceAuditCountSchema))
    body: Of<typeof commerceAuditCountSchema>,
  ) {
    return this.ops.countAudit(id, body, user);
  }
  @Post('audits/:id/approve')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('warehouse')
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.approveAudit(id, user);
  }
  @Post('audits/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('warehouse')
  cancelAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.cancelAudit(id, user);
  }

  // Settlements
  @Get('settlements')
  @CommercePermit('finance')
  settlements() {
    return this.ops.settlements();
  }
  @Post('settlements')
  @CommercePermit('finance')
  @UseInterceptors(upload(5))
  settlement(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(courierSchema)) q: { courier: string },
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.ops.importSettlement(user, q.courier, file);
  }
  @Post('settlements/:id/apply')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('finance')
  applySettlement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.applySettlement(id, user);
  }

  // Orders
  @Post('orders-bulk')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('orders')
  bulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commerceBulkTransitionSchema))
    body: Of<typeof commerceBulkTransitionSchema>,
  ) {
    return this.ops.bulk(body, user);
  }
  @Get('export/orders-xlsx')
  @CommercePermit('orders')
  async exportXlsx(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
    @Res() res: Response,
  ) {
    const rows = await this.ops.exportRows(q, await this.can(user, 'finance'));
    res
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader(
        'Content-Disposition',
        'attachment; filename="fastque-orders.xlsx"',
      )
      .setHeader('Cache-Control', 'private, no-store')
      .send(toXlsx(rows));
  }

  // Procurement
  @Get('purchase-requests')
  @CommercePermit('procurement')
  requests() {
    return this.ops.requests();
  }
  @Post('purchase-requests')
  @CommercePermit('warehouse')
  createRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commercePurchaseRequestSchema))
    body: Of<typeof commercePurchaseRequestSchema>,
  ) {
    return this.ops.createRequest(body, user);
  }
  @Post('purchase-requests/:id/quotations')
  @CommercePermit('procurement')
  quotation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceQuotationSchema))
    body: Of<typeof commerceQuotationSchema>,
  ) {
    return this.ops.quote(id, body);
  }
  @Post('purchase-requests/:id/action')
  @HttpCode(HttpStatus.OK)
  @CommercePermit('procurement')
  async requestAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceRequestActionSchema))
    body: Of<typeof commerceRequestActionSchema>,
  ) {
    if (body.action !== 'ORDER' && !(await this.can(user, 'finance')))
      throw fail(
        'COMMERCE_FORBIDDEN',
        'Only finance staff can decide a purchase request.',
        HttpStatus.FORBIDDEN,
      );
    return this.ops.actOnRequest(id, body.action, body.quotationId, user.id);
  }
  @Get('purchase-orders/:id/document')
  @CommercePermit('procurement')
  poDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.purchaseOrderDocument(id);
  }
  @Get('supplier-returns')
  @CommercePermit('procurement')
  supplierReturns() {
    return this.ops.supplierReturns();
  }
  @Post('supplier-returns')
  @CommercePermit('procurement')
  supplierReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(pipe(commerceSupplierReturnSchema))
    body: Of<typeof commerceSupplierReturnSchema>,
  ) {
    return this.ops.returnToSupplier(body, user, `srt:${requestKey(key)}`);
  }
  @Post('supplier-returns/:id/credit')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('finance')
  credit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commerceSupplierCreditSchema))
    body: Of<typeof commerceSupplierCreditSchema>,
  ) {
    return this.ops.creditSupplierReturn(
      id,
      body.amount,
      body.reference ?? null,
      user.id,
    );
  }

  // Pickups
  @Get('pickups')
  @CommercePermit('delivery')
  pickups(@CurrentUser() user: AuthenticatedUser) {
    return this.ops.pickups(user);
  }
  @Post('pickups')
  @CommercePermit('delivery')
  pickup(
    @CurrentUser() user: AuthenticatedUser,
    @Body(pipe(commercePickupSchema)) body: Of<typeof commercePickupSchema>,
  ) {
    return this.ops.createPickup(body, user);
  }
  @Post('pickups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CommercePermit('delivery')
  pickupAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(pipe(commercePickupActionSchema))
    body: Of<typeof commercePickupActionSchema>,
  ) {
    return this.ops.actOnPickup(id, body.status, user);
  }

  // Forecasts, suggestions, reports
  @Get('forecast')
  @CommercePermit('procurement')
  forecast() {
    if (!flag('FASTQUE_COMMERCE_AI_ENABLED')) throw notFound('This page');
    return this.intel.forecast();
  }
  @Get('price-suggestions')
  @CommercePermit('finance')
  prices() {
    if (!flag('FASTQUE_COMMERCE_AI_ENABLED')) throw notFound('This page');
    return this.intel.priceSuggestions();
  }
  @Get('risk-signals')
  @CommercePermit('support')
  risks() {
    if (!flag('FASTQUE_COMMERCE_AI_ENABLED')) throw notFound('This page');
    return this.intel.riskSignals();
  }
  @Get('reports')
  @Header('Cache-Control', 'private, no-store')
  async reports(
    @CurrentUser() user: AuthenticatedUser,
    @Query(pipe(commerceListQuerySchema)) q: CommerceListQuery,
  ) {
    return this.intel.reports(q, await this.can(user, 'finance'));
  }
  @Get('stock-alerts')
  @CommercePermit('warehouse')
  alerts() {
    return this.intel.stockAlerts();
  }
}
