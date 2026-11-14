import { z } from "zod";
import {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NAME_MIN_LENGTH,
  normalizeContactName,
  normalizeContactPhone,
} from "../contact";
import {
  ChairStatus,
  ChargeType,
  CrmFollowUpChannel,
  CrmFollowUpStatus,
  CrmLeadSource,
  CrmLeadStatus,
  CrmVisitOutcome,
  CreditFundingSource,
  ContactConsentSource,
  Language,
  NotificationCategory,
  NotificationChannel,
  PhotoType,
  PrepaymentRequirement,
  Role,
  SalonLocationSource,
  SalonStatus,
  SalonType,
  StaffMemberStatus,
  UserStatus,
  VerificationStatus,
} from "../enums";
import {
  CUSTOMER_ASSISTANT_SEARCH_LIMITS,
  MAX_SERVICES_PER_BOOKING,
  PREMIUM_PLAN_IDS,
  SALON_DESCRIPTION_SUGGESTION_LIMITS,
} from "../constants";
import { isValidPostalCode, postalCodeRuleFor } from "../locale";
import { POPULAR_SERVICES, SALON_SEARCH_MAX_IDS, SALON_SORT_OPTIONS } from "../catalog/salon-discovery-filters";

// Validation schemas shared by the backend (request validation) and clients (form validation).
// The backend is always the authority — these schemas exist so both sides reject bad input the
// same way before a request ever reaches the server, not to move validation off the server.

// Multi-service booking core mission: one appointment now carries an ORDERED list of selected
// services (not just a shape check) — order is preserved end to end (BookingService.sortOrder,
// BookingDetailDto.services) since it drives which service is treated as "primary" for the
// consumers that still need exactly one (Booking.serviceId, QueueEntry linkage — see
// BookingsService.create's own doc comment). Structural only: duplicate ids, foreign-salon
// services, inactive services and empty selections are all rejected server-side against real data
// (AvailabilityService.getServicesOrThrow), never here — a schema has no salon/DB context to check
// any of that against.
const serviceIdsSchema = z
  .array(z.string().uuid())
  .min(1, "Select at least one service.")
  .max(
    MAX_SERVICES_PER_BOOKING,
    `Select at most ${MAX_SERVICES_PER_BOOKING} services.`,
  );

// Production-safety hardening (P0 #1) — an already-installed FastQue client (mobile not yet
// updated, or any external integration) still sends the ORIGINAL single `serviceId` field on
// booking creation and on the staff/availability GET queries below. Rolling deploys mean that
// shape reaches this backend for real, indefinitely, not just during a brief overlap window — so
// it must keep being accepted, not just tolerated once. New clients send the ordered `serviceIds`
// array instead. Exactly one of the two is accepted per request: both present is rejected (a
// client sending both has a bug worth surfacing, not a case worth silently guessing which one
// wins) and neither present is rejected with the same "select a service" message either shape
// used before normalization. See API.md's "Legacy serviceId compatibility" section.
type ServiceSelectionInput = { serviceId?: string; serviceIds?: string[] };

function checkServiceSelection(
  value: ServiceSelectionInput,
  ctx: z.RefinementCtx,
): void {
  if (value.serviceId && value.serviceIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either serviceId or serviceIds, not both.",
      path: ["serviceIds"],
    });
  }
  if (!value.serviceId && !value.serviceIds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Select at least one service.",
      path: ["serviceIds"],
    });
  }
}

function normalizeServiceSelection<T extends ServiceSelectionInput>(
  value: T,
): Omit<T, "serviceId" | "serviceIds"> & { serviceIds: string[] } {
  const { serviceId, serviceIds, ...rest } = value;
  return { ...rest, serviceIds: serviceIds ?? [serviceId as string] } as Omit<
    T,
    "serviceId" | "serviceIds"
  > & {
    serviceIds: string[];
  };
}

export const createBookingSchema = z
  .object({
    salonId: z.string().uuid(),
    // Legacy single-service clients — see checkServiceSelection/normalizeServiceSelection above.
    serviceId: z.string().uuid().optional(),
    serviceIds: serviceIdsSchema.optional(),
    slotStart: z.string().datetime(),
    // Soft preference only ("Any Staff" = omitted) — see DATABASE.md's Booking section.
    preferredStaffId: z.string().uuid().optional(),
    // AI Style Advisor hand-off (major-upgrade phase) — set when booking arrives via "Try This
    // Look" -> "Book This Style"; omitted for every ordinary booking.
    selectedStyleName: z.string().min(1).max(100).optional(),
    // Opaque, server-issued campaign token. This never accepts a source label from a client.
    attributionToken: z.string().min(40).max(128).optional(),
    // Optional salon-published campaign. The backend rechecks dates, audience, service scope,
    // redemption limits, and final price inside the booking transaction.
    offerId: z.string().uuid().optional(),
    // FastQue Credits / Wallet V1: how much of the customer's own wallet balance to apply against
    // this booking's price, reducing what they pay online. Omitted or 0 = redeem nothing. The
    // backend re-validates this against both the live balance and the COMBINED price of every
    // selected service, inside a transaction (BookingsService.create) — this schema only rejects
    // shapes that could never be valid (negative, non-finite, more than 2 decimal places), never the
    // actual balance/price check.
    creditsToRedeem: z.number().finite().min(0).multipleOf(0.01).optional(),
  })
  .superRefine(checkServiceSelection)
  .transform(normalizeServiceSelection);
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// POST bookings/:id/reschedule — only the slot moves; the existing booking's selected services,
// staff and salon are unchanged (a different service selection or salon is a new booking, not a
// reschedule of this one — see the mission's explicit "do not change services during reschedule"
// rule).
export const rescheduleBookingSchema = z.object({
  slotStart: z.string().datetime(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;

// A GET query string can only ever carry plain strings, so the ordered service-id list travels as
// one comma-separated param (`serviceIds=id1,id2,id3`) rather than a repeated key — repeated-key
// array parsing is a query-library convention (qs) that both web fetch() and mobile's URLSearchParams
// callers would otherwise have to special-case; a single delimited string is trivial for every
// client to build and preserves the selection order exactly as typed. Structural validation only
// (shape + uuid format + count) — the same real-data checks as createBookingSchema apply
// server-side once these ids reach AvailabilityService.
const serviceIdsQueryParam = z
  .string()
  .min(1, "serviceIds is required.")
  .transform((raw) => raw.split(",").map((id) => id.trim()))
  .pipe(serviceIdsSchema);

// GET /salons/:salonId/availability query params. Accepts the legacy single `?serviceId=<uuid>`
// alongside the new `?serviceIds=<id1,id2,...>` — see checkServiceSelection/
// normalizeServiceSelection above.
export const availabilityQuerySchema = z
  .object({
    serviceId: z.string().uuid().optional(),
    serviceIds: serviceIdsQueryParam.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format"),
    staffId: z.string().uuid().optional(),
  })
  .superRefine(checkServiceSelection)
  .transform(normalizeServiceSelection);
export type AvailabilityQueryInput = z.infer<typeof availabilityQuerySchema>;

// GET /salons/:salonId/staff query params. Same legacy `?serviceId=<uuid>` compatibility as
// availabilityQuerySchema above.
export const staffListQuerySchema = z
  .object({
    serviceId: z.string().uuid().optional(),
    serviceIds: serviceIdsQueryParam.optional(),
  })
  .superRefine(checkServiceSelection)
  .transform(normalizeServiceSelection);
export type StaffListQueryInput = z.infer<typeof staffListQuerySchema>;

export const joinQueueSchema = z.object({
  serviceId: z.string().uuid().optional(),
  // Live Queue contact details (see ./contact). Both optional on the wire so an older client that
  // does not send them keeps working when the account already has a phone; the server still refuses
  // to create an uncontactable entry (CONTACT_PHONE_REQUIRED) when no phone can be resolved.
  contactName: z
    .string()
    .transform((value) => normalizeContactName(value))
    .refine((value): value is string => value !== null, {
      message: `name must be ${CONTACT_NAME_MIN_LENGTH}-${CONTACT_NAME_MAX_LENGTH} characters`,
    })
    .optional(),
  contactPhone: z
    .string()
    .transform((value) => normalizeContactPhone(value))
    .refine((value): value is string => value !== null, {
      message:
        "enter a valid mobile number, with a country code if it is not an Indian number",
    })
    .optional(),
});
export type JoinQueueInput = z.infer<typeof joinQueueSchema>;

// POST /dashboard/queue-entries/:id/assign — serviceId is only required when the queue entry
// itself has none (e.g. a walk-in that never picked one); validated in the service layer, not
// here, since that depends on the target entry's existing state.
export const assignQueueEntrySchema = z.object({
  staffId: z.string().uuid(),
  chairId: z.string().uuid(),
  serviceId: z.string().uuid().optional(),
  // Owner-operations corrective mission: assigning a barber and STARTING the service are separate
  // steps. `false` (what every current first-party client sends) only reserves the barber and chair
  // - the customer becomes "Assigned" and the barber explicitly starts the service later. Omitted =
  // the pre-existing behaviour (seat and start in one step), kept ONLY so already-installed
  // clients that predate the Start Service action are not left with customers they can never start.
  startService: z.boolean().optional(),
});
export type AssignQueueEntryInput = z.infer<typeof assignQueueEntrySchema>;

// PATCH /dashboard/queue-entries/:id/reassign — only the assignment changes. Service, token,
// queue position and timestamps remain authoritative on the existing entry/session.
export const reassignQueueEntrySchema = z
  .object({
    staffId: z.string().uuid().optional(),
    chairId: z.string().uuid().optional(),
  })
  .refine((v) => v.staffId !== undefined || v.chairId !== undefined, {
    message: "Choose a barber, a chair, or both",
  });
export type ReassignQueueEntryInput = z.infer<typeof reassignQueueEntrySchema>;

// PATCH /dashboard/staff/:id/status
export const staffStatusSchema = z.object({
  status: z.nativeEnum(StaffMemberStatus),
});
export type StaffStatusInput = z.infer<typeof staffStatusSchema>;

// POST /salons — shop registration (major-upgrade phase). Reuses an existing City (by slug)
// rather than accepting free-text state/country here, which would let a typo silently create a
// duplicate/junk City row — city curation stays a separate, existing concern (CitiesService).
// Indian PIN codes are exactly six digits and never start with 0 (the leading digit is the
// postal region, 1-8). Anchored so "560001abc" and "56 00 01" are rejected rather than coerced.
export const INDIAN_PIN_CODE_REGEX = /^[1-9][0-9]{5}$/;

export const registerSalonSchema = z
  .object({
    name: z.string().min(1).max(200),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    addressLine: z.string().min(1).max(300),
    // ISO-3166-1 alpha-2 of the selected city's country. Sent by the client so postal validation
    // below can pick the right rule before any database lookup; SalonsService independently
    // verifies it matches the resolved City, so a mismatched value cannot be used to bypass a
    // country's postal rule.
    countryCode: z.string().length(2),
    // Country-aware. India keeps exactly the rule it had (6 digits, no leading zero); every other
    // country falls back to a permissive pattern rather than a guessed one, and countries with no
    // postal system may leave it blank. See postalCodeRuleFor in ../locale.
    postalCode: z.string().max(12).optional(),
    // Optional since Phase 11: coordinates are captured from the device's GPS by the registration
    // form's "Use my current location" button, never typed. An owner who denies that permission —
    // or registers from a desktop with no GPS — still gets a working shop; the address + city +
    // PIN code identify it. lat/lng's only consumer is the schema.org `geo` block on the public
    // salon page, which omits itself when they are absent.
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    citySlug: z.string().min(1),
    // Free-text area/locality entered by the owner. localitySlug remains optional metadata when
    // the text exactly matches one of the curated Locality rows; custom neighbourhood names are
    // valid and must never be rejected just because they are absent from the master dataset.
    localityText: z.string().trim().max(160).optional(),
    localitySlug: z.string().optional(),
    landmark: z.string().trim().max(200).optional(),
    // Discovery upgrade: the registration form asks for it; optional here so older clients keep
    // working (their salons stay "type not set" until the owner confirms it in settings).
    salonType: z.nativeEnum(SalonType).optional(),
  })
  // A half-coordinate is meaningless — it would place the shop on the equator or the prime
  // meridian. Either both arrive or neither does.
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: "Latitude and longitude must be provided together",
    path: ["lat"],
  })
  .superRefine((v, ctx) => {
    if (isValidPostalCode(v.countryCode, v.postalCode)) return;
    const rule = postalCodeRuleFor(v.countryCode);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["postalCode"],
      message: rule.example
        ? `Enter a valid ${rule.label} (for example ${rule.example})`
        : `Enter a valid ${rule.label}`,
    });
  });
export type RegisterSalonInput = z.infer<typeof registerSalonSchema>;

export const updateSalonTypeSchema = z.object({
  salonType: z.nativeEnum(SalonType),
});
export type UpdateSalonTypeInput = z.infer<typeof updateSalonTypeSchema>;

// GET /salons query params — validated the same way on backend (ZodValidationPipe on @Query())
// and client (search form) so both agree on shape before a request is ever made.
export const salonSearchQuerySchema = z
  .object({
    city: z.string().optional(),
    // ISO-3166-1 alpha-2, scopes `city` to an exact (countryCode, slug) match — see B9. Optional:
    // not every caller has a country in hand (free-text/service search), so omitting it falls back
    // to matching `city` by slug alone, exactly as before this field existed.
    countryCode: z.string().length(2).optional(),
    locality: z.string().optional(),
    service: z.string().optional(),
    // Dedicated shop-name filter for /search; unlike q it never matches services/descriptions.
    shopName: z.string().trim().min(1).max(120).optional(),
    q: z.string().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    // "Near Me" (Phase 4) — the device's current position, from the browser/RN geolocation API, not
    // a paid geocoding service. Both-or-neither: a lone lat/lng is meaningless, so the service
    // ignores either one supplied without its pair rather than guessing 0 for the other.
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    // Distance filter (Part 8/9) — a hard maximum, only meaningful alongside lat/lng: without a
    // query point there is nothing to measure a radius from, so SalonsService.search ignores this
    // exactly like a lone lat/lng today rather than erroring. Capped at 500km — larger than any of
    // NEAR_ME_RADII_KM's fallback boxes, since a hard cutoff should never need to exceed the widest
    // box the "no explicit radius" path already tries.
    radiusKm: z.coerce.number().positive().max(500).optional(),
    // Price filter (Part 8/9) — independent of `service`/`q` text search: matches any salon with at
    // least one active Service priced in [priceMin, priceMax], regardless of what (if anything) the
    // text search matched. Both ends optional so a caller can give just a floor or just a ceiling.
    priceMin: z.coerce.number().nonnegative().optional(),
    priceMax: z.coerce.number().nonnegative().optional(),
    // Discovery upgrade (catalog/salon-discovery-filters.ts): salon type, a popular service to
    // compare by (its price drives priceMin/priceMax and sort=price), and result ordering.
    salonType: z.enum(["GENTS", "LADIES", "UNISEX"]).optional(),
    popularService: z
      .string()
      .refine((id) => POPULAR_SERVICES.some((s) => s.id === id), "Unknown popular service.")
      .optional(),
    sort: z.enum(SALON_SORT_OPTIONS).optional(),
    // Minimum average review score (salons with no reviews never pass), "open right now", and
    // "favorites only" — the client sends the customer's saved salon IDs (this route is public, so
    // it never reads who is asking).
    minRating: z.coerce.number().min(1).max(5).optional(),
    openNow: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    // Live queue: only salons open now whose estimated queue wait is at most this many minutes.
    maxWaitMinutes: z.coerce.number().int().min(0).max(240).optional(),
    // Only salons with a current published offer (for the selected service, when one is selected).
    offersOnly: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    ids: z
      .string()
      .transform((value) => value.split(",").map((id) => id.trim()).filter(Boolean))
      .pipe(z.array(z.string().uuid()).min(1).max(SALON_SEARCH_MAX_IDS))
      .optional(),
    // Customer dashboard map view ("Search this area"): the visible map rectangle. All four or
    // none — a partial box is ignored by the service. Purely an extra AND filter on salons that
    // have coordinates; it never changes text/service/price matching or ranking.
    minLat: z.coerce.number().min(-90).max(90).optional(),
    maxLat: z.coerce.number().min(-90).max(90).optional(),
    minLng: z.coerce.number().min(-180).max(180).optional(),
    maxLng: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine(
    (data) =>
      data.minLat === undefined || data.maxLat === undefined || data.minLat <= data.maxLat,
    { message: "minLat must not be greater than maxLat.", path: ["minLat"] },
  )
  .refine(
    (data) => data.sort !== "distance" || (data.lat !== undefined && data.lng !== undefined),
    { message: "Sorting by distance needs your location.", path: ["sort"] },
  )
  .refine(
    (data) =>
      data.priceMin === undefined ||
      data.priceMax === undefined ||
      data.priceMin <= data.priceMax,
    {
      message: "priceMin must not be greater than priceMax.",
      path: ["priceMin"],
    },
  );
export type SalonSearchQueryInput = z.infer<typeof salonSearchQuerySchema>;

// POST /assistant/search — deterministic retrieval only. `date` is a salon-local calendar day;
// the backend returns only real bookable slots from AvailabilityService and never creates a
// booking. Real-calendar validation prevents dates such as 2026-02-31 from silently normalizing.
export const customerAssistantSearchSchema = z
  .object({
    serviceQuery: z
      .string()
      .trim()
      .min(2)
      .max(CUSTOMER_ASSISTANT_SEARCH_LIMITS.maxQueryLength),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return (
          Number.isFinite(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === value
        );
      }, "date must be a valid YYYY-MM-DD calendar date"),
    city: z.string().trim().min(1).max(80).optional(),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .optional(),
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional(),
    radiusKm: z.number().finite().positive().max(500).optional(),
    maxPrice: z
      .number()
      .finite()
      .nonnegative()
      .max(CUSTOMER_ASSISTANT_SEARCH_LIMITS.maxPrice)
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CUSTOMER_ASSISTANT_SEARCH_LIMITS.maxResults)
      .default(3),
  })
  .superRefine((value, ctx) => {
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lat and lng must be provided together",
        path: [value.lat === undefined ? "lat" : "lng"],
      });
    }
    if (
      value.radiusKm !== undefined &&
      (value.lat === undefined || value.lng === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "radiusKm requires lat and lng",
        path: ["radiusKm"],
      });
    }
    if (value.countryCode !== undefined && value.city === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "countryCode requires city",
        path: ["countryCode"],
      });
    }
    if (value.city === undefined && value.lat === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "city or coordinates are required to search nearby salons",
        path: ["city"],
      });
    }
  });
export type CustomerAssistantSearchInput = z.infer<
  typeof customerAssistantSearchSchema
>;

// GET /cities/search query params (Phase 6A — Country -> Region -> City-search selection flow).
// countryId is required: a global, unscoped city search across ~100K rows is never allowed.
// `q` is intentionally left unbounded in length here (trimmed/short-circuited in the service, not
// rejected here) so an empty/short query is a normal "still typing" UI state, not a validation
// error.
export const citySearchQuerySchema = z.object({
  countryId: z.string().uuid(),
  regionId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type CitySearchQueryInput = z.infer<typeof citySearchQuerySchema>;

export const otpRequestSchema = z.object({
  phone: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      "phone must be in E.164 format, e.g. +919876543210",
    ),
});
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  phone: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      "phone must be in E.164 format, e.g. +919876543210",
    ),
  code: z.string().regex(/^\d{6}$/, "code must be a 6-digit OTP"),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const ownerPhoneLinkRequestSchema = otpRequestSchema;
export const ownerPhoneLinkVerifySchema = otpVerifySchema;
export type OwnerPhoneLinkRequestInput = z.infer<
  typeof ownerPhoneLinkRequestSchema
>;
export type OwnerPhoneLinkVerifyInput = z.infer<
  typeof ownerPhoneLinkVerifySchema
>;

// POST /auth/google — the client only ever sends the ID token it got directly from Google's own
// sign-in SDK (Google Identity Services on web, expo-auth-session on mobile); the backend is what
// verifies it against Google, never the other way around.
export const googleLoginSchema = z.object({
  idToken: z.string().min(1),
});
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

// Apple identity tokens are verified against Apple's JWKS. The raw nonce is returned by the
// backend once and consumed atomically after its exact signed claim is validated.
export const appleNonceSchema = z.object({
  nonce: z.string().min(32).max(128),
});
export type AppleNonceInput = z.infer<typeof appleNonceSchema>;
export const appleLoginSchema = appleNonceSchema.extend({
  identityToken: z.string().min(1).max(8192),
  // Exchanged server-side so the corresponding Apple refresh token can be revoked if the user
  // later deletes their FastQue account. The code is short-lived and is never persisted/logged.
  authorizationCode: z.string().min(1).max(4096),
});
export type AppleLoginInput = z.infer<typeof appleLoginSchema>;

// Shared password rule: staff/owner/admin accounts only (customers never have a password).
const passwordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .max(72, "password must be at most 72 characters"); // bcrypt truncates beyond 72 bytes

export const staffLoginSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
});
export type StaffLoginInput = z.infer<typeof staffLoginSchema>;

// Self-service shop-owner account creation. The account starts with CUSTOMER access only so it can
// call POST /salons; that existing registration transaction grants the salon-scoped SALON_OWNER
// role and returns a fresh STAFF-audience session once a real salon exists.
export const ownerSignupSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type OwnerSignupInput = z.infer<typeof ownerSignupSchema>;

export const employeeLoginSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .transform((value) => value.toUpperCase()),
  password: passwordSchema,
});
export type EmployeeLoginInput = z.infer<typeof employeeLoginSchema>;

// PLATFORM_ADMIN employee provisioning. Employee IDs are generated server-side and immutable;
// admins choose the temporary password explicitly so no plaintext credential ever needs to be
// generated, logged, emailed, or returned by the server.
export const createEmployeeSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    territory: z.string().trim().max(160).optional(),
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const createSpecialEmployeeSchema = createEmployeeSchema.and(
  z.object({
    employeeNumber: z.number().int().min(1).max(100),
    totpCode: z.string().regex(/^\d{6}$/, "totpCode must be 6 digits"),
  }),
);
export type CreateSpecialEmployeeInput = z.infer<
  typeof createSpecialEmployeeSchema
>;

export const updateEmployeeSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    territory: z.union([z.string().trim().max(160), z.null()]).optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No employee changes provided",
  });
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const resetEmployeePasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetEmployeePasswordInput = z.infer<
  typeof resetEmployeePasswordSchema
>;

// ---------- FastQue internal Field CRM ----------
const optionalCrmText = (max: number) =>
  z.union([z.string().trim().max(max), z.literal("")]).optional();

export const createCrmLeadSchema = z.object({
  shopName: z.string().trim().min(2).max(180),
  contactName: optionalCrmText(120),
  phone: optionalCrmText(32),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  city: optionalCrmText(120),
  locality: optionalCrmText(160),
  addressLine: optionalCrmText(300),
  source: z.nativeEnum(CrmLeadSource).default(CrmLeadSource.FIELD_VISIT),
  notes: optionalCrmText(2000),
});
export type CreateCrmLeadInput = z.infer<typeof createCrmLeadSchema>;

export const updateCrmLeadSchema = z
  .object({
    shopName: z.string().trim().min(2).max(180).optional(),
    contactName: z.union([z.string().trim().max(120), z.null()]).optional(),
    phone: z.union([z.string().trim().max(32), z.null()]).optional(),
    email: z.union([z.string().trim().email(), z.null()]).optional(),
    city: z.union([z.string().trim().max(120), z.null()]).optional(),
    locality: z.union([z.string().trim().max(160), z.null()]).optional(),
    addressLine: z.union([z.string().trim().max(300), z.null()]).optional(),
    source: z.nativeEnum(CrmLeadSource).optional(),
    status: z.nativeEnum(CrmLeadStatus).optional(),
    notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
    lostReason: z.union([z.string().trim().max(500), z.null()]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No lead changes provided",
  });
export type UpdateCrmLeadInput = z.infer<typeof updateCrmLeadSchema>;

export const onboardCrmLeadSchema = z.object({
  salonPublicId: z
    .string()
    .trim()
    .regex(/^BC-SHOP-[0-9]{6}$/i, "Enter a FastQue Shop ID like BC-SHOP-000123")
    .transform((value) => value.toUpperCase()),
});
export type OnboardCrmLeadInput = z.infer<typeof onboardCrmLeadSchema>;

export const createCrmVisitSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    shopName: optionalCrmText(180),
    visitedAt: z.string().datetime().optional(),
    outcome: z.nativeEnum(CrmVisitOutcome),
    notes: optionalCrmText(2000),
  })
  .refine((value) => !!value.leadId || !!value.shopName?.trim(), {
    message: "Choose a lead or enter the shop name",
    path: ["shopName"],
  });
export type CreateCrmVisitInput = z.infer<typeof createCrmVisitSchema>;

export const createCrmFollowUpSchema = z.object({
  leadId: z.string().uuid(),
  dueAt: z.string().datetime(),
  channel: z.nativeEnum(CrmFollowUpChannel),
  notes: optionalCrmText(1000),
});
export type CreateCrmFollowUpInput = z.infer<typeof createCrmFollowUpSchema>;

export const updateCrmFollowUpSchema = z
  .object({
    dueAt: z.string().datetime().optional(),
    channel: z.nativeEnum(CrmFollowUpChannel).optional(),
    status: z.nativeEnum(CrmFollowUpStatus).optional(),
    notes: z.union([z.string().trim().max(1000), z.null()]).optional(),
    outcome: z.union([z.string().trim().max(1000), z.null()]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No follow-up changes provided",
  });
export type UpdateCrmFollowUpInput = z.infer<typeof updateCrmFollowUpSchema>;

// Platform CRM analytics are read-only and bounded. Date filters are UTC instants with an
// exclusive upper bound; this avoids host-local timezone interpretation in a global admin view.
const ADMIN_CRM_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const adminCrmRangeFields = {
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};
const refineAdminCrmRange = (
  value: { from?: string; to?: string },
  context: z.RefinementCtx,
) => {
  if (!value.from || !value.to) return;
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (from >= to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "from must be earlier than to",
      path: ["to"],
    });
  }
};
const refineAdminCrmPageRange = (
  value: { from?: string; to?: string },
  context: z.RefinementCtx,
) => {
  refineAdminCrmRange(value, context);
  if (
    value.from &&
    value.to &&
    Date.parse(value.from) < Date.parse(value.to) &&
    Date.parse(value.to) - Date.parse(value.from) > ADMIN_CRM_MAX_RANGE_MS
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "date range cannot exceed 366 days",
      path: ["to"],
    });
  }
};
const adminCrmPageFields = {
  employeeId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
};

export const adminCrmLeadPageQuerySchema = z
  .object({
    ...adminCrmPageFields,
    ...adminCrmRangeFields,
    status: z.nativeEnum(CrmLeadStatus).optional(),
    source: z.nativeEnum(CrmLeadSource).optional(),
  })
  .superRefine(refineAdminCrmPageRange);
export type AdminCrmLeadPageQuery = z.infer<typeof adminCrmLeadPageQuerySchema>;

export const adminCrmVisitPageQuerySchema = z
  .object({
    ...adminCrmPageFields,
    ...adminCrmRangeFields,
    outcome: z.nativeEnum(CrmVisitOutcome).optional(),
  })
  .superRefine(refineAdminCrmPageRange);
export type AdminCrmVisitPageQuery = z.infer<
  typeof adminCrmVisitPageQuerySchema
>;

export const adminCrmFollowUpPageQuerySchema = z
  .object({
    ...adminCrmPageFields,
    ...adminCrmRangeFields,
    status: z.nativeEnum(CrmFollowUpStatus).optional(),
    channel: z.nativeEnum(CrmFollowUpChannel).optional(),
  })
  .superRefine(refineAdminCrmPageRange);
export type AdminCrmFollowUpPageQuery = z.infer<
  typeof adminCrmFollowUpPageQuerySchema
>;

export const adminCrmAnalyticsQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .superRefine(refineAdminCrmRange);
export type AdminCrmAnalyticsQuery = z.infer<
  typeof adminCrmAnalyticsQuerySchema
>;

// Admin "Shop activity" — an inclusive range of IST calendar dates, capped so one request can
// never scan an unbounded history.
export const ADMIN_SHOP_ACTIVITY_MAX_DAYS = 92;
const adminCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "date must be a valid YYYY-MM-DD calendar date");
export const adminShopActivityQuerySchema = z
  .object({ from: adminCalendarDate, to: adminCalendarDate })
  .superRefine((query, ctx) => {
    const days =
      (Date.parse(`${query.to}T00:00:00.000Z`) -
        Date.parse(`${query.from}T00:00:00.000Z`)) /
        86_400_000 +
      1;
    if (days < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be on or after from",
      });
    } else if (days > ADMIN_SHOP_ACTIVITY_MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `the range cannot exceed ${ADMIN_SHOP_ACTIVITY_MAX_DAYS} days`,
      });
    }
  });
export type AdminShopActivityQuery = z.infer<
  typeof adminShopActivityQuerySchema
>;
// Every admin analytics report takes the same inclusive IST date range.
export const adminAnalyticsRangeQuerySchema = adminShopActivityQuerySchema;
export type AdminAnalyticsRangeQuery = AdminShopActivityQuery;

// Admin chart builder (docs/admin-dashboard-2.0). Metric keys are a closed list; the backend owns
// each metric's SQL, unit and date basis.
export const ADMIN_TIMESERIES_METRICS = [
  "appointmentsBooked",
  "appointmentsCompleted",
  "walkInsServed",
  "completedVisits",
  "cancelled",
  "noShow",
  "cancellationRatePercent",
  "completedServiceValuePaise",
  "serviceHours",
  "newSalons",
  "uniqueCustomers",
  "newCustomers",
  "averageWaitMinutes",
] as const;
export type AdminTimeseriesMetric = (typeof ADMIN_TIMESERIES_METRICS)[number];
export const ADMIN_TIMESERIES_GRANULARITIES = ["day", "week", "month"] as const;
export type AdminTimeseriesGranularity =
  (typeof ADMIN_TIMESERIES_GRANULARITIES)[number];
export const ADMIN_TIMESERIES_MAX_METRICS = 6;
export const adminTimeseriesQuerySchema = z
  .object({
    from: adminCalendarDate,
    to: adminCalendarDate,
    granularity: z.enum(ADMIN_TIMESERIES_GRANULARITIES).default("day"),
    // Comma-separated metric keys, e.g. "appointmentsBooked,cancelled".
    metrics: z
      .string()
      .transform((value) => [...new Set(value.split(",").map((m) => m.trim()).filter(Boolean))])
      .pipe(z.array(z.enum(ADMIN_TIMESERIES_METRICS)).min(1).max(ADMIN_TIMESERIES_MAX_METRICS)),
    compare: z.enum(["none", "previous"]).default("none"),
  })
  .superRefine((query, ctx) => {
    const days =
      (Date.parse(`${query.to}T00:00:00.000Z`) - Date.parse(`${query.from}T00:00:00.000Z`)) / 86_400_000 + 1;
    if (days < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
    } else if (days > 366) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "the range cannot exceed 366 days" });
    }
  });
export type AdminTimeseriesQuery = z.infer<typeof adminTimeseriesQuerySchema>;

export const managedAdminRoleSchema = z.enum([
  Role.CO_FOUNDER,
  Role.HR_ADMIN,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
]);
export type ManagedAdminRole = z.infer<typeof managedAdminRoleSchema>;

export const grantAdminAccessSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: managedAdminRoleSchema,
});
export type GrantAdminAccessInput = z.infer<typeof grantAdminAccessSchema>;

export const revokeAdminAccessSchema = z.object({
  role: managedAdminRoleSchema,
});
export type RevokeAdminAccessInput = z.infer<typeof revokeAdminAccessSchema>;

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  // Optional at the schema layer so the service can distinguish "missing TOTP" (→
  // TOTP_REQUIRED) from "wrong shape" (→ 400) rather than zod rejecting the request outright.
  totpCode: z
    .string()
    .regex(/^\d{6}$/, "totpCode must be 6 digits")
    .optional(),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const adminGoogleLoginSchema = z.object({
  idToken: z.string().min(1),
  // Google proves possession of the existing admin's identity; it never replaces the second
  // factor. Keeping this optional lets the service return TOTP_REQUIRED before any session is
  // issued, then verify the same Google credential together with the authenticator code.
  totpCode: z
    .string()
    .regex(/^\d{6}$/, "totpCode must be 6 digits")
    .optional(),
});
export type AdminGoogleLoginInput = z.infer<typeof adminGoogleLoginSchema>;

export const refreshRequestSchema = z.object({
  // Optional: web relies on the httpOnly refresh cookie instead of sending this in the body.
  refreshToken: z.string().optional(),
});
export type RefreshRequestInput = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().optional(),
});
export type LogoutRequestInput = z.infer<typeof logoutRequestSchema>;

export const passwordAudienceSchema = z.enum(["owner", "staff", "admin"]);
export type PasswordAudience = z.infer<typeof passwordAudienceSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  // Navigation hint only. The backend still decides eligibility from stored roles and always
  // returns the same public response, so this cannot be used to discover or elevate accounts.
  audience: passwordAudienceSchema.optional(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    newPassword: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const initialPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type InitialPasswordInput = z.infer<typeof initialPasswordSchema>;

export const salonPaymentPolicySchema = z
  .object({
    prepaymentRequirement: z.nativeEnum(PrepaymentRequirement),
    prepaymentPercentage: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (val) =>
      val.prepaymentRequirement !== PrepaymentRequirement.PARTIAL ||
      !!val.prepaymentPercentage,
    {
      message:
        "prepaymentPercentage is required when prepaymentRequirement is PARTIAL",
      path: ["prepaymentPercentage"],
    },
  );
export type SalonPaymentPolicyInput = z.infer<typeof salonPaymentPolicySchema>;

export const cancellationPolicySchema = z.object({
  freeCancellationWindowMinutes: z.number().int().min(0),
  lateCancellationChargeType: z.nativeEnum(ChargeType),
  lateCancellationChargeValue: z.number().min(0),
  noShowChargeType: z.nativeEnum(ChargeType),
  noShowChargeValue: z.number().min(0),
  appointmentArrivalGraceMinutes: z.number().int().min(0),
  queueCallResponseGraceMinutes: z.number().int().min(0),
});
export type CancellationPolicyInput = z.infer<typeof cancellationPolicySchema>;

// ---------- Salon owner setup (Phase 11) ----------

// POST dashboard/salons/:salonId/services. Price is rupees (matches Service.price's Decimal(10,2)
// and every other money field in this package); duration is whole minutes because the whole
// booking/slot engine works in minutes.
export const createSalonServiceSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    price: z.number().min(0).max(1_000_000),
    durationMinutes: z.number().int().min(5).max(480),
    category: z.string().min(1).max(60).optional(),
    subcategory: z.string().trim().min(1).max(60).optional(),
    categoryId: z.string().uuid().optional(),
    subcategoryId: z.string().uuid().optional(),
  })
  .refine((v) => !v.subcategoryId || !!v.categoryId, {
    message: "A subcategory ID requires its category ID",
    path: ["categoryId"],
  });
export type CreateSalonServiceInput = z.infer<typeof createSalonServiceSchema>;

// PATCH .../services/:serviceId — every field optional (partial update). `isActive: false` is the
// soft-delete: Service is foreign-keyed from Booking/QueueEntry/ServiceSession, so rows are
// never hard-deleted.
export const updateSalonServiceSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    price: z.number().min(0).max(1_000_000).optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    category: z.string().min(1).max(60).nullable().optional(),
    subcategory: z.string().trim().min(1).max(60).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    subcategoryId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateSalonServiceInput = z.infer<typeof updateSalonServiceSchema>;

// Canonical salon-owned taxonomy nodes. These labels are intentionally separate from the legacy
// free-text service fields so an owner can manage stable IDs without forcing old clients to migrate.
export const serviceTaxonomyNodeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type ServiceTaxonomyNodeInput = z.infer<
  typeof serviceTaxonomyNodeInputSchema
>;

// "HH:mm", 24-hour. Matches exactly what OperatingHours.openTime/closeTime already store and what
// AvailabilityService's istWallTimeToUtc parses — this is a validator for the existing format,
// not a new one.
export const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const operatingHoursEntrySchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    openTime: z.string().regex(TIME_OF_DAY_REGEX, "Use a time like 09:00"),
    closeTime: z.string().regex(TIME_OF_DAY_REGEX, "Use a time like 21:00"),
    isClosed: z.boolean(),
  })
  // Only meaningful on an open day; a closed day's times are ignored by AvailabilityService.
  // Overnight hours (close before open) are deliberately rejected rather than silently accepted:
  // the availability engine resolves open/close within a single IST calendar day, so a
  // 20:00–02:00 shift would produce an empty or negative window, not a late-night salon.
  .refine((v) => v.isClosed || v.closeTime > v.openTime, {
    message: "Closing time must be after opening time",
    path: ["closeTime"],
  });

// PUT dashboard/salons/:salonId/operating-hours — the whole week, replaced in one call. A weekly
// schedule is edited as a unit, so this avoids the partially-saved week that per-day PATCHes
// would allow (e.g. Monday saved, Tuesday failed) and keeps the client to one round-trip.
export const setOperatingHoursSchema = z
  .object({
    days: z.array(operatingHoursEntrySchema).length(7),
  })
  .refine((v) => new Set(v.days.map((d) => d.dayOfWeek)).size === 7, {
    message: "Provide exactly one entry for each day of the week",
    path: ["days"],
  });
export type SetOperatingHoursInput = z.infer<typeof setOperatingHoursSchema>;

// PUT dashboard/salons/:salonId/staff/:staffId/working-hours (Phase 7) — same one-call,
// whole-week-replaced shape and rationale as setOperatingHoursSchema, reusing the exact same
// per-day entry schema (identical validation rules — a "HH:mm" pair and an overnight-hours guard
// apply equally to a barber's personal hours).
export const setStaffWorkingHoursSchema = z
  .object({
    days: z.array(operatingHoursEntrySchema).length(7),
  })
  .refine((v) => new Set(v.days.map((d) => d.dayOfWeek)).size === 7, {
    message: "Provide exactly one entry for each day of the week",
    path: ["days"],
  });
export type SetStaffWorkingHoursInput = z.infer<
  typeof setStaffWorkingHoursSchema
>;

// PUT notifications/preferences (Phase 13) — one (category, channel) toggle per call; the client
// already has the full NotificationPreferencesDto to render from, so there's no need for a
// whole-preferences-replaced-at-once shape the way OperatingHours/StaffWorkingHours use.
export const setNotificationPreferenceSchema = z.object({
  category: z.enum([
    NotificationCategory.BOOKING_UPDATES,
    NotificationCategory.QUEUE_UPDATES,
    NotificationCategory.REMINDERS,
    NotificationCategory.PROMOTIONAL,
  ]),
  channel: z.enum([
    NotificationChannel.IN_APP,
    NotificationChannel.PUSH,
    NotificationChannel.EMAIL,
    NotificationChannel.SMS,
    NotificationChannel.WHATSAPP,
  ]),
  enabled: z.boolean(),
});
export type SetNotificationPreferenceInput = z.infer<
  typeof setNotificationPreferenceSchema
>;

// PATCH auth/language (Phase 14).
export const setLanguageSchema = z.object({
  language: z.nativeEnum(Language),
});
export type SetLanguageInput = z.infer<typeof setLanguageSchema>;

// DELETE auth/account is intentionally confirmation-gated even though the server derives the
// account from the current JWT. This prevents an accidental UI/API call from irreversibly
// removing the caller's credentials and direct identifiers.
export const deleteAccountSchema = z.object({
  confirmation: z.literal("DELETE"),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

// A role-aware request is deliberately separate from DELETE auth/account: it records the
// authenticated user's request and never deletes business or operational data.
export const accountDeletionRequestSchema = z.object({
  confirmation: z.literal("REQUEST_DELETION"),
});
export type AccountDeletionRequestInput = z.infer<typeof accountDeletionRequestSchema>;

// Salon photo by URL. Binary upload is not wired (no object storage is configured), so an owner
// points at an image they already host — their Google Business profile, Instagram, or a CDN.
//
// https only, deliberately: http would be blocked as mixed content on an https page, and
// javascript:/data: URLs are rejected outright rather than trusted to be inert in an <img src>.
// The backend never fetches this URL — only the visitor's browser does — so this is not an SSRF
// surface; the check is about what we are willing to render and store.
export const salonPhotoUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Enter a full https:// image link");

export const createSalonPhotoSchema = z.object({
  url: salonPhotoUrlSchema,
  // Real alt text matters for accessibility and SEO; optional because a forced field invites
  // owners to type junk just to get past it.
  altText: z.string().trim().max(200).optional(),
  type: z.nativeEnum(PhotoType),
});
export type CreateSalonPhotoInput = z.infer<typeof createSalonPhotoSchema>;

// Multipart upload metadata (dashboard/salons/:salonId/photos/upload). Same altText/type fields
// as createSalonPhotoSchema above, minus `url` — on this path the URL is produced by object
// storage after the bytes land, never supplied by the client. Everything arrives as a string in
// a multipart body, so `type` is validated against the enum rather than assumed.
export const salonPhotoUploadMetaSchema = z.object({
  altText: z.string().trim().max(200).optional(),
  type: z.nativeEnum(PhotoType),
});
export type SalonPhotoUploadMetaInput = z.infer<
  typeof salonPhotoUploadMetaSchema
>;

// PUT dashboard/salons/:salonId/payment-qr — link route (FastQue Credits / Wallet V1), same
// https-only/no-credentials validation as salonPhotoUrlSchema above; the multipart upload sibling
// (POST .../payment-qr/upload) needs no body schema at all, same as photos' upload route.
export const setSalonPaymentQrSchema = z.object({
  url: salonPhotoUrlSchema,
});
export type SetSalonPaymentQrInput = z.infer<typeof setSalonPaymentQrSchema>;

export const createSalonChairSchema = z.object({
  label: z.string().min(1).max(60),
});
export type CreateSalonChairInput = z.infer<typeof createSalonChairSchema>;

// Chairs are deactivated (INACTIVE/MAINTENANCE), never deleted — Chair is foreign-keyed from
// ServiceSession/QueueEntry. Only ACTIVE chairs count toward bookable capacity.
export const updateSalonChairSchema = z
  .object({
    label: z.string().min(1).max(60).optional(),
    status: z.nativeEnum(ChairStatus).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateSalonChairInput = z.infer<typeof updateSalonChairSchema>;

const bulkChairIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(50)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Chair IDs must be unique.",
      });
    }
  });

/** Preview explicitly selected chairs before a batch deactivation. */
export const bulkDeactivateSalonChairsPreviewSchema = z.object({
  chairIds: bulkChairIdsSchema,
});
export type BulkDeactivateSalonChairsPreviewInput = z.infer<
  typeof bulkDeactivateSalonChairsPreviewSchema
>;

/** Apply only against the exact row version returned by the preview. */
export const bulkDeactivateSalonChairsApplySchema = z.object({
  items: z
    .array(
      z.object({
        chairId: z.string().uuid(),
        expectedUpdatedAt: z.string().datetime(),
      }),
    )
    .min(1)
    .max(50)
    .superRefine((items, ctx) => {
      const ids = items.map((item) => item.chairId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Chair IDs must be unique.",
        });
      }
    }),
});
export type BulkDeactivateSalonChairsApplyInput = z.infer<
  typeof bulkDeactivateSalonChairsApplySchema
>;

// POST dashboard/salons/:salonId/staff — onboard a staff member quickly. Name is the only
// required field. Phone/email are optional: when an email is supplied the existing invitation
// flow can create a login; a contact-less roster member still contributes to staffing/capacity.
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +919876543210");

export const createSalonStaffSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  phone: e164PhoneSchema.optional(),
  email: z.string().trim().email().optional(),
});
export type CreateSalonStaffInput = z.infer<typeof createSalonStaffSchema>;

// Phase 17 (Barber Professional Profile) — bio/photoUrl accept '' as an explicit "clear this
// field" signal (SalonStaffService maps '' -> null); omitting the key entirely means "leave
// unchanged", same convention as every other partial-update schema in this file.
export const updateSalonStaffSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    status: z.nativeEnum(StaffMemberStatus).optional(),
    bio: z.string().trim().max(500).optional(),
    photoUrl: z.union([salonPhotoUrlSchema, z.literal("")]).optional(),
    yearsExperience: z.number().int().min(0).max(80).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateSalonStaffInput = z.infer<typeof updateSalonStaffSchema>;

// PATCH dashboard/salons/:salonId/profile (Part 2, admin delegated shop management) — the one
// place either the real owner or a PLATFORM_ADMIN acting on their behalf can correct a shop's
// basic identity/contact details after registration; no such endpoint existed before this. Every
// field is safe to change post-registration without breaking a URL or a data-integrity invariant
// elsewhere in the schema. Deliberately excludes: slug, cityId/localityId, publicId, ownerUserId,
// status (each is either immutable in practice or already has its own dedicated, purpose-built,
// more carefully-gated endpoint — timezone/currency via updateSalonTimezoneSchema, status via
// updateSalonStatusSchema above). '' clears an optional field, same convention as
// updateSalonStaffSchema's bio/photoUrl; postalCode's real per-country shape (SalonProfileService
// re-validates via isValidPostalCode against the salon's actual stored country, the same
// "shape-only here, real check server-side" split updateSalonTimezoneSchema already uses).
export const updateSalonProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    phone: z
      .union([z.string().trim().min(1).max(20), z.literal("")])
      .optional(),
    email: z.union([z.string().trim().email(), z.literal("")]).optional(),
    addressLine: z.string().trim().min(1).max(300).optional(),
    postalCode: z.union([z.string().trim().max(12), z.literal("")]).optional(),
    description: z
      .union([z.string().trim().max(2000), z.literal("")])
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });
export type UpdateSalonProfileInput = z.infer<typeof updateSalonProfileSchema>;

// Owner-proposed coordinates remain private and do not alter public Salon.lat/lng until a
// different, authorized PLATFORM_ADMIN approves the proposal.
export const submitSalonLocationProposalSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  source: z.enum([
    SalonLocationSource.GPS,
    SalonLocationSource.MAP_PIN,
    SalonLocationSource.MANUAL,
  ]),
});
export type SubmitSalonLocationProposalInput = z.infer<
  typeof submitSalonLocationProposalSchema
>;

export const decideSalonLocationProposalSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().min(3).max(500),
});
export type DecideSalonLocationProposalInput = z.infer<
  typeof decideSalonLocationProposalSchema
>;

// POST dashboard/salons/:salonId/contacts/preview. The preview is bounded and transient; it
// intentionally does not accept names or account identifiers and never authorizes invitations.
export const salonContactImportPreviewSchema = z
  .object({
    contacts: z
      .array(
        z
          .object({
            phone: z.string().trim().min(1).max(40),
            consent: z
              .object({
                granted: z.boolean(),
                source: z.nativeEnum(ContactConsentSource).optional(),
                capturedAt: z.string().datetime({ offset: true }).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict();
export type SalonContactImportPreviewInput = z.infer<
  typeof salonContactImportPreviewSchema
>;

// PATCH dashboard/salons/:salonId/status — owner self-activation. Deliberately restricted to
// ACTIVE/SUSPENDED: an owner may open or pause their own shop, but cannot move it back to
// PENDING (a moderation state owned by the platform, not the shop).
export const updateSalonStatusSchema = z.object({
  status: z.enum([SalonStatus.ACTIVE, SalonStatus.SUSPENDED]),
});
export type UpdateSalonStatusInput = z.infer<typeof updateSalonStatusSchema>;

// PATCH dashboard/salons/:salonId/timezone — owner-set IANA timezone (Global timezone
// correctness). Real validity (a name Intl actually recognizes, e.g. "Asia/Kolkata" not
// "IST"/"UTC+5:30") can only be checked with Intl.DateTimeFormat, which isn't available inside a
// zod schema in a platform-portable way — this only checks shape (non-empty, plausible
// "Area/Location" form); SalonTimezoneService.updateTimezone is the real, server-side authority via
// isValidTimeZone, and rejects anything this shape check lets through but Intl doesn't recognize.
export const updateSalonTimezoneSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(
      /^[A-Za-z0-9_+-]+\/[A-Za-z0-9_+\-/]+$/,
      "Enter a valid IANA time zone, e.g. Asia/Kolkata",
    ),
});
export type UpdateSalonTimezoneInput = z.infer<
  typeof updateSalonTimezoneSchema
>;

// POST premium/dev/activate — dev/test-only Premium activation for the calling user. The backend
// route itself is unreachable outside a non-production environment (see PremiumController); this
// schema only validates shape, not who's allowed to call it.
export const devActivatePremiumSchema = z.object({
  planId: z.enum(PREMIUM_PLAN_IDS),
});
export type DevActivatePremiumInput = z.infer<typeof devActivatePremiumSchema>;

// ---------- Ratings & Reviews (Phase 16) ----------

// POST reviews — one review per booking (Review.bookingId is @unique; ReviewsService's own
// re-check gives a friendlier ALREADY_REVIEWED error before the DB constraint would).
export const createReviewSchema = z.object({
  bookingId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

// PATCH reviews/:id — both fields optional (edit just the rating, or just the comment), but at
// least one must actually change something, same convention as updateSalonStaffSchema above.
export const updateReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.rating !== undefined || v.comment !== undefined, {
    message: "No fields to update",
  });
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;

// PUT dashboard/salons/:salonId/reviews/:reviewId/response — owner's reply. Required non-empty:
// an owner clearing a response entirely isn't a real use case worth a separate DELETE route.
export const respondToReviewSchema = z.object({
  ownerResponse: z.string().trim().min(1).max(1000),
});
export type RespondToReviewInput = z.infer<typeof respondToReviewSchema>;

// Salon owners may publish links to their own external review profiles. These links are never
// fetched server-side in V1. Exact-host checks prevent lookalike domains and open redirects.
const reviewProfileHosts = {
  google: new Set([
    "g.page",
    "maps.app.goo.gl",
    "maps.google.com",
    "google.com",
    "www.google.com",
  ]),
  facebook: new Set([
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "fb.com",
    "www.fb.com",
    "fb.me",
  ]),
  instagram: new Set(["instagram.com", "www.instagram.com"]),
} as const;

export type ReviewProfileProvider = keyof typeof reviewProfileHosts;

export function isValidReviewProfileUrl(
  provider: ReviewProfileProvider,
  value: string,
): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !reviewProfileHosts[provider].has(url.hostname.toLowerCase()) ||
      [...url.searchParams.keys()].some((key) =>
        /^(access_token|token|api_key|key|code)$/i.test(key),
      )
    ) {
      return false;
    }
    if (
      provider === "google" &&
      ["google.com", "www.google.com"].includes(url.hostname.toLowerCase()) &&
      !/^\/(maps|search)(\/|$)/i.test(url.pathname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const reviewProfileUrlSchema = (provider: ReviewProfileProvider) =>
  z
    .string()
    .trim()
    .min(1)
    .max(500)
    .url()
    .refine((value) => isValidReviewProfileUrl(provider, value), {
      message: "Use a secure HTTPS link for the matching provider.",
    })
    .transform((value) => new URL(value).toString());

// PUT dashboard/salons/:salonId/review-profiles. Omitted fields remain unchanged; null clears a
// previously configured link. An empty object is rejected to avoid accidental no-op writes.
export const updateReviewProfilesSchema = z
  .object({
    googleUrl: reviewProfileUrlSchema("google").nullable().optional(),
    facebookUrl: reviewProfileUrlSchema("facebook").nullable().optional(),
    instagramUrl: reviewProfileUrlSchema("instagram").nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one review profile field is required.",
  });
export type UpdateReviewProfilesInput = z.infer<
  typeof updateReviewProfilesSchema
>;

// ---------- Verification (Phase 18) ----------

// POST dashboard/salons/:salonId/verification and .../staff/:staffId/verification — evidence is
// free text plus a bounded list of already-hosted https links (salonPhotoUrlSchema), never a file
// upload (no object storage configured — same convention as Salon photos/SalonStaff.photoUrl).
// Both fields optional individually, but at least one must carry real content: a request with
// neither notes nor links gives the reviewing admin nothing to actually review.
export const submitVerificationSchema = z
  .object({
    evidenceNotes: z.string().trim().max(2000).optional(),
    evidenceUrls: z.array(salonPhotoUrlSchema).max(10).optional(),
  })
  .refine(
    (v) => !!v.evidenceNotes || (v.evidenceUrls && v.evidenceUrls.length > 0),
    {
      message: "Add a note or at least one evidence link",
    },
  );
export type SubmitVerificationInput = z.infer<typeof submitVerificationSchema>;

// POST admin/verification/:id/decide — reviewNotes required on REJECTED (the owner needs to know
// what to fix before resubmitting); optional on APPROVED.
export const decideVerificationSchema = z
  .object({
    decision: z.enum([
      VerificationStatus.APPROVED,
      VerificationStatus.REJECTED,
    ]),
    reviewNotes: z.string().trim().max(1000).optional(),
  })
  .refine(
    (v) => v.decision !== VerificationStatus.REJECTED || !!v.reviewNotes,
    {
      message: "A reason is required when rejecting a verification request",
      path: ["reviewNotes"],
    },
  );
export type DecideVerificationInput = z.infer<typeof decideVerificationSchema>;

// POST admin/credits/grant (AdminCreditsController, PLATFORM_ADMIN-only) — see
// schema.prisma's CreditTransactionType.PROMO_GRANT doc comment: this is the ONLY way new
// spendable credit enters a customer's wallet (besides a redemption restoration), and it is never
// exposed to a customer-facing route. `reason` is required — an admin must always say why a grant
// happened. The request's own Idempotency-Key header (not a body field) is what the backend
// persists onto the created transaction row, so there is exactly one source of truth for "was
// this exact grant already made" — see AdminCreditsController.
export const grantPromotionalCreditsSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().finite().positive().multipleOf(0.01),
  reason: z.string().trim().min(1).max(500),
  campaignRef: z.string().trim().min(1).max(200).optional(),
  fundingSource: z
    .nativeEnum(CreditFundingSource)
    .default(CreditFundingSource.FASTQUE_FUNDED),
  // ISO 8601 — must be strictly in the future if provided; enforced again server-side, not just
  // here, since a client clock can't be trusted for a hard business rule.
  expiresAt: z.string().datetime().optional(),
});
export type GrantPromotionalCreditsInput = z.infer<
  typeof grantPromotionalCreditsSchema
>;

// First-party FastQue visitor registration. The browser-generated UUID is never stored raw in the
// database; the backend hashes it before persistence. This endpoint records one durable unique
// browser/device visitor, not every page view.
export const siteVisitSchema = z.object({
  visitorId: z.string().uuid(),
});
export type SiteVisitInput = z.infer<typeof siteVisitSchema>;

// POST dashboard/salons/:salonId/description/suggestions. Salon identity and catalog facts are
// loaded by the backend after authorization; caller-supplied highlights are owner attestations.
export const salonDescriptionSuggestionSchema = z
  .object({
    language: z.enum(["en", "hi"]).default("en"),
    tone: z
      .enum(["professional", "friendly", "premium"])
      .default("professional"),
    ownerAttestedHighlights: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(SALON_DESCRIPTION_SUGGESTION_LIMITS.maxHighlightLength),
      )
      .max(SALON_DESCRIPTION_SUGGESTION_LIMITS.maxHighlights)
      .default([]),
  })
  .strict();
export type SalonDescriptionSuggestionInput = z.infer<
  typeof salonDescriptionSuggestionSchema
>;
