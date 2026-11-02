import {
  createOnboardingSchema,
  normalizeIndianMobile,
  onboardingBucketFor,
  onboardingClosesNextDay,
  onboardingDraftSchema,
  onboardingMissingFields,
  onboardingServiceKey,
  onboardingServiceRowSchema,
  type OnboardingCompletenessInput,
} from '../onboarding';

const complete: OnboardingCompletenessInput = {
  salonName: 'Salon 17 Professionals',
  genderCategory: 'UNISEX',
  salonKind: 'UNISEX_SALON',
  ownerName: 'Owner',
  ownerPhone: '+919876543210',
  streetAddress: 'Express Garden Market',
  locality: 'Indirapuram',
  city: 'Ghaziabad',
  state: 'Uttar Pradesh',
  postalCode: '201014',
  country: 'India',
  employeeCount: 10,
  chairCount: 9,
  consentContact: true,
  consentListing: true,
  consentAccuracy: true,
  consentAuthorization: true,
  hours: [{ dayOfWeek: 1, isClosed: false, opensAt: '09:00', closesAt: '21:00' }],
  services: [
    { serviceName: 'Haircut', isActive: true, basePrice: 150, durationMinutes: 30, confirmedByEmployee: true },
  ],
  media: [{ category: 'EXTERIOR' }],
};

describe('normalizeIndianMobile', () => {
  it.each([
    ['9999221320', '+919999221320'],
    ['+91 99992 21320', '+919999221320'],
    ['09999221320', '+919999221320'],
    ['919999221320', '+919999221320'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(['12345', '5999221320', '+449999221320', '', null])('rejects %s', (input) => {
    expect(normalizeIndianMobile(input as string | null)).toBeNull();
  });
});

describe('onboardingMissingFields', () => {
  it('passes a complete application', () => {
    expect(onboardingMissingFields(complete)).toEqual([]);
  });

  it('never treats missing durations, prices, photos or consent as present', () => {
    const missing = onboardingMissingFields({
      ...complete,
      postalCode: null,
      genderCategory: null,
      consentContact: false,
      media: [{ category: 'MENU' }],
      services: [
        { serviceName: 'Facial', isActive: true, basePrice: 800, durationMinutes: null, confirmedByEmployee: false },
        { serviceName: 'Spa', isActive: true, basePrice: null, durationMinutes: 60, confirmedByEmployee: true },
      ],
    });
    const text = missing.map((m) => m.message).join(' | ');
    expect(missing.map((m) => m.field)).toEqual(
      expect.arrayContaining(['postalCode', 'genderCategory', 'consent', 'photos', 'services']),
    );
    expect(text).toContain('Duration not confirmed for: Facial');
    expect(text).toContain('Price missing for: Spa');
    expect(text).toContain('Confirm these services');
  });

  it('accepts an admin photo exception instead of a shop photo', () => {
    expect(
      onboardingMissingFields({ ...complete, media: [], photoExceptionReason: 'Shop under renovation' }),
    ).toEqual([]);
  });

  it('ignores inactive services', () => {
    const missing = onboardingMissingFields({
      ...complete,
      services: [
        ...complete.services,
        { serviceName: 'Old', isActive: false, basePrice: null, durationMinutes: null, confirmedByEmployee: false },
      ],
    });
    expect(missing).toEqual([]);
  });
});

describe('schemas', () => {
  it('requires a salon name to create', () => {
    expect(createOnboardingSchema.safeParse({}).success).toBe(false);
    expect(createOnboardingSchema.safeParse({ salonName: 'A' }).success).toBe(true);
  });

  it('normalizes phones, PIN codes and blanks in a draft', () => {
    const parsed = onboardingDraftSchema.parse({ ownerPhone: '99992 21320', postalCode: '', ownerEmail: 'A@B.COM' });
    expect(parsed).toMatchObject({ ownerPhone: '+919999221320', postalCode: null, ownerEmail: 'a@b.com' });
    expect(onboardingDraftSchema.safeParse({ postalCode: '12345' }).success).toBe(false);
    expect(onboardingDraftSchema.safeParse({ ownerPhone: '12345' }).success).toBe(false);
  });

  it('rejects unknown keys, duplicate days and active chairs above total', () => {
    expect(onboardingDraftSchema.safeParse({ hacked: true }).success).toBe(false);
    expect(
      onboardingDraftSchema.safeParse({
        hours: [
          { dayOfWeek: 1, isClosed: true },
          { dayOfWeek: 1, isClosed: true },
        ],
      }).success,
    ).toBe(false);
    expect(onboardingDraftSchema.safeParse({ chairCount: 2, activeChairCount: 3 }).success).toBe(false);
  });

  it('supports past-midnight hours and requires times for open days', () => {
    expect(onboardingClosesNextDay('18:00', '02:00')).toBe(true);
    expect(onboardingClosesNextDay('09:00', '21:00')).toBe(false);
    expect(onboardingDraftSchema.safeParse({ hours: [{ dayOfWeek: 0, isClosed: false }] }).success).toBe(false);
  });

  it('keeps a service with no duration as null rather than inventing one', () => {
    const row = onboardingServiceRowSchema.parse({ serviceName: 'Hair Spa', basePrice: 1000, priceType: 'STARTS_FROM' });
    expect(row.durationMinutes).toBeUndefined();
    expect(row.confirmedByEmployee).toBe(false);
    expect(
      onboardingServiceRowSchema.safeParse({ serviceName: 'X', basePrice: 100, discountedPrice: 200 }).success,
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('merges service names regardless of case and punctuation', () => {
    expect(onboardingServiceKey("Men's Haircut", 'MEN')).toBe(onboardingServiceKey('MENS  haircut', 'MEN'));
    expect(onboardingServiceKey('Haircut', 'MEN')).not.toBe(onboardingServiceKey('Haircut', 'WOMEN'));
  });

  it('maps statuses to employee tab buckets', () => {
    expect(onboardingBucketFor('RESUBMITTED')).toBe('pending');
    expect(onboardingBucketFor('OWNER_INVITED')).toBe('approved');
    expect(onboardingBucketFor('ACTIVE')).toBe('activated');
  });
});
