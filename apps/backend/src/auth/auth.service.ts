import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import {
  AuthErrorCode,
  AuthProvider,
  Role,
  OtpPurpose,
  SessionAudience,
  UserStatus,
  type AuthSession,
  type AuthTokens,
  Language,
  type MeResponse,
  type PasswordAudience,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { OtpService } from './services/otp.service';
import { TotpService } from './services/totp.service';
import { CryptoService } from './services/crypto.service';
import { GoogleAuthService } from './services/google-auth.service';
import { EMAIL_SENDER, type EmailSender } from './services/email-sender';
import {
  buildPasswordLink,
  passwordWebBaseUrl,
} from './services/password-link';
import { NotificationsService } from '../notifications/notifications.service';
import { acceptOnboardingInvitationInTx } from '../onboarding/onboarding-invitation';

const PASSWORD_RESET_TTL_MINUTES = 15;
const GLOBAL_ADMIN_DASHBOARD_ROLES = new Set<Role>([
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.HR_ADMIN,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
]);

function hasGlobalAdminDashboardRole(
  roles: Array<{ role: Role; salonId: string | null }>,
): boolean {
  return roles.some(
    ({ role, salonId }) =>
      salonId === null && GLOBAL_ADMIN_DASHBOARD_ROLES.has(role),
  );
}

function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly otpService: OtpService,
    private readonly totpService: TotpService,
    private readonly cryptoService: CryptoService,
    private readonly googleAuthService: GoogleAuthService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    // Optional so existing construction sites keep working; used only to tell admins and the
    // field employee that an onboarded salon's owner has activated their account.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------- Customer: phone OTP ----------

  requestCustomerOtp(phone: string) {
    return this.otpService.requestOtp(phone, OtpPurpose.LOGIN);
  }

  async verifyCustomerOtp(
    phone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    await this.otpService.verifyOtp(phone, code, OtpPurpose.LOGIN);

    let user = await this.prisma.user.findUnique({
      where: { phone },
      include: { roles: true },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone,
          phoneVerifiedAt: new Date(),
          roles: { create: { role: Role.CUSTOMER } },
        },
        include: { roles: true },
      });
    } else if (!user.phoneVerifiedAt) {
      // OTP proves control of a number, not ownership of an older account whose phone was
      // never verified. Require an existing identity login and authenticated phone linking.
      // This prevents a recycled number from inheriting an existing account's roles.
      throw new AppException(
        AuthErrorCode.OTP_INVALID,
        'The verification code is invalid or expired. Request a new code and try again.',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.assertActive(user.status);

    // Same CUSTOMER-guarantee semantics as googleLogin (see that method's own doc comment): an
    // existing staff/owner/admin User row that phone-verifies via OTP for the first time is
    // guaranteed CUSTOMER access too — a no-op for the common case (brand-new user or an existing
    // customer) — never removes or alters any role the user already has. `roles` here is
    // deliberately the FULL, unscoped set (needed to decide whether a CUSTOMER row must be
    // created); it is never what gets issued into the token — see sessionRoles below for that.
    let roles = user.roles.map((r) => r.role);
    if (!roles.includes(Role.CUSTOMER)) {
      await this.prisma.userRole.create({
        data: { userId: user.id, role: Role.CUSTOMER },
      });
      roles = [...roles, Role.CUSTOMER];
    }

    // Security fix: customer OTP login is a CUSTOMER-audience session — this User row may also
    // hold PLATFORM_ADMIN/staff roles (same real person, different login surface), but this login
    // path must never assert them. scopeRolesToAudience is the single choke point that enforces
    // that, so the value used here and the value actually signed into the token can never diverge.
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      roles,
      SessionAudience.CUSTOMER,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.CUSTOMER,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.CUSTOMER,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Shop owner: independently authorized phone OTP ----------

  /**
   * Owner OTP never creates an account and never trusts the salon's public contact number. A
   * phone must already be attached and verified on an active User, with a SALON_OWNER role whose
   * salon points back to that same user through Salon.ownerUserId.
   */
  async requestOwnerOtp(phone: string): Promise<{ expiresInSeconds: number }> {
    const owner = await this.findVerifiedOwnerByPhone(phone);
    // Keep the public response shape identical for unknown/non-owner numbers. No SMS is sent and
    // no challenge is created for those accounts, avoiding account enumeration and SMS pumping.
    if (!owner) return { expiresInSeconds: 300 };
    return this.otpService.requestOtp(phone, OtpPurpose.OWNER_LOGIN, owner.id);
  }

  async verifyOwnerOtp(
    phone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const owner = await this.findVerifiedOwnerByPhone(phone);
    if (!owner) throw this.invalidOwnerCredentials();

    try {
      await this.otpService.verifyOtp(
        phone,
        code,
        OtpPurpose.OWNER_LOGIN,
        owner.id,
      );
    } catch (error) {
      // Do not reveal whether a phone is owner-eligible through different responses for a missing
      // account, invalid code, expired code, or exhausted challenge.
      if (error instanceof AppException) throw this.invalidOwnerCredentials();
      throw error;
    }
    this.assertActive(owner.status);

    // This route creates a new STAFF audience session and includes only the owner role. It never
    // upgrades or rotates a CUSTOMER session, and owner membership was independently rechecked
    // from both UserRole and Salon.ownerUserId above.
    const roles = this.tokenService.scopeRolesToAudience(
      [Role.SALON_OWNER],
      SessionAudience.STAFF,
    );
    const tokens = await this.tokenService.issueTokenPair(
      owner.id,
      roles,
      SessionAudience.STAFF,
      deviceInfo,
    );
    await this.prisma.auditLog.create({
      data: {
        actorUserId: owner.id,
        action: 'OWNER_PHONE_OTP_LOGIN',
        entityType: 'User',
        entityId: owner.id,
        metadata: { audience: SessionAudience.STAFF, method: 'sms_otp' },
      },
    });
    return {
      user: this.toMeResponse(
        owner.id,
        roles,
        SessionAudience.STAFF,
        owner.phone,
        owner.email,
        owner.preferredLanguage,
        owner.passwordHash,
      ),
      tokens,
    };
  }

  async requestOwnerPhoneLinkOtp(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
    phone: string,
  ): Promise<{ expiresInSeconds: number }> {
    const owner = await this.assertOwnerIdentity(
      userId,
      audience,
      sessionRoles,
    );
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (existing && existing.id !== owner.id) throw this.phoneAlreadyLinked();
    return this.otpService.requestOtp(phone, OtpPurpose.PHONE_LINK, owner.id);
  }

  async verifyOwnerPhoneLink(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
    phone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<{ success: true; user: MeResponse; tokens: AuthTokens }> {
    await this.assertOwnerIdentity(userId, audience, sessionRoles);
    await this.otpService.verifyOtp(phone, code, OtpPurpose.PHONE_LINK, userId);

    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.user.findUnique({
          where: { id: userId },
          include: { roles: true, ownedSalons: { select: { id: true } } },
        });
        if (
          !current ||
          current.status !== UserStatus.ACTIVE ||
          current.deletedAt
        ) {
          throw this.invalidOwnerCredentials();
        }
        this.assertCanonicalOwnerAccount(current);

        const linked = await tx.user.findUnique({
          where: { phone },
          select: { id: true },
        });
        if (linked && linked.id !== userId) throw this.phoneAlreadyLinked();

        const verifiedAt = new Date();
        await tx.user.update({
          where: { id: userId },
          data: { phone, phoneVerifiedAt: verifiedAt },
        });
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: verifiedAt },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'OWNER_PHONE_LINKED',
            entityType: 'User',
            entityId: userId,
            // The phone number is intentionally omitted from security audit metadata.
            metadata: {
              verifiedAt: verifiedAt.toISOString(),
              method: 'sms_otp',
            },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.phoneAlreadyLinked();
      }
      throw error;
    }
    const updated = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: true },
    });
    const ownerRoles = this.tokenService.scopeRolesToAudience(
      [Role.SALON_OWNER],
      SessionAudience.STAFF,
    );
    const tokens = await this.tokenService.issueTokenPair(
      userId,
      ownerRoles,
      SessionAudience.STAFF,
      deviceInfo,
    );
    return {
      success: true as const,
      user: this.toMeResponse(
        updated.id,
        ownerRoles,
        SessionAudience.STAFF,
        updated.phone,
        updated.email,
        updated.preferredLanguage,
        updated.passwordHash,
      ),
      tokens,
    };
  }

  async requestCustomerPhoneLinkOtp(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
    phone: string,
  ): Promise<{ expiresInSeconds: number }> {
    await this.assertCustomerIdentity(userId, audience, sessionRoles);
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (existing && existing.id !== userId) throw this.phoneAlreadyLinked();
    return this.otpService.requestOtp(phone, OtpPurpose.PHONE_LINK, userId);
  }

  async verifyCustomerPhoneLink(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
    phone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<{ success: true; user: MeResponse; tokens: AuthTokens }> {
    await this.assertCustomerIdentity(userId, audience, sessionRoles);
    await this.otpService.verifyOtp(phone, code, OtpPurpose.PHONE_LINK, userId);

    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.user.findUnique({
          where: { id: userId },
          include: { roles: true },
        });
        if (
          !current ||
          current.status !== UserStatus.ACTIVE ||
          current.deletedAt ||
          !current.roles.some(
            ({ role, salonId }) => role === Role.CUSTOMER && salonId === null,
          )
        ) {
          throw new AppException(
            AuthErrorCode.FORBIDDEN_ROLE,
            'Only an authenticated customer can link a phone number.',
            HttpStatus.FORBIDDEN,
          );
        }
        const linked = await tx.user.findUnique({
          where: { phone },
          select: { id: true },
        });
        if (linked && linked.id !== userId) throw this.phoneAlreadyLinked();

        const verifiedAt = new Date();
        await tx.user.update({
          where: { id: userId },
          data: { phone, phoneVerifiedAt: verifiedAt },
        });
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: verifiedAt },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'CUSTOMER_PHONE_LINKED',
            entityType: 'User',
            entityId: userId,
            metadata: {
              verifiedAt: verifiedAt.toISOString(),
              method: 'sms_otp',
            },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.phoneAlreadyLinked();
      }
      throw error;
    }

    const updated = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: true },
    });
    const customerRoles = this.tokenService.scopeRolesToAudience(
      [Role.CUSTOMER],
      SessionAudience.CUSTOMER,
    );
    const tokens = await this.tokenService.issueTokenPair(
      userId,
      customerRoles,
      SessionAudience.CUSTOMER,
      deviceInfo,
    );
    return {
      success: true,
      user: this.toMeResponse(
        updated.id,
        customerRoles,
        SessionAudience.CUSTOMER,
        updated.phone,
        updated.email,
        updated.preferredLanguage,
        updated.passwordHash,
      ),
      tokens,
    };
  }

  private async assertCustomerIdentity(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
  ) {
    if (
      audience !== SessionAudience.CUSTOMER ||
      !sessionRoles.includes(Role.CUSTOMER)
    ) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Only an authenticated customer can link a phone number.',
        HttpStatus.FORBIDDEN,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      user.deletedAt ||
      !user.roles.some(
        ({ role, salonId }) => role === Role.CUSTOMER && salonId === null,
      )
    ) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Only an authenticated customer can link a phone number.',
        HttpStatus.FORBIDDEN,
      );
    }
    return user;
  }

  private async findVerifiedOwnerByPhone(phone: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { roles: true, ownedSalons: { select: { id: true } } },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      user.deletedAt ||
      !user.phoneVerifiedAt
    ) {
      return null;
    }
    return this.hasCanonicalOwnerRole(user) ? user : null;
  }

  private async assertOwnerIdentity(
    userId: string,
    audience: SessionAudience,
    sessionRoles: Role[],
  ) {
    if (
      audience !== SessionAudience.STAFF ||
      !sessionRoles.includes(Role.SALON_OWNER)
    ) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Only an authenticated shop owner can link a phone number.',
        HttpStatus.FORBIDDEN,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true, ownedSalons: { select: { id: true } } },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw this.invalidOwnerCredentials();
    }
    this.assertCanonicalOwnerAccount(user);
    return user;
  }

  private assertCanonicalOwnerAccount(user: {
    id: string;
    roles: Array<{ role: Role; salonId: string | null }>;
    ownedSalons: Array<{ id: string }>;
  }): void {
    if (!this.hasCanonicalOwnerRole(user)) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Only an authenticated shop owner can link a phone number.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private hasCanonicalOwnerRole(user: {
    id: string;
    roles: Array<{ role: Role; salonId: string | null }>;
    ownedSalons: Array<{ id: string }>;
  }): boolean {
    const ownedSalonIds = new Set(user.ownedSalons.map(({ id }) => id));
    return user.roles.some(
      ({ role, salonId }) =>
        role === Role.SALON_OWNER &&
        salonId !== null &&
        ownedSalonIds.has(salonId),
    );
  }

  private invalidOwnerCredentials(): AppException {
    return new AppException(
      AuthErrorCode.OTP_INVALID,
      'The verification code is invalid or expired. Request a new code and try again.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private phoneAlreadyLinked(): AppException {
    return new AppException(
      AuthErrorCode.PHONE_ALREADY_LINKED,
      'This mobile number is already linked to another account.',
      HttpStatus.CONFLICT,
    );
  }

  // ---------- Customer: Google Sign-In ----------

  /**
   * Sign-in-or-create for Google, in three steps, in this exact priority order:
   *   1. An AuthIdentity already links this exact Google account (`sub`) — log in as its user.
   *   2. No link yet, but the (Google-verified, never client-asserted) email matches an existing
   *      User — link this Google account to that user rather than creating a duplicate. This is
   *      intentionally role-agnostic: if that user happens to already be staff/owner/admin (same
   *      real person, different login path), Google sign-in never touches or removes their
   *      existing roles — it only guarantees they *also* have CUSTOMER access, since that's what
   *      "sign in with Google as a customer" means. Staff/owner/admin authentication itself is
   *      untouched by this method entirely.
   *   3. Neither matched — create a brand-new CUSTOMER user + its AuthIdentity, atomically.
   */
  async googleLogin(
    idToken: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const identity = await this.googleAuthService.verifyIdToken(idToken);

    const user = await this.prisma.$transaction(async (tx) => {
      const existingIdentity = await tx.authIdentity.findUnique({
        where: {
          provider_providerSub: {
            provider: AuthProvider.GOOGLE,
            providerSub: identity.sub,
          },
        },
        include: { user: { include: { roles: true } } },
      });
      if (existingIdentity) return existingIdentity.user;

      if (identity.email) {
        const existingUser = await tx.user.findUnique({
          where: { email: identity.email },
          include: { roles: true },
        });
        if (existingUser) {
          await tx.authIdentity.create({
            data: {
              userId: existingUser.id,
              provider: AuthProvider.GOOGLE,
              providerSub: identity.sub,
              email: identity.email,
            },
          });
          return existingUser;
        }
      }

      return tx.user.create({
        data: {
          email: identity.email,
          emailVerifiedAt: identity.email ? new Date() : null,
          status: UserStatus.ACTIVE,
          roles: { create: { role: Role.CUSTOMER } },
          authIdentities: {
            create: {
              provider: AuthProvider.GOOGLE,
              providerSub: identity.sub,
              email: identity.email,
            },
          },
        },
        include: { roles: true },
      });
    });

    this.assertActive(user.status);

    // Ensure CUSTOMER access exists even for a linked staff/owner/admin account (see the method
    // doc above) — a no-op for the common case (brand-new user or an existing customer), and
    // never removes or alters any role the user already has. `roles` here is deliberately the
    // FULL, unscoped set (needed to correctly decide whether a CUSTOMER row must be created) — it
    // is never what gets issued into the token; see sessionRoles below for that.
    let roles = user.roles.map((r) => r.role);
    if (!roles.includes(Role.CUSTOMER)) {
      await this.prisma.userRole.create({
        data: { userId: user.id, role: Role.CUSTOMER },
      });
      roles = [...roles, Role.CUSTOMER];
    }

    // Security fix: "sign in with Google as a customer" is a CUSTOMER-audience session — it must
    // never assert PLATFORM_ADMIN/staff roles even when this exact User row also holds them (the
    // whole point of the method doc above: this path only ever GUARANTEES customer access, never
    // grants anything more).
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      roles,
      SessionAudience.CUSTOMER,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.CUSTOMER,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.CUSTOMER,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Prospective shop owner: self-service email + password ----------

  /**
   * Creates the account used to begin shop onboarding. A salon-scoped SALON_OWNER role cannot
   * exist safely before a real salon exists, so this account starts with CUSTOMER access only.
   * POST /salons is already the authoritative promotion boundary: it creates the salon, grants
   * SALON_OWNER for that salon and returns a new STAFF-audience session atomically.
   */
  async ownerSignup(
    email: string,
    password: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { roles: true },
    });
    if (existing) {
      this.assertActive(existing.status);
      const existingRoles = existing.roles.map((role) => role.role);
      const isUnfinishedOnboardingAccount =
        existingRoles.length > 0 &&
        existingRoles.every((role) => role === Role.CUSTOMER) &&
        Boolean(existing.passwordHash);
      const passwordMatches =
        isUnfinishedOnboardingAccount && existing.passwordHash
          ? await this.passwordService.compare(password, existing.passwordHash)
          : false;

      // A prospective owner can safely resume after closing the browser/app before creating the
      // salon. Do not create a duplicate account and do not grant a role here: POST /salons remains
      // the only boundary that creates a salon-scoped SALON_OWNER role.
      if (isUnfinishedOnboardingAccount && passwordMatches) {
        const sessionRoles = this.tokenService.scopeRolesToAudience(
          existingRoles,
          SessionAudience.CUSTOMER,
        );
        const tokens = await this.tokenService.issueTokenPair(
          existing.id,
          sessionRoles,
          SessionAudience.CUSTOMER,
          deviceInfo,
        );
        return {
          user: this.toMeResponse(
            existing.id,
            sessionRoles,
            SessionAudience.CUSTOMER,
            existing.phone,
            existing.email,
            existing.preferredLanguage,
            existing.passwordHash,
          ),
          tokens,
        };
      }

      throw new AppException(
        'OWNER_ACCOUNT_EMAIL_EXISTS',
        'An account with this email already exists. Sign in instead.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwordService.hash(password);
    let user: Prisma.UserGetPayload<{ include: { roles: true } }>;
    try {
      user = await this.prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          status: UserStatus.ACTIVE,
          roles: { create: { role: Role.CUSTOMER } },
        },
        include: { roles: true },
      });
    } catch (err) {
      // Keep the duplicate-email result deterministic even if two signup requests race between
      // the pre-check and the unique User.email insert.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new AppException(
          'OWNER_ACCOUNT_EMAIL_EXISTS',
          'An account with this email already exists. Sign in instead.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }

    const sessionRoles = this.tokenService.scopeRolesToAudience(
      user.roles.map((role) => role.role),
      SessionAudience.CUSTOMER,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.CUSTOMER,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.CUSTOMER,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- FastQue employee: employee code + password ----------

  async employeeLogin(
    employeeCode: string,
    password: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { employeeCode: employeeCode.trim().toUpperCase() },
      include: { user: { include: { roles: true } } },
    });
    const user = profile?.user ?? null;
    const roles = user?.roles.map((r) => r.role) ?? [];
    // FIELD_EXECUTIVE is an internal FastQue role, never salon-scoped. Re-check the raw UserRole
    // rows here (before they are flattened to Role[]) so a malformed salon-scoped row can never
    // authenticate through the employee surface.
    const isGlobalFieldExecutive =
      !!user &&
      user.roles.some(
        (r) => r.role === Role.FIELD_EXECUTIVE && r.salonId === null,
      );

    // Constant-shape password comparison prevents employee-code enumeration by response timing.
    const passwordHash =
      user?.passwordHash ??
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const passwordMatches = await this.passwordService.compare(
      password,
      passwordHash,
    );

    if (!profile || !user || !isGlobalFieldExecutive || !passwordMatches) {
      throw new AppException(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Incorrect employee ID or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);

    const sessionRoles = this.tokenService.scopeRolesToAudience(
      roles,
      SessionAudience.EMPLOYEE,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.EMPLOYEE,
      deviceInfo,
    );

    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.EMPLOYEE,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Staff / Owner: email + password ----------

  async staffLogin(
    email: string,
    password: string,
    deviceInfo?: string,
  ): Promise<{
    user: MeResponse;
    tokens: AuthTokens;
    twoFactorRequired: boolean;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: true },
    });
    const roles = user?.roles.map((r) => r.role) ?? [];
    const isStaffOrOwner = roles.some(
      (r) => r === Role.SALON_STAFF || r === Role.SALON_OWNER,
    );

    // Constant-shape failure path: compare against a hash even when the user doesn't exist (or
    // isn't staff/owner), so response timing doesn't leak which emails are registered.
    const passwordHash =
      user?.passwordHash ??
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const passwordMatches = await this.passwordService.compare(
      password,
      passwordHash,
    );

    if (!user || !isStaffOrOwner || !passwordMatches) {
      throw new AppException(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Incorrect email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);

    // Security fix: staff/owner password login is a STAFF-audience session — it must never assert
    // PLATFORM_ADMIN even if this same User row also holds it.
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      roles,
      SessionAudience.STAFF,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.STAFF,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.STAFF,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
      // Always false in V1 — no staff/owner account can have 2FA enabled yet (only the admin
      // seed script provisions a TOTP secret, and only for PLATFORM_ADMIN). Reserved per API.md
      // so a future POST /auth/staff/2fa/verify step slots in without a response-shape change.
      twoFactorRequired: false,
    };
  }

  // ---------- Staff / Owner: Google Sign-In ----------

  /**
   * Google Sign-In restricted to accounts that already hold SALON_OWNER and/or SALON_STAFF.
   * Deliberately NOT the customer googleLogin's create-or-link-then-ensure-CUSTOMER flow — that
   * method exists specifically to be permissive (anyone can become a customer via Google), while
   * this one exists specifically to be restrictive:
   *
   *   1. An AuthIdentity already links this exact Google account (`sub`) — use its user.
   *   2. No link yet, but the (Google-verified, never client-asserted) email matches an existing
   *      User who ALREADY holds SALON_OWNER or SALON_STAFF — link this Google account to that
   *      user. The role check happens BEFORE linking, not after: an existing customer-only
   *      account with the same email is never linked or elevated by this method.
   *   3. Anything else (no identity, no matching user, or a matching user with neither role) —
   *      reject. Never creates a User. Never creates a UserRole. Never adds CUSTOMER.
   *
   * Roles are re-checked on the FINAL resolved user right before issuing tokens, not only at
   * link time — an account that loses its OWNER/STAFF role after a Google identity was already
   * linked must not keep signing in here, same as staffLogin re-checks on every call rather than
   * trusting a one-time check.
   */
  async staffGoogleLogin(
    idToken: string,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const identity = await this.googleAuthService.verifyIdToken(idToken);

    const user = await this.prisma.$transaction(async (tx) => {
      // Disaster-recovery consistency repair: Salon.ownerUserId is the canonical ownership
      // relationship. If a recovery restored the Salon row but missed its matching SALON_OWNER
      // UserRole, repair only that already-proven ownership before applying the normal login gate.
      // This never infers ownership from email and never grants access to a salon the User row
      // does not already own.
      const repairMissingOwnerRole = async <
        T extends { id: string; roles: Array<{ role: Role }> },
      >(
        candidate: T,
      ): Promise<T> => {
        const alreadyOperator = candidate.roles.some(
          ({ role }) => role === Role.SALON_OWNER || role === Role.SALON_STAFF,
        );
        if (alreadyOperator) return candidate;

        const ownedSalons = await tx.salon.findMany({
          where: { ownerUserId: candidate.id },
          select: { id: true },
        });
        if (ownedSalons.length === 0) return candidate;

        await tx.userRole.createMany({
          data: ownedSalons.map(({ id: salonId }) => ({
            userId: candidate.id,
            role: Role.SALON_OWNER,
            salonId,
          })),
          skipDuplicates: true,
        });

        const refreshed = await tx.user.findUnique({
          where: { id: candidate.id },
          include: { roles: true },
        });
        return (refreshed ?? candidate) as T;
      };

      const existingIdentity = await tx.authIdentity.findUnique({
        where: {
          provider_providerSub: {
            provider: AuthProvider.GOOGLE,
            providerSub: identity.sub,
          },
        },
        include: { user: { include: { roles: true } } },
      });
      if (existingIdentity) {
        return repairMissingOwnerRole(existingIdentity.user);
      }

      if (!identity.email) return null;

      const existingUser = await tx.user.findUnique({
        where: { email: identity.email },
        include: { roles: true },
      });
      if (!existingUser) return null;

      const repairedUser = await repairMissingOwnerRole(existingUser);
      const candidateRoles = repairedUser.roles.map((r) => r.role);
      const candidateIsStaffOrOwner = candidateRoles.some(
        (r) => r === Role.SALON_STAFF || r === Role.SALON_OWNER,
      );
      // The role check gates the link itself — an existing customer-only user with this email
      // is left completely untouched unless Salon.ownerUserId independently proves ownership.
      if (!candidateIsStaffOrOwner) return null;

      await tx.authIdentity.create({
        data: {
          userId: repairedUser.id,
          provider: AuthProvider.GOOGLE,
          providerSub: identity.sub,
          email: identity.email,
        },
      });
      return repairedUser;
    });

    const roles = user?.roles.map((r) => r.role) ?? [];
    const isStaffOrOwner = roles.some(
      (r) => r === Role.SALON_STAFF || r === Role.SALON_OWNER,
    );
    if (!user || !isStaffOrOwner) {
      throw new AppException(
        AuthErrorCode.GOOGLE_ACCOUNT_NOT_STAFF,
        'This Google account is not registered as a shop owner or staff member.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);

    // Security fix: staff/owner Google login is a STAFF-audience session — never PLATFORM_ADMIN,
    // even if this same User row also holds it.
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      roles,
      SessionAudience.STAFF,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.STAFF,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.STAFF,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Platform admin: Google + mandatory TOTP ----------

  async adminGoogleLogin(
    idToken: string,
    totpCode: string | undefined,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const identity = await this.googleAuthService.verifyIdToken(idToken);
    const user = await this.prisma.$transaction(async (tx) => {
      const linked = await tx.authIdentity.findUnique({
        where: {
          provider_providerSub: {
            provider: AuthProvider.GOOGLE,
            providerSub: identity.sub,
          },
        },
        include: { user: { include: { roles: true } } },
      });
      if (linked) return linked.user;
      if (!identity.email) return null;

      const candidate = await tx.user.findUnique({
        where: { email: identity.email },
        include: { roles: true },
      });
      // Global-admin-scope fix: PLATFORM_ADMIN is only ever a global role (salonId: null — see
      // UserRole's own doc comment); a salon-scoped PLATFORM_ADMIN row (which should never exist —
      // enforced by a DB CHECK constraint as of this fix — but must never be trusted regardless)
      // must not grant admin-login eligibility here.
      if (!candidate || !hasGlobalAdminDashboardRole(candidate.roles)) {
        return null;
      }
      await tx.authIdentity.create({
        data: {
          userId: candidate.id,
          provider: AuthProvider.GOOGLE,
          providerSub: identity.sub,
          email: identity.email,
        },
      });
      return candidate;
    });

    const hasAdminDashboardAccess =
      !!user && hasGlobalAdminDashboardRole(user.roles);
    if (!user || !hasAdminDashboardAccess) {
      throw new AppException(
        AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN,
        'This Google account is not registered for FastQue admin-dashboard access.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);
    await this.assertAdminTotp(user, totpCode);

    // Admin Google login issues an ADMIN-audience session — the only audience allowed to assert
    // internal-admin roles, and only after the TOTP check just above succeeded.
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      user.roles
        .filter((role) => role.salonId === null)
        .map((role) => role.role),
      SessionAudience.ADMIN,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.ADMIN,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.ADMIN,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Platform admin: email + password + mandatory TOTP ----------

  async adminLogin(
    email: string,
    password: string,
    totpCode: string | undefined,
    deviceInfo?: string,
  ): Promise<{ user: MeResponse; tokens: AuthTokens }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: true },
    });
    // Global-admin-scope fix: PLATFORM_ADMIN is only ever a global role (salonId: null) — a
    // salon-scoped PLATFORM_ADMIN row must never grant admin-login eligibility.
    const hasAdminDashboardAccess =
      !!user && hasGlobalAdminDashboardRole(user.roles);

    const passwordHash =
      user?.passwordHash ??
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const passwordMatches = await this.passwordService.compare(
      password,
      passwordHash,
    );

    if (!user || !hasAdminDashboardAccess || !passwordMatches) {
      throw new AppException(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Incorrect email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);

    await this.assertAdminTotp(user, totpCode);

    // Admin password login issues an ADMIN-audience session — the only audience allowed to assert
    // internal-admin roles, and only after the TOTP check just above succeeded.
    const sessionRoles = this.tokenService.scopeRolesToAudience(
      user.roles
        .filter((role) => role.salonId === null)
        .map((role) => role.role),
      SessionAudience.ADMIN,
    );
    const tokens = await this.tokenService.issueTokenPair(
      user.id,
      sessionRoles,
      SessionAudience.ADMIN,
      deviceInfo,
    );
    return {
      user: this.toMeResponse(
        user.id,
        sessionRoles,
        SessionAudience.ADMIN,
        user.phone,
        user.email,
        user.preferredLanguage,
        user.passwordHash,
      ),
      tokens,
    };
  }

  // ---------- Session lifecycle ----------

  refresh(rawRefreshToken: string, deviceInfo?: string): Promise<AuthTokens> {
    return this.tokenService.rotateRefreshToken(rawRefreshToken, deviceInfo);
  }

  logout(rawRefreshToken: string): Promise<void> {
    return this.tokenService.revokeRefreshToken(rawRefreshToken);
  }

  logoutAll(userId: string): Promise<void> {
    return this.tokenService.revokeAllForUser(userId);
  }

  /**
   * Irreversibly removes a customer account's direct identity and login surface while retaining
   * only de-identified operational/accounting records that cannot safely lose referential
   * integrity (bookings, credit/subscription and security records). Customer reviews are deleted
   * because their optional text and owner response are user-generated content, not required for
   * those retained-record purposes. This deliberately
   * refuses every owner, staff, admin, salon-linked, or mixed-role account: those relationships
   * require a separately reviewed support process and can never be deleted through customer UI.
   */
  async deleteCustomerAccount(
    userId: string,
    audience: SessionAudience,
  ): Promise<{ success: true }> {
    if (audience !== SessionAudience.CUSTOMER) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Only a customer account can be deleted here.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: {
          roles: true,
          ownedSalons: { select: { id: true } },
          staffMemberships: { select: { id: true } },
        },
      });
      if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
        throw new AppException(
          AuthErrorCode.UNAUTHENTICATED,
          'This account is no longer active.',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const hasOnlyCustomerRoles =
        user.roles.length > 0 &&
        user.roles.every(({ role }) => role === Role.CUSTOMER);
      if (
        !hasOnlyCustomerRoles ||
        user.ownedSalons.length > 0 ||
        user.staffMemberships.length > 0
      ) {
        throw new AppException(
          AuthErrorCode.FORBIDDEN_ROLE,
          'This account cannot be deleted through the customer account flow.',
          HttpStatus.FORBIDDEN,
        );
      }

      // Capture the stored value before identity fields are cleared. OtpRequest deliberately has
      // no User relation, so its phone key must be explicitly removed in this same transaction.
      const deletedPhone = user.phone;
      const deletedAt = new Date();
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      if (deletedPhone) {
        await tx.otpRequest.deleteMany({ where: { phone: deletedPhone } });
      }
      await tx.authIdentity.deleteMany({ where: { userId } });
      await tx.pushDevice.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      // A review owns optional customer-written content and the attached owner response. Neither
      // is needed to preserve its booking, so deleting the review row removes both safely.
      await tx.review.deleteMany({ where: { customerId: userId } });
      // Queue membership is not an accounting record. Clearing this optional relation prevents
      // an operational queue from carrying a deleted customer's stable account identifier.
      await tx.queueEntry.updateMany({
        where: { customerId: userId },
        data: { customerId: null },
      });
      // Audit history is retained for security, but its actor link and request metadata are
      // de-identified before the account row is stripped of direct identifiers.
      await tx.auditLog.updateMany({
        where: { actorUserId: userId },
        data: { actorUserId: null, metadata: { accountDeleted: true } },
      });
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          phone: null,
          email: null,
          passwordHash: null,
          phoneVerifiedAt: null,
          emailVerifiedAt: null,
          twoFactorEnabled: false,
          totpSecret: null,
          preferredLanguage: Language.EN,
          status: UserStatus.SUSPENDED,
          deletedAt,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'CUSTOMER_ACCOUNT_DELETED',
          entityType: 'User',
          entityId: userId,
          metadata: { accountDeleted: true },
        },
      });
    });

    return { success: true };
  }

  listSessions(
    userId: string,
    currentRawRefreshToken?: string,
  ): Promise<AuthSession[]> {
    return this.tokenService.listSessions(userId, currentRawRefreshToken);
  }

  revokeSession(userId: string, sessionId: string): Promise<void> {
    return this.tokenService.revokeSession(userId, sessionId);
  }

  async me(
    userId: string,
    tokenRoles: Role[],
    tokenAudience: SessionAudience,
  ): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppException(
        AuthErrorCode.UNAUTHENTICATED,
        'User not found.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.toMeResponse(
      user.id,
      tokenRoles,
      tokenAudience,
      user.phone,
      user.email,
      user.preferredLanguage,
      user.passwordHash,
    );
  }

  /** PATCH auth/language (Phase 14) — the caller's own tokenRoles/audience are reused as-is;
   * changing language never affects role or audience membership. */
  async setLanguage(
    userId: string,
    tokenRoles: Role[],
    tokenAudience: SessionAudience,
    language: Language,
  ): Promise<MeResponse> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { preferredLanguage: language },
    });
    return this.toMeResponse(
      user.id,
      tokenRoles,
      tokenAudience,
      user.phone,
      user.email,
      user.preferredLanguage,
      user.passwordHash,
    );
  }

  async setInitialPassword(
    userId: string,
    tokenAudience: SessionAudience,
    password: string,
  ): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) {
      throw new AppException(
        AuthErrorCode.UNAUTHENTICATED,
        'User not found.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user.status);
    if (!user.email || !user.emailVerifiedAt) {
      throw new AppException(
        AuthErrorCode.INVALID_CREDENTIALS,
        'A verified email address is required before creating a password.',
        HttpStatus.CONFLICT,
      );
    }
    if (user.passwordHash) {
      throw new AppException(
        AuthErrorCode.PASSWORD_ALREADY_CONFIGURED,
        'A password is already configured. Use password recovery to change it.',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwordService.hash(password);
    const updated = await this.prisma.user.updateMany({
      where: { id: user.id, passwordHash: null },
      data: { passwordHash },
    });
    if (updated.count !== 1) {
      throw new AppException(
        AuthErrorCode.PASSWORD_ALREADY_CONFIGURED,
        'A password is already configured. Use password recovery to change it.',
        HttpStatus.CONFLICT,
      );
    }
    // Scoped to the caller's own session audience — this response must never show a role the
    // caller's actual JWT doesn't carry, even if the underlying User row holds more.
    const roles = this.tokenService.scopeRolesToAudience(
      user.roles.map((role) => role.role),
      tokenAudience,
    );
    return this.toMeResponse(
      user.id,
      roles,
      tokenAudience,
      user.phone,
      user.email,
      user.preferredLanguage,
      passwordHash,
    );
  }

  // ---------- Forgot / reset password (staff/owner/admin only — customers have no password) ----------

  async forgotPassword(
    email: string,
    audience?: PasswordAudience,
  ): Promise<{ devResetUrl?: string }> {
    // Availability is checked before account lookup so configuration failures cannot become an
    // account-enumeration oracle. Production never claims a message was sent via console.
    this.emailSender.assertAvailable();
    const webBaseUrl = passwordWebBaseUrl();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: true },
    });
    // Always behave identically whether or not the email exists, so responses can't be used to
    // enumerate registered accounts.
    const eligible = user?.roles.some(
      ({ role }) =>
        role === Role.SALON_OWNER ||
        role === Role.SALON_STAFF ||
        role === Role.PLATFORM_ADMIN ||
        role === Role.CO_FOUNDER ||
        role === Role.HR_ADMIN ||
        role === Role.SALES_ADMIN ||
        role === Role.PLATFORM_VIEWER,
    );
    if (!user || !eligible) {
      return {};
    }

    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashResetToken(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
      },
    });

    const resetUrl = buildPasswordLink(webBaseUrl, rawToken, audience);
    await this.emailSender.sendPasswordReset(
      email,
      resetUrl,
      PASSWORD_RESET_TTL_MINUTES,
    );

    // Dev-only convenience so the flow is testable with no email provider connected — never
    // included outside development (see PAYMENTS.md-style "external dependency" documentation
    // pattern: the abstraction is real, only the transport is stubbed).
    return process.env.NODE_ENV === 'production'
      ? {}
      : { devResetUrl: resetUrl };
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashResetToken(rawToken);
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!resetToken || resetToken.usedAt) {
      throw new AppException(
        AuthErrorCode.RESET_TOKEN_INVALID,
        'This reset link is invalid.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (resetToken.expiresAt.getTime() <= Date.now()) {
      throw new AppException(
        AuthErrorCode.RESET_TOKEN_EXPIRED,
        'This reset link has expired.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await this.passwordService.hash(newPassword);
    const accepted = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: {
          id: resetToken.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          AuthErrorCode.RESET_TOKEN_INVALID,
          'This reset link is invalid.',
          HttpStatus.BAD_REQUEST,
        );
      }
      await tx.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      });
      await tx.refreshToken.updateMany({
        where: { userId: resetToken.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Salon onboarding owner invitations reuse this single-use token flow; a no-op for any
      // ordinary password reset.
      return acceptOnboardingInvitationInTx(
        tx,
        resetToken.id,
        resetToken.userId,
      );
    });
    if (accepted) await this.notifyOwnerActivated(accepted);
  }

  private async notifyOwnerActivated(accepted: {
    applicationId: string;
    reference: string;
    salonName: string;
    assignedEmployeeId: string;
  }): Promise<void> {
    if (!this.notifications) return;
    try {
      const [admins, employee] = await Promise.all([
        this.prisma.userRole.findMany({
          where: {
            role: { in: [Role.PLATFORM_ADMIN, Role.CO_FOUNDER] },
            salonId: null,
          },
          select: { userId: true },
          distinct: ['userId'],
        }),
        this.prisma.employeeProfile.findUnique({
          where: { id: accepted.assignedEmployeeId },
          select: { userId: true },
        }),
      ]);
      const payload = {
        reference: accepted.reference,
        salonName: accepted.salonName,
      };
      for (const { userId } of admins) {
        await this.notifications.notify(
          userId,
          'onboarding.owner_activated',
          payload,
          `admin/onboarding/${accepted.applicationId}`,
        );
      }
      if (employee) {
        await this.notifications.notify(
          employee.userId,
          'onboarding.owner_activated',
          payload,
          `employee/onboarding/${accepted.applicationId}`,
        );
      }
    } catch (err) {
      new Logger(AuthService.name).warn(
        `Owner-activation notice failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  private async assertAdminTotp(
    user: { twoFactorEnabled: boolean; totpSecret: string | null },
    totpCode: string | undefined,
  ): Promise<void> {
    if (!user.twoFactorEnabled || !user.totpSecret) {
      throw new AppException(
        AuthErrorCode.TOTP_SETUP_REQUIRED,
        'Two-factor authentication is not set up for this account.',
        HttpStatus.FORBIDDEN,
      );
    }
    let secret: string;
    try {
      // Validate that the configured secret is actually usable before asking the admin for a
      // one-time code. After a database restore the ciphertext may belong to an older
      // TOTP_ENCRYPTION_KEY; in that case Google sign-in must enter the secure bootstrap flow
      // immediately instead of first prompting for a code that can never succeed.
      secret = this.cryptoService.decrypt(user.totpSecret);
    } catch {
      // A database recovery can restore ciphertext that was encrypted under a different
      // TOTP_ENCRYPTION_KEY. Treat that as a secure re-enrollment requirement instead of leaking
      // a 500. The admin login page will verify Google again and enter the bootstrap flow; no
      // ADMIN session is issued until a newly enrolled authenticator code is confirmed.
      throw new AppException(
        AuthErrorCode.TOTP_SETUP_REQUIRED,
        'Authenticator setup must be repaired before admin sign-in can continue.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!totpCode) {
      throw new AppException(
        AuthErrorCode.TOTP_REQUIRED,
        'A 6-digit authenticator code is required.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const valid = await this.totpService.verifyToken(secret, totpCode);
    if (!valid) {
      throw new AppException(
        AuthErrorCode.TOTP_INVALID,
        'Incorrect authenticator code.',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private assertActive(status: UserStatus): void {
    if (status !== UserStatus.ACTIVE) {
      throw new AppException(
        AuthErrorCode.ACCOUNT_SUSPENDED,
        'This account is no longer active.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private toMeResponse(
    id: string,
    roles: Role[],
    audience: SessionAudience,
    phone: string | null,
    email: string | null,
    preferredLanguage: Language,
    passwordHash: string | null | undefined,
  ): MeResponse {
    return {
      id,
      roles,
      audience,
      phone,
      email,
      preferredLanguage,
      passwordConfigured: Boolean(passwordHash),
    };
  }
}
