"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CrmFollowUpChannel,
  CrmFollowUpStatus,
  CrmLeadSource,
  CrmLeadStatus,
  CrmVisitOutcome,
  EMPLOYEE_PATHS,
  Role,
  type EmployeeCrmDashboardDto,
  type EmployeeCrmFollowUpDto,
  type EmployeeCrmLeadDto,
  type EmployeeCrmVisitDto,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./employee.module.css";
import { EmployeeShopDetails } from "./EmployeeShopDetails";
import { EmployeeOnboardingTab } from "../../components/onboarding/EmployeeOnboardingTab";

type Tab = "dashboard" | "leads" | "visits" | "followups" | "onboarding";

const employeeBase = EMPLOYEE_PATHS.employee;

function pretty(value: string): string {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toIso(localDateTime: string): string {
  return new Date(localDateTime).toISOString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function EmployeeDashboardPage() {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  // "?tab=onboarding" deep-links back from the onboarding pages. Tabs render only after the
  // dashboard loads (client-side), so reading the URL here cannot cause a hydration mismatch.
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "onboarding"
      ? "onboarding"
      : "dashboard",
  );
  const [dashboard, setDashboard] = useState<EmployeeCrmDashboardDto | null>(null);
  const [leads, setLeads] = useState<EmployeeCrmLeadDto[]>([]);
  const [visits, setVisits] = useState<EmployeeCrmVisitDto[]>([]);
  const [followUps, setFollowUps] = useState<EmployeeCrmFollowUpDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState("");
  const [onboardIds, setOnboardIds] = useState<Record<string, string>>({});

  const [leadForm, setLeadForm] = useState({
    shopName: "",
    contactName: "",
    phone: "",
    email: "",
    city: "",
    locality: "",
    source: CrmLeadSource.FIELD_VISIT as CrmLeadSource,
    notes: "",
  });
  const [visitForm, setVisitForm] = useState({
    leadId: "",
    shopName: "",
    outcome: CrmVisitOutcome.CONTACTED as CrmVisitOutcome,
    notes: "",
    visitedAt: "",
  });
  const [followUpForm, setFollowUpForm] = useState({
    leadId: "",
    dueAt: "",
    channel: CrmFollowUpChannel.CALL as CrmFollowUpChannel,
    notes: "",
  });

  const refreshAll = useCallback(async () => {
    try {
      const [nextDashboard, nextLeads, nextVisits, nextFollowUps] = await Promise.all([
        apiFetch<EmployeeCrmDashboardDto>(`${employeeBase}/${EMPLOYEE_PATHS.dashboard}`),
        apiFetch<EmployeeCrmLeadDto[]>(`${employeeBase}/${EMPLOYEE_PATHS.leads}`),
        apiFetch<EmployeeCrmVisitDto[]>(`${employeeBase}/${EMPLOYEE_PATHS.visits}`),
        apiFetch<EmployeeCrmFollowUpDto[]>(`${employeeBase}/${EMPLOYEE_PATHS.followUps}`),
      ]);
      setDashboard(nextDashboard);
      setLeads(nextLeads);
      setVisits(nextVisits);
      setFollowUps(nextFollowUps);
      setError(null);
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not load the CRM workspace."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "authenticated" || !user?.roles.includes(Role.FIELD_EXECUTIVE)) {
      router.replace("/employee/login");
      return;
    }
    void refreshAll();
  }, [refreshAll, router, status, user]);


  const filteredLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((lead) =>
      `${lead.shopName} ${lead.contactName ?? ""} ${lead.phone ?? ""} ${lead.email ?? ""} ${lead.city ?? ""} ${lead.locality ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [leadQuery, leads]);

  const openFollowUps = followUps.filter((item) => item.status === CrmFollowUpStatus.OPEN);
  const overdueFollowUps = openFollowUps.filter((item) => new Date(item.dueAt).getTime() < Date.now());

  async function createLead(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("lead-create");
    setError(null);
    setSuccess(null);
    try {
      const created = await apiFetch<EmployeeCrmLeadDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.leads}`,
        { method: "POST", body: JSON.stringify(leadForm) },
      );
      setLeadForm({
        shopName: "",
        contactName: "",
        phone: "",
        email: "",
        city: "",
        locality: "",
        source: CrmLeadSource.FIELD_VISIT,
        notes: "",
      });
      setSuccess(`Lead created for ${created.shopName}.`);
      await refreshAll();
      setTab("leads");
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not create the lead."));
    } finally {
      setBusy(null);
    }
  }

  async function updateLeadStatus(lead: EmployeeCrmLeadDto, nextStatus: CrmLeadStatus) {
    setBusy(`lead-${lead.id}`);
    setError(null);
    try {
      const updated = await apiFetch<EmployeeCrmLeadDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.leads}/${lead.id}`,
        { method: "PATCH", body: JSON.stringify({ status: nextStatus }) },
      );
      setLeads((current) => current.map((item) => item.id === updated.id ? updated : item));
      await refreshAll();
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not update the lead."));
    } finally {
      setBusy(null);
    }
  }

  /** Option A: convert an existing lead into an onboarding application (prefilled from the lead). */
  async function startOnboarding(lead: EmployeeCrmLeadDto) {
    setBusy(`start-${lead.id}`);
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>(
        `${employeeBase}/${EMPLOYEE_PATHS.leads}/${lead.id}/${EMPLOYEE_PATHS.onboarding}`,
        { method: "POST", body: "{}" },
      );
      router.push(`/employee/onboarding/${created.id}`);
    } catch (requestError) {
      const existing =
        requestError instanceof ApiError &&
        requestError.details &&
        typeof requestError.details === "object" &&
        "applicationId" in requestError.details
          ? String((requestError.details as { applicationId: string }).applicationId)
          : null;
      if (existing) router.push(`/employee/onboarding/${existing}`);
      else setError(errorMessage(requestError, "Could not start onboarding for this lead."));
      setBusy(null);
    }
  }

  async function onboardLead(lead: EmployeeCrmLeadDto) {
    const salonPublicId = (onboardIds[lead.id] ?? "").trim().toUpperCase();
    if (!/^BC-SHOP-[0-9]{6}$/.test(salonPublicId)) {
      setError("Enter the registered FastQue Shop ID, for example BC-SHOP-000123.");
      return;
    }
    setBusy(`onboard-${lead.id}`);
    setError(null);
    setSuccess(null);
    try {
      const updated = await apiFetch<EmployeeCrmLeadDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.leads}/${lead.id}/${EMPLOYEE_PATHS.onboard}`,
        { method: "POST", body: JSON.stringify({ salonPublicId }) },
      );
      setOnboardIds((current) => ({ ...current, [lead.id]: "" }));
      setSuccess(`${updated.shopName} attributed to ${updated.onboardedSalon?.publicId ?? salonPublicId}.`);
      await refreshAll();
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not attribute this shop."));
    } finally {
      setBusy(null);
    }
  }

  async function createVisit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("visit-create");
    setError(null);
    setSuccess(null);
    try {
      await apiFetch<EmployeeCrmVisitDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.visits}`,
        {
          method: "POST",
          body: JSON.stringify({
            leadId: visitForm.leadId || undefined,
            shopName: visitForm.shopName || undefined,
            outcome: visitForm.outcome,
            notes: visitForm.notes,
            visitedAt: visitForm.visitedAt ? toIso(visitForm.visitedAt) : undefined,
          }),
        },
      );
      setVisitForm({
        leadId: "",
        shopName: "",
        outcome: CrmVisitOutcome.CONTACTED,
        notes: "",
        visitedAt: "",
      });
      setSuccess("Field visit logged.");
      await refreshAll();
      setTab("visits");
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not log the visit."));
    } finally {
      setBusy(null);
    }
  }

  async function createFollowUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!followUpForm.leadId || !followUpForm.dueAt) {
      setError("Choose a lead and follow-up date/time.");
      return;
    }
    setBusy("followup-create");
    setError(null);
    setSuccess(null);
    try {
      await apiFetch<EmployeeCrmFollowUpDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.followUps}`,
        {
          method: "POST",
          body: JSON.stringify({
            leadId: followUpForm.leadId,
            dueAt: toIso(followUpForm.dueAt),
            channel: followUpForm.channel,
            notes: followUpForm.notes,
          }),
        },
      );
      setFollowUpForm({
        leadId: "",
        dueAt: "",
        channel: CrmFollowUpChannel.CALL,
        notes: "",
      });
      setSuccess("Follow-up scheduled.");
      await refreshAll();
      setTab("followups");
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not schedule the follow-up."));
    } finally {
      setBusy(null);
    }
  }

  async function closeFollowUp(item: EmployeeCrmFollowUpDto, nextStatus: CrmFollowUpStatus) {
    setBusy(`followup-${item.id}`);
    setError(null);
    try {
      await apiFetch<EmployeeCrmFollowUpDto>(
        `${employeeBase}/${EMPLOYEE_PATHS.followUps}/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: nextStatus,
            outcome: nextStatus === CrmFollowUpStatus.COMPLETED ? "Completed by field executive" : "Cancelled",
          }),
        },
      );
      await refreshAll();
    } catch (requestError) {
      setError(errorMessage(requestError, "Could not update the follow-up."));
    } finally {
      setBusy(null);
    }
  }

  if (status === "loading" || loading || !dashboard) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <p className={styles.eyebrow}>FastQue Field Operations</p>
          <h1 className={styles.title}>{error ? "CRM unavailable" : "Preparing your CRM…"} </h1>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </main>
    );
  }

  const profile = dashboard.profile;

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>FastQue Field CRM</span>
            <strong>{profile.fullName} · {profile.employeeCode}</strong>
          </div>
          <div className={styles.topActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => void refreshAll()}>
              Refresh
            </button>
            <button
              type="button"
              className={styles.signout}
              onClick={() => void logout().then(() => router.replace("/employee/login"))}
            >
              Sign out
            </button>
          </div>
        </header>

        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Employee Workspace</p>
            <h1 className={styles.title}>Field work, follow-ups and onboarding—in one place.</h1>
            <p className={styles.sub}>
              Territory: <strong>{profile.territory ?? "Not assigned"}</strong>. Every lead, visit,
              follow-up and onboarded shop below is attributed to your Employee ID.
            </p>
          </div>
        </section>

        <nav className={styles.tabs} aria-label="CRM sections">
          {([
            ["dashboard", "Dashboard"],
            ["leads", `Leads (${leads.length})`],
            ["visits", `Visits (${visits.length})`],
            ["followups", `Follow-ups (${openFollowUps.length})`],
            ["onboarding", "Salon Onboarding"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? styles.tabActive : styles.tab}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </nav>

        {error && <p className={styles.error} role="alert">{error}</p>}
        {success && <p className={styles.success} role="status">{success}</p>}

        <section className={styles.metrics} aria-label="CRM performance">
          <article><strong>{dashboard.counts.leads}</strong><span>Total leads</span></article>
          <article><strong>{dashboard.counts.onboarded}</strong><span>Onboarded shops</span></article>
          <article><strong>{dashboard.counts.visitsLast30Days}</strong><span>Visits · 30 days</span></article>
          <article><strong>{dashboard.counts.openFollowUps}</strong><span>Open follow-ups</span></article>
          <article className={dashboard.counts.overdueFollowUps > 0 ? styles.metricWarning : ""}>
            <strong>{dashboard.counts.overdueFollowUps}</strong><span>Overdue</span>
          </article>
          <article><strong>{dashboard.conversionRatePercent}%</strong><span>Conversion</span></article>
        </section>

        {tab === "dashboard" && (
          <div className={styles.dashboardGrid}>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Quick actions</h2><span>Keep the pipeline moving</span></div>
              <div className={styles.quickActions}>
                <button type="button" className={styles.primaryButton} onClick={() => setTab("leads")}>+ Add lead</button>
                <Link className={styles.primaryButton} href="/employee/onboarding/new">+ New salon onboarding</Link>
                <button type="button" className={styles.secondaryButton} onClick={() => setTab("visits")}>Log visit</button>
                <button type="button" className={styles.secondaryButton} onClick={() => setTab("followups")}>Schedule follow-up</button>
              </div>
            </section>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Next follow-ups</h2><span>{overdueFollowUps.length} overdue</span></div>
              <div className={styles.compactList}>
                {dashboard.upcomingFollowUps.length === 0 && <p className={styles.empty}>No open follow-ups.</p>}
                {dashboard.upcomingFollowUps.map((item) => (
                  <div key={item.id} className={new Date(item.dueAt).getTime() < Date.now() ? styles.overdueRow : styles.compactRow}>
                    <div><strong>{item.leadShopName}</strong><small>{pretty(item.channel)}</small></div>
                    <span>{dateTime(item.dueAt)}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Recent leads</h2><span>Latest activity</span></div>
              <div className={styles.compactList}>
                {dashboard.recentLeads.map((lead) => (
                  <div key={lead.id} className={styles.compactRow}>
                    <div><strong>{lead.shopName}</strong><small>{lead.city ?? lead.locality ?? "Location not recorded"}</small></div>
                    <span className={styles.status}>{pretty(lead.status)}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Recent visits</h2><span>Latest field work</span></div>
              <div className={styles.compactList}>
                {dashboard.recentVisits.map((visit) => (
                  <div key={visit.id} className={styles.compactRow}>
                    <div><strong>{visit.shopName}</strong><small>{pretty(visit.outcome)}</small></div>
                    <span>{dateTime(visit.visitedAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === "onboarding" && <EmployeeOnboardingTab />}

        {tab === "leads" && (
          <>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Add new lead</h2><span>Shop prospect</span></div>
              <form className={styles.formGrid} onSubmit={createLead}>
                <label>Shop / salon name<input required minLength={2} value={leadForm.shopName} onChange={(e) => setLeadForm({ ...leadForm, shopName: e.target.value })} /></label>
                <label>Contact person<input value={leadForm.contactName} onChange={(e) => setLeadForm({ ...leadForm, contactName: e.target.value })} /></label>
                <label>Mobile<input value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} /></label>
                <label>Email<input type="email" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} /></label>
                <label>City<input value={leadForm.city} onChange={(e) => setLeadForm({ ...leadForm, city: e.target.value })} /></label>
                <label>Area / locality<input value={leadForm.locality} onChange={(e) => setLeadForm({ ...leadForm, locality: e.target.value })} /></label>
                <label>Source<select value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value as CrmLeadSource })}>
                  {Object.values(CrmLeadSource).map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
                </select></label>
                <label className={styles.spanTwo}>Notes<textarea value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} /></label>
                <div className={styles.formAction}><button className={styles.primaryButton} disabled={busy === "lead-create"}>{busy === "lead-create" ? "Saving…" : "Create lead"}</button></div>
              </form>
            </section>

            <section className={styles.panel}>
              <div className={styles.sectionHeader}>
                <h2>Lead pipeline</h2>
                <input className={styles.search} type="search" value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Search shop, contact, city…" />
              </div>
              <div className={styles.tableWrap}>
                <table>
                  <thead><tr><th>Lead</th><th>Contact</th><th>Stage</th><th>Location</th><th>Onboarding attribution</th><th>Field voice log</th></tr></thead>
                  <tbody>
                    {filteredLeads.map((lead) => (
                      <tr key={lead.id}>
                        <td><strong>{lead.shopName}</strong><small>{pretty(lead.source)} · {dateTime(lead.createdAt)}</small></td>
                        <td>{lead.contactName ?? "—"}<small>{lead.phone ?? lead.email ?? "No contact recorded"}</small></td>
                        <td>
                          {lead.status === CrmLeadStatus.ONBOARDED ? (
                            <span className={styles.statusSuccess}>Onboarded</span>
                          ) : (
                            <select
                              value={lead.status}
                              disabled={busy === `lead-${lead.id}`}
                              onChange={(e) => void updateLeadStatus(lead, e.target.value as CrmLeadStatus)}
                            >
                              {Object.values(CrmLeadStatus).filter((value) => value !== CrmLeadStatus.ONBOARDED).map((value) => (
                                <option key={value} value={value}>{pretty(value)}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>{[lead.locality, lead.city].filter(Boolean).join(", ") || "—"}</td>
                        <td>
                          {lead.onboardedSalon ? (
                            <div>
                              <strong>{lead.onboardedSalon.publicId}</strong><small>{lead.onboardedSalon.name}</small>
                              <EmployeeShopDetails leadId={lead.id} />
                            </div>
                          ) : (
                            <div className={styles.inlineAction}>
                              <input
                                value={onboardIds[lead.id] ?? ""}
                                onChange={(e) => setOnboardIds((current) => ({ ...current, [lead.id]: e.target.value }))}
                                placeholder="BC-SHOP-000123"
                              />
                              <button type="button" className={styles.smallButton} disabled={busy === `onboard-${lead.id}`} onClick={() => void onboardLead(lead)}>
                                Attribute
                              </button>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className={styles.inlineButtons}>
                            {lead.status !== CrmLeadStatus.ONBOARDED && (
                              <button type="button" className={styles.smallButton} disabled={busy === `start-${lead.id}`} onClick={() => void startOnboarding(lead)}>
                                {busy === `start-${lead.id}` ? "Opening…" : "Start onboarding"}
                              </button>
                            )}
                            <Link className={styles.smallButton} href={`/employee/voice-onboarding/${lead.id}`}>
                              Start voice onboarding
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredLeads.length === 0 && <p className={styles.empty}>No leads match this search.</p>}
            </section>
          </>
        )}

        {tab === "visits" && (
          <>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Log field visit</h2><span>Visit history is attributed to your Employee ID</span></div>
              <form className={styles.formGrid} onSubmit={createVisit}>
                <label>Existing lead<select value={visitForm.leadId} onChange={(e) => setVisitForm({ ...visitForm, leadId: e.target.value })}>
                  <option value="">Standalone visit</option>
                  {leads.filter((lead) => lead.status !== CrmLeadStatus.ONBOARDED).map((lead) => <option key={lead.id} value={lead.id}>{lead.shopName}</option>)}
                </select></label>
                <label>Shop name (for standalone)<input value={visitForm.shopName} onChange={(e) => setVisitForm({ ...visitForm, shopName: e.target.value })} disabled={!!visitForm.leadId} /></label>
                <label>Outcome<select value={visitForm.outcome} onChange={(e) => setVisitForm({ ...visitForm, outcome: e.target.value as CrmVisitOutcome })}>
                  {Object.values(CrmVisitOutcome).map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
                </select></label>
                <label>Visit date/time<input type="datetime-local" value={visitForm.visitedAt} onChange={(e) => setVisitForm({ ...visitForm, visitedAt: e.target.value })} /></label>
                <label className={styles.spanTwo}>Notes<textarea value={visitForm.notes} onChange={(e) => setVisitForm({ ...visitForm, notes: e.target.value })} /></label>
                <div className={styles.formAction}><button className={styles.primaryButton} disabled={busy === "visit-create"}>{busy === "visit-create" ? "Saving…" : "Log visit"}</button></div>
              </form>
            </section>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Visit history</h2><span>{visits.length} records</span></div>
              <div className={styles.tableWrap}><table><thead><tr><th>Shop</th><th>When</th><th>Outcome</th><th>Notes</th></tr></thead>
                <tbody>{visits.map((visit) => <tr key={visit.id}>
                  <td><strong>{visit.shopName}</strong>{visit.leadShopName && <small>Lead: {visit.leadShopName}</small>}</td>
                  <td>{dateTime(visit.visitedAt)}</td><td><span className={styles.status}>{pretty(visit.outcome)}</span></td><td>{visit.notes ?? "—"}</td>
                </tr>)}</tbody></table></div>
            </section>
          </>
        )}

        {tab === "followups" && (
          <>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Schedule follow-up</h2><span>Calls, WhatsApp, visits or email</span></div>
              <form className={styles.formGrid} onSubmit={createFollowUp}>
                <label>Lead<select required value={followUpForm.leadId} onChange={(e) => setFollowUpForm({ ...followUpForm, leadId: e.target.value })}>
                  <option value="">Choose lead</option>
                  {leads.filter((lead) => lead.status !== CrmLeadStatus.ONBOARDED).map((lead) => <option key={lead.id} value={lead.id}>{lead.shopName}</option>)}
                </select></label>
                <label>Due date/time<input required type="datetime-local" value={followUpForm.dueAt} onChange={(e) => setFollowUpForm({ ...followUpForm, dueAt: e.target.value })} /></label>
                <label>Channel<select value={followUpForm.channel} onChange={(e) => setFollowUpForm({ ...followUpForm, channel: e.target.value as CrmFollowUpChannel })}>
                  {Object.values(CrmFollowUpChannel).map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
                </select></label>
                <label className={styles.spanTwo}>Notes<textarea value={followUpForm.notes} onChange={(e) => setFollowUpForm({ ...followUpForm, notes: e.target.value })} /></label>
                <div className={styles.formAction}><button className={styles.primaryButton} disabled={busy === "followup-create"}>{busy === "followup-create" ? "Saving…" : "Schedule follow-up"}</button></div>
              </form>
            </section>
            <section className={styles.panel}>
              <div className={styles.sectionHeader}><h2>Follow-up queue</h2><span>{overdueFollowUps.length} overdue</span></div>
              <div className={styles.tableWrap}><table><thead><tr><th>Lead</th><th>Due</th><th>Channel</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>{followUps.map((item) => {
                  const overdue = item.status === CrmFollowUpStatus.OPEN && new Date(item.dueAt).getTime() < Date.now();
                  return <tr key={item.id} className={overdue ? styles.overdueTableRow : undefined}>
                    <td><strong>{item.leadShopName}</strong><small>{item.notes ?? "No notes"}</small></td>
                    <td>{dateTime(item.dueAt)}{overdue && <small className={styles.overdueText}>Overdue</small>}</td>
                    <td>{pretty(item.channel)}</td><td><span className={styles.status}>{pretty(item.status)}</span></td>
                    <td>{item.status === CrmFollowUpStatus.OPEN ? <div className={styles.inlineButtons}>
                      <button type="button" className={styles.smallButton} disabled={busy === `followup-${item.id}`} onClick={() => void closeFollowUp(item, CrmFollowUpStatus.COMPLETED)}>Complete</button>
                      <button type="button" className={styles.smallButtonMuted} disabled={busy === `followup-${item.id}`} onClick={() => void closeFollowUp(item, CrmFollowUpStatus.CANCELLED)}>Cancel</button>
                    </div> : (item.outcome ?? "—")}</td>
                  </tr>;
                })}</tbody></table></div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
