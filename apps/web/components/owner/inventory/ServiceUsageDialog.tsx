"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SERVICE_USAGE_PATHS,
  type InventoryUnit,
  type RecordServiceUsageResultDto,
  type UsageProductOptionDto,
  type VisitUsageOptionsDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { quantityText, trimDecimal, unitShort, UNIT_OPTIONS } from "../../../lib/inventory";
import { Banner, Btn, Dialog } from "../parts";
import ui from "../owner.module.css";
import styles from "./usage.module.css";

type Pick = {
  key: string;
  ruleId: string | null;
  label: string;
  /** Products offered as photo cards for this line (its category), best first. */
  choices: string[];
  productId: string | null;
  quantity: string;
  unit: InventoryUnit;
};

const visitPath = (queueEntryId: string) => `dashboard/${SERVICE_USAGE_PATHS.queueEntries}/${queueEntryId}/${SERVICE_USAGE_PATHS.productUsage}`;
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);

/** One pick per recipe line; only a salon-approved default product is chosen in advance. */
function initialPicks(options: VisitUsageOptionsDto): Record<string, Pick[]> {
  const stocked = new Set(options.products.map((p) => p.productId));
  return Object.fromEntries(
    options.services
      .filter((s) => !s.recorded)
      .map((s) => [
        s.serviceId,
        s.lines.map((l) => ({
          key: l.id,
          ruleId: l.id,
          label: `${l.categoryName} · ${trimDecimal(l.quantity)} ${unitShort(l.unit)}`,
          choices: l.productIds,
          productId: l.defaultProductId && stocked.has(l.defaultProductId) ? l.defaultProductId : null,
          quantity: trimDecimal(l.quantity),
          unit: l.unit,
        })),
      ]),
  );
}

/** Units that make sense for a product: its stock unit, what one piece contains, and the recipe's unit. */
function unitChoices(product: UsageProductOptionDto | undefined, current: InventoryUnit): InventoryUnit[] {
  const set = new Set<InventoryUnit>([current]);
  if (product) {
    set.add(product.unit);
    if (product.contentUnit) set.add(product.contentUnit);
  }
  return [...set];
}

/**
 * "Which products did you use?" for one visit — large photo cards per recipe line and service, a
 * product's stock under its photo, amounts that can be changed, and "something else was used".
 * In "complete" mode it is the step before completing the service: with no recipes for these
 * services it completes straight away, exactly as before; staff can always complete without
 * recording. Saving is one request for the whole visit and is safe to repeat.
 */
export function ServiceUsageDialog({
  queueEntryId,
  mode,
  onClose,
  onComplete,
  onSaved,
}: {
  queueEntryId: string;
  mode: "complete" | "record";
  onClose: () => void;
  /** Completes the service (complete mode). */
  onComplete?: () => Promise<unknown> | void;
  onSaved?: (message: string) => void;
}) {
  const [options, setOptions] = useState<VisitUsageOptionsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handedOff = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<VisitUsageOptionsDto>(visitPath(queueEntryId))
      .then((o) => {
        if (cancelled) return;
        if (mode === "complete" && !o.hasAnythingToRecord && !handedOff.current) {
          // No recipes for these services: complete exactly as before, without a product step.
          handedOff.current = true;
          onClose();
          void onComplete?.();
          return;
        }
        setOptions(o);
        setPicks(initialPicks(o));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorText(err, "The products for this visit could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per opened dialog
  }, [queueEntryId]);

  const byId = useMemo(() => new Map((options?.products ?? []).map((p) => [p.productId, p])), [options]);
  const chosen = Object.entries(picks)
    .map(([serviceId, items]) => ({ serviceId, items: items.filter((i) => i.productId && Number(i.quantity) > 0) }))
    .filter((s) => s.items.length > 0);
  const pending = options?.services.filter((s) => !s.recorded) ?? [];

  const update = (serviceId: string, key: string, patch: Partial<Pick>) =>
    setPicks((all) => ({ ...all, [serviceId]: all[serviceId].map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  const addExtra = (serviceId: string) =>
    setPicks((all) => ({
      ...all,
      [serviceId]: [
        ...all[serviceId],
        { key: `extra-${Date.now()}`, ruleId: null, label: "Something else", choices: options!.products.map((p) => p.productId), productId: null, quantity: "1", unit: "EACH" },
      ],
    }));

  async function complete() {
    setBusy(true);
    try {
      await onComplete?.();
      onClose();
    } catch (err) {
      setError(errorText(err, "The service could not be completed — try again."));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!chosen.length) return mode === "complete" ? complete() : setError("Tap the products that were used.");
    const bad = chosen.flatMap((s) => s.items).find((i) => !Number.isFinite(Number(i.quantity)) || Number(i.quantity) <= 0);
    if (bad) return setError("Amounts must be numbers above 0.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch<RecordServiceUsageResultDto>(visitPath(queueEntryId), {
        method: "POST",
        body: JSON.stringify({
          services: chosen.map((s) => ({
            serviceId: s.serviceId,
            items: s.items.map((i) => ({ productId: i.productId, quantity: Math.round(Number(i.quantity) * 1000) / 1000, unit: i.unit, ruleId: i.ruleId })),
          })),
        }),
      });
      const count = chosen.reduce((n, s) => n + s.items.length, 0);
      onSaved?.(`${count} product${count === 1 ? "" : "s"} taken off stock.`);
      if (mode === "complete") {
        await onComplete?.();
      }
      onClose();
    } catch (err) {
      setError(errorText(err, "The products were not saved — try again."));
    } finally {
      setBusy(false);
    }
  }

  const title = options ? `Products used · #${options.tokenNumber}${options.customerName ? ` ${options.customerName}` : ""}` : "Products used";

  return (
    <Dialog title={title} onClose={onClose} wide>
      {!options && !loadError && <p className={ui.cardSub}>Loading the products for this visit…</p>}
      {loadError && (
        <>
          <Banner tone="error">{loadError}</Banner>
          {mode === "complete" && (
            <div className={ui.dialogActions}>
              <Btn variant="primary" icon="check" disabled={busy} onClick={() => void complete()}>Complete without recording</Btn>
            </div>
          )}
        </>
      )}
      {options && (
        <>
          <p className={ui.cardSub}>Tap the photo of each product you used. Change the amount if you used more or less.</p>
          {options.services.map((service) => (
            <section key={service.serviceId} className={styles.service} aria-label={service.serviceName}>
              <h3 className={styles.serviceName}>{service.serviceName}</h3>
              {service.recorded ? (
                <p className={ui.cardSub}>
                  Already recorded: {service.recorded.items.map((i) => `${i.productName} ${trimDecimal(i.enteredQuantity)} ${unitShort(i.enteredUnit)}`).join(", ")}.
                </p>
              ) : (picks[service.serviceId] ?? []).length === 0 ? (
                <p className={ui.cardSub}>No products are set up for this service.</p>
              ) : (
                (picks[service.serviceId] ?? []).map((pick) => {
                  const product = pick.productId ? byId.get(pick.productId) : undefined;
                  return (
                    <div key={pick.key} className={styles.line}>
                      <div className={styles.lineHead}>{pick.label}</div>
                      {pick.choices.length === 0 ? (
                        <p className={ui.hint}>No product in stock for this. Add one under Inventory → Products.</p>
                      ) : (
                        <div className={styles.cards} role="group" aria-label={pick.label}>
                          {pick.choices.map((id) => {
                            const p = byId.get(id)!;
                            const selected = pick.productId === id;
                            const empty = Number(p.stockOnHand) <= 0;
                            return (
                              <button
                                key={id}
                                type="button"
                                className={`${styles.card} ${selected ? styles.cardSelected : ""}`}
                                aria-pressed={selected}
                                onClick={() =>
                                  update(service.serviceId, pick.key, {
                                    productId: selected ? null : id,
                                    ...(pick.ruleId ? {} : { unit: p.contentUnit ?? p.unit }),
                                  })
                                }
                              >
                                <span className={styles.photo}>
                                  {p.imageUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element -- catalog/salon product photos
                                    <img src={p.imageUrl} alt="" />
                                  ) : (
                                    <span aria-hidden="true">📦</span>
                                  )}
                                </span>
                                <span className={styles.cardName}>{p.name}</span>
                                {p.brand && <span className={styles.cardMeta}>{p.brand}</span>}
                                <span className={`${styles.cardMeta} ${empty ? styles.cardEmpty : ""}`}>{empty ? "None left" : `${quantityText(p.stockOnHand, p.unit)} left`}</span>
                                {p.recentRank !== null && p.recentRank < 3 && <span className={styles.recent}>Used recently</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {pick.productId && (
                        <div className={styles.amount}>
                          <label className={ui.label} htmlFor={`amt-${pick.key}`}>Amount used</label>
                          <div className={styles.amountRow}>
                            <Btn small variant="quiet" aria-label="Less" onClick={() => update(service.serviceId, pick.key, { quantity: String(Math.max(0, Math.round((Number(pick.quantity) - 1) * 1000) / 1000)) })}>−</Btn>
                            <input id={`amt-${pick.key}`} className={`${ui.input} ${styles.amountInput}`} inputMode="decimal" value={pick.quantity} onChange={(e) => update(service.serviceId, pick.key, { quantity: e.target.value })} />
                            <Btn small variant="quiet" aria-label="More" onClick={() => update(service.serviceId, pick.key, { quantity: String(Math.round((Number(pick.quantity) + 1) * 1000) / 1000) })}>+</Btn>
                            <select aria-label="Unit" className={`${ui.input} ${styles.unit}`} value={pick.unit} onChange={(e) => update(service.serviceId, pick.key, { unit: e.target.value as InventoryUnit })}>
                              {unitChoices(product, pick.unit).map((u) => (
                                <option key={u} value={u}>{UNIT_OPTIONS.find((o) => o.value === u)?.label ?? u}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              {!service.recorded && options.products.length > 0 && (
                <Btn small variant="quiet" onClick={() => addExtra(service.serviceId)}>+ Something else was used</Btn>
              )}
            </section>
          ))}
          {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
          <div className={ui.dialogActions}>
            {mode === "complete" ? (
              <>
                <Btn variant="quiet" disabled={busy} onClick={() => void complete()}>Complete without recording</Btn>
                <Btn variant="primary" icon="check" disabled={busy} onClick={() => void save()}>
                  {busy ? "Saving…" : pending.length === 0 || chosen.length === 0 ? "Complete service" : "Save and complete"}
                </Btn>
              </>
            ) : (
              <>
                <Btn variant="quiet" disabled={busy} onClick={onClose}>Cancel</Btn>
                <Btn variant="primary" disabled={busy || pending.length === 0} onClick={() => void save()}>{busy ? "Saving…" : "Save products used"}</Btn>
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
