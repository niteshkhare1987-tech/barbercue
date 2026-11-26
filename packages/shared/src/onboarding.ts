import { z } from "zod";

// Employee-to-admin salon onboarding. Field employees fill an 8-step application; admins review,
// approve (creating the PENDING master Salon and an owner invitation), and separately authorize
// publication. Validation lives here so the server's submit check and the wizard's review step
// can never disagree about what is missing.
//
// Employee (FIELD_EXECUTIVE):
//   POST   employee/onboarding                              direct onboarding (creates the lead too)
//   POST   employee/leads/:id/onboarding                    convert an existing lead
//   GET    employee/onboarding?bucket=                      own + territory-shared applications
//   GET    employee/onboarding/counts                       counts per tab bucket
//   GET    employee/onboarding/:id
//   PATCH  employee/onboarding/:id                          save draft (DRAFT / CHANGES_REQUESTED only)
//   PUT    employee/onboarding/:id/services                 replace the service list
//   POST   employee/onboarding/:id/media                    multipart `image` + `category`
//   DELETE employee/onboarding/:id/media/:mediaId
//   GET    employee/onboarding/:id/media/:mediaId/file      authenticated private file
//   POST   employee/onboarding/:id/media/:mediaId/extract   AI menu extraction (unconfirmed rows)
//   POST   employee/onboarding/:id/submit                   server-validated submit / resubmit
//   GET    employee/onboarding/analytics
// Admin: admin/onboarding[...]; see ADMIN_PATHS and the backend AdminOnboardingController.

export const OnboardingStatus = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  RESUBMITTED: "RESUBMITTED",
  REJECTED: "REJECTED",
  APPROVED: "APPROVED",
  OWNER_INVITED: "OWNER_INVITED",
  AWAITING_OWNER_ACTIVATION: "AWAITING_OWNER_ACTIVATION",
  READY_TO_PUBLISH: "READY_TO_PUBLISH",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;
export type OnboardingStatus = (typeof OnboardingStatus)[keyof typeof OnboardingStatus];

export const OnboardingGender = { MEN: "MEN", WOMEN: "WOMEN", UNISEX: "UNISEX" } as const;
export type OnboardingGender = (typeof OnboardingGender)[keyof typeof OnboardingGender];

export const OnboardingSalonKind = {
  BARBER_SHOP: "BARBER_SHOP",
  BEAUTY_SALON: "BEAUTY_SALON",
  UNISEX_SALON: "UNISEX_SALON",
  SPA: "SPA",
  OTHER: "OTHER",
} as const;
export type OnboardingSalonKind = (typeof OnboardingSalonKind)[keyof typeof OnboardingSalonKind];

export const OnboardingMediaCategory = {
  EXTERIOR: "EXTERIOR",
  INTERIOR: "INTERIOR",
  STATIONS: "STATIONS",
  RECEPTION: "RECEPTION",
  LOGO: "LOGO",
  MENU: "MENU",
  OTHER: "OTHER",
  // CRM 2.0 capture slots
  ENTRANCE: "ENTRANCE",
  INTERIOR_LEFT: "INTERIOR_LEFT",
  INTERIOR_RIGHT: "INTERIOR_RIGHT",
  WASH_STATIONS: "WASH_STATIONS",
  WAITING_AREA: "WAITING_AREA",
  EQUIPMENT: "EQUIPMENT",
  RETAIL_DISPLAY: "RETAIL_DISPLAY",
  BARBER_PORTRAIT: "BARBER_PORTRAIT",
  CONSENT_EVIDENCE: "CONSENT_EVIDENCE",
} as const;
export type OnboardingMediaCategory =
  (typeof OnboardingMediaCategory)[keyof typeof OnboardingMediaCategory];

/** Categories that count as "a relevant shop photo" for submission. */
export const ONBOARDING_SHOP_PHOTO_CATEGORIES: readonly OnboardingMediaCategory[] = [
  "EXTERIOR",
  "INTERIOR",
  "STATIONS",
  "RECEPTION",
  "ENTRANCE",
  "INTERIOR_LEFT",
  "INTERIOR_RIGHT",
  "WASH_STATIONS",
  "WAITING_AREA",
];

/** Photo capture slots in the order the field wizard shows them. */
export const ONBOARDING_PHOTO_SLOTS: ReadonlyArray<{ category: OnboardingMediaCategory; label: string; hint: string }> = [
  { category: "EXTERIOR", label: "Shop exterior", hint: "Whole shop front from across the street" },
  { category: "ENTRANCE", label: "Entrance & signage", hint: "Door and the name board" },
  { category: "RECEPTION", label: "Reception", hint: "Front desk or billing counter" },
  { category: "INTERIOR_LEFT", label: "Left interior corner", hint: "Stand at the door, photograph the left corner" },
  { category: "INTERIOR_RIGHT", label: "Right interior corner", hint: "Stand at the door, photograph the right corner" },
  { category: "STATIONS", label: "Styling chairs", hint: "Working chairs and mirrors" },
  { category: "WASH_STATIONS", label: "Hair wash stations", hint: "Wash basins / chairs" },
  { category: "WAITING_AREA", label: "Waiting area", hint: "Where customers wait" },
  { category: "EQUIPMENT", label: "Equipment", hint: "Steamers, dryers, tools" },
  { category: "RETAIL_DISPLAY", label: "Retail / product display", hint: "Products for sale" },
  { category: "INTERIOR", label: "Other interior", hint: "Any other inside view" },
  { category: "LOGO", label: "Logo", hint: "The logo, if there is one" },
  { category: "BARBER_PORTRAIT", label: "Barber portraits", hint: "Add individual portraits with each barber's permission. These stay in the onboarding record." },
  { category: "CONSENT_EVIDENCE", label: "Owner consent evidence", hint: "Upload a photo of the signed consent form or a screenshot of the owner's WhatsApp or SMS approval. This evidence stays private in the onboarding record." },
  { category: "OTHER", label: "Miscellaneous", hint: "Anything else useful" },
];

/** GPS fixes worse than this are flagged and the employee is asked to recapture. */
export const ONBOARDING_GPS_GOOD_ACCURACY_METERS = 50;
export const ONBOARDING_CONSENT_METHODS = ["SIGNED_FORM_PHOTO", "WHATSAPP_CONFIRMATION", "OWNER_ACCOUNT_ACTIVATION", "IN_PERSON_WITH_WITNESS"] as const;
export type OnboardingConsentMethod = (typeof ONBOARDING_CONSENT_METHODS)[number];
export const ONBOARDING_CONSENT_METHOD_LABEL: Record<OnboardingConsentMethod, string> = {
  SIGNED_FORM_PHOTO: "Signed consent form (photo attached)",
  WHATSAPP_CONFIRMATION: "Owner confirmed on WhatsApp / SMS",
  OWNER_ACCOUNT_ACTIVATION: "Owner will confirm by activating their FastQue account",
  IN_PERSON_WITH_WITNESS: "In person, with a named witness",
};
export const ONBOARDING_AMENITIES = ["parking", "waitingArea", "wifi", "airConditioning", "wheelchairAccess", "cardPayments", "upiPayments", "cashPayments"] as const;
export const ONBOARDING_AMENITY_LABEL: Record<(typeof ONBOARDING_AMENITIES)[number], string> = {
  parking: "Parking", waitingArea: "Waiting area", wifi: "Wi-Fi", airConditioning: "Air conditioning", wheelchairAccess: "Wheelchair accessible",
  cardPayments: "Card payments", upiPayments: "UPI payments", cashPayments: "Cash",
};

export const OnboardingPriceType = { FIXED: "FIXED", STARTS_FROM: "STARTS_FROM" } as const;
export type OnboardingPriceType = (typeof OnboardingPriceType)[keyof typeof OnboardingPriceType];

export const OnboardingServiceSource = { MANUAL: "MANUAL", AI_EXTRACTED: "AI_EXTRACTED" } as const;
export type OnboardingServiceSource =
  (typeof OnboardingServiceSource)[keyof typeof OnboardingServiceSource];

export const OnboardingInvitationStatus = {
  PENDING: "PENDING",
  SENT: "SENT",
  CAPTURED_DEV: "CAPTURED_DEV",
  FAILED: "FAILED",
  DELIVERY_UNAVAILABLE: "DELIVERY_UNAVAILABLE",
  ACCEPTED: "ACCEPTED",
  REVOKED: "REVOKED",
} as const;
export type OnboardingInvitationStatus =
  (typeof OnboardingInvitationStatus)[keyof typeof OnboardingInvitationStatus];

export const OnboardingErrorCode = {
  NOT_FOUND: "ONBOARDING_NOT_FOUND",
  ACTIVATION_DISABLED: "ONBOARDING_ACTIVATION_DISABLED",
  NOT_EDITABLE: "ONBOARDING_NOT_EDITABLE",
  INVALID_TRANSITION: "ONBOARDING_INVALID_TRANSITION",
  INCOMPLETE: "ONBOARDING_INCOMPLETE",
  VERSION_CONFLICT: "ONBOARDING_VERSION_CONFLICT",
  LEAD_ALREADY_CONVERTED: "ONBOARDING_LEAD_ALREADY_CONVERTED",
  SELF_REVIEW_FORBIDDEN: "ONBOARDING_SELF_REVIEW_FORBIDDEN",
  CITY_NOT_SUPPORTED: "ONBOARDING_CITY_NOT_SUPPORTED",
  OWNER_IDENTITY_CONFLICT: "ONBOARDING_OWNER_IDENTITY_CONFLICT",
  OWNER_ACCOUNT_UNAVAILABLE: "ONBOARDING_OWNER_ACCOUNT_UNAVAILABLE",
  CONSENT_REQUIRED: "ONBOARDING_CONSENT_REQUIRED",
  NOT_READY_TO_PUBLISH: "ONBOARDING_NOT_READY_TO_PUBLISH",
  PUBLISH_NOT_AUTHORIZED: "ONBOARDING_PUBLISH_NOT_AUTHORIZED",
  MEDIA_INVALID: "ONBOARDING_MEDIA_INVALID",
  MEDIA_LIMIT: "ONBOARDING_MEDIA_LIMIT",
  MEDIA_DUPLICATE: "ONBOARDING_MEDIA_DUPLICATE",
  STORAGE_NOT_CONFIGURED: "ONBOARDING_STORAGE_NOT_CONFIGURED",
  AI_NOT_CONFIGURED: "ONBOARDING_AI_NOT_CONFIGURED",
  AI_FAILED: "ONBOARDING_AI_FAILED",
  INVITATION_NOT_RETRYABLE: "ONBOARDING_INVITATION_NOT_RETRYABLE",
} as const;

export const ONBOARDING_MEDIA_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFilesPerApplication: 30,
  acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"] as readonly string[],
} as const;

export const ONBOARDING_INVITE_DEFAULT_TTL_HOURS = 72;

// ---------- Employee tab buckets ----------

export const OnboardingBucket = {
  DRAFTS: "drafts",
  PENDING: "pending",
  CHANGES: "changes",
  APPROVED: "approved",
  ACTIVATED: "activated",
  REJECTED: "rejected",
} as const;
export type OnboardingBucket = (typeof OnboardingBucket)[keyof typeof OnboardingBucket];

export const ONBOARDING_BUCKET_STATUSES: Record<OnboardingBucket, readonly OnboardingStatus[]> = {
  drafts: ["DRAFT"],
  pending: ["SUBMITTED", "UNDER_REVIEW", "RESUBMITTED"],
  changes: ["CHANGES_REQUESTED"],
  approved: ["APPROVED", "OWNER_INVITED", "AWAITING_OWNER_ACTIVATION", "READY_TO_PUBLISH"],
  activated: ["ACTIVE", "SUSPENDED"],
  rejected: ["REJECTED"],
};

export const ONBOARDING_BUCKET_LABELS: Record<OnboardingBucket, string> = {
  drafts: "My Drafts",
  pending: "Pending Review",
  changes: "Changes Requested",
  approved: "Approved",
  activated: "Activated",
  rejected: "Rejected",
};

export function onboardingBucketFor(status: OnboardingStatus): OnboardingBucket {
  for (const [bucket, statuses] of Object.entries(ONBOARDING_BUCKET_STATUSES)) {
    if (statuses.includes(status)) return bucket as OnboardingBucket;
  }
  return "drafts";
}

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  CHANGES_REQUESTED: "Changes requested",
  RESUBMITTED: "Resubmitted",
  REJECTED: "Rejected",
  APPROVED: "Approved",
  OWNER_INVITED: "Owner invited",
  AWAITING_OWNER_ACTIVATION: "Awaiting owner activation",
  READY_TO_PUBLISH: "Ready to publish",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

/** Statuses in which the assigned employee may edit. Everything else is read-only to them. */
export const ONBOARDING_EMPLOYEE_EDITABLE: readonly OnboardingStatus[] = ["DRAFT", "CHANGES_REQUESTED"];
/** Statuses an admin may approve / reject / request changes from. */
export const ONBOARDING_REVIEWABLE: readonly OnboardingStatus[] = ["SUBMITTED", "UNDER_REVIEW", "RESUBMITTED"];
/** Statuses where the admin-approved salon exists (approval happened). */
export const ONBOARDING_APPROVED_STATUSES: readonly OnboardingStatus[] = [
  "APPROVED",
  "OWNER_INVITED",
  "AWAITING_OWNER_ACTIVATION",
  "READY_TO_PUBLISH",
  "ACTIVE",
  "SUSPENDED",
];

// ---------- Normalizers ----------

/**
 * Indian mobile numbers only: accepts "9999221320", "09999221320", "+91 99992 21320" and returns
 * "+919999221320" (the E.164 form User.phone uses), or null when it is not a valid Indian mobile.
 */
export function normalizeIndianMobile(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let digits = value.replace(/[\s()-]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** Duplicate-merging identity for a service row: case/punctuation-insensitive name + gender. */
export function onboardingServiceKey(name: string, gender: OnboardingGender | null | undefined): string {
  const base = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `${base}|${gender ?? "ANY"}`.slice(0, 160);
}

export function normalizeSalonNameForMatch(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---------- Schemas ----------

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optUrl = z
  .string()
  .trim()
  .max(1000)
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), "Enter a full link starting with https://")
  .nullable()
  .optional();

const optMobile = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const normalized = normalizeIndianMobile(v);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit Indian mobile number" });
      return z.NEVER;
    }
    return normalized;
  })
  .nullable()
  .optional();

const optEmail = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => (v === "" ? null : v))
  .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email address")
  .nullable()
  .optional();

const optCount = (max: number) => z.number().int().min(0).max(max).nullable().optional();

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm");

export const onboardingHoursRowSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    isClosed: z.boolean(),
    opensAt: timeOfDay.nullable().optional(),
    closesAt: timeOfDay.nullable().optional(),
  })
  .superRefine((row, ctx) => {
    if (row.isClosed) return;
    if (!row.opensAt || !row.closesAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Opening and closing time are required for an open day" });
    } else if (row.opensAt === row.closesAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Opening and closing time cannot be the same" });
    }
  });
export type OnboardingHoursRowInput = z.infer<typeof onboardingHoursRowSchema>;

/** A closing time earlier than the opening time means the salon closes after midnight. */
export function onboardingClosesNextDay(opensAt: string, closesAt: string): boolean {
  return closesAt < opensAt;
}

/** Every field optional: a draft may be saved at any point without losing information. */
export const onboardingDraftSchema = z
  .object({
    salonName: z.string().trim().min(1, "Salon name is required").max(160).optional(),
    genderCategory: z.nativeEnum(OnboardingGender).nullable().optional(),
    salonKind: z.nativeEnum(OnboardingSalonKind).nullable().optional(),
    description: optText(2000),
    brandName: optText(160),
    websiteUrl: optUrl,
    instagramUrl: optUrl,
    mapsUrl: optUrl,
    isFranchise: z.boolean().nullable().optional(),
    branchCount: z.number().int().min(1).max(10000).nullable().optional(),

    ownerName: optText(160),
    ownerPhone: optMobile,
    ownerWhatsapp: optMobile,
    ownerEmail: optEmail,
    alternatePhone: optMobile,
    managerName: optText(160),
    managerPhone: optMobile,
    preferredLanguage: optText(40),

    shopNumber: optText(60),
    buildingName: optText(160),
    streetAddress: optText(300),
    locality: optText(160),
    city: optText(120),
    district: optText(120),
    state: optText(120),
    postalCode: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .refine((v) => v === null || /^[1-9]\d{5}$/.test(v), "PIN code must be 6 digits")
      .nullable()
      .optional(),
    country: optText(80),
    landmark: optText(200),
    // Coordinates only travel together with an explicit source (GPS permission or a map pin);
    // nothing is geocoded from text.
    coordinates: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        source: z.enum(["GPS", "MAP_PIN", "MANUAL"]),
        /** Device-reported accuracy (metres) for a GPS fix. */
        accuracyMeters: z.number().min(0).max(100000).nullable().optional(),
      })
      .nullable()
      .optional(),
    /** The employee confirmed the pin is at the salon entrance. */
    locationVerified: z.boolean().optional(),

    employeeCount: optCount(5000),
    chairCount: optCount(1000),
    activeChairCount: optCount(1000),
    maleStaffCount: optCount(5000),
    femaleStaffCount: optCount(5000),
    walkInsAccepted: z.boolean().nullable().optional(),
    bookingsAccepted: z.boolean().nullable().optional(),
    liveQueueSupported: z.boolean().nullable().optional(),
    appointmentIntervalMinutes: z.number().int().min(5).max(240).nullable().optional(),
    averageServiceMinutes: z.number().int().min(1).max(600).nullable().optional(),
    specialTimings: optText(1000),
    hours: z.array(onboardingHoursRowSchema).max(7).optional(),
    washStationCount: optCount(500),
    weeklyHolidays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    amenities: z.array(z.enum(ONBOARDING_AMENITIES)).max(ONBOARDING_AMENITIES.length).optional(),
    qrInstallReady: z.boolean().nullable().optional(),
    inventoryInterest: z.boolean().nullable().optional(),
    ownerTrainingStatus: z.enum(["NOT_STARTED", "SCHEDULED", "COMPLETED"]).nullable().optional(),

    consentContact: z.boolean().optional(),
    consentListing: z.boolean().optional(),
    consentAccuracy: z.boolean().optional(),
    consentAuthorization: z.boolean().optional(),
    consentMethod: z.enum(ONBOARDING_CONSENT_METHODS).nullable().optional(),
    consentByName: optText(120),
    consentByRole: optText(40),
    /** e.g. WhatsApp message time, witness name/phone, or the id of the signed-form photo. */
    consentEvidenceNote: optText(500),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .transform((v) => (v === "" ? null : v))
      .refine(
        (v) => v === null || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v),
        "GSTIN must be 15 characters, e.g. 09ABCDE1234F1Z5",
      )
      .nullable()
      .optional(),
    businessRegistration: optText(200),
    employeeNotes: optText(2000),
    openQuestions: optText(2000),

    /** Optimistic concurrency: the version the client last loaded. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.hours) {
      const days = new Set(value.hours.map((h) => h.dayOfWeek));
      if (days.size !== value.hours.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hours"], message: "Each day may appear only once" });
      }
    }
    if (
      value.activeChairCount != null &&
      value.chairCount != null &&
      value.activeChairCount > value.chairCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeChairCount"],
        message: "Active chairs cannot exceed total chairs",
      });
    }
  });
export type OnboardingDraftInput = z.infer<typeof onboardingDraftSchema>;

export const createOnboardingSchema = onboardingDraftSchema.innerType().extend({
  salonName: z.string().trim().min(1, "Salon name is required").max(160),
});
export type CreateOnboardingInput = z.infer<typeof createOnboardingSchema>;

const money = z.number().min(0).max(1_000_000).multipleOf(0.01);

export const onboardingServiceRowSchema = z
  .object({
    id: z.string().uuid().optional(),
    serviceName: z.string().trim().min(1, "Service name is required").max(120),
    category: optText(80),
    applicableGender: z.nativeEnum(OnboardingGender).nullable().optional(),
    basePrice: money.nullable().optional(),
    priceType: z.nativeEnum(OnboardingPriceType).default("FIXED"),
    discountedPrice: money.nullable().optional(),
    durationMinutes: z.number().int().min(1).max(600).nullable().optional(),
    description: optText(500),
    isActive: z.boolean().default(true),
    sourceType: z.nativeEnum(OnboardingServiceSource).default("MANUAL"),
    sourceMediaId: z.string().uuid().nullable().optional(),
    sourcePage: z.number().int().min(1).max(100).nullable().optional(),
    extractionConfidence: z.number().min(0).max(1).nullable().optional(),
    uncertainFields: z.array(z.string().max(40)).max(10).optional(),
    confirmedByEmployee: z.boolean().default(false),
  })
  .strict()
  .refine(
    (row) => row.discountedPrice == null || row.basePrice == null || row.discountedPrice <= row.basePrice,
    { path: ["discountedPrice"], message: "Discounted price cannot exceed the price" },
  );
export type OnboardingServiceRowInput = z.input<typeof onboardingServiceRowSchema>;

export const replaceOnboardingServicesSchema = z
  .object({
    services: z.array(onboardingServiceRowSchema).max(300),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type ReplaceOnboardingServicesInput = z.infer<typeof replaceOnboardingServicesSchema>;

export const onboardingMediaUploadMetaSchema = z.object({
  category: z.nativeEnum(OnboardingMediaCategory),
  // Private capture metadata (with the employee's permission); never published, never the salon location.
  capturedAt: z.string().datetime({ offset: true }).optional(),
  captureLatitude: z.coerce.number().min(-90).max(90).optional(),
  captureLongitude: z.coerce.number().min(-180).max(180).optional(),
  captureAccuracy: z.coerce.number().min(0).max(100000).optional(),
});

export const onboardingListQuerySchema = z.object({
  bucket: z.nativeEnum(OnboardingBucket).optional(),
});

export const adminOnboardingListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.nativeEnum(OnboardingStatus).optional(),
  city: z.string().trim().max(120).optional(),
  territory: z.string().trim().max(120).optional(),
  employeeId: z.string().uuid().optional(),
  reviewerId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  missingInfo: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminOnboardingListQuery = z.infer<typeof adminOnboardingListQuerySchema>;

export const onboardingRequestChangesSchema = z
  .object({
    items: z
      .array(
        z.object({
          field: z.string().trim().min(1).max(60),
          message: z.string().trim().min(3, "Say what needs correcting").max(500),
        }),
      )
      .min(1, "List at least one item that needs correction")
      .max(30),
    comments: optText(2000),
    applicationVersion: z.number().int().min(1),
  })
  .strict();
export type OnboardingRequestChangesInput = z.infer<typeof onboardingRequestChangesSchema>;

export const onboardingRejectSchema = z
  .object({
    reason: z.string().trim().min(5, "Give a reason for the rejection").max(1000),
    applicationVersion: z.number().int().min(1),
  })
  .strict();
export type OnboardingRejectInput = z.infer<typeof onboardingRejectSchema>;

export const onboardingApproveSchema = z
  .object({
    notes: optText(2000),
    applicationVersion: z.number().int().min(1),
  })
  .strict();
export type OnboardingApproveInput = z.infer<typeof onboardingApproveSchema>;

export const onboardingNotesSchema = z.object({ internalNotes: z.string().trim().max(4000) }).strict();
export const onboardingAssignReviewerSchema = z.object({ reviewerId: z.string().uuid().nullable() }).strict();
export const onboardingPhotoExceptionSchema = z
  .object({ reason: z.string().trim().min(5).max(500).nullable() })
  .strict();
export const onboardingCorrectionSchema = z
  .object({
    changes: onboardingDraftSchema.innerType().omit({ expectedVersion: true, hours: true }).partial(),
    reason: z.string().trim().min(3, "Say why this correction is needed").max(1000),
    applicationVersion: z.number().int().min(1),
  })
  .strict();
export type OnboardingCorrectionInput = z.infer<typeof onboardingCorrectionSchema>;
export const onboardingSuspendSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();

// ---------- Missing-information check (shared by server submit and the wizard review step) ----------

export interface OnboardingCompletenessInput {
  salonName?: string | null;
  genderCategory?: string | null;
  salonKind?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  streetAddress?: string | null;
  locality?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  employeeCount?: number | null;
  chairCount?: number | null;
  consentContact?: boolean;
  consentListing?: boolean;
  consentAccuracy?: boolean;
  consentAuthorization?: boolean;
  consentMethod?: string | null;
  consentByName?: string | null;
  photoExceptionReason?: string | null;
  hours: Array<{ dayOfWeek: number; isClosed: boolean; opensAt?: string | null; closesAt?: string | null }>;
  services: Array<{
    serviceName: string;
    isActive: boolean;
    basePrice?: number | string | null;
    durationMinutes?: number | null;
    confirmedByEmployee: boolean;
  }>;
  media: Array<{ category: string }>;
}

export interface OnboardingMissingItem {
  field: string;
  step: number;
  message: string;
}

export const ONBOARDING_FIELD_LABELS: Record<string, string> = {
  salonName: "Salon name",
  genderCategory: "Salon category (Men / Women / Unisex)",
  salonKind: "Salon type",
  ownerName: "Owner's full name",
  ownerPhone: "Owner's mobile number",
  ownerEmail: "Owner's email",
  ownerWhatsapp: "WhatsApp number",
  streetAddress: "Street address",
  locality: "Locality",
  city: "City",
  district: "District",
  state: "State",
  postalCode: "PIN code",
  country: "Country",
  coordinates: "GPS coordinates",
  employeeCount: "Total employees",
  chairCount: "Total chairs",
  hours: "Opening hours",
  services: "Service menu",
  photos: "Shop photos",
  consent: "Owner consent",
  gstin: "GSTIN",
  description: "Description",
};

export function onboardingMissingFields(app: OnboardingCompletenessInput): OnboardingMissingItem[] {
  const missing: OnboardingMissingItem[] = [];
  const need = (ok: boolean, field: string, step: number, message?: string) => {
    if (!ok) missing.push({ field, step, message: message ?? `${ONBOARDING_FIELD_LABELS[field] ?? field} is required` });
  };
  const present = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

  need(present(app.salonName), "salonName", 1);
  need(present(app.genderCategory), "genderCategory", 1);
  need(present(app.salonKind), "salonKind", 1);

  need(present(app.ownerName), "ownerName", 2);
  need(!!normalizeIndianMobile(app.ownerPhone ?? null), "ownerPhone", 2, "A valid owner mobile number is required");

  need(present(app.streetAddress), "streetAddress", 3);
  need(present(app.locality), "locality", 3);
  need(present(app.city), "city", 3);
  need(present(app.state), "state", 3);
  need(present(app.postalCode) && /^[1-9]\d{5}$/.test(app.postalCode ?? ""), "postalCode", 3);
  need(present(app.country), "country", 3);

  need(typeof app.employeeCount === "number" && app.employeeCount > 0, "employeeCount", 4);
  need(typeof app.chairCount === "number" && app.chairCount > 0, "chairCount", 4);
  const openDays = app.hours.filter((h) => !h.isClosed);
  need(openDays.length > 0, "hours", 4, "Add opening hours for at least one day");
  if (openDays.some((h) => !h.opensAt || !h.closesAt)) {
    missing.push({ field: "hours", step: 4, message: "Every open day needs an opening and closing time" });
  }

  const active = app.services.filter((s) => s.isActive);
  need(active.length > 0, "services", 5, "Add at least one active service");
  const noPrice = active.filter((s) => s.basePrice === null || s.basePrice === undefined || s.basePrice === "");
  if (noPrice.length) {
    missing.push({ field: "services", step: 5, message: `Price missing for: ${noPrice.map((s) => s.serviceName).join(", ")}` });
  }
  const noDuration = active.filter((s) => !s.durationMinutes);
  if (noDuration.length) {
    missing.push({
      field: "services",
      step: 5,
      message: `Duration not confirmed for: ${noDuration.map((s) => s.serviceName).join(", ")}`,
    });
  }
  const unconfirmed = active.filter((s) => !s.confirmedByEmployee);
  if (unconfirmed.length) {
    missing.push({
      field: "services",
      step: 5,
      message: `Confirm these services after checking them: ${unconfirmed.map((s) => s.serviceName).join(", ")}`,
    });
  }

  const shopPhotos = app.media.filter((m) =>
    (ONBOARDING_SHOP_PHOTO_CATEGORIES as readonly string[]).includes(m.category),
  );
  need(
    shopPhotos.length > 0 || present(app.photoExceptionReason),
    "photos",
    6,
    "Upload at least one exterior, interior, stations or reception photo",
  );

  need(
    !!(app.consentContact && app.consentListing && app.consentAccuracy && app.consentAuthorization),
    "consent",
    7,
    "All four owner consent confirmations are required",
  );
  // A checkbox ticked by the employee is not proof on its own: record how the owner consented.
  need(present(app.consentMethod) && present(app.consentByName), "consent", 7, "Record how the owner gave consent and who gave it");
  return missing;
}

// ---------- DTOs ----------

export interface OnboardingHoursDto {
  dayOfWeek: number;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  closesNextDay: boolean;
}

export interface OnboardingServiceDto {
  id: string;
  serviceName: string;
  category: string | null;
  applicableGender: OnboardingGender | null;
  basePrice: number | null;
  priceType: OnboardingPriceType;
  discountedPrice: number | null;
  durationMinutes: number | null;
  description: string | null;
  isActive: boolean;
  sourceType: OnboardingServiceSource;
  sourceMediaId: string | null;
  sourcePage: number | null;
  extractionConfidence: number | null;
  uncertainFields: string[];
  confirmedByEmployee: boolean;
}

export interface OnboardingMediaDto {
  id: string;
  category: OnboardingMediaCategory;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  uploadedBy: string;
  createdAt: string;
  /** Authenticated API path (relative to the API base); never a public URL. */
  filePath: string;
  /** True when the photo was taken with the in-app camera and the phone shared its location. */
  gpsTagged: boolean;
  /** Private capture metadata — admin reviewers only (null for the employee audience). */
  capture: { capturedAt: string | null; latitude: number | null; longitude: number | null; accuracyMeters: number | null } | null;
}

export interface OnboardingStatusHistoryDto {
  previousStatus: OnboardingStatus | null;
  newStatus: OnboardingStatus;
  actorName: string | null;
  reason: string | null;
  createdAt: string;
}

export interface OnboardingReviewDto {
  id: string;
  reviewerName: string;
  decision: string;
  comments: string | null;
  details: unknown;
  applicationVersion: number;
  reviewedAt: string;
}

export interface OnboardingInvitationDto {
  id: string;
  status: OnboardingInvitationStatus;
  channel: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  expired: boolean;
}

export interface OnboardingApplicationDto {
  id: string;
  reference: string;
  version: number;
  status: OnboardingStatus;
  leadId: string;
  salonId: string | null;
  salonPublicId: string | null;
  assignedEmployee: { id: string; fullName: string; employeeCode: string };
  territory: string | null;
  reviewer: { id: string; name: string } | null;
  /** True when the caller may edit (assigned employee, editable status). */
  canEdit: boolean;

  salonName: string;
  genderCategory: OnboardingGender | null;
  salonKind: OnboardingSalonKind | null;
  description: string | null;
  brandName: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  mapsUrl: string | null;
  isFranchise: boolean | null;
  branchCount: number | null;

  ownerName: string | null;
  ownerPhone: string | null;
  ownerWhatsapp: string | null;
  ownerEmail: string | null;
  alternatePhone: string | null;
  managerName: string | null;
  managerPhone: string | null;
  preferredLanguage: string | null;

  shopNumber: string | null;
  buildingName: string | null;
  streetAddress: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  landmark: string | null;
  coordinates: { latitude: number; longitude: number; source: string; accuracyMeters: number | null; capturedAt: string | null } | null;
  locationVerified: boolean;

  employeeCount: number | null;
  chairCount: number | null;
  activeChairCount: number | null;
  maleStaffCount: number | null;
  femaleStaffCount: number | null;
  walkInsAccepted: boolean | null;
  bookingsAccepted: boolean | null;
  liveQueueSupported: boolean | null;
  appointmentIntervalMinutes: number | null;
  averageServiceMinutes: number | null;
  specialTimings: string | null;
  hours: OnboardingHoursDto[];
  washStationCount: number | null;
  weeklyHolidays: number[];
  amenities: string[];
  qrInstallReady: boolean | null;
  inventoryInterest: boolean | null;
  ownerTrainingStatus: string | null;

  consentContact: boolean;
  consentListing: boolean;
  consentAccuracy: boolean;
  consentAuthorization: boolean;
  consentCapturedAt: string | null;
  consentMethod: string | null;
  consentByName: string | null;
  consentByRole: string | null;
  consentEvidenceNote: string | null;
  gstin: string | null;
  businessRegistration: string | null;
  employeeNotes: string | null;
  openQuestions: string | null;

  services: OnboardingServiceDto[];
  media: OnboardingMediaDto[];
  missing: OnboardingMissingItem[];
  changeRequest: Array<{ field: string; message: string }> | null;
  rejectionReason: string | null;
  photoExceptionReason: string | null;

  firstSubmittedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  publishAuthorizedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOnboardingApplicationDto extends OnboardingApplicationDto {
  internalNotes: string | null;
  statusHistory: OnboardingStatusHistoryDto[];
  reviews: OnboardingReviewDto[];
  invitations: OnboardingInvitationDto[];
  ownerPhoneMasked: boolean;
  canDecide: boolean;
}

export interface OnboardingListItemDto {
  id: string;
  reference: string;
  salonName: string;
  city: string | null;
  locality: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  employee: { id: string; fullName: string; employeeCode: string };
  reviewer: { id: string; name: string } | null;
  status: OnboardingStatus;
  submittedAt: string | null;
  updatedAt: string;
  serviceCount: number;
  photoCount: number;
  missingCount: number;
}

export type OnboardingCountsDto = Record<OnboardingBucket, number>;

export interface AdminOnboardingListDto {
  items: OnboardingListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminOnboardingKpisDto {
  total: number;
  drafts: number;
  pendingReview: number;
  changesRequested: number;
  approved: number;
  rejected: number;
  awaitingOwnerActivation: number;
  activeSalons: number;
  averageReviewHours: number | null;
  pendingOver48Hours: number;
  byEmployee: Array<{ employeeId: string; fullName: string; employeeCode: string; total: number; approved: number }>;
  byCity: Array<{ city: string; total: number; approved: number }>;
}

export interface OnboardingDuplicateDto {
  kind: "SALON" | "APPLICATION" | "LEAD";
  id: string;
  label: string;
  reason: string;
  status: string | null;
}

export interface OnboardingPublishReadinessDto {
  ready: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail?: string }>;
}

export interface OnboardingApprovalResultDto {
  application: AdminOnboardingApplicationDto;
  salonId: string;
  ownerUserId: string;
  ownerLinkedExisting: boolean;
  invitation: OnboardingInvitationDto | null;
  /** Dev only: the invite link captured by the console email sender. Never present in production. */
  devInviteUrl?: string;
  servicesNeedingOwnerInput: string[];
  hoursNeedingOwnerInput: number[];
  alreadyApproved: boolean;
}

/** Six deliberately separate funnel definitions; an unapproved application is never "onboarded". */
export interface OnboardingFunnelDto {
  leadsCreated: number;
  visits: number;
  applicationsStarted: number;
  applicationsSubmitted: number;
  approved: number;
  rejected: number;
  ownerActivated: number;
  publiclyActive: number;
  receivingBookings: number;
  pendingCorrections: number;
  avgDaysSubmissionToApproval: number | null;
  avgDaysApprovalToActivation: number | null;
  conversionRate: number | null;
}

export interface AdminOnboardingAnalyticsDto {
  team: OnboardingFunnelDto;
  employees: Array<{ employeeId: string; fullName: string; employeeCode: string; territory: string | null } & OnboardingFunnelDto>;
}

export interface MenuExtractionResultDto {
  provider: string;
  added: number;
  mergedDuplicates: number;
  services: OnboardingServiceDto[];
}
