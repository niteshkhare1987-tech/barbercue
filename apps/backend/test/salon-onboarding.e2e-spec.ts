import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import sharp from 'sharp';
import { Role, SessionAudience } from '@barbercue/shared';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TokenService } from '../src/auth/services/token.service';
import { PasswordService } from '../src/auth/services/password.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  EMAIL_SENDER,
  type EmailSender,
} from '../src/auth/services/email-sender';
import {
  MENU_EXTRACTOR,
  type ExtractedMenuItem,
  type MenuExtractor,
} from '../src/onboarding/menu-extraction/menu-extractor';

/**
 * Salon onboarding, end to end over HTTP against a DISPOSABLE local database (never the dev or a
 * production database): run with DATABASE_URL pointing at a localhost database whose name ends in
 * "_e2e". Email and AI are replaced by in-memory fakes, so nothing leaves the machine; the sample
 * salon's details are used with a synthetic phone/email, never the real owner's contact.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const parsed = (() => {
  try {
    return new URL(DATABASE_URL);
  } catch {
    return null;
  }
})();
const DISPOSABLE =
  !!parsed &&
  ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
  parsed.pathname.endsWith('_e2e');
const maybe = DISPOSABLE ? describe : describe.skip;

type Json = Record<string, any>;

class FakeMailer implements EmailSender {
  failNext = 0;
  invites: Array<{ email: string; url: string }> = [];
  assertAvailable(): void {}
  sendPasswordReset(): Promise<void> {
    return Promise.resolve();
  }
  sendStaffInvitation(): Promise<void> {
    return Promise.resolve();
  }
  sendOwnerInvitation(
    email: string,
    _salon: string,
    url: string,
  ): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('Simulated provider outage'));
    }
    this.invites.push({ email, url });
    return Promise.resolve();
  }
  /** The most recent raw invite token sent to `email` (or to anyone, when omitted). */
  lastToken(email?: string): string {
    const matching = email
      ? this.invites.filter((i) => i.email === email)
      : this.invites;
    const url = new URL(matching[matching.length - 1].url);
    return url.searchParams.get('token') as string;
  }
}

class FakeExtractor implements MenuExtractor {
  readonly provider = 'fake';
  readonly isConfigured = true;
  items: ExtractedMenuItem[] = [];
  extract(): Promise<ExtractedMenuItem[]> {
    return Promise.resolve(this.items);
  }
}

maybe('Salon onboarding workflow (e2e, disposable local database)', () => {
  const run = randomUUID().slice(0, 8);
  const mailer = new FakeMailer();
  const extractor = new FakeExtractor();
  const privateDir = mkdtempSync(join(tmpdir(), 'fq-onb-private-'));
  const publicDir = mkdtempSync(join(tmpdir(), 'fq-onb-public-'));
  const savedEnv = { ...process.env };
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tok: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let phoneCounter = 0;
  const phone = () =>
    `9${String(parseInt(run, 16) % 100_000).padStart(5, '0')}${String(1000 + ++phoneCounter).slice(-4)}`;
  const citySlug = `onbcity-${run}`;
  const cityName = `Onboarding City ${run}`;

  const http = () => request(app.getHttpServer());
  const api = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token?: string,
  ) => {
    const req = http()[method](`/api/v1/${path}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };
  const image = (r: number, g: number, b: number) =>
    sharp({
      create: { width: 48, height: 32, channels: 3, background: { r, g, b } },
    })
      .jpeg()
      .toBuffer();

  async function account(
    label: string,
    roles: Role[],
    audience: SessionAudience,
    territory?: string,
  ) {
    const user = await prisma.user.create({
      data: {
        email: `onb-${run}-${label}@example.test`,
        emailVerifiedAt: new Date(),
      },
    });
    for (const role of roles)
      await prisma.userRole.create({
        data: { userId: user.id, role, salonId: null },
      });
    if (roles.includes(Role.FIELD_EXECUTIVE)) {
      const profile = await prisma.employeeProfile.create({
        data: {
          userId: user.id,
          employeeCode: `ONB-${run}-${label}`,
          fullName: `Field ${label}`,
          territory: territory ?? null,
        },
      });
      ids[`${label}Profile`] = profile.id;
    }
    ids[label] = user.id;
    tok[label] = app
      .get(TokenService)
      .signAccessToken(user.id, roles, audience);
    return user;
  }

  /** A fully complete application owned by `employee`, built through the real API. */
  async function completeApplication(
    employee: string,
    overrides: Json = {},
  ): Promise<Json> {
    const ownerPhone = overrides.ownerPhone ?? phone();
    const created = await api('post', 'employee/onboarding', tok[employee])
      .send({
        salonName: overrides.salonName ?? `Salon 17 Professionals ${run}`,
        ownerName: 'Synthetic Owner',
        ownerPhone,
        ownerEmail:
          overrides.ownerEmail ?? `owner-${run}-${phoneCounter}@example.test`,
        genderCategory: 'UNISEX',
        salonKind: 'UNISEX_SALON',
        streetAddress: 'UGF22 LGF20 Express Garden Market',
        locality: 'Indirapuram',
        city: cityName,
        state: 'Uttar Pradesh',
        postalCode: '201014',
        country: 'India',
        employeeCount: 10,
        chairCount: 9,
        consentContact: true,
        consentListing: true,
        consentAccuracy: true,
        consentAuthorization: true,
        hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
          dayOfWeek: d,
          isClosed: false,
          opensAt: '09:00',
          closesAt: '21:00',
        })),
      })
      .expect(201);
    const id = created.body.id as string;
    await api('put', `employee/onboarding/${id}/services`, tok[employee])
      .send({
        services: [
          {
            serviceName: "Men's Haircut",
            basePrice: 150,
            durationMinutes: 30,
            applicableGender: 'MEN',
            confirmedByEmployee: true,
          },
          {
            serviceName: 'Facial',
            basePrice: 800,
            priceType: 'STARTS_FROM',
            durationMinutes: 45,
            confirmedByEmployee: true,
          },
        ],
      })
      .expect(200);
    await api('post', `employee/onboarding/${id}/media`, tok[employee])
      .field('category', 'EXTERIOR')
      .attach('image', await image(10 + phoneCounter, 20, 30), 'front.jpg')
      .expect(201);
    const res = await api(
      'get',
      `employee/onboarding/${id}`,
      tok[employee],
    ).expect(200);
    return res.body;
  }

  beforeAll(async () => {
    process.env.PRIVATE_STORAGE_DIR = privateDir;
    process.env.LOCAL_STORAGE_DIR = publicDir;
    process.env.LOCAL_STORAGE_PUBLIC_BASE_URL = 'https://uploads.example.test';
    delete process.env.STORAGE_DRIVER;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailer)
      .overrideProvider(MENU_EXTRACTOR)
      .useValue(extractor)
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.city.create({
      data: {
        name: cityName,
        slug: citySlug,
        countryCode: 'IN',
        state: 'Uttar Pradesh',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    await account(
      'empA',
      [Role.FIELD_EXECUTIVE],
      SessionAudience.EMPLOYEE,
      `Territory ${run}`,
    );
    await account(
      'empB',
      [Role.FIELD_EXECUTIVE],
      SessionAudience.EMPLOYEE,
      `Other ${run}`,
    );
    await account(
      'empC',
      [Role.FIELD_EXECUTIVE],
      SessionAudience.EMPLOYEE,
      `Territory ${run}`,
    );
    await account('admin', [Role.PLATFORM_ADMIN], SessionAudience.ADMIN);
    await account('cofounder', [Role.CO_FOUNDER], SessionAudience.ADMIN);
    await account('viewer', [Role.PLATFORM_VIEWER], SessionAudience.ADMIN);
    await account('customer', [Role.CUSTOMER], SessionAudience.CUSTOMER);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    process.env = savedEnv;
    rmSync(privateDir, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
  });

  // 1 + 3 + 4 + 8: new onboarding, drafts, manual services, required-field validation
  it('creates a direct onboarding draft with its own lead and saves/resumes it', async () => {
    const res = await api('post', 'employee/onboarding', tok.empA)
      .send({
        salonName: `Salon 17 Professionals ${run}`,
        ownerName: 'Dashrath Kumar (synthetic)',
        ownerPhone: phone(),
      })
      .expect(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reference).toMatch(/^FQ-ONB-\d{4}-\d{6}$/);
    expect(res.body.postalCode).toBeNull();
    expect(res.body.genderCategory).toBeNull();
    ids.draft = res.body.id;
    const lead = await prisma.employeeCrmLead.findUnique({
      where: { id: res.body.leadId },
    });
    expect(lead?.employeeProfileId).toBe(ids.empAProfile);

    const saved = await api(
      'patch',
      `employee/onboarding/${ids.draft}`,
      tok.empA,
    )
      .send({
        employeeCount: 10,
        chairCount: 9,
        expectedVersion: res.body.version,
        hours: [
          {
            dayOfWeek: 5,
            isClosed: false,
            opensAt: '18:00',
            closesAt: '02:00',
          },
        ],
      })
      .expect(200);
    expect(saved.body.employeeCount).toBe(10);
    expect(saved.body.hours[0]).toMatchObject({
      opensAt: '18:00',
      closesAt: '02:00',
      closesNextDay: true,
    });
    await api('patch', `employee/onboarding/${ids.draft}`, tok.empA)
      .send({ chairCount: 8, expectedVersion: res.body.version })
      .expect(409);
    const resumed = await api(
      'get',
      `employee/onboarding/${ids.draft}`,
      tok.empA,
    ).expect(200);
    expect(resumed.body.chairCount).toBe(9);

    const services = await api(
      'put',
      `employee/onboarding/${ids.draft}/services`,
      tok.empA,
    )
      .send({
        services: [
          { serviceName: "Men's Haircut", basePrice: 150 },
          { serviceName: 'MENS HAIRCUT', basePrice: 150 },
          {
            serviceName: 'Hair Spa',
            basePrice: 1000,
            priceType: 'STARTS_FROM',
          },
        ],
      })
      .expect(200);
    expect(services.body.services).toHaveLength(2);
    expect(
      services.body.services.every((s: Json) => s.durationMinutes === null),
    ).toBe(true);

    const submit = await api(
      'post',
      `employee/onboarding/${ids.draft}/submit`,
      tok.empA,
    )
      .send({})
      .expect(422);
    const fields = submit.body.error.details.missing.map((m: Json) => m.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'postalCode',
        'genderCategory',
        'consent',
        'photos',
        'services',
      ]),
    );
  });

  // 2: converting an existing lead
  it('converts an existing lead without duplicating it', async () => {
    const lead = await api('post', 'employee/leads', tok.empA)
      .send({
        shopName: `Lead Salon ${run}`,
        contactName: 'Lead Owner',
        phone: phone(),
        city: cityName,
        locality: 'Indirapuram',
      })
      .expect(201);
    const conv = await api(
      'post',
      `employee/leads/${lead.body.id}/onboarding`,
      tok.empA,
    )
      .send({})
      .expect(201);
    expect(conv.body).toMatchObject({
      salonName: `Lead Salon ${run}`,
      ownerName: 'Lead Owner',
      city: cityName,
      leadId: lead.body.id,
    });
    expect(conv.body.ownerPhone).toMatch(/^\+91\d{10}$/);
    await api('post', `employee/leads/${lead.body.id}/onboarding`, tok.empA)
      .send({})
      .expect(409);
    await api('post', `employee/leads/${lead.body.id}/onboarding`, tok.empB)
      .send({})
      .expect(404);
    expect(
      await prisma.employeeCrmLead.count({
        where: { shopName: `Lead Salon ${run}` },
      }),
    ).toBe(1);
  });

  // 5 + 6 + 7: photo uploads, menu images, AI extraction with manual correction, upload security
  it('stores photos privately, rejects unsafe uploads, and needs confirmation for AI rows', async () => {
    const id = ids.draft;
    await api('post', `employee/onboarding/${id}/media`, tok.empA)
      .field('category', 'EXTERIOR')
      .attach('image', Buffer.from('<svg onload=alert(1)>'), {
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      })
      .expect(415);
    const photo = await image(200, 10, 10);
    const up = await api('post', `employee/onboarding/${id}/media`, tok.empA)
      .field('category', 'EXTERIOR')
      .attach('image', photo, 'shop.jpg')
      .expect(201);
    expect(up.body.media).toHaveLength(1);
    await api('post', `employee/onboarding/${id}/media`, tok.empA)
      .field('category', 'EXTERIOR')
      .attach('image', photo, 'again.jpg')
      .expect(409);
    const filePath = up.body.media[0].filePath as string;
    expect(filePath).not.toMatch(/^https?:/);
    await http().get(`/api/v1/${filePath}`).expect(401);
    await api('get', filePath, tok.empB).expect(404);
    const file = await api('get', filePath, tok.empA).expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toContain('no-store');

    const menu = await api('post', `employee/onboarding/${id}/media`, tok.empA)
      .field('category', 'MENU')
      .attach('image', await image(10, 200, 10), 'menu.jpg')
      .expect(201);
    const menuId = menu.body.media.find((m: Json) => m.category === 'MENU').id;
    await api(
      'post',
      `employee/onboarding/${id}/media/${up.body.media[0].id}/extract`,
      tok.empA,
    ).expect(400);
    extractor.items = [
      {
        name: 'Shaving',
        category: 'Grooming',
        gender: 'MEN',
        price: 100,
        priceType: 'FIXED',
        durationMinutes: null,
        description: null,
        confidence: 0.9,
        uncertainFields: [],
      },
      {
        name: 'Pedicure',
        category: null,
        gender: null,
        price: null,
        priceType: 'FIXED',
        durationMinutes: null,
        description: null,
        confidence: 0.4,
        uncertainFields: ['basePrice'],
      },
      {
        name: 'Hair Spa',
        category: null,
        gender: null,
        price: 1000,
        priceType: 'STARTS_FROM',
        durationMinutes: null,
        description: null,
        confidence: 0.8,
        uncertainFields: [],
      },
    ];
    const ext = await api(
      'post',
      `employee/onboarding/${id}/media/${menuId}/extract`,
      tok.empA,
    ).expect(201);
    expect(ext.body).toMatchObject({ added: 2, mergedDuplicates: 1 });
    expect(
      ext.body.services.every(
        (s: Json) => !s.confirmedByEmployee && s.durationMinutes === null,
      ),
    ).toBe(true);
    expect(
      ext.body.services.find((s: Json) => s.serviceName === 'Pedicure')
        .uncertainFields,
    ).toContain('basePrice');

    const app1 = await api('get', `employee/onboarding/${id}`, tok.empA).expect(
      200,
    );
    const corrected = app1.body.services.map((s: Json) => ({
      ...s,
      basePrice: s.basePrice ?? 550,
      durationMinutes: 30,
      confirmedByEmployee: true,
    }));
    const put = await api('put', `employee/onboarding/${id}/services`, tok.empA)
      .send({ services: corrected.map(({ id: _id, ...rest }: Json) => rest) })
      .expect(200);
    expect(
      put.body.services.every(
        (s: Json) => s.confirmedByEmployee && s.uncertainFields.length === 0,
      ),
    ).toBe(true);
    expect(
      put.body.services.find((s: Json) => s.serviceName === 'Shaving')
        .sourceType,
    ).toBe('AI_EXTRACTED');
  });

  // 22: privacy between employees
  it('keeps applications private to the employee, with read-only territory sharing', async () => {
    const listB = await api('get', 'employee/onboarding', tok.empB).expect(200);
    expect(listB.body.find((a: Json) => a.id === ids.draft)).toBeUndefined();
    await api('get', `employee/onboarding/${ids.draft}`, tok.empB).expect(404);
    const shared = await api(
      'get',
      `employee/onboarding/${ids.draft}`,
      tok.empC,
    ).expect(200);
    expect(shared.body.canEdit).toBe(false);
    await api('patch', `employee/onboarding/${ids.draft}`, tok.empC)
      .send({ chairCount: 1 })
      .expect(403);
    await api('get', 'employee/onboarding', tok.customer).expect(403);
  });

  // 10 + 11 + 12 + 9: submission, review, change request, resubmission, duplicates
  it('submits, reviews, requests changes, and accepts a resubmission', async () => {
    const full = await completeApplication('empA');
    ids.main = full.id;
    expect(full.missing).toEqual([]);
    const sub = await api(
      'post',
      `employee/onboarding/${ids.main}/submit`,
      tok.empA,
    )
      .send({})
      .expect(201);
    expect(sub.body.status).toBe('SUBMITTED');
    await api('patch', `employee/onboarding/${ids.main}`, tok.empA)
      .send({ chairCount: 3 })
      .expect(409);
    expect(
      await prisma.notification.count({
        where: { userId: ids.admin, type: 'onboarding.submitted' },
      }),
    ).toBeGreaterThan(0);

    const queue = await api(
      'get',
      `admin/onboarding?q=${run}`,
      tok.admin,
    ).expect(200);
    expect(queue.body.items.map((i: Json) => i.id)).toContain(ids.main);
    const viewerList = await api(
      'get',
      `admin/onboarding?q=${run}`,
      tok.viewer,
    ).expect(200);
    expect(
      viewerList.body.items.find((i: Json) => i.id === ids.main).ownerPhone,
    ).toMatch(/^\+\*+\d{2}$/);
    await api(
      'post',
      `admin/onboarding/${ids.main}/start-review`,
      tok.viewer,
    ).expect(403);
    const kpis = await api('get', 'admin/onboarding/kpis', tok.admin).expect(
      200,
    );
    expect(kpis.body.pendingReview).toBeGreaterThan(0);

    const dupe = await completeApplication('empB', {
      ownerPhone: full.ownerPhone,
      salonName: `Branch Two ${run}`,
    });
    ids.dupe = dupe.id;
    const dups = await api(
      'get',
      `admin/onboarding/${ids.main}/duplicates`,
      tok.admin,
    ).expect(200);
    expect(dups.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'APPLICATION', id: ids.dupe }),
      ]),
    );
    const empDups = await api(
      'get',
      `employee/onboarding/${ids.dupe}/duplicates`,
      tok.empB,
    ).expect(200);
    expect(empDups.body[0].id).toBe('');

    const review = await api(
      'post',
      `admin/onboarding/${ids.main}/start-review`,
      tok.admin,
    ).expect(201);
    expect(review.body.status).toBe('UNDER_REVIEW');
    await api('post', `admin/onboarding/${ids.main}/request-changes`, tok.admin)
      .send({ items: [], applicationVersion: review.body.version })
      .expect(400);
    const changes = await api(
      'post',
      `admin/onboarding/${ids.main}/request-changes`,
      tok.admin,
    )
      .send({
        items: [
          {
            field: 'postalCode',
            message: 'PIN code does not match the locality',
          },
        ],
        applicationVersion: review.body.version,
      })
      .expect(201);
    expect(changes.body.status).toBe('CHANGES_REQUESTED');
    expect(
      await prisma.notification.count({
        where: { userId: ids.empA, type: 'onboarding.changes_requested' },
      }),
    ).toBe(1);
    const mine = await api(
      'get',
      `employee/onboarding/${ids.main}`,
      tok.empA,
    ).expect(200);
    expect(mine.body.changeRequest[0].field).toBe('postalCode');
    await api('patch', `employee/onboarding/${ids.main}`, tok.empA)
      .send({ postalCode: '201010' })
      .expect(200);
    const resub = await api(
      'post',
      `employee/onboarding/${ids.main}/submit`,
      tok.empA,
    )
      .send({})
      .expect(201);
    expect(resub.body.status).toBe('RESUBMITTED');
    expect(resub.body.changeRequest).toBeNull();
  });

  // 23: employees cannot approve, and nobody approves their own application
  it('blocks employees and self-review from deciding', async () => {
    await api('post', `admin/onboarding/${ids.main}/approve`, tok.empA)
      .send({ applicationVersion: 1 })
      .expect(403);
    await api('post', `admin/onboarding/${ids.main}/reject`, tok.empA)
      .send({ reason: 'nope nope', applicationVersion: 1 })
      .expect(403);
    // A user who holds both roles still cannot decide their own application.
    await prisma.userRole.create({
      data: { userId: ids.empA, role: Role.PLATFORM_ADMIN, salonId: null },
    });
    const selfAdmin = app
      .get(TokenService)
      .signAccessToken(ids.empA, [Role.PLATFORM_ADMIN], SessionAudience.ADMIN);
    const res = await api(
      'post',
      `admin/onboarding/${ids.main}/approve`,
      selfAdmin,
    )
      .send({ applicationVersion: 99 })
      .expect(403);
    expect(res.body.error.code).toBe('ONBOARDING_SELF_REVIEW_FORBIDDEN');
    await prisma.userRole.deleteMany({
      where: { userId: ids.empA, role: Role.PLATFORM_ADMIN },
    });
  });

  // 13 + 16 + 18 + 24: approval, invitation failure and retry, idempotency
  it('approves once, keeps the salon hidden, and retries a failed invitation', async () => {
    const current = await api(
      'get',
      `admin/onboarding/${ids.main}`,
      tok.admin,
    ).expect(200);
    await api('post', `admin/onboarding/${ids.main}/approve`, tok.admin)
      .send({ applicationVersion: current.body.version - 1 })
      .expect(409);
    mailer.failNext = 1;
    const approved = await api(
      'post',
      `admin/onboarding/${ids.main}/approve`,
      tok.admin,
    )
      .send({
        applicationVersion: current.body.version,
        notes: 'Verified on call',
      })
      .expect(201);
    expect(approved.body.alreadyApproved).toBe(false);
    expect(approved.body.application.status).toBe('OWNER_INVITED');
    expect(approved.body.invitation).toMatchObject({
      status: 'FAILED',
      attempts: 1,
    });
    ids.salon = approved.body.salonId;
    ids.owner = approved.body.ownerUserId;
    const salon = await prisma.salon.findUniqueOrThrow({
      where: { id: ids.salon },
      include: { services: true, operatingHours: true, chairs: true },
    });
    expect(salon.status).toBe('PENDING');
    expect(salon.showPhoneToCustomers).toBe(false);
    expect(salon.services).toHaveLength(2);
    expect(salon.operatingHours).toHaveLength(7);
    expect(salon.chairs).toHaveLength(9);
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ids.owner },
    });
    expect(owner.passwordHash).toBeNull();
    const lead = await prisma.employeeCrmLead.findUniqueOrThrow({
      where: { id: current.body.leadId },
    });
    expect(lead).toMatchObject({
      status: 'ONBOARDED',
      onboardedSalonId: ids.salon,
    });
    const review = await prisma.salonOnboardingReview.findFirstOrThrow({
      where: { applicationId: ids.main, decision: 'APPROVE' },
    });
    expect(review).toMatchObject({
      reviewerId: ids.admin,
      applicationVersion: current.body.version,
      comments: 'Verified on call',
    });

    const again = await api(
      'post',
      `admin/onboarding/${ids.main}/approve`,
      tok.admin,
    )
      .send({ applicationVersion: current.body.version })
      .expect(201);
    expect(again.body).toMatchObject({
      alreadyApproved: true,
      salonId: ids.salon,
    });
    expect(
      await prisma.salon.count({ where: { ownerUserId: ids.owner } }),
    ).toBe(1);

    const search = await api('get', `salons?city=${citySlug}`).expect(200);
    expect(JSON.stringify(search.body)).not.toContain(ids.salon);

    const retry = await api(
      'post',
      `admin/onboarding/${ids.main}/invitation/resend`,
      tok.admin,
    ).expect(201);
    expect(retry.body.application.status).toBe('AWAITING_OWNER_ACTIVATION');
    expect(retry.body.invitation.status).toBe('SENT');
    expect(
      retry.body.application.invitations.filter(
        (i: Json) => i.status === 'REVOKED',
      ),
    ).toHaveLength(1);
    const tokenRow = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: ids.owner, usedAt: null },
    });
    expect(tokenRow.tokenHash).not.toBe(
      mailer.lastToken(retry.body.application.ownerEmail),
    );
    expect(tokenRow.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates exactly one salon under concurrent duplicate approvals', async () => {
    const other = await completeApplication('empA', {
      salonName: `Concurrent ${run}`,
    });
    await api('post', `employee/onboarding/${other.id}/submit`, tok.empA)
      .send({})
      .expect(201);
    const v = (await api('get', `admin/onboarding/${other.id}`, tok.admin)).body
      .version;
    const results = await Promise.all([
      api('post', `admin/onboarding/${other.id}/approve`, tok.admin).send({
        applicationVersion: v,
      }),
      api('post', `admin/onboarding/${other.id}/approve`, tok.cofounder).send({
        applicationVersion: v,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const salonIds = new Set(results.map((r) => r.body.salonId));
    expect(salonIds.size).toBe(1);
    expect(
      await prisma.salon.count({ where: { name: `Concurrent ${run}` } }),
    ).toBe(1);
  });

  // 17 + 19: expired invitation, owner activation
  it('rejects an expired invitation and activates the owner with a fresh one', async () => {
    const ownerEmail = (
      await prisma.user.findUniqueOrThrow({ where: { id: ids.owner } })
    ).email as string;
    const expiredToken = mailer.lastToken(ownerEmail);
    await prisma.passwordResetToken.updateMany({
      where: { userId: ids.owner, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await api('post', 'auth/reset-password').send({
      token: expiredToken,
      newPassword: 'Owner-Pass-12345!',
      confirmPassword: 'Owner-Pass-12345!',
    });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('RESET_TOKEN_EXPIRED');

    await api(
      'post',
      `admin/onboarding/${ids.main}/invitation/resend`,
      tok.admin,
    ).expect(201);
    const fresh = mailer.lastToken(ownerEmail);
    const ok = await api('post', 'auth/reset-password').send({
      token: fresh,
      newPassword: 'Owner-Pass-12345!',
      confirmPassword: 'Owner-Pass-12345!',
    });
    expect([200, 201, 204]).toContain(ok.status);
    const replay = await api('post', 'auth/reset-password').send({
      token: fresh,
      newPassword: 'Another-Pass-12345!',
      confirmPassword: 'Another-Pass-12345!',
    });
    expect(replay.status).toBe(400);

    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ids.owner },
    });
    expect(owner.passwordHash).not.toBeNull();
    expect(owner.emailVerifiedAt).not.toBeNull();
    const detail = await api(
      'get',
      `admin/onboarding/${ids.main}`,
      tok.admin,
    ).expect(200);
    expect(detail.body.status).toBe('READY_TO_PUBLISH');
    expect(detail.body.invitations[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(
      await prisma.notification.count({
        where: { userId: ids.admin, type: 'onboarding.owner_activated' },
      }),
    ).toBeGreaterThan(0);
  });

  // 15: an existing owner is linked, not duplicated
  it('links an existing verified owner who runs another branch', async () => {
    const ownerPhone = phone();
    const existing = await prisma.user.create({
      data: {
        phone: `+91${ownerPhone}`,
        email: `existing-${run}@example.test`,
        emailVerifiedAt: new Date(),
        passwordHash: await app.get(PasswordService).hash('Existing-Pass-123!'),
      },
    });
    const branch = await completeApplication('empA', {
      salonName: `Branch Owner ${run}`,
      ownerPhone,
      ownerEmail: `existing-${run}@example.test`,
    });
    await api('post', `employee/onboarding/${branch.id}/submit`, tok.empA)
      .send({})
      .expect(201);
    const v = (await api('get', `admin/onboarding/${branch.id}`, tok.admin))
      .body.version;
    const before = mailer.invites.length;
    const res = await api(
      'post',
      `admin/onboarding/${branch.id}/approve`,
      tok.admin,
    )
      .send({ applicationVersion: v })
      .expect(201);
    expect(res.body).toMatchObject({
      ownerUserId: existing.id,
      ownerLinkedExisting: true,
    });
    expect(res.body.application.status).toBe('READY_TO_PUBLISH');
    expect(mailer.invites.length).toBe(before);
    expect(
      await prisma.user.count({ where: { phone: `+91${ownerPhone}` } }),
    ).toBe(1);
  });

  // 14: rejection
  it('rejects with a recorded reason and tells the employee', async () => {
    const v = (await api('get', `admin/onboarding/${ids.dupe}`, tok.admin)).body
      .version;
    await api('post', `employee/onboarding/${ids.dupe}/submit`, tok.empB)
      .send({})
      .expect(201);
    const fresh = (await api('get', `admin/onboarding/${ids.dupe}`, tok.admin))
      .body.version;
    expect(fresh).toBe(v);
    await api('post', `admin/onboarding/${ids.dupe}/reject`, tok.admin)
      .send({ reason: 'x', applicationVersion: fresh })
      .expect(400);
    const rej = await api(
      'post',
      `admin/onboarding/${ids.dupe}/reject`,
      tok.admin,
    )
      .send({
        reason: 'Duplicate of an existing branch application',
        applicationVersion: fresh,
      })
      .expect(201);
    expect(rej.body).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Duplicate of an existing branch application',
    });
    expect(
      await prisma.notification.count({
        where: { userId: ids.empB, type: 'onboarding.rejected' },
      }),
    ).toBe(1);
    await api('post', `admin/onboarding/${ids.dupe}/approve`, tok.admin)
      .send({ applicationVersion: fresh })
      .expect(409);
  });

  // 20 + 21 + 26: publication is gated; publishing makes the salon discoverable and bookable-ready
  it('blocks unauthorized publication and publishes once ready', async () => {
    const ownerToken = app
      .get(TokenService)
      .signAccessToken(ids.owner, [Role.SALON_OWNER], SessionAudience.STAFF);
    const ownerPatch = await api(
      'patch',
      `dashboard/salons/${ids.salon}/status`,
      ownerToken,
    ).send({ status: 'ACTIVE' });
    expect(ownerPatch.status).toBe(409);
    await api(
      'post',
      `admin/onboarding/${ids.main}/publish`,
      tok.cofounder,
    ).expect(403);
    await api(
      'post',
      `admin/onboarding/${ids.main}/publish`,
      tok.viewer,
    ).expect(403);
    const notReady = await api(
      'post',
      `admin/onboarding/${ids.main}/publish`,
      tok.admin,
    ).expect(409);
    const failing = notReady.body.error.details.checks
      .filter((c: Json) => !c.ok)
      .map((c: Json) => c.key);
    expect(failing).toEqual(expect.arrayContaining(['capacity', 'photos']));

    // Owner-side setup the dashboard normally does: a barber, plus photos approved for display.
    await prisma.salonStaff.create({
      data: {
        salonId: ids.salon,
        userId: ids.owner,
        displayName: 'Owner Barber',
        roleInSalon: 'OWNER',
        status: 'ACTIVE',
      },
    });
    const detail = await api(
      'get',
      `admin/onboarding/${ids.main}`,
      tok.admin,
    ).expect(200);
    const promoted = await api(
      'post',
      `admin/onboarding/${ids.main}/photos/publish`,
      tok.admin,
    )
      .send({ mediaIds: detail.body.media.map((m: Json) => m.id) })
      .expect(201);
    expect(promoted.body.status).toBe('READY_TO_PUBLISH');
    const photos = await prisma.photo.count({ where: { salonId: ids.salon } });
    for (let i = photos; i < 3; i++) {
      await prisma.photo.create({
        data: {
          salonId: ids.salon,
          url: `https://photos.example.test/${run}-${i}.jpg`,
          type: 'GALLERY',
          sortOrder: i,
        },
      });
    }
    const ready = await api(
      'get',
      `admin/onboarding/${ids.main}/publish-readiness`,
      tok.admin,
    ).expect(200);
    expect(ready.body.ready).toBe(true);

    const published = await api(
      'post',
      `admin/onboarding/${ids.main}/publish`,
      tok.admin,
    );
    if (published.status !== 201)
      throw new Error(
        `publish failed: ${published.status} ${JSON.stringify(published.body)}`,
      );
    expect(published.body.status).toBe('ACTIVE');
    expect(published.body.publishAuthorizedAt).not.toBeNull();
    expect(
      (await prisma.salon.findUniqueOrThrow({ where: { id: ids.salon } }))
        .status,
    ).toBe('ACTIVE');
    const search = await api('get', `salons?city=${citySlug}`).expect(200);
    expect(JSON.stringify(search.body)).toContain(
      `Salon 17 Professionals ${run}`,
    );
    expect(
      await prisma.notification.count({
        where: { userId: ids.empA, type: 'onboarding.published' },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: ids.owner, type: 'onboarding.published' },
      }),
    ).toBe(1);
  });

  // 25: analytics agree across employee and team views
  it('reports consistent employee and team analytics', async () => {
    const mine = await api(
      'get',
      'employee/onboarding/analytics',
      tok.empA,
    ).expect(200);
    const team = await api(
      'get',
      'admin/onboarding/analytics',
      tok.admin,
    ).expect(200);
    const rowA = team.body.employees.find(
      (e: Json) => e.employeeId === ids.empAProfile,
    );
    expect(rowA).toMatchObject(mine.body);
    expect(mine.body).toMatchObject({
      approved: 3,
      ownerActivated: 2,
      publiclyActive: 1,
      rejected: 0,
    });
    expect(mine.body.applicationsStarted).toBeGreaterThanOrEqual(
      mine.body.applicationsSubmitted,
    );
    const rowB = team.body.employees.find(
      (e: Json) => e.employeeId === ids.empBProfile,
    );
    expect(rowB).toMatchObject({ rejected: 1, approved: 0, publiclyActive: 0 });
    const sum = (k: string) =>
      team.body.employees.reduce((s: number, e: Json) => s + e[k], 0);
    for (const k of [
      'approved',
      'rejected',
      'applicationsSubmitted',
      'publiclyActive',
      'ownerActivated',
    ]) {
      expect(team.body.team[k]).toBe(sum(k));
    }
    const counts = await api(
      'get',
      'employee/onboarding/counts',
      tok.empA,
    ).expect(200);
    expect(counts.body.activated).toBe(1);
    expect(counts.body.drafts).toBe(2);
    await api('get', 'admin/onboarding/analytics', tok.empA).expect(403);
  });
});
