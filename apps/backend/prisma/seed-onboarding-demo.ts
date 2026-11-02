/**
 * LOCAL DEVELOPMENT ONLY: creates the "Salon 17 Professionals" sample as a DRAFT salon onboarding
 * application so the employee and admin onboarding screens can be exercised.
 *
 *   DATABASE_URL=postgresql://...@127.0.0.1:5432/barbercue_dev \
 *     npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/seed-onboarding-demo.ts [EMPLOYEE_CODE]
 *
 * Safety:
 * - refuses NODE_ENV=production and any non-loopback database host;
 * - writes a DRAFT only: nothing is approved, published, or sent, and no owner account is created;
 * - every unknown detail stays NULL (PIN code, gender category, service durations, WhatsApp,
 *   photos, menu photo, consent, coordinates), exactly as the sample specifies, so the draft cannot
 *   be submitted until a person supplies them;
 * - idempotent: re-running finds the existing draft instead of creating another.
 * In development the email sender only logs to the console, so no message can reach the sample
 * owner even if the draft is later completed and approved locally.
 */
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL ?? '';
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed onboarding demo data with NODE_ENV=production.');
}
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  throw new Error('Refusing to seed onboarding demo data into a non-local database.');
}

const prisma = new PrismaClient();
const SALON_NAME = 'Salon 17 Professionals';
const SERVICES: Array<[string, number]> = [
  ["Men's Haircut", 150],
  ["Women's Haircut", 400],
  ['Shaving', 100],
  ['Facial', 800],
  ["Men's Head Massage", 200],
  ["Women's Head Massage", 350],
  ['Hair Spa', 1000],
  ['Pedicure', 550],
  ['Manicure', 450],
];

function key(name: string): string {
  return `${name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()}|ANY`;
}

async function main() {
  const code = process.argv[2];
  const employee = code
    ? await prisma.employeeProfile.findUnique({ where: { employeeCode: code } })
    : await prisma.employeeProfile.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!employee) {
    throw new Error('No field employee found. Create one in the admin Employees page, or pass an employee code.');
  }

  const existing = await prisma.salonOnboardingApplication.findFirst({
    where: { salonName: SALON_NAME, assignedEmployeeId: employee.id },
    select: { id: true, reference: true, status: true },
  });
  if (existing) {
    console.log(`Demo draft already exists: ${existing.reference} (${existing.status}).`);
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    const lead = await tx.employeeCrmLead.create({
      data: {
        employeeProfileId: employee.id,
        shopName: SALON_NAME,
        contactName: 'Dashrath Kumar',
        phone: '+919999221320',
        email: 'techdhadhrath@gmail.com',
        city: 'Ghaziabad',
        locality: 'Indirapuram',
        addressLine: 'UGF22 LGF20 Express Garden Market',
        source: 'FIELD_VISIT',
        status: 'INTERESTED',
        notes: 'Development sample for salon onboarding. Do not contact.',
      },
    });
    const app = await tx.salonOnboardingApplication.create({
      data: {
        leadId: lead.id,
        assignedEmployeeId: employee.id,
        createdByUserId: employee.userId,
        territory: employee.territory,
        salonName: SALON_NAME,
        ownerName: 'Dashrath Kumar',
        ownerPhone: '+919999221320',
        ownerEmail: 'techdhadhrath@gmail.com',
        shopNumber: 'UGF22 LGF20',
        buildingName: 'Express Garden Market',
        streetAddress: 'Express Garden Market',
        locality: 'Indirapuram',
        city: 'Ghaziabad',
        state: 'Uttar Pradesh',
        country: 'India',
        employeeCount: 10,
        chairCount: 9,
        employeeNotes: 'Development sample. Missing: PIN code, category, durations, WhatsApp, photos, menu photo, consent, coordinates.',
        hours: {
          create: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            dayOfWeek,
            isClosed: false,
            opensAt: new Date('1970-01-01T09:00:00.000Z'),
            closesAt: new Date('1970-01-01T21:00:00.000Z'),
          })),
        },
        services: {
          create: SERVICES.map(([serviceName, price], sortOrder) => ({
            serviceName,
            normalizedKey: key(serviceName),
            basePrice: price,
            // The sample gives no durations: they stay NULL and the row stays unconfirmed.
            durationMinutes: null,
            confirmedByEmployee: false,
            sortOrder,
          })),
        },
        statusHistory: {
          create: { newStatus: 'DRAFT', actorId: employee.userId, reason: 'Development sample draft' },
        },
      },
      select: { reference: true },
    });
    return app;
  });
  console.log(`Created demo draft ${created.reference} for ${employee.employeeCode}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
