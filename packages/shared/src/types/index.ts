import type {
  BookingAttributionSource,
  BookingSource,
  BookingStatus,
  ChairStatus,
  ChargeType,
  CreditFundingSource,
  ContactImportValidationStatus,
  CreditTransactionType,
  CrmFollowUpChannel,
  CrmFollowUpStatus,
  CrmLeadSource,
  CrmLeadStatus,
  CrmVisitOutcome,
  Language,
  LedgerReason,
  LedgerStatus,
  NotificationCategory,
  NotificationChannel,
  PhotoType,
  PrepaymentRequirement,
  QueueEntrySource,
  QueueEntryStatus,
  ReviewSource,
  ReviewSourceState,
  Role,
  SalonLocationProposalStatus,
  SalonLocationSource,
  SalonStaffRole,
  SalonStatus,
  SalonType,
  SessionAudience,
  StaffMemberStatus,
  SubscriptionStatus,
  CustomerSubscriptionStatus,
  UserStatus,
  VerificationStatus,
  VerificationSubjectType,
} from "../enums";
import type { QueueEntryPhase } from "../queue-phase";

// DTO shapes only — no I/O, no ORM types leak here. These mirror DATABASE.md/API.md and are the
// contract both apps/web and apps/mobile code against; the backend is the source of truth for
// validation (via the zod schemas in ../schemas), not these types alone.

export interface AuthenticatedUser {
  id: string;
  // Always the session-scoped subset of the User's roles (see TokenService.issueTokenPair) —
  // never every role the underlying User row happens to hold. A session's `audience` is what
  // determined that scoping; a route requiring PLATFORM_ADMIN should not treat this array as
  // sufficient proof by itself where the extra guarantee matters (see RolesGuard's own
  // audience-aware check for PLATFORM_ADMIN specifically).
  roles: Role[];
  // Auth security fix — which login surface this session was authenticated through. Present on
  // every token issued after the fix; absent (undefined at runtime) on a token issued before it,
  // which is exactly why RolesGuard's PLATFORM_ADMIN check treats anything other than a literal
  // `'ADMIN'` match as untrusted rather than defaulting/guessing.
  audience: SessionAudience;
}

// GET /auth/me response — deliberately does not include salon associations (ARCHITECTURE.md §4:
// the JWT itself never carries them, and neither does this convenience endpoint's shape).
export interface MeResponse extends AuthenticatedUser {
  phone: string | null;
  email: string | null;
  // Phase 14 (Localization & Voice Operations) — defaults to EN for every existing user (see the
  // migration). Drives both the language switcher's initial state and which VoiceAnnouncements
  // dictionary realtime alert handlers speak from.
  preferredLanguage: Language;
  // Safe capability only. The password hash itself is never returned.
  passwordConfigured: boolean;
}

/**
 * GET auth/methods — which sign-in methods this deployment can complete, so a client never
 * presents a form that is guaranteed to fail. Customer and owner phone OTP depend on a configured
 * SMS provider, keyed challenge secret, and country allowlist; separate booleans let each UI fail
 * closed without exposing secret values.
 *
 * Deliberately booleans only — this endpoint is public and must never reveal which key is set,
 * let alone its value.
 */
export interface AuthMethodsDto {
  google: boolean;
  phoneOtp: boolean;
  /** Owner OTP is separately authorized and issues STAFF audience only for an existing verified owner. */
  ownerPhoneOtp: boolean;
}

export interface EmployeeProfileDto {
  id: string;
  employeeCode: string;
  fullName: string;
  territory: string | null;
  joinedAt: string;
}

export interface AdminAccessUserDto {
  id: string;
  email: string | null;
  status: UserStatus;
  roles: Role[];
  createdAt: string;
}

export interface AdminEmployeeDto extends EmployeeProfileDto {
  userId: string;
  status: UserStatus;
  passwordConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Read-only details of the shop an employee onboarded (owner issue #28). Only shop-facing facts: no owner account contact,
 * no revenue, no customers, no queue. `shop` is null while the lead has not been onboarded.
 */
export interface EmployeeLeadShopDto {
  leadId: string;
  onboarded: boolean;
  shop: {
    salonId: string;
    name: string;
    status: string;
    addressLine: string;
    localityText: string | null;
    cityName: string;
    publicPath: string;
    onboardedAt: string | null;
    /** The shop's published business phone, only when the owner chose to publish it. */
    businessPhone: string | null;
    photos: Array<{ id: string; url: string; altText: string | null; type: string; sortOrder: number }>;
    chairs: Array<{ id: string; label: string; status: string }>;
    chairCounts: { total: number; active: number };
  } | null;
}

export interface EmployeeCrmLeadDto {
  id: string;
  shopName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  locality: string | null;
  addressLine: string | null;
  source: CrmLeadSource;
  status: CrmLeadStatus;
  notes: string | null;
  lostReason: string | null;
  onboardedAt: string | null;
  onboardedSalon: { id: string; publicId: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeCrmVisitDto {
  id: string;
  leadId: string | null;
  leadShopName: string | null;
  shopName: string;
  visitedAt: string;
  outcome: CrmVisitOutcome;
  notes: string | null;
  createdAt: string;
}

export interface EmployeeCrmFollowUpDto {
  id: string;
  leadId: string;
  leadShopName: string;
  dueAt: string;
  channel: CrmFollowUpChannel;
  status: CrmFollowUpStatus;
  notes: string | null;
  outcome: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type {
  EmployeeVoiceLanguage,
  EmployeeVoiceVisitLogDto,
  EmployeeVoiceVisitLogPageDto,
  VoiceOnboardingDraft,
} from '../employee-voice';

export interface EmployeeCrmDashboardDto {
  profile: EmployeeProfileDto;
  counts: {
    leads: number;
    onboarded: number;
    visitsLast30Days: number;
    openFollowUps: number;
    overdueFollowUps: number;
  };
  conversionRatePercent: number;
  recentLeads: EmployeeCrmLeadDto[];
  recentVisits: EmployeeCrmVisitDto[];
  upcomingFollowUps: EmployeeCrmFollowUpDto[];
}

export interface AdminCrmEmployeePerformanceDto {
  employee: EmployeeProfileDto & { status: UserStatus };
  leads: number;
  onboarded: number;
  visitsLast30Days: number;
  openFollowUps: number;
  overdueFollowUps: number;
  conversionRatePercent: number;
}

export interface AdminCrmLeadDto extends EmployeeCrmLeadDto {
  employee: Pick<
    EmployeeProfileDto,
    "id" | "employeeCode" | "fullName" | "territory"
  >;
}

export interface AdminCrmVisitDto extends EmployeeCrmVisitDto {
  employee: Pick<
    EmployeeProfileDto,
    "id" | "employeeCode" | "fullName" | "territory"
  >;
}

export interface AdminCrmFollowUpDto extends EmployeeCrmFollowUpDto {
  employee: Pick<
    EmployeeProfileDto,
    "id" | "employeeCode" | "fullName" | "territory"
  >;
}

export interface AdminCrmOverviewDto {
  counts: {
    employees: number;
    leads: number;
    onboarded: number;
    visitsLast30Days: number;
    openFollowUps: number;
    overdueFollowUps: number;
  };
  conversionRatePercent: number;
  performance: AdminCrmEmployeePerformanceDto[];
  recentLeads: AdminCrmLeadDto[];
  recentVisits: AdminCrmVisitDto[];
  dueFollowUps: AdminCrmFollowUpDto[];
}

export interface AdminCrmPageDto<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

/**
 * Date-bounded, aggregate-only employee CRM analytics. Employee identity is limited to internal
 * ID/code and territory; lead contact details and notes are never included in this response.
 * `onboardedFromPeriodLeads` is the current ONBOARDED count among leads created in the range.
 */
export interface AdminCrmAnalyticsDto {
  from: string;
  to: string;
  generatedAt: string;
  totals: {
    leadsCreated: number;
    onboardedFromPeriodLeads: number;
    leadsOnboardedInPeriod: number;
    visits: number;
    followUpsCompleted: number;
    openFollowUpsOverdueInPeriod: number;
  };
  employees: Array<{
    employeeId: string;
    employeeCode: string;
    territory: string | null;
    status: UserStatus;
    leadsCreated: number;
    onboardedFromPeriodLeads: number;
    leadsOnboardedInPeriod: number;
    visits: number;
    followUpsCompleted: number;
    openFollowUpsOverdueInPeriod: number;
    conversionPercent: number;
  }>;
  territories: Array<{
    territory: string | null;
    employees: number;
    leadsCreated: number;
    onboardedFromPeriodLeads: number;
    leadsOnboardedInPeriod: number;
    visits: number;
    followUpsCompleted: number;
    openFollowUpsOverdueInPeriod: number;
    conversionPercent: number;
  }>;
}

export interface AuthTokens {
  accessToken: string;
  // Present in the response body for mobile (stored via secure storage); web instead relies on
  // the httpOnly refresh cookie the same response sets, per ARCHITECTURE.md §4 — but the field is
  // always present in the JSON shape so one client type serves both.
  refreshToken: string;
  expiresIn: number; // seconds
}

export interface AuthSession {
  id: string;
  deviceInfo: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export interface SalonSummary {
  id: string;
  // Permanent, human-shareable identifier ("BC-SHOP-000001") — distinct from `id` (the internal
  // UUID, an implementation detail never meant for display). See Salon.publicId in schema.prisma.
  publicId: string;
  name: string;
  slug: string;
  citySlug: string;
  localitySlug?: string;
  addressLine: string;
  // ISO-3166-1 alpha-2 of the salon's city — drives postal labels, phone hints and number
  // grouping on the client without a second lookup.
  countryCode: string;
  // ISO-4217. Null where the country has no authoritative mapping wired yet; clients must render
  // a bare amount rather than assuming a symbol (see formatMoney).
  currency: string | null;
  // Postal/ZIP code as entered. Format is country-specific — see postalCodeRuleFor.
  postalCode: string | null;
  // Null when the owner registered without granting GPS permission (or from a desktop). Consumed
  // only by the schema.org `geo` block on the public salon page, which omits itself when absent.
  lat: number | null;
  lng: number | null;
}

export interface ServiceDto {
  id: string;
  salonId: string;
  name: string;
  durationMinutes: number;
  price: number;
  category: string;
  /** Optional category refinement. Older service records and clients may omit it. */
  subcategory?: string | null;
  /** Stable salon-scoped taxonomy identifiers; nullable for uncategorized legacy records. */
  categoryId?: string | null;
  subcategoryId?: string | null;
  isActive: boolean;
}

// ---------- Discovery / SEO (Phase 3A) ----------

export interface CityDto {
  id: string;
  name: string;
  slug: string;
  // ISO-3166-1 alpha-2. The field client logic should key on — `country` below is free-text
  // display data and must not be used for validation, currency or routing decisions.
  countryCode: string;
  // ISO-3166-2 subdivision where known; null where a country has none worth recording.
  regionCode: string | null;
  state: string;
  country: string;
}

export interface LocalityDto {
  id: string;
  name: string;
  slug: string;
  citySlug: string;
}

export interface ServiceSuggestionDto {
  name: string;
  category: string | null;
}

// ---------- Global location discovery (Phase 6A) ----------
// Additive, separate from CityDto/LocalityDto above (untouched) — these back the new
// Country -> Region -> City-search selection flow, not the existing B9 city/locality routes.

export interface CountryDto {
  id: string;
  name: string;
  isoCode2: string;
  // Deliberately NOT used to decide whether to show a Region step (see ARCHITECTURE notes on
  // Country.hasSubdivisions) — it stays at the schema default until a real product decision is
  // made. Callers must derive that from whether GET /countries/:id/regions returns any rows.
  hasSubdivisions: boolean;
}

export interface RegionDto {
  id: string;
  name: string;
  // ISO-3166-2 where the source dataset provided one; null otherwise. Never fabricated.
  code: string | null;
}

// Lean by design: population/coordinates/source-provenance fields exist on the underlying City
// row but are never sent to the browser here — this DTO exists specifically to keep the search
// endpoint's payload small at ~100K-city scale.
export interface CitySearchResultDto {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  region: { id: string; name: string; code: string | null } | null;
}

export interface OperatingHoursDto {
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday (JS Date.getDay() convention)
  openTime: string; // "HH:mm"
  closeTime: string; // "HH:mm"
  isClosed: boolean;
}

// Phase 7 (barber schedules). Same shape as OperatingHoursDto but the opposite default: a day
// this barber has never configured means "unrestricted" (works whenever the shop is open), not
// closed — see StaffWorkingHours' own schema.prisma doc comment. `configured: false` on an entry
// tells the UI "this is the unrestricted default, not something the barber actually set" without
// a client needing to separately track which days exist server-side.
export interface StaffWorkingHoursDto extends OperatingHoursDto {
  configured: boolean;
}

export interface PhotoDto {
  id: string;
  url: string;
  altText: string | null;
  type: PhotoType;
}

// No customer display-name field exists on User (schema gap, out of scope to fix here) — reviews
// render without a name; clients should show something like "Verified customer" instead.
export interface ReviewSummaryDto {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string; // ISO 8601
}

// ---------- Ratings & Reviews (Phase 16) ----------

// POST reviews / PATCH reviews/:id / GET reviews/booking/:bookingId response — the customer's own
// full view of one review, including ownerResponse (ReviewSummaryDto above is the public,
// salon-profile-page shape and deliberately omits it, matching the DB model's own doc comment).
export interface ReviewDetailDto {
  id: string;
  bookingId: string;
  salonId: string;
  rating: number;
  comment: string | null;
  ownerResponse: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

// GET dashboard/salons/:salonId/reviews — adds the operational context an owner needs to respond
// (which contact this review even came from) on top of ReviewDetailDto, same "extend the base DTO"
// pattern as OwnerBookingDetailDto extending BookingDetailDto. No customer display-name for the
// same schema-gap reason as ReviewSummaryDto above.
export interface OwnerReviewDto extends ReviewDetailDto {
  source: ReviewSource;
  customerPhone: string | null;
  customerEmail: string | null;
  serviceName: string;
}

export interface ReviewSourceDto {
  source: ReviewSource;
  state: ReviewSourceState;
  profileUrl: string | null;
}

// Owner review list remains pagination-compatible with the existing endpoint; source metadata is
// additive. External source selections intentionally contain no fetched review rows in V1.
export interface OwnerReviewsResponseDto extends PaginatedResult<OwnerReviewDto> {
  source: ReviewSource;
  sources: ReviewSourceDto[];
}

export interface ReviewProfilesResponseDto {
  sources: ReviewSourceDto[];
}

// ---------- Verification (Phase 18) ----------

// Owner's own view of their shop's or one barber's verification request — GET/POST
// dashboard/salons/:salonId/verification and .../staff/:staffId/verification.
export interface VerificationRequestDto {
  id: string;
  subjectType: VerificationSubjectType;
  status: VerificationStatus;
  evidenceNotes: string | null;
  evidenceUrls: string[];
  submittedAt: string; // ISO 8601
  reviewNotes: string | null;
  reviewedAt: string | null; // null until APPROVED or REJECTED
}

// GET admin/verification[/:id] — adds the review-queue context an admin needs on top of
// VerificationRequestDto, same "extend the base DTO" pattern as OwnerReviewDto. Exactly one of
// salonName / (staffDisplayName + staffSalonName) is populated, matching subjectType.
export interface AdminVerificationRequestDto extends VerificationRequestDto {
  salonId: string | null;
  salonName: string | null;
  staffId: string | null;
  staffDisplayName: string | null;
  staffSalonName: string | null;
  submitterEmail: string | null;
  submitterPhone: string | null;
}

// Listing/search-result card shape — extends the existing SalonSummary rather than duplicating
// its fields, adding only what a card needs beyond identity/location.
export interface SalonListItemDto extends SalonSummary {
  coverPhotoUrl: string | null;
  // Owner's temporary same-day pause. The shop remains discoverable; clients show
  // SHOP_CLOSED_TODAY_MESSAGE and suppress booking/queue CTAs while true.
  isClosedForToday?: boolean;
  ratingAverage: number | null; // null when the salon has zero reviews yet
  ratingCount: number;
  priceMin: number | null; // computed from active services, null if none
  priceMax: number | null;
  // "Near Me" (Phase 4) — null unless the search request carried lat/lng AND this salon has
  // coordinates (see SalonSummary.lat/lng's own nullability). Pre-rounded to 1 decimal place so
  // every client shows the exact figure the server sorted by, not its own rounding.
  distanceKm: number | null;
  // Computed from today's OperatingHours row in the salon's valid IANA timezone. Null when the
  // timezone or today's hours are unknown — never guessed for a multi-timezone country.
  isOpenNow: boolean | null;
  // Phase 18 — true only once an admin has APPROVED a VerificationRequest for this salon. Clients
  // must pair any badge with VERIFICATION_BADGE_CAPTION's exact wording, never invent their own.
  verified: boolean;
  // Issue #13 Mission F — real live signal, not a fabricated one: count of QueueEntry rows
  // currently WAITING/CALLED/IN_SERVICE at this salon. Clients should only surface this when > 0
  // (a real "3 waiting" beats a meaningless "0 waiting" on every card).
  waitingCount: number;
  // Shop-configured percentage applied only to FastQue APP/WEB bookings. Service.price remains the
  // shop's original list price; clients use this value only for an honest pre-booking preview.
  onlineBookingDiscountPercent?: number;
}

// GET salons/:salonId/booking/recent-activity — Issue #13 Mission H, the per-shop "last 30
// minutes" ticker. Deliberately name-free: this schema has no customer display-name field
// anywhere (User only ever stores phone/email — Google's own name claim is verified but not
// persisted), so "first name only" as literally described could only be satisfied by inventing a
// value. Anonymized ("Someone booked X") is strictly more private than a first name would have
// been anyway, and still delivers the real "this shop is active" signal without fabricating
// anything. serviceName is null for a walk-in queue join with no service chosen.
export interface RecentActivityItemDto {
  type: "booking" | "queue";
  serviceName: string | null;
  occurredAt: string; // ISO 8601
}

// GET salons/live-stats — public, privacy-safe live queue signal. Platform-wide shop totals are
// deliberately excluded from public/customer contracts; that count is reserved for PLATFORM_ADMIN.
export interface LiveStatsDto {
  // Sum of QueueEntry rows currently WAITING/CALLED/IN_SERVICE, across every salon.
  liveWaitingCount: number;
}

// Full profile page shape — everything a listing card has, plus the detail-page content.
export interface SalonProfileDto extends SalonListItemDto {
  description: string | null;
  phone: string | null;
  services: ServiceDto[];
  operatingHours: OperatingHoursDto[];
  photos: PhotoDto[];
  reviews: ReviewSummaryDto[]; // most recent, capped server-side (see API.md)
  team: TeamMemberDto[]; // Phase 17 — "Meet the team", ACTIVE staff only
  // Pre-confirmation timezone fix — the salon's resolved IANA zone (server-side, via
  // resolveSalonTimeZone; same convention as BookingDetailDto.salonTimezone for post-booking
  // screens). Null when it genuinely could not be resolved — clients degrade to their own device
  // zone in that case, never a guess. Public scheduling metadata only; carries no owner/admin data.
  salonTimezone: string | null;
}

/**
 * Public salon operations snapshot. This is intentionally aggregate-only: no customer, booking,
 * queue-entry, phone, email, or internal-resource identifiers cross the public API boundary.
 */
export interface PublicSalonStatusDto {
  activeChairCount: number;
  professionals: PublicSalonProfessionalStatusDto[];
}

export interface PublicSalonProfessionalStatusDto {
  displayName: string;
  activeQueueCount: number;
}

// Public "Meet the team" entry on a salon's discovery profile page (Phase 17). Deliberately never
// exposes phone/email (those are SalonStaffDto's owner-only fields) — this is what a customer
// browsing the shop gets to see, nothing account-related.
export interface TeamMemberDto {
  id: string;
  displayName: string;
  roleInSalon: SalonStaffRole;
  photoUrl: string | null;
  bio: string | null;
  yearsExperience: number | null;
  // Phase 18 — true only once an admin has APPROVED a VerificationRequest for this staff member.
  verified: boolean;
}

// POST /salons response — deliberately minimal (not a full SalonProfileDto): a brand-new shop has
// no services/photos/reviews/operating-hours yet, so returning those empty arrays would just be
// noise. `status` is always "PENDING" at creation (Salon.status's existing default), surfaced so
// the owner dashboard can show a moderation-pending state without a second round-trip.
export interface RegisterSalonResultDto {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  status: SalonStatus;
  isClosedForToday?: boolean;
}

/**
 * Auth-security-branch fix: registering a shop grants the caller SALON_OWNER in the DB, but a
 * CUSTOMER-audience session (phone OTP / customer Google) can never carry that role no matter how
 * many times its refresh token is rotated — TokenService.rotateRefreshToken deliberately preserves
 * the session's original audience forever, by design (see its own doc comment). Without this, a
 * plain customer who registers a shop is left holding a token that still can't reach their own new
 * shop's dashboard.
 *
 * So registerSalon mints a genuine fresh STAFF-audience token pair (the same
 * TokenService.issueTokenPair every staff/owner login already uses) as part of a successful,
 * already-authenticated registration — not a patched-in role on the existing token. `user` is the
 * same MeResponse shape every login returns, scoped to that new STAFF audience, so the client can
 * apply this exactly like any other login result (see AuthContext's own handleAuthResult-style
 * helper on web/mobile).
 */
export interface RegisterSalonResponseDto {
  salon: RegisterSalonResultDto;
  user: MeResponse;
  tokens: AuthTokens;
}

/**
 * A salon the caller may operate, from GET salons/workplaces. Resolved from UserRole membership —
 * the same rule SalonAccessService.assertAccess enforces — so "what I can see listed" and "what I
 * can actually open" can never drift apart.
 *
 * `isOwner` is presentation only: it tells the dashboard whether to offer setup links or just the
 * live queue. It grants nothing on its own — every owner-only endpoint still checks
 * @Roles(SALON_OWNER) plus assertAccess server-side.
 */
export interface SalonWorkplaceDto {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  status: SalonStatus;
  isClosedForToday?: boolean;
  isOwner: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BookingDto {
  id: string;
  salonId: string;
  // Null ONLY for an IN_SHOP appointment a shop operator created for someone without an account
  // (see BookingSource.IN_SHOP). Every customer-facing endpoint only ever returns the caller's own
  // bookings, so a customer's client always receives a value here.
  customerId: string | null;
  // Multi-service booking core mission: the PRIMARY (first-selected) service only, kept for every
  // consumer that predates multi-service bookings and still needs exactly one id — QueueEntry/
  // ServiceSession linkage at check-in time, and any read-only display that hasn't been updated to
  // render BookingDetailDto.services yet (see that field's own doc comment). Never the full
  // selection by itself; a multi-service booking's true selection is BookingDetailDto.services.
  serviceId: string;
  slotStart: string; // ISO 8601
  slotEnd: string;
  status: BookingStatus;
  source: BookingSource;
  // Phase 3B: soft preference only, null = "Any Staff" — see DATABASE.md's Booking section. Never
  // affects availability/capacity.
  preferredStaffId: string | null;
  prepaymentRequiredAmount: number | null;
  cancellationChargeAmount: number | null;
  // AI Style Advisor hand-off (major-upgrade phase) — the style name the customer picked via
  // "Try This Look" before booking, null for every ordinary booking. Free text at this layer
  // (not a foreign key) since HAIRSTYLE_CATALOG is a shared constant, not a DB table.
  selectedStyleName: string | null;
  // FastQue Credits / Wallet V1 — the actual amount applied at creation, after the server clamped
  // the customer's request to min(requested, live balance, price-based cap). Null means "redeemed
  // nothing". There is deliberately no "credits earned" field — completing a service never
  // automatically grants credit in this product (see CreditTransactionType.PROMO_GRANT).
  creditsRedeemedAmount: number | null;
  // Snapshotted at booking creation. Zero means no online-booking offer applied.
  onlineBookingDiscountPercent?: number;
  // Exact snapshotted money amount removed from the original service subtotal before credits,
  // prepayment and cancellation/no-show percentage calculations.
  onlineBookingDiscountAmount?: number;
  /** Applied campaign and immutable title snapshot; null when no offer was used. */
  offerId?: string | null;
  offerTitle?: string | null;
}

// ---------- AI Style Advisor (Phase E) ----------

// POST style-advisor/generate response item. `matchPercent` backs the UI's "AI Style Match NN%"
// wording — deliberately never "best match" or a guarantee (see the landing page's own copy).
export interface HairstylePreviewDto {
  styleId: string;
  styleName: string;
  previewUrl: string;
  matchPercent: number;
}

export interface StyleAdvisorResultDto {
  results: HairstylePreviewDto[];
}

// ---------- Booking flow (Phase 3B) ----------

// GET /salons/:salonId/staff?serviceId= — "Any Staff" is a client-side option, never returned here.
export interface StaffOptionDto {
  id: string;
  displayName: string;
  // Phase 17 (Barber Professional Profile) — lets the "choose a barber" step show a face/bio, not
  // just a name. All null until the owner/staff fills them in on the dashboard.
  photoUrl: string | null;
  bio: string | null;
  yearsExperience: number | null;
}

export interface AvailabilitySlotDto {
  slotStart: string; // ISO 8601
  slotEnd: string;
  available: boolean;
  // Additive state for cinema-style clients. `available` remains for backwards compatibility;
  // selected is always a local client state and is never sent by the API.
  state: AvailabilitySlotState;
}

/**
 * Provider-free customer assistant search. Results are actual active catalog services and
 * availability slots from the booking engine. The response intentionally has no customer PII,
 * generated claims, or booking side effect; booking still requires the existing explicit flow.
 */
export interface CustomerAssistantSearchResultDto {
  mode: "DETERMINISTIC_CATALOG_AVAILABILITY";
  generated: false;
  bookingConfirmationRequired: true;
  date: string; // Interpreted as a salon-local YYYY-MM-DD calendar date.
  candidates: Array<{
    salon: {
      id: string;
      publicId: string;
      name: string;
      slug: string;
      citySlug: string;
      countryCode: string;
      distanceKm: number | null;
    };
    service: {
      id: string;
      name: string;
      category: string | null;
      price: number;
      durationMinutes: number;
    };
    currency: string | null;
    timeZone: string;
    availableSlots: Array<{ slotStart: string; slotEnd: string }>;
  }>;
}

export type AvailabilitySlotState = "AVAILABLE" | "OCCUPIED";

// Multi-service booking core mission — one ordered entry per service actually selected on this
// appointment, snapshotted at booking-creation time (name/duration/price never drift if the
// underlying Service is later renamed/repriced/deactivated — same snapshot convention as
// prepaymentRequiredAmount and the other Booking-time snapshots in schema.prisma). Every booking,
// including one created before this mission existed, has at least one entry — a pre-existing
// single-service booking's array holds exactly that one service, backfilled once at migration
// time, so this field is always safe to render without a legacy branch.
export interface BookingServiceItemDto {
  serviceId: string;
  name: string;
  durationMinutes: number;
  price: number;
}

// Adds display fields a UI needs (booking confirmation, list, detail) without extra round-trips —
// same pattern as SalonListItemDto extending SalonSummary in Phase 3A.
export interface BookingDetailDto extends BookingDto {
  // ISO-4217 of the salon this booking belongs to; null when unknown.
  currency: string | null;
  salonName: string;
  // Owner-operations mission — the shop's public phone, present ONLY when the owner has chosen to
  // publish it (Salon.showPhoneToCustomers). Drives the "Call shop" action for rescheduling,
  // cancellation questions and penalty disputes. Optional so older clients keep working.
  shopPhone?: string | null;
  salonSlug: string;
  citySlug: string;
  salonCountryCode: string;
  salonAddress: string;
  // Null when the salon never captured GPS coordinates (see Salon.lat/lng's own nullability) —
  // "Get Directions" falls back to a text-address maps search in that case.
  salonLat: number | null;
  salonLng: number | null;
  // Part 5 (show arrival time after booking): the salon's real IANA zone, resolved server-side via
  // resolveSalonTimeZone (explicit Salon.timezone, else Asia/Kolkata for an India salon, else
  // null). Every client must format slotStart/slotEnd through this — via
  // formatBookingArrivalTime — rather than the device's own timezone, which silently misrepresents
  // the appointment time whenever the customer isn't in the same zone as the shop. Null means the
  // zone genuinely could not be resolved; clients degrade to formatting with no explicit zone.
  salonTimezone: string | null;
  // Part 5 completion (arrival guidance) — pre-computed absolute instants (ISO 8601, format
  // through salonTimezone exactly like slotStart/slotEnd), derived server-side from slotStart plus
  // the Booking.checkInOpensMinutesBefore/checkInDueGraceMinutes snapshot captured at creation
  // time (see schema.prisma). Both null together means no arrival guidance should be shown: either
  // the booking predates this feature (no snapshot recorded), or its current status makes arrival
  // guidance meaningless (CANCELLED/COMPLETED/NO_SHOW) — a client must never fabricate one from the
  // salon's CURRENT live policy, which could differ from what was actually promised at booking
  // time. When present, checkInOpensAt is when check-in becomes available and checkInDueBy is the
  // latest check-in time before the booking is eligible to be marked NO_SHOW.
  checkInOpensAt: string | null;
  checkInDueBy: string | null;
  // Multi-service booking core mission: these three now summarize the COMPLETE selection — a
  // concise truthful name summary (see summarizeServiceNames), and the TOTAL duration/price across
  // every selected service — never just the first one. See `services` below for the full,
  // per-service breakdown a UI should render when it wants to show more than a summary.
  serviceName: string;
  serviceDurationMinutes: number;
  servicePrice: number;
  // Original service subtotal minus onlineBookingDiscountAmount. This is the amount FastQue treats
  // as the booking value before any FastQue Credits redemption.
  discountedServicePrice?: number;
  // Multi-service booking core mission — the complete, ordered per-service breakdown. See
  // BookingServiceItemDto's own doc comment; always has at least one entry, for every booking.
  services: BookingServiceItemDto[];
  // FastQue Credits / Wallet V1: discountedServicePrice minus creditsRedeemedAmount, floored at
  // 0 — the actual amount the customer needs to pay. Always present so a client never has to
  // duplicate discount/credit arithmetic itself.
  payableAmount: number;
  preferredStaffName: string | null;
  // Phase 16 (Ratings & Reviews) — whether the Review.bookingId-unique row already exists for this
  // booking, so a client can show "Leave a review" vs. "You reviewed this" without a second
  // round-trip. Never the review's own content (that's GET reviews/mine/:bookingId).
  hasReview: boolean;
}

export interface CancelBookingResponseDto {
  booking: BookingDetailDto;
  chargeAmount: number;
  ledgerEntryCreated: boolean;
}

// ---------- Owner booking dashboard ----------

// `today`/`upcoming` are date-window views over active bookings; `completed`/`cancelled`/
// `no_show` are outcome views regardless of date; `all` is the unfiltered history feed. Kept as a
// flat union (not derived from BookingStatus) since `today`/`upcoming`/`all` aren't statuses.
export const OWNER_BOOKING_FILTERS = [
  "today",
  "upcoming",
  "completed",
  "cancelled",
  "no_show",
  "all",
] as const;
export type OwnerBookingFilter = (typeof OWNER_BOOKING_FILTERS)[number];

// Adds owner-operational fields (customer contact, assigned barber, timestamps) on top of
// BookingDetailDto — never exposed to the customer-facing booking endpoints, only the owner
// dashboard. Same "extend the base DTO" pattern as BookingDetailDto extending BookingDto.
export interface OwnerBookingDetailDto extends BookingDetailDto {
  customerPhone: string | null;
  customerEmail: string | null;
  /** Server-derived marketing attribution; absent on older responses. */
  attributionSource?: BookingAttributionSource;
  // Owner-operations mission — in-shop appointment provenance and trusted cancellation
  // attribution. All optional/nullable so an older client that predates them keeps working.
  // guestName/guestPhone are set only on BookingSource.IN_SHOP rows; internalNote is staff-only.
  guestName?: string | null;
  guestPhone?: string | null;
  internalNote?: string | null;
  cancelledByActor?: "CUSTOMER" | "OWNER" | "STAFF" | "SYSTEM" | "ADMIN" | null;
  cancellationReason?: string | null;
  // The barber actually assigned at queue check-in (QueueEntry.assignedStaffId), distinct from
  // preferredStaffId/preferredStaffName above (the customer's soft preference at booking time).
  // Null until the booking reaches check-in.
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  cancelledAt: string | null; // ISO 8601
  // P0 arrival-alert mission — server-computed so the client never re-derives no-show/arrival
  // policy math itself (grace minutes, charge amounts) from raw fields. `hasCheckedIn` mirrors
  // ArrivalGuidance's own definition (a QueueEntry exists for this booking) so the owner UI can
  // tell "arrived and waiting" apart from "not yet arrived" even though both currently read as
  // Booking.status === CONFIRMED. `arrivalAlertDue`/`noShowEligible` are both false once
  // hasCheckedIn is true or the booking has left CONFIRMED.
  hasCheckedIn: boolean;
  arrivalAlertDue: boolean;
  noShowEligible: boolean;
}

// P0 arrival-alert mission — the full-screen owner overlay's "what needs my attention right now"
// read model. Deliberately id/summary-only (never phone/email — see the mission's privacy
// requirement): `customerDisplayName` is always the truthful fallback ("Your 3:15 PM Haircut
// customer") because no canonical customer display name exists anywhere in this product (User has
// only phone/email, never a name field) — never invented here.
export interface ArrivalAlertDto {
  bookingId: string;
  salonId: string;
  slotStart: string; // ISO 8601
  serviceName: string;
  customerDisplayName: string;
  graceExpired: boolean;
  // Only meaningful once graceExpired is true (the amount a MARK NO SHOW action would actually
  // charge, per this salon's live CancellationPolicy) — null beforehand so the client never shows
  // a premature/guessed figure.
  noShowChargePreview: number | null;
  currency: string | null;
}

// ---------- Owner customer CRM (Phase 8) ----------

// A deliberately small, factual heuristic on booking counts at THIS salon only — never inferred
// from anything about the customer themselves. `new` = exactly one completed visit ever, `repeat`
// = 2+, `frequent` = FREQUENT_CUSTOMER_THRESHOLD+ (see the backend constant of the same name).
// Someone with 0 completed visits (only cancelled/no-show so far) gets none of these — they're
// just not segmented yet, not a 4th category invented to force a label onto them.
export type CustomerSegment = "new" | "repeat" | "frequent";

export interface OwnerCustomerSummaryDto {
  customerId: string;
  phone: string | null;
  email: string | null;
  // This salon's currency (Salon.currency), for formatting ledgerEntries/outstandingTotalAmount —
  // Part E's confirmation copy ("Waive ₹150 no-show due...") needs a real currency, not a guess.
  currency: string | null;
  totalBookings: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  firstVisitAt: string | null; // ISO 8601 — earliest COMPLETED booking's slotStart
  lastVisitAt: string | null; // ISO 8601 — latest COMPLETED booking's slotStart
  preferredServiceName: string | null; // most-completed service at this salon, if any
  preferredStaffName: string | null; // most-frequent assigned barber at this salon, if derivable
  segment: CustomerSegment | null;
  // Customer Dues + Cancellation Policy mission — Part E's "New customer grace · N of 3 completed
  // visits" line and Part D's waive eligibility gate. Derived from completedCount, exposed
  // directly so no client re-implements the < NEW_CUSTOMER_GRACE_COMPLETED_VISIT_LIMIT rule.
  newCustomerGraceEligible: boolean;
  // OUTSTANDING + WAIVED ledger entries at this salon (never SETTLED-only filtered out — Part E
  // asks for "outstanding/waived dues"), newest first.
  ledgerEntries: CustomerLedgerEntryDto[];
  // Sum of this customer's OUTSTANDING entries at this salon — 0 when none. Matches the total the
  // OUTSTANDING_BALANCE booking-block error reports to the customer (Part I).
  outstandingTotalAmount: number;
  /** Additive visit roll-up; legacy booking-only fields above retain their original meanings. */
  totalVisitCount?: number;
  completedVisitCount?: number;
  firstCompletedVisitAt?: string | null;
  lastCompletedVisitAt?: string | null;
  liveQueueVisitCount?: number;
  completedLiveQueueVisitCount?: number;
  cancelledLiveQueueVisitCount?: number;
  expiredLiveQueueVisitCount?: number;
  noShowLiveQueueVisitCount?: number;
}

/**
 * Server-filtered directory row. `totalSpent` is net FastQue shop-recorded invoice collections
 * (payments less recorded refunds), not an estimate of service value or provider settlement.
 * No canonical (verified) customer name exists. `displayName` is only what the customer themself last typed to this
 * shop (queue contact name or the name on their own booking), always paired with `displayNameSource`; otherwise null.
 */
export interface OwnerCustomerDirectoryItemDto {
  customerId: string;
  phone: string | null;
  email: string | null;
  currency: string | null;
  /** The name the customer last gave this shop, or null. A visit-supplied label with its source - not a verified identity. */
  displayName: string | null;
  displayNameSource: 'NOT_ON_FILE' | 'CONTACT_NAME_ON_VISIT' | 'GUEST_NAME_ON_BOOKING';
  totalBookings: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  totalVisitCount: number;
  completedVisitCount: number;
  liveQueueVisitCount: number;
  completedLiveQueueVisitCount: number;
  cancelledLiveQueueVisitCount: number;
  expiredLiveQueueVisitCount: number;
  noShowLiveQueueVisitCount: number;
  recordedCollections: number;
  recordedRefunds: number;
  totalSpent: number;
  repeatVisitCount: number;
  /** Segment is based on completed bookings plus deduplicated standalone authenticated queue visits. */
  segment: CustomerSegment | null;
}

export interface OwnerCustomerDirectoryPageDto {
  salonId: string;
  currency: string | null;
  items: OwnerCustomerDirectoryItemDto[];
  nextCursor: string | null;
}

export interface OwnerCustomerServiceHistoryItemDto {
  /** Stable source-qualified row id; it is not an account identity or credential. */
  id: string;
  visitId: string;
  bookingId: string | null;
  source: 'ONLINE_BOOKING' | 'IN_SHOP_APPOINTMENT' | 'LIVE_QUEUE';
  serviceId: string | null;
  serviceName: string;
  staffName: string | null;
  date: string;
  completedAt: string | null;
  /** Invoiced line total only; null means no matching issued invoice line is recorded. */
  amount: number | null;
  amountKind: 'INVOICED' | null;
  currency: string | null;
}

export interface OwnerCustomerServiceHistoryPageDto {
  salonId: string;
  customerId: string;
  items: OwnerCustomerServiceHistoryItemDto[];
  nextCursor: string | null;
}

// POST dashboard/.../ledger/:ledgerEntryId/waive|restore response.
export interface LedgerActionResultDto {
  ledgerEntry: CustomerLedgerEntryDto;
}

// AppException.details shape for BookingErrorCode.OUTSTANDING_BALANCE (Part I) — lets the client
// render the real reason/amount instead of a generic message, without exposing ledger entry ids.
export interface OutstandingBalanceDetailsDto {
  totalOutstandingAmount: number;
  currency: string;
  entries: Array<{ reason: LedgerReason; amount: number }>;
}

// ---------- Owner analytics & reporting (Phase 9) ----------

export const OWNER_ANALYTICS_RANGES = ["today", "7d", "30d", "custom"] as const;
export type OwnerAnalyticsRange = (typeof OWNER_ANALYTICS_RANGES)[number];

export interface UtilizationEntryDto {
  id: string;
  displayName: string;
  completedSessions: number;
  totalServiceMinutes: number;
}

export interface HourCountDto {
  hour: number; // 0-23 in the salon's local wall clock
  count: number;
}

export interface ServicePopularityDto {
  serviceId: string;
  name: string;
  completedCount: number;
}

export interface DailyServiceValueDto {
  date: string; // YYYY-MM-DD in the salon's local timezone
  completedCount: number;
  estimatedServiceValue: number;
}

export interface ServiceValueDto {
  serviceId: string;
  name: string;
  completedCount: number;
  estimatedServiceValue: number;
}

export interface BarberValueDto {
  staffId: string;
  displayName: string;
  completedSessions: number;
  estimatedServiceValue: number;
}

export interface HourServiceValueDto {
  hour: number; // 0-23 in the salon's local wall clock
  completedCount: number;
  estimatedServiceValue: number;
}

export interface LostOpportunityDto {
  cancelledEstimatedServiceValue: number;
  noShowEstimatedServiceValue: number;
  idleChairMinutes: number | null;
  idleChairPercent: number | null;
}

// FastQue does not observe a salon's complete cash/card settlement ledger, so these values are
// never presented as audited revenue. They are operational service-value estimates derived from
// listed-price snapshots for completed appointments plus listed prices for completed walk-ins.
// This preserves the existing product rule: never call an estimate "revenue" in UI copy.
export interface OwnerAnalyticsDto {
  from: string; // ISO 8601 — inclusive
  to: string; // ISO 8601 — exclusive
  currency: string | null;
  appointmentsBooked: number;
  completedCount: number;
  confirmedCount: number;
  pendingPaymentCount: number;
  cancelledCount: number;
  noShowCount: number;
  expiredCount: number;
  walkInCount: number;
  newCustomerCount: number;
  repeatCustomerCount: number;
  averageWaitMinutes: number | null;
  averageServiceDurationMinutes: number | null;
  barberUtilization: UtilizationEntryDto[];
  chairUtilization: UtilizationEntryDto[];
  peakHours: HourCountDto[]; // top 5 busiest hours, descending by count
  slowHours: HourCountDto[]; // bottom 5 hours that had at least one booking, ascending by count
  servicePopularity: ServicePopularityDto[]; // descending by completedCount
  estimatedServiceValue: number;
  dailyServiceValue: DailyServiceValueDto[];
  serviceValue: ServiceValueDto[];
  barberValue: BarberValueDto[];
  sourceMix: {
    bookingCompletedCount: number;
    walkInCompletedCount: number;
  };
  hourlyServiceValue: HourServiceValueDto[]; // always 24 rows, including zero-value hours
  newCustomerEstimatedServiceValue: number;
  repeatCustomerEstimatedServiceValue: number;
  lostOpportunity: LostOpportunityDto;
}

export interface QueueEntryDto {
  id: string;
  salonId: string;
  bookingId: string | null;
  source: QueueEntrySource;
  tokenNumber: number;
  status: QueueEntryStatus;
  assignedStaffId: string | null;
  assignedChairId: string | null;
  estimatedWaitMinutes: number | null;
}

// ---------- Queue & check-in (Phase 3C) ----------

// Adds display fields a UI needs (customer queue-status view, staff dashboard) without extra
// round-trips — same "extend the base DTO" pattern as BookingDetailDto extending BookingDto.
export interface QueueEntryDetailDto extends QueueEntryDto {
  serviceId: string | null;
  serviceName: string | null;
  position: number | null; // 1-based rank among WAITING entries at this salon, null once past WAITING
  // The contact number given when joining, else the account's own phone. Present so a shop can
  // reach the customer; only ever returned by owner/staff dashboard reads and to the customer
  // themselves — never by the public queue status APIs.
  customerPhone: string | null;
  // The display name the customer gave when joining. Null for entries that never provided one
  // (older joins, appointment check-ins) — FastQue stores no customer name anywhere else, so it is
  // never derived from an email or phone.
  customerName: string | null;
  // Authoritative "is this person physically in the shop" acknowledgement. Set the moment an
  // appointment check-in creates the entry, when staff mark a remote join as arrived, or implicitly
  // when staff assign it to a chair. Null = remote join not yet acknowledged.
  arrivedAt: string | null; // ISO 8601
  assignedStaffName: string | null;
  assignedChairLabel: string | null;
  // Booking/queue resource-reservation mission (Part 7) — the customer's own barber preference at
  // booking time (Booking.preferredStaffId), surfaced so assignment UI can show it and default to
  // it, instead of only discovering the mismatch after an assign() rejection. Always null for a
  // WALK_IN-sourced entry (no linked booking) or an APPOINTMENT booked "Any Staff".
  preferredStaffId: string | null;
  preferredStaffName: string | null;
  activeServiceSessionId: string | null; // target id for POST .../service-sessions/:id/complete
  joinedAt: string; // ISO 8601
  calledAt: string | null;
  // Owner-operations corrective mission - "assigned" and "service started" are different facts.
  // assignedAt: when a barber + chair were reserved for this customer (null = never assigned).
  // serviceStartedAt: when the barber actually STARTED the service (null until then - an assigned
  // customer has NOT started). `phase` is the server's one-word answer to "where is this customer";
  // clients that predate it derive the same value with queuePhaseOf() from status + assignedStaffId.
  // All three are optional on the wire so every released client keeps parsing responses.
  assignedAt?: string | null;
  serviceStartedAt?: string | null;
  phase?: QueueEntryPhase;
  // Smart Queue (Phase 5) — a realistic range around estimatedWaitMinutes ("arrive between X-Y")
  // rather than presenting queue timing as exact. Null exactly when estimatedWaitMinutes is null.
  estimatedWaitRangeMinutes: { min: number; max: number } | null;
  // Whether this entry is within TURN_APPROACHING_THRESHOLD_MINUTES — drives the client's
  // turn-approaching banner/alert copy without duplicating the threshold constant client-side.
  turnApproaching: boolean;
}

// GET /dashboard/salons/:salonId/booking/staff mirror for the live queue's chair dropdown.
export type ChairOccupancyKind = "FREE" | "LOCAL" | "FASTQUE";

export interface ChairOptionDto {
  id: string;
  label: string;
  // Owner-operations corrective mission: set while an ASSIGNED (not yet started) customer holds this
  // chair. `occupancy` stays 'FREE' for released clients, so they would still offer it; the server
  // refuses a second assignment, and current clients grey it out using these fields.
  reservedForEntryId?: string | null;
  reservedForTokenNumber?: number | null;
  // Optional for wire/backward compatibility with older cached clients; current backend always
  // populates these fields. Missing occupancy is treated as FREE by clients.
  occupancy?: ChairOccupancyKind;
  manualOccupancyId?: string | null;
  activeServiceSessionId?: string | null;
  tokenNumber?: number | null;
  assignedStaffName?: string | null;
}

// A walk-in that joined without picking a service (QueueEntry.serviceId is null) needs one
// specified before it can be assigned — QueueService.assign() rejects with SERVICE_REQUIRED
// otherwise. This is what lets the assign form's service picker exist without its own round trip.
export interface ServiceOptionDto {
  id: string;
  name: string;
}

// GET /dashboard/salons/:salonId/queue — embeds the roster/chairs read-only so the assign UI works
// without needing the (out-of-scope in Phase 3C) staff/chair CRUD endpoints. staffRoster includes
// BOTH ACTIVE and INACTIVE staff (with their current status) so the dashboard's clock-in/out
// toggle can also bring an off-duty staff member back on — an ACTIVE-only list would make an
// inactive staff member invisible here and unable to clock themselves back in. The assign action
// itself still separately re-validates ACTIVE + qualified via AvailabilityService.
export interface DashboardQueueDto {
  /** WAITING + CALLED + IN_SERVICE in join order — unchanged, for clients that predate `sections`. */
  entries: QueueEntryDetailDto[];
  staffRoster: StaffStatusDto[];
  chairs: ChairOptionDto[];
  services: ServiceOptionDto[];
  // Owner-operations mission — additive and optional so every released client keeps working.
  /**
   * Monotonic revision (epoch ms the snapshot was generated at, server clock). A client applies a
   * snapshot only if its revision is not older than the one it already shows, so a slow response can
   * never overwrite newer state. Realtime `queue.updated` events carry the same kind of revision.
   */
  revision?: number;
  serverTime?: string;
  /** Server-authoritative sections: every entry appears in exactly ONE of these. */
  sections?: DashboardQueueSectionsDto;
  counts?: {
    waiting: number;
    /** Called to the counter but not yet given a barber. */
    called: number;
    /** A barber and chair are reserved, service NOT started. Optional: absent on older servers. */
    assigned?: number;
    inService: number;
    completedToday: number;
    historyToday: number;
  };
  autoAssignEnabled?: boolean;
}

export interface DashboardQueueSectionsDto {
  /** Waiting for a barber, in queue order (position 1 = next). */
  waiting: QueueEntryDetailDto[];
  /** Called to the counter but not yet given a barber (no barber/chair reserved). */
  called: QueueEntryDetailDto[];
  /**
   * Assigned: a barber and a chair are reserved for this customer and the barber has NOT started the
   * service. Never counted as waiting and never as in service. Optional: absent on older servers.
   */
  assigned?: QueueEntryDetailDto[];
  /** In service: the barber started it and an ACTIVE service session exists. */
  inService: QueueEntryDetailDto[];
  /** Completed today, newest first. */
  completedToday: QueueEntryDetailDto[];
  /** Cancelled / expired / no-show today, newest first. */
  historyToday: QueueEntryDetailDto[];
}

// GET /dashboard/salons/:salonId/capacity (Phase 6 — Owner Capacity Dashboard). "Busy" means
// currently attached to an ACTIVE ServiceSession; "available" is active-minus-busy. Deliberately a
// small, decision-oriented summary (per the mission's "don't overload the UI" instruction) rather
// than a full analytics view — see Phase 9 for historical/trend reporting.
export interface CapacityCountsDto {
  active: number;
  busy: number;
  available: number;
}

export interface CapacitySummaryDto {
  chairs: CapacityCountsDto & { maintenance: number; inactive: number };
  staff: CapacityCountsDto & { offDuty: number };
  currentServices: number; // ACTIVE ServiceSessions right now
  waitingCustomers: number; // WAITING queue entries
  queueSize: number; // WAITING + CALLED + IN_SERVICE
  averageEstimatedWaitMinutes: number | null;
  // Null when the salon has no trustworthy IANA timezone; other live capacity remains usable.
  todaysBookings: number | null;
  upcomingBookings: number | null;
}

// ---------- Notification Center (Phase 11) ----------

// The concrete notification types this mission actually emits — kept as a closed union so
// producing code can't typo a type string, and consuming UI can exhaustively switch on it for
// icons/copy. Grows as new event sources wire in; never a catch-all "misc" bucket.
export const NOTIFICATION_TYPES = [
  "booking.confirmed",
  "booking.cancelled",
  "booking.no_show",
  "booking.expired",
  "booking.reminder",
  // P0 follow-up: told to a customer whose booking was wrongly recorded as a no-show and has been
  // corrected to COMPLETED — deliberately NOT 'booking.confirmed', which would misstate the outcome.
  "booking.corrected",
  "queue.turn_approaching",
  "owner.booking.created",
  "owner.booking.cancelled",
  "owner.booking.no_show",
  "owner.booking.expired",
  "owner.walk_in.joined",
  "staff.assigned",
  // P0 arrival-alert mission — the T-5-minute "has this customer arrived?" nudge, distinct from
  // 'owner.booking.no_show' (a terminal, financially-consequential state) and from
  // 'booking.reminder' (customer-facing, much larger lead window).
  "owner.booking.arrival_check",
  // Owner-operations mission — told to a customer when THE SHOP cancels or moves their booking.
  // Distinct from 'booking.cancelled' (the customer's own cancellation echoed back) so the copy,
  // deep link and delivery ledger can never confuse who did what.
  "booking.cancelled_by_shop",
  "booking.rescheduled_by_shop",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown> | null;
  deepLink: string | null;
  readAt: string | null; // ISO 8601, null = unread
  createdAt: string; // ISO 8601
}

// Phase 13 (Communication Preferences). `available` is server-computed truth about whether a real
// provider is actually wired for that channel today — IN_APP is always true; PUSH/EMAIL/SMS/
// WHATSAPP report false until this mission's explicitly-out-of-scope external providers are
// configured (see Phase 45's blocker policy). The UI must never let a user "enable" an unavailable
// channel and imply it will do anything.
export interface NotificationChannelPreferenceDto {
  channel: NotificationChannel;
  enabled: boolean;
  available: boolean;
}

export interface NotificationCategoryPreferenceDto {
  category: NotificationCategory;
  channels: NotificationChannelPreferenceDto[];
}

export interface NotificationPreferencesDto {
  categories: NotificationCategoryPreferenceDto[];
}

// GET dashboard/overview (Phase 10 — multi-branch experience). Aggregate-only across every salon
// this owner operates — no per-salon breakdown, so this never becomes a way to peek at one shop's
// numbers through a differently-authorized endpoint; every count here is a plain sum the owner
// could already see by opening each shop's own dashboard.
export interface OwnerMultiShopOverviewDto {
  totalShops: number;
  openShops: number; // SalonStatus.ACTIVE
  // Null if any owned shop lacks a trustworthy timezone, avoiding a silently partial total.
  todaysBookingsTotal: number | null;
  activeQueueTotal: number; // WAITING + CALLED + IN_SERVICE, summed across all owned shops
}

// GET /salons/:salonId/queue/status — public, lightweight, no PII.
export interface QueueStatusDto {
  salonId: string;
  waitingCount: number;
  estimatedWaitMinutes: number | null;
  // Smart Queue (Phase 5) — see QueueEntryDetailDto's own doc comment.
  estimatedWaitRangeMinutes: { min: number; max: number } | null;
}

// Booking/queue resource-reservation mission — SalonStaff.status stays exactly what it always
// was (working/clock-in state: ACTIVE/INACTIVE), never overloaded to mean "currently free". This
// is the SEPARATE, derived, point-in-time answer to "can this person actually take a customer
// right now": an ACTIVE staff member can still be RESERVED (an appointment's booked interval is
// current) or IN_SERVICE (an ACTIVE ServiceSession, walk-in or appointment-check-in). OFF_DUTY
// mirrors status === INACTIVE, surfaced here too so a UI can render every roster row from this one
// field instead of combining it with `status` itself.
export type StaffAvailabilityState =
  "AVAILABLE" | "RESERVED" | "IN_SERVICE" | "OFF_DUTY";

// PATCH /dashboard/staff/:id/status response, and the roster entries in DashboardQueueDto below.
export interface StaffStatusDto {
  id: string;
  displayName: string;
  status: StaffMemberStatus;
  // Optional for wire/backward compatibility with older cached clients — omitted rather than
  // computed as a guess when the caller doesn't need it. No customer PII: only this barber's own
  // derived state and timing, never who they are currently/next serving.
  availabilityState?: StaffAvailabilityState;
  // ISO 8601 — when this barber's current reservation/service is expected to free them, or null
  // when AVAILABLE/OFF_DUTY. For an overrunning ACTIVE service this is a conservative "at least
  // until now" estimate, never a past instant (see ReservationService's own doc comment).
  busyUntil?: string | null;
  // ISO 8601 — this barber's next upcoming appointment reservation start, if any, regardless of
  // their current availabilityState (useful even while AVAILABLE, to warn "free now, booked soon").
  nextBookingStart?: string | null;
}

export interface SalonPaymentPolicyDto {
  salonId: string;
  prepaymentRequirement: PrepaymentRequirement;
  prepaymentPercentage: number | null;
}

/** Public customer-booking payment capability. No provider secret or storage internals. */
export interface BookingPaymentInfoDto {
  onlinePaymentAvailable: boolean;
  paymentMethod: "UPI_QR";
  paymentQrImageUrl: string | null;
  // Optional for older servers/QR-only clients; direct intent is disabled without these.
  upiVpa?: string | null;
  upiPayeeName?: string | null;
  upiQrDecoded?: boolean;
  currency?: string | null;
  prepaymentRequirement: PrepaymentRequirement;
  prepaymentPercentage: number | null;
}

export interface CancellationPolicyDto {
  salonId: string | null;
  // Raw configured value from CancellationPolicy — kept for backward compatibility. Charge
  // computation and any "free cancellation up to N minutes" customer-facing copy must use
  // effectiveFreeCancellationWindowMinutes below instead, never this field directly: a salon may
  // configure less than the platform's 60-minute floor, and this field alone would understate it.
  freeCancellationWindowMinutes: number;
  // packages/shared/src/calc effectiveFreeCancellationWindowMinutes(freeCancellationWindowMinutes)
  // — max(60, configured). Authoritative for both charge eligibility and customer-facing display.
  effectiveFreeCancellationWindowMinutes: number;
  lateCancellationChargeType: ChargeType;
  lateCancellationChargeValue: number;
  noShowChargeType: ChargeType;
  noShowChargeValue: number;
  appointmentArrivalGraceMinutes: number;
  queueCallResponseGraceMinutes: number;
}

export interface CustomerLedgerEntryDto {
  id: string;
  customerId: string;
  salonId: string;
  bookingId: string | null;
  amount: number;
  reason: LedgerReason;
  status: LedgerStatus;
  createdAt: string; // ISO 8601
  settledAt: string | null; // ISO 8601 — set only when status transitions to SETTLED
  // Denormalized display fields — null when the related booking/service was deleted or the entry
  // has no booking (should not normally happen, but the ledger row must never fail to render).
  bookingServiceName: string | null;
  bookingSlotStart: string | null; // ISO 8601
}

// Customer Dues + Cancellation Policy mission — Part D's strict eligibility rule for the owner's
// "waive no-show due" action: true while the customer has fewer than 3 COMPLETED bookings at this
// salon. Does NOT mean 3 free waivers are granted automatically — it only gates whether the owner
// is *permitted* to use the grace waiver at all; the owner still decides per-entry.
export const NEW_CUSTOMER_GRACE_COMPLETED_VISIT_LIMIT = 3;

// ---------- Premium plans & AI credits (Premium phase) ----------

// GET premium/plans response item. price is a plain number (rupees, not paise) — matches every
// other money field in this file (ServiceDto.price etc.), all sourced from Prisma Decimal columns
// converted at the service layer.
export interface CustomerPremiumPlanDto {
  id: string;
  name: string;
  priceInr: number;
  aiCreditsPerYear: number;
  isPopular: boolean;
}

// GET premium/me response — the caller's current Premium status. All fields null/false when the
// customer has no active subscription (never omitted, so clients don't need an extra existence
// check).
export interface PremiumEntitlementDto {
  isPremium: boolean;
  planId: string | null;
  planName: string | null;
  periodEnd: string | null; // ISO 8601
}

// GET premium/credits response — available is always allocated - reserved - consumed, computed
// server-side; clients never derive or trust their own copy of this number.
export interface AiCreditBalanceDto {
  allocated: number;
  reserved: number;
  consumed: number;
  available: number;
}

// ---------- Shop QR / public queue entry (Phase 9) ----------

// GET public-queue/:token — service option shown on the public join page. Deliberately minimal:
// id is required for the join call itself (server re-validates it against the token's salon
// regardless), name/durationMinutes are display-only.
export interface PublicQueueServiceOptionDto {
  id: string;
  name: string;
  durationMinutes: number;
}

// GET public-queue/:token response. Never includes Salon.id, ownerUserId, or anything not needed
// to render the public join page. queueAvailable distinguishes "token resolves but this shop
// isn't currently accepting queue joins" (status !== ACTIVE) from an unknown/invalid token, which
// the controller instead returns as a 404 — the frontend shows a different message for each.
export interface PublicQueueInfoDto {
  salonName: string;
  queueAvailable: boolean;
  services: PublicQueueServiceOptionDto[];
  waitingCount: number;
  estimatedWaitMinutes: number | null;
}

// GET dashboard/salons/:salonId/queue-qr response — authenticated, owner/staff-only. The frontend
// renders the QR client-side from publicQueueUrl; nothing here is itself an image.
export interface PublicQueueQrDto {
  publicQueueToken: string;
  publicQueueUrl: string;
}

// ---------- Salon owner setup: services / chairs / staff (Phase 11) ----------

// Owner-facing view of a Service. Distinct from the public ServiceDto above, which is only ever
// returned for ACTIVE salons and never exposes inactive rows — an owner must see and manage both.
export interface SalonTypeResultDto {
  salonType: SalonType;
}

export interface SalonServiceDto {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: number;
  category: string | null;
  /** Optional category refinement; null for legacy services without a subcategory. */
  subcategory?: string | null;
  /** Stable salon-scoped taxonomy identifiers; nullable for uncategorized legacy records. */
  categoryId?: string | null;
  subcategoryId?: string | null;
  isActive: boolean;
  // ISO-4217 of the owning salon; null when unknown. Prices are major units.
  currency: string | null;
}

export interface SalonServiceSubcategoryDto {
  id: string;
  name: string;
}

export interface SalonServiceCategoryDto {
  id: string;
  name: string;
  subcategories: SalonServiceSubcategoryDto[];
}

export interface ServiceTaxonomyNodeDto {
  id: string;
  name: string;
}

// Owner-facing chair. ChairOptionDto (above) stays the queue dashboard's lighter read model;
// this adds the status an owner needs to manage.
export interface SalonChairDto {
  id: string;
  label: string;
  status: ChairStatus;
}

export type ChairDeactivationConflict =
  | "ACTIVE_SERVICE_SESSION"
  | "ACTIVE_MANUAL_OCCUPANCY"
  | "ASSIGNED_QUEUE_ENTRY"
  | "NOT_ACTIVE"
  | "STALE_PREVIEW";

export interface BulkChairDeactivationPreviewItemDto {
  chairId: string;
  label: string | null;
  status: ChairStatus | null;
  /** Exact optimistic-concurrency version to echo to the apply endpoint. */
  expectedUpdatedAt: string | null;
  disposition: "READY" | "CONFLICT" | "NOT_FOUND";
  conflicts: ChairDeactivationConflict[];
}

export interface BulkChairDeactivationPreviewDto {
  salonId: string;
  items: BulkChairDeactivationPreviewItemDto[];
}

export interface BulkChairDeactivationResultItemDto {
  chairId: string;
  label: string | null;
  result: "DEACTIVATED" | "CONFLICT" | "NOT_FOUND";
  conflicts: ChairDeactivationConflict[];
}

export interface BulkChairDeactivationResultDto {
  salonId: string;
  deactivatedCount: number;
  items: BulkChairDeactivationResultItemDto[];
}

// Owner-facing roster entry. Phone/email come from the linked User account (SalonStaff itself has
// no duplicate contact columns). Legacy staff may have email but no phone; new rows require phone.
export interface SalonStaffDto {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  roleInSalon: SalonStaffRole;
  status: StaffMemberStatus;
  hasPassword: boolean;
  // Owner-operations mission: true once the owner removed this barber's login access. Distinct
  // from `status` (the barber's own clock-in/out duty flag). Optional for older clients.
  accessRevoked?: boolean;
  // Phase 17 (Barber Professional Profile) — owner/staff-editable, shown to customers on the
  // salon's public profile ("Meet the team") and the booking flow's barber picker.
  bio: string | null;
  photoUrl: string | null;
  yearsExperience: number | null;
}

// POST .../staff response. invitationSent stays truthful for email-less staff. `inviteUrl` is
// populated ONLY outside production — in production a real link is delivered by EmailSender and
// never returned over the API.
export interface StaffInviteResultDto {
  staff: SalonStaffDto;
  invitationSent: boolean;
  inviteUrl?: string;
}

// PATCH dashboard/salons/:salonId/status response — the owner-visible activation state.
export interface SalonStatusResultDto {
  id: string;
  status: SalonStatus;
  isClosedForToday?: boolean;
}

// PATCH dashboard/salons/:salonId/timezone response, and GET .../timezone's current-value shape.
// countryCode (added for Issue #13's timezone-picker safety fix) is the salon's city's own ISO
// alpha-2 code, always present for a real salon — it drives an owner-facing "suggested zone" hint
// in web's TimezoneSection, never a silent default; the raw picker still works exactly as before
// for every country this doesn't have a confident single-zone suggestion for.
//
// Part 4 (auto timezone selection) additions:
//   - timezoneAutoDetected / timezoneManuallyOverridden mirror the Salon columns of the same name
//     — whether the CURRENT stored value (if any) came from auto-detection or an explicit owner
//     choice.
//   - suggestion is computed fresh on every GET (never persisted on its own) from
//     resolveAutoTimezone against the salon's current coordinates/city/country. Null means
//     detection is genuinely ambiguous — the UI must keep showing a manual selector, never invent
//     a value. Present even when `timezone` is already set, so a shop whose owner never
//     explicitly confirmed a value (timezoneManuallyOverridden === false) can still be offered a
//     more precise suggestion without it ever being silently applied.
export interface SalonTimezoneSuggestionDto {
  timezone: string;
  confidence: "EXACT" | "HIGH" | "AMBIGUOUS";
  source: "coordinates" | "city" | "country";
}

export interface SalonTimezoneResultDto {
  id: string;
  timezone: string | null;
  countryCode: string;
  timezoneAutoDetected: boolean;
  timezoneManuallyOverridden: boolean;
  suggestion: SalonTimezoneSuggestionDto | null;
}

// GET/PATCH dashboard/salons/:salonId/profile (Part 2, admin delegated shop management) — the
// safe-to-edit-post-registration subset of the Salon row. Deliberately excludes slug/cityId/
// localityId/publicId/ownerUserId/status/timezone/currency — see updateSalonProfileSchema's own
// doc comment for exactly why each is excluded.
export interface SalonProfileDetailDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  addressLine: string;
  postalCode: string | null;
  description: string | null;
}

/** GET dashboard/salons/:salonId/share-links — canonical public URL and share-safe metadata. */
export interface SalonShareLinksDto {
  salonId: string;
  status: SalonStatus;
  publicPath: string;
  publicUrl: string | null;
  readiness: {
    ready: boolean;
    reasons: Array<'SALON_NOT_PUBLIC' | 'WEB_BASE_URL_NOT_CONFIGURED'>;
  };
  metadata: {
    title: string;
    description: string | null;
    imageUrl: string | null;
  };
}

export interface SalonLocationProposalDto {
  id: string;
  status: SalonLocationProposalStatus;
  latitude: number;
  longitude: number;
  source: SalonLocationSource;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface SalonLocationDto {
  salonId: string;
  current: {
    latitude: number | null;
    longitude: number | null;
    verification: 'VERIFIED' | 'UNVERIFIED';
    verifiedAt: string | null;
  };
  pendingProposal: SalonLocationProposalDto | null;
  /** Most recent terminal admin decision; visible only to an authorized shop owner/admin. */
  lastDecision: {
    status: 'APPROVED' | 'REJECTED';
    reviewNote: string | null;
    reviewedAt: string | null;
  } | null;
}

export interface AdminSalonLocationProposalDto extends SalonLocationProposalDto {
  submittedByUserId: string;
  salon: {
    id: string;
    publicId: string;
    name: string;
    addressLine: string;
    localityText: string | null;
    postalCode: string | null;
    cityName: string;
    currentLatitude: number | null;
    currentLongitude: number | null;
  };
}

// GET/PUT dashboard/salons/:salonId/payment-qr response (FastQue Credits / Wallet V1) — the
// owner-facing counterpart to BookingErrorCode.PAYMENT_QR_REQUIRED. null means not configured yet,
// which is exactly what blocks that salon from taking an ONLINE (APP/WEB-sourced) booking.
export interface SalonPaymentQrDto {
  salonId: string;
  paymentQrImageUrl: string | null;
  upiVpa?: string | null;
  upiPayeeName?: string | null;
  upiQrDecoded?: boolean;
}

// GET credits/balance response — the single number a booking-time redemption UI needs. Always
// reflects the durable CustomerCreditAccount.balance, never recomputed client-side.
export interface CustomerCreditBalanceDto {
  balance: number;
}

// GET credits/history — one row per CustomerCreditTransaction, oldest fields never mutated once
// written (see that model's own "append-only" doc comment).
export interface CustomerCreditTransactionDto {
  id: string;
  type: CreditTransactionType;
  amount: number;
  bookingId: string | null;
  // Meaningful only for PROMO_GRANT/RESTORED rows (the "lots") — how much of this specific grant
  // is still unspent. Null for REDEEMED/MANUAL_ADJUSTMENT, which never hold spendable balance.
  remainingAmount: number | null;
  campaignRef: string | null;
  fundingSource: CreditFundingSource | null;
  // Null means "never expires". A lot with a past expiresAt is already excluded from balance/
  // redemption by the server — this is shown for transparency, not as something the client must
  // itself re-check.
  expiresAt: string | null; // ISO 8601
  reason: string | null;
  note: string | null;
  createdAt: string; // ISO 8601
}

// POST admin/credits/grant response (AdminCreditsController, PLATFORM_ADMIN-only) — the created
// PROMO_GRANT transaction, same shape as one CustomerCreditTransactionDto row.
export type PromotionalCreditGrantResultDto = CustomerCreditTransactionDto;

/**
 * What a PENDING salon still needs before it can be opened. Carried as the `details` payload of a
 * SALON_SETUP_INCOMPLETE error so the client can render a per-item checklist ("✓ Service added /
 * ✗ Add at least one barber") instead of one undifferentiated sentence.
 *
 * Each flag counts only rows that are actually usable — an ACTIVE chair, an ACTIVE staff member,
 * an `isActive` service — because a deactivated one contributes nothing to serving a customer.
 */
export interface SalonSetupReadinessDto {
  hasActiveService: boolean;
  hasActiveChair: boolean;
  hasActiveStaff: boolean;
}

/** Counts distinct existing HTTPS/no-credentials photo URL origin/paths; remote content is not fetched. */
export interface SalonPhotoActivationReadinessDto {
  required: 3;
  current: number;
  ready: boolean;
  grandfathered: boolean;
  reasons: Array<'THREE_VALID_PHOTOS_REQUIRED'>;
}

export interface SalonContactImportPreviewDto {
  previewOnly: true;
  invitationEligibility: 'NOT_EVALUATED';
  dispatchEnabled: false;
  dispatchBlockedReason: 'CONSENT_SUPPRESSION_AND_PROVIDER_GATES_REQUIRED';
  summary: {
    total: number;
    validatedForReview: number;
    invalidPhone: number;
    consentRequired: number;
    consentEvidenceIncomplete: number;
    consentTimestampInvalid: number;
    duplicateInBatch: number;
  };
  items: Array<{
    index: number;
    status: ContactImportValidationStatus;
  }>;
}

// ---------- Platform admin monitoring ----------

// GET admin/shop-activity. Bookings count by appointment date (slotStart) and queue entries by
// joinedAt, both inside [from, to] as IST calendar days. liveNow is the current
// WAITING + CALLED + IN_SERVICE count and ignores the date range.
export interface AdminShopActivityCountsDto {
  bookings: {
    total: number;
    confirmed: number;
    completed: number;
    cancelled: number;
    noShow: number;
  };
  queue: {
    joined: number;
    served: number; // COMPLETED
    dropped: number; // NO_SHOW + CANCELLED + EXPIRED
    liveNow: number;
  };
}

export interface AdminShopActivityDto extends AdminShopActivityCountsDto {
  from: string;
  to: string;
  timeZone: string;
  generatedAt: string;
  // Only shops with a booking or queue entry in the range, or someone in the queue right now;
  // busiest first. `bookings`/`queue` on the root are the totals across every shop.
  shops: Array<
    AdminShopActivityCountsDto & {
      id: string;
      publicId: string;
      name: string;
      status: SalonStatus;
    }
  >;
}

export interface PlatformAdminOverviewDto {
  generatedAt: string;
  // Null only before the first real browser/device has registered. We intentionally do not
  // fabricate a historical visitor estimate for traffic that predates first-party tracking.
  visitorTrackingStartedAt: string | null;
  counts: {
    shops: number;
    owners: number;
    staff: number;
    customers: number;
    bookings: number;
    websiteVisitors: number;
    liveQueueEntries: number;
    activePremiumSubscriptions: number;
  };
  shops: Array<{
    id: string;
    publicId: string;
    name: string;
    status: SalonStatus;
    subscriptionStatus: SubscriptionStatus;
    ownerEmail: string | null;
    ownerPhone: string | null;
    staffCount: number;
    bookingCount: number;
    liveQueueCount: number;
    createdAt: string;
  }>;
  staff: Array<{
    id: string;
    displayName: string;
    status: StaffMemberStatus;
    salonName: string;
    salonPublicId: string;
    email: string | null;
    phone: string | null;
  }>;
  customers: Array<{
    id: string;
    status: UserStatus;
    email: string | null;
    phone: string | null;
    bookingCount: number;
    queueEntryCount: number;
    isPremium: boolean;
    createdAt: string;
  }>;
  recentBookings: Array<{
    id: string;
    status: BookingStatus;
    slotStart: string;
    salonName: string;
    serviceName: string;
    customerEmail: string | null;
    customerPhone: string | null;
  }>;
  recentQueue: Array<{
    id: string;
    tokenNumber: number;
    status: QueueEntryStatus;
    joinedAt: string;
    salonName: string;
    serviceName: string | null;
    customerPhone: string | null;
    assignedStaffName: string | null;
    assignedChairLabel: string | null;
  }>;
  premiumSubscriptions: Array<{
    id: string;
    status: CustomerSubscriptionStatus;
    planName: string;
    periodEnd: string;
    customerEmail: string | null;
    customerPhone: string | null;
  }>;
}

export interface HealthCheckResponse {
  status: "ok";
  service: string;
  timestamp: string;
}

/** Draft only: the owner must review every statement and save through the existing profile API. */
export interface SalonDescriptionSuggestionDto {
  draft: string;
  language: 'en' | 'hi';
  persisted: false;
  requiresOwnerReview: true;
  notice: string;
}
