"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DASHBOARD_PATHS, StaffMemberStatus, shopCancelBookingSchema } from "@barbercue/shared";
import type { StaffAppointmentDto, StaffWorkDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { newIdempotencyKey } from "../../lib/idempotency";
import { getRealtimeSocket, joinSalonRoom, onReconnect } from "../../lib/realtime";
import { formatShopTime } from "./format";
import { NewQueueCustomerDialog } from "./NewQueueCustomerDialog";
import { ServiceUsageDialog } from "./inventory/ServiceUsageDialog";
import { Badge, Banner, Btn, BtnLink, Card, Dialog, EmptyState, Field, Kpi, PageHead, Skeleton } from "./parts";
import ui from "./owner.module.css";

const POLL_MS = 30_000;

const AVAILABILITY: Record<StaffWorkDto["availabilityState"], { label: string; tone: "ok" | "warn" | "neutral" | "info" }> = {
  AVAILABLE: { label: "Available", tone: "ok" },
  IN_SERVICE: { label: "With a customer", tone: "warn" },
  RESERVED: { label: "Booked soon", tone: "info" },
  OFF_DUTY: { label: "Off duty", tone: "neutral" },
};

/**
 * A barber's own day. Everything on this page comes from ONE server read model scoped to the
 * signed-in barber: they see the service they are performing (and only they get "Complete
 * Service" for it), who is waiting and which of those customers they may take, and their own
 * appointments. There is nothing here about payments, subscriptions, billing or shop settings -
 * those are owner-only and the server would refuse them anyway.
 */
export function StaffHome({ salonId }: { salonId: string }) {
  const base = `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/${salonId}`;
  const [work, setWork] = useState<StaffWorkDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);
  // Inventory Phase 2: products used, chosen by photo, before the service is completed.
  const [usageFor, setUsageFor] = useState<{ queueEntryId: string; sessionId: string } | null>(null);
  const [cancelFor, setCancelFor] = useState<StaffAppointmentDto | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    apiFetch<StaffWorkDto>(`${base}/staff/me/work`)
      .then((w) => {
        setWork((prev) => (prev && w.revision < prev.revision ? prev : w));
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your day."));
  }, [base]);

  useEffect(() => {
    load();
    const poll = window.setInterval(load, POLL_MS);
    const socket = getRealtimeSocket();
    joinSalonRoom(salonId);
    const handler = (payload: { salonId?: string }) => {
      if (payload?.salonId && payload.salonId !== salonId) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 300);
    };
    const events = ["queue.updated", "booking.created", "booking.cancelled", "booking.rescheduled", "staff.status.changed"];
    events.forEach((e) => socket.on(e, handler));
    const off = onReconnect(load);
    return () => {
      window.clearInterval(poll);
      if (timer.current) window.clearTimeout(timer.current);
      events.forEach((e) => socket.off(e, handler));
      off();
    };
  }, [salonId, load]);

  async function act<T>(key: string, fn: () => Promise<T>, success?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!work) {
    return (
      <>
        <PageHead title="My day" />
        {error ? <Banner tone="error">{error}</Banner> : <Skeleton height={120} />}
      </>
    );
  }

  const onDuty = work.status === StaffMemberStatus.ACTIVE;
  // A barber who has been given a customer (not started) is spoken for: say that, not "Booked soon".
  const a = work.assigned && !work.current ? { label: "Customer assigned", tone: "info" as const } : AVAILABILITY[work.availabilityState];
  const current = work.current;
  // A customer the shop (or the automatic allocator) assigned to this barber: not started yet.
  const assignedToMe = current ? null : (work.assigned ?? null);
  const eligible = work.waiting.filter((w) => w.eligible);

  return (
    <>
      <PageHead
        eyebrow={work.salonName}
        title={`My day · ${work.displayName}`}
        sub="Your customer, the Live Queue and your appointments."
        actions={
          <>
            <Btn
              variant={onDuty ? "secondary" : "primary"}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "duty",
                  () =>
                    apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.staff}/${work.staffId}/${DASHBOARD_PATHS.status}`, {
                      method: "PATCH",
                      body: JSON.stringify({ status: onDuty ? StaffMemberStatus.INACTIVE : StaffMemberStatus.ACTIVE }),
                    }),
                  onDuty ? "You are off duty." : "You are on duty.",
                )
              }
            >
              {onDuty ? "Clock out" : "Clock in"}
            </Btn>
            <Btn variant="secondary" icon="plus" onClick={() => setAddOpen(true)}>
              New Live Queue customer
            </Btn>
          </>
        }
      />
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <div className={`${ui.grid} ${ui.kpiGrid}`} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <Kpi label="My status" value={<Badge tone={a.tone}>{a.label}</Badge>} icon="user" tone={a.tone === "ok" ? "ok" : "info"} />
        <Kpi label="Done today" value={work.completedToday} icon="check" tone="ok" />
        <Kpi label="Waiting for a barber" value={work.waiting.filter((w) => w.status === "WAITING").length} icon="queue" tone="warn" />
        <Kpi label="My appointments today" value={work.appointmentsToday.length} icon="calendar" tone="info" />
      </div>

      <div className={`${ui.grid} ${ui.twoCol} ${ui.mt16}`}>
        <div className={ui.sideStack}>
          <Card title={current ? "Current service" : assignedToMe ? "Assigned to you" : "Current service"}>
            {current ? (
              <div className={`${ui.entry} ${ui.entryInService}`}>
                <div className={ui.entryHead}>
                  <div className={ui.token}>#{current.tokenNumber}</div>
                  <div className={ui.entryWho}>
                    <div className={ui.entryName}>{current.customerLabel}</div>
                    <div className={ui.entryMeta}>
                      {current.serviceName ?? "Service"}
                      {current.chairLabel ? ` · ${current.chairLabel}` : ""}
                      {current.startedAt ? ` · started ${formatShopTime(current.startedAt, null)}` : ""}
                    </div>
                    {current.customerPhone && (
                      <a className={`${ui.entryMeta} ${ui.entryPhone}`} href={`tel:${current.customerPhone}`}>
                        {current.customerPhone}
                      </a>
                    )}
                  </div>
                  <Badge tone="ok">In service</Badge>
                </div>
                <div className={ui.entryActions}>
                  <Btn variant="primary" icon="check" disabled={busy !== null} onClick={() => setConfirmComplete(true)}>
                    Complete Service
                  </Btn>
                </div>
              </div>
            ) : assignedToMe ? (
              <div className={`${ui.entry} ${ui.entryAssigned}`}>
                <div className={ui.entryHead}>
                  <div className={ui.token}>#{assignedToMe.tokenNumber}</div>
                  <div className={ui.entryWho}>
                    <div className={ui.entryName}>{assignedToMe.customerLabel}</div>
                    <div className={ui.entryMeta}>
                      {assignedToMe.serviceName ?? "Service"}
                      {assignedToMe.chairLabel ? ` · ${assignedToMe.chairLabel}` : ""}
                    </div>
                    {assignedToMe.customerPhone && (
                      <a className={`${ui.entryMeta} ${ui.entryPhone}`} href={`tel:${assignedToMe.customerPhone}`}>
                        {assignedToMe.customerPhone}
                      </a>
                    )}
                  </div>
                  <Badge tone="info">Assigned · not started</Badge>
                </div>
                <div className={ui.entryReason}>The service has not started. Press Start service when the customer is in your chair.</div>
                <div className={ui.entryActions}>
                  <Btn
                    variant="primary"
                    icon="scissors"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "start",
                        () => apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.queueEntries}/${assignedToMe.queueEntryId}/${DASHBOARD_PATHS.startService}`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() } }),
                        `${assignedToMe.customerLabel} — service started.`,
                      )
                    }
                  >
                    {busy === "start" ? "Starting…" : "Start service"}
                  </Btn>
                </div>
              </div>
            ) : (
              <EmptyState
                title={onDuty ? "You are free" : "You are off duty"}
                action={
                  onDuty ? (
                    <Btn
                      variant="primary"
                      disabled={busy !== null || eligible.length === 0}
                      onClick={() => void act("next", () => apiFetch(`${base}/queue/take-next`, { method: "POST" }), "Customer assigned to you. Press Start service when they are in your chair.")}
                    >
                      {eligible.length === 0 ? "No one to take yet" : `Take next customer (${eligible.length} can be served by you)`}
                    </Btn>
                  ) : undefined
                }
              >
                {onDuty ? "Take the next waiting customer when you are ready." : "Clock in to start taking customers."}
              </EmptyState>
            )}
          </Card>

          <Card title="Waiting in the Live Queue" sub="Shop-wide, in order">
            {work.waiting.length === 0 ? (
              <EmptyState title="Nobody is waiting" />
            ) : (
              <ul className={ui.list}>
                {work.waiting.map((w) => (
                  <li key={w.queueEntryId} className={ui.listRow}>
                    <span className={ui.timeChip}>#{w.tokenNumber}</span>
                    <div className={ui.listMain}>
                      <div className={ui.listTitle}>{w.customerLabel}</div>
                      <div className={ui.listSub}>
                        {w.serviceName ?? "Service not chosen"}
                        {w.status === "WAITING" ? ` · position ${w.position}` : " · called to the counter"}
                      </div>
                    </div>
                    {w.eligible ? <Badge tone="ok">You can take</Badge> : <Badge tone="neutral">Another barber</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title="My appointments today">
          {work.appointmentsToday.length === 0 ? (
            <EmptyState title="No appointments assigned to you today" />
          ) : (
            <ul className={ui.list}>
              {work.appointmentsToday.map((ap) => (
                <li key={ap.bookingId} className={ui.listRow} style={{ alignItems: "flex-start" }}>
                  <span className={ui.timeChip}>{formatShopTime(ap.slotStart, null)}</span>
                  <div className={ui.listMain}>
                    <div className={ui.listTitle}>{ap.serviceNames.join(" + ")}</div>
                    <div className={ui.listSub}>
                      {ap.customerLabel}
                      {ap.source === "IN_SHOP" ? " · in-shop appointment" : ""}
                    </div>
                    {ap.customerPhone && (
                      <a className={ui.listSub} href={`tel:${ap.customerPhone}`}>
                        {ap.customerPhone}
                      </a>
                    )}
                    {ap.status === "CONFIRMED" && (
                      <div className={ui.rowWrap} style={{ marginTop: 8 }}>
                        <Btn
                          small
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(`arrive-${ap.bookingId}`, () => apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.bookings}/${ap.bookingId}/${DASHBOARD_PATHS.arrive}`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() } }), "Marked as arrived — they are in the Live Queue.")
                          }
                        >
                          Mark arrived
                        </Btn>
                        <Btn small variant="danger" disabled={busy !== null} onClick={() => setCancelFor(ap)}>
                          Cancel appointment
                        </Btn>
                      </div>
                    )}
                  </div>
                  <Badge tone={ap.status === "COMPLETED" ? "ok" : "info"}>{ap.status === "COMPLETED" ? "Done" : "Upcoming"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className={`${ui.rowWrap} ${ui.mt16}`}>
        <BtnLink href={`/dashboard/salons/${salonId}/queue`} icon="queue">
          Open full Live Queue
        </BtnLink>
        <BtnLink href={`/dashboard/salons/${salonId}/notifications`} icon="bell">
          Notifications
        </BtnLink>
      </div>

      {confirmComplete && current?.serviceSessionId && (
        <Dialog title="Complete this service?" onClose={() => setConfirmComplete(false)}>
          <p>
            Mark <strong>{current.customerLabel}</strong> (#{current.tokenNumber}, {current.serviceName ?? "service"}) as finished. This frees your chair and moves the next customer up.
          </p>
          <div className={ui.dialogActions}>
            <Btn variant="quiet" onClick={() => setConfirmComplete(false)}>
              Not yet
            </Btn>
            <Btn
              variant="primary"
              icon="check"
              disabled={busy !== null}
              onClick={() => {
                setConfirmComplete(false);
                setUsageFor({ queueEntryId: current.queueEntryId, sessionId: current.serviceSessionId! });
              }}
            >
              Complete Service
            </Btn>
          </div>
        </Dialog>
      )}

      {usageFor && (
        <ServiceUsageDialog
          queueEntryId={usageFor.queueEntryId}
          mode="complete"
          onClose={() => setUsageFor(null)}
          onComplete={() => act("complete", () => apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.serviceSessions}/${usageFor.sessionId}/${DASHBOARD_PATHS.complete}`, { method: "POST" }), "Service completed.")}
        />
      )}

      {cancelFor && (
        <CancelAppointmentDialog
          salonId={salonId}
          bookingId={cancelFor.bookingId}
          label={`${cancelFor.serviceNames.join(" + ")} · ${formatShopTime(cancelFor.slotStart, null)}`}
          onClose={() => setCancelFor(null)}
          onDone={(msg) => {
            setNotice(msg);
            load();
          }}
        />
      )}
      {addOpen && (
        <NewQueueCustomerDialog
          salonId={salonId}
          onClose={() => setAddOpen(false)}
          onCreated={(e) => {
            setNotice(`Added ${e.customerName ?? "customer"} as queue #${e.tokenNumber}.`);
            load();
          }}
        />
      )}
    </>
  );
}

/** Cancels an appointment on behalf of the shop and says exactly who was (and was not) notified. */
export function CancelAppointmentDialog({
  salonId,
  bookingId,
  label,
  onClose,
  onDone,
}: {
  salonId: string;
  bookingId: string;
  label: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = shopCancelBookingSchema.safeParse({ reason });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the reason.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ notification: { inApp: string; push: string } }>(
        `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/${salonId}/bookings/${bookingId}/cancel`,
        { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() }, body: JSON.stringify(parsed.data) },
      );
      const n = result.notification;
      onDone(
        n.inApp === "NO_ACCOUNT"
          ? "Appointment cancelled. This guest has no FastQue account, so no notification was sent."
          : n.inApp === "SENT"
            ? `Appointment cancelled and the customer was notified in the app${n.push === "SENT" ? " and by push notification" : n.push === "FAILED" ? " (the push notification will be retried)" : ""}.`
            : "Appointment cancelled. The customer notification could not be confirmed.",
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel the appointment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Cancel this appointment?" onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          {label}. The customer is told right away that <strong>the shop</strong> cancelled it, and is <strong>not charged</strong>.
        </p>
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Reason (shown to the customer, optional)" htmlFor="cancel-reason">
          <textarea id="cancel-reason" className={ui.textarea} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. The barber is unwell" />
        </Field>
        <div className={ui.dialogActions}>
          <Btn variant="quiet" onClick={onClose}>
            Keep appointment
          </Btn>
          <Btn variant="danger" type="submit" disabled={busy}>
            {busy ? "Cancelling…" : "Cancel appointment"}
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}
