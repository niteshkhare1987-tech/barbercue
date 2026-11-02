"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  ONBOARDING_FIELD_LABELS,
  ONBOARDING_STATUS_LABELS,
  type AdminOnboardingApplicationDto,
  type OnboardingApprovalResultDto,
  type OnboardingDuplicateDto,
  type OnboardingPublishReadinessDto,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../../../../../lib/api";
import { useAuth } from "../../../../../../lib/auth-context";
import { ADMIN_ONBOARDING, WEEK_DAYS, formatInr } from "../../../../../../lib/onboarding";
import { PrivateImage } from "../../../../../../components/onboarding/PrivateImage";
import { Button, LinkButton } from "../../../../../../components/ui/Button";
import styles from "../../admin.module.css";
import local from "../onboarding-admin.module.css";

type Dialog = null | "approve" | "changes" | "reject" | "correct" | "suspend";
type Json = Record<string, unknown>;

const REVIEWABLE = ["SUBMITTED", "UNDER_REVIEW", "RESUBMITTED"];
const CORRECTABLE_FIELDS = [
  "salonName", "ownerName", "ownerPhone", "ownerEmail", "streetAddress", "locality", "city", "state", "postalCode",
  "landmark", "employeeCount", "chairCount", "description",
];

function when(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === "") return <span className={local.missing}>Not provided</span>;
  if (typeof v === "boolean") return <>{v ? "Yes" : "No"}</>;
  return <>{String(v)}</>;
}

export default function AdminOnboardingReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [app, setApp] = useState<AdminOnboardingApplicationDto | null>(null);
  const [duplicates, setDuplicates] = useState<OnboardingDuplicateDto[]>([]);
  const [readiness, setReadiness] = useState<OnboardingPublishReadinessDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [reason, setReason] = useState("");
  const [changeItems, setChangeItems] = useState<Array<{ field: string; message: string }>>([{ field: "postalCode", message: "" }]);
  const [correction, setCorrection] = useState({ field: "postalCode", value: "", reason: "" });
  const [menuIndex, setMenuIndex] = useState(0);
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([]);
  const superAdmin = !!user?.roles.includes("PLATFORM_ADMIN");

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<AdminOnboardingApplicationDto>(`${ADMIN_ONBOARDING}/${id}`);
      setApp(next);
      setInternalNotes(next.internalNotes ?? "");
      setError(null);
      apiFetch<OnboardingDuplicateDto[]>(`${ADMIN_ONBOARDING}/${id}/duplicates`).then(setDuplicates).catch(() => setDuplicates([]));
      if (next.salonId) {
        apiFetch<OnboardingPublishReadinessDto>(`${ADMIN_ONBOARDING}/${id}/publish-readiness`).then(setReadiness).catch(() => setReadiness(null));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the application.");
    }
  }, [id]);

  useEffect(() => {
    // Deferred one tick so the first fetch's state updates never run inside the effect body.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const act = async (key: string, path: string, body?: Json, success?: string) => {
    if (!app) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<AdminOnboardingApplicationDto | OnboardingApprovalResultDto>(`${ADMIN_ONBOARDING}/${app.id}/${path}`, {
        method: path === "corrections" ? "PATCH" : "POST",
        body: JSON.stringify(body ?? {}),
      });
      if ("application" in result) {
        setDevLink(result.devInviteUrl ?? null);
        const inv = result.invitation;
        setNotice(
          result.alreadyApproved
            ? "Already approved; no duplicate salon or account was created."
            : `${success ?? "Done."} ${
                inv
                  ? inv.status === "SENT"
                    ? "Invitation accepted by the email provider (not yet confirmed delivered)."
                    : inv.status === "CAPTURED_DEV"
                      ? "Development mode: invitation captured locally, nothing was sent."
                      : `Invitation not delivered (${inv.status.toLowerCase().replace(/_/g, " ")}). You can retry.`
                  : result.ownerLinkedExisting
                    ? "Linked to the owner's existing verified account."
                    : ""
              }${result.servicesNeedingOwnerInput.length ? ` Owner must complete: ${result.servicesNeedingOwnerInput.join(", ")}.` : ""}`,
        );
      } else {
        setNotice(success ?? "Saved.");
      }
      setDialog(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.details && typeof err.details === "object" && "checks" in err.details) {
        setReadiness({ ready: false, checks: (err.details as OnboardingPublishReadinessDto).checks });
      }
      setError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setBusy(null);
    }
  };

  if (error && !app) return <main className={styles.page}><p className={styles.error} role="alert">{error}</p></main>;
  if (!app) return <main className={styles.page}><p className={styles.empty} aria-busy="true">Loading application…</p></main>;

  const menus = app.media.filter((m) => m.category === "MENU");
  const photos = app.media.filter((m) => m.category !== "MENU");
  const reviewable = REVIEWABLE.includes(app.status);
  const decide = app.canDecide;
  const latestInvite = app.invitations[0];
  const canResend = decide && ["APPROVED", "OWNER_INVITED", "AWAITING_OWNER_ACTIVATION"].includes(app.status);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}><code>{app.reference}</code> · version {app.version}</p>
          <h1 style={{ fontSize: "1.7rem" }}>{app.salonName}</h1>
          <p>
            {ONBOARDING_STATUS_LABELS[app.status]} · submitted {when(app.submittedAt)} by {app.assignedEmployee.fullName} ({app.assignedEmployee.employeeCode})
            {app.territory ? ` · ${app.territory}` : ""}
          </p>
        </div>
        <div className={styles.headerActions}>
          <LinkButton href="/dashboard/admin/onboarding" variant="outline">Back to queue</LinkButton>
        </div>
      </header>

      {!decide && (
        <p className={styles.readOnlyNotice} role="status">
          {app.ownerPhoneMasked ? "Read-only view; owner contact details are masked." : "You can view this application but cannot decide on it (it is yours, or your role is read-only)."}
        </p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {devLink && (
        <p className={styles.readOnlyNotice}>
          Dev-only invite link (never shown in production): <span className={local.devLink}>{devLink}</span>
        </p>
      )}

      {decide && (
        <div className={local.actionBar}>
          <div>
            {(app.status === "SUBMITTED" || app.status === "RESUBMITTED") && (
              <Button type="button" variant="outline" disabled={!!busy} onClick={() => void act("start", "start-review", {}, "Review started.")}>Start review</Button>
            )}
            {reviewable && <Button type="button" disabled={!!busy || app.missing.length > 0} onClick={() => setDialog("approve")}>Approve</Button>}
            {reviewable && <Button type="button" variant="outline" disabled={!!busy} onClick={() => setDialog("changes")}>Request changes</Button>}
            {reviewable && <Button type="button" variant="outline" disabled={!!busy} onClick={() => setDialog("reject")}>Reject</Button>}
            {reviewable && <Button type="button" variant="outline" disabled={!!busy} onClick={() => setDialog("correct")}>Correct a field</Button>}
            {!app.reviewer && <Button type="button" variant="outline" disabled={!!busy} onClick={() => user && void act("assign", "assign-reviewer", { reviewerId: user.id }, "Assigned to you.")}>Assign to me</Button>}
            {canResend && <Button type="button" variant="outline" disabled={!!busy} onClick={() => void act("resend", "invitation/resend", {}, "New invitation issued.")}>Resend invitation</Button>}
            {superAdmin && app.salonId && app.status !== "ACTIVE" && app.status !== "SUSPENDED" && (
              <Button type="button" disabled={!!busy || !readiness?.ready} onClick={() => void act("publish", "publish", {}, "Salon published. It is now visible to customers.")}>Publish salon</Button>
            )}
            {superAdmin && app.status === "ACTIVE" && <Button type="button" variant="outline" disabled={!!busy} onClick={() => setDialog("suspend")}>Suspend</Button>}
          </div>
          <span>Reviewer: {app.reviewer?.name ?? "Unassigned"}</span>
        </div>
      )}

      {dialog === "approve" && (
        <section className={local.dialog} aria-label="Approve">
          <h3>Approve {app.salonName}?</h3>
          <p>This creates the salon (hidden from customers), links or creates the owner account, and sends a one-time password-setup invitation. It does not publish the salon.</p>
          <label className={local.formField}>Review notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <div>
            <Button type="button" disabled={!!busy} onClick={() => void act("approve", "approve", { applicationVersion: app.version, notes: notes || null }, "Approved.")}>{busy === "approve" ? "Approving…" : "Confirm approval"}</Button>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </div>
        </section>
      )}
      {dialog === "changes" && (
        <section className={local.dialog} aria-label="Request changes">
          <h3>Request changes</h3>
          <p>Say exactly what needs correcting. The employee is notified and can resubmit.</p>
          {changeItems.map((item, i) => (
            <div key={i} className={local.changeItem}>
              <select aria-label="Field" value={item.field} onChange={(e) => setChangeItems((c) => c.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                {Object.entries(ONBOARDING_FIELD_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input aria-label="What needs correcting" value={item.message} placeholder="What is wrong and what is needed" onChange={(e) => setChangeItems((c) => c.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} />
              <Button type="button" variant="outline" disabled={changeItems.length === 1} onClick={() => setChangeItems((c) => c.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" onClick={() => setChangeItems((c) => [...c, { field: "services", message: "" }])}>+ Add item</Button>
            <Button type="button" disabled={!!busy || changeItems.some((c) => c.message.trim().length < 3)} onClick={() => void act("changes", "request-changes", { items: changeItems, applicationVersion: app.version }, "Changes requested; the employee was notified.")}>Send to employee</Button>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </div>
        </section>
      )}
      {dialog === "reject" && (
        <section className={local.dialog} aria-label="Reject">
          <h3>Reject application</h3>
          <label className={local.formField}>Reason (shared with the employee)<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div>
            <Button type="button" disabled={!!busy || reason.trim().length < 5} onClick={() => void act("reject", "reject", { reason, applicationVersion: app.version }, "Rejected; the employee was notified.")}>Confirm rejection</Button>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </div>
        </section>
      )}
      {dialog === "correct" && (
        <section className={local.dialog} aria-label="Correct a field">
          <h3>Correct a field (recorded in the audit trail)</h3>
          <div className={local.changeItem}>
            <select aria-label="Field" value={correction.field} onChange={(e) => setCorrection({ ...correction, field: e.target.value })}>
              {CORRECTABLE_FIELDS.map((k) => <option key={k} value={k}>{ONBOARDING_FIELD_LABELS[k] ?? k}</option>)}
            </select>
            <input aria-label="New value" value={correction.value} placeholder="Corrected value" onChange={(e) => setCorrection({ ...correction, value: e.target.value })} />
          </div>
          <label className={local.formField}>Why<input value={correction.reason} onChange={(e) => setCorrection({ ...correction, reason: e.target.value })} /></label>
          <div>
            <Button
              type="button"
              disabled={!!busy || correction.reason.trim().length < 3}
              onClick={() => {
                const numeric = ["employeeCount", "chairCount"].includes(correction.field);
                void act("correct", "corrections", {
                  changes: { [correction.field]: numeric ? Number(correction.value) : correction.value },
                  reason: correction.reason,
                  applicationVersion: app.version,
                }, "Correction saved.");
              }}
            >
              Save correction
            </Button>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </div>
        </section>
      )}
      {dialog === "suspend" && (
        <section className={local.dialog} aria-label="Suspend">
          <h3>Suspend this live salon</h3>
          <label className={local.formField}>Reason<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div>
            <Button type="button" disabled={!!busy || reason.trim().length < 5} onClick={() => void act("suspend", "suspend", { reason }, "Salon suspended.")}>Confirm suspension</Button>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </div>
        </section>
      )}

      {app.missing.length > 0 && (
        <p className={styles.readOnlyNotice}>
          Missing information: {app.missing.map((m) => m.message).join("; ")}
        </p>
      )}

      <div className={local.review}>
        <div className={local.column}>
          <section className={local.card}>
            <h2>Salon identity</h2>
            <dl>
              <dt>Category</dt><dd><Value v={app.genderCategory} /></dd>
              <dt>Type</dt><dd><Value v={app.salonKind} /></dd>
              <dt>Brand</dt><dd><Value v={app.brandName} /></dd>
              <dt>Franchise</dt><dd><Value v={app.isFranchise} /></dd>
              <dt>Branches</dt><dd><Value v={app.branchCount} /></dd>
              <dt>Website</dt><dd><Value v={app.websiteUrl} /></dd>
              <dt>Instagram</dt><dd><Value v={app.instagramUrl} /></dd>
              <dt>Description</dt><dd><Value v={app.description} /></dd>
            </dl>
          </section>
          <section className={local.card}>
            <h2>Owner contact</h2>
            <dl>
              <dt>Owner</dt><dd><Value v={app.ownerName} /></dd>
              <dt>Mobile</dt><dd><Value v={app.ownerPhone} /></dd>
              <dt>WhatsApp</dt><dd><Value v={app.ownerWhatsapp} /></dd>
              <dt>Email</dt><dd><Value v={app.ownerEmail} /></dd>
              <dt>Alternate</dt><dd><Value v={app.alternatePhone} /></dd>
              <dt>Manager</dt><dd><Value v={app.managerName} /> <Value v={app.managerPhone} /></dd>
              <dt>Language</dt><dd><Value v={app.preferredLanguage} /></dd>
            </dl>
          </section>
          <section className={local.card}>
            <h2>Address</h2>
            <dl>
              <dt>Shop / building</dt><dd><Value v={[app.shopNumber, app.buildingName].filter(Boolean).join(", ")} /></dd>
              <dt>Street</dt><dd><Value v={app.streetAddress} /></dd>
              <dt>Landmark</dt><dd><Value v={app.landmark} /></dd>
              <dt>Locality</dt><dd><Value v={app.locality} /></dd>
              <dt>City / district</dt><dd><Value v={[app.city, app.district].filter(Boolean).join(", ")} /></dd>
              <dt>State / PIN</dt><dd><Value v={app.state} /> · <Value v={app.postalCode} /></dd>
              <dt>Country</dt><dd><Value v={app.country} /></dd>
              <dt>Coordinates</dt><dd>{app.coordinates ? `${app.coordinates.latitude}, ${app.coordinates.longitude} (${app.coordinates.source})` : <Value v={null} />}</dd>
              <dt>Maps link</dt><dd>{app.mapsUrl ? <a href={app.mapsUrl} target="_blank" rel="noreferrer noopener">Open map</a> : <Value v={null} />}</dd>
            </dl>
          </section>
          <section className={local.card}>
            <h2>Staff, chairs and hours</h2>
            <dl>
              <dt>Employees</dt><dd><Value v={app.employeeCount} /></dd>
              <dt>Chairs (active)</dt><dd><Value v={app.chairCount} /> (<Value v={app.activeChairCount} />)</dd>
              <dt>Walk-ins / bookings / queue</dt><dd><Value v={app.walkInsAccepted} /> / <Value v={app.bookingsAccepted} /> / <Value v={app.liveQueueSupported} /></dd>
              {WEEK_DAYS.map(({ day, label }) => {
                const h = app.hours.find((x) => x.dayOfWeek === day);
                return (
                  <span key={day} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd>{!h ? <Value v={null} /> : h.isClosed ? "Closed" : `${h.opensAt}–${h.closesAt}${h.closesNextDay ? " (next day)" : ""}`}</dd>
                  </span>
                );
              })}
              <dt>Special timings</dt><dd><Value v={app.specialTimings} /></dd>
            </dl>
          </section>
          <section className={local.card}>
            <h2>Employee notes</h2>
            <dl>
              <dt>Notes</dt><dd><Value v={app.employeeNotes} /></dd>
              <dt>Open questions</dt><dd><Value v={app.openQuestions} /></dd>
            </dl>
          </section>
          {decide && (
            <section className={local.card}>
              <h2>Internal notes</h2>
              <label className={local.formField}>Visible to admins only<textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} /></label>
              <div style={{ marginTop: 8 }}>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void act("notes", "notes", { internalNotes }, "Notes saved.")}>Save notes</Button>
              </div>
            </section>
          )}
        </div>

        <div className={local.column}>
          <section className={local.card}>
            <h2>Services and original menu ({app.services.length})</h2>
            <div className={local.menuCompare}>
              <div className={local.menuImage}>
                {menus.length ? (
                  <>
                    <PrivateImage path={menus[Math.min(menuIndex, menus.length - 1)].filePath} alt={`Menu page ${menuIndex + 1}`} />
                    {menus.length > 1 && (
                      <div style={{ display: "flex", gap: 6, padding: 6 }}>
                        {menus.map((m, i) => <button key={m.id} type="button" onClick={() => setMenuIndex(i)} aria-pressed={i === menuIndex}>Page {i + 1}</button>)}
                      </div>
                    )}
                  </>
                ) : (
                  <p className={styles.empty}>No menu photo uploaded.</p>
                )}
              </div>
              <table className={local.miniTable}>
                <thead><tr><th>Service</th><th>Price</th><th>Min</th><th>Source</th></tr></thead>
                <tbody>
                  {app.services.map((s) => (
                    <tr key={s.id} className={s.isActive ? undefined : local.missing}>
                      <td>{s.serviceName}<small style={{ display: "block", color: "#a7a7b4" }}>{[s.category, s.applicableGender].filter(Boolean).join(" · ")}</small></td>
                      <td>{s.priceType === "STARTS_FROM" ? "from " : ""}{formatInr(s.basePrice)}{s.discountedPrice !== null ? ` (${formatInr(s.discountedPrice)})` : ""}</td>
                      <td>{s.durationMinutes ?? <span className={local.missing}>—</span>}</td>
                      <td>
                        {s.sourceType === "AI_EXTRACTED" ? `Menu photo${s.extractionConfidence !== null ? ` ${Math.round(s.extractionConfidence * 100)}%` : ""}` : "Manual"}
                        {!s.confirmedByEmployee && <small className={local.warn} style={{ display: "block" }}>Unconfirmed</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={local.card}>
            <h2>Salon photos ({photos.length})</h2>
            {photos.length === 0 && <p className={styles.empty}>{app.photoExceptionReason ? `Photo requirement waived: ${app.photoExceptionReason}` : "No photos uploaded."}</p>}
            <div className={local.thumbs}>
              {photos.map((m) => (
                <div key={m.id} className={local.thumb}>
                  {superAdmin && app.salonId && (
                    <input
                      type="checkbox"
                      aria-label={`Approve ${m.category} photo for public display`}
                      checked={selectedPhotos.includes(m.id)}
                      onChange={(e) => setSelectedPhotos((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))}
                    />
                  )}
                  <PrivateImage path={m.filePath} alt={`${m.category} photo`} />
                  <small>{m.category.toLowerCase()} · {m.uploadedBy} · {when(m.createdAt)}</small>
                </div>
              ))}
            </div>
            {superAdmin && app.salonId && selectedPhotos.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Button type="button" variant="outline" disabled={!!busy} onClick={() => void act("photos", "photos/publish", { mediaIds: selectedPhotos }, "Photos approved for the public profile.").then(() => setSelectedPhotos([]))}>
                  Make {selectedPhotos.length} photo(s) public
                </Button>
              </div>
            )}
          </section>

          <section className={local.card}>
            <h2>Verification and consent</h2>
            <ul className={local.checks}>
              {([
                ["consentAccuracy", "Owner confirms information is accurate"],
                ["consentListing", "Consent for listing and contact processing"],
                ["consentAuthorization", "Owner authorised employee-submitted content"],
                ["consentContact", "Consent to contact and create an account"],
              ] as const).map(([key, label]) => (
                <li key={key} className={app[key] ? local.ok : local.warn}>{app[key] ? "✓" : "✕"} {label}</li>
              ))}
            </ul>
            <dl style={{ marginTop: 8 }}>
              <dt>Captured</dt><dd>{when(app.consentCapturedAt)}</dd>
              <dt>GSTIN</dt><dd><Value v={app.gstin} /></dd>
              <dt>Registration</dt><dd><Value v={app.businessRegistration} /></dd>
            </dl>
            {decide && reviewable && !app.photoExceptionReason && photos.length === 0 && (
              <div style={{ marginTop: 8 }}>
                <Button type="button" variant="outline" disabled={!!busy || reason.trim().length < 5} onClick={() => void act("exception", "photo-exception", { reason }, "Photo requirement waived.")}>Waive photo requirement</Button>
                <input aria-label="Reason for waiving photos" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
          </section>

          <section className={local.card}>
            <h2>Possible duplicates ({duplicates.length})</h2>
            {duplicates.length === 0 ? (
              <p className={styles.empty}>No matching salons, applications or leads.</p>
            ) : (
              <ul className={local.checks}>
                {duplicates.map((d, i) => (
                  <li key={i} className={local.warn}>{d.kind.toLowerCase()}: {d.label} ({d.reason}){d.status ? ` · ${d.status}` : ""}</li>
                ))}
              </ul>
            )}
          </section>

          {(app.salonId || latestInvite) && (
            <section className={local.card}>
              <h2>Owner account and publication</h2>
              <dl>
                <dt>Salon</dt><dd>{app.salonPublicId ?? "—"}</dd>
                <dt>Invitation</dt>
                <dd>
                  {latestInvite
                    ? `${latestInvite.status.toLowerCase().replace(/_/g, " ")}${latestInvite.expired ? " (expired)" : ""} · ${latestInvite.attempts} attempt(s)${latestInvite.lastError ? ` · ${latestInvite.lastError}` : ""}`
                    : "Not needed (existing verified owner)"}
                </dd>
                <dt>Publication</dt><dd>{app.publishedAt ? `Live since ${when(app.publishedAt)}` : app.publishAuthorizedAt ? "Authorized" : "Not published"}</dd>
              </dl>
              {readiness && (
                <ul className={local.checks} style={{ marginTop: 8 }}>
                  {readiness.checks.map((c) => (
                    <li key={c.key} className={c.ok ? local.ok : local.warn}>{c.ok ? "✓" : "✕"} {c.label}{c.detail ? ` (${c.detail})` : ""}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className={local.card}>
            <h2>Submission history and audit trail</h2>
            <ul className={local.timeline}>
              {[
                ...app.statusHistory.map((h) => ({ at: h.createdAt, text: `${h.previousStatus ? `${ONBOARDING_STATUS_LABELS[h.previousStatus]} → ` : ""}${ONBOARDING_STATUS_LABELS[h.newStatus]}`, who: h.actorName ?? "System", note: h.reason })),
                ...app.reviews.map((r) => ({ at: r.reviewedAt, text: `${r.decision.replace(/_/g, " ").toLowerCase()} (v${r.applicationVersion})`, who: r.reviewerName, note: r.comments })),
              ]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((e, i) => (
                  <li key={i}>
                    <strong>{e.text}</strong>
                    <small>{when(e.at)} · {e.who}{e.note ? ` · ${e.note}` : ""}</small>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
