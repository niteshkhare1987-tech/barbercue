"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AUTH_PATHS,
  type AuthMethodsDto,
  OTP_RESEND_COOLDOWN_SECONDS,
  otpRequestSchema,
  otpVerifySchema,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import { CustomerAuthCard } from "../../../components/auth/CustomerAuthCard";
import { AuthPageFallback } from "../../../components/auth/AuthCard";
import { GoogleIdentityButton } from "../../../components/auth/GoogleIdentityButton";
import authStyles from "../../../components/auth/customer-auth.module.css";
import { safeNextPath } from "../../../lib/safe-next-path";

type Step = "phone" | "otp";

function CustomerLoginForm() {
  const { verifyCustomerOtp, googleLogin } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Whether this deployment can actually complete a phone OTP. Null while unknown — the form is
  // hidden until we know, so a customer is never shown an input that is guaranteed to 502.
  const [phoneOtpAvailable, setPhoneOtpAvailable] = useState<boolean | null>(null);
  const [resending, setResending] = useState(false);
  // Seconds remaining before "Resend OTP" is enabled again; 0 = enabled. Starts counting the
  // moment a code is sent (initial send or a resend) — a client-side throttle only, layered on
  // top of (never replacing) OtpService's server-side per-phone rate limit.
  const [resendCooldown, setResendCooldown] = useState(0);

  // Ticks the cooldown down once a second while on the OTP step. Cleared on unmount/step change
  // so no stale timer fires after the user leaves this screen.
  useEffect(() => {
    if (step !== "otp" || resendCooldown <= 0) return undefined;
    const timer = setInterval(() => {
      setResendCooldown((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [step, resendCooldown]);

  async function handleGoogleCredential(idToken: string) {
    setError(null);
    setSubmitting(true);
    try {
      await googleLogin({ idToken });
      router.replace(safeNextPath(searchParams.get("next")) ?? "/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in with Google. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendOtp(targetPhone: string): Promise<void> {
    await apiFetch(`auth/${AUTH_PATHS.otpRequest}`, {
      method: "POST",
      body: JSON.stringify({ phone: targetPhone }),
    });
  }

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = otpRequestSchema.safeParse({ phone });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid phone number.");
      return;
    }
    setSubmitting(true);
    try {
      await sendOtp(parsed.data.phone);
      setStep("otp");
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send OTP. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    // Belt-and-braces guard against a stray click landing between disabled-state re-renders —
    // the button is already disabled during cooldown/in-flight, this just makes it non-negotiable.
    if (resendCooldown > 0 || resending) return;
    setError(null);
    setResendMessage(null);
    setResending(true);
    try {
      await sendOtp(phone);
      setResendMessage("A new code was requested. It may take a moment to arrive.");
    } catch (err) {
      // The backend's OTP_RATE_LIMITED message is already written for end users (see
      // OtpService) — surfaced as-is rather than replaced with a generic string.
      setError(err instanceof ApiError ? err.message : "Could not resend the code. Please try again.");
    } finally {
      // Restart the cooldown on both success and failure — on failure this also prevents
      // hammering the resend button (and the server's rate limit) with instant retries.
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS);
      setResending(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResendMessage(null);
    const parsed = otpVerifySchema.safeParse({ phone, code });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid code.");
      return;
    }
    setSubmitting(true);
    try {
      await verifyCustomerOtp(parsed.data);
      router.replace(safeNextPath(searchParams.get("next")) ?? "/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify OTP. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuthMethodsDto>(`auth/${AUTH_PATHS.methods}`)
      .then((m) => {
        if (!cancelled) setPhoneOtpAvailable(m.phoneOtp === true);
      })
      // Fail closed: a phone form must not claim SMS is available when the server's capability probe
      // failed. Google sign-in stays available independently.
      .catch(() => {
        if (!cancelled) setPhoneOtpAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <CustomerAuthCard>
        {error && <p className={authStyles.errorMessage} role="alert">{error}</p>}
        {resendMessage && <p className={authStyles.successMessage} role="status">{resendMessage}</p>}
        {step === "phone" ? (
          <>
            <GoogleIdentityButton
              audienceLabel="customer"
              onCredential={(token) => void handleGoogleCredential(token)}
              disabled={submitting}
            />
            {phoneOtpAvailable === false ? (
              <p className={authStyles.noticeMessage}>
                Phone sign-in is temporarily unavailable. Please continue with Google above —
                it&apos;s the same account either way.
              </p>
            ) : (
              <>
                <div className={authStyles.divider} aria-hidden="true">OR</div>
                <p className={authStyles.contextLine}>New here? Signing in creates your customer account automatically.</p>
                {phoneOtpAvailable === null ? (
                  <p className={authStyles.contextLine} role="status">Checking sign-in options…</p>
                ) : (
                  <form onSubmit={requestOtp} className={authStyles.form}>
                    <div className={authStyles.field}>
                      <label htmlFor="customer-phone">Mobile number</label>
                      <input
                        id="customer-phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="+91 98765 43210"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className={authStyles.input}
                      />
                    </div>
                    <button type="submit" className={authStyles.primaryButton} disabled={submitting}>
                      {submitting ? "Sending…" : "Send one-time code"}
                    </button>
                  </form>
                )}
              </>
            )}
          </>
        ) : (
          <form onSubmit={verifyOtp} className={authStyles.form}>
            <p className={authStyles.contextLine}>Enter the 6-digit code for <strong>{phone}</strong>. SMS delivery may take a moment.</p>
            <div className={authStyles.field}>
              <label htmlFor="customer-otp">One-time code</label>
              <input
                id="customer-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={authStyles.input}
                autoFocus
              />
            </div>
            <button type="submit" className={authStyles.primaryButton} disabled={submitting}>
              {submitting ? "Verifying…" : "Verify and continue"}
            </button>
            <button
              type="button"
              className={authStyles.secondaryButton}
              onClick={() => void handleResend()}
              disabled={resendCooldown > 0 || resending}
            >
              {resending
                ? "Resending…"
                : resendCooldown > 0
                  ? `Resend OTP in ${resendCooldown}s`
                  : "Resend OTP"}
            </button>
          </form>
        )}
      </CustomerAuthCard>
    </>
  );
}

export default function CustomerLoginPage() {
  return (
    <Suspense fallback={<AuthPageFallback audience="customer" />}>
      <CustomerLoginForm />
    </Suspense>
  );
}
