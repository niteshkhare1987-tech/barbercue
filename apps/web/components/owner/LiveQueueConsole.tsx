"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DASHBOARD_PATHS, StaffMemberStatus, queuePhaseOf } from "@barbercue/shared";
import type { QueueEntryPhase } from "@barbercue/shared";
import type {
  AutoAssignResultDto,
  ChairOptionDto,
  DashboardQueueDto,
  QueueEntryDetailDto,
  StaffStatusDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { newIdempotencyKey } from "../../lib/idempotency";
import { getRealtimeSocket, joinSalonRoom, onReconnect } from "../../lib/realtime";
import { useAuth } from "../../lib/auth-context";
import { ownerVoiceAnnouncements, setVoiceEnabled, speakOwnerVoice, useVoiceEnabled } from "../../lib/voice-preference";
import { formatShopTime } from "./format";
import { InvoiceAction } from "./InvoiceActions";
import { NewQueueCustomerDialog } from "./NewQueueCustomerDialog";
import { ServiceUsageDialog } from "./inventory/ServiceUsageDialog";
import { useOwnerShell } from "./OwnerShell";
import { Badge, Banner, Btn, BtnLink, Card, Dialog, EmptyState, Field, PageHead, Skeleton, Tabs } from "./parts";
import ui from "./owner.module.css";

type View = "waiting" | "in-service" | "completed" | "no-show" | "history";
const VIEWS: ReadonlyArray<View> = ["waiting", "in-service", "completed", "no-show", "history"];
const FALLBACK_POLL_MS = 15_000;
const LIVE_POLL_MS = 60_000;

// Keyed by PHASE, not raw status: "Assigned" (a barber and chair are reserved) is a CALLED entry that
// holds a barber, and it must never read as waiting for a barber or as already in service.
const PHASE_LABEL: Record<QueueEntryPhase, { text: string; tone: "ok" | "warn" | "bad" | "info" | "neutral" }> = {
  WAITING: { text: "Waiting", tone: "warn" },
  CALLED: { text: "Called to the counter", tone: "info" },
  ASSIGNED: { text: "Ready to start · legacy reservation", tone: "info" },
  IN_SERVICE: { text: "In service", tone: "ok" },
  COMPLETED: { text: "Completed", tone: "ok" },
  CANCELLED: { text: "Cancelled", tone: "neutral" },
  EXPIRED: { text: "Expired", tone: "neutral" },
  NO_SHOW: { text: "NO SHOW", tone: "bad" },
};

function availabilityText(member: StaffStatusDto, assignedTo?: QueueEntryDetailDto): { text: string; dot: string } {
  // A barber who has been given a customer (service not started) is spoken for - say so precisely.
  if (assignedTo && member.status === StaffMemberStatus.ACTIVE) {
    return { text: `Reserved for #${assignedTo.tokenNumber} · not started`, dot: ui.dotInfo };
  }
  switch (member.availabilityState) {
    case "AVAILABLE":
      return { text: "Available", dot: ui.dotOk };
    case "IN_SERVICE":
      return { text: "With a customer", dot: ui.dotWarn };
    case "RESERVED":
      return { text: member.busyUntil ? `Booked until ${formatShopTime(member.busyUntil, null)}` : "Booked", dot: ui.dotInfo };
    case "OFF_DUTY":
      return { text: "Off duty", dot: ui.dotOff };
    default:
      return { text: member.status === StaffMemberStatus.ACTIVE ? "On duty" : "Off duty", dot: member.status === StaffMemberStatus.ACTIVE ? ui.dotOk : ui.dotOff };
  }
}

/** A customer's display name. FastQue stores no name for account holders, so an entry without one is
 * shown by its token - never an e-mail or a guess. */
function whoLabel(entry: QueueEntryDetailDto): string {
  return entry.customerName?.trim() || `Customer #${entry.tokenNumber}`;
}

function minutesSince(iso: string | null): number | null {
  return iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000)) : null;
}

export function LiveQueueConsole({ salonId }: { salonId: string }) {
  const base = `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/${salonId}`;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { kind, refreshCounts } = useOwnerShell();
  const voiceEnabled = useVoiceEnabled();
  const [confirmVoiceOff, setConfirmVoiceOff] = useState(false);
  const [arrivalSnoozes, setArrivalSnoozes] = useState<Record<string, number>>({});
  const [arrivalClock, setArrivalClock] = useState(Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setArrivalClock(Date.now()), 20_000);
    return () => window.clearInterval(tick);
  }, []);

  const requested = searchParams.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "waiting";

  const [data, setData] = useState<DashboardQueueDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Inventory Phase 2: "which products did you use?" before a service is completed.
  const [usageFor, setUsageFor] = useState<{ entryId: string; sessionId: string; who: string } | null>(null);
  const [live, setLive] = useState(true);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [skipReasons, setSkipReasons] = useState<Record<string, string>>({});

  const appliedRevision = useRef(0);
  const knownWaiting = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const audio = useRef<AudioContext | null>(null);
  const refetchTimer = useRef<number | null>(null);
  const language = useRef(user?.preferredLanguage);
  const voiceRef = useRef(voiceEnabled);
  // Event handlers read the latest values without re-subscribing the socket listeners.
  useEffect(() => {
    language.current = user?.preferredLanguage;
    voiceRef.current = voiceEnabled;
  }, [user?.preferredLanguage, voiceEnabled]);

  const chime = useCallback(async () => {
    try {
      const Ctx = window.AudioContext;
      const ctx = audio.current ?? new Ctx();
      audio.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      if (ctx.state !== "running") return;
      const now = ctx.currentTime;
      [660, 880].forEach((frequency, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = frequency;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, now + i * 0.13);
        gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.13 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.13);
        osc.stop(now + i * 0.13 + 0.14);
      });
    } catch {
      /* the browser may block audio until the first tap; the chime then plays from the next event */
    }
  }, []);

  const apply = useCallback(
    (snapshot: DashboardQueueDto, announce: boolean) => {
      // A response older than what is already on screen can never overwrite it.
      const revision = snapshot.revision ?? 0;
      if (revision && revision < appliedRevision.current) return;
      appliedRevision.current = Math.max(appliedRevision.current, revision);

      const waiting = (snapshot.sections?.waiting ?? snapshot.entries.filter((e) => e.status === "WAITING")) as QueueEntryDetailDto[];
      const waitingIds = new Set(waiting.map((e) => e.id));
      if (announce && initialized.current) {
        const arrivals = waiting.filter((e) => !knownWaiting.current.has(e.id));
        if (arrivals.length > 0) {
          setFreshIds((cur) => Array.from(new Set([...cur, ...arrivals.map((e) => e.id)])));
          void chime();
          if (voiceRef.current) {
            const latest = arrivals[arrivals.length - 1];
            speakOwnerVoice(ownerVoiceAnnouncements(language.current).newCustomerJoined(latest.tokenNumber, latest.serviceName), language.current);
          }
        }
      }
      knownWaiting.current = waitingIds;
      initialized.current = true;
      setData(snapshot);
      refreshCounts();
    },
    [chime, refreshCounts],
  );

  const refetch = useCallback(
    (announce = true) =>
      apiFetch<DashboardQueueDto>(`${base}/${DASHBOARD_PATHS.queue}`)
        .then((snapshot) => {
          apply(snapshot, announce);
          setError(null);
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Could not refresh the queue. Retrying…")),
    [base, apply],
  );

  useEffect(() => {
    void refetch(false);
  }, [refetch]);

  useEffect(() => {
    const socket = getRealtimeSocket();
    joinSalonRoom(salonId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reflect the socket's current connection state on (re)subscribe
    setLive(socket.connected);
    const onEvent = (payload: { salonId?: string; revision?: number }) => {
      if (payload?.salonId && payload.salonId !== salonId) return;
      // An event stamped with a revision we already show carries nothing new.
      if (payload?.revision && payload.revision <= appliedRevision.current) return;
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => void refetch(true), 150);
    };
    const events = ["queue.updated", "queue.entry.called", "queue.entry.reassigned", "queue.entry.no_show", "queue.entry.expired", "staff.status.changed", "booking.cancelled", "booking.created"];
    events.forEach((e) => socket.on(e, onEvent));
    const onConnect = () => setLive(true);
    const onDisconnect = () => setLive(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    const offReconnect = onReconnect(() => void refetch(true));
    return () => {
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
      events.forEach((e) => socket.off(e, onEvent));
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      offReconnect();
    };
  }, [salonId, refetch]);

  // Polling is the safety net behind the socket: tighter while the socket is down.
  useEffect(() => {
    const timer = window.setInterval(() => void refetch(true), live ? LIVE_POLL_MS : FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, refetch]);

  // Browsers keep audio locked until a gesture; arm it on the first interaction.
  useEffect(() => {
    const arm = () => void chime();
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, [chime]);

  function setView(next: View) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  async function run<T>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (success) setNotice(success);
      await refetch(false);
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const entryPath = (id: string, action: string) => `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.queueEntries}/${id}/${action}`;

  async function assignAutomatically(entry?: QueueEntryDetailDto) {
    setNotice(null);
    if (entry) {
      await run(`auto-${entry.id}`, () => apiFetch(entryPath(entry.id, "auto-assign"), { method: "POST" }), `${whoLabel(entry)} — service started automatically.`);
      return;
    }
    const result = await run("auto-all", () => apiFetch<AutoAssignResultDto>(`${base}/queue/auto-assign`, { method: "POST" }));
    if (result) {
      setSkipReasons(Object.fromEntries(result.skipped.map((s) => [s.entryId, s.reason])));
      setNotice(
        result.assigned.length === 0
          ? "Nobody could start service right now. The reason is shown on each waiting customer."
          : `${result.assigned.length} customer${result.assigned.length === 1 ? " started" : "s started"} service${result.skipped.length ? `; ${result.skipped.length} still waiting` : ""}.`,
      );
    }
  }

  const sections = data?.sections;
  const waiting = sections?.waiting ?? [];
  const called = sections?.called ?? [];
  const assigned = useMemo(
    () => sections?.assigned ?? data?.entries.filter((e) => queuePhaseOf(e) === "ASSIGNED") ?? [],
    [sections?.assigned, data?.entries],
  );
  const assignedByStaff = useMemo(() => new Map(assigned.filter((e) => e.assignedStaffId).map((e) => [e.assignedStaffId as string, e])), [assigned]);
  const inService = sections?.inService ?? [];
  const completed = sections?.completedToday ?? [];
  const noShows = (sections?.historyToday ?? []).filter((e) => e.status === "NO_SHOW");
  const history = (sections?.historyToday ?? []).filter((e) => e.status !== "NO_SHOW");
  const counts = useMemo(
    () => ({ waiting: waiting.length + called.length + assigned.length, inService: inService.length, completed: completed.length, noShow: noShows.length, history: history.length }),
    [waiting.length, called.length, assigned.length, inService.length, completed.length, noShows.length, history.length],
  );

  if (!data) {
    return (
      <>
        <PageHead title="Live Queue" />
        {error ? <Banner tone="error">{error}</Banner> : <Skeleton height={140} />}
      </>
    );
  }

  const dueArrival = [...waiting, ...called].find((entry) =>
    Boolean(entry.arrivalPromptSentAt) && !entry.arrivedAt &&
    (arrivalSnoozes[entry.id] ?? 0) < arrivalClock
  );

  // A chair reserved for an assigned customer is not free for anyone else.
  const freeChairs = data.chairs.filter((c) => (c.occupancy ?? "FREE") === "FREE" && !c.reservedForEntryId);

  return (
    <>
      {dueArrival && (
        <div role="alertdialog" aria-modal="true" aria-label="Live Queue customer arrival check"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", display: "grid",
            placeItems: "center", zIndex: 1300, padding: 20 }}>
          <div style={{ width: "min(95vw,540px)", background: "#fff", color: "#191919", padding: 32, borderRadius: 18 }}>
            <h2>Live Queue · Arrival confirmation</h2>
            <p>Token #{dueArrival.tokenNumber} — {whoLabel(dueArrival)}</p>
            <p>Estimated service time is around 10 minutes away.
              Has the customer physically arrived at your shop?</p>
            <p>Customer replied: {dueArrival.customerArrivalResponse === true ? "Yes (self-reported)" :
              dueArrival.customerArrivalResponse === false ? "Not yet" : "Not answered"}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
              <Btn variant="primary" disabled={busy !== null} onClick={() => {
                if (!window.confirm("Confirm you personally verified this customer is physically in the shop?")) return;
                void run(`arrive-${dueArrival.id}`,
                  () => apiFetch(entryPath(dueArrival.id, DASHBOARD_PATHS.arrive), { method: "POST" }),
                  "Customer physically confirmed at shop.").then(() => void refetch(false));
              }}>Confirm arrived</Btn>
              <Btn variant="secondary" onClick={() => setArrivalSnoozes((prev) => ({
                ...prev, [dueArrival.id]: Date.now() + 120_000,
              }))}>Not arrived · Remind in 2 minutes</Btn>
            </div>
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      )}
      <PageHead
        title="Live Queue"
        sub={
          <>
            <span className={`${ui.liveDot} ${live ? "" : ui.liveDotOff}`} aria-hidden="true" />
            {live ? "Live — updates appear instantly" : "Reconnecting — refreshing every 15 seconds"} · Q Chime on
          </>
        }
        actions={
          <>
            <Btn variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              New Live Queue customer
            </Btn>
            <BtnLink icon="calendar" href={`/dashboard/salons/${salonId}/bookings/new`}>
              New in-shop appointment
            </BtnLink>
            <Btn icon="scissors" disabled={busy !== null || waiting.length + called.length === 0} onClick={() => void assignAutomatically()}>
              {busy === "auto-all" ? "Starting…" : "Start next service"}
            </Btn>
            <Btn
              variant="quiet"
              aria-pressed={voiceEnabled}
              title="Voice announcement preference is saved on this browser"
              onClick={() => {
                if (voiceEnabled) setConfirmVoiceOff(true);
                else setVoiceEnabled(true);
              }}
            >
              Voice: {voiceEnabled ? "on" : "off"}
            </Btn>
          </>
        }
      />
      {confirmVoiceOff && (
        <Dialog title="Turn off voice announcements?" onClose={() => setConfirmVoiceOff(false)}>
          <Banner tone="warn">
            Turning Voice off stops spoken announcements when new customers join the Live Queue.
            Chime alerts will still play. Do you want to turn Voice off?
          </Banner>
          <div className={ui.dialogActions}>
            <Btn variant="secondary" onClick={() => setConfirmVoiceOff(false)}>
              Keep voice on
            </Btn>
            <Btn
              variant="danger"
              onClick={() => {
                setVoiceEnabled(false);
                setConfirmVoiceOff(false);
              }}
            >
              Yes, turn voice off
            </Btn>
          </div>
        </Dialog>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}
      {data.autoAssignEnabled === false && (
        <Banner tone="warn">
          Automatic assignment is OFF for this shop. The manual Assign automatically button still works,
          but free barbers will not automatically start service for waiting customers.
          {kind === "owner" && (
            <>{" "}<Btn small variant="secondary" disabled={busy !== null}
              onClick={() => void run("enable-auto", () => apiFetch(`${base}/queue/settings`, {
                method: "PATCH", body: JSON.stringify({ autoAssignEnabled: true }),
              }), "Automatic assignment enabled. Arrived waiting customers will enter In service automatically whenever a qualified barber and chair are available.")}>
              {busy === "enable-auto" ? "Enabling…" : "Enable automatic assignment"}
            </Btn></>
          )}
        </Banner>
      )}

      <div className={ui.queueTop}>
        <Tabs
          label="Live Queue views"
          value={view}
          onChange={setView}
          tabs={[
            { id: "waiting", label: "Waiting", count: counts.waiting },
            { id: "in-service", label: "In service", count: counts.inService },
            { id: "completed", label: "Completed today", count: counts.completed },
            { id: "no-show", label: "NO SHOW", count: counts.noShow },
            { id: "history", label: "Cancelled & expired", count: counts.history },
          ]}
        />
      </div>

      <div className={ui.queueLayout}>
        <div>
          {view === "waiting" && (
            <div className={ui.entryGrid}>
              {called.length + waiting.length + assigned.length === 0 && (
                <Card>
                  <EmptyState title="Nobody is waiting" action={<Btn variant="primary" icon="plus" onClick={() => setAddOpen(true)}>New Live Queue customer</Btn>}>
                    Customers who join through the app, the QR code or at the counter appear here in order.
                  </EmptyState>
                </Card>
              )}
              {called.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="called">
                  <div className={ui.entryActions}>
                    <Btn variant="primary" small disabled={busy !== null || entry.arrivedAt === null} onClick={() => void assignAutomatically(entry)}>
                      Start service automatically
                    </Btn>
                    <Btn small onClick={() => setAssignFor(assignFor === entry.id ? null : entry.id)}>
                      Choose barber &amp; chair
                    </Btn>
                    <Btn small variant="danger" disabled={busy !== null} onClick={() => void run(`noshow-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.noShow), { method: "POST" }))}>
                      Mark no-show
                    </Btn>
                    <Btn small variant="quiet" disabled={busy !== null} onClick={() => void run(`cancel-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.cancel), { method: "POST" }))}>
                      Cancel
                    </Btn>
                  </div>
                  {assignFor === entry.id && <AssignForm entry={entry} data={data} onDone={() => { setAssignFor(null); void refetch(false); }} />}
                </EntryCard>
              ))}
              {waiting.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="waiting" fresh={freshIds.includes(entry.id)}>
                  {skipReasons[entry.id] ? (
                    <div className={ui.entryReason}>Not assigned yet: {skipReasons[entry.id]}</div>
                  ) : (
                    <div className={ui.entryReason}>{data.autoAssignEnabled === false ? "Waiting to be assigned" : "Waiting for available staff"}</div>
                  )}
                  {entry.arrivedAt === null && (
                    <div className={ui.entryReason}>
                      Background auto-assignment waits for arrival. When the customer is physically here, press Mark as in the shop; the system will then assign an eligible free barber and chair.
                    </div>
                  )}
                  <div className={ui.entryActions}>
                    <Btn variant="primary" small disabled={busy !== null || entry.arrivedAt === null} onClick={() => void assignAutomatically(entry)}>
                      {busy === `auto-${entry.id}` ? "Starting…" : "Start service automatically"}
                    </Btn>
                    <Btn small onClick={() => setAssignFor(assignFor === entry.id ? null : entry.id)}>
                      Choose barber &amp; chair
                    </Btn>
                    {entry.arrivedAt === null && (
                      <Btn small disabled={busy !== null} onClick={() => void run(`arrive-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.arrive), { method: "POST" }), "Marked as in the shop.")}>
                        Mark as in the shop
                      </Btn>
                    )}
                    {entry.arrivedAt === null && (
                      <Btn small variant="danger" disabled={busy !== null} onClick={() => void run(`noshow-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.noShow), { method: "POST" }), "Visitor marked NO SHOW.")}>
                        Mark NO SHOW
                      </Btn>
                    )}
                    <Btn small disabled={busy !== null} onClick={() => void run(`call-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.call), { method: "POST" }), "Customer called.")}>
                      Call
                    </Btn>
                    <Btn small variant="quiet" disabled={busy !== null} onClick={() => void run(`cancel-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.cancel), { method: "POST" }))}>
                      Cancel
                    </Btn>
                  </div>
                  {assignFor === entry.id && <AssignForm entry={entry} data={data} onDone={() => { setAssignFor(null); void refetch(false); }} />}
                </EntryCard>
              ))}
            </div>
          )}

          {view === "waiting" && assigned.length > 0 && (
            <div className={ui.entryGrid}>
              {assigned.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="assigned">
                  <div className={ui.entryReason}>Existing reservation from an older app: the barber and chair are held, but service has not started. Press Start service only when the customer is in the chair.</div>
                  <div className={ui.entryActions}>
                    <Btn
                      variant="primary"
                      small
                      icon="scissors"
                      disabled={busy !== null}
                      onClick={() => void run(`start-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.startService), { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() } }), `${whoLabel(entry)} — service started.`)}
                    >
                      {busy === `start-${entry.id}` ? "Starting…" : "Start service"}
                    </Btn>
                    <Btn small onClick={() => setAssignFor(assignFor === entry.id ? null : entry.id)}>
                      Change barber &amp; chair
                    </Btn>
                    <Btn small variant="danger" disabled={busy !== null} onClick={() => void run(`noshow-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.noShow), { method: "POST" }))}>
                      Mark no-show
                    </Btn>
                    <Btn small variant="quiet" disabled={busy !== null} onClick={() => void run(`cancel-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.cancel), { method: "POST" }))}>
                      Cancel
                    </Btn>
                  </div>
                  {assignFor === entry.id && <AssignForm entry={entry} data={data} onDone={() => { setAssignFor(null); void refetch(false); }} />}
                </EntryCard>
              ))}
            </div>
          )}

          {view === "in-service" && (
            <div className={ui.entryGrid}>
              {inService.length === 0 && (
                <Card>
                  <EmptyState title="No one is in service right now">A customer appears here once their barber has started the service.</EmptyState>
                </Card>
              )}
              {inService.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="in-service">
                  <div className={ui.entryActions}>
                    <Btn variant="primary" small icon="check" disabled={busy !== null || !entry.activeServiceSessionId} onClick={() => entry.activeServiceSessionId && setUsageFor({ entryId: entry.id, sessionId: entry.activeServiceSessionId, who: whoLabel(entry) })}>
                      Complete service
                    </Btn>
                    <Btn small onClick={() => setAssignFor(assignFor === entry.id ? null : entry.id)}>
                      Change barber / chair
                    </Btn>
                    <Btn small variant="quiet" disabled={busy !== null} onClick={() => void run(`cancel-${entry.id}`, () => apiFetch(entryPath(entry.id, DASHBOARD_PATHS.cancel), { method: "POST" }))}>
                      Cancel visit
                    </Btn>
                  </div>
                  {assignFor === entry.id && <ReassignForm entry={entry} data={data} onDone={() => { setAssignFor(null); void refetch(false); }} />}
                </EntryCard>
              ))}
            </div>
          )}

          {view === "completed" && (
            <div className={ui.entryGrid}>
              {completed.length === 0 && (
                <Card>
                  <EmptyState title="Nothing completed yet today" />
                </Card>
              )}
              {completed.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="done">
                  <div className={ui.entryActions}>
                    <InvoiceAction salonId={salonId} bookingId={entry.bookingId} queueEntryId={entry.bookingId ? null : entry.id} />
                  </div>
                </EntryCard>
              ))}
            </div>
          )}

          {view === "no-show" && (
            <div className={ui.entryGrid}>
              {noShows.length === 0 && <Card><EmptyState title="No NO SHOW visits today" /></Card>}
              {noShows.map((entry) => <EntryCard key={entry.id} entry={entry} tone="done" />)}
            </div>
          )}

          {view === "history" && (
            <div className={ui.entryGrid}>
              {history.length > 0 && (
                <div className={ui.entryReason}>
                  These visits are cancelled or expired records, not active assignments.
                  Any barber and chair shown below are historical details and no longer reserved.
                </div>
              )}
              {history.length === 0 && (
                <Card>
                  <EmptyState title="No cancelled or expired visits today">These stay here for the day and are counted in Analytics.</EmptyState>
                </Card>
              )}
              {history.map((entry) => (
                <EntryCard key={entry.id} entry={entry} tone="done" />
              ))}
            </div>
          )}
        </div>

        <div className={ui.sideStack}>
          <Card title="Barbers" sub={`${data.staffRoster.filter((s) => s.status === StaffMemberStatus.ACTIVE).length} on duty`}>
            {data.staffRoster.length === 0 ? (
              <EmptyState title="No barbers yet" action={<BtnLink small href={`/dashboard/salons/${salonId}/staff`} icon="plus">Add a barber</BtnLink>} />
            ) : (
              <div>
                {data.staffRoster.map((member) => {
                  const state = availabilityText(member, assignedByStaff.get(member.id));
                  const on = member.status === StaffMemberStatus.ACTIVE;
                  return (
                    <div key={member.id} className={ui.barberRow}>
                      <span className={`${ui.dot} ${state.dot}`} aria-hidden="true" />
                      <div className={ui.listMain}>
                        <div className={ui.listTitle}>{member.displayName}</div>
                        <div className={ui.listSub}>{state.text}</div>
                      </div>
                      <Btn
                        small
                        variant="quiet"
                        disabled={busy !== null}
                        onClick={() => void run(`duty-${member.id}`, () => apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.staff}/${member.id}/${DASHBOARD_PATHS.status}`, { method: "PATCH", body: JSON.stringify({ status: on ? StaffMemberStatus.INACTIVE : StaffMemberStatus.ACTIVE }) }))}
                      >
                        {on ? "Clock out" : "Clock in"}
                      </Btn>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Chairs" sub={`${freeChairs.length} of ${data.chairs.length} free`}>
            {data.chairs.length === 0 ? (
              <EmptyState title="No chairs set up" action={<BtnLink small href={`/dashboard/salons/${salonId}/chairs`} icon="plus">Add chairs</BtnLink>} />
            ) : (
              <div className={ui.chairGrid}>
                {data.chairs.map((chair) => (
                  <ChairTile
                    key={chair.id}
                    chair={chair}
                    busy={busy !== null}
                    onFree={() => void run(`free-${chair.id}`, () => apiFetch(`${base}/${DASHBOARD_PATHS.chairOccupancy}/${chair.id}/${DASHBOARD_PATHS.freeLocal}`, { method: "POST" }), `${chair.label} is free.`)}
                  />
                ))}
              </div>
            )}
          </Card>

          {kind === "owner" && (
            <Card title="Automatic assignment">
              <div className={ui.toggleRow}>
                <div>
                  <div className={ui.listTitle} style={{ whiteSpace: "normal" }}>
                    Assign staff automatically
                  </div>
                  <div className={ui.cardSub}>
                    On by default. When on, a customer confirmed present at the shop automatically enters In service as soon as a qualified free barber and free chair are available. This also opens a real service session; turn OFF if the shop requires a barber to confirm each start.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={data.autoAssignEnabled === true}
                  aria-label="Automatic assignment"
                  className={`${ui.switch} ${data.autoAssignEnabled === true ? ui.switchOn : ""}`}
                  disabled={busy !== null}
                  onClick={() => void run("auto-setting", () => apiFetch(`${base}/queue/settings`, { method: "PATCH", body: JSON.stringify({ autoAssignEnabled: !data.autoAssignEnabled }) }), data.autoAssignEnabled ? "Automatic assignment is off." : "Automatic assignment is on.")}
                />
              </div>
            </Card>
          )}
        </div>
      </div>

      {usageFor && (
        <ServiceUsageDialog
          queueEntryId={usageFor.entryId}
          mode="complete"
          onClose={() => setUsageFor(null)}
          onComplete={() => run(`done-${usageFor.entryId}`, () => apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.serviceSessions}/${usageFor.sessionId}/${DASHBOARD_PATHS.complete}`, { method: "POST" }), `${usageFor.who} — service completed.`)}
        />
      )}

      {addOpen && (
        <NewQueueCustomerDialog
          salonId={salonId}
          onClose={() => setAddOpen(false)}
          onCreated={(entry) => {
            setNotice(`Added ${entry.customerName ?? "customer"} as queue #${entry.tokenNumber}.`);
            setView("waiting");
            void refetch(false);
          }}
        />
      )}
    </>
  );
}

function ChairTile({ chair, busy, onFree }: { chair: ChairOptionDto; busy: boolean; onFree: () => void }) {
  const occupancy = chair.occupancy ?? "FREE";
  const reserved = occupancy === "FREE" && Boolean(chair.reservedForEntryId);
  return (
    <div className={`${ui.chair} ${occupancy === "FREE" && !reserved ? "" : ui.chairBusy}`}>
      <div className={ui.chairName}>{chair.label}</div>
      <div className={ui.chairState}>
        {occupancy === "FREE" && !reserved && "Free"}
        {reserved && `Reserved · queue #${chair.reservedForTokenNumber ?? "?"} · not started`}
        {occupancy === "FASTQUE" && `${chair.assignedStaffName ?? "A barber"} · queue #${chair.tokenNumber ?? "?"}`}
        {occupancy === "LOCAL" && "Seated without a queue entry"}
      </div>
      {occupancy === "LOCAL" && (
        <Btn small variant="secondary" className={ui.mt12} disabled={busy} onClick={onFree}>
          Free this chair
        </Btn>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  tone,
  fresh,
  children,
}: {
  entry: QueueEntryDetailDto;
  tone: "waiting" | "called" | "assigned" | "in-service" | "done";
  fresh?: boolean;
  children?: React.ReactNode;
}) {
  const phase = queuePhaseOf(entry);
  const status = PHASE_LABEL[phase] ?? { text: entry.status, tone: "neutral" as const };
  // Time since the right thing happened: since service STARTED when in service, since the barber was
  // ASSIGNED when assigned, since joining otherwise.
  const since = minutesSince(
    phase === "IN_SERVICE" ? entry.serviceStartedAt ?? entry.calledAt ?? entry.joinedAt : phase === "ASSIGNED" ? entry.assignedAt ?? entry.calledAt ?? entry.joinedAt : entry.joinedAt,
  );
  return (
    <article
      className={`${ui.entry} ${tone === "waiting" ? ui.entryWaiting : tone === "called" ? ui.entryCalled : tone === "assigned" ? ui.entryAssigned : tone === "in-service" ? ui.entryInService : ui.entryDone} ${fresh ? ui.entryNew : ""}`}
      aria-label={`${whoLabel(entry)}, token ${entry.tokenNumber}, ${status.text}`}
    >
      <div className={ui.entryHead}>
        <div className={ui.token} title="Queue token">
          #{entry.tokenNumber}
        </div>
        <div className={ui.entryWho}>
          <div className={ui.entryName}>{whoLabel(entry)}</div>
          <div className={ui.entryMeta}>
            {entry.serviceName ?? "Service not chosen yet"}
            {entry.status === "WAITING" && entry.position ? ` · position ${entry.position} in line` : ""}
            {entry.status === "WAITING" && entry.estimatedWaitMinutes !== null ? ` · about ${entry.estimatedWaitMinutes} min` : ""}
          </div>
          {entry.customerPhone && (
            <a className={`${ui.entryMeta} ${ui.entryPhone}`} href={`tel:${entry.customerPhone}`}>
              {entry.customerPhone}
            </a>
          )}
          {entry.assignedStaffName && (
            <div className={ui.entryMeta}>
              {phase === "ASSIGNED" ? "Reserved for " : entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.status === "NO_SHOW" ? "Previously assigned to " : ""}
              {entry.assignedStaffName}
              {entry.assignedChairLabel ? ` · ${entry.assignedChairLabel}` : ""}
            </div>
          )}
          {entry.preferredStaffName && entry.status !== "IN_SERVICE" && entry.status !== "COMPLETED" && <div className={ui.entryMeta}>Wants {entry.preferredStaffName}</div>}
          {!entry.assignedStaffName && entry.bookingId && <div className={ui.entryMeta}>Online booking check-in</div>}
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <Badge tone={status.tone}>{status.text}</Badge>
          {(entry.status === "WAITING" || entry.status === "CALLED") && (entry.arrivedAt === null ? <Badge tone="warn">Not in the shop yet</Badge> : <Badge tone="ok">In the shop</Badge>)}
          {since !== null && (entry.status === "WAITING" || entry.status === "CALLED" || entry.status === "IN_SERVICE") && (
            <span className={ui.cardSub}>
              {since} min {phase === "IN_SERVICE" ? "in service" : phase === "ASSIGNED" ? "since assigned" : "so far"}
            </span>
          )}
        </div>
      </div>
      {children}
    </article>
  );
}

function AssignForm({ entry, data, onDone }: { entry: QueueEntryDetailDto; data: DashboardQueueDto; onDone: () => void }) {
  const needsService = !entry.serviceId;
  const [staffId, setStaffId] = useState(entry.preferredStaffId ?? "");
  const [chairId, setChairId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = data.staffRoster.filter((s) => s.status === StaffMemberStatus.ACTIVE);
  const options = entry.preferredStaffId ? staff.filter((s) => s.id === entry.preferredStaffId) : staff;
  // Free chairs, plus the one this very customer already holds.
  const chairs = data.chairs.filter((c) => (c.occupancy ?? "FREE") === "FREE" && (!c.reservedForEntryId || c.reservedForEntryId === entry.id));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.queueEntries}/${entry.id}/${DASHBOARD_PATHS.assign}`, {
        method: "POST",
        headers: { "Idempotency-Key": newIdempotencyKey() },
        // Direct shop workflow: an explicit barber/chair choice immediately starts a real service session.
        body: JSON.stringify({ staffId, chairId, startService: true, ...(needsService ? { serviceId } : {}) }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign this customer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ui.assignBox}>
      {needsService && (
        <Field label="Service" htmlFor={`as-svc-${entry.id}`}>
          <select id={`as-svc-${entry.id}`} className={ui.select} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose…</option>
            {data.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Barber" htmlFor={`as-staff-${entry.id}`} hint={entry.preferredStaffId ? `Booked with ${entry.preferredStaffName ?? "a specific barber"}.` : undefined}>
        <select id={`as-staff-${entry.id}`} className={ui.select} value={staffId} onChange={(e) => setStaffId(e.target.value)} disabled={Boolean(entry.preferredStaffId)}>
          <option value="">Choose…</option>
          {options.map((s) => {
            const state = s.id === entry.assignedStaffId ? { text: "currently assigned" } : availabilityText(s);
            return (
              <option key={s.id} value={s.id} disabled={s.id !== entry.assignedStaffId && (s.availabilityState === "IN_SERVICE" || s.availabilityState === "RESERVED")}>
                {s.displayName} — {state.text}
              </option>
            );
          })}
        </select>
      </Field>
      <Field label="Chair" htmlFor={`as-chair-${entry.id}`}>
        <select id={`as-chair-${entry.id}`} className={ui.select} value={chairId} onChange={(e) => setChairId(e.target.value)}>
          <option value="">Choose…</option>
          {chairs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Btn variant="primary" disabled={busy || entry.arrivedAt === null || !staffId || !chairId || (needsService && !serviceId)} onClick={() => void submit()}>
        {busy ? "Starting…" : "Start service"}
      </Btn>
      {entry.arrivedAt === null && <Banner tone="warn">Mark as in the shop before starting service.</Banner>}
      {error && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </div>
  );
}

function ReassignForm({ entry, data, onDone }: { entry: QueueEntryDetailDto; data: DashboardQueueDto; onDone: () => void }) {
  const [staffId, setStaffId] = useState(entry.assignedStaffId ?? "");
  const [chairId, setChairId] = useState(entry.assignedChairId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = data.staffRoster.filter((s) => s.status === StaffMemberStatus.ACTIVE);
  const chairs = data.chairs.filter((c) => c.id === entry.assignedChairId || (c.occupancy ?? "FREE") === "FREE");
  const changed = staffId !== entry.assignedStaffId || chairId !== entry.assignedChairId;

  async function submit() {
    setBusy(true);
    setError(null);
    const body: { staffId?: string; chairId?: string } = {};
    if (staffId !== entry.assignedStaffId) body.staffId = staffId;
    if (chairId !== entry.assignedChairId) body.chairId = chairId;
    try {
      await apiFetch(`${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.queueEntries}/${entry.id}/${DASHBOARD_PATHS.reassign}`, { method: "PATCH", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move this visit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ui.assignBox}>
      <Field label="Barber" htmlFor={`re-staff-${entry.id}`}>
        <select id={`re-staff-${entry.id}`} className={ui.select} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
              {s.id !== entry.assignedStaffId ? ` — ${availabilityText(s).text}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Chair" htmlFor={`re-chair-${entry.id}`}>
        <select id={`re-chair-${entry.id}`} className={ui.select} value={chairId} onChange={(e) => setChairId(e.target.value)}>
          {chairs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <span />
      <Btn variant="primary" disabled={busy || !changed} onClick={() => void submit()}>
        {busy ? "Moving…" : "Confirm change"}
      </Btn>
      {error && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </div>
  );
}
