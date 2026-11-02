import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Role,
  SalonStatus,
  SessionAudience,
  ChairStatus,
  QueueEntryStatus,
  ServiceSessionStatus,
  currencyForCountry,
  haversineDistanceKm,
  type MeResponse,
  type PaginatedResult,
  type RegisterSalonInput,
  type RegisterSalonResultDto,
  type RegisterSalonResponseDto,
  StaffMemberStatus,
  VerificationStatus,
  type LiveStatsDto,
  type SalonListItemDto,
  type SalonProfileDto,
  type PublicSalonStatusDto,
  type ServiceSuggestionDto,
  type SalonSearchQueryInput,
  type SalonSortOption,
  type SalonWorkplaceDto,
  type TeamMemberDto,
  SALON_TYPE_FILTER_MATCHES,
  expandServiceNameSearch,
  popularServiceById,
  type PopularService,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { TokenService } from '../auth/services/token.service';
import { CitiesService } from './cities.service';
import {
  isOpenAt,
  resolveSalonTimeZone,
  zonedDayAndMinutes,
} from '../common/timezone/timezone';
import { estimateQueueWait } from './queue-wait';
import {
  bestCertainOfferFor,
  offerHeadline,
  summarizeOffers,
  type OfferRow,
  type PricedService,
} from './offer-summary';
import { resolveAutoTimezone } from '../common/timezone/timezone-resolution';

const DEFAULT_PAGE_SIZE = 20;
const RECENT_REVIEWS_LIMIT = 10;
// "Near Me" candidate pool before in-memory distance sort — see search()'s own doc comment.
const NEAR_ME_CANDIDATE_CAP = 200;
// Bounding-box prefilter radii tried in order until enough candidates are found (or the widest
// box is reached) — see boundingBoxDegrees()'s own doc comment for why a box, not PostGIS.
const NEAR_ME_RADII_KM = [25, 100, 400];
const KM_PER_DEGREE_LAT = 111;

// A cheap geographic prefilter for "Near Me", not a distance calculation: converts a radius into a
// lat/lng rectangle so the DB can discard rows that are obviously nowhere near the query point
// before the NEAR_ME_CANDIDATE_CAP applies, rather than capping an unfiltered (or merely
// coordinate-not-null) global scan. Longitude degrees shrink toward the poles (cos(lat) narrows
// them), so the box uses the query point's own latitude to size the longitude span correctly;
// latitude degrees are a constant ~111km everywhere. This is deliberately approximate (a rectangle,
// not a circle) — candidates inside it still get the exact Haversine distance and sort below, so
// the approximation only affects which rows are considered, never how they're ordered once
// considered.
function boundingBoxDegrees(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  // Guards the pole-adjacent case (cos ~ 0, so a degree of longitude is ~0km and the box would
  // otherwise blow up to +/-Infinity) — no real salon is there, but the math shouldn't NaN/Infinity
  // if it's ever asked to.
  const lngDelta = radiusKm / Math.max(kmPerDegreeLng, 1);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}
// A brand-new shop's slug never collides in practice (name + city is a very sparse space at this
// scale), but the DB-level @@unique([cityId, slug]) constraint is the real guarantee — this cap
// just bounds how many times we retry a P2002 before giving up with a clear error instead of an
// infinite loop.
const MAX_SLUG_ATTEMPTS = 5;

// Include shape shared by both the list query and the mapping helper, so the two never drift.
const listInclude = {
  city: true,
  locality: true,
  // Cover first (PhotoType declares COVER before GALLERY), then the owner's order — the card's
  // carousel/thumbnails. coverPhotoUrl still only ever uses a COVER photo.
  photos: {
    orderBy: [{ type: 'asc' as const }, { sortOrder: 'asc' as const }],
    take: 6,
  },
  operatingHours: true,
  // Phase 18 — status only; a salon with no row at all (never submitted) is simply not verified.
  verification: { select: { status: true } },
} satisfies Prisma.SalonInclude;

// Resolved per salon (Salon.timezone, falling back to Asia/Kolkata only for an India-city salon —
// see resolveSalonTimeZone's own doc comment) rather than a fixed +05:30 offset. Null — never a
// guessed Open or Closed — when no trustworthy zone exists, same honest-unknown convention as
// isOpenAt's own contract.
function isOpenNow(
  hours: {
    dayOfWeek: number;
    isClosed: boolean;
    openTime: string;
    closeTime: string;
  }[],
  salon: { timezone: string | null; city: { countryCode: string } },
): boolean | null {
  const timeZone = resolveSalonTimeZone({
    timezone: salon.timezone,
    countryCode: salon.city.countryCode,
  });
  return isOpenAt(hours, timeZone);
}

// Discovery upgrade: one popular service (catalog/salon-discovery-filters.ts) as a Service filter —
// any match term in the salon's own service name or category, and no exclusion term in its name.
function popularServiceRelevance(
  service: PopularService,
): Prisma.ServiceWhereInput {
  return {
    AND: [
      {
        OR: service.match.flatMap((term) => [
          { name: { contains: term, mode: 'insensitive' as const } },
          { category: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      ...(service.exclude ?? []).map((term) => ({
        NOT: { name: { contains: term, mode: 'insensitive' as const } },
      })),
    ],
  };
}

// Without a selected service (selectedService undefined), price sorts use the salon's starting
// price; with one, that service's price (null when the salon doesn't offer it — ranked last).
function comparedPrice(item: SalonListItemDto): number | null {
  return item.selectedService === undefined
    ? item.priceMin
    : (item.selectedService?.price ?? null);
}

/**
 * What the customer would pay after the card's offer, when that is certain: for the selected
 * service, or — with no service selected — the lowest of the starting price and a certain offer price.
 */
export function effectivePrice(item: SalonListItemDto): number | null {
  // With a service selected, the card's offers are already narrowed to that service.
  if (item.selectedService !== undefined)
    return item.selectedService
      ? (item.serviceOffers?.find(
          (o) => o.serviceId === item.selectedService!.id,
        )?.offerPrice ??
          item.offers?.[0]?.price?.offerPrice ??
          item.selectedService.price)
      : null;
  const prices = [
    item.priceMin,
    item.offers?.[0]?.price?.offerPrice ?? null,
    ...(item.serviceOffers ?? []).map((o) => o.offerPrice),
  ].filter((p): p is number => p !== null);
  return prices.length ? Math.min(...prices) : null;
}

export type RankedSort = Exclude<SalonSortOption, 'relevance' | 'distance'>;
export const RANKED_SORTS: readonly SalonSortOption[] = [
  'wait',
  'price',
  'price_desc',
  'effective_price',
  'offer',
  'rating',
  'reviews',
];

/**
 * Price: selected-service price, low→high or high→low; salons without one last either way.
 * Effective price: the same, after the card's certain offer. Offer: certain offers first, then the
 * largest saving; salons without an offer last. Rating: highest average first, unrated last, then
 * more reviews. Reviews: most reviews first, then rating.
 * Stable sort, so equal values keep their incoming order (nearest-first in distance mode).
 */
export function sortListItems(
  items: SalonListItemDto[],
  sort: RankedSort,
): SalonListItemDto[] {
  const last = Number.POSITIVE_INFINITY;
  const offerRank = (item: SalonListItemDto) => {
    const offer = item.offers?.[0];
    return offer ? (offer.conditional ? 1 : 0) : 2;
  };
  return [...items].sort((a, b) => {
    switch (sort) {
      case 'price':
        return (comparedPrice(a) ?? last) - (comparedPrice(b) ?? last);
      case 'price_desc':
        return (comparedPrice(b) ?? -1) - (comparedPrice(a) ?? -1);
      case 'effective_price':
        return (effectivePrice(a) ?? last) - (effectivePrice(b) ?? last);
      case 'offer':
        return (
          offerRank(a) - offerRank(b) ||
          (b.offers?.[0]?.saving ?? 0) - (a.offers?.[0]?.saving ?? 0)
        );
      case 'wait':
        return (
          (a.queueWait?.estimatedWaitMinutes ?? last) -
          (b.queueWait?.estimatedWaitMinutes ?? last)
        );
      case 'reviews':
        return (
          b.ratingCount - a.ratingCount ||
          (b.ratingAverage ?? -1) - (a.ratingAverage ?? -1)
        );
      default:
        return (
          (b.ratingAverage ?? -1) - (a.ratingAverage ?? -1) ||
          b.ratingCount - a.ratingCount
        );
    }
  });
}

// Today's salon-local opening hours ("HH:mm"), or null when the salon has no hours for today or
// no trustworthy time zone (never guessed — same convention as isOpenNow).
function todayHoursOf(
  hours: {
    dayOfWeek: number;
    isClosed: boolean;
    openTime: string;
    closeTime: string;
  }[],
  salon: { timezone: string | null; city: { countryCode: string } },
): { isClosed: boolean; openTime: string; closeTime: string } | null {
  const timeZone = resolveSalonTimeZone({
    timezone: salon.timezone,
    countryCode: salon.city.countryCode,
  });
  if (!timeZone) return null;
  const { dayOfWeek } = zonedDayAndMinutes(new Date(), timeZone);
  const today = hours.find((entry) => entry.dayOfWeek === dayOfWeek);
  return today
    ? {
        isClosed: today.isClosed,
        openTime: today.openTime,
        closeTime: today.closeTime,
      }
    : null;
}

// When a closed salon next opens: today (later), tomorrow, or a later weekday within the week.
// Null when the salon lists no upcoming opening hours or has no trustworthy time zone.
export function nextOpeningOf(
  hours: {
    dayOfWeek: number;
    isClosed: boolean;
    openTime: string;
  }[],
  salon: { timezone: string | null; city: { countryCode: string } },
  now = new Date(),
): { inDays: number; dayOfWeek: number; time: string } | null {
  const timeZone = resolveSalonTimeZone({
    timezone: salon.timezone,
    countryCode: salon.city.countryCode,
  });
  if (!timeZone) return null;
  const { dayOfWeek, minutes } = zonedDayAndMinutes(now, timeZone);
  for (let inDays = 0; inDays < 7; inDays++) {
    const day = (dayOfWeek + inDays) % 7;
    const entry = hours.find((h) => h.dayOfWeek === day);
    if (!entry || entry.isClosed) continue;
    const [h, m] = entry.openTime.split(':').map(Number);
    if (inDays === 0 && minutes >= h * 60 + m) continue;
    return { inDays, dayOfWeek: day, time: entry.openTime };
  }
  return null;
}

type SalonWithListRelations = Prisma.SalonGetPayload<{
  include: typeof listInclude;
}>;

@Injectable()
export class SalonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly citiesService: CitiesService,
    private readonly salonAccess: SalonAccessService,
    private readonly tokenService: TokenService,
  ) {}

  // Public live stats deliberately exclude the platform-wide shop total. Shop count is an
  // admin-only metric; public/customer surfaces only receive current queue activity.
  async getLiveStats(): Promise<LiveStatsDto> {
    const liveWaitingCount = await this.prisma.queueEntry.count({
      where: {
        status: {
          in: [
            QueueEntryStatus.WAITING,
            QueueEntryStatus.CALLED,
            QueueEntryStatus.IN_SERVICE,
          ],
        },
      },
    });
    return { liveWaitingCount };
  }

  async searchServiceSuggestions(
    rawQuery: string,
    requestedLimit = 8,
  ): Promise<ServiceSuggestionDto[]> {
    const q = rawQuery.trim();
    if (q.length < 2) return [];
    const limit = Math.min(Math.max(requestedLimit, 1), 250);
    const rows = await this.prisma.service.findMany({
      where: {
        isActive: true,
        salon: { status: SalonStatus.ACTIVE },
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { category: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { name: true, category: true },
      distinct: ['name'],
      orderBy: { name: 'asc' },
      take: limit,
    });
    return rows;
  }

  async search(
    query: SalonSearchQueryInput,
  ): Promise<PaginatedResult<SalonListItemDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.SalonWhereInput = { status: SalonStatus.ACTIVE };
    // City.slug is unique only per country (@@unique([countryCode, slug])), so a bare slug filter
    // can match a same-named city in a different country. countryCode is optional here because
    // not every caller has one in hand (free-text search, the landing page's featured shops) —
    // when it's supplied (city/locality pages, sitemap) the filter is exact rather than ambiguous.
    if (query.city) {
      where.city = query.countryCode
        ? { slug: query.city, countryCode: query.countryCode.toUpperCase() }
        : { slug: query.city };
    }
    if (query.locality) where.locality = { slug: query.locality };
    // The visible /search Service field keeps only salons with an active service of that name or an
    // equivalent one (expandServiceNameSearch: synonyms, plurals, typos, Hinglish). It only decides
    // which salons stay visible — prices, offers, the price filter and sorts are untouched. Kept in
    // where.AND so it never collides with `service`'s own where.services key.
    if (query.serviceName) {
      const search = expandServiceNameSearch(query.serviceName);
      where.AND = [
        {
          services: {
            some: {
              isActive: true,
              OR: search.match.map((term) => ({
                name: { contains: term, mode: 'insensitive' as const },
              })),
              ...(search.exclude.length
                ? {
                    NOT: search.exclude.map((term) => ({
                      name: { contains: term, mode: 'insensitive' as const },
                    })),
                  }
                : {}),
            },
          },
        },
      ];
    }

    // Part 8/9 correction: a price filter must be satisfied by the SAME service that matched the
    // text search, never any unrelated service the salon happens to also offer. Searching "Haircut"
    // with a ₹300 ceiling at a salon selling an ₹800 Haircut and a ₹200 Shave must exclude that
    // salon — the ₹200 Shave is irrelevant to what was actually searched for. `priceCondition` is
    // the raw Decimal range (undefined when no price filter is active); `withPrice` folds it onto a
    // service-relevance predicate as an extra AND branch, so a single `services.some(...)` row has
    // to satisfy both at once.
    const priceCondition: Prisma.DecimalFilter | undefined =
      query.priceMin !== undefined || query.priceMax !== undefined
        ? {
            ...(query.priceMin !== undefined ? { gte: query.priceMin } : {}),
            ...(query.priceMax !== undefined ? { lte: query.priceMax } : {}),
          }
        : undefined;

    function serviceRelevance(term: string): Prisma.ServiceWhereInput {
      return {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { category: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    function withPrice(
      relevance: Prisma.ServiceWhereInput,
    ): Prisma.ServiceWhereInput {
      return priceCondition
        ? { AND: [relevance, { price: priceCondition }] }
        : relevance;
    }

    if (query.service) {
      where.services = {
        some: { isActive: true, ...withPrice(serviceRelevance(query.service)) },
      };
    }
    // Issue #13 Mission D: the web search form's field is genuinely labeled "Shop or service" —
    // typing "bear" (or "beard") for a real shop's real "Beard" service returned zero results,
    // because this only ever matched salon name/description, never a service. Now mirrors the
    // same name-or-category match query.service already uses above, so the field actually
    // searches what it claims to. Its own service sub-clause gets the identical same-service price
    // treatment as `query.service` above — this is the field the real search UI actually sends
    // free-text through, so the "Haircut + ₹300 ceiling excludes an ₹800 Haircut" fix must apply
    // here too, not only to the separate, rarely-used `service` param.
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        {
          services: {
            some: { isActive: true, ...withPrice(serviceRelevance(query.q)) },
          },
        },
      ];
    }

    // Broad price filtering (Part 8/9) — only when there is no service-relevance text to pin the
    // price check to (no `service` param). A price filter alone, or paired with `q`, still requires
    // *some* active service in range: `q`'s name/description match branches above have no specific
    // service to check price against, so without this a name-matched salon with zero affordable
    // services could otherwise pass a price filter entirely unchecked. When `query.service` is
    // set, this would be redundant (the tightened where.services above already fully encodes the
    // price constraint) and is skipped. Uses `where.AND` rather than a second `where.services` key
    // so it never collides with `query.service`'s own key on the same `where` object.
    // Discovery upgrade: salon type (rule in SALON_TYPE_FILTER_MATCHES — Male/Female include Unisex,
    // "Unisex only" requires an owner-confirmed type) and a popular service to compare by. The
    // popular service gets the same same-service price treatment as `service`: one matching
    // service row must satisfy both the match and the price range.
    if (query.salonType) {
      const rule = SALON_TYPE_FILTER_MATCHES[query.salonType];
      where.salonType = { in: [...rule.types] };
      if (rule.requiresConfirmed) where.salonTypeConfirmed = true;
    }
    const popular = popularServiceById(query.popularService);
    if (popular) {
      const popularCondition: Prisma.SalonWhereInput = {
        services: {
          some: {
            isActive: true,
            ...withPrice(popularServiceRelevance(popular)),
          },
        },
      };
      where.AND = where.AND
        ? [
            ...(Array.isArray(where.AND) ? where.AND : [where.AND]),
            popularCondition,
          ]
        : [popularCondition];
    }
    const selected = popular
      ? { service: popular, price: priceCondition }
      : undefined;

    if (priceCondition && !query.service && !popular) {
      const broadPriceCondition: Prisma.SalonWhereInput = {
        services: { some: { isActive: true, price: priceCondition } },
      };
      where.AND = where.AND
        ? [
            ...(Array.isArray(where.AND) ? where.AND : [where.AND]),
            broadPriceCondition,
          ]
        : [broadPriceCondition];
    }

    // Discovery upgrade: "favorites only" (the client's saved salon IDs) and a minimum average
    // review score. Unreviewed salons have no average, so they never pass a minimum.
    const extraConditions: Prisma.SalonWhereInput[] = [];
    if (query.ids) extraConditions.push({ id: { in: query.ids } });
    // Offers only: a published offer valid now that covers the selected service (an offer with
    // no linked services covers all of them), or any active service when none is selected.
    if (query.offersOnly) {
      const now = new Date();
      const coveredService: Prisma.ServiceWhereInput = popular
        ? { isActive: true, ...popularServiceRelevance(popular) }
        : { isActive: true };
      extraConditions.push({
        offers: {
          some: {
            status: 'ACTIVE',
            validFrom: { lte: now },
            validTo: { gt: now },
            OR: [
              { services: { none: {} } },
              { services: { some: { service: coveredService } } },
            ],
          },
        },
      });
    }
    if (query.minRating !== undefined) {
      const rated = await this.prisma.review.groupBy({
        by: ['salonId'],
        _avg: { rating: true },
        having: { rating: { _avg: { gte: query.minRating } } },
      });
      extraConditions.push({ id: { in: rated.map((r) => r.salonId) } });
    }
    if (extraConditions.length > 0) {
      where.AND = [
        ...(where.AND
          ? Array.isArray(where.AND)
            ? where.AND
            : [where.AND]
          : []),
        ...extraConditions,
      ];
    }
    // "Open now" depends on each salon's hours in its own time zone, so it is checked per
    // candidate after loading — which makes it a bounded, single-page mode like the sorts below.
    const openNowOnly = query.openNow === true;
    // Live queue filter: open now with an estimated wait within the limit (checked after loading,
    // like open now, so it is a bounded single-page mode too).
    const maxWait = query.maxWaitMinutes;
    const keepOpen = (items: SalonListItemDto[]) =>
      items.filter(
        (item) =>
          (!openNowOnly || item.isOpenNow === true) &&
          (maxWait === undefined ||
            (item.queueWait != null &&
              item.queueWait.estimatedWaitMinutes <= maxWait)),
      );
    const checkedAfterLoad = openNowOnly || maxWait !== undefined;

    // "Near Me" (Phase 4): sorting by a computed haversine distance isn't something Prisma/Postgres
    // can do without a geo extension (PostGIS earthdistance), which isn't set up here. Rather than
    // fake a stable cursor over an in-memory sort, distance mode fetches a capped batch, sorts it
    // in memory, and returns a single unpaginated page (nextCursor always null) — an honest
    // limitation for a foundation-phase, demo-scale salon count, not a hidden bug. Still bounded
    // candidates + in-memory Haversine, never PostGIS/a real nearest-neighbour index. Within that
    // architecture, candidates are now drawn from a geographic bounding box around the query point
    // (see boundingBoxDegrees), not merely "coordinate-bearing" — at real scale, a query point in a
    // dense city could otherwise have its 200-row cap filled entirely by coordinate-bearing salons
    // hundreds of km away in a different city, silently crowding out the genuinely nearby ones the
    // box now excludes them from competing with in the first place. The box widens (NEAR_ME_RADII_KM)
    // if the tightest one doesn't turn up enough candidates to fill a page — a sparse/rural query
    // point still gets a useful result instead of an artificially empty one — capped at the widest
    // configured radius rather than widening indefinitely into an unbounded scan. This remains an
    // honest limitation, not a claim of global correctness: with more than NEAR_ME_CANDIDATE_CAP
    // salons inside whichever box is used, the cap still picks an arbitrary (id-ordered, so at least
    // deterministic) subset of them rather than the exact nearest — the box only guarantees that
    // subset is geographically relevant, not that it's the true top-200-nearest within itself.
    const nearMe = query.lat !== undefined && query.lng !== undefined;
    // Price and rating sorts need every candidate's value before ordering, so — like "Near me" —
    // they rank a bounded candidate set in memory and return a single page (nextCursor null).
    const sort = query.sort ?? (nearMe ? 'distance' : 'relevance');
    const ranked = RANKED_SORTS.includes(sort) ? (sort as RankedSort) : null;
    if (!nearMe && (ranked || checkedAfterLoad)) {
      const candidates = await this.prisma.salon.findMany({
        where,
        orderBy: sort === 'relevance' ? { name: 'asc' } : { id: 'asc' },
        take: NEAR_ME_CANDIDATE_CAP,
        include: listInclude,
      });
      const items = keepOpen(
        await this.toListItems(candidates, undefined, selected),
      );
      return {
        items: (ranked ? sortListItems(items, ranked) : items).slice(0, limit),
        nextCursor: null,
      };
    }
    if (nearMe) {
      const from = { lat: query.lat!, lng: query.lng! };
      // Distance filter (Part 8/9): an explicit radiusKm is a hard cap the caller asked for, not a
      // "find me enough results" hint — widening past it (the way the no-radius path below
      // deliberately does) would silently return salons farther away than requested. So this tries
      // exactly one box, sized to the requested radius, instead of walking NEAR_ME_RADII_KM.
      const radiiToTry =
        query.radiusKm !== undefined ? [query.radiusKm] : NEAR_ME_RADII_KM;
      // A salon with no lat/lng can never get a distance and is always dropped by the
      // distanceKm-not-null filter below — fetching it into the capped candidate set would only
      // ever waste one of the NEAR_ME_CANDIDATE_CAP slots. Filtering coordinates at the DB level
      // (on top of the bounding box) spends every one of the capped rows on a salon that can
      // actually appear in the sorted result.
      let candidates: SalonWithListRelations[] = [];
      for (const radiusKm of radiiToTry) {
        const box = boundingBoxDegrees(from.lat, from.lng, radiusKm);
        candidates = await this.prisma.salon.findMany({
          where: {
            ...where,
            lat: { not: null, gte: box.minLat, lte: box.maxLat },
            lng: { not: null, gte: box.minLng, lte: box.maxLng },
          },
          // Deterministic across widening attempts and repeated calls — Prisma/Postgres give no
          // ordering guarantee without an explicit orderBy, which would otherwise make which 200
          // rows survive the cap (when more than 200 match) merely "incidental," not reproducible.
          orderBy: { id: 'asc' },
          take: NEAR_ME_CANDIDATE_CAP,
          include: listInclude,
        });
        if (candidates.length >= limit) break;
      }
      const candidateItems = await this.toListItems(candidates, from, selected);
      const withDistance = candidates.map((s, index) => ({
        item: candidateItems[index],
        // SalonListItemDto.distanceKm is deliberately pre-rounded to 1 decimal place for
        // display — not precise enough for a hard radius cutoff (a salon at exactly 0.15km
        // rounds to "0.1 km" and would then wrongly pass a 0.1km radius check). The radius
        // filter below always compares against this unrounded value instead.
        rawDistanceKm:
          s.lat !== null && s.lng !== null
            ? haversineDistanceKm(from.lat, from.lng, s.lat, s.lng)
            : null,
      }));
      const sorted = withDistance
        .filter((w) => w.item.distanceKm !== null)
        .filter((w) => keepOpen([w.item]).length === 1)
        // The bounding box is a rectangle approximation of a circle (see boundingBoxDegrees), so a
        // corner of the box can sit slightly beyond the true requested radius — this is the actual
        // hard cutoff a caller-supplied radiusKm promises, checked against the real, unrounded
        // Haversine distance, never just "was it inside the prefilter box" or the rounded display
        // value.
        .filter(
          (w) =>
            query.radiusKm === undefined || w.rawDistanceKm! <= query.radiusKm,
        )
        // Tie-broken by id: the candidate query has no explicit orderBy, so two salons at an
        // identical distance would otherwise sort in whatever incidental row order Postgres
        // happened to return them in — never guaranteed, and not something a client can rely on
        // page-to-page. Sorting is stable (ES2019+), so this tiebreaker makes the full order
        // deterministic rather than merely "probably consistent."
        .sort(
          (a, b) =>
            a.rawDistanceKm! - b.rawDistanceKm! ||
            a.item.id.localeCompare(b.item.id),
        )
        .map((w) => w.item);
      // Within the distance-sorted, radius-filtered set, price/rating sorts re-rank (stable, so
      // equal values stay nearest-first).
      return {
        items: (ranked ? sortListItems(sorted, ranked) : sorted).slice(
          0,
          limit,
        ),
        nextCursor: null,
      };
    }

    const salons = await this.prisma.salon.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: listInclude,
    });

    const hasMore = salons.length > limit;
    const page = hasMore ? salons.slice(0, limit) : salons;
    const items = await this.toListItems(page, undefined, selected);

    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async getProfile(
    countryCode: string,
    citySlug: string,
    salonSlug: string,
  ): Promise<SalonProfileDto> {
    const city = await this.citiesService.findCityByCountryAndSlugOrThrow(
      countryCode,
      citySlug,
    );

    const salon = await this.prisma.salon.findFirst({
      where: { slug: salonSlug, cityId: city.id, status: SalonStatus.ACTIVE },
      include: {
        city: true,
        locality: true,
        photos: { orderBy: { sortOrder: 'asc' } },
        services: { where: { isActive: true }, orderBy: { name: 'asc' } },
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
        reviews: { orderBy: { createdAt: 'desc' }, take: RECENT_REVIEWS_LIMIT },
        // Phase 17 (Barber Professional Profile) — "Meet the team". Only staff currently working
        // here; someone marked INACTIVE (left, on leave) isn't shown to customers browsing the shop.
        staff: {
          where: { status: StaffMemberStatus.ACTIVE },
          orderBy: { displayName: 'asc' },
          // Phase 18 — status only, same reasoning as the salon's own verification include below.
          include: { verification: { select: { status: true } } },
        },
        // Phase 18 — status only; no row at all means "never submitted," not verified.
        verification: { select: { status: true } },
      },
    });
    if (!salon) {
      throw new AppException(
        'SALON_NOT_FOUND',
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    const { ratingAverage, ratingCount, priceMin, priceMax } =
      await this.aggregate(salon.id);

    return {
      id: salon.id,
      publicId: salon.publicId,
      name: salon.name,
      slug: salon.slug,
      citySlug: salon.city.slug,
      localitySlug: salon.locality?.slug,
      addressLine: salon.addressLine,
      countryCode: salon.city.countryCode,
      currency: salon.currency,
      postalCode: salon.postalCode,
      lat: salon.lat,
      lng: salon.lng,
      coverPhotoUrl:
        salon.photos.find((p) => p.type === 'COVER')?.url ??
        salon.photos[0]?.url ??
        null,
      ratingAverage,
      ratingCount,
      priceMin,
      priceMax,
      // No lat/lng of the viewer to compare against on the profile page (unlike search results)
      // — the customer already navigated here, distance is no longer the decision being made.
      distanceKm: null,
      isOpenNow: salon.isClosedForToday
        ? false
        : isOpenNow(salon.operatingHours, salon),
      isClosedForToday: salon.isClosedForToday,
      // Pre-confirmation timezone fix: the salon's resolved IANA zone, so the booking flow (date
      // picker, slot times, pre-confirm summary) can render in the SALON's local time instead of
      // the customer device's, the same way BookingDetailDto.salonTimezone already does for
      // post-booking screens (Part 5). Public scheduling metadata, safe on the public profile DTO
      // — never the raw owner-only Salon.timezone override flags, just the resolved zone string.
      salonTimezone: resolveSalonTimeZone({
        timezone: salon.timezone,
        countryCode: salon.city.countryCode,
      }),
      verified: salon.verification?.status === VerificationStatus.APPROVED,
      waitingCount: await this.prisma.queueEntry.count({
        where: {
          salonId: salon.id,
          status: {
            in: [
              QueueEntryStatus.WAITING,
              QueueEntryStatus.CALLED,
              QueueEntryStatus.IN_SERVICE,
            ],
          },
        },
      }),
      onlineBookingDiscountPercent: salon.onlineBookingDiscountPercent,
      description: salon.description,
      // Owner-operations mission: the owner may choose not to publish the shop phone. The column
      // defaults to true (the phone was already public), so only an explicit opt-out hides it.
      phone: salon.showPhoneToCustomers === false ? null : salon.phone,
      services: salon.services.map((s) => ({
        id: s.id,
        salonId: s.salonId,
        name: s.name,
        durationMinutes: s.durationMinutes,
        price: Number(s.price),
        category: s.category ?? '',
        subcategory: s.subcategory ?? null,
        categoryId: s.categoryId ?? null,
        subcategoryId: s.subcategoryId ?? null,
        isActive: s.isActive,
      })),
      operatingHours: salon.operatingHours.map((h) => ({
        dayOfWeek: h.dayOfWeek,
        openTime: h.openTime,
        closeTime: h.closeTime,
        isClosed: h.isClosed,
      })),
      photos: salon.photos.map((p) => ({
        id: p.id,
        url: p.url,
        altText: p.altText,
        type: p.type,
      })),
      reviews: salon.reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
      team: salon.staff.map((s): TeamMemberDto => ({
        id: s.id,
        displayName: s.displayName,
        roleInSalon: s.roleInSalon,
        photoUrl: s.photoUrl,
        bio: s.bio,
        yearsExperience: s.yearsExperience,
        verified: s.verification?.status === VerificationStatus.APPROVED,
      })),
    };
  }

  /**
   * Public live operating snapshot for a salon profile/booking page. Only active chairs, active
   * professionals, and aggregate active queue counts are selected. In particular, queue-entry
   * IDs and customer relations are never selected or serialized across this public boundary.
   */
  async getPublicStatus(
    countryCode: string,
    citySlug: string,
    salonSlug: string,
  ): Promise<PublicSalonStatusDto> {
    const city = await this.citiesService.findCityByCountryAndSlugOrThrow(
      countryCode,
      citySlug,
    );
    const salon = await this.prisma.salon.findFirst({
      where: {
        slug: salonSlug,
        cityId: city.id,
        status: SalonStatus.ACTIVE,
        isClosedForToday: false,
      },
      select: {
        chairs: {
          where: { status: ChairStatus.ACTIVE },
          select: { id: true },
        },
        staff: {
          where: { status: StaffMemberStatus.ACTIVE },
          orderBy: { displayName: 'asc' },
          select: {
            displayName: true,
            _count: {
              select: {
                queueEntriesAssigned: {
                  where: {
                    status: {
                      in: [
                        QueueEntryStatus.WAITING,
                        QueueEntryStatus.CALLED,
                        QueueEntryStatus.IN_SERVICE,
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!salon) {
      throw new AppException(
        'SALON_NOT_FOUND',
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      activeChairCount: salon.chairs.length,
      professionals: salon.staff.map((staff) => ({
        displayName: staff.displayName,
        activeQueueCount: staff._count.queueEntriesAssigned,
      })),
    };
  }

  /**
   * Self-serve shop registration (major-upgrade phase). Any authenticated user — including a
   * customer who just signed up seconds ago via Google — may register a shop; a SALON_OWNER
   * UserRole is granted for the new salon in the same transaction, on top of (never replacing)
   * whatever roles they already have. Requires an existing City (by slug) rather than accepting
   * free-text state/country, so a typo can't silently create a duplicate/junk City row — city
   * curation stays CitiesService's existing, separate concern.
   *
   * Auth-security-branch fix: the caller's EXISTING session's audience is never upgraded in
   * place — TokenService.rotateRefreshToken deliberately preserves a token's original audience
   * forever (a CUSTOMER session must never become able to mint SALON_OWNER just because the DB
   * role now exists). So a customer registering their first shop would otherwise be left holding
   * a CUSTOMER-scoped token that can never reach the very shop they just created, no matter how
   * many times they refresh. This method closes that gap the same way every other login does:
   * mints a genuine new STAFF-audience token pair via TokenService.issueTokenPair, scoped to
   * whatever roles the user now actually holds (including the SALON_OWNER just granted) —
   * never a patched-in role on the old token, never a bypass of TOTP/owner auth (there is no
   * separate "owner credential" to bypass; STAFF-audience login has never required one beyond
   * the role itself, same as this).
   */
  async registerSalon(
    ownerUserId: string,
    input: RegisterSalonInput,
    deviceInfo?: string,
  ): Promise<RegisterSalonResponseDto> {
    const city = await this.citiesService.findCityBySlugOrThrow(input.citySlug);

    // The client sends countryCode so postal validation can run before any lookup. Re-check it
    // against the city we actually resolved: without this, a caller could pair a country with a
    // lenient postal rule against a city in a country with a strict one and bypass the rule.
    if (city.countryCode !== input.countryCode) {
      throw new AppException(
        'CITY_COUNTRY_MISMATCH',
        'That city does not belong to the selected country.',
        HttpStatus.BAD_REQUEST,
      );
    }

    let localityId: string | null = null;
    let resolvedLocalityName: string | null = null;
    if (input.localitySlug) {
      const locality = await this.prisma.locality.findUnique({
        where: { cityId_slug: { cityId: city.id, slug: input.localitySlug } },
      });
      if (!locality) {
        throw new AppException(
          'LOCALITY_NOT_FOUND',
          'Locality not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      localityId = locality.id;
      resolvedLocalityName = locality.name;
    }

    // Part 4 (auto timezone selection): try to resolve a confident IANA zone from whatever the
    // owner actually gave us at registration — GPS coordinates first (most precise), then the
    // resolved city's own known zone, then the India-only country fallback. Ambiguous/unresolved
    // stays null, same as before this feature existed — never a fabricated guess.
    const timezoneSuggestion = resolveAutoTimezone({
      latitude: input.lat ?? null,
      longitude: input.lng ?? null,
      cityTimezone: city.timezone,
      countryCode: city.countryCode,
    });

    const baseSlug = slugify(input.name);
    let lastError: Prisma.PrismaClientKnownRequestError | undefined;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      try {
        const salon = await this.prisma.$transaction(async (tx) => {
          // publicId is never set here — it's a DB column DEFAULT (see the
          // add_salon_public_id migration's sequence), so every real INSERT gets one
          // automatically, with uniqueness guaranteed by Postgres, not app code.
          const created = await tx.salon.create({
            data: {
              ownerUserId,
              name: input.name,
              slug,
              cityId: city.id,
              localityId,
              // Always preserve what the owner typed. Older clients that still send only a
              // curated localitySlug get the resolved locality name here, so this additive field
              // remains backward-compatible during mobile rollout.
              localityText: input.localityText ?? resolvedLocalityName,
              landmark: input.landmark ?? null,
              // Discovery upgrade: a type chosen at registration is confirmed; an older client that
              // omits it keeps the UNISEX default, unconfirmed ("type not set" in discovery).
              ...(input.salonType
                ? { salonType: input.salonType, salonTypeConfirmed: true }
                : {}),
              addressLine: input.addressLine,
              postalCode: input.postalCode ?? null,
              // Derived from the country, and only where that mapping is authoritative — an
              // unlisted country leaves this null rather than guessing a currency, and the UI
              // then renders a bare amount instead of a wrong symbol.
              currency: currencyForCountry(city.countryCode),
              // Part 4: auto-filled only when resolveAutoTimezone is actually confident (EXACT or
              // HIGH) — an AMBIGUOUS/null result leaves this null exactly like before the feature
              // existed, so a multi-timezone country with no coordinates never gets a guessed
              // zone. timezoneAutoDetected records that this came from detection, not an owner
              // choice, so the settings page can still offer to refine/confirm it later.
              timezone: timezoneSuggestion?.timezone ?? null,
              timezoneAutoDetected: Boolean(timezoneSuggestion),
              // Absent when the owner declined GPS — stored as NULL, not 0/0 (a real place in
              // the Gulf of Guinea), so "unknown" stays distinguishable from "there".
              lat: input.lat ?? null,
              lng: input.lng ?? null,
              phone: input.phone ?? null,
              email: input.email ?? null,
              status: SalonStatus.PENDING,
              // Distinguish new registrations from legacy rows left NULL by the additive migration.
              shopPhotoRequirementGrandfathered: false,
            },
          });
          await tx.userRole.upsert({
            where: {
              userId_role_salonId: {
                userId: ownerUserId,
                role: 'SALON_OWNER',
                salonId: created.id,
              },
            },
            update: {},
            create: {
              userId: ownerUserId,
              role: 'SALON_OWNER',
              salonId: created.id,
            },
          });

          // Fast onboarding defaults. These are persisted in the same registration transaction,
          // so every client (web, mobile or API) starts from the same ready-to-edit baseline:
          // 09:00-21:00 on every day and ten active chairs. Owners can edit/deactivate either
          // later; nothing here affects already-existing shops.
          await tx.operatingHours.createMany({
            data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
              salonId: created.id,
              dayOfWeek,
              openTime: '09:00',
              closeTime: '21:00',
              isClosed: false,
            })),
          });
          await tx.chair.createMany({
            data: Array.from({ length: 10 }, (_, index) => ({
              salonId: created.id,
              label: `Chair ${index + 1}`,
              status: ChairStatus.ACTIVE,
            })),
          });
          return created;
        });

        // Fresh read, not the pre-grant roles we started this call with — this is the exact
        // point of the fix: the newly-granted SALON_OWNER must actually make it into the minted
        // token, which only a real re-read (not the caller's stale in-memory role list) can see.
        const freshUser = await this.prisma.user.findUniqueOrThrow({
          where: { id: ownerUserId },
          include: { roles: true },
        });
        const scopedRoles = this.tokenService.scopeRolesToAudience(
          freshUser.roles.map((r) => r.role),
          SessionAudience.STAFF,
        );
        const tokens = await this.tokenService.issueTokenPair(
          ownerUserId,
          scopedRoles,
          SessionAudience.STAFF,
          deviceInfo,
        );
        const user: MeResponse = {
          id: freshUser.id,
          roles: scopedRoles,
          audience: SessionAudience.STAFF,
          phone: freshUser.phone,
          email: freshUser.email,
          preferredLanguage: freshUser.preferredLanguage,
          passwordConfigured: Boolean(freshUser.passwordHash),
        };

        return {
          salon: {
            id: salon.id,
            publicId: salon.publicId,
            slug: salon.slug,
            name: salon.name,
            status: salon.status,
            isClosedForToday: salon.isClosedForToday,
          },
          user,
          tokens,
        };
      } catch (err) {
        // Only retry on the specific (cityId, slug) collision — anything else is a real failure.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw (
      lastError ??
      new AppException(
        'SALON_SLUG_UNAVAILABLE',
        'Could not register this shop. Please try again.',
        HttpStatus.CONFLICT,
      )
    );
  }

  /** GET salons/mine — every salon this user owns, for the dashboard's salon-picker landing page. */
  async listOwned(ownerUserId: string): Promise<RegisterSalonResultDto[]> {
    const salons = await this.prisma.salon.findMany({
      where: { ownerUserId },
      orderBy: { name: 'asc' },
    });
    return salons.map((s) => ({
      id: s.id,
      publicId: s.publicId,
      slug: s.slug,
      name: s.name,
      status: s.status,
      isClosedForToday: s.isClosedForToday,
    }));
  }

  /**
   * GET salons/workplaces — every salon this user may operate, for owners AND staff.
   *
   * listOwned above keys on Salon.ownerUserId, so a barber (who owns nothing) gets an empty list
   * and no route to the salon they actually work at. This resolves membership from UserRole —
   * byte-for-byte the same condition SalonAccessService.assertAccess enforces — so the list can
   * never show a salon the caller would then be refused, or hide one they can reach.
   *
   * `isOwner` is derived for presentation only. It decides whether the dashboard offers setup
   * links or just the live queue; it confers nothing, since every owner-only route independently
   * checks @Roles(SALON_OWNER) and assertAccess.
   */
  async listWorkplaces(userId: string): Promise<SalonWorkplaceDto[]> {
    const memberships = await this.prisma.userRole.findMany({
      where: {
        userId,
        salonId: { not: null },
        role: { in: [Role.SALON_STAFF, Role.SALON_OWNER] },
      },
      include: { salon: true },
    });

    // One user can hold both SALON_OWNER and SALON_STAFF for the same salon (an owner who also
    // cuts hair), which would otherwise list it twice.
    const bySalon = new Map<string, SalonWorkplaceDto>();
    for (const m of memberships) {
      if (!m.salon) continue;
      const existing = bySalon.get(m.salon.id);
      const isOwner = m.role === Role.SALON_OWNER;
      if (existing) {
        if (isOwner) existing.isOwner = true;
        continue;
      }
      bySalon.set(m.salon.id, {
        id: m.salon.id,
        publicId: m.salon.publicId,
        slug: m.salon.slug,
        name: m.salon.name,
        status: m.salon.status,
        isClosedForToday: m.salon.isClosedForToday,
        isOwner,
      });
    }

    return [...bySalon.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * GET salons/mine/:salonId — minimal owner/staff-scoped detail (publicId + identity), for the
   * settings page. Reuses SalonAccessService (the same membership check the queue dashboard
   * already relies on) rather than a bespoke ownerUserId check, so access rules can't drift
   * between "can view this salon's settings" and "can operate this salon's queue".
   *
   * Part 2 — falls back to assertOwnerOrAdminAccess only when the normal owner/staff check fails,
   * so a genuine owner/staff request is completely unaffected (same call, same behavior, same
   * error) and a PLATFORM_ADMIN can load this same settings-page data for an ACTIVE salon they are
   * delegated-managing. A caller that is neither still gets assertOwnerOrAdminAccess's own
   * SALON_ACCESS_DENIED, not the original assertAccess error — both are 403s with an equivalent
   * message, so nothing meaningful is lost for a genuinely unauthorized caller.
   */
  async getOwnedSalon(
    userId: string,
    salonId: string,
  ): Promise<RegisterSalonResultDto> {
    try {
      await this.salonAccess.assertAccess(userId, salonId);
    } catch {
      await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    }
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
    });
    if (!salon) {
      throw new AppException(
        'SALON_NOT_FOUND',
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      id: salon.id,
      publicId: salon.publicId,
      slug: salon.slug,
      name: salon.name,
      status: salon.status,
      isClosedForToday: salon.isClosedForToday,
    };
  }

  /**
   * List items for a page of salons, with every per-salon figure (ratings, price span, live queue,
   * selected-service price) fetched in a handful of grouped queries rather than 3-4 queries per
   * salon. Order matches `salons`. Public so the favorites list renders the exact same item shape.
   */
  async toListItems(
    salons: SalonWithListRelations[],
    from?: { lat: number; lng: number },
    selected?: { service: PopularService; price?: Prisma.DecimalFilter },
  ): Promise<SalonListItemDto[]> {
    if (salons.length === 0) return [];
    const ids = salons.map((salon) => salon.id);
    const now = new Date();
    // Queue waits only matter while a salon is open, so only those salons are queried.
    const openIds = salons
      .filter(
        (salon) =>
          !salon.isClosedForToday &&
          isOpenNow(salon.operatingHours, salon) === true,
      )
      .map((salon) => salon.id);
    const waitInputs = openIds.length
      ? this.queueWaitInputs(openIds, now)
      : Promise.resolve(null);
    const [ratings, prices, waiting, matches, activeServices, offerRows] =
      await Promise.all([
        this.prisma.review.groupBy({
          by: ['salonId'],
          where: { salonId: { in: ids } },
          _avg: { rating: true },
          _count: { rating: true },
        }),
        this.prisma.service.groupBy({
          by: ['salonId'],
          where: { salonId: { in: ids }, isActive: true },
          _min: { price: true },
          _max: { price: true },
          _avg: { durationMinutes: true },
        }),
        // Same WAITING/CALLED/IN_SERVICE whitelist getDashboardQueue/getCapacitySummary use.
        this.prisma.queueEntry.groupBy({
          by: ['salonId'],
          where: {
            salonId: { in: ids },
            status: {
              in: [
                QueueEntryStatus.WAITING,
                QueueEntryStatus.CALLED,
                QueueEntryStatus.IN_SERVICE,
              ],
            },
          },
          _count: { _all: true },
        }),
        selected
          ? this.prisma.service.findMany({
              where: {
                salonId: { in: ids },
                isActive: true,
                ...(selected.price
                  ? {
                      AND: [
                        popularServiceRelevance(selected.service),
                        { price: selected.price },
                      ],
                    }
                  : popularServiceRelevance(selected.service)),
              },
              select: {
                id: true,
                salonId: true,
                name: true,
                price: true,
                durationMinutes: true,
              },
              orderBy: [{ price: 'asc' }, { name: 'asc' }],
            })
          : Promise.resolve([]),
        // Every active service (cheapest first): the card's other prices and offer coverage.
        this.prisma.service.findMany({
          where: { salonId: { in: ids }, isActive: true },
          select: { id: true, salonId: true, name: true, price: true },
          orderBy: [{ price: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.offer.findMany({
          where: {
            salonId: { in: ids },
            status: 'ACTIVE',
            validFrom: { lte: now },
            validTo: { gt: now },
          },
          include: { services: { select: { serviceId: true } } },
          orderBy: [{ validTo: 'asc' }, { id: 'asc' }],
        }),
      ]);
    const ratingBy = new Map(ratings.map((r) => [r.salonId, r]));
    const priceBy = new Map(prices.map((p) => [p.salonId, p]));
    const waitingBy = new Map(waiting.map((w) => [w.salonId, w._count._all]));
    // Rows arrive cheapest first, so the first row per salon is its compared price.
    const selectedBy = new Map<string, (typeof matches)[number]>();
    for (const row of matches)
      if (!selectedBy.has(row.salonId)) selectedBy.set(row.salonId, row);
    const servicesBy = new Map<string, PricedService[]>();
    for (const row of activeServices) {
      const list = servicesBy.get(row.salonId) ?? [];
      list.push({ id: row.id, name: row.name, price: Number(row.price) });
      servicesBy.set(row.salonId, list);
    }
    const waitData = await waitInputs;
    const offersBy = new Map<string, OfferRow[]>();
    for (const row of offerRows) {
      const list = offersBy.get(row.salonId) ?? [];
      list.push({ ...row, serviceIds: row.services.map((s) => s.serviceId) });
      offersBy.set(row.salonId, list);
    }

    return salons.map((salon) => {
      const rating = ratingBy.get(salon.id);
      const price = priceBy.get(salon.id);
      const match = selectedBy.get(salon.id);
      const salonServices = servicesBy.get(salon.id) ?? [];
      const salonOffers = offersBy.get(salon.id) ?? [];
      const selectedPriced = selected
        ? match
          ? { id: match.id, name: match.name, price: Number(match.price) }
          : null
        : undefined;
      const summaries = summarizeOffers(
        salonOffers,
        salonServices,
        selectedPriced,
      );
      const otherServices = salonServices
        .filter((service) => service.id !== match?.id)
        .slice(0, 3);
      const openNow = salon.isClosedForToday
        ? false
        : isOpenNow(salon.operatingHours, salon);
      const todayHours = todayHoursOf(salon.operatingHours, salon);
      const distanceKm =
        from && salon.lat !== null && salon.lng !== null
          ? Math.round(
              haversineDistanceKm(from.lat, from.lng, salon.lat, salon.lng) *
                10,
            ) / 10
          : null;
      return {
        id: salon.id,
        publicId: salon.publicId,
        name: salon.name,
        slug: salon.slug,
        citySlug: salon.city.slug,
        localitySlug: salon.locality?.slug,
        addressLine: salon.addressLine,
        countryCode: salon.city.countryCode,
        currency: salon.currency,
        postalCode: salon.postalCode,
        lat: salon.lat,
        lng: salon.lng,
        coverPhotoUrl:
          salon.photos.find((photo) => photo.type === 'COVER')?.url ?? null,
        photoUrls: salon.photos.map((photo) => photo.url),
        ratingAverage: rating?._avg.rating ?? null,
        ratingCount: rating?._count.rating ?? 0,
        priceMin: price?._min.price ? Number(price._min.price) : null,
        priceMax: price?._max.price ? Number(price._max.price) : null,
        distanceKm,
        isOpenNow: openNow,
        closesAt: openNow ? (todayHours?.closeTime ?? null) : null,
        todayHours,
        queueWait:
          waitData && openNow === true
            ? estimateQueueWait({
                waitingCount: waitData.waiting.get(salon.id) ?? 0,
                activeStaff: waitData.staff.get(salon.id) ?? 0,
                activeChairs: waitData.chairs.get(salon.id) ?? 0,
                occupiedChairs: waitData.occupied.get(salon.id) ?? 0,
                avgServiceMinutes: price?._avg?.durationMinutes ?? null,
                activeSessions: waitData.sessions.get(salon.id) ?? [],
              })
            : null,
        opensNext:
          openNow === true ? null : nextOpeningOf(salon.operatingHours, salon),
        isClosedForToday: salon.isClosedForToday,
        verified: salon.verification?.status === VerificationStatus.APPROVED,
        waitingCount: waitingBy.get(salon.id) ?? 0,
        onlineBookingDiscountPercent: salon.onlineBookingDiscountPercent,
        salonType: salon.salonType,
        salonTypeConfirmed: salon.salonTypeConfirmed,
        selectedService: selected
          ? match
            ? {
                id: match.id,
                name: match.name,
                price: Number(match.price),
                durationMinutes: match.durationMinutes,
              }
            : null
          : undefined,
        serviceCount: salonServices.length,
        otherServices,
        offers: summaries.slice(0, 5),
        offerHeadline: offerHeadline(summaries),
        // Each service shown on the card with its own best certain discount.
        serviceOffers: [
          ...(selectedPriced ? [selectedPriced] : []),
          ...otherServices,
        ]
          .map((service) => {
            const best = bestCertainOfferFor(salonOffers, service);
            return best ? { serviceId: service.id, ...best } : null;
          })
          .filter((entry) => entry !== null),
      };
    });
  }

  /**
   * Batched inputs for the live-queue wait of several open salons — the same counts
   * QueueService.getQueueStatus reads for one salon: WAITING entries, ACTIVE staff, ACTIVE chairs,
   * manually occupied chairs, and services in the chair right now.
   */
  private async queueWaitInputs(ids: string[], now: Date) {
    const [waiting, staff, chairs, occupied, sessions] = await Promise.all([
      this.prisma.queueEntry.groupBy({
        by: ['salonId'],
        where: { salonId: { in: ids }, status: QueueEntryStatus.WAITING },
        _count: { _all: true },
      }),
      this.prisma.salonStaff.groupBy({
        by: ['salonId'],
        where: { salonId: { in: ids }, status: StaffMemberStatus.ACTIVE },
        _count: { _all: true },
      }),
      this.prisma.chair.groupBy({
        by: ['salonId'],
        where: { salonId: { in: ids }, status: ChairStatus.ACTIVE },
        _count: { _all: true },
      }),
      this.prisma.manualChairOccupancy.groupBy({
        by: ['salonId'],
        where: { salonId: { in: ids }, endedAt: null },
        _count: { _all: true },
      }),
      this.prisma.serviceSession.findMany({
        where: {
          status: ServiceSessionStatus.ACTIVE,
          chair: { salonId: { in: ids } },
        },
        select: {
          startedAt: true,
          service: { select: { durationMinutes: true } },
          chair: { select: { salonId: true } },
        },
      }),
    ]);
    const counts = (rows: { salonId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((row) => [row.salonId, row._count._all]));
    const bySalon = new Map<
      string,
      { durationMinutes: number; elapsedMinutes: number }[]
    >();
    for (const session of sessions) {
      const list = bySalon.get(session.chair.salonId) ?? [];
      list.push({
        durationMinutes: session.service.durationMinutes,
        elapsedMinutes: (now.getTime() - session.startedAt.getTime()) / 60_000,
      });
      bySalon.set(session.chair.salonId, list);
    }
    return {
      waiting: counts(waiting),
      staff: counts(staff),
      chairs: counts(chairs),
      occupied: counts(occupied),
      sessions: bySalon,
    };
  }

  /** Salons by id, in the given order, as list items (missing or inactive salons are skipped). */
  async listItemsByIds(ids: string[]): Promise<SalonListItemDto[]> {
    if (ids.length === 0) return [];
    const salons = await this.prisma.salon.findMany({
      where: { id: { in: ids }, status: SalonStatus.ACTIVE },
      include: listInclude,
    });
    const byId = new Map(salons.map((salon) => [salon.id, salon]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((s): s is SalonWithListRelations => !!s);
    return this.toListItems(ordered);
  }

  // Computed on read, not stored (no schema change) — see DATABASE.md's existing pattern for
  // derived values. Two small aggregate queries per salon; fine at this data volume, a candidate
  // for denormalization/caching once salon counts grow past a foundation-phase scale.
  private async aggregate(salonId: string): Promise<{
    ratingAverage: number | null;
    ratingCount: number;
    priceMin: number | null;
    priceMax: number | null;
  }> {
    const [ratingAgg, priceAgg] = await Promise.all([
      this.prisma.review.aggregate({
        where: { salonId },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      this.prisma.service.aggregate({
        where: { salonId, isActive: true },
        _min: { price: true },
        _max: { price: true },
      }),
    ]);
    return {
      ratingAverage: ratingAgg._avg.rating,
      ratingCount: ratingAgg._count.rating,
      priceMin: priceAgg._min.price ? Number(priceAgg._min.price) : null,
      priceMax: priceAgg._max.price ? Number(priceAgg._max.price) : null,
    };
  }
}

/** Lowercase, ASCII-hyphenated slug from a shop name — "Fresh Cuts & Co." -> "fresh-cuts-co". */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'shop'
  );
}
