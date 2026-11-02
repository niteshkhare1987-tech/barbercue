"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OnboardingApplicationDto } from "@barbercue/shared";
import { ApiError, apiFetch } from "../../../../lib/api";
import { EMPLOYEE_ONBOARDING } from "../../../../lib/onboarding";
import { EmployeeOnboardingShell } from "../../../../components/onboarding/EmployeeOnboardingShell";
import base from "../../employee.module.css";
import styles from "../onboarding.module.css";

/** Direct onboarding (no existing lead): the server creates and links the lead automatically. */
export default function NewOnboardingPage() {
  const router = useRouter();
  const [salonName, setSalonName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<OnboardingApplicationDto>(EMPLOYEE_ONBOARDING, {
        method: "POST",
        body: JSON.stringify({
          salonName,
          ...(ownerName.trim() ? { ownerName } : {}),
          ...(ownerPhone.trim() ? { ownerPhone } : {}),
        }),
      });
      router.replace(`/employee/onboarding/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the application.");
      setBusy(false);
    }
  };

  return (
    <EmployeeOnboardingShell>
      <section className={base.panel}>
        <div className={styles.heading}>
          <h2>New salon onboarding</h2>
          <small>Starts a draft you can finish in steps. A CRM lead is created for you.</small>
        </div>
        {error && <p className={base.error} role="alert">{error}</p>}
        <form className={styles.fields} onSubmit={start}>
          <label className={styles.full}>
            <span className={styles.required}>Salon name</span>
            <input required maxLength={160} value={salonName} onChange={(e) => setSalonName(e.target.value)} />
          </label>
          <label>
            Owner&apos;s name
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label>
            Owner&apos;s mobile
            <input type="tel" inputMode="tel" placeholder="10-digit mobile" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} />
          </label>
          <div className={base.formAction}>
            <button className={base.primaryButton} disabled={busy || !salonName.trim()}>
              {busy ? "Starting…" : "Start onboarding"}
            </button>
          </div>
        </form>
      </section>
    </EmployeeOnboardingShell>
  );
}
