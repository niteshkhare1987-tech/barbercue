"use client";

import type { ServiceDto } from "@barbercue/shared";
import {
  computePercentageDiscountPaise,
  formatMoney,
  MAX_SERVICES_PER_BOOKING,
  numberToPaise,
  paiseToRupees,
} from "@barbercue/shared";
import { Button } from "../ui/Button";
import styles from "./booking.module.css";

export function ServiceStep({
  services,
  selectedServiceIds,
  onToggle,
  currency,
  countryCode,
  onlineBookingDiscountPercent = 0,
  showStepNumber = true,
  maxServices = MAX_SERVICES_PER_BOOKING,
  disabled = false,
  onContinue,
}: {
  services: ServiceDto[];
  selectedServiceIds: string[];
  onToggle: (serviceId: string) => void;
  currency: string | null;
  countryCode?: string | null;
  onlineBookingDiscountPercent?: number;
  showStepNumber?: boolean;
  maxServices?: number;
  disabled?: boolean;
  onContinue?: () => void;
}) {
  const byId = new Map(services.map((service) => [service.id, service]));
  const selected = selectedServiceIds.flatMap((id) => {
    const service = byId.get(id);
    return service ? [service] : [];
  });
  const minutes = selected.reduce((sum, service) => sum + service.durationMinutes, 0);
  const subtotal = selected.reduce((sum, service) => sum + numberToPaise(service.price), 0);
  const discount = computePercentageDiscountPaise(subtotal, onlineBookingDiscountPercent);
  const money = (amount: number) => formatMoney(amount, currency, countryCode);
  const atLimit = selected.length >= maxServices;

  return (
    <section className={showStepNumber ? [styles.serviceStep, styles.stepCard].join(" ") : styles.serviceStep}>
      <h2 className={styles.stepHeading}>
        {showStepNumber && <span className={styles.stepNumber}>1</span>}
        Select services
      </h2>
      <div className={styles.serviceCartLayout}>
        <div className={styles.serviceList}>
          {services.length === 0 && <p className={styles.optionMeta}>No services available.</p>}
          {services.map((service) => {
            const isSelected = selectedServiceIds.includes(service.id);
            return (
              <button
                key={service.id}
                type="button"
                onClick={() => onToggle(service.id)}
                aria-pressed={isSelected}
                disabled={disabled || (atLimit && !isSelected)}
                className={`${styles.optionRow} ${styles.cartOption} ${isSelected ? styles.optionRowSelected : ""}`}
              >
                <span>
                  <span className={styles.optionName}>{service.name}</span>
                  <span className={styles.cartDuration}>{service.durationMinutes} min</span>
                </span>
                <span className={styles.optionPrice}>{money(service.price)}</span>
                <span className={styles.cartAdd} aria-hidden="true">{isSelected ? "✓" : "+"}</span>
              </button>
            );
          })}
          {atLimit && <p className={styles.optionMeta}>You can select up to {maxServices} services.</p>}
        </div>
        <aside className={styles.serviceCart} aria-label="Service cart">
          <h3>Your services</h3>
          {selected.length === 0 ? (
            <p className={styles.optionMeta}>Tap + to add services.</p>
          ) : (
            <ul className={styles.cartItems}>
              {selected.map((service) => (
                <li key={service.id}>
                  <span>{service.name}<small className={styles.cartDuration}>{service.durationMinutes} min</small></span>
                  <span>{money(service.price)}</span>
                  <button
                    type="button"
                    className={styles.cartRemove}
                    aria-label={`Remove ${service.name} from cart`}
                    disabled={disabled}
                    onClick={() => onToggle(service.id)}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.cartTotals} aria-live="polite" aria-atomic="true">
            {discount > 0 && <div><span>FastQue offer ({onlineBookingDiscountPercent}% off)</span><span>−{money(paiseToRupees(discount))}</span></div>}
            <div><strong>Total</strong><strong>{money(paiseToRupees(subtotal - discount))}</strong></div>
            {selected.length > 0 && <small className={styles.optionMeta}>{minutes} min total</small>}
          </div>
          {onContinue && (
            <div className={styles.cartContinue}>
              <Button type="button" variant="primary" fullWidth disabled={disabled || !selected.length} onClick={onContinue}>
                Continue
              </Button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
