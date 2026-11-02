import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AuthErrorCode,
  Language,
  OtpPurpose,
  Role,
  SessionAudience,
  UserStatus,
} from '@barbercue/shared';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { OtpService } from './services/otp.service';
import { TotpService } from './services/totp.service';
import { CryptoService } from './services/crypto.service';
import { GoogleAuthService } from './services/google-auth.service';
import { EMAIL_SENDER } from './services/email-sender';
import { AppException } from '../common/exceptions/app.exception';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    authIdentity: {
      findUnique: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    userRole: {
      create: jest.Mock;
      createMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    salon: {
      findMany: jest.Mock;
    };
    passwordResetToken: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    refreshToken: { updateMany: jest.Mock; deleteMany: jest.Mock };
    otpRequest: { deleteMany: jest.Mock };
    pushDevice: { deleteMany: jest.Mock };
    notificationPreference: { deleteMany: jest.Mock };
    notification: { deleteMany: jest.Mock };
    queueEntry: { updateMany: jest.Mock };
    review: { deleteMany: jest.Mock };
    auditLog: { updateMany: jest.Mock; create: jest.Mock };
    salonOnboardingInvitation: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let passwordService: { hash: jest.Mock; compare: jest.Mock };
  let tokenService: {
    issueTokenPair: jest.Mock;
    rotateRefreshToken: jest.Mock;
    revokeRefreshToken: jest.Mock;
    revokeAllForUser: jest.Mock;
    scopeRolesToAudience: jest.Mock;
  };
  let otpService: { requestOtp: jest.Mock; verifyOtp: jest.Mock };
  let totpService: { verifyToken: jest.Mock };
  let cryptoService: { decrypt: jest.Mock };
  let googleAuthService: { verifyIdToken: jest.Mock };
  let emailSender: {
    assertAvailable: jest.Mock;
    sendPasswordReset: jest.Mock;
    sendStaffInvitation: jest.Mock;
  };

  const fakeTokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresIn: 900,
  };

  beforeEach(async () => {
    // Railway/CI runs tests with NODE_ENV=production; make password-link tests hermetic instead of
    // depending on whichever WEB_BASE_URL happens to exist in the build environment.
    process.env.WEB_BASE_URL = 'https://fastque.test';
    prisma = {
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      authIdentity: {
        findUnique: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      userRole: {
        create: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn(),
      },
      salon: { findMany: jest.fn().mockResolvedValue([]) },
      passwordResetToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      refreshToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      otpRequest: { deleteMany: jest.fn() },
      pushDevice: { deleteMany: jest.fn() },
      notificationPreference: { deleteMany: jest.fn() },
      notification: { deleteMany: jest.fn() },
      queueEntry: { updateMany: jest.fn() },
      review: { deleteMany: jest.fn() },
      auditLog: { updateMany: jest.fn(), create: jest.fn() },
      // An ordinary reset token is not an onboarding invitation.
      salonOnboardingInvitation: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      // Supports both call shapes AuthService actually uses: the array form
      // (resetPassword's batch of writes) and the interactive-callback form (googleLogin's
      // find-or-create) — same dual-mode mock pattern as the rest of this backend's test suite.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.all(arg as unknown[]),
      ),
    };
    passwordService = { hash: jest.fn(), compare: jest.fn() };
    tokenService = {
      issueTokenPair: jest.fn().mockResolvedValue(fakeTokens),
      rotateRefreshToken: jest.fn(),
      revokeRefreshToken: jest.fn(),
      revokeAllForUser: jest.fn(),
      // Mirrors TokenService's real ROLES_ALLOWED_FOR_AUDIENCE mapping (not just a passthrough) so
      // these tests actually exercise the audience-scoping boundary AuthService depends on, rather
      // than trivially passing because the mock echoes back whatever roles it was given.
      scopeRolesToAudience: jest.fn(
        (roles: Role[], audience: SessionAudience) => {
          const allowed: Record<SessionAudience, Role[]> = {
            [SessionAudience.CUSTOMER]: [Role.CUSTOMER],
            [SessionAudience.STAFF]: [Role.SALON_STAFF, Role.SALON_OWNER],
            [SessionAudience.EMPLOYEE]: [Role.FIELD_EXECUTIVE],
            [SessionAudience.ADMIN]: [
              Role.PLATFORM_ADMIN,
              Role.CO_FOUNDER,
              Role.HR_ADMIN,
              Role.SALES_ADMIN,
              Role.PLATFORM_VIEWER,
            ],
          };
          return roles.filter((role) => allowed[audience].includes(role));
        },
      ),
    };
    otpService = { requestOtp: jest.fn(), verifyOtp: jest.fn() };
    totpService = { verifyToken: jest.fn() };
    cryptoService = { decrypt: jest.fn() };
    googleAuthService = { verifyIdToken: jest.fn() };
    emailSender = {
      assertAvailable: jest.fn(),
      sendPasswordReset: jest.fn(),
      sendStaffInvitation: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
        { provide: OtpService, useValue: otpService },
        { provide: TotpService, useValue: totpService },
        { provide: CryptoService, useValue: cryptoService },
        { provide: GoogleAuthService, useValue: googleAuthService },
        { provide: EMAIL_SENDER, useValue: emailSender },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('verifyCustomerOtp', () => {
    it('creates a new CUSTOMER user on first-ever OTP verification for a phone number', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      const result = await service.verifyCustomerOtp('+919876543210', '123456');

      expect(prisma.user.create).toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.tokens).toBe(fakeTokens);
    });

    it('[Test B] a user holding CUSTOMER + PLATFORM_ADMIN never receives PLATFORM_ADMIN via customer OTP login', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        roles: [
          { role: Role.CUSTOMER },
          { role: Role.PLATFORM_ADMIN, salonId: null },
        ],
      });

      const result = await service.verifyCustomerOtp('+919876543210', '123456');

      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'u1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        undefined,
      );
      // [Fix2-C] the user already has CUSTOMER — no duplicate role grant.
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('[Fix2-A] an existing SALON_OWNER with no CUSTOMER role yet is granted CUSTOMER on first OTP verification, without losing the owner role', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        phone: '+919876543210',
        email: 'owner@salon.com',
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_OWNER, salonId: 's1' }],
      });

      const result = await service.verifyCustomerOtp('+919876543210', '123456');

      expect(prisma.userRole.create).toHaveBeenCalledWith({
        data: { userId: 'owner-1', role: Role.CUSTOMER },
      });
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'owner-1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        undefined,
      );
      // The DB grant only ADDS CUSTOMER — it never touches/removes the existing SALON_OWNER row.
      expect(prisma.userRole.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: Role.SALON_OWNER }),
        }),
      );
    });

    it('[Fix2-B] an existing global PLATFORM_ADMIN with no CUSTOMER role yet is granted CUSTOMER on first OTP verification, and the session never carries PLATFORM_ADMIN', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'admin-1',
        phone: '+919876543210',
        email: 'admin@barbercue.app',
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.PLATFORM_ADMIN, salonId: null }],
      });

      const result = await service.verifyCustomerOtp('+919876543210', '123456');

      expect(prisma.userRole.create).toHaveBeenCalledWith({
        data: { userId: 'admin-1', role: Role.CUSTOMER },
      });
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'admin-1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        undefined,
      );
    });

    it('reuses the existing user on a returning customer and does not create a duplicate', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        phoneVerifiedAt: new Date(),
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      await service.verifyCustomerOtp('+919876543210', '123456');

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('does not let phone possession take over an existing account whose phone was never verified', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'legacy-owner',
        phone: '+919876543210',
        email: 'owner@example.com',
        phoneVerifiedAt: null,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_OWNER, salonId: 'salon-1' }],
      });

      await expect(
        service.verifyCustomerOtp('+919876543210', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.OTP_INVALID });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('propagates OTP failures without issuing tokens', async () => {
      otpService.verifyOtp.mockRejectedValue(
        new AppException(AuthErrorCode.OTP_INVALID, 'bad', 400),
      );
      await expect(
        service.verifyCustomerOtp('+919876543210', '000000'),
      ).rejects.toThrow(AppException);
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a suspended customer even with a correct OTP', async () => {
      otpService.verifyOtp.mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        phoneVerifiedAt: new Date(),
        status: UserStatus.SUSPENDED,
        roles: [{ role: Role.CUSTOMER }],
      });
      await expect(
        service.verifyCustomerOtp('+919876543210', '123456'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    });
  });

  describe('owner phone OTP', () => {
    const owner = {
      id: 'owner-1',
      phone: '+919876543210',
      phoneVerifiedAt: new Date(),
      email: 'owner@example.com',
      passwordHash: null,
      preferredLanguage: Language.EN,
      status: UserStatus.ACTIVE,
      deletedAt: null,
      roles: [{ role: Role.SALON_OWNER, salonId: 'salon-1' }],
      ownedSalons: [{ id: 'salon-1' }],
    };

    it('requests only an account-bound owner challenge for a verified canonical owner phone', async () => {
      prisma.user.findUnique.mockResolvedValue(owner);
      otpService.requestOtp.mockResolvedValue({ expiresInSeconds: 300 });

      await expect(service.requestOwnerOtp(owner.phone)).resolves.toEqual({
        expiresInSeconds: 300,
      });
      expect(otpService.requestOtp).toHaveBeenCalledWith(
        owner.phone,
        OtpPurpose.OWNER_LOGIN,
        owner.id,
      );
    });

    it('returns the same public request shape without sending for an unknown or non-owner phone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.requestOwnerOtp('+919900000000')).resolves.toEqual({
        expiresInSeconds: 300,
      });
      expect(otpService.requestOtp).not.toHaveBeenCalled();
    });

    it('issues a STAFF session containing only SALON_OWNER after canonical DB role verification', async () => {
      prisma.user.findUnique.mockResolvedValue(owner);
      otpService.verifyOtp.mockResolvedValue(undefined);

      const result = await service.verifyOwnerOtp(
        owner.phone,
        '123456',
        'browser-test',
      );

      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        owner.phone,
        '123456',
        OtpPurpose.OWNER_LOGIN,
        owner.id,
      );
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        owner.id,
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
        'browser-test',
      );
      expect(result.user.audience).toBe(SessionAudience.STAFF);
      expect(result.user.roles).toEqual([Role.SALON_OWNER]);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'OWNER_PHONE_OTP_LOGIN',
          metadata: { audience: SessionAudience.STAFF, method: 'sms_otp' },
        }),
      });
    });

    it('does not issue owner tokens or reveal account eligibility when the phone is not a canonical owner', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...owner,
        roles: [{ role: Role.CUSTOMER, salonId: null }],
        ownedSalons: [],
      });

      await expect(
        service.verifyOwnerOtp(owner.phone, '123456'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.OTP_INVALID,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('normalizes wrong, expired and exhausted owner OTP outcomes to one response', async () => {
      prisma.user.findUnique.mockResolvedValue(owner);
      otpService.verifyOtp.mockRejectedValue(
        new AppException(
          AuthErrorCode.OTP_EXPIRED,
          'private detail',
          HttpStatus.BAD_REQUEST,
        ),
      );

      await expect(
        service.verifyOwnerOtp(owner.phone, '123456'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.OTP_INVALID,
        status: HttpStatus.BAD_REQUEST,
        message:
          'The verification code is invalid or expired. Request a new code and try again.',
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('requires an authenticated STAFF owner session to link a phone', async () => {
      await expect(
        service.requestOwnerPhoneLinkOtp(
          'customer-1',
          SessionAudience.CUSTOMER,
          [Role.CUSTOMER],
          '+919900000000',
        ),
      ).rejects.toMatchObject({ code: AuthErrorCode.FORBIDDEN_ROLE });
      expect(otpService.requestOtp).not.toHaveBeenCalled();
    });

    it('links only the verified unique phone, audits without the number, revokes refresh sessions, and returns a new STAFF session', async () => {
      const newPhone = '+919900000000';
      const updatedOwner = { ...owner, phone: newPhone };
      prisma.user.findUnique
        .mockResolvedValueOnce(owner) // request authorization
        .mockResolvedValueOnce(owner) // transactional recheck
        .mockResolvedValueOnce(null); // uniqueness recheck
      prisma.user.findUniqueOrThrow.mockResolvedValue(updatedOwner);
      otpService.verifyOtp.mockResolvedValue(undefined);

      const result = await service.verifyOwnerPhoneLink(
        owner.id,
        SessionAudience.STAFF,
        [Role.SALON_OWNER],
        newPhone,
        '123456',
        'browser-test',
      );

      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        newPhone,
        '123456',
        OtpPurpose.PHONE_LINK,
        owner.id,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: owner.id },
        data: { phone: newPhone, phoneVerifiedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: owner.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'OWNER_PHONE_LINKED',
          metadata: expect.not.objectContaining({ phone: newPhone }),
        }),
      });
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        owner.id,
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
        'browser-test',
      );
      expect(result.success).toBe(true);
      expect(result.user.phone).toBe(newPhone);
      expect(result.user.audience).toBe(SessionAudience.STAFF);
    });
  });

  describe('customer phone linking', () => {
    const customer = {
      id: 'customer-1',
      phone: null,
      phoneVerifiedAt: null,
      email: 'customer@example.com',
      passwordHash: null,
      preferredLanguage: Language.EN,
      status: UserStatus.ACTIVE,
      deletedAt: null,
      roles: [{ role: Role.CUSTOMER, salonId: null }],
    };

    it('requires a CUSTOMER-audience session before requesting a phone link code', async () => {
      await expect(
        service.requestCustomerPhoneLinkOtp(
          customer.id,
          SessionAudience.STAFF,
          [Role.SALON_OWNER],
          '+919900000000',
        ),
      ).rejects.toMatchObject({ code: AuthErrorCode.FORBIDDEN_ROLE });
      expect(otpService.requestOtp).not.toHaveBeenCalled();
    });

    it('links the unique phone transactionally, audits without PII, revokes sessions, and reissues CUSTOMER only', async () => {
      const phone = '+919900000000';
      const linkedCustomer = { ...customer, phone };
      prisma.user.findUnique
        .mockResolvedValueOnce(customer) // request authorization
        .mockResolvedValueOnce(null) // request phone uniqueness
        .mockResolvedValueOnce(customer) // verify authorization
        .mockResolvedValueOnce(customer) // transaction recheck
        .mockResolvedValueOnce(null); // phone uniqueness recheck
      prisma.user.findUniqueOrThrow.mockResolvedValue(linkedCustomer);
      otpService.requestOtp.mockResolvedValue({ expiresInSeconds: 300 });
      otpService.verifyOtp.mockResolvedValue(undefined);

      await service.requestCustomerPhoneLinkOtp(
        customer.id,
        SessionAudience.CUSTOMER,
        [Role.CUSTOMER],
        phone,
      );
      const result = await service.verifyCustomerPhoneLink(
        customer.id,
        SessionAudience.CUSTOMER,
        [Role.CUSTOMER],
        phone,
        '123456',
        'browser-test',
      );

      expect(otpService.requestOtp).toHaveBeenCalledWith(
        phone,
        OtpPurpose.PHONE_LINK,
        customer.id,
      );
      expect(otpService.verifyOtp).toHaveBeenCalledWith(
        phone,
        '123456',
        OtpPurpose.PHONE_LINK,
        customer.id,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: customer.id },
        data: { phone, phoneVerifiedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: customer.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CUSTOMER_PHONE_LINKED',
          metadata: expect.not.objectContaining({ phone }),
        }),
      });
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        customer.id,
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        'browser-test',
      );
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
    });
  });

  describe('googleLogin', () => {
    const verifiedIdentity = {
      sub: 'google-sub-123',
      email: 'alex@example.com',
      name: 'Alex',
    };

    it('creates a new CUSTOMER user + AuthIdentity when neither the sub nor the email matches anything existing', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        phone: null,
        email: 'alex@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      const result = await service.googleLogin('id-token');

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'alex@example.com',
            roles: { create: { role: Role.CUSTOMER } },
            authIdentities: {
              create: {
                provider: 'GOOGLE',
                providerSub: 'google-sub-123',
                email: 'alex@example.com',
              },
            },
          }),
        }),
      );
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.tokens).toBe(fakeTokens);
      // No redundant extra role grant — the just-created user already has CUSTOMER.
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('[Test A] a user holding CUSTOMER + PLATFORM_ADMIN never receives PLATFORM_ADMIN via customer Google login, even using the same Google identity as the admin account', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'u1',
          phone: null,
          email: 'alex@example.com',
          status: UserStatus.ACTIVE,
          roles: [
            { role: Role.CUSTOMER },
            { role: Role.PLATFORM_ADMIN, salonId: null },
          ],
        },
      });

      const result = await service.googleLogin('id-token');

      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'u1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        undefined,
      );
    });

    it('logs in as the existing linked user on a repeat Google login — never creates a duplicate', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'u1',
          phone: null,
          email: 'alex@example.com',
          status: UserStatus.ACTIVE,
          roles: [{ role: Role.CUSTOMER }],
        },
      });

      const result = await service.googleLogin('id-token');

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
    });

    it('links a new Google identity to an existing user matched by verified email, without creating a duplicate customer', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-customer',
        phone: '+919876543210',
        email: 'alex@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      const result = await service.googleLogin('id-token');

      expect(prisma.authIdentity.create).toHaveBeenCalledWith({
        data: {
          userId: 'existing-customer',
          provider: 'GOOGLE',
          providerSub: 'google-sub-123',
          email: 'alex@example.com',
        },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('links to an existing staff account by verified email and grants CUSTOMER at the DB level, but the resulting session is CUSTOMER-audience only — it never carries SALON_STAFF', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-staff',
        phone: null,
        email: 'alex@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_STAFF }],
      });

      const result = await service.googleLogin('id-token');

      expect(prisma.authIdentity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'existing-staff' }),
        }),
      );
      expect(prisma.userRole.create).toHaveBeenCalledWith({
        data: { userId: 'existing-staff', role: Role.CUSTOMER },
      });
      // "Sign in with Google as a customer" is a CUSTOMER-audience session (same rationale as
      // Test A) — the underlying User row keeps its SALON_STAFF role untouched in the DB, but
      // this login surface must never assert it into the session/token.
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
    });

    it('propagates an invalid Google token without touching the database or issuing tokens', async () => {
      googleAuthService.verifyIdToken.mockRejectedValue(
        new AppException(AuthErrorCode.GOOGLE_TOKEN_INVALID, 'bad token', 401),
      );
      await expect(service.googleLogin('bad-token')).rejects.toMatchObject({
        code: AuthErrorCode.GOOGLE_TOKEN_INVALID,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a suspended account matched via Google, even with a fully valid token', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'u1',
          email: 'alex@example.com',
          status: UserStatus.SUSPENDED,
          roles: [{ role: Role.CUSTOMER }],
        },
      });
      await expect(service.googleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('ownerSignup', () => {
    it('creates a password-backed onboarding account with CUSTOMER-only session scope', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      passwordService.hash.mockResolvedValue('hashed-password');
      prisma.user.create.mockResolvedValue({
        id: 'prospective-owner-1',
        phone: null,
        email: 'owner@example.com',
        passwordHash: 'hashed-password',
        preferredLanguage: Language.EN,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      const result = await service.ownerSignup(
        '  Owner@Example.COM  ',
        'password123',
        'test-device',
      );

      expect(passwordService.hash).toHaveBeenCalledWith('password123');
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'owner@example.com',
            passwordHash: 'hashed-password',
            status: UserStatus.ACTIVE,
            roles: { create: { role: Role.CUSTOMER } },
          }),
          include: { roles: true },
        }),
      );
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'prospective-owner-1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        'test-device',
      );
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.user.audience).toBe(SessionAudience.CUSTOMER);
      expect(result.user.passwordConfigured).toBe(true);
      expect(result.tokens).toBe(fakeTokens);
    });

    it('resumes an unfinished password-backed owner onboarding account with the same credentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'prospective-owner-1',
        phone: null,
        email: 'owner@example.com',
        passwordHash: 'hashed-password',
        preferredLanguage: Language.EN,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });
      passwordService.compare.mockResolvedValue(true);

      const result = await service.ownerSignup(
        'owner@example.com',
        'password123',
        'resume-device',
      );

      expect(passwordService.compare).toHaveBeenCalledWith(
        'password123',
        'hashed-password',
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'prospective-owner-1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
        'resume-device',
      );
      expect(result.user.roles).toEqual([Role.CUSTOMER]);
      expect(result.tokens).toBe(fakeTokens);
    });

    it('rejects an email that already belongs to an owner/staff account without changing its roles or password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-owner',
        phone: null,
        email: 'existing@example.com',
        passwordHash: 'hashed-password',
        preferredLanguage: Language.EN,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_OWNER }],
      });

      let thrown: unknown;
      try {
        await service.ownerSignup('existing@example.com', 'password123');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppException);
      expect((thrown as AppException).code).toBe('OWNER_ACCOUNT_EMAIL_EXISTS');
      expect((thrown as AppException).getStatus()).toBe(HttpStatus.CONFLICT);

      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('staffGoogleLogin', () => {
    const verifiedIdentity = {
      sub: 'google-sub-999',
      email: 'owner@example.com',
      name: 'Priya',
    };

    it('authenticates an existing OWNER account matched by verified email, and links the identity', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        phone: null,
        email: 'owner@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_OWNER }],
      });

      const result = await service.staffGoogleLogin('id-token');

      expect(prisma.authIdentity.create).toHaveBeenCalledWith({
        data: {
          userId: 'owner-1',
          provider: 'GOOGLE',
          providerSub: 'google-sub-999',
          email: 'owner@example.com',
        },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.SALON_OWNER]);
      expect(result.tokens).toBe(fakeTokens);
    });

    it('authenticates an existing STAFF account the same way', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'staff-1',
        phone: null,
        email: 'owner@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_STAFF }],
      });

      const result = await service.staffGoogleLogin('id-token');

      expect(result.user.roles).toEqual([Role.SALON_STAFF]);
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('logs in via an already-linked identity on a repeat login — never re-queries by email or creates a duplicate', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'owner-1',
          email: 'owner@example.com',
          status: UserStatus.ACTIVE,
          roles: [{ role: Role.SALON_OWNER }],
        },
      });

      const result = await service.staffGoogleLogin('id-token');

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.SALON_OWNER]);
    });

    it('repairs a missing SALON_OWNER role only when Salon.ownerUserId already proves ownership after DB recovery', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai-owner-recovery',
        user: {
          id: 'recovered-owner',
          phone: null,
          email: 'owner@example.com',
          status: UserStatus.ACTIVE,
          preferredLanguage: Language.EN,
          passwordHash: 'hash',
          roles: [
            { role: Role.CUSTOMER, salonId: null },
            { role: Role.PLATFORM_ADMIN, salonId: null },
          ],
        },
      });
      prisma.salon.findMany.mockResolvedValue([{ id: 'salon-recovered' }]);
      prisma.userRole.createMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValue({
        id: 'recovered-owner',
        phone: null,
        email: 'owner@example.com',
        status: UserStatus.ACTIVE,
        preferredLanguage: Language.EN,
        passwordHash: 'hash',
        roles: [
          { role: Role.CUSTOMER, salonId: null },
          { role: Role.PLATFORM_ADMIN, salonId: null },
          { role: Role.SALON_OWNER, salonId: 'salon-recovered' },
        ],
      });

      const result = await service.staffGoogleLogin('id-token');

      expect(prisma.salon.findMany).toHaveBeenCalledWith({
        where: { ownerUserId: 'recovered-owner' },
        select: { id: true },
      });
      expect(prisma.userRole.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 'recovered-owner',
            role: Role.SALON_OWNER,
            salonId: 'salon-recovered',
          },
        ],
        skipDuplicates: true,
      });
      expect(result.user.roles).toEqual([Role.SALON_OWNER]);
      expect(result.user.audience).toBe(SessionAudience.STAFF);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'recovered-owner',
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
        undefined,
      );
    });

    it('rejects a customer-only account matched by email — never links the identity, never elevates the account', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'customer-1',
        phone: '+919876543210',
        email: 'owner@example.com',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });

      await expect(service.staffGoogleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_STAFF,
      });
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a Google account with no matching user at all — creates nothing', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.staffGoogleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_STAFF,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a verified Google token with no email claim and no existing linked identity', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue({
        sub: 'google-sub-no-email',
        email: null,
        name: null,
      });
      prisma.authIdentity.findUnique.mockResolvedValue(null);

      await expect(service.staffGoogleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_STAFF,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('re-checks roles on the linked user even on a repeat login — rejects if the role was since removed', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'former-owner',
          email: 'owner@example.com',
          status: UserStatus.ACTIVE,
          roles: [{ role: Role.CUSTOMER }],
        },
      });

      await expect(service.staffGoogleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_STAFF,
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('propagates an invalid Google token without touching the database or issuing tokens', async () => {
      googleAuthService.verifyIdToken.mockRejectedValue(
        new AppException(AuthErrorCode.GOOGLE_TOKEN_INVALID, 'bad token', 401),
      );
      await expect(service.staffGoogleLogin('bad-token')).rejects.toMatchObject(
        {
          code: AuthErrorCode.GOOGLE_TOKEN_INVALID,
        },
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects a suspended owner account, even with a fully valid token and a linked identity', async () => {
      googleAuthService.verifyIdToken.mockResolvedValue(verifiedIdentity);
      prisma.authIdentity.findUnique.mockResolvedValue({
        id: 'ai1',
        user: {
          id: 'owner-1',
          email: 'owner@example.com',
          status: UserStatus.SUSPENDED,
          roles: [{ role: Role.SALON_OWNER }],
        },
      });
      await expect(service.staffGoogleLogin('id-token')).rejects.toMatchObject({
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('staffLogin', () => {
    it('logs in a valid staff member', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u2',
        email: 'staff@salon.com',
        phone: null,
        passwordHash: 'hash',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_STAFF }],
      });
      passwordService.compare.mockResolvedValue(true);

      const result = await service.staffLogin(
        'staff@salon.com',
        'correct-password',
      );
      expect(result.user.roles).toEqual([Role.SALON_STAFF]);
    });

    it('rejects an unknown email with the same error as a wrong password (no user enumeration)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      passwordService.compare.mockResolvedValue(false);
      await expect(
        service.staffLogin('nobody@nowhere.com', 'whatever'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
      // Still compares against a hash even for a nonexistent user — constant-shape failure path.
      expect(passwordService.compare).toHaveBeenCalled();
    });

    it('rejects a correct password for a user who is not staff/owner (e.g. a customer)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u3',
        email: 'customer@example.com',
        passwordHash: 'hash',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });
      passwordService.compare.mockResolvedValue(true);
      await expect(
        service.staffLogin('customer@example.com', 'correct-password'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('rejects a suspended staff account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u4',
        email: 'staff@salon.com',
        passwordHash: 'hash',
        status: UserStatus.SUSPENDED,
        roles: [{ role: Role.SALON_STAFF }],
      });
      passwordService.compare.mockResolvedValue(true);
      await expect(
        service.staffLogin('staff@salon.com', 'correct-password'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    });
  });

  describe('adminLogin', () => {
    const adminUser = {
      id: 'admin1',
      email: 'admin@barbercue.app',
      passwordHash: 'hash',
      status: UserStatus.ACTIVE,
      twoFactorEnabled: true,
      totpSecret: 'encrypted-secret',
      roles: [{ role: Role.PLATFORM_ADMIN, salonId: null }],
    };

    it('requires a TOTP code even with a correct password', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      passwordService.compare.mockResolvedValue(true);
      await expect(
        service.adminLogin(
          'admin@barbercue.app',
          'correct-password',
          undefined,
        ),
      ).rejects.toMatchObject({
        code: AuthErrorCode.TOTP_REQUIRED,
      });
    });

    it('rejects an incorrect TOTP code', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      passwordService.compare.mockResolvedValue(true);
      cryptoService.decrypt.mockReturnValue('plain-secret');
      totpService.verifyToken.mockResolvedValue(false);
      await expect(
        service.adminLogin('admin@barbercue.app', 'correct-password', '000000'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.TOTP_INVALID,
      });
    });

    it('[Test F] logs in with a correct password and correct TOTP code, issuing an ADMIN-audience session with PLATFORM_ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      passwordService.compare.mockResolvedValue(true);
      cryptoService.decrypt.mockReturnValue('plain-secret');
      totpService.verifyToken.mockResolvedValue(true);
      const result = await service.adminLogin(
        'admin@barbercue.app',
        'correct-password',
        '123456',
      );
      expect(result.user.roles).toEqual([Role.PLATFORM_ADMIN]);
      expect(result.user.audience).toBe(SessionAudience.ADMIN);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'admin1',
        [Role.PLATFORM_ADMIN],
        SessionAudience.ADMIN,
        undefined,
      );
    });

    it.each([
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
      Role.SALES_ADMIN,
      Role.PLATFORM_VIEWER,
    ])(
      'allows global %s only after the mandatory authenticator check',
      async (role) => {
        prisma.user.findUnique.mockResolvedValue({
          ...adminUser,
          roles: [{ role, salonId: null }],
        });
        passwordService.compare.mockResolvedValue(true);
        cryptoService.decrypt.mockReturnValue('plain-secret');
        totpService.verifyToken.mockResolvedValue(true);

        const result = await service.adminLogin(
          'admin@barbercue.app',
          'correct-password',
          '123456',
        );

        expect(result.user.roles).toEqual([role]);
        expect(result.user.audience).toBe(SessionAudience.ADMIN);
        expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
          'admin1',
          [role],
          SessionAudience.ADMIN,
          undefined,
        );
      },
    );

    it('does not put malformed salon-scoped admin roles into a mixed-role ADMIN token', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...adminUser,
        roles: [
          { role: Role.PLATFORM_ADMIN, salonId: null },
          { role: Role.CO_FOUNDER, salonId: 'salon-1' },
        ],
      });
      passwordService.compare.mockResolvedValue(true);
      cryptoService.decrypt.mockReturnValue('plain-secret');
      totpService.verifyToken.mockResolvedValue(true);

      const result = await service.adminLogin(
        'admin@barbercue.app',
        'correct-password',
        '123456',
      );

      expect(result.user.roles).toEqual([Role.PLATFORM_ADMIN]);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'admin1',
        [Role.PLATFORM_ADMIN],
        SessionAudience.ADMIN,
        undefined,
      );
    });

    it('refuses to bypass 2FA even if somehow disabled on an admin account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...adminUser,
        twoFactorEnabled: false,
        totpSecret: null,
      });
      passwordService.compare.mockResolvedValue(true);
      await expect(
        service.adminLogin(
          'admin@barbercue.app',
          'correct-password',
          undefined,
        ),
      ).rejects.toMatchObject({
        code: AuthErrorCode.TOTP_SETUP_REQUIRED,
      });
    });

    it('[Test I] rejects a malformed salon-scoped PLATFORM_ADMIN row — the role only grants admin-login eligibility when global', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...adminUser,
        roles: [{ role: Role.PLATFORM_ADMIN, salonId: 's1' }],
      });
      passwordService.compare.mockResolvedValue(true);
      await expect(
        service.adminLogin('admin@barbercue.app', 'correct-password', '123456'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('adminGoogleLogin', () => {
    const verified = { sub: 'google-admin', email: 'admin@barbercue.app' };
    const admin = {
      id: 'admin1',
      email: 'admin@barbercue.app',
      phone: null,
      passwordHash: 'hash',
      preferredLanguage: Language.EN,
      status: UserStatus.ACTIVE,
      twoFactorEnabled: true,
      totpSecret: 'encrypted-secret',
      roles: [{ role: Role.PLATFORM_ADMIN, salonId: null }],
    };

    beforeEach(() => {
      googleAuthService.verifyIdToken.mockResolvedValue(verified);
      cryptoService.decrypt.mockReturnValue('plain-secret');
    });

    it('[Test D] never issues a session before the mandatory authenticator code', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({ user: admin });
      await expect(
        service.adminGoogleLogin('id-token', undefined),
      ).rejects.toMatchObject({ code: AuthErrorCode.TOTP_REQUIRED });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('detects an undecryptable restored TOTP secret before prompting for an impossible code', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({ user: admin });
      cryptoService.decrypt.mockImplementationOnce(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });

      await expect(
        service.adminGoogleLogin('id-token', undefined),
      ).rejects.toMatchObject({ code: AuthErrorCode.TOTP_SETUP_REQUIRED });
      expect(totpService.verifyToken).not.toHaveBeenCalled();
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('turns an undecryptable restored TOTP secret into a secure setup-required response instead of a 500', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({ user: admin });
      cryptoService.decrypt.mockImplementationOnce(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });

      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.TOTP_SETUP_REQUIRED });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects an invalid authenticator code', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({ user: admin });
      totpService.verifyToken.mockResolvedValue(false);
      await expect(
        service.adminGoogleLogin('id-token', '000000'),
      ).rejects.toMatchObject({ code: AuthErrorCode.TOTP_INVALID });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('[Test E] signs in a linked active admin only after valid TOTP, issuing an ADMIN-audience session with PLATFORM_ADMIN', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({ user: admin });
      totpService.verifyToken.mockResolvedValue(true);
      const result = await service.adminGoogleLogin('id-token', '123456');
      expect(result.user.roles).toEqual([Role.PLATFORM_ADMIN]);
      expect(result.user.audience).toBe(SessionAudience.ADMIN);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'admin1',
        [Role.PLATFORM_ADMIN],
        SessionAudience.ADMIN,
        undefined,
      );
    });

    it('signs in an approved PLATFORM_VIEWER only after valid TOTP and never grants PLATFORM_ADMIN', async () => {
      const viewer = {
        ...admin,
        id: 'viewer1',
        email: 'viewer@example.com',
        roles: [{ role: Role.PLATFORM_VIEWER, salonId: null }],
      };
      prisma.authIdentity.findUnique.mockResolvedValue({ user: viewer });
      totpService.verifyToken.mockResolvedValue(true);

      const result = await service.adminGoogleLogin('id-token', '123456');

      expect(result.user.roles).toEqual([Role.PLATFORM_VIEWER]);
      expect(result.user.roles).not.toContain(Role.PLATFORM_ADMIN);
      expect(result.user.audience).toBe(SessionAudience.ADMIN);
      expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
        'viewer1',
        [Role.PLATFORM_VIEWER],
        SessionAudience.ADMIN,
        undefined,
      );
    });

    it.each([Role.CO_FOUNDER, Role.HR_ADMIN, Role.SALES_ADMIN])(
      'signs in global %s only through the Google + TOTP ADMIN flow',
      async (role) => {
        prisma.authIdentity.findUnique.mockResolvedValue({
          user: { ...admin, roles: [{ role, salonId: null }] },
        });
        totpService.verifyToken.mockResolvedValue(true);

        const result = await service.adminGoogleLogin('id-token', '123456');

        expect(result.user.roles).toEqual([role]);
        expect(result.user.audience).toBe(SessionAudience.ADMIN);
        expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
          'admin1',
          [role],
          SessionAudience.ADMIN,
          undefined,
        );
      },
    );

    it.each([
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
      Role.SALES_ADMIN,
      Role.PLATFORM_VIEWER,
    ])(
      'rejects a salon-scoped %s role as Google admin-login eligibility',
      async (role) => {
        prisma.authIdentity.findUnique.mockResolvedValue({
          user: { ...admin, roles: [{ role, salonId: 'salon-1' }] },
        });

        await expect(
          service.adminGoogleLogin('id-token', '123456'),
        ).rejects.toMatchObject({
          code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN,
        });
        expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['customer', Role.CUSTOMER],
      ['owner', Role.SALON_OWNER],
      ['staff', Role.SALON_STAFF],
    ])(
      'rejects a linked %s-only account after re-checking current roles',
      async (_label, role) => {
        prisma.authIdentity.findUnique.mockResolvedValue({
          user: { ...admin, roles: [{ role }] },
        });
        await expect(
          service.adminGoogleLogin('id-token', '123456'),
        ).rejects.toMatchObject({
          code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN,
        });
        expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
      },
    );

    it('rejects an unknown Google user without creating a User or role', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
    });

    it('does not link or elevate an unlinked customer whose verified email matches', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        ...admin,
        id: 'customer1',
        roles: [{ role: Role.CUSTOMER }],
      });
      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN });
      expect(prisma.authIdentity.create).not.toHaveBeenCalled();
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('links a verified matching email only when the existing user is already an admin', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(admin);
      totpService.verifyToken.mockResolvedValue(true);
      await service.adminGoogleLogin('id-token', '123456');
      expect(prisma.authIdentity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'admin1' }),
      });
      expect(prisma.userRole.create).not.toHaveBeenCalled();
    });

    it('rejects a suspended admin even when Google and TOTP are valid', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({
        user: { ...admin, status: UserStatus.SUSPENDED },
      });
      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.ACCOUNT_SUSPENDED });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });

    it('rejects an admin without configured TOTP rather than bypassing MFA', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({
        user: { ...admin, twoFactorEnabled: false, totpSecret: null },
      });
      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.TOTP_SETUP_REQUIRED });
    });

    it('[Test I] rejects a malformed salon-scoped PLATFORM_ADMIN row via Google login too — the role only grants admin eligibility when global', async () => {
      prisma.authIdentity.findUnique.mockResolvedValue({
        user: {
          ...admin,
          roles: [{ role: Role.PLATFORM_ADMIN, salonId: 's1' }],
        },
      });
      await expect(
        service.adminGoogleLogin('id-token', '123456'),
      ).rejects.toMatchObject({ code: AuthErrorCode.GOOGLE_ACCOUNT_NOT_ADMIN });
      expect(tokenService.issueTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword / resetPassword', () => {
    it('returns no dev URL and sends no email for an email that has no password (e.g. customer or nonexistent)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword('nobody@nowhere.com');
      expect(result).toEqual({});
      expect(emailSender.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('creates a reset token and emails it for a real staff/owner/admin account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'owner@salon.com',
        passwordHash: 'hash',
        roles: [{ role: Role.SALON_OWNER }],
      });
      prisma.passwordResetToken.create.mockResolvedValue({});

      // devResetUrl is deliberately hidden in production. This test specifically verifies the
      // non-production developer convenience URL, so pin the environment locally and restore it
      // even when an assertion fails. Runtime production behavior is unchanged.
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        const result = await service.forgotPassword('owner@salon.com');
        expect(prisma.passwordResetToken.create).toHaveBeenCalled();
        expect(emailSender.sendPasswordReset).toHaveBeenCalled();
        expect(result.devResetUrl).toContain('/reset-password?token=');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('rejects an unknown or already-used reset token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(null);
      await expect(
        service.resetPassword('bad-token', 'newpassword123'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.RESET_TOKEN_INVALID,
      });
    });

    it('rejects an expired reset token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.resetPassword('expired-token', 'newpassword123'),
      ).rejects.toMatchObject({
        code: AuthErrorCode.RESET_TOKEN_EXPIRED,
      });
    });

    it('updates the password and revokes all sessions on a valid reset', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      passwordService.hash.mockResolvedValue('new-hash');
      await service.resetPassword('good-token', 'newpassword123');
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('allows only one concurrent consumer to claim a reset token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.passwordResetToken.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      passwordService.hash.mockResolvedValue('new-hash');
      const results = await Promise.allSettled([
        service.resetPassword('good-token', 'newpassword123'),
        service.resetPassword('good-token', 'newpassword123'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
    });
  });

  describe('setInitialPassword', () => {
    it('sets the first password on the authenticated verified-email user only', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'google-owner',
        email: 'owner@example.com',
        emailVerifiedAt: new Date(),
        phone: null,
        passwordHash: null,
        preferredLanguage: Language.EN,
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.CUSTOMER }],
      });
      passwordService.hash.mockResolvedValue('new-hash');
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.setInitialPassword(
        'google-owner',
        SessionAudience.CUSTOMER,
        'longenough',
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'google-owner', passwordHash: null },
        data: { passwordHash: 'new-hash' },
      });
      expect(result.passwordConfigured).toBe(true);
    });

    it('does not overwrite an existing password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'owner',
        email: 'owner@example.com',
        emailVerifiedAt: new Date(),
        passwordHash: 'existing',
        status: UserStatus.ACTIVE,
        roles: [{ role: Role.SALON_OWNER }],
      });
      await expect(
        service.setInitialPassword(
          'owner',
          SessionAudience.STAFF,
          'newpassword',
        ),
      ).rejects.toMatchObject({
        code: AuthErrorCode.PASSWORD_ALREADY_CONFIGURED,
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('me / setLanguage (Phase 14)', () => {
    it('includes preferredLanguage in the me() response', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        preferredLanguage: 'HI',
      });
      const result = await service.me(
        'u1',
        [Role.CUSTOMER],
        SessionAudience.CUSTOMER,
      );
      expect(result.preferredLanguage).toBe('HI');
      expect(result.audience).toBe(SessionAudience.CUSTOMER);
    });

    it('updates preferredLanguage and returns it in the response, without touching roles', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'u1',
        phone: '+919876543210',
        email: null,
        preferredLanguage: 'HI',
      });
      const result = await service.setLanguage(
        'u1',
        [Role.SALON_OWNER],
        SessionAudience.STAFF,
        Language.HI,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { preferredLanguage: 'HI' },
      });
      expect(result).toEqual({
        id: 'u1',
        roles: [Role.SALON_OWNER],
        audience: SessionAudience.STAFF,
        phone: '+919876543210',
        email: null,
        preferredLanguage: 'HI',
        passwordConfigured: false,
      });
    });
  });

  describe('deleteCustomerAccount', () => {
    const customer = {
      id: 'customer-1',
      phone: '+919876543210',
      status: UserStatus.ACTIVE,
      deletedAt: null,
      roles: [{ role: Role.CUSTOMER }],
      ownedSalons: [],
      staffMemberships: [],
    };

    it('anonymizes only the authenticated customer, removes direct identity data, and deletes session/OTP/review records', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      await expect(
        service.deleteCustomerAccount('customer-1', SessionAudience.CUSTOMER),
      ).resolves.toEqual({ success: true });

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'customer-1' },
      });
      expect(prisma.otpRequest.deleteMany).toHaveBeenCalledWith({
        where: { phone: '+919876543210' },
      });
      expect(prisma.authIdentity.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'customer-1' },
      });
      expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'customer-1' },
      });
      expect(prisma.queueEntry.updateMany).toHaveBeenCalledWith({
        where: { customerId: 'customer-1' },
        data: { customerId: null },
      });
      expect(prisma.review.deleteMany).toHaveBeenCalledWith({
        where: { customerId: 'customer-1' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'customer-1' },
          data: expect.objectContaining({
            phone: null,
            email: null,
            passwordHash: null,
            status: UserStatus.SUSPENDED,
            deletedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CUSTOMER_ACCOUNT_DELETED',
            entityId: 'customer-1',
          }),
        }),
      );
    });

    it('removes only the authenticated phone OTP rows and never accepts a client-supplied target', async () => {
      let otpRows = [
        { id: 'otp-customer', phone: customer.phone },
        { id: 'otp-unrelated', phone: '+919999999999' },
      ];
      prisma.otpRequest.deleteMany.mockImplementation(
        ({ where: { phone } }: { where: { phone: string } }) => {
          const before = otpRows.length;
          otpRows = otpRows.filter((row) => row.phone !== phone);
          return Promise.resolve({ count: before - otpRows.length });
        },
      );
      prisma.user.findUnique.mockResolvedValue(customer);
      await service.deleteCustomerAccount(
        'customer-1',
        SessionAudience.CUSTOMER,
      );

      expect(prisma.otpRequest.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.otpRequest.deleteMany).toHaveBeenCalledWith({
        where: { phone: customer.phone },
      });
      expect(prisma.otpRequest.deleteMany).not.toHaveBeenCalledWith({
        where: { phone: '+919999999999' },
      });
      expect(otpRows).toEqual([
        { id: 'otp-unrelated', phone: '+919999999999' },
      ]);
    });

    it("deletes only the authenticated customer review rows, preserving other customers' reviews", async () => {
      let reviews = [
        {
          id: 'review-customer',
          customerId: 'customer-1',
          comment: 'Customer review',
          ownerResponse: 'Thanks',
        },
        {
          id: 'review-unrelated',
          customerId: 'customer-2',
          comment: 'Other review',
          ownerResponse: null,
        },
      ];
      prisma.review.deleteMany.mockImplementation(
        ({ where: { customerId } }: { where: { customerId: string } }) => {
          const before = reviews.length;
          reviews = reviews.filter(
            (review) => review.customerId !== customerId,
          );
          return Promise.resolve({ count: before - reviews.length });
        },
      );
      prisma.user.findUnique.mockResolvedValue(customer);
      await service.deleteCustomerAccount(
        'customer-1',
        SessionAudience.CUSTOMER,
      );

      expect(prisma.review.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.review.deleteMany).toHaveBeenCalledWith({
        where: { customerId: 'customer-1' },
      });
      expect(prisma.review.deleteMany).not.toHaveBeenCalledWith({
        where: { customerId: 'customer-2' },
      });
      expect(reviews).toEqual([
        {
          id: 'review-unrelated',
          customerId: 'customer-2',
          comment: 'Other review',
          ownerResponse: null,
        },
      ]);
    });

    it('removes all customer refresh session records so no device metadata or refresh credential remains', async () => {
      let sessions = [
        { id: 'session-customer', userId: 'customer-1', deviceInfo: 'Android' },
        {
          id: 'session-unrelated',
          userId: 'customer-2',
          deviceInfo: 'Other device',
        },
      ];
      prisma.refreshToken.deleteMany.mockImplementation(
        ({ where: { userId } }: { where: { userId: string } }) => {
          const before = sessions.length;
          sessions = sessions.filter((session) => session.userId !== userId);
          return Promise.resolve({ count: before - sessions.length });
        },
      );
      prisma.user.findUnique.mockResolvedValue(customer);
      await service.deleteCustomerAccount(
        'customer-1',
        SessionAudience.CUSTOMER,
      );

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'customer-1' },
      });
      expect(sessions).toEqual([
        {
          id: 'session-unrelated',
          userId: 'customer-2',
          deviceInfo: 'Other device',
        },
      ]);
    });

    it('rejects a non-customer audience before looking up or mutating an account', async () => {
      await expect(
        service.deleteCustomerAccount('owner-1', SessionAudience.STAFF),
      ).rejects.toMatchObject({
        code: AuthErrorCode.FORBIDDEN_ROLE,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a mixed customer/owner account so a customer token cannot delete business data', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...customer,
        roles: [{ role: Role.CUSTOMER }, { role: Role.SALON_OWNER }],
        ownedSalons: [{ id: 'salon-1' }],
      });
      await expect(
        service.deleteCustomerAccount('customer-1', SessionAudience.CUSTOMER),
      ).rejects.toMatchObject({
        code: AuthErrorCode.FORBIDDEN_ROLE,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('fails closed for an already deleted or otherwise inactive account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...customer,
        status: UserStatus.SUSPENDED,
        deletedAt: new Date(),
      });
      await expect(
        service.deleteCustomerAccount('customer-1', SessionAudience.CUSTOMER),
      ).rejects.toMatchObject({
        code: AuthErrorCode.UNAUTHENTICATED,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
