"use client";

import { useParams } from "next/navigation";
import { EmployeeOnboardingShell } from "../../../../components/onboarding/EmployeeOnboardingShell";
import { OnboardingWizard } from "../../../../components/onboarding/OnboardingWizard";

export default function EmployeeOnboardingApplicationPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <EmployeeOnboardingShell>
      <OnboardingWizard applicationId={id} />
    </EmployeeOnboardingShell>
  );
}
