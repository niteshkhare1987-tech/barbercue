import {
  EMPLOYEE_PATHS,
  ADMIN_PATHS,
  onboardingMissingFields,
  type OnboardingApplicationDto,
  type OnboardingDraftInput,
  type OnboardingHoursDto,
  type OnboardingMissingItem,
  type OnboardingServiceDto,
  type OnboardingServiceRowInput,
} from "@barbercue/shared";

export const EMPLOYEE_ONBOARDING = `${EMPLOYEE_PATHS.employee}/${EMPLOYEE_PATHS.onboarding}`;
export const ADMIN_ONBOARDING = `${ADMIN_PATHS.admin}/${ADMIN_PATHS.onboarding}`;

export const ONBOARDING_STEPS = [
  "Salon identity",
  "Owner & contact",
  "Address",
  "Operations",
  "Service menu",
  "Photos",
  "Verification",
  "Review & submit",
] as const;

/** Display order Monday-first; values are 0 = Sunday … 6 = Saturday (OperatingHours convention). */
export const WEEK_DAYS: ReadonlyArray<{ day: number; label: string }> = [
  { day: 1, label: "Monday" },
  { day: 2, label: "Tuesday" },
  { day: 3, label: "Wednesday" },
  { day: 4, label: "Thursday" },
  { day: 5, label: "Friday" },
  { day: 6, label: "Saturday" },
  { day: 0, label: "Sunday" },
];

/** Every day starts unanswered-but-open with empty times: nothing is pre-filled for the employee. */
export function initialHours(existing: OnboardingHoursDto[]): OnboardingHoursDto[] {
  return WEEK_DAYS.map(({ day }) => {
    const found = existing.find((h) => h.dayOfWeek === day);
    return found ?? { dayOfWeek: day, isClosed: false, opensAt: null, closesAt: null, closesNextDay: false };
  });
}

/** Rows for the PATCH body: only days the employee actually filled or marked closed. */
export function hoursForSave(hours: OnboardingHoursDto[]): NonNullable<OnboardingDraftInput["hours"]> {
  return hours
    .filter((h) => h.isClosed || (h.opensAt && h.closesAt))
    .map((h) => ({
      dayOfWeek: h.dayOfWeek,
      isClosed: h.isClosed,
      opensAt: h.isClosed ? null : h.opensAt,
      closesAt: h.isClosed ? null : h.closesAt,
    }));
}

export type DraftForm = Record<string, string | number | boolean | null>;

/** Editable scalar fields, as the wizard holds them (blank strings mean "not entered"). */
export const DRAFT_FIELDS = [
  "salonName", "genderCategory", "salonKind", "description", "brandName", "websiteUrl", "instagramUrl",
  "mapsUrl", "isFranchise", "branchCount", "ownerName", "ownerPhone", "ownerWhatsapp", "ownerEmail",
  "alternatePhone", "managerName", "managerPhone", "preferredLanguage", "shopNumber", "buildingName",
  "streetAddress", "locality", "city", "district", "state", "postalCode", "country", "landmark",
  "employeeCount", "chairCount", "activeChairCount", "maleStaffCount", "femaleStaffCount",
  "walkInsAccepted", "bookingsAccepted", "liveQueueSupported", "appointmentIntervalMinutes",
  "averageServiceMinutes", "specialTimings", "consentContact", "consentListing", "consentAccuracy",
  "consentAuthorization", "gstin", "businessRegistration", "employeeNotes", "openQuestions",
] as const;

const NUMBER_FIELDS = new Set([
  "branchCount", "employeeCount", "chairCount", "activeChairCount", "maleStaffCount", "femaleStaffCount",
  "appointmentIntervalMinutes", "averageServiceMinutes",
]);
const ENUM_FIELDS = new Set(["genderCategory", "salonKind"]);
const TRISTATE_FIELDS = new Set(["isFranchise", "walkInsAccepted", "bookingsAccepted", "liveQueueSupported"]);

export function formFromApplication(app: OnboardingApplicationDto): DraftForm {
  const form: DraftForm = {};
  const source = app as unknown as Record<string, unknown>;
  for (const key of DRAFT_FIELDS) {
    const value = source[key];
    form[key] = value === null || value === undefined ? "" : (value as string | number | boolean);
  }
  // Display phones in the familiar 10-digit form; the server re-normalizes to +91.
  for (const key of ["ownerPhone", "ownerWhatsapp", "alternatePhone", "managerPhone"]) {
    if (typeof form[key] === "string") form[key] = (form[key] as string).replace(/^\+91/, "");
  }
  return form;
}

/** Converts the wizard's form into a PATCH body. Blank text -> null; never invents a value. */
export function draftPayload(form: DraftForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DRAFT_FIELDS) {
    const value = form[key];
    if (value === undefined) continue;
    if (NUMBER_FIELDS.has(key)) {
      out[key] = value === "" || value === null ? null : Number(value);
    } else if (ENUM_FIELDS.has(key)) {
      out[key] = value === "" ? null : value;
    } else if (TRISTATE_FIELDS.has(key)) {
      out[key] = value === "" || value === null ? null : value === true || value === "true";
    } else if (key.startsWith("consent")) {
      out[key] = value === true;
    } else if (key === "salonName") {
      if (typeof value === "string" && value.trim()) out[key] = value;
    } else {
      out[key] = value === null ? "" : String(value);
    }
  }
  return out;
}

export function addressPreview(form: DraftForm): string {
  const parts = ["shopNumber", "buildingName", "streetAddress", "landmark", "locality", "city", "district", "state"]
    .map((k) => (typeof form[k] === "string" ? (form[k] as string).trim() : ""))
    .filter(Boolean);
  const pin = typeof form.postalCode === "string" ? form.postalCode.trim() : "";
  const country = typeof form.country === "string" ? form.country.trim() : "";
  return [parts.join(", "), pin && `PIN ${pin}`, country].filter(Boolean).join(" · ");
}

export type ServiceRow = OnboardingServiceRowInput & { key: string };

let rowCounter = 0;
export function newServiceRow(partial: Partial<OnboardingServiceRowInput> = {}): ServiceRow {
  rowCounter += 1;
  return {
    key: `row-${Date.now()}-${rowCounter}`,
    serviceName: "",
    category: null,
    applicableGender: null,
    basePrice: null,
    priceType: "FIXED",
    discountedPrice: null,
    durationMinutes: null,
    description: null,
    isActive: true,
    sourceType: "MANUAL",
    confirmedByEmployee: false,
    uncertainFields: [],
    ...partial,
  };
}

export function rowsFromServices(services: OnboardingServiceDto[]): ServiceRow[] {
  return services.map((s) =>
    newServiceRow({
      serviceName: s.serviceName,
      category: s.category,
      applicableGender: s.applicableGender,
      basePrice: s.basePrice,
      priceType: s.priceType,
      discountedPrice: s.discountedPrice,
      durationMinutes: s.durationMinutes,
      description: s.description,
      isActive: s.isActive,
      sourceType: s.sourceType,
      sourceMediaId: s.sourceMediaId,
      sourcePage: s.sourcePage,
      extractionConfidence: s.extractionConfidence,
      uncertainFields: s.uncertainFields,
      confirmedByEmployee: s.confirmedByEmployee,
    }),
  );
}

/** PUT body: drops blank rows the employee never filled in. */
export function servicesPayload(rows: ServiceRow[]): OnboardingServiceRowInput[] {
  return rows
    .filter((r) => r.serviceName.trim())
    .map((r) => {
      const row: OnboardingServiceRowInput & { key?: string } = { ...r };
      delete row.key;
      return row;
    })
    .map((row) => ({
      ...row,
      serviceName: row.serviceName.trim(),
      basePrice: row.basePrice === null || row.basePrice === undefined || Number.isNaN(row.basePrice) ? null : row.basePrice,
      durationMinutes: row.durationMinutes ? row.durationMinutes : null,
    }));
}

/** The wizard's live view of what is still missing, using the same rules the server enforces. */
export function liveMissing(
  form: DraftForm,
  hours: OnboardingHoursDto[],
  rows: ServiceRow[],
  media: Array<{ category: string }>,
  photoExceptionReason: string | null,
): OnboardingMissingItem[] {
  const draft = draftPayload(form) as Record<string, never>;
  return onboardingMissingFields({
    ...draft,
    ownerPhone: typeof form.ownerPhone === "string" ? form.ownerPhone : null,
    photoExceptionReason,
    hours: hoursForSave(hours),
    services: servicesPayload(rows).map((s) => ({
      serviceName: s.serviceName,
      isActive: s.isActive ?? true,
      basePrice: s.basePrice ?? null,
      durationMinutes: s.durationMinutes ?? null,
      confirmedByEmployee: s.confirmedByEmployee ?? false,
    })),
    media,
  });
}

export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `₹${value.toLocaleString("en-IN")}`;
}

/** Local backup of unsaved edits, per application. Storage can be unavailable; never throws. */
export function backupDraft(id: string, data: unknown): void {
  try {
    localStorage.setItem(`fq-onboarding-draft-${id}`, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* private mode or blocked storage */
  }
}
export function clearDraftBackup(id: string): void {
  try {
    localStorage.removeItem(`fq-onboarding-draft-${id}`);
  } catch {
    /* ignore */
  }
}
