"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AUTH_PATHS,
  LANGUAGE_LABELS,
  Language,
  NOTIFICATION_PATHS,
  Role,
} from "@barbercue/shared";
import type { AuthSession, MeResponse, NotificationPreferencesDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth-context";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { CustomerPhoneLinkPanel } from "../../../../components/auth/CustomerPhoneLinkPanel";
import { LocationSettings, PrivacySettings } from "../../../../components/customer-dashboard/SettingsExtras";
import styles from "./profile.module.css";

const ROLE_LABELS: Record<string, string> = {
  [Role.CUSTOMER]: "Customer",
  [Role.SALON_STAFF]: "Salon Staff",
  [Role.SALON_OWNER]: "Salon Owner",
  [Role.PLATFORM_ADMIN]: "Platform Admin",
};

const CATEGORY_LABEL: Record<string, { title: string; description: string }> = {
  BOOKING_UPDATES: { title: "Booking updates", description: "Confirmations and cancellations." },
  QUEUE_UPDATES: { title: "Queue updates", description: "Turn-approaching and wait-time alerts." },
  REMINDERS: { title: "Appointment reminders", description: "A heads-up before your appointment." },
  PROMOTIONAL: { title: "Offers & promotions", description: "Deals from shops you've visited." },
};

export default function ProfilePage() {
  const { user, logout, refreshMe } = useAuth();
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferencesDto | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingLanguage, setSavingLanguage] = useState(false);

  async function changeLanguage(language: Language) {
    if (language === user?.preferredLanguage || savingLanguage) return;
    setSavingLanguage(true);
    try {
      await apiFetch<MeResponse>(`auth/${AUTH_PATHS.language}`, {
        method: "PATCH",
        body: JSON.stringify({ language }),
      });
      await refreshMe();
    } catch {
      /* the buttons below just keep reflecting whatever preferredLanguage actually saved */
    } finally {
      setSavingLanguage(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<NotificationPreferencesDto>(`${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.preferences}`)
      .then((result) => {
        if (!cancelled) setPreferences(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePreference(category: string, channel: string, nextEnabled: boolean) {
    setSavingKey(`${category}:${channel}`);
    try {
      const result = await apiFetch<NotificationPreferencesDto>(
        `${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.preferences}`,
        { method: "PUT", body: JSON.stringify({ category, channel, enabled: nextEnabled }) },
      );
      setPreferences(result);
    } catch {
      /* leave the previous state in place */
    } finally {
      setSavingKey(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuthSession[]>(`auth/${AUTH_PATHS.sessions}`)
      .then((result) => {
        if (!cancelled) setSessions(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load your sessions.");
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function revokeSession(id: string) {
    setRevokingId(id);
    setError(null);
    try {
      await apiFetch(`auth/${AUTH_PATHS.sessions}/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign out that session.");
    } finally {
      setRevokingId(null);
    }
  }

  async function revokeOtherSessions() {
    const others = sessions.filter((s) => !s.current);
    if (others.length === 0) return;
    setRevokingOthers(true);
    setError(null);
    try {
      await Promise.all(others.map((s) => apiFetch(`auth/${AUTH_PATHS.sessions}/${s.id}`, { method: "DELETE" })));
      setSessions((prev) => prev.filter((s) => s.current));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign out other sessions.");
    } finally {
      setRevokingOthers(false);
    }
  }

  const otherSessionCount = sessions.filter((s) => !s.current).length;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>PROFILE & SECURITY</p>
        <h1 className={styles.pageTitle}>Your account, kept simple.</h1>
        <p className={styles.pageSubtitle}>
          Review the contact details connected to FastQue and manage where your account is signed in.
        </p>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Account details</h2>
          <p>These details come from your current authenticated FastQue account.</p>
        </div>
        <Card className={styles.profileCard}>
          <dl>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldLabel}>Email</dt>
              <dd className={styles.fieldValue}>{user?.email ?? "Not set"}</dd>
            </div>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldLabel}>Phone</dt>
              <dd className={styles.fieldValue}>{user?.phone ?? "Not set"}</dd>
            </div>
            <div className={styles.fieldRow}>
              <dt className={styles.fieldLabel}>Account type</dt>
              <dd className={styles.fieldValue}>
                {user?.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ") ?? "—"}
              </dd>
            </div>
            {/* The password itself is hashed and can never be shown — only whether one exists. */}
            <div className={styles.fieldRow}>
              <dt className={styles.fieldLabel}>Sign-in method</dt>
              <dd className={styles.fieldValue}>
                {[
                  user?.passwordConfigured ? "Email & password" : null,
                  user?.phone ? "Mobile OTP" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Google / Apple sign-in"}
                {user?.passwordConfigured && (
                  <>
                    {" "}
                    <Link href="/forgot-password">Reset password</Link>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </section>

      {user?.audience === "CUSTOMER" && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Mobile sign-in</h2>
            <p>Verify a mobile number while signed in to your existing account.</p>
          </div>
          <Card className={styles.securityCard}>
            <CustomerPhoneLinkPanel />
          </Card>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Language</h2>
          <p>Controls voice announcements on the owner/staff dashboard, and this account&apos;s language going forward.</p>
        </div>
        <Card className={styles.securityCard}>
          <div className={styles.fieldRow}>
            <dt className={styles.fieldLabel}>Spoken / display language</dt>
            <dd className={styles.fieldValue} style={{ display: "flex", gap: 8 }}>
              {Object.values(Language).map((lang) => (
                <Button
                  key={lang}
                  type="button"
                  variant={user?.preferredLanguage === lang ? "primary" : "outline"}
                  onClick={() => void changeLanguage(lang)}
                  disabled={savingLanguage}
                >
                  {LANGUAGE_LABELS[lang]}
                </Button>
              ))}
            </dd>
          </div>
        </Card>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Signed-in devices</h2>
          <p>Review active sessions and sign out devices you no longer recognise or use.</p>
        </div>
        <Card className={styles.securityCard}>
          {sessionsLoading && (
            <div className={styles.sessionLoading} role="status">
              <span aria-hidden="true" />
              <p>Loading your signed-in devices…</p>
            </div>
          )}
          {!sessionsLoading &&
            sessions.map((session) => (
              <div key={session.id} className={styles.sessionRow}>
                <div>
                  <div className={styles.sessionDevice}>
                    {session.deviceInfo ?? "Unknown device"}
                    {session.current && <span className={styles.currentBadge}>This device</span>}
                  </div>
                  <div className={styles.sessionMeta}>
                    Signed in {new Date(session.createdAt).toLocaleString()}
                  </div>
                </div>
                {!session.current && (
                  <button
                    type="button"
                    className={styles.revokeButton}
                    onClick={() => void revokeSession(session.id)}
                    disabled={revokingId === session.id || revokingOthers}
                  >
                    {revokingId === session.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </div>
            ))}
          {!sessionsLoading && sessions.length === 0 && !error && (
            <p className={styles.noteText}>No active sessions were returned for this account.</p>
          )}
          {error && <p className={styles.errorText} role="alert">{error}</p>}
          <div className={styles.actions}>
            {otherSessionCount > 0 && (
              <Button variant="outline" onClick={() => void revokeOtherSessions()} disabled={revokingOthers}>
                {revokingOthers ? "Signing out…" : `Sign out of ${otherSessionCount} other session${otherSessionCount === 1 ? "" : "s"}`}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void logout()}>
              Log out of this device
            </Button>
          </div>
        </Card>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Notification preferences</h2>
          <p>
            Choose what you hear from FastQue. In-app is the only channel available today — SMS,
            email and WhatsApp aren&apos;t connected yet.
          </p>
        </div>
        <Card className={styles.securityCard}>
          {preferences === null ? (
            <p className={styles.noteText}>Loading…</p>
          ) : (
            preferences.categories.map((cat) => {
              const inApp = cat.channels.find((c) => c.channel === "IN_APP");
              if (!inApp) return null;
              const key = `${cat.category}:IN_APP`;
              return (
                <div key={cat.category} className={styles.fieldRow}>
                  <div>
                    <dt className={styles.fieldLabel}>{CATEGORY_LABEL[cat.category]?.title ?? cat.category}</dt>
                    <p className={styles.sessionMeta}>{CATEGORY_LABEL[cat.category]?.description}</p>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={inApp.enabled}
                      disabled={savingKey === key}
                      onChange={(e) => void togglePreference(cat.category, "IN_APP", e.target.checked)}
                      style={{ width: 18, height: 18 }}
                    />
                  </label>
                </div>
              );
            })
          )}
        </Card>
      </section>
      <LocationSettings />
      <PrivacySettings />
    </div>
  );
}
