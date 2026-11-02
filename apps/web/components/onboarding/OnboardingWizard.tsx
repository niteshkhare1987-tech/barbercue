"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  EMPLOYEE_PATHS,
  ONBOARDING_FIELD_LABELS,
  ONBOARDING_MEDIA_LIMITS,
  ONBOARDING_SHOP_PHOTO_CATEGORIES,
  ONBOARDING_STATUS_LABELS,
  type MenuExtractionResultDto,
  type OnboardingApplicationDto,
  type OnboardingHoursDto,
  type OnboardingMediaCategory,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../lib/api";
import {
  EMPLOYEE_ONBOARDING,
  ONBOARDING_STEPS,
  WEEK_DAYS,
  addressPreview,
  backupDraft,
  clearDraftBackup,
  draftPayload,
  formFromApplication,
  formatInr,
  hoursForSave,
  initialHours,
  liveMissing,
  newServiceRow,
  rowsFromServices,
  servicesPayload,
  type DraftForm,
  type ServiceRow,
} from "../../lib/onboarding";
import { PrivateImage } from "./PrivateImage";
import base from "../../app/employee/employee.module.css";
import styles from "../../app/employee/onboarding/onboarding.module.css";

const PHOTO_GROUPS: Array<{ category: OnboardingMediaCategory; label: string }> = [
  { category: "EXTERIOR", label: "Exterior / shop front" },
  { category: "INTERIOR", label: "Interior" },
  { category: "STATIONS", label: "Working chairs / stations" },
  { category: "RECEPTION", label: "Reception" },
  { category: "LOGO", label: "Logo" },
  { category: "OTHER", label: "Other useful photos" },
];

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

interface Props {
  applicationId: string;
}

/**
 * The 8-step field onboarding form. Everything an employee types is kept in memory across steps,
 * backed up locally, and saved to the server on "Save draft" and on every step change. The
 * server repeats every validation; this component only makes problems visible early.
 */
export function OnboardingWizard({ applicationId }: Props) {
  const [app, setApp] = useState<OnboardingApplicationDto | null>(null);
  const [form, setForm] = useState<DraftForm>({});
  const [hours, setHours] = useState<OnboardingHoursDto[]>(initialHours([]));
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [servicesDirty, setServicesDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const loaded = useRef(false);

  const accept = useCallback((next: OnboardingApplicationDto, resetLocal: boolean) => {
    setApp(next);
    if (resetLocal) {
      setForm(formFromApplication(next));
      setHours(initialHours(next.hours));
      setRows(rowsFromServices(next.services));
      setDirty(false);
      setServicesDirty(false);
    }
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    apiFetch<OnboardingApplicationDto>(`${EMPLOYEE_ONBOARDING}/${applicationId}`)
      .then((next) => accept(next, true))
      .catch((err) => setError(message(err, "Could not load this application.")));
  }, [accept, applicationId]);

  const readOnly = !app?.canEdit;
  const set = (key: string, value: string | number | boolean | null) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  useEffect(() => {
    if (dirty || servicesDirty) backupDraft(applicationId, { form, hours, rows });
  }, [applicationId, dirty, servicesDirty, form, hours, rows]);

  const save = useCallback(
    async (quiet = false): Promise<boolean> => {
      if (!app || readOnly) return true;
      if (!dirty && !servicesDirty) return true;
      setBusy("save");
      setError(null);
      try {
        let next = app;
        if (dirty) {
          next = await apiFetch<OnboardingApplicationDto>(`${EMPLOYEE_ONBOARDING}/${app.id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...draftPayload(form), hours: hoursForSave(hours), expectedVersion: next.version }),
          });
        }
        if (servicesDirty) {
          next = await apiFetch<OnboardingApplicationDto>(
            `${EMPLOYEE_ONBOARDING}/${app.id}/${EMPLOYEE_PATHS.services}`,
            { method: "PUT", body: JSON.stringify({ services: servicesPayload(rows), expectedVersion: next.version }) },
          );
        }
        accept(next, false);
        setRows(rowsFromServices(next.services));
        setDirty(false);
        setServicesDirty(false);
        setSavedAt(new Date());
        clearDraftBackup(app.id);
        if (!quiet) setNotice("Draft saved.");
        return true;
      } catch (err) {
        setError(message(err, "Could not save. Your changes are still here; try again."));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [accept, app, dirty, form, hours, readOnly, rows, servicesDirty],
  );

  const goTo = async (next: number) => {
    setNotice(null);
    if (await save(true)) {
      setStep(next);
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const missing = useMemo(
    () => (app ? liveMissing(form, hours, rows, app.media, app.photoExceptionReason) : []),
    [app, form, hours, rows],
  );

  if (error && !app) return <p className={base.error} role="alert">{error}</p>;
  if (!app) return <p className={base.empty} aria-busy="true">Loading application…</p>;

  const upload = async (files: FileList | null, category: OnboardingMediaCategory) => {
    if (!files?.length) return;
    if (!(await save(true))) return;
    setError(null);
    for (const file of Array.from(files)) {
      if (file.size > ONBOARDING_MEDIA_LIMITS.maxBytes) {
        setError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      setBusy(`upload-${category}`);
      const body = new FormData();
      body.append("category", category);
      body.append("image", file);
      try {
        const next = await apiFetch<OnboardingApplicationDto>(`${EMPLOYEE_ONBOARDING}/${app.id}/${EMPLOYEE_PATHS.media}`, {
          method: "POST",
          body,
        });
        accept(next, false);
        setNotice(`${file.name} uploaded.`);
      } catch (err) {
        setError(message(err, `Could not upload ${file.name}.`));
      } finally {
        setBusy(null);
      }
    }
  };

  const removeMedia = async (mediaId: string) => {
    setBusy(`remove-${mediaId}`);
    try {
      const next = await apiFetch<OnboardingApplicationDto>(
        `${EMPLOYEE_ONBOARDING}/${app.id}/${EMPLOYEE_PATHS.media}/${mediaId}`,
        { method: "DELETE" },
      );
      accept(next, false);
    } catch (err) {
      setError(message(err, "Could not remove the photo."));
    } finally {
      setBusy(null);
    }
  };

  const extract = async (mediaId: string) => {
    if (!(await save(true))) return;
    setBusy(`extract-${mediaId}`);
    setError(null);
    try {
      const result = await apiFetch<MenuExtractionResultDto>(
        `${EMPLOYEE_ONBOARDING}/${app.id}/${EMPLOYEE_PATHS.media}/${mediaId}/${EMPLOYEE_PATHS.extract}`,
        { method: "POST" },
      );
      const next = await apiFetch<OnboardingApplicationDto>(`${EMPLOYEE_ONBOARDING}/${app.id}`);
      accept(next, false);
      setRows(rowsFromServices(next.services));
      setNotice(
        `${result.added} services read from the menu${result.mergedDuplicates ? `, ${result.mergedDuplicates} already listed` : ""}. Check each highlighted row and tick "Confirmed".`,
      );
    } catch (err) {
      setError(message(err, "The menu could not be read automatically. Enter the services manually."));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!(await save(true))) return;
    setBusy("submit");
    setError(null);
    try {
      const next = await apiFetch<OnboardingApplicationDto>(
        `${EMPLOYEE_ONBOARDING}/${app.id}/${EMPLOYEE_PATHS.submit}`,
        { method: "POST", body: JSON.stringify({ expectedVersion: app.version }) },
      );
      accept(next, true);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.details && typeof err.details === "object" && "missing" in err.details) {
        setError("Some required information is still missing. See the list below.");
      } else {
        setError(message(err, "Could not submit the application."));
      }
    } finally {
      setBusy(null);
    }
  };

  const captureLocation = () => {
    if (!navigator.geolocation) {
      setError("This device cannot share its location. Paste a Google Maps link instead.");
      return;
    }
    setBusy("gps");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(null);
        void saveCoordinates(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setBusy(null);
        setError("Location permission was not given. Coordinates were left empty.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const saveCoordinates = async (latitude: number, longitude: number) => {
    try {
      const next = await apiFetch<OnboardingApplicationDto>(`${EMPLOYEE_ONBOARDING}/${app.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          coordinates: { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)), source: "GPS" },
          expectedVersion: app.version,
        }),
      });
      accept(next, false);
      setNotice("GPS location saved.");
    } catch (err) {
      setError(message(err, "Could not save the location."));
    }
  };

  const text = (key: string, label: string, opts: { required?: boolean; type?: string; inputMode?: "numeric" | "tel" | "email" | "url"; placeholder?: string; full?: boolean; maxLength?: number } = {}) => (
    <label className={opts.full ? styles.full : undefined}>
      <span className={opts.required ? styles.required : undefined}>{label}</span>
      <input
        type={opts.type ?? "text"}
        inputMode={opts.inputMode}
        placeholder={opts.placeholder}
        maxLength={opts.maxLength}
        value={(form[key] as string | number | undefined) ?? ""}
        disabled={readOnly}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const number = (key: string, label: string, required = false) => (
    <label>
      <span className={required ? styles.required : undefined}>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        value={(form[key] as string | number | undefined) ?? ""}
        disabled={readOnly}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const choice = (key: string, label: string, options: Array<[string, string]>, required = false) => (
    <div className={`${styles.field} ${styles.full}`}>
      <span className={required ? styles.required : undefined}>{label}</span>
      <div className={styles.segmented} role="radiogroup" aria-label={label}>
        {options.map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={form[key] === value}
            className={form[key] === value ? styles.segmentedActive : undefined}
            disabled={readOnly}
            onClick={() => set(key, form[key] === value ? "" : value)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
  const yesNo = (key: string, label: string) =>
    choice(key, label, [
      ["true", "Yes"],
      ["false", "No"],
    ]);
  const check = (key: string, label: string) => (
    <label className={`${styles.checkRow} ${styles.full}`}>
      <input type="checkbox" checked={form[key] === true} disabled={readOnly} onChange={(e) => set(key, e.target.checked)} />
      <span>{label}</span>
    </label>
  );

  const updateRow = (key: string, patch: Partial<ServiceRow>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setServicesDirty(true);
  };

  const menuMedia = app.media.filter((m) => m.category === "MENU");
  const statusLabel = ONBOARDING_STATUS_LABELS[app.status];

  if (submitted) {
    return (
      <section className={base.panel}>
        <p className={base.success} role="status">
          Submitted for review as <span className={styles.ref}>{app.reference}</span>. The application is now read-only
          until the FastQue team reviews it.
        </p>
        <div className={base.quickActions}>
          <Link className={base.primaryButton} href="/employee?tab=onboarding">Back to Salon Onboarding</Link>
          <Link className={base.secondaryButton} href="/employee/onboarding/new">Start another</Link>
        </div>
      </section>
    );
  }

  return (
    <div>
      <div className={styles.heading}>
        <div>
          <h2>{app.salonName}</h2>
          <small>
            <span className={styles.ref}>{app.reference}</span> · {statusLabel} · {app.assignedEmployee.fullName} (
            {app.assignedEmployee.employeeCode})
          </small>
        </div>
        <small className={styles.savedNote} aria-live="polite">
          {busy === "save" ? "Saving…" : dirty || servicesDirty ? "Unsaved changes" : savedAt ? `Saved ${savedAt.toLocaleTimeString("en-IN")}` : ""}
        </small>
      </div>

      {readOnly && (
        <div className={styles.callout}>
          {app.status === "REJECTED"
            ? `Rejected: ${app.rejectionReason ?? "no reason recorded"}`
            : "This application is with the review team and is read-only. You can edit it again if changes are requested."}
        </div>
      )}
      {app.changeRequest && app.status === "CHANGES_REQUESTED" && (
        <div className={`${styles.callout} ${styles.calloutDanger}`}>
          <strong>Corrections requested:</strong>
          <ul className={styles.missingList}>
            {app.changeRequest.map((item, i) => (
              <li key={i}>
                {ONBOARDING_FIELD_LABELS[item.field] ?? item.field}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <nav className={styles.stepper} aria-label="Onboarding steps">
        {ONBOARDING_STEPS.map((label, index) => {
          const stepHasMissing = missing.some((m) => m.step === index + 1);
          const className = index === step ? styles.stepActive : !stepHasMissing && index < step ? styles.stepDone : styles.step;
          return (
            <button
              key={label}
              type="button"
              className={className}
              aria-current={index === step ? "step" : undefined}
              onClick={() => void goTo(index)}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          );
        })}
      </nav>
      <div className={styles.progress} aria-hidden="true">
        <i style={{ width: `${((step + 1) / ONBOARDING_STEPS.length) * 100}%` }} />
      </div>

      {error && <p className={base.error} role="alert">{error}</p>}
      {notice && <p className={base.success} role="status">{notice}</p>}

      <section className={base.panel}>
        {step === 0 && (
          <div className={styles.fields}>
            {text("salonName", "Salon name", { required: true, full: true, maxLength: 160 })}
            {choice("genderCategory", "Salon category", [["MEN", "Men"], ["WOMEN", "Women"], ["UNISEX", "Unisex"]], true)}
            {choice(
              "salonKind",
              "Salon type",
              [["BARBER_SHOP", "Barber shop"], ["BEAUTY_SALON", "Beauty salon"], ["UNISEX_SALON", "Unisex salon"], ["SPA", "Spa"], ["OTHER", "Other"]],
              true,
            )}
            {text("brandName", "Business / brand name")}
            {text("websiteUrl", "Website", { inputMode: "url", placeholder: "https://" })}
            {text("instagramUrl", "Instagram profile", { inputMode: "url", placeholder: "https://instagram.com/…" })}
            {text("mapsUrl", "Google Maps link", { inputMode: "url", placeholder: "https://maps.app.goo.gl/…" })}
            {choice("isFranchise", "Ownership", [["false", "Independent"], ["true", "Franchise"]])}
            {number("branchCount", "Number of branches")}
            <label className={styles.full}>
              Description (optional)
              <textarea value={(form.description as string) ?? ""} disabled={readOnly} onChange={(e) => set("description", e.target.value)} />
            </label>
          </div>
        )}

        {step === 1 && (
          <div className={styles.fields}>
            {text("ownerName", "Owner's full name", { required: true })}
            {text("ownerPhone", "Owner's mobile", { required: true, type: "tel", inputMode: "tel", placeholder: "10-digit mobile" })}
            {text("ownerWhatsapp", "WhatsApp number", { type: "tel", inputMode: "tel" })}
            {text("ownerEmail", "Owner's email", { type: "email", inputMode: "email" })}
            {text("alternatePhone", "Alternate contact", { type: "tel", inputMode: "tel" })}
            {text("preferredLanguage", "Preferred language", { placeholder: "Hindi, English…" })}
            {text("managerName", "Manager name (if different)")}
            {text("managerPhone", "Manager phone", { type: "tel", inputMode: "tel" })}
            {check("consentContact", "The owner agrees that FastQue may contact them and create a FastQue account for this salon.")}
            <p className={`${styles.hint} ${styles.full}`}>
              FastQue never sends a password. After approval the owner gets a one-time link to set their own.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className={styles.fields}>
            {text("shopNumber", "Shop number")}
            {text("buildingName", "Building / market")}
            {text("streetAddress", "Street address", { required: true, full: true })}
            {text("landmark", "Landmark")}
            {text("locality", "Locality / area", { required: true })}
            {text("city", "City", { required: true })}
            {text("district", "District")}
            {text("state", "State", { required: true })}
            {text("postalCode", "PIN code", { required: true, inputMode: "numeric", maxLength: 6 })}
            {text("country", "Country", { required: true })}
            {text("mapsUrl", "Google Maps link", { inputMode: "url", full: true })}
            <div className={`${styles.field} ${styles.full}`}>
              <span>GPS coordinates</span>
              <div className={styles.uploadButtons}>
                <button type="button" className={base.secondaryButton} disabled={readOnly || busy === "gps"} onClick={captureLocation}>
                  {busy === "gps" ? "Getting location…" : "Use my current location"}
                </button>
                <span className={styles.hint}>
                  {app.coordinates
                    ? `${app.coordinates.latitude}, ${app.coordinates.longitude} (${app.coordinates.source})`
                    : "Not captured. Only saved with your permission; never guessed from the address."}
                </span>
              </div>
            </div>
            <div className={`${styles.preview} ${styles.full}`} aria-label="Address preview">
              {addressPreview(form) || "The address preview appears here as you type."}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className={styles.fields}>
            {number("employeeCount", "Total employees", true)}
            {number("chairCount", "Total service chairs", true)}
            {number("activeChairCount", "Active chairs")}
            {number("averageServiceMinutes", "Average service time (min)")}
            {number("maleStaffCount", "Male staff (if separate)")}
            {number("femaleStaffCount", "Female staff (if separate)")}
            {yesNo("walkInsAccepted", "Walk-ins accepted")}
            {yesNo("bookingsAccepted", "Scheduled bookings accepted")}
            {yesNo("liveQueueSupported", "Live queue supported")}
            {number("appointmentIntervalMinutes", "Appointment interval (min)")}
            <div className={`${styles.field} ${styles.full}`}>
              <span className={styles.required}>Weekly hours</span>
              <div className={base.quickActions}>
                <button
                  type="button"
                  className={base.smallButton}
                  disabled={readOnly}
                  onClick={() => {
                    const monday = hours.find((h) => h.dayOfWeek === 1);
                    if (!monday) return;
                    setHours((current) => current.map((h) => ({ ...monday, dayOfWeek: h.dayOfWeek })));
                    setDirty(true);
                  }}
                >
                  Copy Monday to all days
                </button>
              </div>
              <div className={styles.hoursList}>
                {WEEK_DAYS.map(({ day, label }) => {
                  const row = hours.find((h) => h.dayOfWeek === day) as OnboardingHoursDto;
                  const overnight = !row.isClosed && !!row.opensAt && !!row.closesAt && row.closesAt < row.opensAt;
                  const patch = (p: Partial<OnboardingHoursDto>) => {
                    setHours((current) => current.map((h) => (h.dayOfWeek === day ? { ...h, ...p } : h)));
                    setDirty(true);
                  };
                  return (
                    <div key={day} className={styles.hoursRow}>
                      <strong>{label}</strong>
                      <label className={styles.checkRow}>
                        <input type="checkbox" checked={row.isClosed} disabled={readOnly} onChange={(e) => patch({ isClosed: e.target.checked })} />
                        Closed
                      </label>
                      {!row.isClosed && (
                        <>
                          <input type="time" aria-label={`${label} opens`} value={row.opensAt ?? ""} disabled={readOnly} onChange={(e) => patch({ opensAt: e.target.value || null })} />
                          <input type="time" aria-label={`${label} closes`} value={row.closesAt ?? ""} disabled={readOnly} onChange={(e) => patch({ closesAt: e.target.value || null })} />
                        </>
                      )}
                      {overnight && <span className={styles.overnight}>Closes after midnight (next day)</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <label className={styles.full}>
              Weekly holidays, special or festival timings
              <textarea value={(form.specialTimings as string) ?? ""} disabled={readOnly} onChange={(e) => set("specialTimings", e.target.value)} />
            </label>
          </div>
        )}

        {step === 4 && (
          <div>
            <div className={styles.callout}>
              Enter every service with its price and how long it takes. Never guess a duration: ask the owner. Rows read
              from a menu photo stay unconfirmed until you check them and tick “Confirmed”.
            </div>
            <div className={styles.photoGroups}>
              <div>
                <div className={styles.heading}>
                  <h2>Menu photos</h2>
                  <small>{menuMedia.length} uploaded</small>
                </div>
                <PhotoPicker category="MENU" busy={busy} readOnly={readOnly} onFiles={upload} />
                <div className={styles.photoGrid}>
                  {menuMedia.map((m, i) => (
                    <div key={m.id} className={styles.photoCard}>
                      <PrivateImage path={m.filePath} alt={`Menu page ${i + 1}`} />
                      <footer>
                        <button type="button" className={base.smallButton} disabled={readOnly || !!busy} onClick={() => void extract(m.id)}>
                          {busy === `extract-${m.id}` ? "Reading…" : "Read menu"}
                        </button>
                        {!readOnly && (
                          <button type="button" className={base.smallButtonMuted} onClick={() => void removeMedia(m.id)}>
                            Remove
                          </button>
                        )}
                      </footer>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className={styles.heading} style={{ marginTop: 16 }}>
              <h2>Services ({rows.length})</h2>
              {!readOnly && (
                <button type="button" className={base.primaryButton} onClick={() => { setRows((r) => [...r, newServiceRow()]); setServicesDirty(true); }}>
                  + Add service
                </button>
              )}
            </div>
            {rows.length === 0 && <p className={base.empty}>No services yet. Add them by hand or read a menu photo.</p>}
            <div className={styles.serviceList}>
              {rows.map((row) => {
                const unsure = (field: string) => (row.uncertainFields ?? []).includes(field) && !row.confirmedByEmployee;
                return (
                  <div key={row.key} className={`${styles.serviceRow} ${row.confirmedByEmployee ? "" : styles.serviceUnconfirmed}`}>
                    <label>
                      Service name
                      <input value={row.serviceName} disabled={readOnly} onChange={(e) => updateRow(row.key, { serviceName: e.target.value, confirmedByEmployee: false })} />
                    </label>
                    <label className={unsure("basePrice") ? styles.uncertain : undefined}>
                      Price (₹)
                      <input type="number" inputMode="decimal" min={0} value={row.basePrice ?? ""} disabled={readOnly} onChange={(e) => updateRow(row.key, { basePrice: e.target.value === "" ? null : Number(e.target.value) })} />
                    </label>
                    <label>
                      Price type
                      <select value={row.priceType ?? "FIXED"} disabled={readOnly} onChange={(e) => updateRow(row.key, { priceType: e.target.value as "FIXED" | "STARTS_FROM" })}>
                        <option value="FIXED">Fixed</option>
                        <option value="STARTS_FROM">Starts from</option>
                      </select>
                    </label>
                    <label className={!row.durationMinutes ? styles.uncertain : undefined}>
                      Duration (min)
                      <input type="number" inputMode="numeric" min={1} value={row.durationMinutes ?? ""} disabled={readOnly} onChange={(e) => updateRow(row.key, { durationMinutes: e.target.value === "" ? null : Number(e.target.value) })} />
                    </label>
                    <label>
                      For
                      <select value={row.applicableGender ?? ""} disabled={readOnly} onChange={(e) => updateRow(row.key, { applicableGender: (e.target.value || null) as ServiceRow["applicableGender"] })}>
                        <option value="">Not stated</option>
                        <option value="MEN">Men</option>
                        <option value="WOMEN">Women</option>
                        <option value="UNISEX">Unisex</option>
                      </select>
                    </label>
                    {!readOnly && (
                      <button type="button" className={base.smallButtonMuted} aria-label={`Remove ${row.serviceName || "service"}`} onClick={() => { setRows((r) => r.filter((x) => x.key !== row.key)); setServicesDirty(true); }}>
                        ✕
                      </button>
                    )}
                    <div className={styles.serviceMeta}>
                      <label>
                        Category
                        <input value={row.category ?? ""} disabled={readOnly} onChange={(e) => updateRow(row.key, { category: e.target.value || null })} />
                      </label>
                      <label>
                        Discounted price (₹)
                        <input type="number" min={0} value={row.discountedPrice ?? ""} disabled={readOnly} onChange={(e) => updateRow(row.key, { discountedPrice: e.target.value === "" ? null : Number(e.target.value) })} />
                      </label>
                      <label className={styles.checkRow}>
                        <input type="checkbox" checked={row.isActive ?? true} disabled={readOnly} onChange={(e) => updateRow(row.key, { isActive: e.target.checked })} />
                        Active
                      </label>
                      <label className={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={row.confirmedByEmployee ?? false}
                          disabled={readOnly}
                          onChange={(e) => updateRow(row.key, { confirmedByEmployee: e.target.checked, uncertainFields: e.target.checked ? [] : row.uncertainFields })}
                        />
                        Confirmed with owner
                      </label>
                      {row.sourceType === "AI_EXTRACTED" && <span className={styles.badgeWarn}>From menu photo{row.extractionConfidence != null ? ` · ${Math.round(row.extractionConfidence * 100)}% sure` : ""}</span>}
                      {row.confirmedByEmployee && <span className={styles.badgeOk}>Confirmed</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 5 && (
          <div className={styles.photoGroups}>
            <p className={styles.hint}>
              At least one exterior, interior, stations or reception photo is required. Photos stay private until FastQue
              approves them for the public profile. JPG, PNG or WebP up to 10 MB.
            </p>
            {PHOTO_GROUPS.map((group) => {
              const items = app.media.filter((m) => m.category === group.category);
              return (
                <div key={group.category}>
                  <div className={styles.heading}>
                    <h2>
                      {group.label}
                      {ONBOARDING_SHOP_PHOTO_CATEGORIES.includes(group.category) ? "" : " (optional)"}
                    </h2>
                    <small>{items.length} uploaded</small>
                  </div>
                  <PhotoPicker category={group.category} busy={busy} readOnly={readOnly} onFiles={upload} />
                  <div className={styles.photoGrid}>
                    {items.map((m) => (
                      <div key={m.id} className={styles.photoCard}>
                        <PrivateImage path={m.filePath} alt={`${group.label} photo`} />
                        <footer>
                          <span>{m.uploadedBy}</span>
                          {!readOnly && (
                            <button type="button" className={base.smallButtonMuted} disabled={busy === `remove-${m.id}`} onClick={() => void removeMedia(m.id)}>
                              Remove
                            </button>
                          )}
                        </footer>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {step === 6 && (
          <div className={styles.fields}>
            {check("consentAccuracy", "The owner confirms the salon information is accurate.")}
            {check("consentListing", "The owner consents to the FastQue listing and to FastQue processing these contact details.")}
            {check("consentAuthorization", "The owner authorises the content I collected (details, photos, menu) to be submitted.")}
            {check("consentContact", "The owner agrees to be contacted and to have a FastQue account created.")}
            {text("gstin", "GSTIN (optional)", { maxLength: 15 })}
            {text("businessRegistration", "Business registration details (optional)")}
            <label className={styles.full}>
              Employee notes
              <textarea value={(form.employeeNotes as string) ?? ""} disabled={readOnly} onChange={(e) => set("employeeNotes", e.target.value)} />
            </label>
            <label className={styles.full}>
              Unresolved questions
              <textarea value={(form.openQuestions as string) ?? ""} disabled={readOnly} onChange={(e) => set("openQuestions", e.target.value)} />
            </label>
            <p className={`${styles.hint} ${styles.full}`}>Do not collect Aadhaar, PAN or other identity documents.</p>
          </div>
        )}

        {step === 7 && (
          <ReviewStep
            app={app}
            form={form}
            hours={hours}
            rows={rows}
            missing={missing}
            onJump={(s) => void goTo(s - 1)}
          />
        )}
      </section>

      <div className={styles.navBar}>
        <button type="button" className={base.secondaryButton} disabled={step === 0 || !!busy} onClick={() => void goTo(step - 1)}>
          ← Previous
        </button>
        <div>
          {!readOnly && (
            <button type="button" className={base.secondaryButton} disabled={!!busy || (!dirty && !servicesDirty)} onClick={() => void save(false)}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
          )}
          {step < ONBOARDING_STEPS.length - 1 ? (
            <button type="button" className={base.primaryButton} disabled={!!busy} onClick={() => void goTo(step + 1)}>
              Next →
            </button>
          ) : (
            !readOnly && (
              <button type="button" className={base.primaryButton} disabled={!!busy || missing.length > 0} onClick={() => void submit()}>
                {busy === "submit" ? "Submitting…" : app.status === "CHANGES_REQUESTED" ? "Resubmit for review" : "Submit for review"}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function PhotoPicker({
  category,
  busy,
  readOnly,
  onFiles,
}: {
  category: OnboardingMediaCategory;
  busy: string | null;
  readOnly: boolean;
  onFiles: (files: FileList | null, category: OnboardingMediaCategory) => void | Promise<void>;
}) {
  if (readOnly) return null;
  const uploading = busy === `upload-${category}`;
  return (
    <div className={styles.uploadButtons} style={{ marginBottom: 10 }}>
      <label className={styles.uploadLabel}>
        {uploading ? "Uploading…" : "Take photo"}
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={!!busy} onChange={(e) => { void onFiles(e.target.files, category); e.target.value = ""; }} />
      </label>
      <label className={styles.uploadLabel}>
        Upload from device
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={!!busy} onChange={(e) => { void onFiles(e.target.files, category); e.target.value = ""; }} />
      </label>
    </div>
  );
}

function ReviewStep({
  app,
  form,
  hours,
  rows,
  missing,
  onJump,
}: {
  app: OnboardingApplicationDto;
  form: DraftForm;
  hours: OnboardingHoursDto[];
  rows: ServiceRow[];
  missing: ReturnType<typeof liveMissing>;
  onJump: (step: number) => void;
}) {
  const v = (key: string) => {
    const value = form[key];
    return value === "" || value === null || value === undefined ? "Not entered" : String(value);
  };
  const consents = ["consentContact", "consentListing", "consentAccuracy", "consentAuthorization"].filter((k) => form[k] === true).length;
  return (
    <div>
      {missing.length > 0 ? (
        <div className={styles.callout}>
          <strong>Still missing before you can submit:</strong>
          <ul className={styles.missingList}>
            {missing.map((m, i) => (
              <li key={i}>
                <button type="button" onClick={() => onJump(m.step)}>
                  Step {m.step}: {m.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={base.success}>Everything required is filled in. Check the summary and submit.</p>
      )}
      <div className={styles.summary}>
        <section>
          <h3>Salon</h3>
          <dl>
            <dt>Name</dt><dd>{v("salonName")}</dd>
            <dt>Category</dt><dd>{v("genderCategory")}</dd>
            <dt>Type</dt><dd>{v("salonKind")}</dd>
            <dt>Employee</dt><dd>{app.assignedEmployee.fullName} ({app.assignedEmployee.employeeCode})</dd>
          </dl>
        </section>
        <section>
          <h3>Owner</h3>
          <dl>
            <dt>Name</dt><dd>{v("ownerName")}</dd>
            <dt>Mobile</dt><dd>{v("ownerPhone")}</dd>
            <dt>Email</dt><dd>{v("ownerEmail")}</dd>
            <dt>Consent</dt><dd>{consents} of 4 confirmations</dd>
          </dl>
        </section>
        <section>
          <h3>Address</h3>
          <p>{addressPreview(form) || "Not entered"}</p>
        </section>
        <section>
          <h3>Operations</h3>
          <dl>
            <dt>Staff</dt><dd>{v("employeeCount")}</dd>
            <dt>Chairs</dt><dd>{v("chairCount")}</dd>
            {WEEK_DAYS.map(({ day, label }) => {
              const h = hours.find((x) => x.dayOfWeek === day);
              return (
                <span key={day} style={{ display: "contents" }}>
                  <dt>{label.slice(0, 3)}</dt>
                  <dd>{!h ? "—" : h.isClosed ? "Closed" : h.opensAt && h.closesAt ? `${h.opensAt}–${h.closesAt}` : "Not entered"}</dd>
                </span>
              );
            })}
          </dl>
        </section>
        <section className={styles.full}>
          <h3>Services ({rows.length})</h3>
          <dl>
            {rows.map((r) => (
              <span key={r.key} style={{ display: "contents" }}>
                <dt>{r.serviceName || "Unnamed"}</dt>
                <dd>
                  {r.priceType === "STARTS_FROM" ? "from " : ""}
                  {formatInr(r.basePrice ?? null)} · {r.durationMinutes ? `${r.durationMinutes} min` : "duration missing"}
                  {r.confirmedByEmployee ? "" : " · unconfirmed"}
                </dd>
              </span>
            ))}
          </dl>
        </section>
        <section className={styles.full}>
          <h3>Photos ({app.media.length})</h3>
          <div className={styles.photoGrid}>
            {app.media.map((m) => (
              <div key={m.id} className={styles.photoCard}>
                <PrivateImage path={m.filePath} alt={m.category} />
                <footer><span>{m.category.toLowerCase()}</span></footer>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
