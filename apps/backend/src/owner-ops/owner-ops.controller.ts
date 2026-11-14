import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  DASHBOARD_PATHS,
  Role,
  billingProfileSchema,
  cancellationAnalyticsQuerySchema,
  contactVisibilitySchema,
  createInShopBookingSchema,
  createInvoiceSchema,
  createQueueCustomerSchema,
  ownerRevenueReportQuerySchema,
  ownerAssistantQuerySchema,
  OWNER_ASSISTANT_QUERY_LIMITS,
  queueSettingsSchema,
  recordInvoicePaymentSchema,
  shopCancelBookingSchema,
  shopRescheduleBookingSchema,
  staffAccessChangeSchema,
  voidInvoiceSchema,
  type AuthenticatedUser,
  type BillingProfileInput,
  type CancellationAnalyticsQuery,
  type ContactVisibilityInput,
  type CreateInShopBookingInput,
  type CreateInvoiceInput,
  type CreateQueueCustomerInput,
  type InvoicePaymentStatus,
  type OwnerRevenueReportQuery,
  type OwnerAssistantQueryInput,
  type OwnerAssistantQueryDto,
  type SalonShareLinksDto,
  type QueueSettingsInput,
  type RecordInvoicePaymentInput,
  type ShopCancelBookingInput,
  type ShopRescheduleBookingInput,
  type StaffAccessChangeInput,
  type VoidInvoiceInput,
  customerInvoiceListQuerySchema,
  type CustomerInvoiceListQuery,
} from '@barbercue/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { QueueService } from '../queue/queue.service';
import { CancellationAnalyticsService } from './cancellation-analytics.service';
import { InvoicesService } from './invoices.service';
import { OwnerOverviewService } from './owner-overview.service';
import {
  buildRevenueExcelXml,
  RevenueReportService,
} from './revenue-report.service';
import { OwnerSearchService } from './owner-search.service';
import { QueueAutoAssignService } from './queue-auto-assign.service';
import { ShopBookingActionsService } from './shop-booking-actions.service';
import { StaffAccessService } from './staff-access.service';
import { StaffWorkService } from './staff-work.service';
import { SalonShareLinksService } from './salon-share-links.service';
import { OwnerAssistantService } from './owner-assistant.service';

const SALON = 'dashboard/salons/:salonId';

/**
 * Shop-side routes added by the owner-operations mission. Route-level @Roles only keeps customers
 * out; every handler's service then re-checks, in the database, that THIS user operates THIS salon
 * in the right capacity (owner-only vs owner-or-barber) - see SalonAccessService.
 */
@Controller()
@Roles(Role.SALON_OWNER, Role.SALON_STAFF, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
export class OwnerOpsController {
  constructor(
    private readonly overview: OwnerOverviewService,
    private readonly revenueReports: RevenueReportService,
    private readonly search: OwnerSearchService,
    private readonly cancellations: CancellationAnalyticsService,
    private readonly bookingActions: ShopBookingActionsService,
    private readonly autoAssign: QueueAutoAssignService,
    private readonly queue: QueueService,
    private readonly staffWork: StaffWorkService,
    private readonly staffAccess: StaffAccessService,
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly realtime: RealtimeGateway,
    private readonly salonShareLinks: SalonShareLinksService,
    private readonly ownerAssistant: OwnerAssistantService,
  ) {}

  // ---------- Overview / search / analytics ----------

  @Get(`${SALON}/share-links`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Header('Cache-Control', 'private, no-store')
  getSalonShareLinks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ): Promise<SalonShareLinksDto> {
    return this.salonShareLinks.getForSalon(user.id, salonId);
  }

  @Get(`${SALON}/overview`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.overview.getOverview(user.id, salonId);
  }

  @Get(`${SALON}/revenue`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  getRevenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.overview.getRevenue(user.id, salonId);
  }

  @Post(`${SALON}/${DASHBOARD_PATHS.assistant}/query`)
  @HttpCode(200)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({
    default: {
      limit: OWNER_ASSISTANT_QUERY_LIMITS.maxRequests,
      ttl: OWNER_ASSISTANT_QUERY_LIMITS.throttleWindowMs,
    },
  })
  queryOwnerInsights(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(ownerAssistantQuerySchema))
    body: OwnerAssistantQueryInput,
  ): Promise<OwnerAssistantQueryDto> {
    return this.ownerAssistant.query(user.id, salonId, body);
  }

  @Get(`${SALON}/revenue/report`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Header('Cache-Control', 'private, no-store')
  getRevenueReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(ownerRevenueReportQuerySchema))
    query: OwnerRevenueReportQuery,
  ) {
    return this.revenueReports.getReport(user.id, salonId, query);
  }

  @Get(`${SALON}/revenue/report.csv`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportRevenueReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(ownerRevenueReportQuerySchema))
    query: OwnerRevenueReportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fastque-revenue-${query.from}-${query.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(
      await this.revenueReports.getCsv(user.id, salonId, query),
    );
  }

  @Get(`${SALON}/revenue/report.excel.xml`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Header('Content-Type', 'application/vnd.ms-excel; charset=utf-8')
  async exportRevenueReportExcel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(ownerRevenueReportQuerySchema))
    query: OwnerRevenueReportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fastque-revenue-${query.from}-${query.to}.xml"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    const report = await this.revenueReports.getReport(user.id, salonId, query);
    return new StreamableFile(buildRevenueExcelXml(report));
  }

  @Get(`${SALON}/search`)
  searchDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query('q') q?: string,
  ) {
    return this.search.search(user.id, salonId, q ?? '');
  }

  @Get(`${SALON}/analytics/cancellations`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  getCancellationAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(cancellationAnalyticsQuerySchema))
    query: CancellationAnalyticsQuery,
  ) {
    return this.cancellations.getAnalytics(user.id, salonId, query);
  }

  // ---------- Bookings ----------

  @Post(`${SALON}/bookings/in-shop`)
  @Idempotent()
  createInShopBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(createInShopBookingSchema))
    body: CreateInShopBookingInput,
    @Req() req: Request,
  ) {
    return this.bookingActions.createInShop(
      user,
      salonId,
      body,
      req.header('Idempotency-Key') ?? randomUUID(),
    );
  }

  @Post(`${SALON}/bookings/:bookingId/cancel`)
  @Idempotent()
  cancelBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body(new ZodValidationPipe(shopCancelBookingSchema))
    body: ShopCancelBookingInput,
  ) {
    return this.bookingActions.cancel(user, salonId, bookingId, body);
  }

  @Post(`${SALON}/bookings/:bookingId/reschedule`)
  @Idempotent()
  rescheduleBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body(new ZodValidationPipe(shopRescheduleBookingSchema))
    body: ShopRescheduleBookingInput,
  ) {
    return this.bookingActions.reschedule(user, salonId, bookingId, body);
  }

  // ---------- Live Queue ----------

  @Post(`${SALON}/queue/customers`)
  @Idempotent()
  addQueueCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(createQueueCustomerSchema))
    body: CreateQueueCustomerInput,
  ) {
    return this.queue.createOperatorEntry(user.id, salonId, body);
  }

  @Post(`${SALON}/queue/auto-assign`)
  autoAssignAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.autoAssign.assignAllWaiting(user.id, salonId);
  }

  @Post(`${SALON}/queue/take-next`)
  takeNext(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.autoAssign.takeNext(user.id, salonId);
  }

  @Get(`${SALON}/queue/settings`)
  getQueueSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.autoAssign.getAutomaticAssignment(user.id, salonId);
  }

  @Patch(`${SALON}/queue/settings`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  setQueueSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(queueSettingsSchema)) body: QueueSettingsInput,
  ) {
    return this.autoAssign.setAutomaticAssignment(
      user.id,
      salonId,
      body.autoAssignEnabled,
    );
  }

  @Post('dashboard/queue-entries/:entryId/auto-assign')
  autoAssignEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.autoAssign.assignOne(user.id, entryId);
  }

  // ---------- Staff ----------

  @Get(`${SALON}/staff/me/work`)
  getMyWork(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.staffWork.getMyWork(user.id, salonId);
  }

  @Post(`${SALON}/staff/:staffId/access/revoke`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  revokeStaffAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Body(new ZodValidationPipe(staffAccessChangeSchema))
    body: StaffAccessChangeInput,
  ) {
    return this.staffAccess.revoke(user.id, salonId, staffId, body);
  }

  @Post(`${SALON}/staff/:staffId/access/restore`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  restoreStaffAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Body(new ZodValidationPipe(staffAccessChangeSchema))
    body: StaffAccessChangeInput,
  ) {
    return this.staffAccess.restore(user.id, salonId, staffId, body);
  }

  // ---------- Contact visibility ----------

  @Patch(`${SALON}/contact-visibility`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  async setContactVisibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(contactVisibilitySchema))
    body: ContactVisibilityInput,
  ) {
    const actor = await this.salonAccess.assertOwnerOrAdminAccess(
      user.id,
      salonId,
    );
    await this.prisma.$transaction([
      this.prisma.salon.update({
        where: { id: salonId },
        data: { showPhoneToCustomers: body.showPhoneToCustomers },
      }),
      this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'SALON_PHONE_VISIBILITY_CHANGED',
          entityType: 'Salon',
          entityId: salonId,
          metadata: { actor, showPhoneToCustomers: body.showPhoneToCustomers },
        },
      }),
    ]);
    this.realtime.emitQueueUpdated(salonId);
    return { showPhoneToCustomers: body.showPhoneToCustomers };
  }

  // ---------- Billing ----------

  @Get(`${SALON}/billing-profile`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  getBillingProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.invoices.getBillingProfile(user.id, salonId);
  }

  @Put(`${SALON}/billing-profile`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  saveBillingProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(billingProfileSchema))
    body: BillingProfileInput,
  ) {
    return this.invoices.saveBillingProfile(user.id, salonId, body);
  }

  @Post(`${SALON}/invoices`)
  @Idempotent()
  async issueInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { invoice, created } = await this.invoices.issue(
      user.id,
      salonId,
      body,
      req.header('Idempotency-Key') ?? undefined,
    );
    res.status(created ? 201 : 200);
    return invoice;
  }

  @Get(`${SALON}/invoices`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  listInvoices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query('payment') payment?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const allowed = [
      'ALL',
      'UNPAID',
      'PARTIALLY_PAID',
      'PAID',
      'REFUNDED',
      'VOID',
    ];
    return this.invoices.list(user.id, salonId, {
      payment:
        payment && allowed.includes(payment)
          ? (payment as InvoicePaymentStatus | 'ALL')
          : 'ALL',
      q,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(`${SALON}/payments`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  listPayments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.invoices.listPayments(user.id, salonId, {
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(`${SALON}/invoices/by-source`)
  invoiceBySource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query('bookingId') bookingId?: string,
    @Query('queueEntryId') queueEntryId?: string,
  ) {
    const parsed = createInvoiceSchema.parse({ bookingId, queueEntryId });
    return this.invoices.getForSource(user.id, salonId, parsed);
  }

  @Get(`${SALON}/invoices/:invoiceId`)
  getInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.get(user.id, salonId, invoiceId);
  }

  @Get(`${SALON}/invoices/:invoiceId/pdf`)
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'private, no-store')
  async invoicePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { buffer, filename } = await this.invoices.pdf(
      user.id,
      salonId,
      invoiceId,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer);
  }

  @Post(`${SALON}/invoices/:invoiceId/payments`)
  @Idempotent()
  recordInvoicePayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body(new ZodValidationPipe(recordInvoicePaymentSchema))
    body: RecordInvoicePaymentInput,
    @Req() req: Request,
  ) {
    return this.invoices.recordPayment(
      user.id,
      salonId,
      invoiceId,
      body,
      req.header('Idempotency-Key') ?? undefined,
    );
  }

  @Post(`${SALON}/invoices/:invoiceId/void`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  @Idempotent()
  voidInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body(new ZodValidationPipe(voidInvoiceSchema)) body: VoidInvoiceInput,
  ) {
    return this.invoices.voidInvoice(user.id, salonId, invoiceId, body);
  }
}

/** A customer's own invoices. No @Roles: any signed-in user, but every query is `customerId = me`. */
@Controller('invoices/mine')
export class CustomerInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(customerInvoiceListQuerySchema))
    query: CustomerInvoiceListQuery,
    @Query('limit') limit?: string,
  ) {
    const { cursor, from, to, salonId, q } = query;
    return this.invoices.listMine(
      user.id,
      cursor,
      limit ? Number(limit) : undefined,
      { from, to, salonId, q },
    );
  }

  @Get(':invoiceId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.invoices.getMine(user.id, invoiceId);
  }

  @Get(':invoiceId/pdf')
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'private, no-store')
  async pdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { buffer, filename } = await this.invoices.pdfMine(
      user.id,
      invoiceId,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer);
  }
}
