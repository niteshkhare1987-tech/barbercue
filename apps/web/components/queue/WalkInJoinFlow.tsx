"use client";

import { useEffect, useState } from "react";
import {
  MAX_WALK_IN_SERVICES,
  QUEUE_ENTRIES_PATH,
  SALON_QUEUE_PATHS,
  type QueueEntryDetailDto,
  type ServiceDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { newIdempotencyKey } from "../../lib/idempotency";
import { useAuth } from "../../lib/auth-context";
import { Button } from "../ui/Button";
import { ServiceStep } from "../booking/ServiceStep";
import { QueueStatusPanel } from "./QueueStatusPanel";
import { QueueContactFields, resolveContactInput } from "./QueueContactFields";
import styles from "./queue.module.css";

// Issue #13 Mission E: service selection is visible and usable with no login wall at all — only
// the actual "Join the queue" action requires a signed-in customer, matching the desired journey
// (find shop -> select -> confirm -> THEN sign in). Google Identity Services renders as an
// in-page button/overlay, never a full-page redirect, so `selectedServiceIds` below is never lost
// across sign-in — the exact same pattern PublicQueueJoinFlow (the QR entry point) already proved
// out for this queue engine.
export function WalkInJoinFlow({ salonId, services, currency = null, countryCode }: {
  salonId: string;
  services: ServiceDto[];
  currency?: string | null;
  countryCode?: string | null;
}) {
  const { status: authStatus, user } = useAuth();
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState(user?.phone ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [guestAccessToken, setGuestAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState<QueueEntryDetailDto | null>(null);

  // A customer can only hold one active token anywhere (assertNotAlreadyInQueue) — only checkable
  // once actually signed in, so this waits for authStatus rather than firing unconditionally on
  // mount (which would 401 for the now-common case of an unauthenticated first visit).
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    let cancelled = false;
    apiFetch<QueueEntryDetailDto | null>(`${QUEUE_ENTRIES_PATH}/mine/active`)
      .then((active) => {
        if (!cancelled) setEntry(active);
      })
      .catch(() => {
        /* no active entry, or a transient error — the join button remains available */
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  // Restore only this browser session's unguessable ticket, never an account identity.
  useEffect(() => {
    if (authStatus === "loading" || authStatus === "authenticated") return;
    const key = `fastque:guest-queue:${salonId}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return;
    try {
      const data = JSON.parse(saved) as { id: string; token: string };
      if (!data.id || !data.token) return;
      apiFetch<QueueEntryDetailDto>(`${QUEUE_ENTRIES_PATH}/${data.id}/guest-status`, {
        headers: { "X-Queue-Guest-Token": data.token },
      }).then((row) => {
        if (row.salonId === salonId && ["WAITING", "CALLED", "IN_SERVICE"].includes(row.status)) {
          setGuestAccessToken(data.token);
          setEntry(row);
        } else {
          sessionStorage.removeItem(key);
        }
      }).catch(() => sessionStorage.removeItem(key));
    } catch { sessionStorage.removeItem(key); }
  }, [salonId, authStatus]);

  // Prefill from the account once it loads, without clobbering anything the customer typed.
  useEffect(() => {
    if (user?.phone) setContactPhone((current) => current || (user.phone as string));
  }, [user?.phone]);

  async function handleJoin() {
    const resolved = resolveContactInput(contactName, contactPhone);
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    if (!selectedServiceIds.length) {
      setError("Please select at least one service before joining.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const guestMode = authStatus !== "authenticated";
      const created = await apiFetch<QueueEntryDetailDto & { guestAccessToken?: string }>(
        guestMode ? `salons/${salonId}/queue/guest-join` : `salons/${salonId}/queue/${SALON_QUEUE_PATHS.join}`, {
        method: "POST",
        headers: { "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({
          serviceIds: selectedServiceIds,
          ...resolved.contact,
        }),
      });
      if (created.guestAccessToken) {
        setGuestAccessToken(created.guestAccessToken);
        sessionStorage.setItem(`fastque:guest-queue:${salonId}`,
          JSON.stringify({ id: created.id, token: created.guestAccessToken }));
      }
      setEntry(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not join the queue. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (authStatus === "loading") return <p className={styles.stepLoading}>Loading…</p>;

  if (entry && entry.salonId !== salonId) {
    return (
      <div>
        <p className={styles.stepLoading}>
          You already have an active Live Queue token at another salon. You can cancel it here
          before joining this salon.
        </p>
        <QueueStatusPanel entry={entry} guestAccessToken={guestAccessToken} onEntryChange={setEntry} />
      </div>
    );
  }

  if (entry) {
    return <QueueStatusPanel entry={entry} guestAccessToken={guestAccessToken} onEntryChange={setEntry} />;
  }

  return (
    <div className={styles.joinCard}>
      <ServiceStep
        services={services}
        selectedServiceIds={selectedServiceIds}
        onToggle={(id) => setSelectedServiceIds((current) =>
          current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
        )}
        currency={currency}
        countryCode={countryCode}
        showStepNumber={false}
        maxServices={MAX_WALK_IN_SERVICES}
        disabled={submitting}
      />

      {(
        <QueueContactFields
          idPrefix="walkin"
          name={contactName}
          phone={contactPhone}
          onNameChange={setContactName}
          onPhoneChange={setContactPhone}
        />
      )}

      {error && <p className={styles.errorText}>{error}</p>}

      <div className={styles.joinActions}>
        <Button type="button" variant="primary" onClick={() => void handleJoin()} disabled={submitting || selectedServiceIds.length === 0}>
          {submitting ? "Joining…" : "Join Live Queue"}
        </Button>
        <p className={styles.reassure}>No Gmail login needed. The contact number is not verified.</p>
      </div>
      <p className={styles.reassure}>We&apos;ll keep your place — no need to stay by the counter.</p>
    </div>
  );
}
