// Owner-operations mission — shared contracts for the Shop Owner / Staff dashboard.
//
// Everything new for this mission lives in this one module (re-exported from ./index) instead of
// being threaded through enums/types/schemas/constants. That keeps the diff reviewable and keeps
// merge conflicts with other long-running branches (which edit those large files) to a minimum.
// Persisted enum values that already exist (BookingSource.WALK_IN, QueueEntrySource.WALK_IN, ...)
// are NOT renamed anywhere: only user-facing labels say "Live Queue".

import { z } from 'zod';
import { normalizeContactName, normalizeContactPhone } from './contact';
import {
  MAX_SERVICES_PER_BOOKING,
  OWNER_ASSISTANT_QUERY_LIMITS,
} from './constants';
import { BookingAttributionSource, BookingSource } from './enums';
import type {
  BookingAttributionSource as BookingAttributionSourceType,
  BookingSource as BookingSourceType,
  BookingStatus,
  QueueEntryStatus,
  StaffMemberStatus,
} from './enums';

// ---------- Enumerations (mirror schema.prisma) ----------

/** Who cancelled a booking. `UNKNOWN` is never persisted — it is how analytics reports a
 * cancellation written before attribution existed. */
export const CancellationActor = {
  CUSTOMER: 'CUSTOMER',
  OWNER: 'OWNER',
  STAFF: 'STAFF',
  SYSTEM: 'SYSTEM',
  ADMIN: 'ADMIN',
} as const;
export type CancellationActor = (typeof CancellationActor)[keyof typeof CancellationActor];
export type CancellationActorOrUnknown = CancellationActor | 'UNKNOWN';
export const CANCELLATION_ACTOR_VALUES: readonly CancellationActorOrUnknown[] = [
  'CUSTOMER',
  'OWNER',
  'STAFF',
  'SYSTEM',
  'ADMIN',
  'UNKNOWN',
];

export const InvoiceStatus = { ISSUED: 'ISSUED', VOID: 'VOID' } as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const InvoiceSourceType = { BOOKING: 'BOOKING', QUEUE_ENTRY: 'QUEUE_ENTRY' } as const;
export type InvoiceSourceType = (typeof InvoiceSourceType)[keyof typeof InvoiceSourceType];

export const InvoiceTaxMode = { EXCLUSIVE: 'EXCLUSIVE', INCLUSIVE: 'INCLUSIVE' } as const;
export type InvoiceTaxMode = (typeof InvoiceTaxMode)[keyof typeof InvoiceTaxMode];

export const InvoicePaymentKind = { PAYMENT: 'PAYMENT', REFUND: 'REFUND' } as const;
export type InvoicePaymentKind = (typeof InvoicePaymentKind)[keyof typeof InvoicePaymentKind];

export const InvoicePaymentMethod = {
  CASH: 'CASH',
  UPI: 'UPI',
  CARD: 'CARD',
  OTHER: 'OTHER',
} as const;
export type InvoicePaymentMethod = (typeof InvoicePaymentMethod)[keyof typeof InvoicePaymentMethod];

/** Derived (never stored): where an invoice stands against the payments the SHOP has recorded. */
export const InvoicePaymentStatus = {
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  REFUNDED: 'REFUNDED',
  VOID: 'VOID',
} as const;
export type InvoicePaymentStatus = (typeof InvoicePaymentStatus)[keyof typeof InvoicePaymentStatus];

export const NotificationDeliveryStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  GAVE_UP: 'GAVE_UP',
  SKIPPED: 'SKIPPED',
} as const;
export type NotificationDeliveryStatus =
  (typeof NotificationDeliveryStatus)[keyof typeof NotificationDeliveryStatus];

export const OwnerOpsErrorCode = {
  // Bookings
  BOOKING_NOT_CANCELLABLE_BY_SHOP: 'BOOKING_NOT_CANCELLABLE_BY_SHOP',
  BOOKING_NOT_YOURS: 'BOOKING_NOT_YOURS',
  IN_SHOP_CONTACT_CONSENT_REQUIRED: 'IN_SHOP_CONTACT_CONSENT_REQUIRED',
  IN_SHOP_DUPLICATE_BOOKING: 'IN_SHOP_DUPLICATE_BOOKING',
  // Live Queue
  NOT_YOUR_SERVICE_SESSION: 'NOT_YOUR_SERVICE_SESSION',
  NO_ELIGIBLE_BARBER: 'NO_ELIGIBLE_BARBER',
  NO_FREE_CHAIR: 'NO_FREE_CHAIR',
  // Assignment vs start of service (corrective mission)
  NOT_YOUR_ASSIGNMENT: 'NOT_YOUR_ASSIGNMENT',
  NOT_ASSIGNED: 'NOT_ASSIGNED',
  ASSIGNMENT_NOT_STARTABLE: 'ASSIGNMENT_NOT_STARTABLE',
  CUSTOMER_NOT_ARRIVED: 'CUSTOMER_NOT_ARRIVED',
  QUEUE_ENTRY_ALREADY_ACTIVE: 'QUEUE_ENTRY_ALREADY_ACTIVE',
  // Staff
  STAFF_ACCESS_REVOKED: 'STAFF_ACCESS_REVOKED',
  STAFF_ACCESS_ALREADY_REVOKED: 'STAFF_ACCESS_ALREADY_REVOKED',
  STAFF_ACCESS_NOT_REVOKED: 'STAFF_ACCESS_NOT_REVOKED',
  // Billing
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  INVOICE_SOURCE_NOT_BILLABLE: 'INVOICE_SOURCE_NOT_BILLABLE',
  INVOICE_ALREADY_ISSUED: 'INVOICE_ALREADY_ISSUED',
  INVOICE_VOID: 'INVOICE_VOID',
  INVOICE_OVERPAYMENT: 'INVOICE_OVERPAYMENT',
  INVOICE_REFUND_EXCEEDS_PAID: 'INVOICE_REFUND_EXCEEDS_PAID',
  BILLING_PROFILE_REQUIRED: 'BILLING_PROFILE_REQUIRED',
  BILLING_TAX_NOT_CONFIGURED: 'BILLING_TAX_NOT_CONFIGURED',
  BOOKING_ATTRIBUTION_CAMPAIGN_NOT_FOUND:
    'BOOKING_ATTRIBUTION_CAMPAIGN_NOT_FOUND',
  OWNER_ASSISTANT_QUERY_UNSUPPORTED: 'OWNER_ASSISTANT_QUERY_UNSUPPORTED',
} as const;
export type OwnerOpsErrorCode = (typeof OwnerOpsErrorCode)[keyof typeof OwnerOpsErrorCode];

// ---------- Route segments (all under `dashboard/salons/:salonId/...` unless noted) ----------

export const OWNER_OPS_PATHS = {
  dashboard: 'dashboard',
  salons: 'salons',
  overview: 'overview',
  search: 'search',
  revenue: 'revenue',
  cancellationAnalytics: 'analytics/cancellations',
  bookingsInShop: 'bookings/in-shop',
  bookings: 'bookings',
  bookingAttribution: 'booking-attribution',
  attributionCampaigns: 'campaigns',
  cancel: 'cancel',
  reschedule: 'reschedule',
  queueCustomers: 'queue/customers',
  queueAutoAssign: 'queue/auto-assign',
  queueTakeNext: 'queue/take-next',
  queueSettings: 'queue/settings',
  queueEntries: 'queue-entries',
  autoAssign: 'auto-assign',
  staff: 'staff',
  staffMeWork: 'staff/me/work',
  staffAccess: 'access',
  invoices: 'invoices',
  invoicesMine: 'invoices/mine',
  billingProfile: 'billing-profile',
  payments: 'payments',
  pdf: 'pdf',
  void: 'void',
  contact: 'contact',
  /** Customer-side (outside `dashboard/`): GET invoices/mine, GET invoices/mine/:id/pdf. */
  customerInvoices: 'invoices/mine',
} as const;

// ---------- Invoice / tax arithmetic (integer paise only — no floats anywhere) ----------

export interface InvoiceLineInput {
  description: string;
  unitPricePaise: number;
  quantity: number;
  /** Absolute discount on this line in paise, never more than unitPricePaise * quantity. */
  discountPaise: number;
}

export interface InvoiceTaxConfig {
  enabled: boolean;
  /** Basis points: 1800 = 18.00%. Ignored when `enabled` is false. */
  rateBps: number | null;
  mode: InvoiceTaxMode;
}

export interface InvoiceTotalsPaise {
  lines: { lineTotalPaise: number }[];
  subtotalPaise: number;
  discountTotalPaise: number;
  taxTotalPaise: number;
  totalPaise: number;
}

export class InvoiceMathError extends Error {}

/**
 * Computes invoice totals from trusted line items.
 *
 *  - subtotal = sum(unit * qty);  discountTotal = sum(line discount)
 *  - tax is applied ONLY when configured (enabled AND a rate): never guessed or defaulted.
 *  - EXCLUSIVE: tax = round-half-up(net * rate / 10000), total = net + tax.
 *  - INCLUSIVE: the listed prices already contain tax — total = net, and the tax component is
 *    extracted: round-half-up(net * rate / (10000 + rate)).
 *  - A line total is its own net (gross - discount); tax is computed on the invoice net (not per
 *    line) so a rounding difference can never make the lines and the footer disagree.
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  tax: InvoiceTaxConfig,
): InvoiceTotalsPaise {
  if (lines.length === 0) throw new InvoiceMathError('An invoice needs at least one line.');
  let subtotalPaise = 0;
  let discountTotalPaise = 0;
  const computed = lines.map((line) => {
    for (const value of [line.unitPricePaise, line.quantity, line.discountPaise]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new InvoiceMathError('Invoice amounts must be non-negative whole paise.');
      }
    }
    if (line.quantity < 1) throw new InvoiceMathError('Quantity must be at least 1.');
    const gross = line.unitPricePaise * line.quantity;
    if (line.discountPaise > gross) {
      throw new InvoiceMathError('A line discount cannot exceed the line amount.');
    }
    subtotalPaise += gross;
    discountTotalPaise += line.discountPaise;
    return { lineTotalPaise: gross - line.discountPaise };
  });

  const netPaise = subtotalPaise - discountTotalPaise;
  let taxTotalPaise = 0;
  let totalPaise = netPaise;
  if (tax.enabled) {
    if (tax.rateBps === null || !Number.isInteger(tax.rateBps) || tax.rateBps < 0 || tax.rateBps > 10000) {
      throw new InvoiceMathError('Tax is enabled but no valid rate is configured.');
    }
    if (tax.mode === InvoiceTaxMode.INCLUSIVE) {
      taxTotalPaise = divRoundHalfUp(netPaise * tax.rateBps, 10000 + tax.rateBps);
    } else {
      taxTotalPaise = divRoundHalfUp(netPaise * tax.rateBps, 10000);
      totalPaise = netPaise + taxTotalPaise;
    }
  }
  return { lines: computed, subtotalPaise, discountTotalPaise, taxTotalPaise, totalPaise };
}

function divRoundHalfUp(numerator: number, denominator: number): number {
  // numerator is a non-negative integer well below 2^53 for any realistic invoice.
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Derives the payment status from shop-recorded amounts (all paise). */
export function deriveInvoicePaymentStatus(input: {
  voided: boolean;
  totalPaise: number;
  paidPaise: number;
  refundedPaise: number;
}): InvoicePaymentStatus {
  if (input.voided) return InvoicePaymentStatus.VOID;
  const net = input.paidPaise - input.refundedPaise;
  if (net <= 0) {
    return input.refundedPaise > 0 ? InvoicePaymentStatus.REFUNDED : InvoicePaymentStatus.UNPAID;
  }
  return net >= input.totalPaise ? InvoicePaymentStatus.PAID : InvoicePaymentStatus.PARTIALLY_PAID;
}

/** Format-only GSTIN check (state code + PAN-shaped body + entity digit + Z + checksum char).
 * It does NOT prove the number is registered — only the GST portal can. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function formatInvoiceNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(6, '0')}`;
}

// ---------- Validation schemas ----------

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

const phoneField = z
  .string()
  .transform((value) => normalizeContactPhone(value))
  .refine((value): value is string => value !== null, {
    message: 'enter a valid mobile number, with a country code if it is not an Indian number',
  });

const nameField = z
  .string()
  .transform((value) => normalizeContactName(value))
  .refine((value): value is string => value !== null, {
    message: 'enter the customer name (2-60 characters)',
  });

/** POST dashboard/salons/:salonId/bookings/:id/cancel */
export const shopCancelBookingSchema = z.object({
  reason: optionalTrimmed(300),
});
export type ShopCancelBookingInput = z.infer<typeof shopCancelBookingSchema>;

/** POST dashboard/salons/:salonId/bookings/:id/reschedule */
export const shopRescheduleBookingSchema = z.object({
  slotStart: z.string().datetime(),
});
export type ShopRescheduleBookingInput = z.infer<typeof shopRescheduleBookingSchema>;

/**
 * POST dashboard/salons/:salonId/bookings/in-shop — an appointment an operator creates for
 * someone who contacted the shop directly. No account is created; a phone is only stored with the
 * customer's consent.
 */
export const createInShopBookingSchema = z
  .object({
    guestName: nameField,
    guestPhone: phoneField.optional(),
    contactConsent: z.boolean().default(false),
    serviceIds: z.array(z.string().uuid()).min(1).max(MAX_SERVICES_PER_BOOKING),
    slotStart: z.string().datetime(),
    preferredStaffId: z.string().uuid().optional(),
    note: optionalTrimmed(500),
  })
  .superRefine((value, ctx) => {
    if (value.guestPhone && !value.contactConsent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contactConsent'],
        message: 'Confirm the customer agreed to be contacted before saving their number.',
      });
    }
  });
export type CreateInShopBookingInput = z.infer<typeof createInShopBookingSchema>;

/** POST dashboard/salons/:salonId/queue/customers — "New Live Queue customer". */
export const createQueueCustomerSchema = z
  .object({
    name: nameField,
    phone: phoneField.optional(),
    contactConsent: z.boolean().default(false),
    serviceId: z.string().uuid().optional(),
    preferredStaffId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.phone && !value.contactConsent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contactConsent'],
        message: 'Confirm the customer agreed to be contacted before saving their number.',
      });
    }
  });
export type CreateQueueCustomerInput = z.infer<typeof createQueueCustomerSchema>;

/** PATCH dashboard/salons/:salonId/queue/settings */
export const queueSettingsSchema = z.object({
  autoAssignEnabled: z.boolean(),
});
export type QueueSettingsInput = z.infer<typeof queueSettingsSchema>;

/** PATCH dashboard/salons/:salonId/contact-visibility — the owner's opt-in to publish the shop phone. */
export const contactVisibilitySchema = z.object({
  showPhoneToCustomers: z.boolean(),
});
export type ContactVisibilityInput = z.infer<typeof contactVisibilitySchema>;

/** POST dashboard/salons/:salonId/staff/:staffId/access/revoke|restore */
export const staffAccessChangeSchema = z.object({
  reason: optionalTrimmed(200),
});
export type StaffAccessChangeInput = z.infer<typeof staffAccessChangeSchema>;

const rupeeAmount = z
  .number()
  .finite()
  .positive()
  .max(1_000_000)
  .refine((value) => Math.round(value * 100) / 100 === value, {
    message: 'amount can have at most 2 decimal places',
  });

/** POST dashboard/salons/:salonId/invoices — exactly one source. */
export const createInvoiceSchema = z
  .object({
    bookingId: z.string().uuid().optional(),
    queueEntryId: z.string().uuid().optional(),
  })
  .refine((value) => Number(Boolean(value.bookingId)) + Number(Boolean(value.queueEntryId)) === 1, {
    message: 'provide exactly one of bookingId or queueEntryId',
  });
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/** POST dashboard/salons/:salonId/invoices/:id/payments — a payment the shop RECEIVED (or refunded). */
export const recordInvoicePaymentSchema = z.object({
  kind: z.enum(['PAYMENT', 'REFUND']).default('PAYMENT'),
  method: z.enum(['CASH', 'UPI', 'CARD', 'OTHER']),
  amount: rupeeAmount,
  reference: optionalTrimmed(80),
  note: optionalTrimmed(200),
});
export type RecordInvoicePaymentInput = z.infer<typeof recordInvoicePaymentSchema>;

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

/** PUT dashboard/salons/:salonId/billing-profile */
export const billingProfileSchema = z
  .object({
    legalName: z.string().trim().min(2).max(160),
    billingAddress: optionalTrimmed(300),
    contactPhone: optionalTrimmed(32),
    contactEmail: z.union([z.literal(''), z.string().trim().email().max(160)]).optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .optional()
      .transform((value) => (value ? value : undefined))
      .refine((value) => value === undefined || GSTIN_PATTERN.test(value), {
        message: 'GSTIN format is invalid (15 characters)',
      }),
    taxEnabled: z.boolean(),
    taxLabel: z.string().trim().min(1).max(20).default('GST'),
    // Percent with up to 2 decimals, e.g. 18 or 5.5. Converted to basis points server-side.
    taxRatePercent: z.number().min(0).max(100).optional(),
    taxMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).default('EXCLUSIVE'),
    invoicePrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,8}$/, 'prefix must be 2-8 letters or digits')
      .default('INV'),
  })
  .superRefine((value, ctx) => {
    if (value.taxEnabled && value.taxRatePercent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taxRatePercent'],
        message: 'Enter the tax rate, or turn tax off.',
      });
    }
    if (value.taxRatePercent !== undefined && Math.round(value.taxRatePercent * 100) / 100 !== value.taxRatePercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taxRatePercent'],
        message: 'rate can have at most 2 decimal places',
      });
    }
  });
export type BillingProfileInput = z.infer<typeof billingProfileSchema>;

/** GET dashboard/salons/:salonId/analytics/cancellations */
export const cancellationAnalyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  range: z.enum(['7d', '30d', '90d']).optional(),
  actor: z.enum(['CUSTOMER', 'OWNER', 'STAFF', 'SYSTEM', 'ADMIN', 'UNKNOWN']).optional(),
  serviceId: z.string().uuid().optional(),
});
export type CancellationAnalyticsQuery = z.infer<typeof cancellationAnalyticsQuerySchema>;

const salonLocalDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a valid salon-local date in YYYY-MM-DD format.');

/** GET dashboard/salons/:salonId/revenue/report. `to` is inclusive in the salon's timezone. */
export const ownerRevenueReportQuerySchema = z
  .object({
    from: salonLocalDateSchema,
    to: salonLocalDateSchema,
    groupBy: z.enum(['day', 'week', 'month']).default('day'),
    /** Direct source is projected from the legacy booking source; external channels require a valid campaign token. */
    // Keep legacy APP/WEB filters accepted for already-shipped clients while exposing the
    // normalized FASTQUE_APP/FASTQUE_WEB attribution vocabulary to new consumers.
    source: z
      .enum([
        'FASTQUE_WEB',
        'FASTQUE_APP',
        'WALK_IN',
        'IN_SHOP',
        'FACEBOOK',
        'INSTAGRAM',
        'CHATGPT',
        'OTHER',
        'UNKNOWN',
        'APP',
        'WEB',
      ])
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end date must be on or after the start date.',
      });
      return;
    }
    const from = Date.parse(`${value.from}T00:00:00.000Z`);
    const to = Date.parse(`${value.to}T00:00:00.000Z`);
    if ((to - from) / 86_400_000 > 365) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'A report may cover at most 366 calendar days.',
      });
    }
  });
export type OwnerRevenueReportQuery = z.infer<
  typeof ownerRevenueReportQuerySchema
>;

const campaignSourceSchema = z.enum([
  'FACEBOOK',
  'INSTAGRAM',
  'CHATGPT',
  'OTHER',
]);

export const createBookingAttributionCampaignSchema = z
  .object({
    source: campaignSourceSchema,
    label: z.string().trim().min(1).max(120),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.startsAt &&
      value.endsAt &&
      Date.parse(value.endsAt) <= Date.parse(value.startsAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Campaign end must be after its start.',
      });
    }
  });
export type CreateBookingAttributionCampaignInput = z.infer<
  typeof createBookingAttributionCampaignSchema
>;

export const bookingAttributionCampaignListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type BookingAttributionCampaignListQuery = z.infer<
  typeof bookingAttributionCampaignListQuerySchema
>;

export const bookingAttributionSummaryQuerySchema = z
  .object({
    from: salonLocalDateSchema,
    to: salonLocalDateSchema,
    source: z.nativeEnum(BookingAttributionSource).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end date must be on or after the start date.',
      });
    }
    const from = Date.parse(`${value.from}T00:00:00.000Z`);
    const to = Date.parse(`${value.to}T00:00:00.000Z`);
    if ((to - from) / 86_400_000 > 365) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'A report may cover at most 366 calendar days.',
      });
    }
  });
export type BookingAttributionSummaryQuery = z.infer<
  typeof bookingAttributionSummaryQuerySchema
>;

export interface BookingAttributionCampaignDto {
  id: string;
  salonId: string;
  source: Extract<
    BookingAttributionSourceType,
    'FACEBOOK' | 'INSTAGRAM' | 'CHATGPT' | 'OTHER'
  >;
  label: string;
  startsAt: string | null;
  endsAt: string | null;
  revokedAt: string | null;
  bookingCount: number;
  createdAt: string;
}

/** The opaque token is returned only once, immediately after campaign creation. */
export interface CreateBookingAttributionCampaignDto extends BookingAttributionCampaignDto {
  token: string;
}

export interface BookingAttributionSourceCountDto {
  source: BookingAttributionSourceType;
  bookingCount: number;
}

export interface BookingAttributionCampaignCountDto {
  campaignId: string;
  source: BookingAttributionCampaignDto['source'];
  label: string;
  bookingCount: number;
}

export interface BookingAttributionSummaryDto {
  salonId: string;
  from: string;
  to: string;
  timezone: string;
  asOf: string;
  bySource: BookingAttributionSourceCountDto[];
  campaigns: BookingAttributionCampaignCountDto[];
}

/**
 * GET dashboard/salons/:salonId/customers. Search is limited to account id, email, and phone;
 * User has no canonical name field, and per-visit guest names are not identity evidence.
 */
export const ownerCustomerListQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    search: z.string().trim().min(1).max(120).optional(),
    /** `q` is the concise URL alias used by dashboard clients; `search` stays backward-compatible. */
    q: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.search && value.q) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['q'],
        message: 'Use either q or search, not both.',
      });
    }
  });
export type OwnerCustomerListQuery = z.infer<typeof ownerCustomerListQuerySchema>;

/**
 * GET dashboard/salons/:salonId/customers/:customerId/history.
 * from/to are inclusive salon-local calendar dates; nextCursor is opaque and scope-bound.
 */
export const ownerCustomerHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    source: z.enum(['ONLINE_BOOKING', 'IN_SHOP_APPOINTMENT', 'LIVE_QUEUE']).optional(),
    status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'WAITING', 'CALLED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW']).optional(),
    from: salonLocalDateSchema.optional(),
    to: salonLocalDateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end date must be on or after the start date.',
      });
      return;
    }
    if (value.from && value.to) {
      const from = Date.parse(`${value.from}T00:00:00.000Z`);
      const to = Date.parse(`${value.to}T00:00:00.000Z`);
      if ((to - from) / 86_400_000 > 365) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['to'],
          message: 'History may cover at most 366 calendar days.',
        });
      }
    }
  });
export type OwnerCustomerHistoryQuery = z.infer<typeof ownerCustomerHistoryQuerySchema>;

/** Additive server-side customer directory; the legacy offset endpoint remains unchanged. */
export const ownerCustomerDirectoryQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().min(1).max(120).optional(),
  segment: z.enum(['new', 'repeat', 'frequent']).optional(),
  sort: z.enum(['lastVisit', 'totalSpent', 'visits']).default('lastVisit'),
  minVisits: z.coerce.number().int().min(0).max(50_000).default(0),
});
export type OwnerCustomerDirectoryQuery = z.infer<typeof ownerCustomerDirectoryQuerySchema>;

/** Stable keyset page for completed service rows in a known salon/customer scope. */
export const ownerCustomerServicesQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type OwnerCustomerServicesQuery = z.infer<typeof ownerCustomerServicesQuerySchema>;

/** Provider-free owner insights accept a bounded, deterministic question only. */
export const ownerAssistantQuerySchema = z
  .object({
    question: z.string().trim().min(2).max(OWNER_ASSISTANT_QUERY_LIMITS.maxQuestionLength),
  })
  .strict();
export type OwnerAssistantQueryInput = z.infer<typeof ownerAssistantQuerySchema>;

// ---------- DTOs ----------

/** Money is always shown in the shop's own currency; `amount` is a decimal number with <= 2 dp. */
export interface MoneyDto {
  amount: number;
  currency: string | null;
}

export interface PeriodComparisonDto {
  current: number;
  previous: number;
  /** null when the previous period had nothing to compare against (never a fabricated 0%/100%). */
  changePercent: number | null;
}

export interface RevenuePointDto {
  /** Salon-local calendar date (YYYY-MM-DD) for daily rows; week start / month start for the others. */
  date: string;
  amount: number;
}

export type OwnerAssistantIntent =
  | 'TODAY_SUMMARY'
  | 'TODAY_RECORDED_AND_ESTIMATED_VALUE'
  | 'APPOINTMENTS_TODAY'
  | 'COMPLETED_SERVICES_TODAY'
  | 'WAITING_QUEUE_NOW'
  | 'IN_SERVICE_NOW'
  | 'AVAILABLE_BARBERS_NOW'
  | 'CANCELLATIONS_TODAY';

export interface OwnerAssistantFigureDto {
  metric:
    | 'appointmentsToday'
    | 'completedServicesToday'
    | 'waitingInQueue'
    | 'inService'
    | 'availableBarbers'
    | 'cancelledToday'
    | 'recordedCollectionsToday'
    | 'estimatedServiceValueToday';
  value: number;
  unit: 'count' | 'money';
  currency: string | null;
  /** True only for a completed service's listed-price estimate; never call it collected revenue. */
  estimated: boolean;
}

export interface OwnerAssistantQueryDto {
  salonId: string;
  mode: 'DETERMINISTIC';
  intent: OwnerAssistantIntent;
  localDate: string;
  timezone: string;
  answer: string;
  figures: OwnerAssistantFigureDto[];
  generatedAt: string;
}

export interface OwnerOverviewKpisDto {
  appointmentsToday: number;
  customersServedToday: number;
  waitingInQueue: number;
  inService: number;
  availableBarbers: number;
  busyBarbers: number;
  activeStaff: number;
  completedServicesToday: number;
  cancelledToday: number;
  /** Shop-recorded payments (net of recorded refunds) received today. */
  recordedRevenueToday: number;
  recordedPaymentsToday: number;
}

export interface OwnerRevenueDto {
  currency: string | null;
  /** false => nothing has ever been recorded; UIs show an honest empty state, not zeros as data. */
  hasRecordedPayments: boolean;
  daily: RevenuePointDto[];
  weekly: RevenuePointDto[];
  monthly: RevenuePointDto[];
  today: PeriodComparisonDto;
  thisWeek: PeriodComparisonDto;
  thisMonth: PeriodComparisonDto;
  /** Listed-price estimate for services completed today. Never presented as revenue. */
  estimatedServiceValueToday: number;
  unpaidInvoiceCount: number;
  unpaidInvoiceTotal: number;
}

export interface OwnerRevenueReportMetricDto {
  completedVisits: number;
  /** Gross completed-service value before invoice discounts; price data is an estimate when no snapshot exists. */
  grossServiceValue: number;
  /** Listed-price estimate, not money received. Standalone queue rows without a price snapshot use the current service list price. */
  estimatedServiceValue: number;
  invoiceCount: number;
  invoiceDiscounts: number;
  /** Issued invoice totals (tax-inclusive), excluding void invoices. */
  invoicedAmount: number;
  /** Append-only shop-recorded PAYMENT events for the cash-event period. */
  recordedCollections: number;
  /** Append-only shop-recorded REFUND events for the cash-event period. */
  refunds: number;
  netRecordedCollections: number;
}

export interface OwnerRevenueReportGroupDto extends OwnerRevenueReportMetricDto {
  key: string;
  label: string;
}

export interface OwnerRevenueReportServiceDto extends OwnerRevenueReportGroupDto {
  serviceId: string | null;
}

export interface OwnerRevenueReportStaffDto extends OwnerRevenueReportGroupDto {
  staffId: string | null;
  /** False when only a text label exists and no completed session links the invoice to staff. */
  identityVerified: boolean;
}

export interface OwnerRevenueReportSourceDto extends OwnerRevenueReportGroupDto {
  /** Where the visits and invoices in this row came from. UNKNOWN means not recorded (old or unattributable); it is never guessed. */
  source: BookingAttributionSourceType;
}

export interface OwnerRevenueReportCustomerDto extends OwnerRevenueReportGroupDto {
  customerId: string | null;
  /** Guest visits remain separate; names or phone numbers are never used to merge identities. */
  identityVerified: boolean;
}

export interface OwnerRevenueReportPeriodDto extends OwnerRevenueReportMetricDto {
  /** Salon-local day, Monday week start, or calendar month start. */
  period: string;
}

export interface OwnerRevenueReportDto {
  salonId: string;
  currency: string | null;
  timeZone: string;
  from: string;
  to: string;
  groupBy: 'day' | 'week' | 'month';
  source: BookingAttributionSourceType | BookingSourceType | null;
  /** Visit and invoice amounts are bucketed by serviceDate; payments/refunds by recordedAt. */
  periods: OwnerRevenueReportPeriodDto[];
  totals: OwnerRevenueReportMetricDto;
  byService: OwnerRevenueReportServiceDto[];
  byStaff: OwnerRevenueReportStaffDto[];
  byCustomer: OwnerRevenueReportCustomerDto[];
  /** Every visit and invoice belongs to exactly one source, so these rows add up to `totals`. */
  bySource: OwnerRevenueReportSourceDto[];
  dataSemantics: {
    estimateBasis: 'BOOKING_PRICE_SNAPSHOT_AND_CURRENT_QUEUE_SERVICE_PRICE';
    cashSource: 'SHOP_RECORDED_INVOICE_PAYMENT_LEDGER';
    serviceCashAllocation: 'PRO_RATA_BY_INVOICE_LINE_TOTAL';
    externalAttribution: 'CAMPAIGN_TOKEN_WHEN_PRESENT_LEGACY_SOURCE_PROJECTION_OTHERWISE';
  };
}

export interface OwnerCustomerHistoryPaymentDto {
  kind: 'PAYMENT' | 'REFUND';
  method: 'CASH' | 'UPI' | 'CARD' | 'OTHER';
  amount: string;
  recordedAt: string;
}

export interface OwnerCustomerHistoryInvoiceDto {
  id: string;
  number: string;
  status: 'ISSUED' | 'VOID';
  currency: string;
  total: string;
  discountTotal: string;
  payments: OwnerCustomerHistoryPaymentDto[];
}

export interface OwnerCustomerHistoryEntryDto {
  id: string;
  source: 'ONLINE_BOOKING' | 'IN_SHOP_APPOINTMENT' | 'LIVE_QUEUE';
  /** Slot start for a booking; salon-local arrival instant for a Live Queue visit. */
  occurredAt: string;
  createdAt: string;
  status: string;
  /** A per-record entered label, never used to link/merge customer identities. */
  recordedName: string | null;
  serviceNames: string[];
  staffName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Shop-recorded invoice/payment facts only; no provider settlement is inferred. */
  invoices: OwnerCustomerHistoryInvoiceDto[];
}

export interface OwnerCustomerHistoryPageDto {
  salonId: string;
  customerId: string;
  salonTimezone: string;
  items: OwnerCustomerHistoryEntryDto[];
  nextCursor: string | null;
}

export interface OwnerTopServiceDto {
  serviceId: string | null;
  name: string;
  completedCount: number;
  /** Mean of trusted charged amounts (invoice line totals) where invoices exist; else null. */
  averageChargedAmount: number | null;
  recordedRevenue: number;
  estimatedValue: number;
  /** Share of completed services in the window, 0-100. */
  popularityPercent: number;
}

export interface OwnerStaffPerformanceDto {
  staffId: string;
  displayName: string;
  status: StaffMemberStatus;
  availabilityState: 'AVAILABLE' | 'IN_SERVICE' | 'RESERVED' | 'OFF_DUTY';
  completedToday: number;
  completedLast30Days: number;
  /** Listed-price estimate for this barber's completed services in the last 30 days. */
  estimatedValueLast30Days: number;
  /** FastQue reviews attach to a booking, not a barber, so a per-barber rating does not exist. */
  rating: null;
  /** The barber's own profile photo when they have set one (never a stock image). */
  photoUrl?: string | null;
}

export interface OwnerScheduleItemDto {
  id: string;
  kind: 'BOOKING';
  slotStart: string;
  slotEnd: string;
  status: BookingStatus;
  source: 'ONLINE' | 'IN_SHOP';
  serviceNames: string[];
  customerLabel: string;
  staffName: string | null;
  /** The first service's category (e.g. Haircut, Colour) - drives the colour of the schedule block. */
  category?: string | null;
}

export interface OwnerQueueSummaryDto {
  waiting: number;
  called: number;
  /** A barber and chair are reserved, service not started. Optional: absent on older servers. */
  assigned?: number;
  inService: number;
  completedToday: number;
  cancelledToday: number;
  expiredToday: number;
  noShowToday: number;
}

export interface OwnerCancellationSummaryDto {
  windowDays: number;
  total: number;
  ratePercent: number | null;
  byActor: Record<CancellationActorOrUnknown, number>;
}

export interface OwnerBranchSummaryDto {
  salonId: string;
  name: string;
  waiting: number;
  inService: number;
  completedToday: number;
  recordedRevenueToday: number;
  currency: string | null;
}

export interface OwnerOverviewDto {
  salonId: string;
  salonName: string;
  currency: string | null;
  timezone: string;
  localDate: string;
  generatedAt: string;
  kpis: OwnerOverviewKpisDto;
  revenue: OwnerRevenueDto;
  topServices: OwnerTopServiceDto[];
  staffPerformance: OwnerStaffPerformanceDto[];
  todaysSchedule: OwnerScheduleItemDto[];
  queueSummary: OwnerQueueSummaryDto;
  cancellationSummary: OwnerCancellationSummaryDto;
  /** Only populated when the caller genuinely owns more than one shop. */
  branches: OwnerBranchSummaryDto[];
  settings: {
    autoAssignEnabled: boolean;
    showPhoneToCustomers: boolean;
    hasPaymentQr: boolean;
    hasBillingProfile: boolean;
  };
}

export interface CancellationBucketDto {
  key: string;
  label: string;
  count: number;
}

export interface CancellationRowDto {
  bookingId: string;
  cancelledAt: string;
  slotStart: string;
  actor: CancellationActorOrUnknown;
  reason: string | null;
  serviceNames: string[];
  chargeAmount: number | null;
  /** WAIVED / OUTSTANDING / SETTLED when a ledger charge exists, else null. */
  chargeStatus: 'OUTSTANDING' | 'SETTLED' | 'WAIVED' | null;
}

export interface CancellationAnalyticsDto {
  from: string;
  to: string;
  currency: string | null;
  totalCancellations: number;
  totalBookings: number;
  /** cancelled / bookings scheduled in the window; null when there were no bookings. */
  cancellationRatePercent: number | null;
  byActor: Record<CancellationActorOrUnknown, number>;
  byService: CancellationBucketDto[];
  byReason: CancellationBucketDto[];
  charges: { charged: number; waived: number; outstanding: number; settled: number };
  rows: CancellationRowDto[];
  /** Live Queue visits are reported separately and are never mixed into the booking figures above. */
  liveQueue: { cancelled: number; expired: number; noShow: number };
  /** How many cancelled rows lacked attribution (historical data) and are reported as UNKNOWN. */
  unattributedCount: number;
}

export interface ShopCancelBookingResultDto {
  bookingId: string;
  status: BookingStatus;
  cancelledByActor: CancellationActor;
  cancelledAt: string;
  /** Delivery truth for the customer notification, never a claim of success it cannot back up. */
  notification: {
    inApp: NotificationDeliveryStatus | 'NO_ACCOUNT';
    push: NotificationDeliveryStatus | 'NO_DEVICE' | 'NO_ACCOUNT';
  };
}

export interface InShopBookingDto {
  id: string;
  salonId: string;
  slotStart: string;
  slotEnd: string;
  status: BookingStatus;
  guestName: string;
  guestPhone: string | null;
  serviceNames: string[];
  staffName: string | null;
  note: string | null;
  createdAt: string;
}

export type QueueSectionKey = 'waiting' | 'called' | 'assigned' | 'inService' | 'completedToday' | 'historyToday';

export interface QueueBoardEntryNote {
  /** Why an automatic allocation did not seat this customer (shown to staff as a plain sentence). */
  entryId: string;
  reason: string;
}

export interface AutoAssignResultDto {
  assigned: { queueEntryId: string; staffId: string; chairId: string }[];
  /** Customers left waiting, each with a clear reason. */
  skipped: QueueBoardEntryNote[];
}

export interface StaffWorkItemDto {
  queueEntryId: string;
  serviceSessionId: string | null;
  tokenNumber: number;
  customerLabel: string;
  customerPhone: string | null;
  serviceName: string | null;
  startedAt: string | null;
  status: QueueEntryStatus;
  chairLabel: string | null;
}

export interface StaffAppointmentDto {
  bookingId: string;
  slotStart: string;
  slotEnd: string;
  status: BookingStatus;
  serviceNames: string[];
  customerLabel: string;
  customerPhone: string | null;
  source: 'ONLINE' | 'IN_SHOP';
}

/** GET dashboard/salons/:salonId/staff/me/work — a barber's own day, scoped to their own records. */
export interface StaffWorkDto {
  salonId: string;
  salonName: string;
  staffId: string;
  displayName: string;
  status: StaffMemberStatus;
  availabilityState: 'AVAILABLE' | 'IN_SERVICE' | 'RESERVED' | 'OFF_DUTY';
  /** The one session this barber is serving right now, if any — the only one they may complete. */
  current: StaffWorkItemDto | null;
  /**
   * A customer the shop (or the automatic allocator) has assigned to THIS barber whose service has
   * not started: the barber starts it explicitly. Never set at the same time as `current`. Optional:
   * absent on older servers.
   */
  assigned?: StaffWorkItemDto | null;
  /** The shop's waiting list, with the entries THIS barber is eligible to take flagged. */
  waiting: (StaffWorkItemDto & { eligible: boolean; position: number })[];
  appointmentsToday: StaffAppointmentDto[];
  completedToday: number;
  revision: number;
}

export interface OwnerSearchHitDto {
  type: 'booking' | 'customer' | 'service' | 'queue' | 'invoice';
  id: string;
  title: string;
  subtitle: string | null;
  /** Dashboard-relative path the hit opens (always a real page). */
  href: string;
}

export interface OwnerSearchResultDto {
  query: string;
  hits: OwnerSearchHitDto[];
}

export interface BillingProfileDto {
  salonId: string;
  legalName: string | null;
  billingAddress: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  gstin: string | null;
  taxEnabled: boolean;
  taxLabel: string;
  taxRatePercent: number | null;
  taxMode: InvoiceTaxMode;
  invoicePrefix: string;
  /** True once a legal name exists: invoices cannot be issued before that. */
  complete: boolean;
}

export interface InvoiceLineDto {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
}

export interface InvoicePaymentDto {
  id: string;
  kind: InvoicePaymentKind;
  method: InvoicePaymentMethod;
  amount: number;
  reference: string | null;
  note: string | null;
  recordedAt: string;
}

export interface InvoiceSummaryDto {
  id: string;
  number: string;
  salonId: string;
  sourceType: InvoiceSourceType;
  bookingId: string | null;
  queueEntryId: string | null;
  customerName: string | null;
  currency: string;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  balanceDue: number;
  paymentStatus: InvoicePaymentStatus;
  status: InvoiceStatus;
  issuedAt: string;
  serviceDate: string;
  /** Issuing shop's name (the salon is the invoice issuer). Optional for older clients. */
  salonName?: string;
}

export interface InvoiceDetailDto extends InvoiceSummaryDto {
  salonName: string;
  customerPhone: string | null;
  staffName: string | null;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  taxLabel: string | null;
  taxRatePercent: number | null;
  taxMode: InvoiceTaxMode | null;
  seller: {
    legalName: string;
    gstin: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  lines: InvoiceLineDto[];
  payments: InvoicePaymentDto[];
  voidReason: string | null;
}

export interface InvoiceListDto {
  items: InvoiceSummaryDto[];
  nextCursor: string | null;
}

export interface RecordedPaymentDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string | null;
  kind: InvoicePaymentKind;
  method: InvoicePaymentMethod;
  amount: number;
  reference: string | null;
  note: string | null;
  recordedAt: string;
  /** The barber's/owner's display name as the shop knows them ("Owner" for the shop owner). */
  recordedBy: string;
}

/** GET dashboard/salons/:salonId/payments - what the shop recorded as received/refunded. */
export interface RecordedPaymentListDto {
  from: string;
  to: string;
  currency: string | null;
  items: RecordedPaymentDto[];
  nextCursor: string | null;
  totals: { received: number; refunded: number; net: number; count: number };
  byMethod: { method: InvoicePaymentMethod; net: number }[];
}

export interface BookingShopContactDto {
  /** Present only when the owner chose to publish it (Salon.showPhoneToCustomers). */
  shopPhone: string | null;
  shopName: string;
}
