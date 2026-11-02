"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Role } from "@barbercue/shared";
import { useAuth } from "../../lib/auth-context";
import base from "../../app/employee/employee.module.css";

/** Employee portal frame for the onboarding pages: same header, same FIELD_EXECUTIVE gate. */
export function EmployeeOnboardingShell({ children }: { children: React.ReactNode }) {
  const { user, status } = useAuth();
  const router = useRouter();
  const allowed = status === "authenticated" && !!user?.roles.includes(Role.FIELD_EXECUTIVE);

  useEffect(() => {
    if (status === "loading") return;
    if (!allowed) router.replace("/employee/login");
  }, [allowed, router, status]);

  return (
    <main className={base.page}>
      <div className={base.shell}>
        <header className={base.topbar}>
          <div>
            <span className={base.eyebrow}>FastQue Field CRM</span>
            <strong>Salon Onboarding</strong>
          </div>
          <div className={base.topActions}>
            <Link className={base.secondaryButton} href="/employee?tab=onboarding">
              ← All applications
            </Link>
          </div>
        </header>
        {allowed ? children : <p className={base.empty} aria-busy="true">Checking your access…</p>}
      </div>
    </main>
  );
}
