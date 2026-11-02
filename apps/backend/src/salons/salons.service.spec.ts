import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { SalonsService } from './salons.service';
import { CitiesService } from './cities.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { TokenService } from '../auth/services/token.service';

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

function makeSalon(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    name: 'BarberCue Demo Salon',
    slug: 'barbercue-demo',
    addressLine: '100 Indiranagar 12th Main',
    lat: 12.9716,
    lng: 77.6412,
    city: { slug: 'bengaluru', countryCode: 'IN' },
    currency: 'INR',
    locality: { slug: 'indiranagar' },
    photos: [],
    operatingHours: [],
    staff: [],
    verification: null,
    isClosedForToday: false,
    ...overrides,
  };
}

interface SalonFindManyArgs {
  where: {
    status: string;
    city?: { slug: string };
    locality?: { slug: string };
  };
}

describe('SalonsService', () => {
  let service: SalonsService;
  let prisma: {
    salon: {
      findMany: jest.Mock<Promise<unknown[]>, [SalonFindManyArgs]>;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      count: jest.Mock;
    };
    review: { aggregate: jest.Mock; groupBy: jest.Mock };
    service: { aggregate: jest.Mock; findMany: jest.Mock; groupBy: jest.Mock };
    queueEntry: { count: jest.Mock; groupBy: jest.Mock };
    offer: { findMany: jest.Mock };
    locality: { findUnique: jest.Mock };
    userRole: { upsert: jest.Mock; findMany: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock };
    operatingHours: { createMany: jest.Mock };
    chair: { createMany: jest.Mock; groupBy: jest.Mock };
    salonStaff: { groupBy: jest.Mock };
    manualChairOccupancy: { groupBy: jest.Mock };
    serviceSession: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let citiesService: {
    findCityBySlugOrThrow: jest.Mock;
    findCityByCountryAndSlugOrThrow: jest.Mock;
  };
  let salonAccess: { assertAccess: jest.Mock; assertOwnerOrAdminAccess: jest.Mock };
  let tokenService: { scopeRolesToAudience: jest.Mock; issueTokenPair: jest.Mock };

  beforeEach(async () => {
    prisma = {
      salon: {
        findMany: jest.fn<Promise<unknown[]>, [SalonFindManyArgs]>(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      review: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { rating: null }, _count: { rating: 0 } }),
        // Search results batch their per-salon figures (SalonsService.toListItems).
        groupBy: jest.fn().mockResolvedValue([]),
      },
      service: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _min: { price: null }, _max: { price: null } }),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      queueEntry: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      offer: { findMany: jest.fn().mockResolvedValue([]) },
      locality: { findUnique: jest.fn() },
      userRole: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      operatingHours: { createMany: jest.fn().mockResolvedValue({ count: 7 }) },
      chair: {
        createMany: jest.fn().mockResolvedValue({ count: 10 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      salonStaff: { groupBy: jest.fn().mockResolvedValue([]) },
      manualChairOccupancy: { groupBy: jest.fn().mockResolvedValue([]) },
      serviceSession: { findMany: jest.fn().mockResolvedValue([]) },
      // registerSalon's post-grant re-read — default shape carries exactly the newly-granted
      // SALON_OWNER role so existing registerSalon tests (which don't care about the minted
      // session) keep passing without each needing to stub this individually.
      user: {
        findUniqueOrThrow: jest.fn((args: { where: { id: string } }) =>
          Promise.resolve({
            id: args.where.id,
            roles: [{ role: 'SALON_OWNER' }],
            phone: null,
            email: null,
            preferredLanguage: 'EN',
            passwordHash: null,
          }),
        ),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    citiesService = {
      findCityBySlugOrThrow: jest.fn(),
      findCityByCountryAndSlugOrThrow: jest.fn(),
    };
    salonAccess = {
      assertAccess: jest.fn().mockResolvedValue(undefined),
      assertOwnerOrAdminAccess: jest.fn().mockResolvedValue('PLATFORM_ADMIN'),
    };
    tokenService = {
      scopeRolesToAudience: jest.fn((roles: string[]) =>
        roles.filter((r) => r === 'SALON_OWNER' || r === 'SALON_STAFF'),
      ),
      issueTokenPair: jest
        .fn()
        .mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SalonsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CitiesService, useValue: citiesService },
        { provide: SalonAccessService, useValue: salonAccess },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();
    service = moduleRef.get(SalonsService);
  });

  describe('getLiveStats', () => {
    it('returns live queue activity without querying or exposing the platform shop total', async () => {
      prisma.queueEntry.count.mockResolvedValue(5);
      const result = await service.getLiveStats();
      expect(result).toEqual({ liveWaitingCount: 5 });
      expect(prisma.salon.count).not.toHaveBeenCalled();
      expect(prisma.queueEntry.count).toHaveBeenCalledWith({
        where: { status: { in: ['WAITING', 'CALLED', 'IN_SERVICE'] } },
      });
    });

    it('returns a real zero queue count on an empty platform, never a fabricated placeholder', async () => {
      prisma.queueEntry.count.mockResolvedValue(0);
      const result = await service.getLiveStats();
      expect(result).toEqual({ liveWaitingCount: 0 });
      expect(prisma.salon.count).not.toHaveBeenCalled();
    });
  });

  describe('searchServiceSuggestions', () => {
    it('returns distinct real active services from ACTIVE shops for a typed service fragment', async () => {
      prisma.service.findMany.mockResolvedValue([
        { name: 'Haircut', category: 'Hair' },
        { name: 'Hair Spa', category: 'Hair' },
      ]);

      await expect(service.searchServiceSuggestions('hair', 8)).resolves.toEqual([
        { name: 'Haircut', category: 'Hair' },
        { name: 'Hair Spa', category: 'Hair' },
      ]);

      expect(prisma.service.findMany).toHaveBeenCalledWith({
        where: {
          isActive: true,
          salon: { status: 'ACTIVE' },
          OR: [
            { name: { contains: 'hair', mode: 'insensitive' } },
            { category: { contains: 'hair', mode: 'insensitive' } },
          ],
        },
        select: { name: true, category: true },
        distinct: ['name'],
        orderBy: { name: 'asc' },
        take: 8,
      });
    });

    it('does not query the database until at least two service characters are typed', async () => {
      await expect(service.searchServiceSuggestions('h')).resolves.toEqual([]);
      expect(prisma.service.findMany).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('always scopes to ACTIVE salons regardless of filters', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({});
      expect(prisma.salon.findMany.mock.calls[0][0].where.status).toBe(
        'ACTIVE',
      );
    });

    it('keeps an owner-closed-for-today ACTIVE shop in discovery and marks it closed', async () => {
      prisma.salon.findMany.mockResolvedValue([
        makeSalon({ isClosedForToday: true }),
      ]);
      const result = await service.search({});
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 's1',
        isClosedForToday: true,
        isOpenNow: false,
      });
      expect(prisma.salon.findMany.mock.calls[0][0].where.status).toBe('ACTIVE');
    });

    it('filters by city and locality slug when provided', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ city: 'bengaluru', locality: 'indiranagar' });
      const { where } = prisma.salon.findMany.mock.calls[0][0];
      expect(where.city).toEqual({ slug: 'bengaluru' });
      expect(where.locality).toEqual({ slug: 'indiranagar' });
    });

    // City.slug is unique only per country, so an unscoped filter could match a same-named city
    // in a different country. City/locality pages and the sitemap pass countryCode; free-text
    // search does not, and must keep matching by slug alone exactly as before this field existed.
    it('scopes the city filter to an exact country when countryCode is supplied', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ city: 'bengaluru', countryCode: 'in' });
      const { where } = prisma.salon.findMany.mock.calls[0][0];
      expect(where.city).toEqual({ slug: 'bengaluru', countryCode: 'IN' });
    });

    it('falls back to matching city by slug alone when no countryCode is given', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ city: 'bengaluru' });
      const { where } = prisma.salon.findMany.mock.calls[0][0];
      expect(where.city).toEqual({ slug: 'bengaluru' });
    });

    it('keeps only salons offering the searched service or an equivalent name', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ serviceName: 'Hair Cutting', limit: 8 });
      const { where } = prisma.salon.findMany.mock.calls[0][0] as {
        where: { status: string; name?: unknown; OR?: unknown; services?: unknown; AND?: unknown };
      };
      expect(where.status).toBe('ACTIVE');
      expect(where.name).toBeUndefined();
      expect(where.OR).toBeUndefined();
      expect(where.services).toBeUndefined();
      const [condition] = where.AND as {
        services: { some: { isActive: boolean; OR: { name: unknown }[]; NOT?: unknown } };
      }[];
      expect(condition.services.some.isActive).toBe(true);
      const names = condition.services.some.OR.map((c) => c.name);
      expect(names).toContainEqual({ contains: 'haircut', mode: 'insensitive' });
      expect(names).toContainEqual({ contains: 'hair trim', mode: 'insensitive' });
      expect(names).toContainEqual({ contains: 'Hair Cutting', mode: 'insensitive' });
      expect(condition.services.some.NOT).toBeUndefined();
    });

    it('excludes service names that are not the searched service (Head Shave is not a Shave)', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ serviceName: 'shaving' });
      const { where } = prisma.salon.findMany.mock.calls[0][0] as { where: { AND?: unknown } };
      const [condition] = where.AND as { services: { some: { NOT: { name: unknown }[] } } }[];
      expect(condition.services.some.NOT).toContainEqual({ name: { contains: 'head shave', mode: 'insensitive' } });
    });

    it('combines the service-name filter with the existing service, city and price filters unchanged', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ serviceName: 'champi', service: 'haircut', city: 'patna', priceMax: 300 });
      const { where } = prisma.salon.findMany.mock.calls[0][0] as {
        where: { name?: unknown; services?: unknown; city?: unknown; AND?: unknown };
      };
      expect(where.name).toBeUndefined();
      expect(where.city).toEqual({ slug: 'patna' });
      // The existing `service` filter keeps its own same-service price rule.
      expect(where.services).toMatchObject({ some: { isActive: true, AND: [expect.anything(), { price: { lte: 300 } }] } });
      const [condition] = where.AND as { services: { some: { OR: { name: unknown }[] } } }[];
      expect(condition.services.some.OR).toContainEqual({ name: { contains: 'head massage', mode: 'insensitive' } });
    });

    // Issue #13 Mission D: the "Shop or service" field previously only matched salon
    // name/description, so typing a real service name (e.g. "beard") for a shop that genuinely
    // offers it returned zero results.
    it('matches q against service name/category, not just salon name/description', async () => {
      prisma.salon.findMany.mockResolvedValue([]);
      await service.search({ q: 'bear' });
      const { where } = prisma.salon.findMany.mock.calls[0][0] as {
        where: { OR?: Record<string, unknown>[] };
      };
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { name: { contains: 'bear', mode: 'insensitive' } },
          { description: { contains: 'bear', mode: 'insensitive' } },
          {
            services: {
              some: {
                isActive: true,
                OR: [
                  { name: { contains: 'bear', mode: 'insensitive' } },
                  { category: { contains: 'bear', mode: 'insensitive' } },
                ],
              },
            },
          },
        ]),
      );
    });

    // Part 8/9 — price filter.
    describe('price filter (priceMin/priceMax)', () => {
      it('adds a services.some price condition via where.AND when only priceMin is given', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({ priceMin: 200 });
        const { where } = prisma.salon.findMany.mock.calls[0][0] as {
          where: { AND?: Record<string, unknown>[] };
        };
        expect(where.AND).toEqual([
          { services: { some: { isActive: true, price: { gte: 200 } } } },
        ]);
      });

      it('adds a services.some price condition via where.AND when only priceMax is given', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({ priceMax: 800 });
        const { where } = prisma.salon.findMany.mock.calls[0][0] as {
          where: { AND?: Record<string, unknown>[] };
        };
        expect(where.AND).toEqual([
          { services: { some: { isActive: true, price: { lte: 800 } } } },
        ]);
      });

      it('combines priceMin and priceMax into a single range condition', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({ priceMin: 200, priceMax: 800 });
        const { where } = prisma.salon.findMany.mock.calls[0][0] as {
          where: { AND?: Record<string, unknown>[] };
        };
        expect(where.AND).toEqual([
          { services: { some: { isActive: true, price: { gte: 200, lte: 800 } } } },
        ]);
      });

      it('adds no price condition at all when neither priceMin nor priceMax is given', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({});
        const { where } = prisma.salon.findMany.mock.calls[0][0] as {
          where: { AND?: unknown };
        };
        expect(where.AND).toBeUndefined();
      });

      // Correction (Part 8/9 review): a price filter combined with a service/text query must be
      // satisfied by the SAME service row, never an unrelated one the salon happens to also sell —
      // searching "Haircut" + "under ₹300" at a salon selling an ₹800 Haircut and a ₹200 Shave must
      // exclude that salon. The broad, independent where.AND price condition is what "no service
      // query" still uses — see the two describe blocks below for both the where-clause
      // construction and genuinely behavioral proof against realistic salon/service data.
      describe('same-service requirement when combined with a service/text query', () => {
        it('folds the price condition into where.services as an AND with the relevance predicate, for the `service` param', async () => {
          prisma.salon.findMany.mockResolvedValue([]);
          await service.search({ service: 'Haircut', priceMin: 200, priceMax: 800 });
          const { where } = prisma.salon.findMany.mock.calls[0][0] as {
            where: { services?: unknown; AND?: unknown };
          };
          expect(where.services).toEqual({
            some: {
              isActive: true,
              AND: [
                {
                  OR: [
                    { name: { contains: 'Haircut', mode: 'insensitive' } },
                    { category: { contains: 'Haircut', mode: 'insensitive' } },
                  ],
                },
                { price: { gte: 200, lte: 800 } },
              ],
            },
          });
          // No redundant broad where.AND price clause — where.services above already fully
          // encodes the price constraint when `service` is present.
          expect(where.AND).toBeUndefined();
        });

        it('applies the identical same-service treatment to `q`\'s own service sub-clause (the field the real search UI actually sends free text through)', async () => {
          prisma.salon.findMany.mockResolvedValue([]);
          await service.search({ q: 'Haircut', priceMax: 300 });
          const { where } = prisma.salon.findMany.mock.calls[0][0] as {
            where: { OR?: Record<string, unknown>[]; AND?: unknown };
          };
          expect(where.OR).toEqual(
            expect.arrayContaining([
              {
                services: {
                  some: {
                    isActive: true,
                    AND: [
                      {
                        OR: [
                          { name: { contains: 'Haircut', mode: 'insensitive' } },
                          { category: { contains: 'Haircut', mode: 'insensitive' } },
                        ],
                      },
                      { price: { lte: 300 } },
                    ],
                  },
                },
              },
            ]),
          );
          // `q`'s name/description branches have no specific service to check price against, so
          // the broad AND still applies alongside it — unlike the `service` param case above.
          expect(where.AND).toEqual([
            { services: { some: { isActive: true, price: { lte: 300 } } } },
          ]);
        });
      });

      // Genuinely behavioral proof (not just where-clause shape) against the mission's own worked
      // examples — mockImplementation replicates exactly what Prisma would do with the constructed
      // where clause against real salon/service rows, the same technique this file's own near-me
      // bounding-box tests already use for the analogous "don't just trust the query, prove the
      // filter" concern.
      describe('same-service price filtering — behavioral proof', () => {
        interface FakeService {
          name: string;
          category?: string;
          price: number;
          isActive: boolean;
        }
        interface FakeSalon {
          id: string;
          services: FakeService[];
        }

        function evalServiceCond(cond: Record<string, unknown>, s: FakeService): boolean {
          if (cond.OR) {
            return (cond.OR as Record<string, unknown>[]).some((c) => evalServiceCond(c, s));
          }
          if (cond.name) {
            const term = String((cond.name as { contains: string }).contains).toLowerCase();
            return s.name.toLowerCase().includes(term);
          }
          if (cond.category) {
            const term = String((cond.category as { contains: string }).contains).toLowerCase();
            return (s.category ?? '').toLowerCase().includes(term);
          }
          if (cond.price) {
            const { gte, lte } = cond.price as { gte?: number; lte?: number };
            if (gte !== undefined && s.price < gte) return false;
            if (lte !== undefined && s.price > lte) return false;
            return true;
          }
          return true;
        }

        function evalServicesSome(someClause: Record<string, unknown>, services: FakeService[]): boolean {
          return services.some((s) => {
            if (someClause.isActive !== undefined && s.isActive !== someClause.isActive) return false;
            const conditions = (someClause.AND as Record<string, unknown>[] | undefined) ?? [someClause];
            return conditions.every((c) => evalServiceCond(c, s));
          });
        }

        function salonMatchesWhere(where: Record<string, unknown>, salon: FakeSalon): boolean {
          return Object.entries(where).every(([key, value]) => {
            if (key === 'services') {
              return evalServicesSome(
                (value as { some: Record<string, unknown> }).some,
                salon.services,
              );
            }
            if (key === 'AND') {
              const clauses = Array.isArray(value) ? value : [value];
              return (clauses as Record<string, unknown>[]).every((c) => salonMatchesWhere(c, salon));
            }
            if (key === 'OR') {
              return (value as Record<string, unknown>[]).some((c) => {
                if (c.services) {
                  return evalServicesSome(
                    (c.services as { some: Record<string, unknown> }).some,
                    salon.services,
                  );
                }
                return false; // name/description branches: these fixtures never match by name
              });
            }
            return true; // status, city, etc. — not modeled by these fixtures
          });
        }

        async function searchAgainst(salon: FakeSalon, query: Parameters<typeof service.search>[0]) {
          prisma.salon.findMany.mockImplementation((args: SalonFindManyArgs) =>
            Promise.resolve(
              salonMatchesWhere(args.where as unknown as Record<string, unknown>, salon)
                ? [makeSalon({ id: salon.id })]
                : [],
            ),
          );
          return service.search(query);
        }

        it('Salon A (Haircut ₹250, Shave ₹500) — query Haircut + max ₹300 → INCLUDED', async () => {
          const salonA: FakeSalon = {
            id: 'salon-a',
            services: [
              { name: 'Haircut', price: 250, isActive: true },
              { name: 'Shave', price: 500, isActive: true },
            ],
          };
          const result = await searchAgainst(salonA, { service: 'Haircut', priceMax: 300 });
          expect(result.items.map((i) => i.id)).toEqual(['salon-a']);
        });

        it('Salon B (Haircut ₹800, Shave ₹200) — query Haircut + max ₹300 → EXCLUDED', async () => {
          const salonB: FakeSalon = {
            id: 'salon-b',
            services: [
              { name: 'Haircut', price: 800, isActive: true },
              { name: 'Shave', price: 200, isActive: true },
            ],
          };
          const result = await searchAgainst(salonB, { service: 'Haircut', priceMax: 300 });
          expect(result.items).toHaveLength(0);
        });

        it('Salon C (Haircut ₹400) — query Haircut + ₹300–₹600 → INCLUDED', async () => {
          const salonC: FakeSalon = {
            id: 'salon-c',
            services: [{ name: 'Haircut', price: 400, isActive: true }],
          };
          const result = await searchAgainst(salonC, {
            service: 'Haircut',
            priceMin: 300,
            priceMax: 600,
          });
          expect(result.items.map((i) => i.id)).toEqual(['salon-c']);
        });

        it('Salon D (inactive Haircut ₹200, active Haircut ₹700) — query Haircut + max ₹300 → EXCLUDED', async () => {
          const salonD: FakeSalon = {
            id: 'salon-d',
            services: [
              { name: 'Haircut', price: 200, isActive: false },
              { name: 'Haircut', price: 700, isActive: true },
            ],
          };
          const result = await searchAgainst(salonD, { service: 'Haircut', priceMax: 300 });
          expect(result.items).toHaveLength(0);
        });

        it('no service query + max ₹300 — a salon with any qualifying ACTIVE service is included under the documented broad semantics', async () => {
          // Same salon shape as Salon B (an unrelated affordable Shave alongside a pricey
          // Haircut), but with NO service/text query at all — the broad "any active service in
          // range" rule from the price-filter-alone case explicitly still applies here.
          const salon: FakeSalon = {
            id: 'salon-broad',
            services: [
              { name: 'Haircut', price: 800, isActive: true },
              { name: 'Shave', price: 200, isActive: true },
            ],
          };
          const result = await searchAgainst(salon, { priceMax: 300 });
          expect(result.items.map((i) => i.id)).toEqual(['salon-broad']);
        });
      });
    });

    it('returns no nextCursor when results fit within the limit', async () => {
      prisma.salon.findMany.mockResolvedValue([makeSalon()]);
      const result = await service.search({ limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it('returns a nextCursor and trims to `limit` items when there are more results than the page size', async () => {
      const salons = [
        makeSalon({ id: 's1' }),
        makeSalon({ id: 's2' }),
        makeSalon({ id: 's3' }),
      ];
      prisma.salon.findMany.mockResolvedValue(salons); // limit+1 = 3 for limit=2
      const result = await service.search({ limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBe('s2');
    });

    it('maps Decimal price aggregates to plain numbers', async () => {
      prisma.salon.findMany.mockResolvedValue([makeSalon()]);
      prisma.service.groupBy.mockResolvedValue([
        {
          salonId: 's1',
          _min: { price: { toString: () => '300' } },
          _max: { price: { toString: () => '600' } },
        },
      ]);
      const result = await service.search({});
      expect(result.items[0].priceMin).toBe(300);
      expect(result.items[0].priceMax).toBe(600);
    });

    it('leaves distanceKm null when no lat/lng is supplied', async () => {
      prisma.salon.findMany.mockResolvedValue([makeSalon()]);
      const result = await service.search({});
      expect(result.items[0].distanceKm).toBeNull();
    });

    // Issue #13 Mission F: a real live signal on the search card, never a fabricated one.
    it('includes the real live waitingCount, scoped to WAITING/CALLED/IN_SERVICE for that salon', async () => {
      prisma.salon.findMany.mockResolvedValue([makeSalon()]);
      prisma.queueEntry.groupBy.mockResolvedValue([{ salonId: 's1', _count: { _all: 3 } }]);
      const result = await service.search({});
      expect(result.items[0].waitingCount).toBe(3);
      expect(prisma.queueEntry.groupBy).toHaveBeenCalledWith({
        by: ['salonId'],
        where: {
          salonId: { in: ['s1'] },
          status: { in: ['WAITING', 'CALLED', 'IN_SERVICE'] },
        },
        _count: { _all: true },
      });
    });

    describe('"near me" (lat/lng supplied)', () => {
      it('sorts results by ascending distance and always returns a null nextCursor', async () => {
        const near = makeSalon({ id: 'near', lat: 12.9716, lng: 77.6412 }); // ~0km from query point
        const far = makeSalon({ id: 'far', lat: 13.5, lng: 78.5 }); // well outside Bengaluru
        prisma.salon.findMany.mockResolvedValue([far, near]);
        const result = await service.search({ lat: 12.9716, lng: 77.6412 });
        expect(result.items.map((i) => i.id)).toEqual(['near', 'far']);
        expect(result.items[0].distanceKm).toBeCloseTo(0, 0);
        expect(result.nextCursor).toBeNull();
      });

      it('excludes salons with no coordinates rather than crashing or showing a fake 0', async () => {
        const noCoords = makeSalon({ id: 'no-coords', lat: null, lng: null });
        prisma.salon.findMany.mockResolvedValue([noCoords]);
        const result = await service.search({ lat: 12.9716, lng: 77.6412 });
        expect(result.items).toHaveLength(0);
      });

      it('does not send a cursor/orderBy to Prisma in near-me mode (in-memory sort instead)', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({
          lat: 12.9716,
          lng: 77.6412,
          cursor: 'ignored-in-near-me-mode',
        });
        const call = prisma.salon.findMany.mock
          .calls[0][0] as unknown as Record<string, unknown>;
        expect(call.cursor).toBeUndefined();
      });

      // A salon with no usable coordinates can never get a distance and is always dropped by the
      // distanceKm-not-null filter — so fetching it into the bounded NEAR_ME_CANDIDATE_CAP
      // candidate set only ever wastes a slot. At real scale (200+ coordinate-less salons in a
      // city, say) an unfiltered query could fill the entire capped set with rows that were
      // always going to be discarded, silently returning zero results even when real
      // coordinate-bearing salons exist and match every other filter.
      it('filters coordinate-less salons out of the candidate query itself, not just the final result', async () => {
        prisma.salon.findMany.mockResolvedValue([]);
        await service.search({ lat: 12.9716, lng: 77.6412 });
        const call = prisma.salon.findMany.mock.calls[0][0] as unknown as {
          where: {
            lat: { not: null; gte: number; lte: number };
            lng: { not: null; gte: number; lte: number };
          };
          take: number;
        };
        expect(call.where.lat.not).toBeNull();
        expect(call.where.lng.not).toBeNull();
        // The full candidate cap is spent entirely on rows that can actually appear in the
        // distance-sorted result — this is what actually prevents the crowding-out bug once the
        // coordinate filter above is applied at the database level.
        expect(call.take).toBe(200);
      });

      it('still considers every coordinate-bearing salon even when many others in the same query have none', async () => {
        // The mock can't simulate a real WHERE filter (bounding box or coordinate-not-null), so
        // this proves the *other* half of the fix: every candidate the DB actually returns is
        // still correctly distance-sorted and included, none silently dropped just for being one
        // of many. Real bounding-box exclusion of a truly distant salon is covered separately below.
        const far = makeSalon({ id: 'far', lat: 20.0, lng: 80.0 });
        const near = makeSalon({ id: 'near', lat: 12.9716, lng: 77.6412 });
        const mid = makeSalon({ id: 'mid', lat: 13.2, lng: 77.8 });
        prisma.salon.findMany.mockResolvedValue([far, near, mid]);
        const result = await service.search({ lat: 12.9716, lng: 77.6412 });
        expect(result.items.map((i) => i.id)).toEqual(['near', 'mid', 'far']);
      });

      it('sizes the initial bounding box from the query point, not a fixed offset', async () => {
        prisma.salon.findMany.mockResolvedValue([
          makeSalon(),
          makeSalon(),
          makeSalon(),
        ]);
        // Two query points far enough apart (different cities) that a fixed-size box bug (e.g.
        // reusing one city's box for another) would produce identical bounds either way — this
        // instead asserts the bounds are actually a function of each query's own lat/lng.
        await service.search({ lat: 12.9716, lng: 77.6412 }); // Bengaluru
        const bengaluruBox = prisma.salon.findMany.mock
          .calls[0][0] as unknown as {
          where: {
            lat: { gte: number; lte: number };
            lng: { gte: number; lte: number };
          };
        };
        prisma.salon.findMany.mockClear();
        await service.search({ lat: 28.6139, lng: 77.209 }); // Delhi
        const delhiBox = prisma.salon.findMany.mock.calls[0][0] as unknown as {
          where: {
            lat: { gte: number; lte: number };
            lng: { gte: number; lte: number };
          };
        };
        expect(bengaluruBox.where.lat.gte).not.toBeCloseTo(
          delhiBox.where.lat.gte,
          1,
        );
        // Bengaluru (~13°N) and Delhi (~28°N) sit at different latitudes, so a correct box (which
        // narrows longitude by cos(latitude)) gives them different-width longitude spans — a bug
        // that used a fixed km-per-degree-longitude regardless of latitude would make these equal.
        const bengaluruLngSpan =
          bengaluruBox.where.lng.lte - bengaluruBox.where.lng.gte;
        const delhiLngSpan = delhiBox.where.lng.lte - delhiBox.where.lng.gte;
        expect(bengaluruLngSpan).not.toBeCloseTo(delhiLngSpan, 3);
      });

      it('cannot let a salon outside the bounding box crowd out one inside it, even with 200+ distant coordinate-bearing rows', async () => {
        // Simulates the real WHERE clause: only rows whose lat/lng actually fall inside the box
        // this specific call requested are returned — exactly what Postgres would do, unlike the
        // other tests here (which use a single fixed mock and so can't exercise this distinction).
        const from = { lat: 12.9716, lng: 77.6412 }; // Bengaluru
        const near = makeSalon({ id: 'near', lat: 12.98, lng: 77.65 }); // ~1.5km away
        // 200 salons scattered around a totally different part of the world (Delhi), each with
        // real, valid coordinates — under the pre-fix "coordinate-bearing only" filter these could
        // fill the entire NEAR_ME_CANDIDATE_CAP before the query ever reached `near`.
        const farAway = Array.from({ length: 200 }, (_, i) =>
          makeSalon({ id: `far-${i}`, lat: 28.6139 + i * 0.001, lng: 77.209 }),
        );
        prisma.salon.findMany.mockImplementation((args: SalonFindManyArgs) => {
          const latFilter = (
            args.where as unknown as { lat?: { gte: number; lte: number } }
          ).lat;
          const lngFilter = (
            args.where as unknown as { lng?: { gte: number; lte: number } }
          ).lng;
          const inBox = (s: ReturnType<typeof makeSalon>) =>
            !!latFilter &&
            !!lngFilter &&
            s.lat >= latFilter.gte &&
            s.lat <= latFilter.lte &&
            s.lng >= lngFilter.gte &&
            s.lng <= lngFilter.lte;
          return Promise.resolve([...farAway, near].filter(inBox));
        });
        const result = await service.search({ lat: from.lat, lng: from.lng });
        expect(result.items.map((i) => i.id)).toContain('near');
      });

      it('excludes a salon with only one of lat/lng set (malformed/partial coordinates), not just fully-null', async () => {
        const partial = makeSalon({ id: 'partial', lat: 12.9716, lng: null });
        prisma.salon.findMany.mockResolvedValue([partial]);
        const result = await service.search({ lat: 12.9716, lng: 77.6412 });
        expect(result.items).toHaveLength(0);
      });

      it('does not enter near-me mode at all when only one of lat/lng is supplied in the query', async () => {
        prisma.salon.findMany.mockResolvedValue([makeSalon()]);
        await service.search({ lat: 12.9716 });
        const call = prisma.salon.findMany.mock.calls[0][0] as unknown as {
          where: Record<string, unknown>;
        };
        // Falls through to the ordinary cursor-paginated path — no coordinate filter applied.
        expect(call.where.lat).toBeUndefined();
      });

      it('breaks an exact distance tie deterministically by id, not by incidental row order', async () => {
        // Both salons are equidistant from the query point (same lat/lng as each other).
        const b = makeSalon({ id: 'b-salon', lat: 13.0, lng: 78.0 });
        const a = makeSalon({ id: 'a-salon', lat: 13.0, lng: 78.0 });
        // mockResolvedValue (not Once): fewer than `limit` candidates triggers the box-widening
        // retry loop, which would call findMany again — a single queued Once-value would leave
        // that retry with nothing mocked and throw on `.length` of undefined.
        prisma.salon.findMany.mockResolvedValue([b, a]);
        const first = await service.search({ lat: 12.9716, lng: 77.6412 });
        prisma.salon.findMany.mockResolvedValue([a, b]);
        const second = await service.search({ lat: 12.9716, lng: 77.6412 });
        // Same tie-break result regardless of which order Prisma happened to return the rows in.
        expect(first.items.map((i) => i.id)).toEqual(['a-salon', 'b-salon']);
        expect(second.items.map((i) => i.id)).toEqual(['a-salon', 'b-salon']);
      });

      // Part 8/9 — distance filter (radiusKm).
      describe('radiusKm', () => {
        it('excludes a salon farther than the requested radius, even though it is inside the coordinate bounding box', async () => {
          // The mock can't simulate a real box exclusion (see the "cannot let a salon outside the
          // bounding box crowd out..." test above), so this proves the *other* half of radiusKm:
          // the hard Haversine cutoff applied after candidates come back, which is what actually
          // enforces "farther than the box's rectangle corners" cases too.
          const near = makeSalon({ id: 'near', lat: 12.98, lng: 77.65 }); // ~1.5km from query point
          const justOutside = makeSalon({ id: 'far', lat: 13.1, lng: 77.8 }); // tens of km away
          prisma.salon.findMany.mockResolvedValue([near, justOutside]);
          const result = await service.search({ lat: 12.9716, lng: 77.6412, radiusKm: 5 });
          expect(result.items.map((i) => i.id)).toEqual(['near']);
        });

        it('tries exactly one bounding box sized to radiusKm, never widening past what the caller asked for', async () => {
          // Fewer than `limit` candidates would normally trigger NEAR_ME_RADII_KM's widening
          // retry loop — an explicit radiusKm must not widen past the caller's own hard cap.
          prisma.salon.findMany.mockResolvedValue([]);
          await service.search({ lat: 12.9716, lng: 77.6412, radiusKm: 5, limit: 20 });
          expect(prisma.salon.findMany).toHaveBeenCalledTimes(1);
        });

        it('is ignored when lat/lng are not both supplied (no query point to measure a radius from)', async () => {
          prisma.salon.findMany.mockResolvedValue([makeSalon()]);
          const result = await service.search({ radiusKm: 5 });
          // Falls through to the ordinary cursor-paginated path — distanceKm stays null, nothing
          // is dropped for being "too far" when there is no distance to compare against.
          expect(result.items[0].distanceKm).toBeNull();
        });

        it('does not affect the default (no-radius) near-me path at all', async () => {
          const far = makeSalon({ id: 'far', lat: 13.5, lng: 78.5 });
          prisma.salon.findMany.mockResolvedValue([far]);
          const result = await service.search({ lat: 12.9716, lng: 77.6412 });
          expect(result.items.map((i) => i.id)).toEqual(['far']);
        });

        // Deterministic cutoffs at exact distances from a known query point (Part 8/9 review).
        // Coordinates are precise: each fixture's lat offset was derived from the real, imported
        // haversineDistanceKm — the same function search() itself uses for the final cutoff — so
        // "750m away" genuinely measures as 0.750km, not an approximation that happens to round
        // there. The final Haversine check (not bounding-box inclusion) is what's authoritative
        // here: the mock returns the fixture unconditionally, so a passing test proves the
        // post-fetch distance filter itself made the right call, not the DB prefilter.
        describe('deterministic cutoffs at exact known distances', () => {
          const QUERY_LAT = 12.9716;
          const QUERY_LNG = 77.6412;
          // Latitude for a point due north of the query point at exactly this many km away,
          // verified against haversineDistanceKm to 6 decimal places.
          const latAt = {
            '0.05': 12.97204966,
            '0.15': 12.97294898,
            '0.4': 12.97519729,
            '0.75': 12.97834491,
            '2.5': 12.99408304,
            '4.5': 13.01206947,
            '6': 13.0255593,
          };

          async function searchAtDistance(distanceKey: keyof typeof latAt, radiusKm: number) {
            const salon = makeSalon({ id: `at-${distanceKey}km`, lat: latAt[distanceKey], lng: QUERY_LNG });
            prisma.salon.findMany.mockResolvedValue([salon]);
            return service.search({ lat: QUERY_LAT, lng: QUERY_LNG, radiusKm });
          }

          it('a salon 50m away is included for a 100m radius', async () => {
            const result = await searchAtDistance('0.05', 0.1);
            expect(result.items).toHaveLength(1);
          });

          it('a salon 150m away is excluded for a 100m radius but included for a 200m radius', async () => {
            expect((await searchAtDistance('0.15', 0.1)).items).toHaveLength(0);
            expect((await searchAtDistance('0.15', 0.2)).items).toHaveLength(1);
          });

          it('a salon 400m away is included for a 500m radius', async () => {
            const result = await searchAtDistance('0.4', 0.5);
            expect(result.items).toHaveLength(1);
          });

          it('a salon 750m away is excluded for a 500m radius but included for a 1km radius', async () => {
            expect((await searchAtDistance('0.75', 0.5)).items).toHaveLength(0);
            expect((await searchAtDistance('0.75', 1)).items).toHaveLength(1);
          });

          it('a salon 2.5km away is excluded for a 2km radius but included for a 3km radius', async () => {
            expect((await searchAtDistance('2.5', 2)).items).toHaveLength(0);
            expect((await searchAtDistance('2.5', 3)).items).toHaveLength(1);
          });

          it('a salon 4.5km away is included for a 5km radius', async () => {
            const result = await searchAtDistance('4.5', 5);
            expect(result.items).toHaveLength(1);
          });

          it('a salon 6km away (>5km) is excluded for a 5km radius', async () => {
            const result = await searchAtDistance('6', 5);
            expect(result.items).toHaveLength(0);
          });
        });
      });
    });
  });

  describe('getPublicStatus', () => {
    it('returns active chair and aggregate queue counts without customer data', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'city-1',
      });
      prisma.salon.findFirst.mockResolvedValue({
        chairs: [{ id: 'chair-1' }, { id: 'chair-2' }],
        staff: [
          { displayName: 'Ravi', _count: { queueEntriesAssigned: 2 } },
          { displayName: 'Aman', _count: { queueEntriesAssigned: 0 } },
        ],
      });

      await expect(
        service.getPublicStatus('IN', 'bengaluru', 'demo'),
      ).resolves.toEqual({
        activeChairCount: 2,
        professionals: [
          { displayName: 'Ravi', activeQueueCount: 2 },
          { displayName: 'Aman', activeQueueCount: 0 },
        ],
      });
      const query = prisma.salon.findFirst.mock.calls[0][0];
      expect(query.where).toEqual({
        slug: 'demo',
        cityId: 'city-1',
        status: 'ACTIVE',
        isClosedForToday: false,
      });
      expect(query.select.staff.select).not.toHaveProperty('user');
      expect(query.select.staff.select).not.toHaveProperty(
        'queueEntriesAssigned',
      );
      expect(
        query.select.staff.select._count.select.queueEntriesAssigned.where
          .status.in,
      ).toEqual(['WAITING', 'CALLED', 'IN_SERVICE']);
    });

    it('does not expose non-active chairs or staff', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'city-1',
      });
      prisma.salon.findFirst.mockResolvedValue({ chairs: [], staff: [] });

      await expect(
        service.getPublicStatus('IN', 'bengaluru', 'demo'),
      ).resolves.toEqual({
        activeChairCount: 0,
        professionals: [],
      });
      const query = prisma.salon.findFirst.mock.calls[0][0];
      expect(query.select.chairs.where).toEqual({ status: 'ACTIVE' });
      expect(query.select.staff.where).toEqual({ status: 'ACTIVE' });
    });

    it('returns not found for a non-active or unknown salon', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'city-1',
      });
      prisma.salon.findFirst.mockResolvedValue(null);

      await expect(
        service.getPublicStatus('IN', 'bengaluru', 'missing'),
      ).rejects.toMatchObject({
        code: 'SALON_NOT_FOUND',
      });
    });
  });

  describe('getProfile', () => {
    it('throws SALON_NOT_FOUND when no ACTIVE salon matches the slug in that city', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });
      prisma.salon.findFirst.mockResolvedValue(null);
      await expect(
        service.getProfile('IN', 'bengaluru', 'nonexistent'),
      ).rejects.toMatchObject({ code: 'SALON_NOT_FOUND' });
    });

    it('maps the full profile shape including services, hours, photos, and reviews', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });
      prisma.salon.findFirst.mockResolvedValue(
        makeSalon({
          description: 'A demo salon',
          phone: '+918041234567',
          services: [
            {
              id: 'sv1',
              salonId: 's1',
              name: 'Haircut',
              durationMinutes: 30,
              price: { toString: () => '300' },
              category: 'Hair',
              subcategory: 'Haircut',
              categoryId: 'category-hair',
              subcategoryId: 'subcategory-haircut',
              isActive: true,
            },
          ],
          operatingHours: [
            {
              dayOfWeek: 1,
              openTime: '09:00',
              closeTime: '20:00',
              isClosed: false,
            },
          ],
          photos: [
            {
              id: 'p1',
              url: 'https://example.com/a.jpg',
              altText: null,
              type: 'COVER',
            },
          ],
          reviews: [
            {
              id: 'r1',
              rating: 5,
              comment: 'Great!',
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        }),
      );
      prisma.review.aggregate.mockResolvedValue({
        _avg: { rating: 5 },
        _count: { rating: 1 },
      });

      const profile = await service.getProfile(
        'IN',
        'bengaluru',
        'barbercue-demo',
      );

      expect(profile.services).toEqual([
        {
          id: 'sv1',
          salonId: 's1',
          name: 'Haircut',
          durationMinutes: 30,
          price: 300,
          category: 'Hair',
          subcategory: 'Haircut',
          categoryId: 'category-hair',
          subcategoryId: 'subcategory-haircut',
          isActive: true,
        },
      ]);
      expect(profile.operatingHours).toEqual([
        {
          dayOfWeek: 1,
          openTime: '09:00',
          closeTime: '20:00',
          isClosed: false,
        },
      ]);
      expect(profile.photos[0].url).toBe('https://example.com/a.jpg');
      expect(profile.reviews[0]).toMatchObject({
        rating: 5,
        comment: 'Great!',
      });
      expect(profile.ratingAverage).toBe(5);
      expect(profile.ratingCount).toBe(1);
    });

    it('defaults a null service category to an empty string (schema allows null, DTO does not)', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });
      prisma.salon.findFirst.mockResolvedValue(
        makeSalon({
          services: [
            {
              id: 'sv1',
              salonId: 's1',
              name: 'Haircut',
              durationMinutes: 30,
              price: { toString: () => '300' },
              category: null,
              subcategory: null,
              isActive: true,
            },
          ],
          operatingHours: [],
          reviews: [],
        }),
      );
      const profile = await service.getProfile(
        'IN',
        'bengaluru',
        'barbercue-demo',
      );
      expect(profile.services[0].category).toBe('');
      expect(profile.services[0].subcategory).toBeNull();
    });

    it('maps ACTIVE staff to the public team list (Phase 17)', async () => {
      citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });
      prisma.salon.findFirst.mockResolvedValue(
        makeSalon({
          services: [],
          operatingHours: [],
          reviews: [],
          staff: [
            {
              id: 'st1',
              displayName: 'Marcus',
              roleInSalon: 'BARBER',
              photoUrl: 'https://example.com/marcus.jpg',
              bio: 'Fades and tapers specialist.',
              yearsExperience: 8,
              verification: { status: 'APPROVED' },
            },
          ],
        }),
      );
      const profile = await service.getProfile(
        'IN',
        'bengaluru',
        'barbercue-demo',
      );
      expect(profile.team).toEqual([
        {
          id: 'st1',
          verified: true,
          displayName: 'Marcus',
          roleInSalon: 'BARBER',
          photoUrl: 'https://example.com/marcus.jpg',
          bio: 'Fades and tapers specialist.',
          yearsExperience: 8,
        },
      ]);
    });

    // isOpenNow used to be computed against a fixed +05:30 IST offset for every salon regardless
    // of where it actually is — these prove it now resolves each salon's OWN timezone instead.
    describe('isOpenNow (global timezone correctness)', () => {
      const mondayHours = [
        {
          dayOfWeek: 1,
          isClosed: false,
          openTime: '09:00',
          closeTime: '18:00',
        },
      ];

      afterEach(() => {
        jest.useRealTimers();
      });

      async function loadProfile() {
        citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
          id: 'c1',
          slug: 'bengaluru',
          countryCode: 'IN',
        });
        return service.getProfile('IN', 'bengaluru', 'barbercue-demo');
      }

      it('is open for an India salon with no explicit timezone (country fallback to Asia/Kolkata)', async () => {
        // Monday 2026-06-01, 11:00 IST = 05:30 UTC.
        jest.useFakeTimers({ now: new Date('2026-06-01T05:30:00.000Z') });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({ operatingHours: mondayHours, services: [], reviews: [] }),
        );
        const profile = await loadProfile();
        expect(profile.isOpenNow).toBe(true);
      });

      it("is open using London's real +01:00 BST offset, at an instant the old fixed +05:30 IST assumption would have wrongly called closed", async () => {
        // 2026-06-01T16:30:00Z: correct London local time is 17:30 (BST, +01:00) — inside
        // 09:00-18:00, so open. The old fixed +05:30 offset would have computed "23:30" for this
        // same UTC instant — outside 09:00-18:00 — and wrongly reported closed.
        jest.useFakeTimers({ now: new Date('2026-06-01T16:30:00.000Z') });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'london', countryCode: 'GB' },
            timezone: 'Europe/London',
            operatingHours: mondayHours,
            services: [],
            reviews: [],
          }),
        );
        const profile = await loadProfile();
        expect(profile.isOpenNow).toBe(true);
      });

      it("is closed using London's real offset, at an instant the old fixed +05:30 IST assumption would have wrongly called open", async () => {
        // 2026-06-01T06:00:00Z: correct London local time is 07:00 (BST) — before this salon's
        // 09:00 open, so closed. The old fixed +05:30 offset would have computed "11:30" for this
        // same UTC instant — inside 09:00-18:00 — and wrongly reported open.
        jest.useFakeTimers({ now: new Date('2026-06-01T06:00:00.000Z') });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'london', countryCode: 'GB' },
            timezone: 'Europe/London',
            operatingHours: mondayHours,
            services: [],
            reviews: [],
          }),
        );
        const profile = await loadProfile();
        expect(profile.isOpenNow).toBe(false);
      });

      it('is null — never falsely Open or Closed — for a non-India salon with no explicit timezone', async () => {
        jest.useFakeTimers({ now: new Date('2026-06-01T05:30:00.000Z') });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'newyork', countryCode: 'US' },
            timezone: null,
            operatingHours: mondayHours,
            services: [],
            reviews: [],
          }),
        );
        const profile = await loadProfile();
        expect(profile.isOpenNow).toBeNull();
      });

      it('is null for an invalid stored IANA timezone string, not a crash', async () => {
        jest.useFakeTimers({ now: new Date('2026-06-01T05:30:00.000Z') });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'newyork', countryCode: 'US' },
            timezone: 'Not/AZone',
            operatingHours: mondayHours,
            services: [],
            reviews: [],
          }),
        );
        const profile = await loadProfile();
        expect(profile.isOpenNow).toBeNull();
      });
    });

    // Pre-confirmation timezone fix — SalonProfileDto now exposes the same resolved IANA zone
    // BookingDetailDto.salonTimezone already does, so the booking flow can render dates/slots in
    // the salon's own local time before a booking even exists.
    describe('salonTimezone', () => {
      it("exposes the salon's own explicit IANA zone", async () => {
        citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
          id: 'c1',
          slug: 'dallas',
          countryCode: 'US',
        });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'dallas', countryCode: 'US' },
            timezone: 'America/Chicago',
            services: [],
            operatingHours: [],
            reviews: [],
          }),
        );
        const profile = await service.getProfile('US', 'dallas', 'barbercue-demo');
        expect(profile.salonTimezone).toBe('America/Chicago');
      });

      it('falls back to Asia/Kolkata for an India salon with no explicit timezone stored', async () => {
        citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
          id: 'c1',
          slug: 'bengaluru',
          countryCode: 'IN',
        });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({ services: [], operatingHours: [], reviews: [] }),
        );
        const profile = await service.getProfile('IN', 'bengaluru', 'barbercue-demo');
        expect(profile.salonTimezone).toBe('Asia/Kolkata');
      });

      it('is null — never guessed — for a non-India salon with no explicit or resolvable timezone', async () => {
        citiesService.findCityByCountryAndSlugOrThrow.mockResolvedValue({
          id: 'c1',
          slug: 'newyork',
          countryCode: 'US',
        });
        prisma.salon.findFirst.mockResolvedValue(
          makeSalon({
            city: { slug: 'newyork', countryCode: 'US' },
            timezone: null,
            services: [],
            operatingHours: [],
            reviews: [],
          }),
        );
        const profile = await service.getProfile('US', 'newyork', 'barbercue-demo');
        expect(profile.salonTimezone).toBeNull();
      });
    });
  });

  describe('registerSalon', () => {
    const input = {
      name: 'Fresh Cuts & Co.',
      addressLine: '12 MG Road',
      countryCode: 'IN',
      postalCode: '560001',
      lat: 12.97,
      lng: 77.59,
      citySlug: 'bengaluru',
    };

    beforeEach(() => {
      citiesService.findCityBySlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });
    });

    it('creates the salon with a slugified name and grants the caller SALON_OWNER for it', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      const result = await service.registerSalon('owner-1', input);

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerUserId: 'owner-1',
          slug: 'fresh-cuts-co',
          cityId: 'c1',
          localityId: null,
          status: 'PENDING',
          shopPhotoRequirementGrandfathered: false,
        }),
      });
      expect(prisma.userRole.upsert).toHaveBeenCalledWith({
        where: {
          userId_role_salonId: {
            userId: 'owner-1',
            role: 'SALON_OWNER',
            salonId: 's1',
          },
        },
        update: {},
        create: { userId: 'owner-1', role: 'SALON_OWNER', salonId: 's1' },
      });
      expect(result.salon).toEqual({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });
      expect(prisma.operatingHours.createMany).toHaveBeenCalledWith({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          salonId: 's1',
          dayOfWeek,
          openTime: '09:00',
          closeTime: '21:00',
          isClosed: false,
        })),
      });
      expect(prisma.chair.createMany).toHaveBeenCalledWith({
        data: Array.from({ length: 10 }, (_, index) => ({
          salonId: 's1',
          label: `Chair ${index + 1}`,
          status: 'ACTIVE',
        })),
      });
    });

    it('stores owner-entered locality text and landmark even when the locality is not in master data', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      await service.registerSalon('owner-1', {
        ...input,
        localityText: 'Boring Road',
        landmark: 'Near Hanuman Mandir',
      });

      expect(prisma.locality.findUnique).not.toHaveBeenCalled();
      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          localityId: null,
          localityText: 'Boring Road',
          landmark: 'Near Hanuman Mandir',
        }),
      });
    });

    // Auth-security-branch fix: a CUSTOMER-audience session must never be left unable to reach
    // the very shop it just registered. See registerSalon's own doc comment.
    describe('the minted STAFF-audience session', () => {
      beforeEach(() => {
        prisma.salon.create.mockResolvedValue({
          id: 's1',
          publicId: 'BC-SHOP-000001',
          slug: 'fresh-cuts-co',
          name: 'Fresh Cuts & Co.',
          status: 'PENDING',
        });
      });

      it('re-reads the caller\'s roles AFTER the SALON_OWNER grant, not the pre-registration set', async () => {
        await service.registerSalon('owner-1', input);
        expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { id: 'owner-1' },
          include: { roles: true },
        });
      });

      it('mints a fresh token pair via TokenService, scoped to STAFF audience, including the just-granted SALON_OWNER role', async () => {
        await service.registerSalon('owner-1', input, 'test-device');
        expect(tokenService.scopeRolesToAudience).toHaveBeenCalledWith(
          ['SALON_OWNER'],
          'STAFF',
        );
        expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
          'owner-1',
          ['SALON_OWNER'],
          'STAFF',
          'test-device',
        );
      });

      it('returns a MeResponse-shaped user with STAFF audience and the tokens from TokenService — never the old session\'s shape', async () => {
        const result = await service.registerSalon('owner-1', input);
        expect(result.user).toEqual({
          id: 'owner-1',
          roles: ['SALON_OWNER'],
          audience: 'STAFF',
          phone: null,
          email: null,
          preferredLanguage: 'EN',
          passwordConfigured: false,
        });
        expect(result.tokens).toEqual({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresIn: 900,
        });
      });

      it('never leaks a PLATFORM_ADMIN role into the minted STAFF session even if the User row also holds it', async () => {
        // Real filtering behavior, not the simplified per-test mock — proves this call site
        // actually benefits from TokenService's own audience-scoping rule, not just that this
        // spec's mock happens to agree with it.
        const realTokenService = {
          scopeRolesToAudience: (roles: string[], audience: string) => {
            const allowed: Record<string, string[]> = {
              CUSTOMER: ['CUSTOMER'],
              STAFF: ['SALON_STAFF', 'SALON_OWNER'],
              ADMIN: ['PLATFORM_ADMIN'],
            };
            return roles.filter((r) => allowed[audience]?.includes(r));
          },
          issueTokenPair: tokenService.issueTokenPair,
        };
        const moduleRef = await Test.createTestingModule({
          providers: [
            SalonsService,
            { provide: PrismaService, useValue: prisma },
            { provide: CitiesService, useValue: citiesService },
            { provide: SalonAccessService, useValue: salonAccess },
            { provide: TokenService, useValue: realTokenService },
          ],
        }).compile();
        const realService = moduleRef.get(SalonsService);
        prisma.user.findUniqueOrThrow.mockResolvedValueOnce({
          id: 'owner-1',
          roles: [{ role: 'SALON_OWNER' }, { role: 'PLATFORM_ADMIN' }],
          phone: null,
          email: null,
          preferredLanguage: 'EN',
          passwordHash: null,
        });

        const result = await realService.registerSalon('owner-1', input);

        expect(result.user.roles).toEqual(['SALON_OWNER']);
        expect(result.user.roles).not.toContain('PLATFORM_ADMIN');
        expect(tokenService.issueTokenPair).toHaveBeenCalledWith(
          'owner-1',
          ['SALON_OWNER'],
          'STAFF',
          undefined,
        );
      });
    });

    it('persists the PIN code and the captured coordinates', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      await service.registerSalon('owner-1', input);

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postalCode: '560001',
          lat: 12.97,
          lng: 77.59,
        }),
      });
    });

    // An owner who denies GPS permission (or registers from a desktop) must still get a shop —
    // address + city + PIN identify it. Coordinates must land as NULL, never as 0/0, which is a
    // real location in the Gulf of Guinea and would put the shop on a map thousands of km away.
    it('registers a salon with no coordinates, storing null rather than 0/0', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });
      const { lat: _lat, lng: _lng, ...withoutCoords } = input;

      const result = await service.registerSalon('owner-1', withoutCoords);

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          postalCode: '560001',
          lat: null,
          lng: null,
        }),
      });
      expect(result.salon.id).toBe('s1');
    });

    // The client sends countryCode so postal validation can run before any DB lookup. If that
    // were trusted blindly, a caller could pair a lenient country's postal rule with a city in a
    // strict one and slip an invalid postal code past validation.
    it('rejects a countryCode that does not match the resolved city', async () => {
      citiesService.findCityBySlugOrThrow.mockResolvedValue({
        id: 'c1',
        slug: 'bengaluru',
        countryCode: 'IN',
      });

      await expect(
        service.registerSalon('owner-1', { ...input, countryCode: 'GB' }),
      ).rejects.toMatchObject({ code: 'CITY_COUNTRY_MISMATCH' });
      expect(prisma.salon.create).not.toHaveBeenCalled();
    });

    it('stores the currency derived from the city country', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      await service.registerSalon('owner-1', input);

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ currency: 'INR' }),
      });
    });

    // Part 4 (auto timezone selection): the default `input` above carries real Bengaluru
    // coordinates, so registration should confidently auto-fill the IANA zone rather than
    // leaving it null the way it always used to before coordinate-based resolution existed.
    it('auto-detects the timezone from GPS coordinates at registration and flags it as auto-detected', async () => {
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      await service.registerSalon('owner-1', input);

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          timezone: 'Asia/Kolkata',
          timezoneAutoDetected: true,
        }),
      });
    });

    it('auto-detects a non-India timezone from coordinates alone (Dallas -> America/Chicago)', async () => {
      citiesService.findCityBySlugOrThrow.mockResolvedValue({
        id: 'c2',
        slug: 'dallas',
        countryCode: 'US',
      });
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });

      await service.registerSalon('owner-1', {
        ...input,
        countryCode: 'US',
        citySlug: 'dallas',
        lat: 32.7767,
        lng: -96.797,
      });

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          timezone: 'America/Chicago',
          timezoneAutoDetected: true,
        }),
      });
    });

    // No coordinates, no known city timezone, and a genuinely multi-timezone country (USA) — none
    // of the resolution signals clear their confidence bar, so this must stay null rather than
    // guessing one of several plausible US zones.
    it('does not invent a timezone when nothing confidently resolves one', async () => {
      citiesService.findCityBySlugOrThrow.mockResolvedValue({
        id: 'c3',
        slug: 'some-us-city',
        countryCode: 'US',
      });
      prisma.salon.create.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'fresh-cuts-co',
        name: 'Fresh Cuts & Co.',
        status: 'PENDING',
      });
      const { lat: _lat, lng: _lng, ...withoutCoords } = input;

      await service.registerSalon('owner-1', {
        ...withoutCoords,
        countryCode: 'US',
        citySlug: 'some-us-city',
      });

      expect(prisma.salon.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          timezone: null,
          timezoneAutoDetected: false,
        }),
      });
    });

    it('throws LOCALITY_NOT_FOUND when localitySlug is given but does not exist in the city', async () => {
      prisma.locality.findUnique.mockResolvedValue(null);
      await expect(
        service.registerSalon('owner-1', {
          ...input,
          localitySlug: 'no-such-place',
        }),
      ).rejects.toMatchObject({ code: 'LOCALITY_NOT_FOUND' });
      expect(prisma.salon.create).not.toHaveBeenCalled();
    });

    it('retries with a suffixed slug on a slug collision and succeeds', async () => {
      prisma.salon.create
        .mockRejectedValueOnce(uniqueConstraintError())
        .mockResolvedValueOnce({
          id: 's2',
          publicId: 'BC-SHOP-000002',
          slug: 'fresh-cuts-co-2',
          name: 'Fresh Cuts & Co.',
          status: 'PENDING',
        });

      const result = await service.registerSalon('owner-1', input);

      expect(prisma.salon.create).toHaveBeenCalledTimes(2);
      expect(prisma.salon.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({ slug: 'fresh-cuts-co-2' }),
      });
      expect(result.salon.slug).toBe('fresh-cuts-co-2');
    });

    it('gives up after MAX_SLUG_ATTEMPTS collisions with a clear error', async () => {
      prisma.salon.create.mockRejectedValue(uniqueConstraintError());
      await expect(service.registerSalon('owner-1', input)).rejects.toThrow();
      expect(prisma.salon.create).toHaveBeenCalledTimes(5);
    });

    it('propagates a non-collision error immediately without retrying', async () => {
      const dbError = new Error('connection lost');
      prisma.salon.create.mockRejectedValueOnce(dbError);
      await expect(service.registerSalon('owner-1', input)).rejects.toBe(
        dbError,
      );
      expect(prisma.salon.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listOwned', () => {
    it('scopes to salons owned by the given user', async () => {
      prisma.salon.findMany.mockResolvedValue([
        {
          id: 's1',
          publicId: 'BC-SHOP-000001',
          slug: 'a',
          name: 'A',
          status: 'PENDING',
        },
      ]);
      const result = await service.listOwned('owner-1');
      expect(prisma.salon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerUserId: 'owner-1' } }),
      );
      expect(result).toEqual([
        {
          id: 's1',
          publicId: 'BC-SHOP-000001',
          slug: 'a',
          name: 'A',
          status: 'PENDING',
        },
      ]);
    });
  });

  describe('getOwnedSalon', () => {
    it('checks salon access before returning the salon', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'a',
        name: 'A',
        status: 'PENDING',
      });
      const result = await service.getOwnedSalon('user-1', 's1');
      expect(salonAccess.assertAccess).toHaveBeenCalledWith('user-1', 's1');
      expect(result.publicId).toBe('BC-SHOP-000001');
    });

    it('throws SALON_NOT_FOUND when access is granted but the salon no longer exists', async () => {
      prisma.salon.findUnique.mockResolvedValue(null);
      await expect(service.getOwnedSalon('user-1', 's1')).rejects.toMatchObject(
        {
          code: 'SALON_NOT_FOUND',
        },
      );
    });

    it('propagates the access-denied error without reaching the DB lookup, when neither the owner/staff nor the admin fallback check passes', async () => {
      const denied = new Error('denied');
      salonAccess.assertAccess.mockRejectedValueOnce(new Error('not owner/staff'));
      salonAccess.assertOwnerOrAdminAccess.mockRejectedValueOnce(denied);
      await expect(service.getOwnedSalon('user-1', 's1')).rejects.toBe(denied);
      expect(prisma.salon.findUnique).not.toHaveBeenCalled();
    });

    it('never calls the admin fallback when the plain owner/staff check already succeeds', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'a',
        name: 'A',
        status: 'PENDING',
      });
      await service.getOwnedSalon('owner-1', 's1');
      expect(salonAccess.assertOwnerOrAdminAccess).not.toHaveBeenCalled();
    });

    // Part 2 — PLATFORM_ADMIN delegated shop management: a caller who fails the normal
    // owner/staff check can still load this same data via the admin fallback.
    it('PLATFORM_ADMIN managing an ACTIVE salon can load its owned-salon data via the fallback check', async () => {
      prisma.salon.findUnique.mockResolvedValue({
        id: 's1',
        publicId: 'BC-SHOP-000001',
        slug: 'a',
        name: 'A',
        status: 'ACTIVE',
      });
      salonAccess.assertAccess.mockRejectedValueOnce(new Error('not owner/staff'));
      salonAccess.assertOwnerOrAdminAccess.mockResolvedValueOnce('PLATFORM_ADMIN');
      const result = await service.getOwnedSalon('admin-1', 's1');
      expect(salonAccess.assertOwnerOrAdminAccess).toHaveBeenCalledWith('admin-1', 's1');
      expect(result.publicId).toBe('BC-SHOP-000001');
    });
  });

  // A barber holds no ownership, so listOwned returns nothing for them — this is the only route
  // by which they can discover the salon they work at.
  describe('listWorkplaces', () => {
    const salonRow = (over: Record<string, unknown> = {}) => ({
      id: 's1',
      publicId: 'BC-SHOP-000001',
      slug: 'demo',
      name: 'Demo Salon',
      status: 'ACTIVE',
      ...over,
    });

    it('resolves membership from UserRole, the same rule assertAccess uses', async () => {
      prisma.userRole.findMany.mockResolvedValue([]);

      await service.listWorkplaces('user-1');

      expect(prisma.userRole.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          salonId: { not: null },
          role: { in: ['SALON_STAFF', 'SALON_OWNER'] },
        },
        include: { salon: true },
      });
    });

    it('lists a salon a barber only works at, marked isOwner false', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { role: 'SALON_STAFF', salon: salonRow() },
      ]);

      const result = await service.listWorkplaces('barber-1');

      expect(result).toEqual([
        {
          id: 's1',
          publicId: 'BC-SHOP-000001',
          slug: 'demo',
          name: 'Demo Salon',
          status: 'ACTIVE',
          isOwner: false,
        },
      ]);
    });

    it('marks an owned salon isOwner true', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { role: 'SALON_OWNER', salon: salonRow() },
      ]);
      const result = await service.listWorkplaces('owner-1');
      expect(result[0].isOwner).toBe(true);
    });

    // An owner who also cuts hair holds both roles for one salon.
    it('de-duplicates a salon held under both roles and keeps isOwner true', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { role: 'SALON_STAFF', salon: salonRow() },
        { role: 'SALON_OWNER', salon: salonRow() },
      ]);

      const result = await service.listWorkplaces('owner-barber');

      expect(result).toHaveLength(1);
      expect(result[0].isOwner).toBe(true);
    });

    it('returns an empty list for a user with no salon memberships', async () => {
      prisma.userRole.findMany.mockResolvedValue([]);
      await expect(service.listWorkplaces('customer-1')).resolves.toEqual([]);
    });

    it('skips a membership row whose salon relation is missing', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { role: 'SALON_STAFF', salon: null },
      ]);
      await expect(service.listWorkplaces('user-1')).resolves.toEqual([]);
    });

    it('sorts by salon name', async () => {
      prisma.userRole.findMany.mockResolvedValue([
        { role: 'SALON_STAFF', salon: salonRow({ id: 'b', name: 'Zen Cuts' }) },
        {
          role: 'SALON_STAFF',
          salon: salonRow({ id: 'a', name: 'Ace Salon' }),
        },
      ]);
      const result = await service.listWorkplaces('barber-1');
      expect(result.map((r) => r.name)).toEqual(['Ace Salon', 'Zen Cuts']);
    });
  });
});
