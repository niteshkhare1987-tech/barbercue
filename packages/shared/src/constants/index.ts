// Cross-cutting constants shared by the backend (route/controller definitions) and clients
// (URL construction) — kept here so the literal never has to be duplicated or drift between them.

// Matches the backend's HealthController's @Controller() path. Clients build the full URL as
// `${API_BASE_URL}/${HEALTH_PATH}`, where API_BASE_URL already includes the /api/v1 prefix.
export const HEALTH_PATH = 'health';

// Sub-paths under AuthController's `@Controller('auth')` prefix — used directly as `@Post(...)`
// decorator arguments on the backend, and as `${API_BASE_URL}/auth/${AUTH_PATHS.otpRequest}` on
// clients. Kept here so the literal path strings never drift between the two.
export const AUTH_PATHS = {
  otpRequest: 'otp/request',
  otpVerify: 'otp/verify',
  ownerOtpRequest: 'owner/otp/request',
  ownerOtpVerify: 'owner/otp/verify',
  ownerPhoneLinkRequest: 'owner/phone/link/request',
  ownerPhoneLinkVerify: 'owner/phone/link/verify',
  customerPhoneLinkRequest: 'customer/phone/link/request',
  customerPhoneLinkVerify: 'customer/phone/link/verify',
  google: 'google',
  staffLogin: 'staff/login',
  // Self-service shop-owner account creation before salon onboarding.
  ownerSignup: 'owner/signup',
  employeeLogin: 'employee/login',
  // Google Sign-In restricted to accounts that already hold SALON_OWNER and/or SALON_STAFF —
  // deliberately a separate endpoint from `google` above, not a shared one branching on a role
  // param: the two have opposite account-creation semantics (customer Google sign-in creates a
  // user on no match; this one must never create one), and keeping them physically separate
  // makes that difference impossible to blur by accident in either handler.
  staffGoogle: 'staff/google',
  adminLogin: 'admin/login',
  adminGoogle: 'admin/google',
  refresh: 'refresh',
  logout: 'logout',
  logoutAll: 'logout-all',
  sessions: 'sessions',
  forgotPassword: 'forgot-password',
  resetPassword: 'reset-password',
  initialPassword: 'password/initial',
  // DELETE auth/account — customer-only irreversible account deletion/anonymization. The server
  // derives the affected account entirely from the authenticated token; no user id is accepted.
  accountDeletion: 'account',
  me: 'me',
  // auth/methods — which sign-in methods this deployment can actually complete right now.
  // Booleans only; never echoes any configuration value.
  methods: 'methods',
  // PATCH auth/language (Phase 14) — sets User.preferredLanguage, returns the updated MeResponse.
  language: 'language',
} as const;

export const EMPLOYEE_PATHS = {
  employee: 'employee',
  me: 'me',
  dashboard: 'dashboard',
  leads: 'leads',
  visits: 'visits',
  followUps: 'follow-ups',
  onboard: 'onboard',
  voiceVisitLogs: 'voice-visit-logs',
  shop: 'shop',
} as const;

export const EMPLOYEE_RESERVED_ID_MIN = 1;
export const EMPLOYEE_RESERVED_ID_MAX = 100;
export const EMPLOYEE_STANDARD_ID_START = 101;

export const SITE_METRICS_PATHS = {
  siteMetrics: 'site-metrics',
  visit: 'visit',
} as const;

export const ADMIN_PATHS = {
  admin: 'admin',
  overview: 'overview',
  // admin/shop-activity?from=YYYY-MM-DD&to=YYYY-MM-DD — shop-wise bookings and live-queue counts
  // for an IST date range.
  shopActivity: 'shop-activity',
  // admin/analytics/overview?from&to — Executive Command Center (docs/admin-dashboard-2.0).
  analytics: 'analytics',
  // Phase 18 — admin/verification[/:id[/start-review|/decide]], the PLATFORM_ADMIN review queue.
  verification: 'verification',
  startReview: 'start-review',
  decide: 'decide',
  // admin/shops/:id (DELETE) — platform-admin shop removal, guarded server-side to only ever
  // succeed against a shop with zero bookings/staff/queue/reviews/ledger activity.
  shops: 'shops',
  status: 'status',
  // Super-admin-only internal access management for co-founders / HR / sales.
  access: 'access',
  locationVerifications: 'location-verifications',
  decision: 'decision',
  revoke: 'revoke',
  // FastQue internal field-team provisioning.
  employees: 'employees',
  password: 'password',
  special: 'special',
  // FastQue internal field CRM / sales-operations portal.
  crm: 'crm',
  leads: 'leads',
  visits: 'visits',
  followUps: 'follow-ups',
} as const;

// Proposed shop adoption thresholds (docs/admin-dashboard-2.0/PLAN.md §4) — business proposals, not
// industry standards. "Completed visits" = completed appointments + served walk-ins.
export const ADMIN_ADOPTION_THRESHOLDS = {
  windowDays: 30,
  recentlyOnboardedDays: 7,
  highlyActiveMinVisits: 20,
  moderatelyActiveMinVisits: 5,
  atRiskMinBaselineVisits: 10,
  atRiskDropPercent: 50,
} as const;

// The ONLY place this wording is allowed to live — every surface that shows a Verified badge
// imports this constant rather than writing its own copy, so the legally-sensitive distinction
// (evidence reviewed, not identity verified, not a quality guarantee) can never drift between web,
// mobile, and any future surface. Never replace with "Identity Verified" without an actual
// identity-verification/KYC process behind it.
export const VERIFICATION_BADGE_CAPTION =
  'Business/profile evidence reviewed by FastQue. Verification is not a guarantee of service quality.';

// Exact customer-facing copy for an owner-paused shop. Shared so web/mobile cannot drift.
export const SHOP_CLOSED_TODAY_MESSAGE = 'This shop is closed for today.';

// Name of the httpOnly cookie the backend sets/reads for web refresh-token delivery. Shared so
// the web app's fetch wrapper knows to send credentials, without needing to know the token value.
export const REFRESH_TOKEN_COOKIE_NAME = 'barbercue_refresh_token';

// Client-side "Resend OTP" cooldown, in seconds — a UI throttle only, purely to stop a user from
// mashing the button; it is deliberately shorter than OtpService's server-side per-phone rate
// limit (3 requests / 10 minutes, see otp.service.ts), which remains the real security boundary
// and is never touched by this constant. Shared so apps/web and apps/mobile can't drift apart.
export const OTP_RESEND_COOLDOWN_SECONDS = 45;

// Base segments for the public discovery API (CitiesController/SalonsController) — dynamic
// segments (:citySlug, :salonSlug, etc.) are interpolated at the call site, same pattern as
// HEALTH_PATH usage.
export const DISCOVERY_PATHS = {
  cities: 'cities',
  // cities/all — every city the platform operates in, unfiltered. Distinct from `cities`, which
  // deliberately lists only cities containing an ACTIVE salon (no dead-end SEO pages). Shop
  // registration needs the unfiltered list: filtering it would mean the first shop in a new city
  // could never be registered, because the city only becomes visible once such a shop is ACTIVE.
  allCities: 'all',
  // cities/search — Phase 6A's scalable Country -> Region -> City-search flow. Single literal
  // segment, same arity argument as `all` above: it can never be confused with the two-segment
  // :countryCode/:citySlug (B9) routes regardless of declaration order.
  citySearch: 'search',
  salons: 'salons',
  // salons/live-stats — Issue #13 Mission G. Single literal segment, same arity argument as
  // `mine`/`workplaces` below: registered before the three-segment :countryCode/:citySlug/
  // :salonSlug wildcard (B9) so it can never be shadowed by it regardless of declaration order.
  liveStats: 'live-stats',
  // salons/service-suggestions?q=... — public distinct active service names for the service-only
  // customer search typeahead. Never returns shop names.
  serviceSuggestions: 'service-suggestions',
  // Owner-scoped reads under salons/mine[/...] — literal 'mine' segment, registered before the
  // :citySlug/:salonSlug wildcard route in SalonsController so it can never be shadowed by it.
  mine: 'mine',
  // salons/workplaces — every salon the caller may operate, for owners AND staff. Distinct from
  // `mine`, which is owner-only and keyed on Salon.ownerUserId: a barber owns nothing, so that
  // route returns an empty list and leaves them with no way to reach the salon they work at.
  workplaces: 'workplaces',
  status: 'status',
} as const;

// New top-level `countries` controller (Phase 6A) — separate resource from DISCOVERY_PATHS'
// `cities`, additive to the existing discovery API surface.
export const COUNTRY_PATHS = {
  countries: 'countries',
  // countries/:countryId/regions
  regions: 'regions',
} as const;

// Sub-paths for booking-related reads that hang off a salon (DISCOVERY_PATHS.salons/:salonId/...)
// — kept separate from DISCOVERY_PATHS since these are authenticated/booking-flow endpoints, not
// public SEO discovery, even though they share the same `salons` URL segment.
export const SALON_BOOKING_INFO_PATHS = {
  staff: 'staff',
  availability: 'availability',
  cancellationPolicy: 'cancellation-policy',
  // Public, read-only shop payment capability for the customer booking review/confirmation UI.
  paymentInfo: 'payment-info',
} as const;

// BookingsController's `@Controller('bookings')` prefix.
export const BOOKING_PATHS = {
  bookings: 'bookings',
  mine: 'mine',
  cancel: 'cancel',
  checkIn: 'check-in',
  reschedule: 'reschedule',
} as const;

// Sub-paths under `salons/:salonId/queue` (SalonQueueController) — a 3-segment shape deliberately,
// not a bare `salons/:salonId/queue-status`, to avoid the same discovery-route collision class
// fixed in Phase 3B (see SalonsController's `:citySlug/:salonSlug`).
export const SALON_QUEUE_PATHS = {
  status: 'status',
  join: 'join',
} as const;

// QueueEntriesController's `@Controller('queue-entries')` prefix (customer view).
export const QUEUE_ENTRIES_PATH = 'queue-entries';

// ReviewsController's `@Controller('reviews')` prefix (Phase 16 — Ratings & Reviews).
// GET reviews/booking/:bookingId, POST reviews, PATCH reviews/:id — the owner-response side lives
// under DASHBOARD_PATHS.reviews instead (dashboard/salons/:salonId/reviews), same
// customer-vs-owner controller split as every other feature in this codebase.
export const REVIEW_PATHS = {
  reviews: 'reviews',
  booking: 'booking',
} as const;

// StyleAdvisorController's `@Controller('style-advisor')` prefix.
export const STYLE_ADVISOR_PATHS = {
  styleAdvisor: 'style-advisor',
  generate: 'generate',
} as const;

// A small, fixed style catalog (major-upgrade phase) — not salon-configurable data, so a shared
// constant rather than a DB table (see AI Style Advisor's Phase E notes). Used by the landing
// page's "Popular styles" section and the AI Style Advisor's generation request/results, so both
// always agree on the same names. General barbershop styles only — nothing brand-specific.
export const HAIRSTYLE_CATALOG = [
  { id: 'crew-cut', name: 'Crew Cut' },
  { id: 'fade', name: 'Fade' },
  { id: 'pompadour', name: 'Pompadour' },
  { id: 'buzz-cut', name: 'Buzz Cut' },
  { id: 'textured-quiff', name: 'Textured Quiff' },
  { id: 'undercut', name: 'Undercut' },
  { id: 'slick-back', name: 'Slick Back' },
  { id: 'crop', name: 'Crop' },
] as const;

// PremiumController's `@Controller('premium')` prefix (Premium plans + AI credits phase).
export const PREMIUM_PATHS = {
  premium: 'premium',
  plans: 'plans',
  me: 'me',
  credits: 'credits',
  // Dev/test-only activation — PremiumController rejects this outside a non-production
  // environment; never reachable in production regardless of who calls it.
  devActivate: 'dev/activate',
} as const;

// Single authoritative list of Premium plan ids — used to validate PremiumDevActivateInput and
// anywhere else client/server code needs to enumerate the fixed 3-plan catalog without a round
// trip. Actual price/credit values live in CustomerPremiumPlan (DB) via PremiumPlansService,
// never duplicated here.
export const PREMIUM_PLAN_IDS = ['basic', 'pro', 'max'] as const;

// CustomerCreditsController's `@Controller('credits')` prefix (FastQue Credits / Wallet V1) — the
// customer-facing wallet balance/history, distinct from PREMIUM_PATHS.credits above (that's the AI
// Style Advisor's unrelated per-subscription generation-credit pool, not money).
export const CREDITS_PATHS = {
  credits: 'credits',
  balance: 'balance',
  history: 'history',
  // POST admin/credits/grant (AdminCreditsController, PLATFORM_ADMIN-only) — mounted under
  // ADMIN_CREDITS_PATHS below, not this prefix, since it is never reachable at plain `credits/...`.
} as const;

// FastQue Credits admin grant route — deliberately a distinct top-level prefix from CREDITS_PATHS
// (the customer-facing balance/history reads), never nested under it, so the two can never be
// confused by a role-check bug — a route under `admin/` is a strong, visible signal that it needs
// PLATFORM_ADMIN, the same convention AdminController already uses for `admin/overview` etc.
export const ADMIN_CREDITS_PATHS = {
  admin: 'admin',
  credits: 'credits',
  grant: 'grant',
} as const;

// FastQue Credits REDEMPTION CAP (not an earn rate — see schema.prisma's CreditTransactionType
// doc comment: completing a service never automatically grants credit in this product):
// maxCreditsAllowed = floor(price / CREDIT_SLAB_AMOUNT_INR) * CREDIT_PER_SLAB_INR. The most a
// customer may redeem against a single ₹50 service is ₹10, ₹100 is ₹20, ₹150 is ₹30, and so on —
// exactly 20% at every whole-slab price and strictly less at any price that isn't an exact
// multiple of ₹50 (e.g. a ₹75 service caps redemption at ₹10, not ₹15). The customer's live wallet
// balance is a SEPARATE, independent cap — actualCreditsUsed is the minimum of the requested
// amount, the live balance, and this price-based cap. See
// CustomerCreditsService.computeMaxRedeemable, the single place this formula is implemented.
export const CREDIT_SLAB_AMOUNT_INR = 50;
export const CREDIT_PER_SLAB_INR = 10;

// Multi-service booking core mission: the most services a single appointment may select. A hard
// ceiling, not a UX suggestion — createBookingSchema/availabilityQuerySchema/staffListQuerySchema
// reject anything past this before it ever reaches AvailabilityService/BookingsService, so a
// pathological request can never force the server to sum an unbounded list of durations/prices or
// build an unbounded staff-qualification AND-clause. 10 comfortably covers any real appointment
// (a full "cut + beard + facial + wash + style" combination is 4-5) with generous headroom.
export const MAX_SERVICES_PER_BOOKING = 10;

// DashboardQueueController's `@Controller('dashboard')` prefix — staff/owner queue operations.
// Salon photo upload limits. Shared so the browser can reject a bad file before spending an
// upload on it and the server can reject the same file again on arrival — the client copy is a
// courtesy, the server copy is the boundary that actually counts.
export const SALON_PHOTO_UPLOAD = {
  // 5 MB, matching the Style Advisor's existing MAX_UPLOAD_BYTES — one upload ceiling across the
  // product rather than a second, different number for owners to trip over.
  maxBytes: 5 * 1024 * 1024,
  // The three formats every current browser and phone camera can produce and every browser can
  // render. Deliberately no HEIC: Safari uploads it happily but Chrome/Firefox cannot display it,
  // so accepting it would store photos that some customers simply never see.
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  // For the file picker's `accept` attribute. Extensions are a UI hint only — the server decides
  // by sniffing the file's magic bytes, never by trusting this or the browser's declared type.
  accept: 'image/jpeg,image/png,image/webp',
  // How many gallery photos the owner UI queues in one multi-select/camera batch before requiring
  // a separate session — a client-side UX cap (keeps one screen reviewable and one "Upload All"
  // click bounded), not a total-photos-per-salon limit enforced anywhere server-side.
  maxBatchCount: 10,
} as const;

export const DASHBOARD_PATHS = {
  dashboard: 'dashboard',
  salons: 'salons',
  queue: 'queue',
  queueEntries: 'queue-entries',
  serviceSessions: 'service-sessions',
  staff: 'staff',
  call: 'call',
  assign: 'assign',
  // Owner-operations corrective mission: assignment and the start of service are separate steps.
  startService: 'start-service',
  reassign: 'reassign',
  noShow: 'no-show',
  cancel: 'cancel',
  complete: 'complete',
  // Manual/local customer chair occupancy. Never aliases Chair ACTIVE/INACTIVE.
  chairOccupancy: 'chair-occupancy',
  occupyLocal: 'occupy-local',
  freeLocal: 'free-local',
  freeAllLocal: 'free-all-local',
  status: 'status',
  // Owner-set weekly opening times. AvailabilityService treats a day with no OperatingHours row
  // as closed and returns zero bookable slots, so until an owner sets these their shop can take
  // walk-ins through the queue but can never be booked.
  operatingHours: 'operating-hours',
  // Phase 9: authenticated "get my shop's QR/public queue URL" — mounted under the existing
  // dashboard/salons/:salonId/... shape alongside PublicQueueController's other routes.
  queueQr: 'queue-qr',
  // dashboard/salons/:salonId/photos/upload — multipart device upload. Additive sibling of the
  // JSON `photos` POST, which still takes an already-hosted https link and is unchanged; both
  // funnel into the same Photo row, so there is exactly one photo model, not two.
  photoUpload: 'upload',
  // Phase 11 (owner setup): salon-scoped roster/catalog management. `staff` above is reused —
  // note DashboardQueueController's existing `dashboard/staff/:id/status` (clock in/out) is a
  // DIFFERENT route from Phase 11's `dashboard/salons/:salonId/staff/:staffId`; the `salons/`
  // prefix keeps them from colliding.
  services: 'services',
  salonType: 'salon-type',
  chairs: 'chairs',
  // Salon photos. URL-based for now — no object storage is configured, so an owner links an
  // image they already host rather than uploading a file.
  photos: 'photos',
  location: 'location',
  resendInvite: 'resend-invite',
  // Owner-only salon-scoped booking operations (Phase: owner booking dashboard) — mounted at
  // dashboard/salons/:salonId/bookings, same shape as `queue` above.
  bookings: 'bookings',
  // GET dashboard/salons/:salonId/staff/me — "which SalonStaff row is *me*" for the authenticated
  // staff/owner user at this salon, so a client can self clock-in/out via the existing
  // `dashboard/staff/:id/status` route without already knowing its own staffId. Never collides with
  // salon-setup.controller.ts's `staff/:staffId` PATCH — there is no competing GET on that shape.
  me: 'me',
  // GET dashboard/salons/:salonId/capacity (Phase 6 — Owner Capacity Dashboard).
  capacity: 'capacity',
  // dashboard/salons/:salonId/staff/:staffId/working-hours (Phase 7 — barber schedules). A
  // per-barber refinement layer, same shape/route convention as operatingHours above.
  workingHours: 'working-hours',
  // GET dashboard/salons/:salonId/customers[/:customerId] (Phase 8 — owner customer CRM).
  customers: 'customers',
  customerHistory: 'history',
  customerDirectory: 'directory',
  customerServices: 'services',
  // Read-only provider-free queries against the salon's deterministic Owner Overview data.
  assistant: 'assistant',
  // POST dashboard/salons/:salonId/contacts/preview — transient owner contact-list validation.
  contacts: 'contacts',
  // POST dashboard/salons/:salonId/customers/:customerId/ledger/:ledgerEntryId/waive|restore —
  // Customer Dues + Cancellation Policy mission (New Customer No-Show Grace).
  ledger: 'ledger',
  waive: 'waive',
  restore: 'restore',
  // GET dashboard/salons/:salonId/analytics (Phase 9 — owner analytics/reporting).
  analytics: 'analytics',
  // GET dashboard/overview (Phase 10 — multi-branch aggregate overview, no :salonId).
  overview: 'overview',
  // GET dashboard/salons/:salonId/reviews, PUT .../reviews/:reviewId/response (Phase 16 — the
  // owner-response side of Ratings & Reviews; the customer write side is REVIEW_PATHS instead).
  reviews: 'reviews',
  reviewProfiles: 'review-profiles',
  response: 'response',
  // Phase 18 — dashboard/salons/:salonId/verification (shop) and
  // dashboard/salons/:salonId/staff/:staffId/verification (professional, `staff` above reused).
  verification: 'verification',
  // GET/PATCH dashboard/salons/:salonId/timezone (Global timezone correctness) — the owner-facing
  // counterpart to SALON_TIMEZONE_REQUIRED: booking/analytics/isOpenNow all need a real IANA zone,
  // and until this endpoint existed there was no way for an owner to actually set one.
  timezone: 'timezone',
  // GET/PUT dashboard/salons/:salonId/payment-qr, POST .../payment-qr/upload (FastQue Credits /
  // Wallet V1) — the owner-facing counterpart to BookingErrorCode.PAYMENT_QR_REQUIRED: an ONLINE
  // (APP/WEB-sourced) booking cannot be created at a salon with no payment QR configured, and until
  // this endpoint existed there was no way for an owner to actually set one. Same link-or-upload
  // dual-route shape as `photos`/`photoUpload` above.
  paymentQr: 'payment-qr',
  // GET/PATCH dashboard/salons/:salonId/profile (Part 2, admin delegated shop management) — the
  // safe-to-edit-post-registration subset of the Salon row (name/phone/email/addressLine/
  // postalCode/description). No such endpoint existed before this; shared verbatim by owner and
  // PLATFORM_ADMIN via the same SalonProfileService.
  profile: 'profile',
  // Authenticated canonical public shop URL and share-safe metadata.
  shareLinks: 'share-links',
  // Owner/admin readiness checklist for the three-photo first-activation requirement.
  photoReadiness: 'photo-readiness',
  // P0 arrival-alert mission — POST dashboard/bookings/:id/arrive|no-show|correct-no-show (staff/
  // owner-triggered booking-lifecycle actions, mounted alongside the existing queue mutations in
  // DashboardQueueController) and GET dashboard/salons/:salonId/arrival-alerts (the "reconstruct
  // eligibility from backend truth" read used by the full-screen overlay on load/reconnect).
  arrive: 'arrive',
  correctNoShow: 'correct-no-show',
  arrivalAlerts: 'arrival-alerts',
} as const;

export const OWNER_ASSISTANT_QUERY_LIMITS = {
  maxQuestionLength: 300,
  maxRequests: 12,
  throttleWindowMs: 60_000,
} as const;

// Public, provider-free customer booking assistant search.
export const CUSTOMER_ASSISTANT_PATHS = {
  assistant: 'assistant',
  search: 'search',
} as const;

export const CUSTOMER_ASSISTANT_SEARCH_LIMITS = {
  maxQueryLength: 80,
  maxResults: 5,
  maxPrice: 1_000_000,
  maxCandidatesScanned: 12,
  maxSlotsPerSalon: 3,
  maxRequests: 5,
  throttleWindowMs: 60_000,
} as const;

// P0 arrival-alert mission — how far ahead of slotStart the arrival-check alert becomes eligible.
// A single platform-wide constant for V1, same rationale as reminders.service.ts's
// REMINDER_WINDOW_MINUTES: no owner-facing settings UI exists yet to make this per-salon
// configurable, so it stays a named constant (one-line change later) rather than a hardcoded
// magic number repeated in both the backend sweep and the frontend eligibility display.
export const ARRIVAL_ALERT_LEAD_MINUTES = 5;

// Requirement #10 — conservative bounds for a future approved description-generation provider.
export const SALON_DESCRIPTION_SUGGESTION_LIMITS = {
  maxRequests: 3,
  throttleWindowMs: 600_000,
  providerTimeoutMs: 8_000,
  maxServices: 20,
  maxHighlights: 5,
  maxHighlightLength: 120,
  maxCurrentDescriptionLength: 600,
  maxPromptCharacters: 4_000,
  maxSalonNameLength: 120,
  maxCityNameLength: 120,
  maxServiceNameLength: 80,
  minDraftLength: 80,
  maxDraftLength: 600,
} as const;

// PublicQueueController's `@Controller('public-queue')` prefix (Phase 9 — shop QR queue entry).
// `:token` is Salon.publicQueueToken, never the internal Salon.id.
export const PUBLIC_QUEUE_PATHS = {
  publicQueue: 'public-queue',
  join: 'join',
} as const;

// NotificationsController's `@Controller('notifications')` prefix (Phase 11 — Notification
// Center). Every route here is scoped to the authenticated caller's own notifications only.
export const NOTIFICATION_PATHS = {
  notifications: 'notifications',
  mine: 'mine',
  unreadCount: 'unread-count',
  read: 'read',
  readAll: 'read-all',
  // GET/PUT notifications/preferences (Phase 13 — communication preferences).
  preferences: 'preferences',
} as const;
