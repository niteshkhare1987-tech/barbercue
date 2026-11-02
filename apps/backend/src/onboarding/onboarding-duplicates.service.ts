import { Injectable } from '@nestjs/common';
import {
  normalizeSalonNameForMatch,
  type OnboardingDuplicateDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';

interface DuplicateProbe {
  id: string;
  leadId: string;
  salonId: string | null;
  salonName: string;
  city: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
}

/**
 * Possible duplicates of an application among live salons, other applications and other leads,
 * matched on owner phone, owner email, or the same normalized salon name in the same city.
 * Advisory only: a franchise owner legitimately has several branches, so the admin decides.
 * `redact` hides the other record's name for employee callers, so they learn a conflict exists
 * without seeing another employee's private lead.
 */
@Injectable()
export class OnboardingDuplicatesService {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    app: DuplicateProbe,
    redact = false,
  ): Promise<OnboardingDuplicateDto[]> {
    const results: OnboardingDuplicateDto[] = [];
    const phone = app.ownerPhone;
    const email = app.ownerEmail?.toLowerCase() ?? null;
    const nameKey = normalizeSalonNameForMatch(app.salonName);
    const city = app.city?.trim() ?? null;

    const contactOr = [
      ...(phone ? [{ phone }] : []),
      ...(email
        ? [{ email: { equals: email, mode: 'insensitive' as const } }]
        : []),
    ];

    const salons = await this.prisma.salon.findMany({
      where: {
        ...(app.salonId ? { id: { not: app.salonId } } : {}),
        OR: [
          ...contactOr,
          ...(phone ? [{ owner: { phone } }] : []),
          ...(email
            ? [
                {
                  owner: {
                    email: { equals: email, mode: 'insensitive' as const },
                  },
                },
              ]
            : []),
          ...(city
            ? [
                {
                  city: {
                    name: { equals: city, mode: 'insensitive' as const },
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        name: true,
        publicId: true,
        status: true,
        phone: true,
        email: true,
        owner: { select: { phone: true, email: true } },
        city: { select: { name: true } },
      },
      take: 200,
    });
    for (const s of salons) {
      const reasons: string[] = [];
      if (phone && (s.phone === phone || s.owner.phone === phone))
        reasons.push('same owner phone');
      if (
        email &&
        (s.email?.toLowerCase() === email ||
          s.owner.email?.toLowerCase() === email)
      ) {
        reasons.push('same owner email');
      }
      if (
        city &&
        s.city.name.toLowerCase() === city.toLowerCase() &&
        normalizeSalonNameForMatch(s.name) === nameKey
      ) {
        reasons.push('same name in the same city');
      }
      if (!reasons.length) continue;
      results.push({
        kind: 'SALON',
        id: redact ? '' : s.id,
        label: redact
          ? `Existing FastQue shop ${s.publicId}`
          : `${s.name} (${s.publicId})`,
        reason: reasons.join(', '),
        status: s.status,
      });
    }

    const apps = await this.prisma.salonOnboardingApplication.findMany({
      where: {
        id: { not: app.id },
        status: { not: 'REJECTED' },
        OR: [
          ...(phone ? [{ ownerPhone: phone }] : []),
          ...(email
            ? [{ ownerEmail: { equals: email, mode: 'insensitive' as const } }]
            : []),
          ...(city
            ? [{ city: { equals: city, mode: 'insensitive' as const } }]
            : []),
        ],
      },
      select: {
        id: true,
        reference: true,
        salonName: true,
        ownerPhone: true,
        ownerEmail: true,
        city: true,
        status: true,
      },
      take: 200,
    });
    for (const a of apps) {
      const reasons: string[] = [];
      if (phone && a.ownerPhone === phone) reasons.push('same owner phone');
      if (email && a.ownerEmail?.toLowerCase() === email)
        reasons.push('same owner email');
      if (
        city &&
        a.city?.toLowerCase() === city.toLowerCase() &&
        normalizeSalonNameForMatch(a.salonName) === nameKey
      ) {
        reasons.push('same name in the same city');
      }
      if (!reasons.length) continue;
      results.push({
        kind: 'APPLICATION',
        id: redact ? '' : a.id,
        label: redact
          ? `Onboarding application ${a.reference}`
          : `${a.salonName} (${a.reference})`,
        reason: reasons.join(', '),
        status: a.status,
      });
    }

    if (phone || email) {
      const leads = await this.prisma.employeeCrmLead.findMany({
        where: {
          id: { not: app.leadId },
          onboardingApplication: null,
          OR: [
            ...(phone ? [{ phone }, { phone: phone.slice(3) }] : []),
            ...(email
              ? [{ email: { equals: email, mode: 'insensitive' as const } }]
              : []),
          ],
        },
        select: { id: true, shopName: true, status: true },
        take: 20,
      });
      for (const l of leads) {
        results.push({
          kind: 'LEAD',
          id: redact ? '' : l.id,
          label: redact ? 'Another field lead' : l.shopName,
          reason: 'same owner contact',
          status: l.status,
        });
      }
    }
    return results;
  }
}
