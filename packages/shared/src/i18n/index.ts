// Phase 14 (Localization & Voice Operations), extended for Issue 9 (mobile launch mission) to
// also cover the core customer-journey UI strings (UiStrings/UI_STRINGS/uiStringsFor below), and
// further extended after a Build 9 physical-device test proved app-owned English strings were
// still reaching Hindi-selected screens: bottom tab labels, owner/staff account + Manage Shop +
// Bookings-filter labels (UiStrings), the in-app Notification Center's per-type title
// (NotificationTypeLabels/notificationTypeLabel), and the OS push notification title/body
// (PushCopy/pushCopyFor) all now go through this module. Long-form/secondary owner-only copy not
// covered by an explicit key here still stays English-only — a real, narrower slice than "the
// whole app," not silently regressed to "translate nothing."
//
// Extensibility contract: adding a language means adding one Language enum value (../enums) plus
// one complete VoiceAnnouncements object, one complete UiStrings object, one complete
// NotificationTypeLabels object, one complete PushCopy object, one SPEECH_LOCALE entry and one
// LANGUAGE_LABELS entry below — TypeScript's Record<Language, ...> makes an incomplete addition a
// compile error, not a silent English fallback for the new language.

import { Language } from '../enums';
import { NOTIFICATION_TYPES, type NotificationType } from '../types';

export interface VoiceAnnouncements {
  /** Customer: a booked appointment's queue turn is about to come up. */
  turnApproaching(): string;
  /** Customer: the estimated wait shifted enough to be worth a fresh alert. */
  waitTimeChanged(): string;
  /**
   * Owner/staff: a new booking just landed on this salon. `barberName` is the actual assigned
   * barber if one exists yet, else the customer's selected preference, else null when the
   * customer chose "Any staff" and no one has been assigned yet — callers must never invent a
   * name for that null case (see formatVoiceBarberDate below for how `date`/`time` are produced).
   */
  newBookingReceived(
    serviceName: string | null,
    barberName: string | null,
    salonName: string | null,
    date: string | null,
    time: string | null,
  ): string;
  /** Owner/staff: a booking on this salon was moved to a new slot. */
  bookingRescheduled(date: string | null, time: string | null): string;
  /** Owner/staff: a booking on this salon was just cancelled. */
  bookingCancelled(): string;
  /** Owner/staff: a walk-in just joined the live queue. */
  newCustomerJoined(tokenNumber: number, serviceName: string | null): string;
  /** Spoken once, immediately, when an owner/staff member turns voice announcements on — the only
   * way speechSynthesis/Speech.speak can be confirmed working without waiting for a real event. */
  voiceAnnouncementsOn(): string;
  /**
   * Owner/staff: the repeating arrival-check reminder (P0 arrival-alert mission) — asks whether an
   * unresolved, grace-window-eligible appointment's customer has arrived. `serviceName`/`time`
   * follow the exact same null-safe pattern as newBookingReceived/bookingRescheduled above; never a
   * customer name (no canonical one exists in this product — see ArrivalAlertDto's own comment).
   */
  arrivalCheck(serviceName: string | null, time: string | null): string;
}

const en: VoiceAnnouncements = {
  turnApproaching: () => 'Your turn is almost here.',
  waitTimeChanged: () => 'Your wait time has changed.',
  newBookingReceived: (serviceName, barberName, salonName, date, time) => {
    const service = serviceName ? `New ${serviceName} service booked` : 'New booking received';
    const who = barberName ? ` for ${barberName}` : '';
    const where = salonName ? ` at ${salonName}` : '';
    const when = [date ? `on ${date}` : null, time ? `at ${time}` : null].filter(Boolean).join(' ');
    const whenClause = when ? ` ${when}` : '';
    const sentence = `${service}${who}${where}${whenClause}.`;
    return barberName ? sentence : `${sentence} Barber not assigned yet.`;
  },
  bookingRescheduled: (date, time) => {
    const when = [date ? `to ${date}` : null, time ? `at ${time}` : null].filter(Boolean).join(' ');
    return when ? `Booking rescheduled ${when}.` : 'Booking rescheduled.';
  },
  bookingCancelled: () => 'Booking cancelled.',
  newCustomerJoined: (tokenNumber, serviceName) =>
    `New customer joined the queue. Queue number ${tokenNumber}${serviceName ? `, ${serviceName}` : ''}.`,
  voiceAnnouncementsOn: () => 'Voice announcements on.',
  arrivalCheck: (serviceName, time) => {
    const service = serviceName ? `${serviceName} customer` : 'customer';
    const when = time ? ` ${time}` : '';
    return `Appointment reminder. Has the${when} ${service} arrived? Please confirm arrived or not arrived.`;
  },
};

// Hindi, Devanagari script — expo-speech / speechSynthesis both accept UTF-8 text directly, no
// transliteration needed as long as the utterance's `lang`/voice is set to a Hindi locale (see
// SPEECH_LOCALE below), which is the caller's responsibility, not this module's. Proper nouns
// (service/barber/salon names) and the date/time string stay exactly as passed in — they are
// already Latin-script/English data throughout the rest of this product, matching how the
// pre-existing entries below already embed `serviceName`/`tokenNumber` untranslated.
const hi: VoiceAnnouncements = {
  turnApproaching: () => 'आपकी बारी जल्द आने वाली है।',
  waitTimeChanged: () => 'आपके प्रतीक्षा समय में बदलाव हुआ है।',
  newBookingReceived: (serviceName, barberName, salonName, date, time) => {
    const parts = [`नई ${serviceName ?? 'बुकिंग'} सेवा`];
    if (barberName) parts.push(`${barberName} के लिए`);
    if (salonName) parts.push(`${salonName} में`);
    if (date) parts.push(`${date} को`);
    if (time) parts.push(`${time} बजे`);
    parts.push('बुक हुई।');
    const sentence = parts.join(' ');
    return barberName ? sentence : `${sentence} अभी तक बार्बर तय नहीं हुआ है।`;
  },
  bookingRescheduled: (date, time) => {
    const when = [date ? `${date} को` : null, time ? `${time} बजे` : null].filter(Boolean).join(' ');
    return when ? `बुकिंग पुनर्निर्धारित की गई है। नया समय ${when}।` : 'बुकिंग पुनर्निर्धारित की गई है।';
  },
  bookingCancelled: () => 'बुकिंग रद्द कर दी गई है।',
  newCustomerJoined: (tokenNumber, serviceName) =>
    `कतार में नया ग्राहक जुड़ा। कतार नंबर ${tokenNumber}${serviceName ? `, ${serviceName}` : ''}।`,
  voiceAnnouncementsOn: () => 'आवाज़ में सूचनाएं चालू हैं।',
  arrivalCheck: (serviceName, time) => {
    const service = serviceName ? `${serviceName} ग्राहक` : 'अपॉइंटमेंट के ग्राहक';
    const when = time ? `${time} बजे के ` : '';
    return `अपॉइंटमेंट रिमाइंडर। क्या ${when}${service} पहुंच चुका है? कृपया पुष्टि करें, आया या नहीं आया।`;
  },
};


/**
 * Owner-facing voice can be independent of the app UI language. This is deliberately a speech
 * presentation preference, not another UI locale: an owner may keep the dashboard in English and
 * still ask FastQue to announce bookings in Hindi.
 *
 * "HINDI_BIHAR" uses straightforward Bihar-friendly Hindi wording with the normal hi-IN TTS
 * locale. It does not pretend that "Bihari" is one language or that the device has a Bihar-specific
 * synthetic accent; the exact audible voice still comes from the installed TTS engine.
 */
export const OWNER_VOICE_STYLES = ['ACCOUNT', 'HINDI', 'ENGLISH', 'HINDI_BIHAR'] as const;
export type OwnerVoiceStyle = (typeof OWNER_VOICE_STYLES)[number];

export const OWNER_VOICE_STYLE_LABELS: Readonly<Record<OwnerVoiceStyle, string>> = {
  ACCOUNT: 'Same as app language',
  HINDI: 'Hindi',
  ENGLISH: 'English (India)',
  HINDI_BIHAR: 'Hindi (Bihar style)',
};

export const OWNER_VOICE_TONES = ['NATURAL', 'LIGHT', 'DEEP'] as const;
export type OwnerVoiceTone = (typeof OWNER_VOICE_TONES)[number];

export const OWNER_VOICE_TONE_LABELS: Readonly<Record<OwnerVoiceTone, string>> = {
  NATURAL: 'Natural',
  LIGHT: 'Female-style (lighter)',
  DEEP: 'Male-style (deeper)',
};

export const OWNER_VOICE_PITCH: Readonly<Record<OwnerVoiceTone, number>> = {
  NATURAL: 1,
  LIGHT: 1.15,
  DEEP: 0.86,
};

const hiBihar: VoiceAnnouncements = {
  turnApproaching: () => 'आपकी बारी अब आने वाली है।',
  waitTimeChanged: () => 'आपके इंतज़ार के समय में बदलाव हुआ है।',
  newBookingReceived: (serviceName, barberName, salonName, date, time) => {
    const parts = ['नई बुकिंग आई है।'];
    if (serviceName) parts.push(`${serviceName} सेवा के लिए`);
    if (barberName) parts.push(`${barberName} के नाम पर`);
    if (salonName) parts.push(`${salonName} में`);
    if (date) parts.push(`${date} को`);
    if (time) parts.push(`${time} बजे`);
    parts.push('कृपया देख लीजिए।');
    if (!barberName) parts.push('अभी बार्बर तय नहीं है।');
    return parts.join(' ');
  },
  bookingRescheduled: (date, time) => {
    const when = [date ? `${date} को` : null, time ? `${time} बजे` : null].filter(Boolean).join(' ');
    return when ? `बुकिंग का समय बदल गया है। नया समय ${when} है।` : 'बुकिंग का समय बदल गया है।';
  },
  bookingCancelled: () => 'बुकिंग रद्द हो गई है।',
  newCustomerJoined: (tokenNumber, serviceName) =>
    `कतार में नया ग्राहक आया है। कतार नंबर ${tokenNumber}${serviceName ? `, ${serviceName}` : ''}। कृपया देख लीजिए।`,
  voiceAnnouncementsOn: () => 'आवाज़ वाली सूचना चालू हो गई है।',
  arrivalCheck: (serviceName, time) => {
    const service = serviceName ? `${serviceName} वाले ग्राहक` : 'अपॉइंटमेंट वाले ग्राहक';
    const when = time ? `${time} बजे के ` : '';
    return `अपॉइंटमेंट रिमाइंडर। ${when}${service} पहुंचे हैं कि नहीं, कृपया देख लीजिए।`;
  },
};

export function voiceAnnouncementsForStyle(
  style: OwnerVoiceStyle,
  accountLanguage: Language | null | undefined,
): VoiceAnnouncements {
  if (style === 'HINDI') return hi;
  if (style === 'ENGLISH') return en;
  if (style === 'HINDI_BIHAR') return hiBihar;
  return voiceAnnouncementsFor(accountLanguage);
}

export function speechLocaleForVoiceStyle(
  style: OwnerVoiceStyle,
  accountLanguage: Language | null | undefined,
): string {
  if (style === 'HINDI' || style === 'HINDI_BIHAR') return 'hi-IN';
  if (style === 'ENGLISH') return 'en-IN';
  return accountLanguage ? SPEECH_LOCALE[accountLanguage] : SPEECH_LOCALE[Language.EN];
}

export const VOICE_ANNOUNCEMENTS: Readonly<Record<Language, VoiceAnnouncements>> = {
  [Language.EN]: en,
  [Language.HI]: hi,
};

/** Never throws on an unrecognised value — falls back to English, matching every other
 * "unknown/unset preference" default in this codebase. */
export function voiceAnnouncementsFor(language: Language | null | undefined): VoiceAnnouncements {
  return (language && VOICE_ANNOUNCEMENTS[language]) || VOICE_ANNOUNCEMENTS[Language.EN];
}

/** BCP-47 tags for Speech.speak()'s `language` option / SpeechSynthesisUtterance.lang — the `-IN`
 * region keeps both English and Hindi announcements in an Indian accent/voice where the platform
 * offers one, matching COUNTRY_LOCALE's existing en-IN convention in ../locale. */
export const SPEECH_LOCALE: Readonly<Record<Language, string>> = {
  [Language.EN]: 'en-IN',
  [Language.HI]: 'hi-IN',
};

/**
 * BCP-47 tags for `Intl.DateTimeFormat`/`toLocaleDateString`/`toLocaleTimeString`/`toLocaleString`,
 * driven by the app's own selected UI language — NOT `COUNTRY_LOCALE` in ../locale, which is a
 * business's operating country (for number-grouping/currency) and has nothing to do with which
 * language the viewer has chosen. Physical Build 10 retest found FastQue-generated weekday/month
 * labels (e.g. booking slot times on Owner Bookings) still rendering in English while Hindi was
 * selected, because every call site passed `undefined` as the locale argument — which resolves to
 * the *device's* locale, not this app's language selection. Same values as SPEECH_LOCALE today,
 * but named and documented for its own (date-formatting, not speech) call sites so the two don't
 * have to be conceptually the same constant just because they happen to share values.
 */
export const DATE_LOCALE: Readonly<Record<Language, string>> = {
  [Language.EN]: 'en-IN',
  [Language.HI]: 'hi-IN',
};

/** Shown in the language switcher itself — each language's own name, in its own script. */
export const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  [Language.EN]: 'English',
  [Language.HI]: 'हिन्दी',
};

/** "1st" / "2nd" / "3rd" / "4th" ... "11th"-"13th" are always -th regardless of the last digit. */
export function ordinalDay(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * Voice/push booking announcements must speak the SALON's local date/time, never the listening
 * device's — a booking made from a phone in a different timezone must announce the same wall-
 * clock time an owner physically in that salon would recognize as their own. Pure: takes the IANA
 * zone the caller already resolved (apps/*'s own dashboard/salons/:salonId/timezone lookup),
 * never infers one itself.
 *
 * `date` is "5th September" (ordinal day + full month name, no year — a booking is always for the
 * near future). `time` drops a redundant ":00" ("10 AM") but keeps real minutes ("10:30 AM") —
 * built from Intl.DateTimeFormat parts rather than string-slicing the formatted output, so it
 * can't silently drift for locales/hour-cycles this file doesn't anticipate.
 */
export function formatVoiceDateTime(isoUtc: string, timeZone: string): { date: string; time: string } {
  const when = new Date(isoUtc);
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: 'numeric',
    month: 'long',
  }).formatToParts(when);
  const day = Number(dateParts.find((p) => p.type === 'day')?.value ?? '');
  const month = dateParts.find((p) => p.type === 'month')?.value ?? '';
  const date = Number.isFinite(day) && month ? `${ordinalDay(day)} ${month}` : '';

  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  }).formatToParts(when);
  const hour = timeParts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = timeParts.find((p) => p.type === 'minute')?.value ?? '0';
  const dayPeriod = timeParts.find((p) => p.type === 'dayPeriod')?.value ?? '';
  // Intl's `minute: 'numeric'` still zero-pads ("00", not "0") in this runtime's ICU data — compare
  // the numeric value, not the raw string, so an on-the-hour slot reliably drops the ":00".
  const time = hour ? `${hour}${Number(minute) !== 0 ? `:${minute.padStart(2, '0')}` : ''} ${dayPeriod}`.trim() : '';

  return { date, time };
}

/**
 * Issue 9 (mobile launch mission) — the customer-journey strings a direct, pre-auth-reachable
 * language switcher actually needs. Deliberately a flat, keyed dictionary (not a template/ICU
 * system) — every value here is a short label or a fixed short sentence, never one built from
 * interpolated user data (booking/salon/service names stay in their own source language
 * regardless of UI language, same as the voice announcements above).
 */
export interface UiStrings {
  city: string;
  service: string;
  search: string;
  searchPlaceholder: string;
  nearMe: string;
  book: string;
  joinQueue: string;
  confirm: string;
  cancel: string;
  keepBooking: string;
  waiting: string;
  yourTurn: string;
  called: string;
  inService: string;
  signIn: string;
  signInWithGoogle: string;
  notifications: string;
  noNotifications: string;
  markAllRead: string;
  retry: string;
  open: string;
  closed: string;
  noResults: string;
  loading: string;
  outstandingDue: string;
  freeCancellation: string;
  statusConfirmed: string;
  statusPendingPayment: string;
  statusCancelled: string;
  statusCompleted: string;
  statusNoShow: string;
  statusExpired: string;
  genericError: string;
  offline: string;

  // Bottom tab labels — shown on every screen, so a gap here is the most visible kind of
  // half-translated app. One flat set reused across the customer/owner/staff tab bars rather than
  // three near-duplicate keys per role.
  tabHome: string;
  tabSearch: string;
  tabBookings: string;
  tabQueue: string;
  tabAccount: string;
  tabDashboard: string;
  tabShop: string;
  tabToday: string;

  // Account (customer + owner/staff DashboardAccountScreen share this set where the underlying
  // concept is identical — "account", "signed-in devices", etc. are role-agnostic).
  yourAccount: string;
  email: string;
  phone: string;
  accountType: string;
  signedInDevices: string;
  thisDevice: string;
  signOut: string;
  signOutThisDevice: string;
  language: string;

  // Owner/staff operational surfaces (Dashboard, Manage Shop, Bookings filters/status).
  dashboardTitle: string;
  manageShop: string;
  servicesLabel: string;
  chairsLabel: string;
  staffLabel: string;
  hoursLabel: string;
  photosLabel: string;
  customersLabel: string;
  customerLabel: string;
  addService: string;
  addChair: string;
  addBarber: string;
  addPhoto: string;
  saveAction: string;
  editAction: string;
  removeAction: string;
  cancelAction: string;
  activateAction: string;
  deactivateAction: string;
  viewCustomers: string;
  todayTitle: string;
  filterToday: string;
  filterUpcoming: string;
  filterCompleted: string;
  filterCancelled: string;
  filterNoShow: string;
  filterHistory: string;
  loadMore: string;

  // RoleSelectScreen (the pre-auth landing screen) — a real Build 9 physical-device screenshot
  // showed this exact screen half-translated: the browse card's own `t.city`/`t.book`/etc. calls
  // resolved to Hindi, but "Find a shop", "Already know your account?" and the three role
  // titles/subtitles sitting right next to them were hardcoded English literals never wired to
  // this module at all — the most visible possible half-translated-app symptom.
  findAShop: string;
  browseHint: string;
  orContinueAs: string;
  alreadyKnowAccount: string;
  roleCustomer: string;
  roleCustomerSubtitle: string;
  roleOwner: string;
  roleOwnerSubtitle: string;
  roleStaff: string;
  roleStaffSubtitle: string;

  // HomeScreen (the first screen a signed-in customer sees).
  welcomeBack: string;
  welcomeSubtitle: string;
  liveQueueLabel: string;
  tokenNumberPrefix: string;
  calledMessage: string;
  positionPrefix: string;
  positionSuffix: string;
  viewQueueStatus: string;
  upcomingBookingLabel: string;
  viewBookingAction: string;
  bookAheadKicker: string;
  reserveChair: string;
  serviceBarberTime: string;
  joinLiveKicker: string;
  skipTheWait: string;
  findShopJoinQueue: string;
  myBookings: string;
  aiStyleAdvisor: string;
  accountAndPremium: string;

  // HomeScreen premium redesign (FastQue Home discovery mission checkpoint).
  homeHeroEyebrow: string;
  homeHeroHeadlineLine1: string;
  homeHeroHeadlineLine2: string;
  homeHeroSubcopy: string;
  chooseLocationAction: string;
  detectingLocationAction: string;
  searchModeBarber: string;
  searchModeSalon: string;
  shopOrServiceLabel: string;
  shopOrServiceExample: string;
  cityLocationLabel: string;
  findABarberAction: string;
  findShopsAction: string;
  popularServicesTitle: string;
  viewAllAction: string;
  categoryHaircut: string;
  categoryBeardTrim: string;
  categoryFade: string;
  categoryShave: string;
  categoryNails: string;
  categorySpa: string;
  queuePromoHeadlineLine1: string;
  queuePromoHeadlineLine2: string;
  queuePromoSubcopy: string;
  trustShopsLabel: string;
  trustExperienceLabel: string;
  trustRealTimeLabel: string;
  trustOffersLabel: string;
  // Part 8/9 (Home discovery information) — appended after the real activeShopCount from
  // GET salons/live-stats, replacing the static trustShopsLabel once that real number has loaded
  // (see HomeScreen.tsx). Never shown with a fabricated count; trustShopsLabel remains the
  // fallback while live stats are still loading or the request fails. Includes a leading space.
  trustShopsCountSuffix: string;
  fastQueCreditsShortcut: string;
  startingPricePrefix: string;

  notSet: string;
  unknownDevice: string;
  signedInOnPrefix: string;
  signingOut: string;

  // OwnerDashboardScreen.
  statusPrefix: string;
  activeService: string;
  activeChair: string;
  activeBarber: string;
  closeShop: string;
  openShop: string;
  todaysBookings: string;
  completedTodayLabel: string;
  cancelledNoShowToday: string;
  liveQueue: string;
  registerShopHint: string;

  bookingsTitle: string;
  newBookingReceivedBanner: string;
  bookingCancelledBanner: string;
  // Build 10 physical-device retest (Hindi TTS blocker) — shown, throttled, when Hindi is the
  // active language but the device has no installed Hindi voice, so voice-announce.ts skips
  // speaking rather than silently using an English/default voice. Actionable: tells the owner
  // exactly what to go do, not just that something failed.
  hindiVoiceUnavailableWarning: string;
  noShopSelected: string;
  selectShopHint: string;
  noBookingsTitle: string;
  noBookingsHint: string;
  newBadge: string;
  preferredPrefix: string;

  // OwnerShopScreen (Manage Shop).
  selectShopTitle: string;
  chooseShopHint: string;
  shopSubtitle: string;
  noServicesYet: string;
  browseServiceSuggestions: string;
  hideServiceSuggestions: string;
  noChairsYet: string;
  noBarbersYet: string;
  customersHint: string;
  coverPhotoHint: string;
  noPhotosYet: string;
  replaceCoverPhoto: string;
  addCoverPhoto: string;
  addGalleryPhoto: string;

  // Mobile Shop Owner Onboarding mission — signed-out/no-shop-yet entry points.
  registerShopCta: string;
  listYourShopCta: string;
  newToFastQueRegisterShop: string;
  noShopYetRouteToRegistration: string;

  // RegisterShopScreen.
  registerShopTitle: string;
  registerShopSubtitle: string;
  shopNameLabel: string;
  shopNamePlaceholder: string;
  shopCountryLabel: string;
  selectCountryPlaceholder: string;
  loadingCountriesHint: string;
  shopCityLabel: string;
  citySearchPlaceholder: string;
  citySearchTooShortHint: string;
  citySearchNoResults: string;
  citySearchFailedHint: string;
  changeCityAction: string;
  shopLocalityLabel: string;
  shopLocalityOptionalHint: string;
  noLocalityOption: string;
  shopAddressLabel: string;
  shopAddressPlaceholder: string;
  shopPostalCodeOptionalSuffix: string;
  shopPhoneLabel: string;
  shopEmailLabel: string;
  useCurrentLocationAction: string;
  detectingLocationEllipsis: string;
  locationDetectedLabel: string;
  locationSkippedHint: string;
  chooseCountryFirstError: string;
  chooseCityFirstError: string;
  registerShopAction: string;
  registeringShopEllipsis: string;
  couldNotRegisterShop: string;

  // OwnerOnboardingScreen — 7-step setup wizard chrome (Mobile Shop Owner Onboarding mission).
  onboardingStepOf(step: number, total: number): string;
  onboardingWelcomeTitle: string;
  onboardingWelcomeHint: string;
  onboardingServicesStepTitle: string;
  onboardingHoursStepTitle: string;
  onboardingPhotosStepTitle: string;
  onboardingChairsStepTitle: string;
  onboardingStaffStepTitle: string;
  onboardingPaymentQrStepTitle: string;
  onboardingPaymentQrStepHint: string;
  onboardingGoLiveStepTitle: string;
  saveAndNextAction: string;
  previousAction: string;
  skipForNowAction: string;
  goLiveAction: string;
  goingLiveEllipsis: string;
  setupIncompleteTitle: string;
  setupIncompleteMissingService: string;
  setupIncompleteMissingChair: string;
  setupIncompleteMissingStaff: string;
  couldNotGoLive: string;
  shopIsLiveTitle: string;
  shopIsLiveHint: string;
  continueToDashboardAction: string;
  resumeSetupBanner: string;

  // StaffTodayScreen.
  noShopYetTitle: string;
  noShopYetHint: string;
  todaysQueue: string;

  // Navigation stack header titles (customer + auth stacks) — shown at the top of literally
  // every screen below the tab root, so a gap here is maximally visible.
  findASalonTitle: string;
  salonTitle: string;
  chooseABarberTitle: string;
  chooseADateTitle: string;
  chooseATimeTitle: string;
  confirmTitle: string;
  queueTitle: string;
  bookingTitle: string;
  signInTitle: string;
  passwordRecoveryTitle: string;
  homeButtonLabel: string;

  // AccountScreen (customer) + shared role labels.
  accountDetailsCard: string;
  contactDetailsSubtitle: string;
  couldNotLoadSessions: string;
  couldNotSignOutSession: string;
  couldNotSignOutOtherSessions: string;
  voiceHint: string;
  premiumActive: string;
  premiumInactive: string;
  noActiveSessions: string;
  signOutOtherSessions: string;
  roleCustomerLabel: string;
  roleStaffLabel: string;
  roleOwnerLabel: string;
  roleAdminLabel: string;
  premiumLabel: string;

  // Core booking flow: DateSelect, SlotSelect, StaffSelect, ConfirmBooking, BookingDetail,
  // MyBookings, WalkInJoin, QueueScreen, QueueStatusPanel, SalonSearch, SalonProfile.
  anyStaffOption: string;
  staffSelectHint: string;
  slotsClosedLabel: string;
  noSlotsTitle: string;
  noSlotsHint: string;
  availableLegend: string;
  occupiedLegend: string;
  availableWord: string;
  occupiedWord: string;
  timeAvailabilityLegend: string;
  couldNotLoadTimes: string;
  couldNotLoadStaff: string;
  getDirections: string;
  shareAction: string;
  shareOnWhatsApp: string;
  bookAgainAction: string;
  cancelBookingAction: string;
  hideRescheduleAction: string;
  rescheduleAction: string;
  cancelBookingConfirmTitle: string;
  confirmCancellationAction: string;
  checkInAction: string;
  statusLabelPrefix: string;
  preferredBarberPrefix: string;
  styleLabelPrefix: string;
  prepaymentRequiredPrefix: string;
  cancellationChargePrefix: string;
  bookingIdPrefix: string;
  couldNotLoadBooking: string;
  couldNotShare: string;
  couldNotLoadCancellationPolicy: string;
  couldNotCancelBooking: string;
  couldNotCheckIn: string;
  couldNotCreateBooking: string;
  bookingConfirmedTitle: string;
  confirmBookingTitle: string;
  viewMyBookings: string;
  freeCancellationUpTo: string;
  beforeYourAppointment: string;
  hoursSingular: string;
  hoursPlural: string;
  minutesSuffix: string;
  myBookingsTitle: string;
  noBookingsYetTitle: string;
  noBookingsYetHint: string;
  viewDetailsAction: string;
  couldNotLoadBookings: string;
  couldNotJoinQueue: string;
  alreadyInQueueTitle: string;
  alreadyInQueueHint: string;
  cancelLiveQueueAction: string;
  cancellingLiveQueueLabel: string;
  cancelLiveQueueA11yLabel: string;
  cancelLiveQueueConfirmTitle: string;
  cancelLiveQueueConfirmMessage: string;
  keepMyPlaceAction: string;
  confirmCancelLiveQueueAction: string;
  couldNotCancelLiveQueue: string;
  cancelLiveQueueReassurance: string;
  youreInLineTitle: string;
  joinTheQueueTitle: string;
  serviceOptional: string;
  anyServiceOption: string;
  queueStatusTitle: string;
  noActiveQueueTitle: string;
  noActiveQueueHint: string;
  findASalonAction: string;
  couldNotLoadQueueStatus: string;
  tokenNumberLabel: string;
  estimatedWaitLabel: string;
  headOverNowMessage: string;
  withBarberPrefix: string;
  turnAlmostHereToast: string;
  waitChangedToast: string;
  findASalonSearchTitle: string;
  searchAction: string;
  locatingAction: string;
  nearMeFound: string;
  couldNotSearchSalons: string;
  locationDenied: string;
  couldNotGetLocation: string;
  noSalonsFoundTitle: string;
  noSalonsFoundHint: string;
  openNowLabel: string;
  closedNowLabel: string;
  salonTypeFilterLabel: string;
  salonTypeAll: string;
  salonTypeMale: string;
  salonTypeFemale: string;
  salonTypeUnisex: string;
  salonTypeNotSet: string;
  compareServiceLabel: string;
  compareServiceNone: string;
  sortLabel: string;
  sortRecommended: string;
  sortDistance: string;
  sortPrice: string;
  sortRating: string;
  sortPriceNeedsService: string;
  ratingFilterLabel: string;
  ratingFilterAny: string;
  favoritesOnlyLabel: string;
  saveFavoriteAction: string;
  removeFavoriteAction: string;
  favoritesSignInHint: string;
  favoritesEmptyHint: string;
  favoriteUpdateFailed: string;
  // Unit-agnostic — the actual number+unit ("2 km"/"1.2 mi") comes from formatDistance, which
  // already picks metric vs imperial per salon country; this is only ever appended after that.
  awaySuffix: string;
  // Part 8/9 (distance + price filters), SalonSearchScreen. Distance chips only render once "Near
  // Me" coordinates are known (radiusKm is meaningless without a query point — see
  // salonSearchQuerySchema's own doc comment); price chips are always available. "Any" clears that
  // filter back to unset, never a fabricated 0 value. Values corrected (Part 8/9 review) to
  // practical near-shop radii (100m-5km) instead of the original 2/5/10/25km set — the canonical
  // internal radiusKm sent to the backend is still exactly 0.1/0.2/0.5/1/2/3/5, in km; these labels
  // are metric display only (formatDistance handles imperial elsewhere) since the chips apply to
  // the whole result set, not one salon with its own country.
  distanceFilterLabel: string;
  /** Shown only while no location is set yet — explains that picking a radius will ask for it. */
  distanceFilterLocationHint: string;
  distanceFilterAny: string;
  distanceFilter100m: string;
  distanceFilter200m: string;
  distanceFilter500m: string;
  distanceFilter1km: string;
  distanceFilter2km: string;
  distanceFilter3km: string;
  distanceFilter5km: string;
  priceFilterLabel: string;
  priceFilterAny: string;
  priceFilterOver1000: string;
  /** Rendered as `${priceFilterUpToPrefix}${maxRupees}${priceFilterUpToSuffix}` — a preset row
   * like "Up to ₹50" (EN) / "₹50 तक" (HI), one per ₹20 step from ₹30 to ₹990. */
  priceFilterUpToPrefix: string;
  priceFilterUpToSuffix: string;
  /** Same prefix/suffix pattern as above, for the Custom modal's "only a minimum was entered"
   * display case (e.g. "From ₹450" / "₹450 से अधिक") — never a preset row, only a custom value. */
  priceFilterFromPrefix: string;
  priceFilterFromSuffix: string;
  priceFilterCustomLabel: string;
  priceFilterMinLabel: string;
  priceFilterMaxLabel: string;
  priceFilterApplyAction: string;
  priceFilterClearAction: string;
  priceFilterErrorNegative: string;
  priceFilterErrorMinExceedsMax: string;
  serviceFilterLabel: string;
  serviceFilterAll: string;
  serviceCategoryHair: string;
  serviceCategoryBarber: string;
  serviceCategoryBeard: string;
  serviceCategoryNails: string;
  serviceCategoryFacial: string;
  serviceCategoryMakeup: string;
  serviceCategoryWaxingThreading: string;
  serviceCategorySpaMassage: string;
  serviceCategoryBridalEvent: string;
  closeFilterMenu: string;
  couldNotLoadSalon: string;
  salonNotFound: string;
  photoGalleryHint: string;
  photosTapToView: string;
  verifiedBadge: string;
  reviewsSuffix: string;
  joinQueueNow: string;
  meetTheTeam: string;
  // Multi-service booking core mission — advances from the multi-select service picker (mobile's
  // SalonProfileScreen) once at least one service is chosen, to the staff-selection step.
  continueLabel: string;
  bookingForTheLookPrefix: string;
  bookingForTheLookSuffix: string;
  searchByNamePlaceholder: string;
  reviewsTitle: string;

  // PhoneOtpLoginScreen (customer sign-in).
  continueWithGoogle: string;
  couldNotSignInWithGoogle: string;
  signInUnavailableNotice: string;
  orDivider: string;
  invalidPhoneNumber: string;
  couldNotSendOtp: string;
  newCodeSent: string;
  couldNotResendCode: string;
  invalidCode: string;
  couldNotVerifyOtp: string;
  otpSubtitleGoogleOnly: string;
  otpSubtitleBoth: string;
  enterCodeSentToPrefix: string;
  phoneOtpUnavailableNotice: string;
  phoneNumberPlaceholder: string;
  otpCodePlaceholder: string;
  sendOtpAction: string;
  verifyAndContinueAction: string;
  resendOtpAction: string;
  resendOtpInPrefix: string;
  resendOtpInSuffix: string;

  // Small shared UI components (ErrorState, NotificationBell, PhotoGalleryViewer, OfflineBanner,
  // PublicSalonStatus).
  tryAgain: string;
  unreadSuffix: string;
  closePhotoGallery: string;
  offlineMessage: string;
  liveShopSnapshotLabel: string;
  liveShopSnapshotEyebrow: string;
  aChairWhenReady: string;
  activeChairsSuffix: string;
  waitingCountSuffix: string;
  professionalAvailabilityHint: string;
  aggregateCountsNote: string;
  cancellingWillChargePrefix: string;
  cancellingWillChargeSuffix: string;
  noChargeFreeWindow: string;
  barberPrefix: string;
  minutesAbbrev: string;
  yearsExpAbbrev: string;
  yearsExperienceWord: string;
  /** Sun..Sat, in display order — index by JS Date#getDay()/dayOfWeek (0=Sunday). */
  dayAbbreviations: readonly [string, string, string, string, string, string, string];

  // OwnerShopScreen sub-components (ServiceRow, AddServiceForm, ChairRow, AddChairForm,
  // HoursEditor, AddStaffForm) — Manage Shop's remaining Save/Cancel/Add forms.
  couldNotSaveService: string;
  couldNotUpdateService: string;
  couldNotAddService: string;
  couldNotUpdateChair: string;
  couldNotAddChair: string;
  couldNotAddBarber: string;
  servicePlaceholder: string;
  pricePlaceholder: string;
  minutesPlaceholder: string;
  chairLabelPlaceholder: string;
  barberNamePlaceholder: string;
  staffPhoneOptionalPlaceholder: string;
  emailOptionalPlaceholder: string;
  inactiveSuffix: string;
  invitePendingSuffix: string;
  addAction: string;
  reactivateAction: string;
  invalidPhoneFormatHint: string;
  openToggleLabel: string;
  checkHoursPrefix: string;
  checkHoursSuffix: string;
  saveHoursAction: string;
  couldNotSaveHours: string;
  ownerEyebrow: string;

  // OwnerCustomersScreen / OwnerCustomerDetailScreen.
  segmentNew: string;
  segmentRepeat: string;
  segmentFrequent: string;
  noContactOnFile: string;
  couldNotLoadCustomer: string;
  couldNotLoadCustomers: string;
  customerNotFound: string;
  customerSuffix: string;
  outstandingBlockedPrefix: string;
  outstandingBlockedSuffix: string;
  duesTitle: string;
  noDuesYet: string;
  noShowDueReason: string;
  cancellationChargeReason: string;
  outstandingBadge: string;
  waivedBadge: string;
  noRelatedBooking: string;
  recordedPrefix: string;
  waiveNoShowDueAction: string;
  restoreDueRowAction: string;
  waiveConfirmPrefix: string;
  waiveConfirmSuffix: string;
  restoreConfirmPrefix: string;
  restoreConfirmSuffix: string;
  waiveDueAction: string;
  restoreDueModalAction: string;
  graceEligiblePrefix: string;
  graceEligibleMiddle: string;
  graceEligibleSuffix: string;
  graceCompletedPrefix: string;
  graceCompletedSuffix: string;
  customersTitle: string;
  customersSubtitle: string;
  noCustomersYetTitle: string;
  noCustomersYetHint: string;
  outstandingSuffix: string;
  couldNotWaiveDue: string;
  couldNotRestoreDue: string;
  chooseShopQueueHint: string;

  // OwnerStaffLoginScreen / OwnerStaffPasswordRecoveryScreen.
  signInToYourShop: string;
  signInToWorkToday: string;
  useYourDashboardAccount: string;
  onlyWorksIfRegisteredOwner: string;
  onlyWorksIfRegisteredStaff: string;
  passwordLabel: string;
  forgotPasswordQuestion: string;
  enterValidEmailPassword: string;
  couldNotSignIn: string;
  enterValidEmail: string;
  recoveryUnavailableNotice: string;
  checkYourInboxTitle: string;
  eligibleAccountPrefix: string;
  eligibleAccountSuffix: string;
  afterResetHint: string;
  backToSignIn: string;
  resetYourPasswordTitle: string;
  enterEmailForAccountPrefix: string;
  enterEmailForAccountSuffix: string;
  roleLabelOwner: string;
  roleLabelStaff: string;
  sendResetLinkAction: string;
  emailAddressAccessibilityLabel: string;

  // CapacitySummaryPanel, LiveQueuePanel (owner dashboard widgets).
  chairsFreeLabel: string;
  barbersFreeLabel: string;
  waitingLabel: string;
  avgWaitLabel: string;
  couldNotCompleteAction: string;
  callAction: string;
  phoneCustomerAction: string;
  markArrivedAction: string;
  arrivedStatus: string;
  notYetArrivedStatus: string;
  customerNameMissing: string;
  customerPhoneMissing: string;
  keepEntryAction: string;
  confirmCancelEntryTitle: string;
  confirmCancelEntryBody: string;
  confirmNoShowEntryTitle: string;
  confirmNoShowEntryBody: string;
  confirmCompleteServiceTitle: string;
  confirmCompleteServiceBody: string;
  queueEntryChangedError: string;
  queueActionNotAllowedError: string;
  queueNetworkError: string;
  contactNameLabel: string;
  contactPhoneLabel: string;
  contactPhoneHint: string;
  contactNameRequiredError: string;
  contactPhoneInvalidError: string;
  assignAction: string;
  noShowAction: string;
  barberLabel: string;
  chairLabel: string;
  confirmAssignmentAction: string;
  completeAction: string;
  couldNotLoadQueue: string;
  queueIsEmptyTitle: string;
  queueIsEmptyHint: string;
  statusCalledShort: string;

  // Style Advisor screen (mobile)
  photoLibraryAccessNeeded: string;
  aiStylePreviewUnavailable: string;
  aiStyleAdvisorPremiumTitle: string;
  upgradeToPreviewHairstyles: string;
  aiStyleAdvisorEyebrow: string;
  outOfAiStyleCreditsTitle: string;
  outOfAiStyleCreditsSubtitle: string;
  yourLooksTitle: string;
  aiStyleMatchDisclaimer: string;
  aiStyleMatchPrefix: string;
  aiStyleMatchSuffix: string;
  tryThisLookAction: string;
  previewYourNextLookTitle: string;
  uploadPhotoPreviewSubtitle: string;
  choosePhotoAction: string;
  chooseDifferentPhotoAction: string;
  aiCreditsRemainingPrefix: string;
  analyzeMyPhotoAction: string;
  photoNotStoredNote: string;

  // Review panel (mobile)
  yourReviewTitle: string;
  shopsResponseLabel: string;
  editReviewAction: string;
  editYourReviewTitle: string;
  leaveAReviewTitle: string;
  optionalCommentPlaceholder: string;
  savingEllipsis: string;
  removingEllipsis: string;
  saveReviewAction: string;
  submitReviewAction: string;
  couldNotSaveReview: string;

  // Reschedule sheet (mobile)
  rescheduleBookingTitle: string;
  currentlyPrefix: string;
  noSlotsOnThisDay: string;
  keepCurrentTimeAction: string;
  reschedulingEllipsis: string;
  confirmNewTimeAction: string;
  couldNotRescheduleBooking: string;

  // Google sign-in error messages (lib/google-signin.ts)
  googleSignInUnavailable: string;
  googlePlayServicesUnavailable: string;
  couldNotOpenGooglePicker: string;
  googleNoTokenReturned: string;
  couldNotCompleteGoogleSignIn: string;

  // Network / data-loading error fallbacks
  networkOfflineMessage: string;
  couldNotLoadSalons: string;
  couldNotOpenBookingFlow: string;
  couldNotStartNewBooking: string;

  // Relative-time labels (NotificationsScreen)
  justNowLabel: string;
  minutesAgoSuffix: string;
  hoursAgoSuffix: string;
  daysAgoSuffix: string;

  // SafeImage accessibility fallback labels
  photoUnavailableLabel: string;
  noPhotoYetLabel: string;

  // OwnerShopScreen photo upload
  photoLibraryAccessNeededForShopPhotos: string;
  photoOverSizeLimitPrefix: string;
  photoOverSizeLimitSuffix: string;
  noShopsYetTitle: string;
  bookingFiltersLabel: string;
  bookingFiltersHint: string;
  confirmedEyebrow: string;
  discoveryEyebrow: string;

  // Share-sheet text (lib/booking-actions.ts)
  shareBookingPrefix: string;
  shareBookingMiddle: string;

  // Booking reference prefix (OwnerBookingsScreen card, "· Ref abcd1234")
  bookingRefPrefix: string;

  /** Connector for "{service} at {salon}" (ConfirmBookingScreen) — includes surrounding spaces. */
  atConnector: string;

  /**
   * Part 5 (show arrival time after booking) — appended after an arrival time whenever it's shown
   * in the salon's own zone and that differs from the device's own (formatBookingArrivalTime's
   * isDeviceLocalTimezone === false), so a traveling customer knows the clock time isn't in their
   * own timezone. Includes a leading space.
   */
  shopLocalTimeSuffix: string;

  /**
   * Part 5 completion (arrival guidance) — labels for BookingDetailDto's checkInOpensAt/
   * checkInDueBy. appointmentTimePrefix relabels what used to be a bare arrival-time line;
   * checkInBetweenPrefix introduces the full window (ConfirmBookingScreen success state,
   * BookingDetailScreen); checkInByPrefix is the compact, single-boundary form for space-limited
   * cards (MyBookingsScreen). All include a trailing ": " like the other *Prefix strings above.
   */
  appointmentTimePrefix: string;
  checkInBetweenPrefix: string;
  checkInByPrefix: string;

  // FastQue Credits / Wallet V1
  fastQueCreditsLabel: string;
  walletBalanceLabel: string;
  redeemCreditsLabel: string;
  redeemCreditsHint: string;
  creditsRedeemedLabel: string;
  payableAmountLabel: string;
  fullPriceLabel: string;
  couldNotLoadCreditsBalance: string;
  noCreditsHistoryYet: string;
  creditsHistoryTitle: string;
  promoGrantEntryLabel: string;
  redeemedCreditsEntryLabel: string;
  restoredCreditsEntryLabel: string;
  manualAdjustmentEntryLabel: string;
  paymentQrRequiredMessage: string;
  paymentQrSectionTitle: string;
  paymentQrSectionHint: string;
  uploadPaymentQrAction: string;
  linkPaymentQrAction: string;
  removePaymentQrAction: string;
  noPaymentQrConfiguredLabel: string;
  paymentQrConfiguredLabel: string;
  couldNotSavePaymentQr: string;
  couldNotRemovePaymentQr: string;
}

const enUi: UiStrings = {
  city: 'City',
  service: 'Service',
  search: 'Search',
  searchPlaceholder: 'Search shops or services…',
  nearMe: 'Near me',
  book: 'Book an appointment',
  joinQueue: 'Join live queue',
  confirm: 'Confirm booking',
  cancel: 'Cancel booking',
  keepBooking: 'Keep booking',
  waiting: 'Waiting',
  yourTurn: "It's your turn",
  called: "You're being called",
  inService: 'In service',
  signIn: 'Sign in',
  signInWithGoogle: 'Sign in with Google',
  notifications: 'Notifications',
  noNotifications: "You're all caught up",
  markAllRead: 'Mark all read',
  retry: 'Try again',
  open: 'Open now',
  closed: 'Closed',
  noResults: 'No results found',
  loading: 'Loading…',
  outstandingDue: 'Outstanding due',
  freeCancellation: 'Free cancellation',
  statusConfirmed: 'Confirmed',
  statusPendingPayment: 'Payment pending',
  statusCancelled: 'Cancelled',
  statusCompleted: 'Completed',
  statusNoShow: 'No-show',
  statusExpired: 'Expired',
  genericError: 'Something went wrong. Please try again.',
  offline: "You appear to be offline.",

  tabHome: 'Home',
  tabSearch: 'Search',
  tabBookings: 'Bookings',
  tabQueue: 'Queue',
  tabAccount: 'Account',
  tabDashboard: 'Dashboard',
  tabShop: 'Shop',
  tabToday: 'Today',

  yourAccount: 'Your account',
  email: 'Email',
  phone: 'Phone',
  accountType: 'Account type',
  signedInDevices: 'Signed-in devices',
  thisDevice: 'this device',
  signOut: 'Sign out',
  signOutThisDevice: 'Log out of this device',
  language: 'Language',

  dashboardTitle: 'Dashboard',
  manageShop: 'Manage shop',
  servicesLabel: 'Services',
  chairsLabel: 'Chairs',
  staffLabel: 'Staff',
  hoursLabel: 'Hours',
  photosLabel: 'Photos',
  customersLabel: 'Customers',
  customerLabel: 'Customer',
  addService: 'Add service',
  addChair: 'Add chair',
  addBarber: 'Add staff',
  addPhoto: 'Add photo',
  saveAction: 'Save',
  editAction: 'Edit',
  removeAction: 'Remove',
  cancelAction: 'Cancel',
  activateAction: 'Activate',
  deactivateAction: 'Deactivate',
  viewCustomers: 'View customers',
  todayTitle: 'Today',
  filterToday: 'Today',
  filterUpcoming: 'Upcoming',
  filterCompleted: 'Completed',
  filterCancelled: 'Cancelled',
  filterNoShow: 'No-show',
  filterHistory: 'History',
  loadMore: 'Load more',

  findAShop: 'Find a shop',
  browseHint: 'Book or join a live queue — no sign-in needed to look around.',
  orContinueAs: 'Or continue as',
  alreadyKnowAccount: 'Already know your account?',
  roleCustomer: 'Customer',
  roleCustomerSubtitle: 'Book a chair or join a live queue',
  roleOwner: 'Shop Owner',
  roleOwnerSubtitle: 'Run your salon, queue, and team',
  roleStaff: 'Barber / Staff',
  roleStaffSubtitle: "Work today's queue and bookings",

  welcomeBack: 'Welcome back',
  welcomeSubtitle: 'Book ahead, or join a live queue near you.',
  liveQueueLabel: 'Live queue',
  tokenNumberPrefix: 'Queue #',
  calledMessage: "You're being called — please head to the counter!",
  positionPrefix: 'Position ',
  positionSuffix: ' in line',
  viewQueueStatus: 'View queue status',
  upcomingBookingLabel: 'Upcoming booking',
  viewBookingAction: 'View booking',
  bookAheadKicker: 'Book ahead',
  reserveChair: 'Reserve a chair',
  serviceBarberTime: 'Service → barber → time',
  joinLiveKicker: 'Join live',
  skipTheWait: 'Skip the wait',
  findShopJoinQueue: 'Find a shop, join the queue',
  myBookings: 'My bookings',
  aiStyleAdvisor: 'AI Style Advisor',
  accountAndPremium: 'Account & Premium',

  homeHeroEyebrow: 'GOOD LOOKS · LESS WAITING',
  homeHeroHeadlineLine1: 'Your Style.',
  homeHeroHeadlineLine2: 'Your Time.',
  homeHeroSubcopy: 'Discover barbers, salons and grooming services. Book ahead or join a live queue.',
  chooseLocationAction: 'Choose location',
  detectingLocationAction: 'Detecting…',
  searchModeBarber: 'Find a barber',
  searchModeSalon: 'Find a salon & more',
  shopOrServiceLabel: 'Service',
  shopOrServiceExample: 'Haircut, hair spa, beard trim, massage…',
  cityLocationLabel: 'City / Location',
  findABarberAction: 'Find a barber',
  findShopsAction: 'Find shops',
  popularServicesTitle: 'Popular Services',
  viewAllAction: 'View all',
  categoryHaircut: 'Haircut',
  categoryBeardTrim: 'Beard Trim',
  categoryFade: 'Fade',
  categoryShave: 'Shave',
  categoryNails: 'Nails',
  categorySpa: 'Spa',
  queuePromoHeadlineLine1: 'Skip the wait.',
  queuePromoHeadlineLine2: 'Keep your day.',
  queuePromoSubcopy: 'Real-time queue, live updates.',
  trustShopsLabel: 'Trusted Shops',
  trustExperienceLabel: 'Better Experience',
  trustRealTimeLabel: 'Real-time Updates',
  trustOffersLabel: 'Great Offers',
  trustShopsCountSuffix: ' Trusted Shops',
  fastQueCreditsShortcut: 'FastQue Credits',
  startingPricePrefix: 'From ',

  notSet: 'Not set',
  unknownDevice: 'Unknown device',
  signedInOnPrefix: 'Signed in ',
  signingOut: 'Signing out…',

  statusPrefix: 'Status: ',
  activeService: 'Active service',
  activeChair: 'Active chair',
  activeBarber: 'Active barber',
  closeShop: 'Close shop',
  openShop: 'Open shop',
  todaysBookings: "Today's bookings",
  completedTodayLabel: 'Completed today',
  cancelledNoShowToday: 'Cancelled / no-show today',
  liveQueue: 'Live queue',
  registerShopHint: 'Register a shop on the FastQue web dashboard to manage it here.',

  bookingsTitle: 'Bookings',
  newBookingReceivedBanner: 'New booking received',
  bookingCancelledBanner: 'Booking cancelled',
  hindiVoiceUnavailableWarning:
    "Hindi voice isn't installed on this device, so voice announcements are silent. Install a Hindi text-to-speech voice in your phone's Settings, then reopen FastQue to try again.",
  noShopSelected: 'No shop selected',
  selectShopHint: 'Select a shop from the Dashboard tab to see its bookings.',
  noBookingsTitle: 'No bookings',
  noBookingsHint: 'Nothing in this view yet.',
  newBadge: 'NEW',
  preferredPrefix: 'Pref: ',

  selectShopTitle: 'Select a shop',
  chooseShopHint: 'Choose a shop from the Dashboard tab first.',
  shopSubtitle: 'Services, chairs, staff, and hours',
  noServicesYet: 'No services yet.',
  browseServiceSuggestions: 'Choose service pack',
  hideServiceSuggestions: 'Hide service packs',
  noChairsYet: 'No chairs yet.',
  noBarbersYet: 'No staff added yet.',
  customersHint: 'Visit history, dues, and no-show waivers for everyone who has booked at your shop.',
  coverPhotoHint: 'Your cover photo is what customers see first when they find you.',
  noPhotosYet: 'No photos yet.',
  replaceCoverPhoto: 'Replace cover photo',
  addCoverPhoto: 'Add cover photo',
  addGalleryPhoto: 'Add gallery photo',

  registerShopCta: 'Register your shop',
  listYourShopCta: 'List your shop on FastQue',
  newToFastQueRegisterShop: 'New to FastQue? Register your shop',
  noShopYetRouteToRegistration: "You don't have a shop yet. Register one to get started.",

  registerShopTitle: 'Register your shop',
  registerShopSubtitle: 'Tell us about your shop. You can add services, hours, photos and staff next.',
  shopNameLabel: 'Shop name',
  shopNamePlaceholder: 'e.g. Sharma Hair Studio',
  shopCountryLabel: 'Country',
  selectCountryPlaceholder: 'Select a country…',
  loadingCountriesHint: 'Loading countries…',
  shopCityLabel: 'City',
  citySearchPlaceholder: 'Search for your city',
  citySearchTooShortHint: 'Keep typing to search…',
  citySearchNoResults: 'No cities found. Try a different spelling.',
  citySearchFailedHint: 'Could not search cities. Please try again.',
  changeCityAction: 'Change',
  shopLocalityLabel: 'Area / locality (optional)',
  shopLocalityOptionalHint: 'Helps customers in a big city find you faster.',
  noLocalityOption: 'No specific area',
  shopAddressLabel: 'Shop address',
  shopAddressPlaceholder: 'Shop no., building, street',
  shopPostalCodeOptionalSuffix: ' (optional)',
  shopPhoneLabel: 'Business phone (optional)',
  shopEmailLabel: 'Business email (optional)',
  useCurrentLocationAction: 'Use my current location',
  detectingLocationEllipsis: 'Detecting location…',
  locationDetectedLabel: 'Location detected',
  locationSkippedHint: "No problem — your address and city are enough to register.",
  chooseCountryFirstError: 'Please choose the country your shop is in.',
  chooseCityFirstError: "Please search for and select your shop's city.",
  registerShopAction: 'Register shop',
  registeringShopEllipsis: 'Registering…',
  couldNotRegisterShop: 'Could not register this shop. Please try again.',

  onboardingStepOf: (step: number, total: number) => `Step ${step} of ${total}`,
  onboardingWelcomeTitle: "You're in! Let's set up your shop.",
  onboardingWelcomeHint: 'A few quick steps and customers will be able to find and book you.',
  onboardingServicesStepTitle: 'Add your services',
  onboardingHoursStepTitle: 'Set your opening hours',
  onboardingPhotosStepTitle: 'Add photos',
  onboardingChairsStepTitle: 'Add your chairs',
  onboardingStaffStepTitle: 'Add your staff',
  onboardingPaymentQrStepTitle: 'Add a payment QR',
  onboardingPaymentQrStepHint: 'Shown to customers paying for an app or website booking. Walk-ins can still pay you directly without one.',
  onboardingGoLiveStepTitle: 'Go live',
  saveAndNextAction: 'Save & Next',
  previousAction: 'Previous',
  skipForNowAction: 'Skip for now',
  goLiveAction: 'Go live',
  goingLiveEllipsis: 'Going live…',
  setupIncompleteTitle: 'A few things are still missing before you can open your shop:',
  setupIncompleteMissingService: 'Add at least one service',
  setupIncompleteMissingChair: 'Add at least one chair',
  setupIncompleteMissingStaff: 'Add at least one staff member',
  couldNotGoLive: 'Could not open your shop. Please try again.',
  shopIsLiveTitle: "You're live!",
  shopIsLiveHint: 'Customers can now find and book your shop on FastQue.',
  continueToDashboardAction: 'Continue to dashboard',
  resumeSetupBanner: 'Pick up where you left off — finish setting up your shop.',

  noShopYetTitle: 'No shop yet',
  noShopYetHint: 'Ask your shop owner to add you as staff on the FastQue web dashboard.',
  todaysQueue: "Today's queue",

  findASalonTitle: 'Find a salon',
  salonTitle: 'Salon',
  chooseABarberTitle: 'Choose a barber',
  chooseADateTitle: 'Choose a date',
  chooseATimeTitle: 'Choose a time',
  confirmTitle: 'Confirm',
  queueTitle: 'Queue',
  bookingTitle: 'Booking',
  signInTitle: 'Sign in',
  passwordRecoveryTitle: 'Password recovery',
  homeButtonLabel: 'Home',

  accountDetailsCard: 'Account details',
  contactDetailsSubtitle: 'Contact details, security, and shortcuts.',
  couldNotLoadSessions: 'Could not load your sessions.',
  couldNotSignOutSession: 'Could not sign out that session.',
  couldNotSignOutOtherSessions: 'Could not sign out other sessions.',
  voiceHint: 'Also controls voice announcements read aloud on this device.',
  premiumActive: 'Active',
  premiumInactive: 'Not subscribed — manage on web',
  noActiveSessions: 'No active sessions were returned for this account.',
  signOutOtherSessions: 'Sign out of other sessions',
  roleCustomerLabel: 'Customer',
  roleStaffLabel: 'Salon Staff',
  roleOwnerLabel: 'Salon Owner',
  roleAdminLabel: 'Platform Admin',
  premiumLabel: 'Premium',

  anyStaffOption: 'Any Staff',
  staffSelectHint: 'This is a preference, not a guarantee — the salon assigns the actual barber and chair when you check in.',
  slotsClosedLabel: 'Closed',
  noSlotsTitle: 'No slots on this day',
  noSlotsHint: 'Try a different date.',
  availableLegend: '● Available',
  occupiedLegend: '● Occupied',
  availableWord: 'available',
  occupiedWord: 'occupied',
  timeAvailabilityLegend: 'Time availability legend',
  couldNotLoadTimes: 'Could not load available times.',
  couldNotLoadStaff: 'Could not load staff.',
  getDirections: 'Get Directions',
  shareAction: 'Share',
  shareOnWhatsApp: 'Share on WhatsApp',
  bookAgainAction: 'Book again',
  cancelBookingAction: 'Cancel booking',
  hideRescheduleAction: 'Hide reschedule',
  rescheduleAction: 'Reschedule',
  cancelBookingConfirmTitle: 'Cancel booking?',
  confirmCancellationAction: 'Confirm cancellation',
  checkInAction: 'Check in',
  statusLabelPrefix: 'Status: ',
  preferredBarberPrefix: 'Preferred barber: ',
  styleLabelPrefix: 'Style: ',
  prepaymentRequiredPrefix: 'Prepayment required: ',
  cancellationChargePrefix: 'Cancellation charge: ',
  bookingIdPrefix: 'Booking ID: ',
  couldNotLoadBooking: 'Could not load this booking.',
  couldNotShare: 'Could not open the share sheet.',
  couldNotLoadCancellationPolicy: 'Could not load the cancellation policy.',
  couldNotCancelBooking: 'Could not cancel this booking.',
  couldNotCheckIn: 'Could not check in. Please try again.',
  couldNotCreateBooking: 'Could not create the booking. Please try again.',
  bookingConfirmedTitle: 'Booking confirmed',
  confirmBookingTitle: 'Confirm booking',
  viewMyBookings: 'View my bookings',
  freeCancellationUpTo: 'Free cancellation up to ',
  beforeYourAppointment: ' before your appointment.',
  hoursSingular: 'hour',
  hoursPlural: 'hours',
  minutesSuffix: 'minutes',
  myBookingsTitle: 'My bookings',
  noBookingsYetTitle: 'No bookings yet',
  noBookingsYetHint: 'Find a salon and book your next visit.',
  viewDetailsAction: 'View details',
  couldNotLoadBookings: 'Could not load your bookings.',
  couldNotJoinQueue: 'Could not join the queue. Please try again.',
  alreadyInQueueTitle: 'Already in a queue',
  alreadyInQueueHint: 'You already have an active queue number at another salon. Finish or cancel it before joining here.',
  cancelLiveQueueAction: 'Cancel Live Queue',
  cancellingLiveQueueLabel: 'Cancelling…',
  cancelLiveQueueA11yLabel: 'Cancel Live Queue token',
  cancelLiveQueueConfirmTitle: 'Cancel Live Queue?',
  cancelLiveQueueConfirmMessage: 'You will lose your place in line. You can join again if you need to.',
  keepMyPlaceAction: 'Keep my place',
  confirmCancelLiveQueueAction: 'Cancel queue',
  couldNotCancelLiveQueue: 'Could not cancel your Live Queue token. Please try again.',
  cancelLiveQueueReassurance: 'You can cancel before your service starts.',
  youreInLineTitle: "You're in line",
  joinTheQueueTitle: 'Join the queue',
  serviceOptional: 'Service (optional)',
  anyServiceOption: 'Any service',
  queueStatusTitle: 'Queue status',
  noActiveQueueTitle: 'No active queue',
  noActiveQueueHint: 'Join a live queue at a nearby shop and follow your position here.',
  findASalonAction: 'Find a salon',
  couldNotLoadQueueStatus: 'Could not load your queue status.',
  tokenNumberLabel: 'Queue #',
  estimatedWaitLabel: 'Estimated wait: ',
  headOverNowMessage: "Please head over now — you're almost up.",
  withBarberPrefix: 'With ',
  turnAlmostHereToast: 'Your turn is almost here! Tap to dismiss.',
  waitChangedToast: 'Your wait time changed. Tap to dismiss.',
  findASalonSearchTitle: 'Find a salon',
  searchAction: 'Search',
  locatingAction: 'Locating…',
  nearMeFound: 'Near me ✓',
  couldNotSearchSalons: 'Could not search salons.',
  locationDenied: 'Location permission was denied. Try searching by name instead.',
  couldNotGetLocation: "Couldn't get your location. Try searching by name instead.",
  noSalonsFoundTitle: 'No salons found',
  noSalonsFoundHint: 'Try a different name, or clear the search to browse everything.',
  openNowLabel: 'Open now',
  closedNowLabel: 'Closed now',
  salonTypeFilterLabel: 'Salon type',
  salonTypeAll: 'All salons',
  salonTypeMale: 'Male',
  salonTypeFemale: 'Female',
  salonTypeUnisex: 'Unisex',
  salonTypeNotSet: 'Type not set',
  compareServiceLabel: 'Compare price',
  compareServiceNone: 'No service',
  sortLabel: 'Sort by',
  sortRecommended: 'Recommended',
  sortDistance: 'Distance',
  sortPrice: 'Price',
  sortRating: 'Reviews',
  sortPriceNeedsService: 'Pick a service under "Compare price" to sort by price.',
  ratingFilterLabel: 'Rating',
  ratingFilterAny: 'Any rating',
  favoritesOnlyLabel: '♥ Favorites',
  saveFavoriteAction: 'Save to favorites',
  removeFavoriteAction: 'Remove from favorites',
  favoritesSignInHint: 'Sign in as a customer to save and see favorite salons.',
  favoritesEmptyHint: 'No favorite salons yet. Tap the heart on a salon to save it.',
  favoriteUpdateFailed: 'Couldn’t update favorites. Please try again.',
  awaySuffix: ' away',
  distanceFilterLabel: 'Distance',
  distanceFilterLocationHint: 'Choose a radius to use your current location.',
  distanceFilterAny: 'Any distance',
  distanceFilter100m: '100 m',
  distanceFilter200m: '200 m',
  distanceFilter500m: '500 m',
  distanceFilter1km: '1 km',
  distanceFilter2km: '2 km',
  distanceFilter3km: '3 km',
  distanceFilter5km: '5 km',
  priceFilterLabel: 'Price',
  priceFilterAny: 'Any price',
  priceFilterOver1000: '₹1000+',
  priceFilterUpToPrefix: 'Up to ₹',
  priceFilterUpToSuffix: '',
  priceFilterFromPrefix: 'From ₹',
  priceFilterFromSuffix: '',
  priceFilterCustomLabel: 'Custom…',
  priceFilterMinLabel: 'Minimum price',
  priceFilterMaxLabel: 'Maximum price',
  priceFilterApplyAction: 'Apply',
  priceFilterClearAction: 'Clear',
  priceFilterErrorNegative: 'Price cannot be negative.',
  priceFilterErrorMinExceedsMax: 'Minimum price cannot exceed maximum price.',
  serviceFilterLabel: 'Service',
  serviceFilterAll: 'All services',
  serviceCategoryHair: 'Hair',
  serviceCategoryBarber: 'Barber',
  serviceCategoryBeard: 'Beard',
  serviceCategoryNails: 'Nails',
  serviceCategoryFacial: 'Facial',
  serviceCategoryMakeup: 'Makeup',
  serviceCategoryWaxingThreading: 'Waxing & Threading',
  serviceCategorySpaMassage: 'Spa & Massage',
  serviceCategoryBridalEvent: 'Bridal & Event',
  closeFilterMenu: 'Close menu',
  couldNotLoadSalon: 'Could not load this salon.',
  salonNotFound: 'Salon not found.',
  photoGalleryHint: 'Opens full-screen photo gallery',
  photosTapToView: 'photo(s) · tap to view',
  verifiedBadge: '✓ Verified',
  reviewsSuffix: 'review(s)',
  joinQueueNow: 'Join queue now',
  meetTheTeam: 'Meet the team',
  continueLabel: 'Continue',
  bookingForTheLookPrefix: 'Booking for the ',
  bookingForTheLookSuffix: ' look — pick a shop to continue.',
  searchByNamePlaceholder: 'Search services…',
  reviewsTitle: 'Reviews',

  continueWithGoogle: 'Continue with Google',
  couldNotSignInWithGoogle: 'Could not sign in with Google. Please try again.',
  signInUnavailableNotice: 'Sign-in is temporarily unavailable. Please try again shortly.',
  orDivider: 'or',
  invalidPhoneNumber: 'Invalid phone number.',
  couldNotSendOtp: 'Could not send OTP. Please try again.',
  newCodeSent: 'A new code has been sent.',
  couldNotResendCode: 'Could not resend the code. Please try again.',
  invalidCode: 'Invalid code.',
  couldNotVerifyOtp: 'Could not verify OTP. Please try again.',
  otpSubtitleGoogleOnly: 'Continue with Google. New here? This creates your account automatically.',
  otpSubtitleBoth: 'Continue with Google, or use a one-time code. New here? This creates your account automatically.',
  enterCodeSentToPrefix: 'Enter the code sent to ',
  phoneOtpUnavailableNotice: "Phone sign-in is temporarily unavailable. Please continue with Google above — it's the same account either way.",
  phoneNumberPlaceholder: '+919876543210',
  otpCodePlaceholder: '6-digit code',
  sendOtpAction: 'Send OTP',
  verifyAndContinueAction: 'Verify & Continue',
  resendOtpAction: 'Resend OTP',
  resendOtpInPrefix: 'Resend OTP in ',
  resendOtpInSuffix: 's',

  tryAgain: 'Try again',
  unreadSuffix: ' unread',
  closePhotoGallery: 'Close photo gallery',
  offlineMessage: "You're offline — showing the last data we had.",
  liveShopSnapshotLabel: 'Live shop snapshot',
  liveShopSnapshotEyebrow: 'LIVE SHOP SNAPSHOT',
  aChairWhenReady: "A chair when you're ready",
  activeChairsSuffix: 'active chair(s)',
  waitingCountSuffix: 'waiting',
  professionalAvailabilityHint: 'Professional availability will appear here during shop hours.',
  aggregateCountsNote: 'Aggregate counts only — no customer details are shown.',
  cancellingWillChargePrefix: 'Cancelling now will charge ',
  cancellingWillChargeSuffix: ' (outside the free cancellation window).',
  noChargeFreeWindow: "No charge — you're within the free cancellation window.",
  barberPrefix: 'Barber: ',
  minutesAbbrev: 'min',
  yearsExpAbbrev: 'yr(s) exp.',
  yearsExperienceWord: 'years experience',
  dayAbbreviations: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],

  couldNotSaveService: 'Could not save this service.',
  couldNotUpdateService: 'Could not update this service.',
  couldNotAddService: 'Could not add this service.',
  couldNotUpdateChair: 'Could not update this chair.',
  couldNotAddChair: 'Could not add this chair.',
  couldNotAddBarber: 'Could not add this staff member.',
  servicePlaceholder: 'Service name',
  pricePlaceholder: 'Price',
  minutesPlaceholder: 'Minutes',
  chairLabelPlaceholder: 'Chair label',
  barberNamePlaceholder: 'Staff name',
  staffPhoneOptionalPlaceholder: 'Mobile number (optional)',
  emailOptionalPlaceholder: 'Email (optional, for account invite)',
  inactiveSuffix: ' · Inactive',
  invitePendingSuffix: ' · Invite pending',
  addAction: 'Add',
  reactivateAction: 'Reactivate',
  invalidPhoneFormatHint: 'Use international format, e.g. +919876543210',
  openToggleLabel: 'Open',
  checkHoursPrefix: 'Check ',
  checkHoursSuffix: "'s hours — use a time like 09:00, with closing after opening.",
  saveHoursAction: 'Save hours',
  couldNotSaveHours: 'Could not save your hours.',
  ownerEyebrow: 'Owner',

  segmentNew: 'New',
  segmentRepeat: 'Repeat',
  segmentFrequent: 'Frequent',
  noContactOnFile: 'No contact on file',
  couldNotLoadCustomer: 'Could not load this customer.',
  couldNotLoadCustomers: 'Could not load customers.',
  customerNotFound: 'Customer not found.',
  customerSuffix: ' customer',
  outstandingBlockedPrefix: '',
  outstandingBlockedSuffix: ' outstanding — new bookings are blocked at this shop until this is settled or waived.',
  duesTitle: 'Dues',
  noDuesYet: 'No outstanding or waived dues.',
  noShowDueReason: 'No-show due',
  cancellationChargeReason: 'Cancellation charge',
  outstandingBadge: 'Outstanding',
  waivedBadge: 'Waived',
  noRelatedBooking: 'No related booking',
  recordedPrefix: 'Recorded ',
  waiveNoShowDueAction: 'Waive no-show due',
  restoreDueRowAction: 'Restore due',
  waiveConfirmPrefix: 'Waive ',
  waiveConfirmSuffix: ' no-show due for this customer?',
  restoreConfirmPrefix: 'Restore the ',
  restoreConfirmSuffix: ' no-show due? The customer will be blocked from new bookings again until it is settled or waived.',
  waiveDueAction: 'Waive due',
  restoreDueModalAction: 'Restore due',
  graceEligiblePrefix: 'New customer grace · ',
  graceEligibleMiddle: ' of ',
  graceEligibleSuffix: ' completed visits',
  graceCompletedPrefix: 'New customer grace completed · ',
  graceCompletedSuffix: '+ visits',
  customersTitle: 'Customers',
  customersSubtitle: 'Visit history and dues, from your own booking records.',
  noCustomersYetTitle: 'No customers yet',
  noCustomersYetHint: 'Everyone who books at your shop will show up here.',
  outstandingSuffix: ' outstanding',
  couldNotWaiveDue: 'Could not waive this due. Please try again.',
  couldNotRestoreDue: 'Could not restore this due. Please try again.',
  chooseShopQueueHint: 'Choose a shop from the Dashboard tab to see its live queue.',

  signInToYourShop: 'Sign in to your shop',
  signInToWorkToday: 'Sign in to work today',
  useYourDashboardAccount: 'Use your FastQue dashboard account.',
  onlyWorksIfRegisteredOwner: 'Only works if this Google account is already registered as a shop owner.',
  onlyWorksIfRegisteredStaff: 'Only works if this Google account is already registered as staff.',
  passwordLabel: 'Password',
  forgotPasswordQuestion: 'Forgot password?',
  enterValidEmailPassword: 'Enter a valid email and password.',
  couldNotSignIn: 'Could not sign in. Please try again.',
  enterValidEmail: 'Enter a valid email address.',
  recoveryUnavailableNotice: 'Password recovery is temporarily unavailable. Please try again shortly.',
  checkYourInboxTitle: 'Check your inbox',
  eligibleAccountPrefix: 'If an eligible ',
  eligibleAccountSuffix: " account uses that email, we'll send a secure password-reset link. The link expires soon and can be used once.",
  afterResetHint: 'After resetting your password, return here and sign in with your new password.',
  backToSignIn: 'Back to sign in',
  resetYourPasswordTitle: 'Reset your password',
  enterEmailForAccountPrefix: 'Enter the email for your ',
  enterEmailForAccountSuffix: ' account.',
  roleLabelOwner: 'shop owner',
  roleLabelStaff: 'barber / staff',
  sendResetLinkAction: 'Send reset link',
  emailAddressAccessibilityLabel: 'Email address',

  chairsFreeLabel: 'Chairs free',
  barbersFreeLabel: 'Barbers free',
  waitingLabel: 'Waiting',
  avgWaitLabel: 'Avg wait',
  couldNotCompleteAction: 'Could not complete that action.',
  callAction: 'Call',
  phoneCustomerAction: 'Phone customer',
  markArrivedAction: 'Mark arrived',
  arrivedStatus: 'Arrived in shop',
  notYetArrivedStatus: 'Not yet arrived',
  customerNameMissing: 'Name not provided',
  customerPhoneMissing: 'No phone number',
  keepEntryAction: 'Keep',
  confirmCancelEntryTitle: 'Cancel this queue entry?',
  confirmCancelEntryBody: 'The customer will be removed from the live queue.',
  confirmNoShowEntryTitle: 'Mark as no-show?',
  confirmNoShowEntryBody: 'Use this only if the customer was called and did not come.',
  confirmCompleteServiceTitle: 'Complete this service?',
  confirmCompleteServiceBody: 'This marks the visit as successfully served.',
  queueEntryChangedError: 'This queue entry has changed. The list was refreshed.',
  queueActionNotAllowedError: 'You do not have permission to do that.',
  queueNetworkError: 'Could not reach FastQue. Check your connection and try again.',
  contactNameLabel: 'Your name',
  contactPhoneLabel: 'Mobile number',
  contactPhoneHint: 'The shop uses this to reach you about your turn.',
  contactNameRequiredError: 'Please enter your name (at least 2 letters).',
  contactPhoneInvalidError: 'Enter a valid mobile number, with a country code if it is not Indian.',
  assignAction: 'Assign',
  noShowAction: 'No-show',
  barberLabel: 'Barber',
  chairLabel: 'Chair',
  confirmAssignmentAction: 'Confirm assignment',
  completeAction: 'Complete',
  couldNotLoadQueue: 'Could not load the queue.',
  queueIsEmptyTitle: 'Queue is empty',
  queueIsEmptyHint: 'Walk-ins and checked-in bookings will appear here in real time.',
  statusCalledShort: 'Called',

  photoLibraryAccessNeeded: 'Photo library access is needed to try the AI Style Advisor.',
  aiStylePreviewUnavailable: 'AI Style Preview is temporarily unavailable while we prepare the image-generation service. Your photo was not stored.',
  aiStyleAdvisorPremiumTitle: 'AI Style Advisor is a Premium feature',
  upgradeToPreviewHairstyles: 'Upgrade to Premium on the FastQue web app to preview hairstyles on your photo.',
  aiStyleAdvisorEyebrow: 'AI Style Advisor',
  outOfAiStyleCreditsTitle: "You're out of AI Style Credits",
  outOfAiStyleCreditsSubtitle: "You've used all your AI Style Credits for this subscription period.",
  yourLooksTitle: 'Your looks',
  aiStyleMatchDisclaimer: 'Each shows an AI Style Match — not a guarantee of how it will turn out on you.',
  aiStyleMatchPrefix: 'AI Style Match: ',
  aiStyleMatchSuffix: '%',
  tryThisLookAction: 'Try This Look',
  previewYourNextLookTitle: 'Preview your next look',
  uploadPhotoPreviewSubtitle: 'Upload a photo and preview a few hairstyles before you book.',
  choosePhotoAction: 'Choose a photo',
  chooseDifferentPhotoAction: 'Choose a different photo',
  aiCreditsRemainingPrefix: 'AI Credits remaining: ',
  analyzeMyPhotoAction: 'Analyze my photo',
  photoNotStoredNote: 'Your photo is used only to generate these previews and is not stored.',

  yourReviewTitle: 'Your review',
  shopsResponseLabel: "Shop's response: ",
  editReviewAction: 'Edit your review',
  editYourReviewTitle: 'Edit your review',
  leaveAReviewTitle: 'Leave a review',
  optionalCommentPlaceholder: 'Optional comment',
  savingEllipsis: 'Saving…',
  removingEllipsis: 'Removing…',
  saveReviewAction: 'Save review',
  submitReviewAction: 'Submit review',
  couldNotSaveReview: 'Could not save your review.',

  rescheduleBookingTitle: 'Reschedule booking',
  currentlyPrefix: 'Currently ',
  noSlotsOnThisDay: 'No slots on this day.',
  keepCurrentTimeAction: 'Keep current time',
  reschedulingEllipsis: 'Rescheduling…',
  confirmNewTimeAction: 'Confirm new time',
  couldNotRescheduleBooking: 'Could not reschedule this booking.',

  googleSignInUnavailable: 'Google sign-in is not available in this build.',
  googlePlayServicesUnavailable: 'Google Play Services is unavailable or out of date on this device.',
  couldNotOpenGooglePicker: 'Could not open the Google account picker.',
  googleNoTokenReturned: 'Google did not return a sign-in token. Please try again.',
  couldNotCompleteGoogleSignIn: 'Could not complete Google sign-in. Please try again.',

  networkOfflineMessage: 'You appear to be offline. Check your connection and try again.',
  couldNotLoadSalons: 'Could not load your salons.',
  couldNotOpenBookingFlow: 'Could not open the booking flow. Please try again.',
  couldNotStartNewBooking: 'Could not start a new booking. Please try again.',

  justNowLabel: 'just now',
  minutesAgoSuffix: 'm ago',
  hoursAgoSuffix: 'h ago',
  daysAgoSuffix: 'd ago',

  photoUnavailableLabel: 'photo unavailable',
  noPhotoYetLabel: 'no photo yet',

  photoLibraryAccessNeededForShopPhotos: 'Photo library access is needed to add shop photos.',
  photoOverSizeLimitPrefix: 'That photo is over the ',
  photoOverSizeLimitSuffix: ' MB limit.',
  noShopsYetTitle: 'No shops yet',
  bookingFiltersLabel: 'Booking filters',
  bookingFiltersHint: 'Swipe left or right to reach every booking filter',
  confirmedEyebrow: 'Confirmed',
  discoveryEyebrow: 'Discovery',

  shareBookingPrefix: 'Book at ',
  shareBookingMiddle: ' on FastQue: ',

  bookingRefPrefix: 'Ref ',

  atConnector: ' at ',

  shopLocalTimeSuffix: " (shop's local time)",

  appointmentTimePrefix: 'Appointment time: ',
  checkInBetweenPrefix: 'Check in between ',
  checkInByPrefix: 'Check in by ',

  fastQueCreditsLabel: 'FastQue Credits',
  walletBalanceLabel: 'Your FastQue Credits balance',
  redeemCreditsLabel: 'Redeem FastQue Credits',
  redeemCreditsHint: 'Use some of your balance to pay less for this booking.',
  creditsRedeemedLabel: 'Credits redeemed',
  payableAmountLabel: 'Amount to pay',
  fullPriceLabel: 'Full price',
  couldNotLoadCreditsBalance: 'Could not load your FastQue Credits balance.',
  noCreditsHistoryYet: 'No FastQue Credits activity yet.',
  creditsHistoryTitle: 'Credits history',
  promoGrantEntryLabel: 'Credit added',
  redeemedCreditsEntryLabel: 'Redeemed',
  restoredCreditsEntryLabel: 'Restored',
  manualAdjustmentEntryLabel: 'Adjustment',
  paymentQrRequiredMessage: "This shop hasn't set up online payment yet. Please try again later or visit in person.",
  paymentQrSectionTitle: 'Payment QR',
  paymentQrSectionHint: 'Customers scan this to pay online. Required before online booking can be enabled.',
  uploadPaymentQrAction: 'Upload QR code',
  linkPaymentQrAction: 'Link QR code image',
  removePaymentQrAction: 'Remove QR code',
  noPaymentQrConfiguredLabel: 'No payment QR configured yet',
  paymentQrConfiguredLabel: 'Payment QR configured',
  couldNotSavePaymentQr: 'Could not save the payment QR.',
  couldNotRemovePaymentQr: 'Could not remove the payment QR.',
};

const hiUi: UiStrings = {
  city: 'शहर',
  service: 'सेवा',
  search: 'खोजें',
  searchPlaceholder: 'दुकान या सेवा खोजें…',
  nearMe: 'मेरे पास',
  book: 'अपॉइंटमेंट बुक करें',
  joinQueue: 'लाइव कतार में शामिल हों',
  confirm: 'बुकिंग की पुष्टि करें',
  cancel: 'बुकिंग रद्द करें',
  keepBooking: 'बुकिंग रखें',
  waiting: 'प्रतीक्षा में',
  yourTurn: 'आपकी बारी आ गई है',
  called: 'आपको बुलाया जा रहा है',
  inService: 'सेवा जारी है',
  signIn: 'साइन इन करें',
  signInWithGoogle: 'Google से साइन इन करें',
  notifications: 'सूचनाएं',
  noNotifications: 'आप पूरी तरह अपडेट हैं',
  markAllRead: 'सभी को पढ़ा हुआ चिह्नित करें',
  retry: 'फिर कोशिश करें',
  open: 'अभी खुला है',
  closed: 'बंद है',
  noResults: 'कोई परिणाम नहीं मिला',
  loading: 'लोड हो रहा है…',
  outstandingDue: 'बकाया राशि',
  freeCancellation: 'मुफ़्त रद्दीकरण',
  statusConfirmed: 'पुष्टि हो गई',
  statusPendingPayment: 'भुगतान लंबित',
  statusCancelled: 'रद्द',
  statusCompleted: 'पूर्ण',
  statusNoShow: 'नो-शो',
  statusExpired: 'समाप्त',
  genericError: 'कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।',
  offline: 'लगता है आप ऑफ़लाइन हैं।',

  tabHome: 'होम',
  tabSearch: 'खोजें',
  tabBookings: 'बुकिंग्स',
  tabQueue: 'कतार',
  tabAccount: 'खाता',
  tabDashboard: 'डैशबोर्ड',
  tabShop: 'दुकान',
  tabToday: 'आज',

  yourAccount: 'आपका खाता',
  email: 'ईमेल',
  phone: 'फ़ोन',
  accountType: 'खाता प्रकार',
  signedInDevices: 'साइन-इन डिवाइस',
  thisDevice: 'यह डिवाइस',
  signOut: 'साइन आउट करें',
  signOutThisDevice: 'इस डिवाइस से लॉग आउट करें',
  language: 'भाषा',

  dashboardTitle: 'डैशबोर्ड',
  manageShop: 'दुकान प्रबंधित करें',
  servicesLabel: 'सेवाएं',
  chairsLabel: 'कुर्सियां',
  staffLabel: 'स्टाफ',
  hoursLabel: 'समय',
  photosLabel: 'फ़ोटो',
  customersLabel: 'ग्राहक',
  customerLabel: 'ग्राहक',
  addService: 'सेवा जोड़ें',
  addChair: 'कुर्सी जोड़ें',
  addBarber: 'स्टाफ जोड़ें',
  addPhoto: 'फ़ोटो जोड़ें',
  saveAction: 'सहेजें',
  editAction: 'संपादित करें',
  removeAction: 'हटाएं',
  cancelAction: 'रद्द करें',
  activateAction: 'सक्रिय करें',
  deactivateAction: 'निष्क्रिय करें',
  viewCustomers: 'ग्राहक देखें',
  todayTitle: 'आज',
  filterToday: 'आज',
  filterUpcoming: 'आगामी',
  filterCompleted: 'पूर्ण',
  filterCancelled: 'रद्द',
  filterNoShow: 'नो-शो',
  filterHistory: 'इतिहास',
  loadMore: 'और लोड करें',

  findAShop: 'दुकान खोजें',
  browseHint: 'बुक करें या लाइव कतार में शामिल हों — देखने के लिए साइन-इन ज़रूरी नहीं।',
  orContinueAs: 'या इस रूप में जारी रखें',
  alreadyKnowAccount: 'क्या आपके पास पहले से खाता है?',
  roleCustomer: 'ग्राहक',
  roleCustomerSubtitle: 'कुर्सी बुक करें या लाइव कतार में शामिल हों',
  roleOwner: 'दुकान मालिक',
  roleOwnerSubtitle: 'अपना सैलून, कतार और टीम चलाएं',
  roleStaff: 'बार्बर / स्टाफ',
  roleStaffSubtitle: 'आज की कतार और बुकिंग्स संभालें',

  welcomeBack: 'वापसी पर स्वागत है',
  welcomeSubtitle: 'पहले से बुक करें, या पास की लाइव कतार में शामिल हों।',
  liveQueueLabel: 'लाइव कतार',
  tokenNumberPrefix: 'कतार #',
  calledMessage: 'आपको बुलाया जा रहा है — कृपया काउंटर पर आएं!',
  positionPrefix: 'लाइन में स्थान ',
  positionSuffix: '',
  viewQueueStatus: 'कतार की स्थिति देखें',
  upcomingBookingLabel: 'आगामी बुकिंग',
  viewBookingAction: 'बुकिंग देखें',
  bookAheadKicker: 'पहले से बुक करें',
  reserveChair: 'कुर्सी आरक्षित करें',
  serviceBarberTime: 'सेवा → बार्बर → समय',
  joinLiveKicker: 'लाइव में शामिल हों',
  skipTheWait: 'प्रतीक्षा छोड़ें',
  findShopJoinQueue: 'दुकान खोजें, कतार में शामिल हों',
  myBookings: 'मेरी बुकिंग्स',
  aiStyleAdvisor: 'AI स्टाइल सलाहकार',
  accountAndPremium: 'खाता और प्रीमियम',

  homeHeroEyebrow: 'बेहतरीन लुक · कम इंतज़ार',
  homeHeroHeadlineLine1: 'आपकी स्टाइल.',
  homeHeroHeadlineLine2: 'आपका समय.',
  homeHeroSubcopy: 'बार्बर, सैलून और ग्रूमिंग सेवाएं खोजें। पहले से बुक करें या लाइव कतार में शामिल हों।',
  chooseLocationAction: 'स्थान चुनें',
  detectingLocationAction: 'पता लगाया जा रहा है…',
  searchModeBarber: 'बार्बर खोजें',
  searchModeSalon: 'सैलून व अन्य खोजें',
  shopOrServiceLabel: 'सेवा',
  shopOrServiceExample: 'हेयरकट, हेयर स्पा, बियर्ड ट्रिम, मसाज…',
  cityLocationLabel: 'शहर / स्थान',
  findABarberAction: 'बार्बर खोजें',
  findShopsAction: 'दुकानें खोजें',
  popularServicesTitle: 'लोकप्रिय सेवाएं',
  viewAllAction: 'सभी देखें',
  categoryHaircut: 'हेयरकट',
  categoryBeardTrim: 'बियर्ड ट्रिम',
  categoryFade: 'फेड',
  categoryShave: 'शेव',
  categoryNails: 'नेल्स',
  categorySpa: 'स्पा',
  queuePromoHeadlineLine1: 'इंतज़ार छोड़ें.',
  queuePromoHeadlineLine2: 'अपना समय बचाएं.',
  queuePromoSubcopy: 'रीयल-टाइम कतार, लाइव अपडेट्स।',
  trustShopsLabel: 'विश्वसनीय दुकानें',
  trustExperienceLabel: 'बेहतर अनुभव',
  trustRealTimeLabel: 'रीयल-टाइम अपडेट्स',
  trustOffersLabel: 'शानदार ऑफ़र',
  trustShopsCountSuffix: ' विश्वसनीय दुकानें',
  fastQueCreditsShortcut: 'FastQue क्रेडिट्स',
  startingPricePrefix: 'शुरुआत ',

  notSet: 'सेट नहीं है',
  unknownDevice: 'अज्ञात डिवाइस',
  signedInOnPrefix: 'साइन-इन किया ',
  signingOut: 'साइन आउट हो रहा है…',

  statusPrefix: 'स्थिति: ',
  activeService: 'सक्रिय सेवा',
  activeChair: 'सक्रिय कुर्सी',
  activeBarber: 'सक्रिय बार्बर',
  closeShop: 'दुकान बंद करें',
  openShop: 'दुकान खोलें',
  todaysBookings: 'आज की बुकिंग्स',
  completedTodayLabel: 'आज पूर्ण हुईं',
  cancelledNoShowToday: 'आज रद्द / नो-शो',
  liveQueue: 'लाइव कतार',
  registerShopHint: 'इसे प्रबंधित करने के लिए FastQue वेब डैशबोर्ड पर अपनी दुकान पंजीकृत करें।',

  bookingsTitle: 'बुकिंग्स',
  newBookingReceivedBanner: 'नई बुकिंग प्राप्त हुई',
  bookingCancelledBanner: 'बुकिंग रद्द हुई',
  hindiVoiceUnavailableWarning:
    'इस डिवाइस पर हिंदी आवाज़ इंस्टॉल नहीं है, इसलिए आवाज़ में सूचनाएं नहीं सुनाई देंगी। अपने फ़ोन की सेटिंग्स में हिंदी टेक्स्ट-टू-स्पीच आवाज़ इंस्टॉल करें, फिर दोबारा आज़माने के लिए FastQue को फिर से खोलें।',
  noShopSelected: 'कोई दुकान चयनित नहीं',
  selectShopHint: 'इसकी बुकिंग्स देखने के लिए डैशबोर्ड टैब से एक दुकान चुनें।',
  noBookingsTitle: 'कोई बुकिंग नहीं',
  noBookingsHint: 'इस दृश्य में अभी कुछ नहीं है।',
  newBadge: 'नई',
  preferredPrefix: 'पसंदीदा: ',

  selectShopTitle: 'एक दुकान चुनें',
  chooseShopHint: 'पहले डैशबोर्ड टैब से एक दुकान चुनें।',
  shopSubtitle: 'सेवाएं, कुर्सियां, स्टाफ और समय',
  noServicesYet: 'अभी कोई सेवा नहीं है।',
  browseServiceSuggestions: 'सेवा पैक चुनें',
  hideServiceSuggestions: 'सेवा पैक छिपाएं',
  noChairsYet: 'अभी कोई कुर्सी नहीं है।',
  noBarbersYet: 'अभी कोई स्टाफ नहीं जोड़ा गया।',
  customersHint: 'आपकी दुकान पर बुकिंग करने वाले हर ग्राहक का विज़िट इतिहास, बकाया और नो-शो छूट।',
  coverPhotoHint: 'आपकी कवर फ़ोटो वह है जिसे ग्राहक आपको खोजते समय सबसे पहले देखते हैं।',
  noPhotosYet: 'अभी कोई फ़ोटो नहीं है।',
  replaceCoverPhoto: 'कवर फ़ोटो बदलें',
  addCoverPhoto: 'कवर फ़ोटो जोड़ें',
  addGalleryPhoto: 'गैलरी फ़ोटो जोड़ें',

  registerShopCta: 'अपनी दुकान रजिस्टर करें',
  listYourShopCta: 'FastQue पर अपनी दुकान सूचीबद्ध करें',
  newToFastQueRegisterShop: 'FastQue पर नए हैं? अपनी दुकान रजिस्टर करें',
  noShopYetRouteToRegistration: 'अभी आपकी कोई दुकान नहीं है। शुरू करने के लिए एक रजिस्टर करें।',

  registerShopTitle: 'अपनी दुकान रजिस्टर करें',
  registerShopSubtitle: 'हमें अपनी दुकान के बारे में बताएं। इसके बाद आप सेवाएं, समय, फ़ोटो और स्टाफ जोड़ सकते हैं।',
  shopNameLabel: 'दुकान का नाम',
  shopNamePlaceholder: 'जैसे शर्मा हेयर स्टूडियो',
  shopCountryLabel: 'देश',
  selectCountryPlaceholder: 'एक देश चुनें…',
  loadingCountriesHint: 'देश लोड हो रहे हैं…',
  shopCityLabel: 'शहर',
  citySearchPlaceholder: 'अपना शहर खोजें',
  citySearchTooShortHint: 'खोजने के लिए टाइप करते रहें…',
  citySearchNoResults: 'कोई शहर नहीं मिला। कोई अलग वर्तनी आज़माएं।',
  citySearchFailedHint: 'शहर खोजे नहीं जा सके। कृपया फिर से प्रयास करें।',
  changeCityAction: 'बदलें',
  shopLocalityLabel: 'क्षेत्र / इलाका (वैकल्पिक)',
  shopLocalityOptionalHint: 'इससे बड़े शहर में ग्राहकों को आपको जल्दी खोजने में मदद मिलती है।',
  noLocalityOption: 'कोई विशेष इलाका नहीं',
  shopAddressLabel: 'दुकान का पता',
  shopAddressPlaceholder: 'दुकान नंबर, इमारत, सड़क',
  shopPostalCodeOptionalSuffix: ' (वैकल्पिक)',
  shopPhoneLabel: 'व्यवसाय फ़ोन (वैकल्पिक)',
  shopEmailLabel: 'व्यवसाय ईमेल (वैकल्पिक)',
  useCurrentLocationAction: 'मेरा वर्तमान स्थान उपयोग करें',
  detectingLocationEllipsis: 'स्थान का पता लगाया जा रहा है…',
  locationDetectedLabel: 'स्थान मिल गया',
  locationSkippedHint: 'कोई बात नहीं — रजिस्टर करने के लिए आपका पता और शहर काफी है।',
  chooseCountryFirstError: 'कृपया वह देश चुनें जहाँ आपकी दुकान है।',
  chooseCityFirstError: 'कृपया अपनी दुकान का शहर खोजें और चुनें।',
  registerShopAction: 'दुकान रजिस्टर करें',
  registeringShopEllipsis: 'रजिस्टर किया जा रहा है…',
  couldNotRegisterShop: 'यह दुकान रजिस्टर नहीं हो सकी। कृपया फिर से प्रयास करें।',

  onboardingStepOf: (step: number, total: number) => `चरण ${step} / ${total}`,
  onboardingWelcomeTitle: 'आप शामिल हो गए! चलिए आपकी दुकान सेट करते हैं।',
  onboardingWelcomeHint: 'कुछ आसान चरणों के बाद ग्राहक आपको खोज और बुक कर सकेंगे।',
  onboardingServicesStepTitle: 'अपनी सेवाएं जोड़ें',
  onboardingHoursStepTitle: 'अपने खुलने का समय सेट करें',
  onboardingPhotosStepTitle: 'फ़ोटो जोड़ें',
  onboardingChairsStepTitle: 'अपनी कुर्सियां जोड़ें',
  onboardingStaffStepTitle: 'अपना स्टाफ जोड़ें',
  onboardingPaymentQrStepTitle: 'भुगतान QR जोड़ें',
  onboardingPaymentQrStepHint: 'ऐप या वेबसाइट बुकिंग के लिए भुगतान करने वाले ग्राहकों को दिखाया जाता है। वॉक-इन ग्राहक इसके बिना भी सीधे आपको भुगतान कर सकते हैं।',
  onboardingGoLiveStepTitle: 'लाइव जाएं',
  saveAndNextAction: 'सेव करें और आगे बढ़ें',
  previousAction: 'पिछला',
  skipForNowAction: 'अभी के लिए छोड़ें',
  goLiveAction: 'लाइव जाएं',
  goingLiveEllipsis: 'लाइव किया जा रहा है…',
  setupIncompleteTitle: 'अपनी दुकान खोलने से पहले कुछ चीज़ें अभी बाकी हैं:',
  setupIncompleteMissingService: 'कम से कम एक सेवा जोड़ें',
  setupIncompleteMissingChair: 'कम से कम एक कुर्सी जोड़ें',
  setupIncompleteMissingStaff: 'कम से कम एक स्टाफ सदस्य जोड़ें',
  couldNotGoLive: 'आपकी दुकान लाइव नहीं हो सकी। कृपया फिर से प्रयास करें।',
  shopIsLiveTitle: 'आप लाइव हैं!',
  shopIsLiveHint: 'ग्राहक अब FastQue पर आपकी दुकान खोज और बुक कर सकते हैं।',
  continueToDashboardAction: 'डैशबोर्ड पर जारी रखें',
  resumeSetupBanner: 'जहां आपने छोड़ा था वहीं से जारी रखें — अपनी दुकान सेटअप पूरा करें।',

  noShopYetTitle: 'अभी कोई दुकान नहीं',
  noShopYetHint: 'अपने दुकान मालिक से FastQue वेब डैशबोर्ड पर आपको स्टाफ के रूप में जोड़ने के लिए कहें।',
  todaysQueue: 'आज की कतार',

  findASalonTitle: 'सैलून खोजें',
  salonTitle: 'सैलून',
  chooseABarberTitle: 'बार्बर चुनें',
  chooseADateTitle: 'तारीख चुनें',
  chooseATimeTitle: 'समय चुनें',
  confirmTitle: 'पुष्टि करें',
  queueTitle: 'कतार',
  bookingTitle: 'बुकिंग',
  signInTitle: 'साइन इन करें',
  passwordRecoveryTitle: 'पासवर्ड पुनर्प्राप्ति',
  homeButtonLabel: 'होम',

  accountDetailsCard: 'खाता विवरण',
  contactDetailsSubtitle: 'संपर्क विवरण, सुरक्षा और शॉर्टकट।',
  couldNotLoadSessions: 'आपके सत्र लोड नहीं हो सके।',
  couldNotSignOutSession: 'उस सत्र से साइन आउट नहीं हो सका।',
  couldNotSignOutOtherSessions: 'अन्य सत्रों से साइन आउट नहीं हो सका।',
  voiceHint: 'यह डिवाइस पर बोली जाने वाली आवाज़ सूचनाओं को भी नियंत्रित करता है।',
  premiumActive: 'सक्रिय',
  premiumInactive: 'सदस्यता नहीं है — वेब पर प्रबंधित करें',
  noActiveSessions: 'इस खाते के लिए कोई सक्रिय सत्र नहीं मिला।',
  signOutOtherSessions: 'अन्य सत्रों से साइन आउट करें',
  roleCustomerLabel: 'ग्राहक',
  roleStaffLabel: 'सैलून स्टाफ',
  roleOwnerLabel: 'सैलून मालिक',
  roleAdminLabel: 'प्लेटफ़ॉर्म एडमिन',
  premiumLabel: 'प्रीमियम',

  anyStaffOption: 'कोई भी स्टाफ',
  staffSelectHint: 'यह एक पसंद है, गारंटी नहीं — चेक-इन के समय सैलून ही असली बार्बर और कुर्सी तय करता है।',
  slotsClosedLabel: 'बंद है',
  noSlotsTitle: 'इस दिन कोई स्लॉट नहीं',
  noSlotsHint: 'कोई और तारीख आज़माएं।',
  availableLegend: '● उपलब्ध',
  occupiedLegend: '● व्यस्त',
  availableWord: 'उपलब्ध',
  occupiedWord: 'व्यस्त',
  timeAvailabilityLegend: 'समय उपलब्धता सूचक',
  couldNotLoadTimes: 'उपलब्ध समय लोड नहीं हो सके।',
  couldNotLoadStaff: 'स्टाफ लोड नहीं हो सका।',
  getDirections: 'दिशा-निर्देश पाएं',
  shareAction: 'शेयर करें',
  shareOnWhatsApp: 'WhatsApp पर शेयर करें',
  bookAgainAction: 'फिर से बुक करें',
  cancelBookingAction: 'बुकिंग रद्द करें',
  hideRescheduleAction: 'पुनर्निर्धारण छुपाएं',
  rescheduleAction: 'पुनर्निर्धारित करें',
  cancelBookingConfirmTitle: 'बुकिंग रद्द करें?',
  confirmCancellationAction: 'रद्दीकरण की पुष्टि करें',
  checkInAction: 'चेक इन करें',
  statusLabelPrefix: 'स्थिति: ',
  preferredBarberPrefix: 'पसंदीदा बार्बर: ',
  styleLabelPrefix: 'स्टाइल: ',
  prepaymentRequiredPrefix: 'अग्रिम भुगतान आवश्यक: ',
  cancellationChargePrefix: 'रद्दीकरण शुल्क: ',
  bookingIdPrefix: 'बुकिंग आईडी: ',
  couldNotLoadBooking: 'यह बुकिंग लोड नहीं हो सकी।',
  couldNotShare: 'शेयर शीट नहीं खुल सकी।',
  couldNotLoadCancellationPolicy: 'रद्दीकरण नीति लोड नहीं हो सकी।',
  couldNotCancelBooking: 'यह बुकिंग रद्द नहीं हो सकी।',
  couldNotCheckIn: 'चेक इन नहीं हो सका। कृपया फिर कोशिश करें।',
  couldNotCreateBooking: 'बुकिंग नहीं बन सकी। कृपया फिर कोशिश करें।',
  bookingConfirmedTitle: 'बुकिंग की पुष्टि हो गई',
  confirmBookingTitle: 'बुकिंग की पुष्टि करें',
  viewMyBookings: 'मेरी बुकिंग्स देखें',
  freeCancellationUpTo: 'मुफ़्त रद्दीकरण अपॉइंटमेंट से ',
  beforeYourAppointment: ' पहले तक।',
  hoursSingular: 'घंटा',
  hoursPlural: 'घंटे',
  minutesSuffix: 'मिनट',
  myBookingsTitle: 'मेरी बुकिंग्स',
  noBookingsYetTitle: 'अभी कोई बुकिंग नहीं',
  noBookingsYetHint: 'सैलून खोजें और अपनी अगली विज़िट बुक करें।',
  viewDetailsAction: 'विवरण देखें',
  couldNotLoadBookings: 'आपकी बुकिंग्स लोड नहीं हो सकीं।',
  couldNotJoinQueue: 'कतार में शामिल नहीं हो सके। कृपया फिर कोशिश करें।',
  alreadyInQueueTitle: 'पहले से कतार में',
  alreadyInQueueHint: 'आपके पास पहले से किसी और सैलून में सक्रिय कतार नंबर है। यहां शामिल होने से पहले उसे पूरा करें या रद्द करें।',
  cancelLiveQueueAction: 'लाइव कतार रद्द करें',
  cancellingLiveQueueLabel: 'रद्द किया जा रहा है…',
  cancelLiveQueueA11yLabel: 'लाइव कतार टोकन रद्द करें',
  cancelLiveQueueConfirmTitle: 'लाइव कतार रद्द करें?',
  cancelLiveQueueConfirmMessage: 'कतार में आपकी जगह चली जाएगी। ज़रूरत हो तो आप दोबारा शामिल हो सकते हैं।',
  keepMyPlaceAction: 'मेरी जगह रखें',
  confirmCancelLiveQueueAction: 'कतार रद्द करें',
  couldNotCancelLiveQueue: 'आपका लाइव कतार टोकन रद्द नहीं हो सका। कृपया फिर कोशिश करें।',
  cancelLiveQueueReassurance: 'सेवा शुरू होने से पहले आप रद्द कर सकते हैं।',
  youreInLineTitle: 'आप कतार में हैं',
  joinTheQueueTitle: 'कतार में शामिल हों',
  serviceOptional: 'सेवा (वैकल्पिक)',
  anyServiceOption: 'कोई भी सेवा',
  queueStatusTitle: 'कतार की स्थिति',
  noActiveQueueTitle: 'कोई सक्रिय कतार नहीं',
  noActiveQueueHint: 'पास की किसी दुकान की लाइव कतार में शामिल हों और यहां अपनी स्थिति देखें।',
  findASalonAction: 'सैलून खोजें',
  couldNotLoadQueueStatus: 'आपकी कतार स्थिति लोड नहीं हो सकी।',
  tokenNumberLabel: 'कतार #',
  estimatedWaitLabel: 'अनुमानित प्रतीक्षा: ',
  headOverNowMessage: 'कृपया अभी आएं — आपकी बारी लगभग आ गई है।',
  withBarberPrefix: 'साथ में ',
  turnAlmostHereToast: 'आपकी बारी लगभग आने वाली है! खारिज करने के लिए टैप करें।',
  waitChangedToast: 'आपका प्रतीक्षा समय बदल गया है। खारिज करने के लिए टैप करें।',
  findASalonSearchTitle: 'सैलून खोजें',
  searchAction: 'खोजें',
  locatingAction: 'स्थान ढूंढ रहे हैं…',
  nearMeFound: 'मेरे पास ✓',
  couldNotSearchSalons: 'सैलून खोजे नहीं जा सके।',
  locationDenied: 'लोकेशन अनुमति अस्वीकृत हुई। नाम से खोजने का प्रयास करें।',
  couldNotGetLocation: 'आपका स्थान नहीं मिल सका। नाम से खोजने का प्रयास करें।',
  noSalonsFoundTitle: 'कोई सैलून नहीं मिला',
  noSalonsFoundHint: 'कोई और नाम आज़माएं, या सब कुछ देखने के लिए खोज साफ़ करें।',
  openNowLabel: 'अभी खुला है',
  closedNowLabel: 'अभी बंद है',
  salonTypeFilterLabel: 'सैलून प्रकार',
  salonTypeAll: 'सभी सैलून',
  salonTypeMale: 'पुरुष',
  salonTypeFemale: 'महिला',
  salonTypeUnisex: 'यूनिसेक्स',
  salonTypeNotSet: 'प्रकार तय नहीं',
  compareServiceLabel: 'कीमत तुलना',
  compareServiceNone: 'कोई सेवा नहीं',
  sortLabel: 'क्रम',
  sortRecommended: 'सुझाए गए',
  sortDistance: 'दूरी',
  sortPrice: 'कीमत',
  sortRating: 'समीक्षाएं',
  sortPriceNeedsService: 'कीमत से क्रम के लिए पहले "कीमत तुलना" में सेवा चुनें।',
  ratingFilterLabel: 'रेटिंग',
  ratingFilterAny: 'कोई भी रेटिंग',
  favoritesOnlyLabel: '♥ पसंदीदा',
  saveFavoriteAction: 'पसंदीदा में जोड़ें',
  removeFavoriteAction: 'पसंदीदा से हटाएं',
  favoritesSignInHint: 'पसंदीदा सैलून सहेजने और देखने के लिए ग्राहक के रूप में साइन इन करें।',
  favoritesEmptyHint: 'अभी कोई पसंदीदा सैलून नहीं। सहेजने के लिए सैलून पर दिल टैप करें।',
  favoriteUpdateFailed: 'पसंदीदा अपडेट नहीं हो सका। कृपया फिर से कोशिश करें।',
  awaySuffix: ' दूर',
  distanceFilterLabel: 'दूरी',
  distanceFilterLocationHint: 'अपनी वर्तमान लोकेशन का उपयोग करने के लिए एक दूरी चुनें।',
  distanceFilterAny: 'कोई भी दूरी',
  distanceFilter100m: '100 मी',
  distanceFilter200m: '200 मी',
  distanceFilter500m: '500 मी',
  distanceFilter1km: '1 किमी',
  distanceFilter2km: '2 किमी',
  distanceFilter3km: '3 किमी',
  distanceFilter5km: '5 किमी',
  priceFilterLabel: 'कीमत',
  priceFilterAny: 'कोई भी कीमत',
  priceFilterOver1000: '₹1000+',
  priceFilterUpToPrefix: '₹',
  priceFilterUpToSuffix: ' तक',
  priceFilterFromPrefix: '₹',
  priceFilterFromSuffix: ' से अधिक',
  priceFilterCustomLabel: 'कस्टम…',
  priceFilterMinLabel: 'न्यूनतम कीमत',
  priceFilterMaxLabel: 'अधिकतम कीमत',
  priceFilterApplyAction: 'लागू करें',
  priceFilterClearAction: 'साफ़ करें',
  priceFilterErrorNegative: 'कीमत नकारात्मक नहीं हो सकती।',
  priceFilterErrorMinExceedsMax: 'न्यूनतम कीमत अधिकतम कीमत से अधिक नहीं हो सकती।',
  serviceFilterLabel: 'सेवा',
  serviceFilterAll: 'सभी सेवाएं',
  serviceCategoryHair: 'बाल',
  serviceCategoryBarber: 'बार्बर',
  serviceCategoryBeard: 'दाढ़ी',
  serviceCategoryNails: 'नाखून',
  serviceCategoryFacial: 'फेशियल',
  serviceCategoryMakeup: 'मेकअप',
  serviceCategoryWaxingThreading: 'वैक्सिंग और थ्रेडिंग',
  serviceCategorySpaMassage: 'स्पा और मालिश',
  serviceCategoryBridalEvent: 'दुल्हन और इवेंट',
  closeFilterMenu: 'मेनू बंद करें',
  couldNotLoadSalon: 'यह सैलून लोड नहीं हो सका।',
  salonNotFound: 'सैलून नहीं मिला।',
  photoGalleryHint: 'पूर्ण-स्क्रीन फ़ोटो गैलरी खोलता है',
  photosTapToView: 'फ़ोटो · देखने के लिए टैप करें',
  verifiedBadge: '✓ सत्यापित',
  reviewsSuffix: 'समीक्षा',
  joinQueueNow: 'अभी कतार में शामिल हों',
  meetTheTeam: 'टीम से मिलें',
  continueLabel: 'जारी रखें',
  bookingForTheLookPrefix: '',
  bookingForTheLookSuffix: ' लुक के लिए बुकिंग — जारी रखने के लिए दुकान चुनें।',
  searchByNamePlaceholder: 'सेवाएँ खोजें…',
  reviewsTitle: 'समीक्षाएं',

  continueWithGoogle: 'Google से जारी रखें',
  couldNotSignInWithGoogle: 'Google से साइन इन नहीं हो सका। कृपया फिर कोशिश करें।',
  signInUnavailableNotice: 'साइन-इन अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर कोशिश करें।',
  orDivider: 'या',
  invalidPhoneNumber: 'अमान्य फ़ोन नंबर।',
  couldNotSendOtp: 'OTP भेजा नहीं जा सका। कृपया फिर कोशिश करें।',
  newCodeSent: 'नया कोड भेज दिया गया है।',
  couldNotResendCode: 'कोड फिर से नहीं भेजा जा सका। कृपया फिर कोशिश करें।',
  invalidCode: 'अमान्य कोड।',
  couldNotVerifyOtp: 'OTP सत्यापित नहीं हो सका। कृपया फिर कोशिश करें।',
  otpSubtitleGoogleOnly: 'Google से जारी रखें। नए हैं? इससे आपका खाता अपने आप बन जाएगा।',
  otpSubtitleBoth: 'Google से जारी रखें, या वन-टाइम कोड का उपयोग करें। नए हैं? इससे आपका खाता अपने आप बन जाएगा।',
  enterCodeSentToPrefix: 'भेजा गया कोड डालें ',
  phoneOtpUnavailableNotice: 'फ़ोन साइन-इन अस्थायी रूप से उपलब्ध नहीं है। कृपया ऊपर Google से जारी रखें — यह वही खाता है।',
  phoneNumberPlaceholder: '+919876543210',
  otpCodePlaceholder: '6-अंकीय कोड',
  sendOtpAction: 'OTP भेजें',
  verifyAndContinueAction: 'सत्यापित करें और जारी रखें',
  resendOtpAction: 'OTP फिर भेजें',
  resendOtpInPrefix: 'OTP फिर भेजें ',
  resendOtpInSuffix: ' सेकंड में',

  tryAgain: 'फिर कोशिश करें',
  unreadSuffix: ' अपठित',
  closePhotoGallery: 'फ़ोटो गैलरी बंद करें',
  offlineMessage: 'आप ऑफ़लाइन हैं — पिछला डेटा दिखाया जा रहा है।',
  liveShopSnapshotLabel: 'लाइव दुकान स्नैपशॉट',
  liveShopSnapshotEyebrow: 'लाइव दुकान स्नैपशॉट',
  aChairWhenReady: 'जब आप तैयार हों तब कुर्सी',
  activeChairsSuffix: 'सक्रिय कुर्सियां',
  waitingCountSuffix: 'प्रतीक्षा में',
  professionalAvailabilityHint: 'दुकान के समय के दौरान पेशेवर उपलब्धता यहां दिखेगी।',
  aggregateCountsNote: 'केवल कुल संख्या — कोई ग्राहक विवरण नहीं दिखाया गया।',
  cancellingWillChargePrefix: 'अभी रद्द करने पर ',
  cancellingWillChargeSuffix: ' शुल्क लगेगा (मुफ़्त रद्दीकरण विंडो के बाहर)।',
  noChargeFreeWindow: 'कोई शुल्क नहीं — आप मुफ़्त रद्दीकरण विंडो में हैं।',
  barberPrefix: 'बार्बर: ',
  minutesAbbrev: 'मिनट',
  yearsExpAbbrev: 'वर्ष अनुभव',
  yearsExperienceWord: 'वर्ष अनुभव',
  dayAbbreviations: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'],

  couldNotSaveService: 'यह सेवा सहेजी नहीं जा सकी।',
  couldNotUpdateService: 'यह सेवा अपडेट नहीं हो सकी।',
  couldNotAddService: 'यह सेवा जोड़ी नहीं जा सकी।',
  couldNotUpdateChair: 'यह कुर्सी अपडेट नहीं हो सकी।',
  couldNotAddChair: 'यह कुर्सी जोड़ी नहीं जा सकी।',
  couldNotAddBarber: 'यह स्टाफ सदस्य जोड़ा नहीं जा सका।',
  servicePlaceholder: 'सेवा का नाम',
  pricePlaceholder: 'कीमत',
  minutesPlaceholder: 'मिनट',
  chairLabelPlaceholder: 'कुर्सी लेबल',
  barberNamePlaceholder: 'स्टाफ का नाम',
  staffPhoneOptionalPlaceholder: 'मोबाइल नंबर (वैकल्पिक)',
  emailOptionalPlaceholder: 'ईमेल (वैकल्पिक, खाता आमंत्रण हेतु)',
  inactiveSuffix: ' · निष्क्रिय',
  invitePendingSuffix: ' · आमंत्रण लंबित',
  addAction: 'जोड़ें',
  reactivateAction: 'फिर सक्रिय करें',
  invalidPhoneFormatHint: 'अंतरराष्ट्रीय प्रारूप का उपयोग करें, जैसे +919876543210',
  openToggleLabel: 'खुला',
  checkHoursPrefix: '',
  checkHoursSuffix: ' का समय जांचें — 09:00 जैसा समय उपयोग करें, बंद होने का समय खुलने के बाद होना चाहिए।',
  saveHoursAction: 'समय सहेजें',
  couldNotSaveHours: 'आपका समय सहेजा नहीं जा सका।',
  ownerEyebrow: 'मालिक',

  segmentNew: 'नया',
  segmentRepeat: 'दोहराया',
  segmentFrequent: 'बार-बार आने वाला',
  noContactOnFile: 'कोई संपर्क दर्ज नहीं',
  couldNotLoadCustomer: 'यह ग्राहक लोड नहीं हो सका।',
  couldNotLoadCustomers: 'ग्राहक लोड नहीं हो सके।',
  customerNotFound: 'ग्राहक नहीं मिला।',
  customerSuffix: ' ग्राहक',
  outstandingBlockedPrefix: '',
  outstandingBlockedSuffix: ' बकाया है — जब तक यह चुकाया या माफ़ नहीं किया जाता, इस दुकान पर नई बुकिंग रोकी गई है।',
  duesTitle: 'बकाया',
  noDuesYet: 'कोई बकाया या माफ़ की गई राशि नहीं है।',
  noShowDueReason: 'नो-शो बकाया',
  cancellationChargeReason: 'रद्दीकरण शुल्क',
  outstandingBadge: 'बकाया',
  waivedBadge: 'माफ़ किया गया',
  noRelatedBooking: 'कोई संबंधित बुकिंग नहीं',
  recordedPrefix: 'दर्ज किया गया ',
  waiveNoShowDueAction: 'नो-शो बकाया माफ़ करें',
  restoreDueRowAction: 'बकाया बहाल करें',
  waiveConfirmPrefix: '',
  waiveConfirmSuffix: ' का नो-शो बकाया इस ग्राहक के लिए माफ़ करें?',
  restoreConfirmPrefix: '',
  restoreConfirmSuffix: ' का नो-शो बकाया बहाल करें? जब तक यह चुकाया या माफ़ नहीं किया जाता, ग्राहक को फिर से नई बुकिंग से रोका जाएगा।',
  waiveDueAction: 'बकाया माफ़ करें',
  restoreDueModalAction: 'बकाया बहाल करें',
  graceEligiblePrefix: 'नया ग्राहक छूट · ',
  graceEligibleMiddle: ' में से ',
  graceEligibleSuffix: ' पूर्ण विज़िट',
  graceCompletedPrefix: 'नया ग्राहक छूट पूर्ण · ',
  graceCompletedSuffix: '+ विज़िट',
  customersTitle: 'ग्राहक',
  customersSubtitle: 'आपके अपने बुकिंग रिकॉर्ड से विज़िट इतिहास और बकाया।',
  noCustomersYetTitle: 'अभी कोई ग्राहक नहीं',
  noCustomersYetHint: 'आपकी दुकान पर बुकिंग करने वाला हर कोई यहां दिखेगा।',
  outstandingSuffix: ' बकाया',
  couldNotWaiveDue: 'यह बकाया माफ़ नहीं हो सका। कृपया फिर कोशिश करें।',
  couldNotRestoreDue: 'यह बकाया बहाल नहीं हो सका। कृपया फिर कोशिश करें।',
  chooseShopQueueHint: 'इसकी लाइव कतार देखने के लिए डैशबोर्ड टैब से एक दुकान चुनें।',

  signInToYourShop: 'अपनी दुकान में साइन इन करें',
  signInToWorkToday: 'आज काम करने के लिए साइन इन करें',
  useYourDashboardAccount: 'अपना FastQue डैशबोर्ड खाता उपयोग करें।',
  onlyWorksIfRegisteredOwner: 'यह तभी काम करता है जब यह Google खाता पहले से दुकान मालिक के रूप में पंजीकृत हो।',
  onlyWorksIfRegisteredStaff: 'यह तभी काम करता है जब यह Google खाता पहले से स्टाफ के रूप में पंजीकृत हो।',
  passwordLabel: 'पासवर्ड',
  forgotPasswordQuestion: 'पासवर्ड भूल गए?',
  enterValidEmailPassword: 'एक मान्य ईमेल और पासवर्ड दर्ज करें।',
  couldNotSignIn: 'साइन इन नहीं हो सका। कृपया फिर कोशिश करें।',
  enterValidEmail: 'एक मान्य ईमेल पता दर्ज करें।',
  recoveryUnavailableNotice: 'पासवर्ड पुनर्प्राप्ति अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर कोशिश करें।',
  checkYourInboxTitle: 'अपना इनबॉक्स जांचें',
  eligibleAccountPrefix: 'यदि किसी योग्य ',
  eligibleAccountSuffix: ' खाते में वह ईमेल है, तो हम एक सुरक्षित पासवर्ड-रीसेट लिंक भेजेंगे। लिंक जल्द ही समाप्त हो जाता है और केवल एक बार उपयोग किया जा सकता है।',
  afterResetHint: 'अपना पासवर्ड रीसेट करने के बाद, यहां लौटें और अपने नए पासवर्ड से साइन इन करें।',
  backToSignIn: 'साइन इन पर वापस जाएं',
  resetYourPasswordTitle: 'अपना पासवर्ड रीसेट करें',
  enterEmailForAccountPrefix: 'अपने ',
  enterEmailForAccountSuffix: ' खाते का ईमेल दर्ज करें।',
  roleLabelOwner: 'दुकान मालिक',
  roleLabelStaff: 'बार्बर / स्टाफ',
  sendResetLinkAction: 'रीसेट लिंक भेजें',
  emailAddressAccessibilityLabel: 'ईमेल पता',

  chairsFreeLabel: 'खाली कुर्सियां',
  barbersFreeLabel: 'खाली बार्बर',
  waitingLabel: 'प्रतीक्षा में',
  avgWaitLabel: 'औसत प्रतीक्षा',
  couldNotCompleteAction: 'वह कार्रवाई पूरी नहीं हो सकी।',
  callAction: 'बुलाएं',
  phoneCustomerAction: 'ग्राहक को फ़ोन करें',
  markArrivedAction: 'आगमन दर्ज करें',
  arrivedStatus: 'दुकान में पहुंच गए',
  notYetArrivedStatus: 'अभी पहुंचे नहीं',
  customerNameMissing: 'नाम नहीं दिया गया',
  customerPhoneMissing: 'फ़ोन नंबर नहीं है',
  keepEntryAction: 'रहने दें',
  confirmCancelEntryTitle: 'यह कतार प्रविष्टि रद्द करें?',
  confirmCancelEntryBody: 'ग्राहक को लाइव कतार से हटा दिया जाएगा।',
  confirmNoShowEntryTitle: 'नो-शो चिह्नित करें?',
  confirmNoShowEntryBody: 'इसे केवल तब उपयोग करें जब ग्राहक को बुलाया गया हो और वह न आया हो।',
  confirmCompleteServiceTitle: 'यह सेवा पूर्ण करें?',
  confirmCompleteServiceBody: 'इससे यह विज़िट सफलतापूर्वक पूरी चिह्नित हो जाएगी।',
  queueEntryChangedError: 'यह कतार प्रविष्टि बदल गई है। सूची ताज़ा कर दी गई है।',
  queueActionNotAllowedError: 'आपको यह करने की अनुमति नहीं है।',
  queueNetworkError: 'FastQue तक नहीं पहुंच सके। कनेक्शन जांचें और फिर कोशिश करें।',
  contactNameLabel: 'आपका नाम',
  contactPhoneLabel: 'मोबाइल नंबर',
  contactPhoneHint: 'दुकान आपकी बारी के बारे में इसी नंबर पर संपर्क करेगी।',
  contactNameRequiredError: 'कृपया अपना नाम दर्ज करें (कम से कम 2 अक्षर)।',
  contactPhoneInvalidError: 'सही मोबाइल नंबर दर्ज करें; भारतीय नंबर न हो तो देश कोड के साथ।',
  assignAction: 'नियुक्त करें',
  noShowAction: 'नो-शो',
  barberLabel: 'बार्बर',
  chairLabel: 'कुर्सी',
  confirmAssignmentAction: 'नियुक्ति की पुष्टि करें',
  completeAction: 'पूर्ण करें',
  couldNotLoadQueue: 'कतार लोड नहीं हो सकी।',
  queueIsEmptyTitle: 'कतार खाली है',
  queueIsEmptyHint: 'वॉक-इन और चेक-इन की गई बुकिंग्स यहां वास्तविक समय में दिखेंगी।',
  statusCalledShort: 'बुलाया गया',

  photoLibraryAccessNeeded: 'AI स्टाइल एडवाइज़र आज़माने के लिए फोटो लाइब्रेरी की अनुमति आवश्यक है।',
  aiStylePreviewUnavailable: 'इमेज-जनरेशन सेवा तैयार करते समय AI स्टाइल प्रीव्यू अस्थायी रूप से अनुपलब्ध है। आपकी फोटो सेव नहीं की गई।',
  aiStyleAdvisorPremiumTitle: 'AI स्टाइल एडवाइज़र एक प्रीमियम सुविधा है',
  upgradeToPreviewHairstyles: 'अपनी फोटो पर हेयरस्टाइल प्रीव्यू करने के लिए FastQue वेब ऐप पर प्रीमियम में अपग्रेड करें।',
  aiStyleAdvisorEyebrow: 'AI स्टाइल एडवाइज़र',
  outOfAiStyleCreditsTitle: 'आपके AI स्टाइल क्रेडिट समाप्त हो गए हैं',
  outOfAiStyleCreditsSubtitle: 'आपने इस सदस्यता अवधि के लिए अपने सभी AI स्टाइल क्रेडिट उपयोग कर लिए हैं।',
  yourLooksTitle: 'आपके लुक्स',
  aiStyleMatchDisclaimer: 'प्रत्येक एक AI स्टाइल मैच दिखाता है — यह गारंटी नहीं कि आप पर वैसा ही दिखेगा।',
  aiStyleMatchPrefix: 'AI स्टाइल मैच: ',
  aiStyleMatchSuffix: '%',
  tryThisLookAction: 'यह लुक आज़माएं',
  previewYourNextLookTitle: 'अपना अगला लुक प्रीव्यू करें',
  uploadPhotoPreviewSubtitle: 'बुक करने से पहले एक फोटो अपलोड करें और कुछ हेयरस्टाइल प्रीव्यू करें।',
  choosePhotoAction: 'फोटो चुनें',
  chooseDifferentPhotoAction: 'दूसरी फोटो चुनें',
  aiCreditsRemainingPrefix: 'शेष AI क्रेडिट: ',
  analyzeMyPhotoAction: 'मेरी फोटो विश्लेषण करें',
  photoNotStoredNote: 'आपकी फोटो केवल इन प्रीव्यू को बनाने के लिए उपयोग की जाती है और सेव नहीं की जाती।',

  yourReviewTitle: 'आपकी समीक्षा',
  shopsResponseLabel: 'दुकान की प्रतिक्रिया: ',
  editReviewAction: 'अपनी समीक्षा संपादित करें',
  editYourReviewTitle: 'अपनी समीक्षा संपादित करें',
  leaveAReviewTitle: 'समीक्षा दें',
  optionalCommentPlaceholder: 'वैकल्पिक टिप्पणी',
  savingEllipsis: 'सेव हो रहा है…',
  removingEllipsis: 'हटाया जा रहा है…',
  saveReviewAction: 'समीक्षा सेव करें',
  submitReviewAction: 'समीक्षा सबमिट करें',
  couldNotSaveReview: 'आपकी समीक्षा सेव नहीं हो सकी।',

  rescheduleBookingTitle: 'बुकिंग पुनर्निर्धारित करें',
  currentlyPrefix: 'अभी ',
  noSlotsOnThisDay: 'इस दिन कोई स्लॉट उपलब्ध नहीं है।',
  keepCurrentTimeAction: 'वर्तमान समय रखें',
  reschedulingEllipsis: 'पुनर्निर्धारित हो रहा है…',
  confirmNewTimeAction: 'नया समय पुष्ट करें',
  couldNotRescheduleBooking: 'यह बुकिंग पुनर्निर्धारित नहीं हो सकी।',

  googleSignInUnavailable: 'इस बिल्ड में Google साइन-इन उपलब्ध नहीं है।',
  googlePlayServicesUnavailable: 'इस डिवाइस पर Google Play सेवाएं अनुपलब्ध हैं या पुरानी हैं।',
  couldNotOpenGooglePicker: 'Google खाता चयनकर्ता नहीं खोला जा सका।',
  googleNoTokenReturned: 'Google ने साइन-इन टोकन नहीं भेजा। कृपया फिर कोशिश करें।',
  couldNotCompleteGoogleSignIn: 'Google साइन-इन पूरा नहीं हो सका। कृपया फिर कोशिश करें।',

  networkOfflineMessage: 'लगता है आप ऑफ़लाइन हैं। अपना कनेक्शन जांचें और फिर कोशिश करें।',
  couldNotLoadSalons: 'आपकी दुकानें लोड नहीं हो सकीं।',
  couldNotOpenBookingFlow: 'बुकिंग फ़्लो नहीं खोला जा सका। कृपया फिर कोशिश करें।',
  couldNotStartNewBooking: 'नई बुकिंग शुरू नहीं हो सकी। कृपया फिर कोशिश करें।',

  justNowLabel: 'अभी अभी',
  minutesAgoSuffix: 'मि पहले',
  hoursAgoSuffix: 'घं पहले',
  daysAgoSuffix: 'दि पहले',

  photoUnavailableLabel: 'फोटो उपलब्ध नहीं',
  noPhotoYetLabel: 'अभी तक कोई फोटो नहीं',

  photoLibraryAccessNeededForShopPhotos: 'दुकान की फोटो जोड़ने के लिए फोटो लाइब्रेरी की अनुमति आवश्यक है।',
  photoOverSizeLimitPrefix: 'यह फोटो ',
  photoOverSizeLimitSuffix: ' MB सीमा से बड़ी है।',
  noShopsYetTitle: 'अभी तक कोई दुकान नहीं',
  bookingFiltersLabel: 'बुकिंग फ़िल्टर',
  bookingFiltersHint: 'हर बुकिंग फ़िल्टर तक पहुंचने के लिए बाएं या दाएं स्वाइप करें',
  confirmedEyebrow: 'पुष्ट',
  discoveryEyebrow: 'खोज',

  shareBookingPrefix: 'यहां बुक करें ',
  shareBookingMiddle: ' FastQue पर: ',

  bookingRefPrefix: 'संदर्भ ',

  atConnector: ' में ',

  shopLocalTimeSuffix: ' (दुकान के स्थानीय समय पर)',

  appointmentTimePrefix: 'अपॉइंटमेंट का समय: ',
  checkInBetweenPrefix: 'चेक-इन विंडो: ',
  checkInByPrefix: 'इससे पहले चेक-इन करें: ',

  fastQueCreditsLabel: 'FastQue Credits',
  walletBalanceLabel: 'आपका FastQue Credits बैलेंस',
  redeemCreditsLabel: 'FastQue Credits का उपयोग करें',
  redeemCreditsHint: 'इस बुकिंग के लिए कम भुगतान करने हेतु अपने बैलेंस का कुछ हिस्सा उपयोग करें।',
  creditsRedeemedLabel: 'उपयोग किए गए क्रेडिट',
  payableAmountLabel: 'भुगतान करने की राशि',
  fullPriceLabel: 'पूरी कीमत',
  couldNotLoadCreditsBalance: 'आपका FastQue Credits बैलेंस लोड नहीं हो सका।',
  noCreditsHistoryYet: 'अभी तक कोई FastQue Credits गतिविधि नहीं है।',
  creditsHistoryTitle: 'क्रेडिट इतिहास',
  promoGrantEntryLabel: 'क्रेडिट जोड़ा गया',
  redeemedCreditsEntryLabel: 'उपयोग किया गया',
  restoredCreditsEntryLabel: 'वापस किया गया',
  manualAdjustmentEntryLabel: 'समायोजन',
  paymentQrRequiredMessage: 'इस दुकान ने अभी तक ऑनलाइन भुगतान सेट अप नहीं किया है। कृपया बाद में पुनः प्रयास करें या व्यक्तिगत रूप से जाएँ।',
  paymentQrSectionTitle: 'भुगतान QR',
  paymentQrSectionHint: 'ग्राहक ऑनलाइन भुगतान के लिए इसे स्कैन करते हैं। ऑनलाइन बुकिंग चालू करने से पहले यह आवश्यक है।',
  uploadPaymentQrAction: 'QR कोड अपलोड करें',
  linkPaymentQrAction: 'QR कोड इमेज लिंक करें',
  removePaymentQrAction: 'QR कोड हटाएं',
  noPaymentQrConfiguredLabel: 'अभी तक कोई भुगतान QR सेट नहीं किया गया',
  paymentQrConfiguredLabel: 'भुगतान QR सेट हो गया',
  couldNotSavePaymentQr: 'भुगतान QR सेव नहीं हो सका।',
  couldNotRemovePaymentQr: 'भुगतान QR हटाया नहीं जा सका।',
};

export const UI_STRINGS: Readonly<Record<Language, UiStrings>> = {
  [Language.EN]: enUi,
  [Language.HI]: hiUi,
};

/** Never throws on an unrecognised value — same "unknown/unset -> English" default as
 * voiceAnnouncementsFor, so a fresh/anonymous session always renders something correct. */
export function uiStringsFor(language: Language | null | undefined): UiStrings {
  return (language && UI_STRINGS[language]) || UI_STRINGS[Language.EN];
}

/**
 * In-app Notification Center list labels, keyed by the same NotificationType every backend
 * `notify()` call already produces (see notifications.service.ts's TYPE_CATEGORY — this is that
 * same exhaustiveness guarantee applied to display copy instead of category routing). Fixes a
 * real Build 9 physical-device defect: NotificationsScreen previously kept its own
 * English-only `TYPE_LABEL` map entirely outside the language system, so the screen heading could
 * read in Hindi while every notification title underneath it stayed English regardless of the
 * owner's selected language.
 */
export type NotificationTypeLabels = Readonly<Record<NotificationType, string>>;

const enNotificationTypeLabels: NotificationTypeLabels = {
  'booking.confirmed': 'Booking confirmed',
  'booking.cancelled': 'Booking cancelled',
  'booking.no_show': 'Marked as no-show',
  'booking.expired': 'Booking expired',
  'booking.reminder': 'Upcoming appointment',
  'booking.corrected': 'Booking corrected: marked completed',
  'queue.turn_approaching': 'Your turn is approaching',
  'queue.arrival_check': 'Live Queue arrival check',
  'owner.booking.created': 'New booking',
  'owner.booking.cancelled': 'Booking cancelled',
  'owner.booking.no_show': 'Customer no-show',
  'owner.booking.expired': 'Booking expired',
  'owner.walk_in.joined': 'New walk-in',
  'staff.assigned': 'You were assigned a customer',
  'owner.booking.arrival_check': 'Appointment arrival check',
  'booking.cancelled_by_shop': 'Appointment cancelled by the shop',
  'booking.rescheduled_by_shop': 'Appointment time changed by the shop',
  'owner.inventory.reorder': 'Time to reorder stock',
  'owner.inventory.expiring': 'Stock expiring soon',
};

const hiNotificationTypeLabels: NotificationTypeLabels = {
  'booking.confirmed': 'बुकिंग की पुष्टि हुई',
  'booking.cancelled': 'बुकिंग रद्द हुई',
  'booking.no_show': 'नो-शो के रूप में चिह्नित',
  'booking.expired': 'बुकिंग समाप्त हो गई',
  'booking.reminder': 'आगामी अपॉइंटमेंट',
  'booking.corrected': 'बुकिंग सुधारी गई: पूर्ण के रूप में चिह्नित',
  'queue.turn_approaching': 'आपकी बारी आने वाली है',
  'queue.arrival_check': 'लाइव क्यू में पहुंचने की पुष्टि',
  'owner.booking.created': 'नई बुकिंग',
  'owner.booking.cancelled': 'बुकिंग रद्द हुई',
  'owner.booking.no_show': 'ग्राहक नो-शो',
  'owner.booking.expired': 'बुकिंग समाप्त हो गई',
  'owner.walk_in.joined': 'नया वॉक-इन',
  'staff.assigned': 'आपको एक ग्राहक सौंपा गया',
  'owner.booking.arrival_check': 'अपॉइंटमेंट आगमन जांच',
  'booking.cancelled_by_shop': 'दुकान ने अपॉइंटमेंट रद्द की',
  'booking.rescheduled_by_shop': 'दुकान ने अपॉइंटमेंट का समय बदला',
  'owner.inventory.reorder': 'स्टॉक फिर से मंगाने का समय',
  'owner.inventory.expiring': 'स्टॉक जल्द एक्सपायर हो रहा है',
};

export const NOTIFICATION_TYPE_LABELS: Readonly<Record<Language, NotificationTypeLabels>> = {
  [Language.EN]: enNotificationTypeLabels,
  [Language.HI]: hiNotificationTypeLabels,
};

/** Never throws on an unrecognised type/language — falls back to English labels, then to the raw
 * type string itself, so a future NotificationType added to the enum without a translation entry
 * degrades to something readable rather than crashing the list. */
export function notificationTypeLabel(
  language: Language | null | undefined,
  type: NotificationType,
): string {
  const table = (language && NOTIFICATION_TYPE_LABELS[language]) || NOTIFICATION_TYPE_LABELS[Language.EN];
  return table[type] ?? enNotificationTypeLabels[type] ?? type;
}

/**
 * OS push notification title/body — generated server-side (bookings.service.ts), so unlike every
 * other string in this file it is never rendered through a client-side React tree. Split out from
 * VoiceAnnouncements/UiStrings because a push payload is title+body, not a single sentence, and
 * because the backend is the only caller. Fixes a real Build 9 physical-device defect: the push
 * title/body were previously hardcoded English literals at the dispatchToUser call site,
 * completely bypassing the recipient owner's preferredLanguage.
 */
export interface PushCopy {
  newBooking(serviceName: string | null): { title: string; body: string };
  bookingRescheduled(serviceName: string | null): { title: string; body: string };
  bookingCancelled(serviceName: string | null): { title: string; body: string };
  bookingReminder(serviceName: string | null): { title: string; body: string };
  /** P0 arrival-alert mission — the one-shot T-5-minute push. Never a customer name (see
   * ArrivalAlertDto's own comment on why one is never invented). */
  arrivalCheck(serviceName: string | null): { title: string; body: string };
  /** Owner-operations mission — CUSTOMER-facing push when the shop cancels their appointment.
   * `whenText` is the already-formatted, salon-local date/time (or null when it cannot be
   * resolved — the copy then simply omits it rather than guessing a timezone). */
  shopCancelledBooking(input: { shopName: string; serviceName: string | null; whenText: string | null }): {
    title: string;
    body: string;
  };
  /** Same, for a shop-initiated reschedule. */
  shopRescheduledBooking(input: { shopName: string; serviceName: string | null; whenText: string | null }): {
    title: string;
    body: string;
  };
}

const enPush: PushCopy = {
  newBooking: (serviceName) => ({
    title: 'New booking',
    body: serviceName ? `${serviceName} booked for your shop.` : 'A new booking was made for your shop.',
  }),
  bookingRescheduled: (serviceName) => ({
    title: 'Booking rescheduled',
    body: serviceName ? `${serviceName} booking was rescheduled.` : 'A booking at your shop was rescheduled.',
  }),
  bookingCancelled: (serviceName) => ({
    title: 'Booking cancelled',
    body: serviceName ? `${serviceName} booking was cancelled.` : 'A booking at your shop was cancelled.',
  }),
  bookingReminder: (serviceName) => ({
    title: 'Appointment reminder',
    body: serviceName ? `${serviceName} appointment starts in about 15 minutes.` : 'Your appointment starts in about 15 minutes.',
  }),
  arrivalCheck: (serviceName) => ({
    title: 'Appointment in 5 minutes',
    body: serviceName
      ? `Has the ${serviceName} customer arrived? Open FastQue to confirm.`
      : 'Has the customer arrived for their appointment? Open FastQue to confirm.',
  }),
  shopCancelledBooking: ({ shopName, serviceName, whenText }) => ({
    title: 'Appointment cancelled by the shop',
    body:
      `Your appointment at ${shopName}${serviceName ? ` for ${serviceName}` : ''}` +
      `${whenText ? ` on ${whenText}` : ''} has been cancelled by the shop. ` +
      'Please open FastQue to view your booking details or contact the shop for assistance.',
  }),
  shopRescheduledBooking: ({ shopName, serviceName, whenText }) => ({
    title: 'Appointment time changed by the shop',
    body:
      `Your appointment at ${shopName}${serviceName ? ` for ${serviceName}` : ''}` +
      `${whenText ? ` has been moved to ${whenText}` : ' has been moved'} by the shop. ` +
      'Open FastQue to review the new time or contact the shop if it does not work for you.',
  }),
};

const hiPush: PushCopy = {
  newBooking: (serviceName) => ({
    title: 'नई बुकिंग',
    body: serviceName ? `आपकी दुकान के लिए ${serviceName} बुक हुई।` : 'आपकी दुकान के लिए एक नई बुकिंग हुई।',
  }),
  bookingRescheduled: (serviceName) => ({
    title: 'बुकिंग पुनर्निर्धारित हुई',
    body: serviceName ? `${serviceName} बुकिंग का समय बदल दिया गया।` : 'आपकी दुकान की एक बुकिंग का समय बदल दिया गया।',
  }),
  bookingCancelled: (serviceName) => ({
    title: 'बुकिंग रद्द हुई',
    body: serviceName ? `${serviceName} बुकिंग रद्द कर दी गई।` : 'आपकी दुकान की एक बुकिंग रद्द कर दी गई।',
  }),
  bookingReminder: (serviceName) => ({
    title: 'अपॉइंटमेंट रिमाइंडर',
    body: serviceName ? `${serviceName} अपॉइंटमेंट लगभग 15 मिनट में शुरू होगी।` : 'आपकी अपॉइंटमेंट लगभग 15 मिनट में शुरू होगी।',
  }),
  arrivalCheck: (serviceName) => ({
    title: 'अपॉइंटमेंट 5 मिनट में',
    body: serviceName
      ? `क्या ${serviceName} ग्राहक पहुंच चुका है? पुष्टि के लिए FastQue खोलें।`
      : 'क्या ग्राहक अपने अपॉइंटमेंट के लिए पहुंच चुका है? पुष्टि के लिए FastQue खोलें।',
  }),
  shopCancelledBooking: ({ shopName, serviceName, whenText }) => ({
    title: 'दुकान ने अपॉइंटमेंट रद्द की',
    body:
      `${shopName} पर ${serviceName ? `${serviceName} की ` : ''}आपकी अपॉइंटमेंट` +
      `${whenText ? ` (${whenText})` : ''} दुकान द्वारा रद्द कर दी गई है। ` +
      'विवरण देखने या दुकान से संपर्क करने के लिए FastQue खोलें।',
  }),
  shopRescheduledBooking: ({ shopName, serviceName, whenText }) => ({
    title: 'दुकान ने अपॉइंटमेंट का समय बदला',
    body:
      `${shopName} पर ${serviceName ? `${serviceName} की ` : ''}आपकी अपॉइंटमेंट` +
      `${whenText ? ` अब ${whenText} पर` : ''} दुकान द्वारा स्थानांतरित कर दी गई है। ` +
      'नया समय देखने के लिए FastQue खोलें या असुविधा होने पर दुकान से संपर्क करें।',
  }),
};

export const PUSH_COPY: Readonly<Record<Language, PushCopy>> = {
  [Language.EN]: enPush,
  [Language.HI]: hiPush,
};

/** Same never-throws fallback-to-English convention as voiceAnnouncementsFor/uiStringsFor. */
export function pushCopyFor(language: Language | null | undefined): PushCopy {
  return (language && PUSH_COPY[language]) || PUSH_COPY[Language.EN];
}
