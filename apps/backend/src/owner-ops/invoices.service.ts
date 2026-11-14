import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingStatus,
  InvoicePaymentKind,
  InvoiceStatus,
  InvoiceTaxMode,
  OwnerOpsErrorCode,
  QueueEntryStatus,
  ServiceSessionStatus,
  computeInvoiceTotals,
  decimalStringToPaise,
  deriveInvoicePaymentStatus,
  formatInvoiceNumber,
  paiseToRupees,
  type BillingProfileDto,
  type BillingProfileInput,
  type CreateInvoiceInput,
  type CustomerInvoiceListQuery,
  dayRangeBounds,
  type InvoiceDetailDto,
  type InvoiceLineInput,
  type InvoiceListDto,
  type InvoicePaymentStatus,
  type InvoiceSummaryDto,
  type RecordInvoicePaymentInput,
  type RecordedPaymentListDto,
  type VoidInvoiceInput,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import {
  addZonedCalendarDays,
  resolveSalonTimeZone,
  zonedWallTimeToUtc,
} from '../common/timezone/timezone';
import { todayLocal } from './local-time';
import { resolveEffectiveBookingServices } from '../bookings/effective-booking-services';
import { renderInvoicePdf } from './invoice-pdf';

const TX = { timeout: 15_000 };

const invoiceInclude = {
  lines: { orderBy: { sortOrder: 'asc' as const } },
  payments: { orderBy: { recordedAt: 'asc' as const } },
  salon: {
    select: {
      name: true,
      timezone: true,
      city: { select: { countryCode: true } },
    },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceWithAll = Prisma.InvoiceGetPayload<{
  include: typeof invoiceInclude;
}>;

/**
 * Invoices and shop-recorded payments.
 *
 * Trust model, stated plainly because money is involved:
 *  - amounts come ONLY from server-side records (the booking's own price snapshots and its
 *    snapshotted online discount / credits, or the completed service's listed price) - never from a
 *    client-supplied number;
 *  - an invoice is issued explicitly by an operator for a COMPLETED visit (never automatically, never
 *    back-filled for old visits), at most one ISSUED invoice per visit (partial unique indexes make
 *    that a database guarantee), numbered from an atomic per-shop sequence inside the same
 *    transaction that inserts the invoice, so a failed issuance leaves no gap and a retry cannot
 *    duplicate;
 *  - "paid" means ONLY that the shop recorded a payment (who/when/how). Showing a payment QR proves
 *    nothing and nothing here treats it as proof; the payment ledger is append-only (a trigger makes
 *    UPDATE/DELETE impossible - a correction is a REFUND row) and an issued invoice's amounts are
 *    frozen by trigger;
 *  - tax is applied only when the owner configured it (enabled + a rate); no GSTIN is ever invented.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
  ) {}

  // ---------- Billing profile ----------

  async getBillingProfile(
    userId: string,
    salonId: string,
  ): Promise<BillingProfileDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const profile = await this.prisma.salonBillingProfile.findUnique({
      where: { salonId },
    });
    return this.toProfileDto(salonId, profile);
  }

  async saveBillingProfile(
    userId: string,
    salonId: string,
    input: BillingProfileInput,
  ): Promise<BillingProfileDto> {
    const actor = await this.salonAccess.assertOwnerOrAdminAccess(
      userId,
      salonId,
    );
    const data = {
      legalName: input.legalName,
      billingAddress: input.billingAddress ?? null,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ? input.contactEmail : null,
      gstin: input.gstin ?? null,
      taxEnabled: input.taxEnabled,
      taxLabel: input.taxLabel,
      taxRateBps:
        input.taxRatePercent === undefined
          ? null
          : Math.round(input.taxRatePercent * 100),
      taxMode: input.taxMode,
      invoicePrefix: input.invoicePrefix,
    };
    const saved = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.salonBillingProfile.upsert({
        where: { salonId },
        create: { salonId, ...data },
        update: data,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'BILLING_PROFILE_SAVED',
          entityType: 'Salon',
          entityId: salonId,
          metadata: {
            actor,
            taxEnabled: data.taxEnabled,
            taxRateBps: data.taxRateBps,
            taxMode: data.taxMode,
            hasGstin: Boolean(data.gstin),
          },
        },
      });
      return profile;
    });
    return this.toProfileDto(salonId, saved);
  }

  // ---------- Issue ----------

  async issue(
    userId: string,
    salonId: string,
    input: CreateInvoiceInput,
    idempotencyKey?: string,
  ): Promise<{ invoice: InvoiceDetailDto; created: boolean }> {
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);

    const existing = await this.findIssuedForSource(salonId, input);
    if (existing) return { invoice: this.toDetail(existing), created: false };

    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: {
        name: true,
        currency: true,
        city: { select: { countryCode: true } },
      },
    });
    if (!salon) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Shop not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const currency =
      salon.currency ?? (salon.city.countryCode === 'IN' ? 'INR' : null);
    if (!currency) {
      throw new AppException(
        OwnerOpsErrorCode.BILLING_PROFILE_REQUIRED,
        'Set your shop’s currency before issuing invoices.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const profile = await this.prisma.salonBillingProfile.findUnique({
      where: { salonId },
    });
    if (!profile?.legalName) {
      throw new AppException(
        OwnerOpsErrorCode.BILLING_PROFILE_REQUIRED,
        'Add your business name in Billing settings before issuing invoices.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (profile.taxEnabled && profile.taxRateBps === null) {
      throw new AppException(
        OwnerOpsErrorCode.BILLING_TAX_NOT_CONFIGURED,
        'Tax is turned on but no rate is set. Update your Billing settings.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const source = input.bookingId
      ? await this.loadBookingSource(salonId, input.bookingId)
      : await this.loadQueueSource(salonId, input.queueEntryId!);

    const totals = computeInvoiceTotals(source.lines, {
      enabled: profile.taxEnabled,
      rateBps: profile.taxRateBps,
      mode: profile.taxMode,
    });

    try {
      const invoiceId = await this.prisma.$transaction(async (tx) => {
        // Atomic per-shop sequence: the increment and the invoice insert commit (or roll back)
        // together, so numbers are consecutive and a duplicate attempt consumes none.
        const bumped = await tx.salonBillingProfile.update({
          where: { salonId },
          data: { nextInvoiceSequence: { increment: 1 } },
          select: { nextInvoiceSequence: true, invoicePrefix: true },
        });
        const sequence = bumped.nextInvoiceSequence - 1;
        const created = await tx.invoice.create({
          data: {
            salonId,
            sequence,
            number: formatInvoiceNumber(bumped.invoicePrefix, sequence),
            sourceType: source.sourceType,
            bookingId: source.bookingId,
            queueEntryId: source.queueEntryId,
            customerId: source.customerId,
            customerName: source.customerName,
            customerPhone: source.customerPhone,
            staffName: source.staffName,
            currency,
            subtotal: paiseToDecimal(totals.subtotalPaise),
            discountTotal: paiseToDecimal(totals.discountTotalPaise),
            taxTotal: paiseToDecimal(totals.taxTotalPaise),
            total: paiseToDecimal(totals.totalPaise),
            taxLabel: profile.taxEnabled ? profile.taxLabel : null,
            taxRateBps: profile.taxEnabled ? profile.taxRateBps : null,
            taxMode: profile.taxEnabled ? profile.taxMode : null,
            sellerLegalName: profile.legalName!,
            sellerGstin: profile.gstin,
            sellerAddress: profile.billingAddress,
            sellerPhone: profile.contactPhone,
            sellerEmail: profile.contactEmail,
            serviceDate: source.serviceDate,
            issuedByUserId: userId,
            idempotencyKey: idempotencyKey ?? null,
            lines: {
              create: source.lines.map((line, index) => ({
                serviceId: source.serviceIds[index] ?? null,
                description: line.description,
                quantity: line.quantity,
                unitPrice: paiseToDecimal(line.unitPricePaise),
                discount: paiseToDecimal(line.discountPaise),
                lineTotal: paiseToDecimal(totals.lines[index].lineTotalPaise),
                sortOrder: index,
              })),
            },
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVOICE_ISSUED',
            entityType: 'Invoice',
            entityId: created.id,
            metadata: {
              salonId,
              number: created.number,
              sourceType: source.sourceType,
              sourceId: source.bookingId ?? source.queueEntryId,
              totalPaise: totals.totalPaise,
              taxTotalPaise: totals.taxTotalPaise,
            },
          },
        });
        return created.id;
      }, TX);
      return {
        invoice: await this.getDetailInternal(salonId, invoiceId),
        created: true,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // A concurrent identical request (a double-click, a retry with a fresh key) won the race:
        // report the invoice it created instead of failing or duplicating.
        const winner = await this.findIssuedForSource(salonId, input);
        if (winner) return { invoice: this.toDetail(winner), created: false };
      }
      throw err;
    }
  }

  // ---------- Payments ----------

  async recordPayment(
    userId: string,
    salonId: string,
    invoiceId: string,
    input: RecordInvoicePaymentInput,
    idempotencyKey?: string,
  ): Promise<InvoiceDetailDto> {
    // Receiving money at the counter is a normal staff action; refunding is not.
    const actor =
      input.kind === InvoicePaymentKind.REFUND
        ? await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId)
        : await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);
    const amountPaise = decimalStringToPaise(input.amount.toFixed(2));

    try {
      await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent payments on one invoice so the overpayment guard cannot be raced.
        await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} AND "salonId" = ${salonId} FOR UPDATE`;
        const invoice = await tx.invoice.findFirst({
          where: { id: invoiceId, salonId },
          include: { payments: true },
        });
        if (!invoice) {
          throw new AppException(
            OwnerOpsErrorCode.INVOICE_NOT_FOUND,
            'Invoice not found.',
            HttpStatus.NOT_FOUND,
          );
        }
        if (invoice.status === InvoiceStatus.VOID) {
          throw new AppException(
            OwnerOpsErrorCode.INVOICE_VOID,
            'This invoice has been voided.',
            HttpStatus.CONFLICT,
          );
        }
        const { paidPaise, refundedPaise } = sumPayments(invoice.payments);
        const totalPaise = decimalStringToPaise(invoice.total.toString());
        if (input.kind === InvoicePaymentKind.PAYMENT) {
          if (paidPaise - refundedPaise + amountPaise > totalPaise) {
            throw new AppException(
              OwnerOpsErrorCode.INVOICE_OVERPAYMENT,
              'That payment is more than the balance due on this invoice.',
              HttpStatus.CONFLICT,
            );
          }
        } else if (amountPaise > paidPaise - refundedPaise) {
          throw new AppException(
            OwnerOpsErrorCode.INVOICE_REFUND_EXCEEDS_PAID,
            'A refund cannot be more than what has been received.',
            HttpStatus.CONFLICT,
          );
        }
        const payment = await tx.invoicePayment.create({
          data: {
            invoiceId,
            salonId,
            kind: input.kind,
            method: input.method,
            amount: paiseToDecimal(amountPaise),
            reference: input.reference ?? null,
            note: input.note ?? null,
            recordedByUserId: userId,
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action:
              input.kind === InvoicePaymentKind.REFUND
                ? 'INVOICE_REFUND_RECORDED'
                : 'INVOICE_PAYMENT_RECORDED',
            entityType: 'Invoice',
            entityId: invoiceId,
            metadata: {
              salonId,
              paymentId: payment.id,
              method: input.method,
              amountPaise,
              actor,
            },
          },
        });
      }, TX);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        idempotencyKey
      ) {
        // The same request key was already applied: this is a replay - return the current state.
        const prior = await this.prisma.invoicePayment.findUnique({
          where: { idempotencyKey },
        });
        if (prior && prior.invoiceId === invoiceId)
          return this.getDetailInternal(salonId, invoiceId);
      }
      throw err;
    }
    return this.getDetailInternal(salonId, invoiceId);
  }

  async voidInvoice(
    userId: string,
    salonId: string,
    invoiceId: string,
    input: VoidInvoiceInput,
  ): Promise<InvoiceDetailDto> {
    const actor = await this.salonAccess.assertOwnerOrAdminAccess(
      userId,
      salonId,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} AND "salonId" = ${salonId} FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, salonId },
        include: { payments: true },
      });
      if (!invoice) {
        throw new AppException(
          OwnerOpsErrorCode.INVOICE_NOT_FOUND,
          'Invoice not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (invoice.status === InvoiceStatus.VOID) return; // idempotent
      const { paidPaise, refundedPaise } = sumPayments(invoice.payments);
      if (paidPaise - refundedPaise > 0) {
        throw new AppException(
          OwnerOpsErrorCode.INVOICE_REFUND_EXCEEDS_PAID,
          'Refund the payments recorded on this invoice before voiding it.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: InvoiceStatus.VOID,
          voidedAt: new Date(),
          voidedByUserId: userId,
          voidReason: input.reason,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'INVOICE_VOIDED',
          entityType: 'Invoice',
          entityId: invoiceId,
          metadata: {
            salonId,
            number: invoice.number,
            reason: input.reason,
            actor,
          },
        },
      });
    }, TX);
    return this.getDetailInternal(salonId, invoiceId);
  }

  // ---------- Reads (shop side) ----------

  async get(
    userId: string,
    salonId: string,
    invoiceId: string,
  ): Promise<InvoiceDetailDto> {
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);
    return this.getDetailInternal(salonId, invoiceId);
  }

  async getForSource(
    userId: string,
    salonId: string,
    input: CreateInvoiceInput,
  ): Promise<InvoiceDetailDto | null> {
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);
    const invoice = await this.findIssuedForSource(salonId, input);
    return invoice ? this.toDetail(invoice) : null;
  }

  async list(
    userId: string,
    salonId: string,
    query: {
      payment?: InvoicePaymentStatus | 'ALL';
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<InvoiceListDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const payment =
      query.payment && query.payment !== 'ALL' ? query.payment : null;
    const q = query.q?.trim();
    const items: InvoiceSummaryDto[] = [];
    let cursor = query.cursor;
    let exhausted = false;
    // The payment status is derived from the ledger, so it is filtered after loading; scan bounded
    // keyset pages until a full page of matches is collected (never silently truncating history).
    for (
      let scan = 0;
      scan < 10 && items.length < limit + 1 && !exhausted;
      scan++
    ) {
      const rows = await this.prisma.invoice.findMany({
        where: {
          salonId,
          ...(payment === 'VOID' ? { status: InvoiceStatus.VOID } : {}),
          ...(q
            ? {
                OR: [
                  { number: { contains: q, mode: 'insensitive' } },
                  { customerName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        include: invoiceInclude,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length < 50) exhausted = true;
      for (const row of rows) {
        cursor = row.id;
        const summary = this.toSummary(row);
        if (payment && summary.paymentStatus !== payment) continue;
        items.push(summary);
        if (items.length >= limit + 1) break;
      }
    }
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * The shop's payment ledger for a salon-local date range (default: the last 30 days): every payment
   * and refund the shop recorded, with totals. Windowed and paged; only the owner (or a delegated
   * admin) may read it, and every row is salon-scoped in the WHERE clause.
   */
  async listPayments(
    userId: string,
    salonId: string,
    query: { from?: string; to?: string; cursor?: string; limit?: number },
  ): Promise<RecordedPaymentListDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: {
        currency: true,
        timezone: true,
        city: { select: { countryCode: true } },
      },
    });
    if (!salon) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Shop not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const timeZone =
      resolveSalonTimeZone({
        timezone: salon.timezone,
        countryCode: salon.city.countryCode,
      }) ?? 'UTC';
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const today = todayLocal(timeZone);
    const toDate = query.to && datePattern.test(query.to) ? query.to : today;
    const fromDate =
      query.from && datePattern.test(query.from)
        ? query.from
        : addZonedCalendarDays(toDate, -29);
    const start =
      zonedWallTimeToUtc(fromDate, '00:00', timeZone) ?? new Date(0);
    const end =
      zonedWallTimeToUtc(addZonedCalendarDays(toDate, 1), '00:00', timeZone) ??
      new Date();
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const where = { salonId, recordedAt: { gte: start, lt: end } };

    const [rows, grouped] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where,
        include: { invoice: { select: { number: true, customerName: true } } },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.prisma.invoicePayment.groupBy({
        by: ['kind', 'method'],
        where,
        _sum: { amount: true },
      }),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const recorders = await this.prisma.salonStaff.findMany({
      where: {
        salonId,
        userId: { in: [...new Set(page.map((p) => p.recordedByUserId))] },
      },
      select: { userId: true, displayName: true },
    });
    const nameByUser = new Map(recorders.map((r) => [r.userId, r.displayName]));

    let received = 0;
    let refunded = 0;
    const methodNet = new Map<string, number>();
    for (const g of grouped) {
      const paise = decimalStringToPaise((g._sum.amount ?? 0).toString());
      if (g.kind === InvoicePaymentKind.REFUND) refunded += paise;
      else received += paise;
      methodNet.set(
        g.method,
        (methodNet.get(g.method) ?? 0) +
          (g.kind === InvoicePaymentKind.REFUND ? -paise : paise),
      );
    }
    const count = await this.prisma.invoicePayment.count({ where });
    return {
      from: fromDate,
      to: toDate,
      currency:
        salon.currency ?? (salon.city.countryCode === 'IN' ? 'INR' : null),
      items: page.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        invoiceNumber: p.invoice.number,
        customerName: p.invoice.customerName,
        kind: p.kind,
        method: p.method,
        amount: Number(p.amount),
        reference: p.reference,
        note: p.note,
        recordedAt: p.recordedAt.toISOString(),
        recordedBy: nameByUser.get(p.recordedByUserId) ?? 'Owner',
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      totals: {
        received: paiseToRupees(received),
        refunded: paiseToRupees(refunded),
        net: paiseToRupees(received - refunded),
        count,
      },
      byMethod: [...methodNet.entries()].map(([method, net]) => ({
        method: method as RecordedPaymentListDto['byMethod'][number]['method'],
        net: paiseToRupees(net),
      })),
    };
  }

  async pdf(
    userId: string,
    salonId: string,
    invoiceId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    await this.salonAccess.assertAccessOrAdminAccess(userId, salonId);
    return this.renderPdf(await this.loadWithSalon(salonId, invoiceId));
  }

  // ---------- Reads (customer side) ----------

  async listMine(
    userId: string,
    cursor: string | undefined,
    limit = 20,
    filters: Omit<CustomerInvoiceListQuery, 'cursor' | 'paymentStatus'> = {},
  ): Promise<InvoiceListDto> {
    const take = Math.min(Math.max(limit, 1), 50);
    const issuedAt = dayRangeBounds(filters.from, filters.to);
    const rows = await this.prisma.invoice.findMany({
      where: {
        customerId: userId,
        status: InvoiceStatus.ISSUED,
        ...(issuedAt.gte || issuedAt.lt ? { issuedAt } : {}),
        ...(filters.salonId ? { salonId: filters.salonId } : {}),
        ...(filters.q
          ? { number: { contains: filters.q, mode: 'insensitive' as const } }
          : {}),
      },
      include: invoiceInclude,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.toSummary(r)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async getMine(userId: string, invoiceId: string): Promise<InvoiceDetailDto> {
    return this.toDetail(await this.loadMine(userId, invoiceId));
  }

  async pdfMine(
    userId: string,
    invoiceId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.renderPdf(await this.loadMine(userId, invoiceId));
  }

  // ---------- internals ----------

  private async loadMine(
    userId: string,
    invoiceId: string,
  ): Promise<InvoiceWithAll> {
    // Ownership is part of the WHERE: another customer's invoice is indistinguishable from a
    // missing one, so ids can never be probed.
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        customerId: userId,
        status: InvoiceStatus.ISSUED,
      },
      include: invoiceInclude,
    });
    if (!invoice) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Invoice not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return invoice;
  }

  private async loadWithSalon(
    salonId: string,
    invoiceId: string,
  ): Promise<InvoiceWithAll> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, salonId },
      include: invoiceInclude,
    });
    if (!invoice) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Invoice not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return invoice;
  }

  private async getDetailInternal(
    salonId: string,
    invoiceId: string,
  ): Promise<InvoiceDetailDto> {
    return this.toDetail(await this.loadWithSalon(salonId, invoiceId));
  }

  private renderPdf(invoice: InvoiceWithAll): {
    buffer: Buffer;
    filename: string;
  } {
    const detail = this.toDetail(invoice);
    const timeZone = resolveSalonTimeZone({
      timezone: invoice.salon.timezone,
      countryCode: invoice.salon.city.countryCode,
    });
    return {
      buffer: renderInvoicePdf(detail, { timeZone }),
      filename: `${invoice.number}.pdf`,
    };
  }

  private findIssuedForSource(
    salonId: string,
    input: CreateInvoiceInput,
  ): Promise<InvoiceWithAll | null> {
    return this.prisma.invoice.findFirst({
      where: {
        salonId,
        status: InvoiceStatus.ISSUED,
        ...(input.bookingId
          ? { bookingId: input.bookingId }
          : { queueEntryId: input.queueEntryId }),
      },
      include: invoiceInclude,
    });
  }

  private async loadBookingSource(salonId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, salonId },
      include: {
        service: { select: { name: true, durationMinutes: true, price: true } },
        services: { orderBy: { sortOrder: 'asc' } },
        customer: { select: { phone: true } },
        preferredStaff: { select: { displayName: true } },
        queueEntries: {
          take: 1,
          select: {
            assignedStaff: { select: { displayName: true } },
            serviceSessions: {
              where: { status: ServiceSessionStatus.COMPLETED },
              orderBy: { endedAt: 'desc' },
              take: 1,
              select: { staff: { select: { displayName: true } } },
            },
          },
        },
      },
    });
    if (!booking) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_SOURCE_NOT_BILLABLE,
        'Only a completed service can be invoiced.',
        HttpStatus.CONFLICT,
      );
    }
    const services = resolveEffectiveBookingServices(booking);
    const unit = services.map((s) => decimalStringToPaise(s.price.toString()));
    const gross = unit.reduce((a, b) => a + b, 0);
    // Booking-level reductions that the customer was actually promised, snapshotted at booking time.
    const reductionPaise = Math.min(
      gross,
      decimalStringToPaise(booking.onlineBookingDiscountAmount.toString()) +
        (booking.creditsRedeemedAmount
          ? decimalStringToPaise(booking.creditsRedeemedAmount.toString())
          : 0),
    );
    const discounts = allocateProportionally(unit, reductionPaise);
    const lines: InvoiceLineInput[] = services.map((s, i) => ({
      description: s.serviceName,
      unitPricePaise: unit[i],
      quantity: 1,
      discountPaise: discounts[i],
    }));
    const performer =
      booking.queueEntries[0]?.serviceSessions[0]?.staff.displayName;
    return {
      sourceType: 'BOOKING' as const,
      bookingId: booking.id,
      queueEntryId: null,
      customerId: booking.customerId,
      customerName: booking.guestName,
      customerPhone: booking.guestPhone ?? booking.customer?.phone ?? null,
      staffName:
        performer ??
        booking.queueEntries[0]?.assignedStaff?.displayName ??
        booking.preferredStaff?.displayName ??
        null,
      serviceDate: booking.slotStart,
      lines,
      serviceIds: services.map((s) => s.serviceId),
    };
  }

  private async loadQueueSource(salonId: string, queueEntryId: string) {
    const entry = await this.prisma.queueEntry.findFirst({
      where: { id: queueEntryId, salonId },
      include: {
        customer: { select: { phone: true } },
        serviceSessions: {
          where: { status: ServiceSessionStatus.COMPLETED },
          orderBy: { endedAt: 'desc' },
          take: 1,
          include: {
            service: { select: { id: true, name: true, price: true } },
            staff: { select: { displayName: true } },
          },
        },
      },
    });
    if (!entry) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_NOT_FOUND,
        'Live Queue visit not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (entry.bookingId) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_SOURCE_NOT_BILLABLE,
        'This visit belongs to a booking. Invoice the booking instead.',
        HttpStatus.CONFLICT,
      );
    }
    const session = entry.serviceSessions[0];
    if (entry.status !== QueueEntryStatus.COMPLETED || !session) {
      throw new AppException(
        OwnerOpsErrorCode.INVOICE_SOURCE_NOT_BILLABLE,
        'Only a completed service can be invoiced.',
        HttpStatus.CONFLICT,
      );
    }
    const lines: InvoiceLineInput[] = [
      {
        description: session.service.name,
        // The listed price at invoice time: a walk-in visit has no booking snapshot to read from.
        unitPricePaise: decimalStringToPaise(session.service.price.toString()),
        quantity: 1,
        discountPaise: 0,
      },
    ];
    return {
      sourceType: 'QUEUE_ENTRY' as const,
      bookingId: null,
      queueEntryId: entry.id,
      customerId: entry.customerId,
      customerName: entry.contactName,
      customerPhone: entry.contactPhone ?? entry.customer?.phone ?? null,
      staffName: session.staff.displayName,
      serviceDate: entry.serviceCompletedAt ?? session.endedAt ?? new Date(),
      lines,
      serviceIds: [session.service.id],
    };
  }

  private toProfileDto(
    salonId: string,
    profile: Prisma.SalonBillingProfileGetPayload<object> | null,
  ): BillingProfileDto {
    return {
      salonId,
      legalName: profile?.legalName ?? null,
      billingAddress: profile?.billingAddress ?? null,
      contactPhone: profile?.contactPhone ?? null,
      contactEmail: profile?.contactEmail ?? null,
      gstin: profile?.gstin ?? null,
      taxEnabled: profile?.taxEnabled ?? false,
      taxLabel: profile?.taxLabel ?? 'GST',
      taxRatePercent:
        profile?.taxRateBps != null ? profile.taxRateBps / 100 : null,
      taxMode: profile?.taxMode ?? InvoiceTaxMode.EXCLUSIVE,
      invoicePrefix: profile?.invoicePrefix ?? 'INV',
      complete: Boolean(profile?.legalName),
    };
  }

  private toSummary(row: InvoiceWithAll): InvoiceSummaryDto {
    const { paidPaise, refundedPaise } = sumPayments(row.payments);
    const totalPaise = decimalStringToPaise(row.total.toString());
    const voided = row.status === InvoiceStatus.VOID;
    return {
      id: row.id,
      number: row.number,
      salonId: row.salonId,
      sourceType: row.sourceType,
      bookingId: row.bookingId,
      queueEntryId: row.queueEntryId,
      customerName: row.customerName,
      currency: row.currency,
      total: paiseToRupees(totalPaise),
      amountPaid: paiseToRupees(paidPaise),
      amountRefunded: paiseToRupees(refundedPaise),
      balanceDue: voided
        ? 0
        : paiseToRupees(Math.max(0, totalPaise - (paidPaise - refundedPaise))),
      paymentStatus: deriveInvoicePaymentStatus({
        voided,
        totalPaise,
        paidPaise,
        refundedPaise,
      }),
      status: row.status,
      salonName: row.salon.name,
      issuedAt: row.issuedAt.toISOString(),
      serviceDate: row.serviceDate.toISOString(),
    };
  }

  private toDetail(row: InvoiceWithAll): InvoiceDetailDto {
    return {
      ...this.toSummary(row),
      salonName: row.salon.name,
      customerPhone: row.customerPhone,
      staffName: row.staffName,
      subtotal: Number(row.subtotal),
      discountTotal: Number(row.discountTotal),
      taxTotal: Number(row.taxTotal),
      taxLabel: row.taxLabel,
      taxRatePercent: row.taxRateBps !== null ? row.taxRateBps / 100 : null,
      taxMode: row.taxMode,
      seller: {
        legalName: row.sellerLegalName,
        gstin: row.sellerGstin,
        address: row.sellerAddress,
        phone: row.sellerPhone,
        email: row.sellerEmail,
      },
      lines: row.lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: Number(l.unitPrice),
        discount: Number(l.discount),
        lineTotal: Number(l.lineTotal),
      })),
      payments: row.payments.map((p) => ({
        id: p.id,
        kind: p.kind,
        method: p.method,
        amount: Number(p.amount),
        reference: p.reference,
        note: p.note,
        recordedAt: p.recordedAt.toISOString(),
      })),
      voidReason: row.voidReason,
    };
  }
}

function paiseToDecimal(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const frac = Math.abs(paise % 100)
    .toString()
    .padStart(2, '0');
  return `${whole}.${frac}`;
}

function sumPayments(payments: { kind: string; amount: Prisma.Decimal }[]): {
  paidPaise: number;
  refundedPaise: number;
} {
  let paidPaise = 0;
  let refundedPaise = 0;
  for (const p of payments) {
    const amount = decimalStringToPaise(p.amount.toString());
    if (p.kind === InvoicePaymentKind.REFUND) refundedPaise += amount;
    else paidPaise += amount;
  }
  return { paidPaise, refundedPaise };
}

/** Splits `total` across `weights` proportionally in whole paise; the remainder goes to the earliest
 * lines so the parts always sum EXACTLY to `total` and no part exceeds its own weight. */
export function allocateProportionally(
  weights: number[],
  total: number,
): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total <= 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((w * total) / sum));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0 && i < parts.length * 2; i++) {
    const idx = i % parts.length;
    if (parts[idx] < weights[idx]) {
      parts[idx] += 1;
      remainder -= 1;
    }
  }
  return parts;
}
