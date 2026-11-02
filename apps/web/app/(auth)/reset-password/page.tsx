"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AUTH_PATHS, passwordAudienceSchema, resetPasswordSchema } from "@barbercue/shared";
import { ApiError, apiFetch } from "../../../lib/api";
import { AuthCard, AuthPageFallback } from "../../../components/auth/AuthCard";
import authStyles from "../../../components/auth/customer-auth.module.css";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const audienceResult = passwordAudienceSchema.safeParse(searchParams.get("audience"));
  const audience = audienceResult.success ? audienceResult.data : "staff";
  const loginPath = audience === "owner" ? "/owner/login" : audience === "admin" ? "/admin/login" : "/staff/login";
  // Invitation links (staff invites, salon-onboarding owner invites) set a first password.
  const invite = searchParams.get("intent") === "invite";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = resetPasswordSchema.safeParse({ token, newPassword, confirmPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`auth/${AUTH_PATHS.resetPassword}`, { method: "POST", body: JSON.stringify(parsed.data) });
      setDone(true);
      setTimeout(() => router.replace(loginPath), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "This reset link is invalid or has expired.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthCard audience="recovery" title="This reset link is incomplete" showAudienceLinks={false}>
        <p className={authStyles.errorMessage} role="alert">
          This link is missing a reset token. Request a new link from the password recovery page.
        </p>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard audience="recovery" title="Password updated" showAudienceLinks={false}>
        <p className={authStyles.successMessage} role="status">
          You can now sign in with your new password. Taking you to {audience} sign-in…
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      audience="recovery"
      title={invite ? "Set up your FastQue password" : "Choose a new password"}
      subtitle={
        invite
          ? "Choose your own password to activate your account. This link works once; FastQue never sends passwords."
          : "Set the new password for this owner, staff or administrator account."
      }
      showAudienceLinks={false}
    >
      <form onSubmit={handleSubmit} className={authStyles.form}>
        {error && <p className={authStyles.errorMessage} role="alert">{error}</p>}
        <div className={authStyles.field}>
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Enter a new password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={authStyles.input}
            autoFocus
          />
        </div>
        <div className={authStyles.field}>
          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Repeat your new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={authStyles.input}
          />
        </div>
        <label className={authStyles.passwordToggle}>
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(event) => setShowPassword(event.target.checked)}
          />
          Show passwords
        </label>
        <p className={authStyles.contextLine}>Use 8–72 characters. A successful reset signs out every existing session.</p>
        <button type="submit" className={authStyles.primaryButton} disabled={submitting}>
          {submitting ? "Updating…" : invite ? "Activate account" : "Update password"}
        </button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthPageFallback audience="recovery" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
