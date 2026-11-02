import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuthErrorCode } from '@barbercue/shared';
import { AppException } from '../../common/exceptions/app.exception';
import type { EmailSender } from './email-sender';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface ResendErrorBody {
  message?: string;
  name?: string;
}

/**
 * Production transactional email via Resend's single-endpoint HTTP API (no SMTP, no library
 * beyond the platform `fetch` already used by TwoFactorOtpSender). Chosen for the same
 * "smallest reliable solution" reason as 2Factor for SMS: one API key, one POST per email, no
 * queue/webhook infrastructure required for launch. Requires:
 *   - RESEND_API_KEY: the account's API key (Resend dashboard -> API Keys).
 *   - EMAIL_FROM_ADDRESS: a "from" address at a domain verified in Resend (Domains -> Verify).
 *     Sending from an unverified domain is rejected by Resend itself before this code runs.
 * Never logs the API key, the recipient's raw email is only ever logged on failure (matching
 * TwoFactorOtpSender's convention of logging enough to debug without logging secrets), and the
 * reset/invite URL itself (which embeds a live single-use token) is never logged at all.
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailSender (Resend)');

  assertAvailable(): void {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM_ADDRESS) {
      this.logger.error(
        'RESEND_API_KEY or EMAIL_FROM_ADDRESS is not configured; cannot send transactional email.',
      );
      throw this.deliveryUnavailable();
    }
  }

  async sendPasswordReset(
    email: string,
    resetUrl: string,
    expiresInMinutes: number,
  ): Promise<void> {
    await this.send(
      email,
      'Reset your FastQue password',
      `<p>Click the link below to reset your password. This link expires in ${expiresInMinutes} minutes and can only be used once.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
    );
  }

  async sendStaffInvitation(
    email: string,
    setupUrl: string,
    expiresInDays: number,
  ): Promise<void> {
    await this.send(
      email,
      "You've been invited to FastQue",
      `<p>Click the link below to set your password and finish joining your team. This link expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}.</p><p><a href="${setupUrl}">${setupUrl}</a></p>`,
    );
  }

  async sendOwnerInvitation(
    email: string,
    salonName: string,
    setupUrl: string,
    expiresInHours: number,
  ): Promise<void> {
    const safeName = salonName.replace(/[<>&"']/g, '');
    await this.send(
      email,
      `Your FastQue account for ${safeName}`,
      `<p>${safeName} has been approved on FastQue. Click the link below to set your own password and open your salon dashboard. FastQue will never send you a password.</p><p>This link can be used once and expires in ${expiresInHours} hours.</p><p><a href="${setupUrl}">${setupUrl}</a></p>`,
    );
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    this.assertAvailable();
    const apiKey = process.env.RESEND_API_KEY as string;
    const from = process.env.EMAIL_FROM_ADDRESS as string;

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      });
    } catch (err) {
      this.logger.error(
        `Resend request failed before a response was received: ${err instanceof Error ? err.message : 'unknown network error'}`,
      );
      throw this.deliveryUnavailable();
    }

    if (!response.ok) {
      let body: ResendErrorBody | null = null;
      try {
        body = (await response.json()) as ResendErrorBody;
      } catch {
        body = null;
      }
      // Provider error detail is safe to log (Resend's own message/name), never the recipient
      // address alongside it and never the email body (which carries the live reset/invite URL).
      this.logger.error(
        `Resend email delivery failed (HTTP ${response.status}): ${body?.message ?? body?.name ?? 'no response body'}`,
      );
      throw this.deliveryUnavailable();
    }
  }

  private deliveryUnavailable(): AppException {
    return new AppException(
      AuthErrorCode.EMAIL_DELIVERY_UNAVAILABLE,
      'Email delivery is temporarily unavailable. Please try again later.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
