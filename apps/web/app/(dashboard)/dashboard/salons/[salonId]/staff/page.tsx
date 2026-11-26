"use client";

import { use, useEffect, useState } from "react";
import { createSalonStaffSchema, DASHBOARD_PATHS, Role, StaffMemberStatus } from "@barbercue/shared";
import type { SalonStaffDto, StaffInviteResultDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { useAuth } from "../../../../../../lib/auth-context";
import { canPermanentlyDelete } from "../../../../../../lib/permanent-delete-access";
import { useAssistantRefresh } from "../../../../../../lib/assistant-events";
import { RequireRole } from "../../../../../../components/auth/RequireRole";
import { Button } from "../../../../../../components/ui/Button";
import { Banner as OwnerBanner, Btn as OwnerBtn, Dialog as OwnerDialog } from "../../../../../../components/owner/parts";
import { SetupNavigation } from "../../../../../../components/dashboard/SetupNavigation";
import { StaffHoursEditor } from "../../../../../../components/dashboard/StaffHoursEditor";
import { StaffProfileEditor } from "../../../../../../components/dashboard/StaffProfileEditor";
import { StaffVerificationPanel } from "../../../../../../components/dashboard/StaffVerificationPanel";
import { PermanentDeleteDialog } from "../../../../../../components/dashboard/PermanentDeleteDialog";
import styles from "../../../../../../components/dashboard/dashboard.module.css";

// Staff roster. Name is the only onboarding requirement. Optional phone/email can link an
// existing account; email enables the password invitation flow and independent staff login.
export default function DashboardStaffPage({
  params,
}: {
  params: Promise<{ salonId: string }>;
}) {
  const { salonId } = use(params);
  const { user } = useAuth();
  const mayDelete = canPermanentlyDelete(user?.roles);
  const base = `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/${salonId}/${DASHBOARD_PATHS.staff}`;

  const [staff, setStaff] = useState<SalonStaffDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Populated only outside production, where the backend returns the invitation link because no
  // email provider is wired yet (ConsoleEmailSender just logs it). In production this stays null
  // and the barber receives the link by email.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [hoursOpenFor, setHoursOpenFor] = useState<string | null>(null);
  const [profileOpenFor, setProfileOpenFor] = useState<string | null>(null);
  const [verificationOpenFor, setVerificationOpenFor] = useState<string | null>(null);
  // Owner-operations mission: removing/restoring a barber's login access (separate from clock-in/out).
  const [accessChange, setAccessChange] = useState<{ member: SalonStaffDto; revoke: boolean } | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  async function applyAccessChange() {
    if (!accessChange) return;
    setAccessBusy(true);
    setAccessError(null);
    try {
      await apiFetch(`${base}/${accessChange.member.id}/access/${accessChange.revoke ? "revoke" : "restore"}`, { method: "POST", body: JSON.stringify({}) });
      const list = await apiFetch<SalonStaffDto[]>(base);
      setStaff(list);
      setNotice(accessChange.revoke ? `${accessChange.member.displayName} can no longer sign in to this shop.` : `${accessChange.member.displayName} can sign in again. They stay off duty until they clock in.`);
      setAccessChange(null);
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : "Could not change access.");
    } finally {
      setAccessBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<SalonStaffDto[]>(base)
      .then((list) => {
        if (!cancelled) setStaff(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load staff.");
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  // A change confirmed through the Assistant reloads the list from the server.
  useAssistantRefresh("staff", () => {
    apiFetch<SalonStaffDto[]>(base).then(setStaff).catch(() => undefined);
  });

  // Issue #378: the staff member whose permanent-delete dialog is open.
  const [deleting, setDeleting] = useState<SalonStaffDto | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setInviteUrl(null);
    const parsed = createSalonStaffSchema.safeParse({
      displayName: displayName.trim(),
      phone: phone.replace(/[\s()-]/g, "") || undefined,
      email: email.trim() || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the staff details.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await apiFetch<StaffInviteResultDto>(base, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setStaff((prev) => [...(prev ?? []), result.staff]);
      setInviteUrl(result.inviteUrl ?? null);
      setNotice(
        result.invitationSent && result.staff.email
          ? `Staff member added. Invitation sent to ${result.staff.email}.`
          : "Staff member added without a login invitation.",
      );
      setDisplayName("");
      setPhone("");
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that staff member.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resendInvite(member: SalonStaffDto) {
    setError(null);
    setNotice(null);
    setInviteUrl(null);
    try {
      const result = await apiFetch<StaffInviteResultDto>(
        `${base}/${member.id}/${DASHBOARD_PATHS.resendInvite}`,
        { method: "POST" },
      );
      setInviteUrl(result.inviteUrl ?? null);
      setNotice(`New invitation sent to ${member.email ?? "their email"}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resend that invitation.");
    }
  }

  async function toggleActive(member: SalonStaffDto) {
    setError(null);
    setNotice(null);
    const next =
      member.status === StaffMemberStatus.ACTIVE
        ? StaffMemberStatus.INACTIVE
        : StaffMemberStatus.ACTIVE;
    try {
      const updated = await apiFetch<SalonStaffDto>(`${base}/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      setStaff((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update that staff member.");
    }
  }

  return (
    <RequireRole roles={[Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER]} redirectTo="/dashboard/salons">
    <main className={styles.page}>
      <h1 className={styles.pageTitle}>Staff</h1>
      <p className={styles.pageSubtitle}>
        Only the staff member&apos;s name is required. Mobile number and email are optional.
        If an email is provided, FastQue sends the password setup invitation for independent login.
        Staff without contact details can still be used for assignments and queue capacity.
      </p>
      <SetupNavigation salonId={salonId} currentStep="staff" section="steps" />

      {error && <p className={`${styles.banner} ${styles.bannerError}`}>{error}</p>}
      {notice && <p className={`${styles.banner} ${styles.bannerNotice}`} role="status">{notice}</p>}

      {inviteUrl && (
        <div className={`${styles.banner} ${styles.bannerWarning}`}>
          <strong style={{ fontSize: 14 }}>Invitation link</strong>
          <p style={{ fontSize: 13, margin: "4px 0 8px" }}>
            No email provider is connected yet, so send this to the staff member yourself. It expires in
            7 days and can only be used once.
          </p>
          <code style={{ fontSize: 12, wordBreak: "break-all" }}>{inviteUrl}</code>
        </div>
      )}

      <form onSubmit={handleCreate} className={styles.form}>
        <div style={{ flex: "1 1 180px" }} className={styles.fieldWrap}>
          <label className={styles.fieldLabel} htmlFor="staff-name">Staff name</label>
          <input
            id="staff-name"
            placeholder="Staff member name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={120}
            autoComplete="off"
            className={styles.input}
          />
        </div>
        <div style={{ flex: "1 1 220px" }} className={styles.fieldWrap}>
          <label className={styles.fieldLabel} htmlFor="staff-phone">Mobile number (optional)</label>
          <input
            id="staff-phone"
            type="tel"
            inputMode="tel"
            placeholder="+91 98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            className={styles.input}
          />
          <p className={styles.hint}>Optional. If entered, use country code, such as +919876543210.</p>
        </div>
        <div style={{ flex: "1 1 220px" }} className={styles.fieldWrap}>
          <label className={styles.fieldLabel} htmlFor="staff-email">Email (optional)</label>
          <input
            id="staff-email"
            type="email"
            inputMode="email"
            placeholder="marcus@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className={styles.input}
          />
        </div>
        <Button type="submit" variant="secondary" fullWidth disabled={submitting}>
          {submitting ? "Adding staff…" : "Add staff"}
        </Button>
      </form>

      {staff === null && !error && <p className={styles.loadingText}>Loading…</p>}
      {staff?.length === 0 && <p className={styles.emptyState}>No staff yet. Add your first staff member above.</p>}
      {staff && staff.length > 0 && (
        <ul className={styles.rowList}>
          {staff.map((m) => (
            <li key={m.id} className={styles.row}>
              <div style={{ minWidth: 0 }}>
                <span className={styles.rowTitle} style={{ opacity: m.status === StaffMemberStatus.ACTIVE ? 1 : 0.55 }}>
                  {m.displayName}
                </span>
                <div className={styles.rowMeta} style={{ wordBreak: "break-word" }}>
                  {m.phone ?? (m.email ? "Mobile not provided" : "No contact details")}
                  {m.email && ` · ${m.email}`}
                  {m.accessRevoked ? " · access removed" : m.status !== StaffMemberStatus.ACTIVE && " · not working"}
                  {m.email && !m.hasPassword && " · hasn't set their password yet"}
                </div>
              </div>
              <div className={styles.rowActions}>
                {m.email && !m.hasPassword && (
                  <Button type="button" variant="outline" onClick={() => void resendInvite(m)}>
                    Resend invitation
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => void toggleActive(m)}>
                  {m.status === StaffMemberStatus.ACTIVE ? "Mark not working" : "Mark working"}
                </Button>
                <Button type="button" variant="outline" onClick={() => { setAccessError(null); setAccessChange({ member: m, revoke: !m.accessRevoked }); }}>
                  {m.accessRevoked ? "Restore access" : "Remove access"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setHoursOpenFor(hoursOpenFor === m.id ? null : m.id)}
                >
                  {hoursOpenFor === m.id ? "Hide hours" : "Set working hours"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setProfileOpenFor(profileOpenFor === m.id ? null : m.id)}
                >
                  {profileOpenFor === m.id ? "Hide profile" : "Edit profile"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVerificationOpenFor(verificationOpenFor === m.id ? null : m.id)}
                >
                  {verificationOpenFor === m.id ? "Hide verification" : "Verification"}
                </Button>
                {mayDelete && (
                  <OwnerBtn variant="danger" small onClick={() => setDeleting(m)} aria-label={`Delete ${m.displayName} permanently`}>
                    Delete permanently
                  </OwnerBtn>
                )}
              </div>
              {hoursOpenFor === m.id && <StaffHoursEditor salonId={salonId} staffId={m.id} />}
              {profileOpenFor === m.id && (
                <StaffProfileEditor
                  salonId={salonId}
                  member={m}
                  onPhotoSaved={(photoUrl) => {
                    setStaff((prev) => prev?.map((staff) => staff.id === m.id ? { ...staff, photoUrl } : staff) ?? prev);
                  }}
                  onSaved={(updated) => {
                    setStaff((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
                    setProfileOpenFor(null);
                  }}
                />
              )}
              {verificationOpenFor === m.id && <StaffVerificationPanel salonId={salonId} staffId={m.id} />}
            </li>
          ))}
        </ul>
      )}
      {accessChange && (
        <OwnerDialog title={accessChange.revoke ? `Remove ${accessChange.member.displayName}'s access?` : `Restore ${accessChange.member.displayName}'s access?`} onClose={() => setAccessChange(null)}>
          {accessError && <OwnerBanner tone="error">{accessError}</OwnerBanner>}
          <p>
            {accessChange.revoke
              ? "They will be signed out of this shop's dashboard straight away and taken off duty. Their past services and records are kept. You can restore access at any time."
              : "They will be able to sign in to this shop again with their existing account. They stay off duty until they clock in."}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <OwnerBtn variant="quiet" onClick={() => setAccessChange(null)}>Cancel</OwnerBtn>
            <OwnerBtn variant={accessChange.revoke ? "danger" : "primary"} disabled={accessBusy} onClick={() => void applyAccessChange()}>
              {accessBusy ? "Saving…" : accessChange.revoke ? "Remove access" : "Restore access"}
            </OwnerBtn>
          </div>
        </OwnerDialog>
      )}
      <SetupNavigation salonId={salonId} currentStep="staff" section="actions" />
      {deleting && (
        <PermanentDeleteDialog
          kind="staff"
          salonId={salonId}
          targetId={deleting.id}
          onClose={() => setDeleting(null)}
          onDeleted={(result) => {
            setDeleting(null);
            setStaff((current) => (current ?? []).filter((member) => member.id !== result.deletedId));
            setNotice(result.message);
          }}
        />
      )}
    </main>
    </RequireRole>
  );
}
