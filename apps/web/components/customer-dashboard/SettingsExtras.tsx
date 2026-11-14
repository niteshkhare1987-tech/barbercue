"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DISCOVERY_PATHS, type CityDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { savePrefs, useCustomerPrefs } from "../../lib/customer-preferences";
import { clearRecent } from "../../lib/recently-viewed";
import styles from "./dash.module.css";

/** Settings › Location. Preferred city is stored on this device; GPS is read only on tap. */
export function LocationSettings() {
  const prefs = useCustomerPrefs();
  const router = useRouter();
  const [cities, setCities] = useState<CityDto[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    apiFetch<CityDto[]>(DISCOVERY_PATHS.cities)
      .then((list) => setCities([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setCities([]));
  }, []);

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setStatus("Location isn’t available in this browser. Choose a city instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p = new URLSearchParams({ lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) });
        router.push(`/account/discover?${p}`);
      },
      () => {
        setLocating(false);
        setStatus("Location wasn’t shared. You can still search by city.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  return (
    <section id="location" className={styles.card} aria-labelledby="location-title" style={{ scrollMarginTop: 180 }}>
      <h2 id="location-title" className={styles.sectionTitle}>Location</h2>
      <p className={styles.meta} style={{ margin: "6px 0 14px" }}>
        Your preferred city is used to start searches. It’s saved on this device only. FastQue asks for your precise location only
        when you tap “Use my current location”, and never tracks it in the background.
      </p>
      <div className={styles.filters}>
        <label className={styles.field}>
          Preferred city
          <select
            value={prefs.preferredCity?.slug ?? ""}
            disabled={!cities}
            onChange={(e) => {
              const city = cities?.find((c) => c.slug === e.target.value);
              savePrefs({ preferredCity: city ? { slug: city.slug, name: city.name, countryCode: city.countryCode } : null });
              setStatus(city ? `Saved ${city.name} as your preferred city.` : "Preferred city cleared.");
            }}
          >
            <option value="">{cities ? "No preference" : "Loading cities…"}</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.slug}>{c.name}{c.state ? `, ${c.state}` : ""}</option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.btn} onClick={useCurrentLocation} disabled={locating}>
          {locating ? "Locating…" : "Use my current location"}
        </button>
      </div>
      {status && <p className={styles.meta} role="status" style={{ marginTop: 10 }}>{status}</p>}
    </section>
  );
}

/** Settings › Privacy & account. Uses only flows that exist; nothing is deleted without confirmation. */
export function PrivacySettings() {
  const [status, setStatus] = useState<string | null>(null);

  async function clearHistory() {
    if (!window.confirm("Clear your recently viewed salons on this account and device?")) return;
    try {
      await clearRecent(true);
      setStatus("Recently viewed history cleared.");
    } catch {
      setStatus("Couldn’t clear your history. Try again.");
    }
  }

  return (
    <section className={styles.card} aria-labelledby="privacy-title">
      <h2 id="privacy-title" className={styles.sectionTitle}>Privacy &amp; account</h2>
      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }}>
        <li><Link href="/privacy-policy">Read the privacy policy</Link></li>
        <li>
          <button type="button" className={styles.btnGhost} style={{ padding: 0 }} onClick={() => void clearHistory()}>
            Clear recently viewed history
          </button>
        </li>
        <li>
          <Link href="/contact-us">Request a copy of your data</Link>
          <span className={styles.meta}> — handled by our support team; there’s no self-serve export yet.</span>
        </li>
        <li><Link href="/account-deletion">Request account deletion</Link></li>
      </ul>
      <p className={styles.meta} style={{ marginTop: 10 }}>
        Booking and queue messages are transactional and are always sent. Marketing messages need your opt-in in Notification
        preferences above.
      </p>
      {status && <p className={styles.meta} role="status">{status}</p>}
    </section>
  );
}
