import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AdminTotpBootstrapController } from './admin-totp-bootstrap.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { OtpService } from './services/otp.service';
import { TotpService } from './services/totp.service';
import { CryptoService } from './services/crypto.service';
import { GoogleAuthService } from './services/google-auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OTP_SENDER, UnavailableOtpSender } from './services/otp-sender';
import { TwoFactorOtpSender } from './services/two-factor-otp-sender';
import { isPhoneOtpConfigured } from './services/otp-config';
import {
  EMAIL_SENDER,
  ConsoleEmailSender,
  UnavailableProductionEmailSender,
} from './services/email-sender';
import { ResendEmailSender } from './services/resend-email-sender';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PassportModule,
    NotificationsModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
      // Per-call expiresIn (TokenService) always wins; this is just a safe fallback.
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController, AdminTotpBootstrapController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    OtpService,
    TotpService,
    CryptoService,
    GoogleAuthService,
    JwtStrategy,
    // No development console OTP: OTP values and phone numbers must never be written to logs.
    // Production dispatch is enabled only when provider/template, keyed-hash secret, explicit
    // country allowlist, and all hard send ceilings are valid; otherwise it fails closed.
    UnavailableOtpSender,
    TwoFactorOtpSender,
    {
      provide: OTP_SENDER,
      useFactory: (
        unavailableSender: UnavailableOtpSender,
        twoFactorSender: TwoFactorOtpSender,
      ) => (isPhoneOtpConfigured() ? twoFactorSender : unavailableSender),
      inject: [UnavailableOtpSender, TwoFactorOtpSender],
    },
    ConsoleEmailSender,
    UnavailableProductionEmailSender,
    ResendEmailSender,
    {
      provide: EMAIL_SENDER,
      // Same fail-closed shape as OTP_SENDER above: production only ever gets a real transport
      // when it's actually configured (RESEND_API_KEY + EMAIL_FROM_ADDRESS both present) —
      // otherwise it keeps failing closed via UnavailableProductionEmailSender exactly as
      // before, rather than silently downgrading to the console capture.
      useFactory: (
        consoleSender: ConsoleEmailSender,
        unavailableSender: UnavailableProductionEmailSender,
        resendSender: ResendEmailSender,
      ) => {
        if (process.env.NODE_ENV !== 'production') return consoleSender;
        return process.env.RESEND_API_KEY && process.env.EMAIL_FROM_ADDRESS
          ? resendSender
          : unavailableSender;
      },
      inject: [
        ConsoleEmailSender,
        UnavailableProductionEmailSender,
        ResendEmailSender,
      ],
    },
  ],
  // EMAIL_SENDER is exported (Phase 11) so SalonSetupModule can deliver barber invitations
  // through the same transport the forgot-password flow already uses, rather than binding a
  // second EmailSender of its own. No auth behavior changes — this is an export-list addition.
  exports: [
    TokenService,
    PasswordService,
    TotpService,
    CryptoService,
    EMAIL_SENDER,
  ],
})
export class AuthModule {}
