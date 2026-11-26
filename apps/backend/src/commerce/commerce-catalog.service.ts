import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  effectivePrice,
  expandShopQuery,
  matchZone,
  paise,
  type CommerceAvailability,
  type CommerceConfigDto,
  type CommerceHomeDto,
  type CommercePageDto,
  type CommerceProductDto,
  type CommerceProductsQuery,
  type CommerceServiceabilityDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceStockService } from './commerce-stock.service';
import {
  FASTQUE_SELLER_CODE,
  flag,
  money,
  notFound,
  type Db,
} from './commerce-support';

export const listingInclude = {
  seller: true,
  globalProduct: {
    select: {
      id: true,
      name: true,
      brand: true,
      category: true,
      description: true,
      variantText: true,
      hsnCode: true,
      gstRatePercent: true,
      verificationStatus: true,
      visibility: true,
      isTestData: true,
      barcodes: { select: { display: true }, take: 1 },
      images: {
        select: { url: true },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
    },
  },
} satisfies Prisma.CommerceListingInclude;
export type ListingRow = Prisma.CommerceListingGetPayload<{
  include: typeof listingInclude;
}>;

/** What a customer may see: FastQue's active listings of verified, real (non-test) catalog products. */
export const PUBLIC_LISTING: Prisma.CommerceListingWhereInput = {
  status: 'ACTIVE',
  seller: { code: FASTQUE_SELLER_CODE, isActive: true },
  globalProduct: {
    verificationStatus: 'VERIFIED',
    visibility: 'GLOBAL',
    isTestData: false,
  },
};
/** Category rule and product rule together: the stricter one applies. */
export type ReturnRules = Map<
  string,
  { returnable: boolean; windowDays: number }
>;
export async function returnRules(db: Db): Promise<ReturnRules> {
  const rows = await db.commerceReturnPolicy.findMany();
  return new Map(rows.map((r) => [r.category.toLowerCase(), r]));
}
export const returnRule = (
  l: {
    returnable: boolean;
    returnWindowDays: number;
    globalProduct: { category: string | null };
  },
  rules: ReturnRules,
) => {
  const p = rules.get(l.globalProduct.category?.toLowerCase() ?? '');
  return {
    returnable: l.returnable && (p?.returnable ?? true),
    returnWindowDays: Math.min(
      l.returnWindowDays,
      p?.windowDays ?? l.returnWindowDays,
    ),
  };
};

export const isSellable = (l: ListingRow) =>
  l.status === 'ACTIVE' &&
  l.seller.isActive &&
  l.seller.code === FASTQUE_SELLER_CODE &&
  l.globalProduct.verificationStatus === 'VERIFIED' &&
  l.globalProduct.visibility === 'GLOBAL' &&
  !l.globalProduct.isTestData;

export const priceNow = (
  l: {
    price: Prisma.Decimal;
    promoPrice: Prisma.Decimal | null;
    promoStartsAt: Date | null;
    promoEndsAt: Date | null;
  },
  now = new Date(),
) =>
  effectivePrice(
    {
      price: l.price.toFixed(2),
      promoPrice: l.promoPrice?.toFixed(2) ?? null,
      promoStartsAt: l.promoStartsAt,
      promoEndsAt: l.promoEndsAt,
    },
    now,
  );

/** Just enough to filter and rank; full rows are loaded only for the products shown. */
const rankSelect = {
  id: true,
  price: true,
  mrp: true,
  promoPrice: true,
  promoStartsAt: true,
  promoEndsAt: true,
} satisfies Prisma.CommerceListingSelect;

@Injectable()
export class CommerceCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: CommerceStockService,
  ) {}

  /** Always answers, so the website can hide everything when the feature is off. */
  async config(): Promise<CommerceConfigDto> {
    const enabled = flag('FASTQUE_DIRECT_COMMERCE_ENABLED');
    const s = enabled
      ? await this.prisma.commerceSeller.findUnique({
          where: { code: FASTQUE_SELLER_CODE },
        })
      : null;
    return {
      enabled,
      multiSellerCart: flag('MULTI_SELLER_CART_ENABLED'),
      cod: flag('FASTQUE_COD_ENABLED'),
      delivery: flag('FASTQUE_DELIVERY_ENABLED'),
      returns: flag('FASTQUE_RETURNS_ENABLED'),
      insights: flag('FASTQUE_COMMERCE_AI_ENABLED'),
      seller: s
        ? {
            name: s.displayName,
            supportEmail: s.supportEmail,
            supportPhone: s.supportPhone,
            legalName: s.legalName,
            gstin: s.gstin,
            address: s.address,
            grievance: s.grievance,
            returnPolicy: s.returnPolicy,
          }
        : null,
    };
  }

  toDto(
    l: ListingRow,
    available: number,
    extra?: {
      rules: ReturnRules;
      ratings: Map<string, { average: number; count: number }>;
    },
  ): CommerceProductDto {
    const price = priceNow(l);
    const mrp = l.mrp.toFixed(2);
    const availability: CommerceAvailability =
      available <= 0
        ? 'OUT_OF_STOCK'
        : available <= 3
          ? 'LOW_STOCK'
          : 'IN_STOCK';
    const off = Math.round((1 - paise(price) / paise(mrp)) * 100);
    const image = l.globalProduct.images[0]?.url ?? null;
    return {
      listingId: l.id,
      productId: l.globalProductId,
      name: l.globalProduct.name,
      brand: l.globalProduct.brand,
      category: l.globalProduct.category,
      variant: l.globalProduct.variantText,
      description: l.globalProduct.description,
      imageUrl: image?.startsWith('https://') ? image : null,
      sellerName: l.seller.displayName,
      mrp,
      price,
      discountPercent: off > 0 ? off : null,
      availability,
      // The exact count stays internal; the customer only needs to know what one order may contain.
      availableQuantity: Math.min(available, l.maxPerOrder),
      maxPerOrder: l.maxPerOrder,
      codEligible: l.codEligible,
      ...returnRule(l, extra?.rules ?? new Map<string, never>()),
      ...(extra?.ratings.has(l.id) ? { rating: extra.ratings.get(l.id)! } : {}),
    };
  }

  private async extras(ids: string[]) {
    const rules = await returnRules(this.prisma);
    const rows = await this.prisma.commerceReview.groupBy({
      by: ['listingId'],
      where: { listingId: { in: ids }, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: true,
    });
    return {
      rules,
      ratings: new Map(
        rows.map((r) => [
          r.listingId,
          {
            average: Math.round((r._avg.rating ?? 0) * 10) / 10,
            count: r._count,
          },
        ]),
      ),
    };
  }

  /** Public products by id, in the order asked for. */
  async byListingIds(ids: string[]): Promise<CommerceProductDto[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.commerceListing.findMany({
      where: { AND: [PUBLIC_LISTING, { id: { in: ids } }] },
      include: listingInclude,
    });
    const items = await this.withStock(rows);
    return ids.flatMap((id) => items.find((i) => i.listingId === id) ?? []);
  }
  async inCategories(
    categories: string[],
    exclude: string[],
  ): Promise<CommerceProductDto[]> {
    if (!categories.length) return [];
    const rows = await this.prisma.commerceListing.findMany({
      where: {
        AND: [
          PUBLIC_LISTING,
          {
            id: { notIn: exclude },
            globalProduct: { category: { in: categories } },
          },
        ],
      },
      include: listingInclude,
      orderBy: { createdAt: 'desc' },
      take: 24,
    });
    return (await this.withStock(rows))
      .filter((i) => i.availability !== 'OUT_OF_STOCK')
      .slice(0, 8);
  }

  private async withStock(rows: ListingRow[]): Promise<CommerceProductDto[]> {
    const available = await this.stock.available(
      this.prisma,
      rows.map((r) => r.id),
    );
    const extra = await this.extras(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, available.get(r.id) ?? 0, extra));
  }

  async search(
    q: CommerceProductsQuery,
  ): Promise<CommercePageDto<CommerceProductDto>> {
    const now = new Date();
    const groups = q.q ? expandShopQuery(q.q) : [];
    const digits = q.q?.replace(/[\s-]/g, '') ?? '';
    const product: Prisma.GlobalProductWhereInput =
      digits && /^\d{8,14}$/.test(digits)
        ? {
            barcodes: {
              some: { code: { in: [digits, digits.padStart(14, '0')] } },
            },
          }
        : {
            AND: groups.map((words) => ({
              OR: words.flatMap((w) => [
                { name: { contains: w, mode: 'insensitive' as const } },
                { brand: { contains: w, mode: 'insensitive' as const } },
                { category: { contains: w, mode: 'insensitive' as const } },
                { subcategory: { contains: w, mode: 'insensitive' as const } },
              ]),
            })),
          };
    const promoNow: Prisma.CommerceListingWhereInput = {
      promoPrice: { not: null },
      AND: [
        { OR: [{ promoStartsAt: null }, { promoStartsAt: { lte: now } }] },
        { OR: [{ promoEndsAt: null }, { promoEndsAt: { gt: now } }] },
      ],
    };
    const rows = await this.prisma.commerceListing.findMany({
      where: {
        AND: [
          PUBLIC_LISTING,
          {
            globalProduct: {
              AND: [
                product,
                q.brand
                  ? { brand: { equals: q.brand, mode: 'insensitive' } }
                  : {},
                q.category
                  ? { category: { equals: q.category, mode: 'insensitive' } }
                  : {},
              ],
            },
          },
          q.onSale
            ? {
                OR: [
                  promoNow,
                  {
                    price: { lt: this.prisma.commerceListing.fields.mrp },
                  },
                ],
              }
            : {},
        ],
      },
      select: rankSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 5000,
    });
    const available = await this.stock.available(
      this.prisma,
      rows.map((r) => r.id),
    );
    const sold =
      q.sort === 'popular' ? await this.unitsSold() : new Map<string, number>();
    const list = rows
      .map((row) => ({
        row,
        price: paise(priceNow(row, now)),
        stock: available.get(row.id) ?? 0,
      }))
      .filter(
        (x) =>
          (q.minPrice == null || x.price >= q.minPrice * 100) &&
          (q.maxPrice == null || x.price <= q.maxPrice * 100) &&
          (!q.availableOnly || x.stock > 0),
      );
    if (q.sort === 'price_asc') list.sort((a, b) => a.price - b.price);
    else if (q.sort === 'price_desc') list.sort((a, b) => b.price - a.price);
    else if (q.sort === 'popular')
      list.sort(
        (a, b) => (sold.get(b.row.id) ?? 0) - (sold.get(a.row.id) ?? 0),
      );
    else if (q.sort === 'relevance')
      list.sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0));
    const start = (q.page - 1) * q.limit;
    const page = list.slice(start, start + q.limit);
    return {
      items: await this.byListingIds(page.map((x) => x.row.id)),
      total: list.length,
      page: q.page,
      pageSize: q.limit,
    };
  }

  /** Units delivered or on the way in the last 90 days — real orders only. */
  private async unitsSold(): Promise<Map<string, number>> {
    const rows = await this.prisma.commerceOrderItem.groupBy({
      by: ['listingId'],
      where: {
        order: {
          status: { notIn: ['CANCELLED', 'RETURNED', 'RETURN_TO_ORIGIN'] },
          placedAt: { gte: new Date(Date.now() - 90 * 86400_000) },
        },
      },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.listingId, r._sum.quantity ?? 0]));
  }

  async home(): Promise<CommerceHomeDto> {
    const rows = await this.prisma.commerceListing.findMany({
      where: PUBLIC_LISTING,
      select: {
        ...rankSelect,
        featured: true,
        globalProduct: { select: { category: true, brand: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const [available, sold] = await Promise.all([
      this.stock.available(
        this.prisma,
        rows.map((r) => r.id),
      ),
      this.unitsSold(),
    ]);
    const live = rows.filter((r) => (available.get(r.id) ?? 0) > 0);
    const off = (r: (typeof rows)[number]) =>
      Math.round((1 - paise(priceNow(r)) / paise(r.mrp.toFixed(2))) * 100);
    const known = new Set(rows.map((r) => r.id));
    const first = (list: Array<{ id: string }>) =>
      list.slice(0, 8).map((r) => r.id);
    const featured = first(rows.filter((r) => r.featured));
    const best = [...sold]
      .filter(([id]) => known.has(id))
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([id]) => id);
    const fresh = first(live);
    const offers = first(
      live
        .map((r) => ({ id: r.id, off: off(r) }))
        .filter((r) => r.off > 0)
        .sort((x, y) => y.off - x.off),
    );
    const items = new Map(
      (
        await this.byListingIds([
          ...new Set([...featured, ...best, ...fresh, ...offers]),
        ])
      ).map((p) => [p.listingId, p]),
    );
    const pick = (ids: string[]) => ids.flatMap((id) => items.get(id) ?? []);
    const count = (key: 'category' | 'brand') => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const v = r.globalProduct[key];
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return [...m]
        .map(([name, products]) => ({ name, products }))
        .sort((x, y) => y.products - x.products)
        .slice(0, 24);
    };
    return {
      featured: pick(featured),
      bestSellers: pick(best),
      newArrivals: pick(fresh),
      offers: pick(offers),
      categories: count('category'),
      brands: count('brand'),
    };
  }

  /** FastQue's own offer for a catalog product, for the seller comparison; null when not sold. */
  async offer(globalProductId: string): Promise<CommerceProductDto | null> {
    const row = await this.prisma.commerceListing.findFirst({
      where: { AND: [PUBLIC_LISTING, { globalProductId }] },
      include: listingInclude,
    });
    return row ? (await this.withStock([row]))[0] : null;
  }

  async product(globalProductId: string): Promise<{
    product: CommerceProductDto;
    boughtTogether: CommerceProductDto[];
    related: CommerceProductDto[];
  }> {
    const product = await this.offer(globalProductId);
    if (!product) throw notFound('The product');
    // Real co-purchases only: products that shared at least two orders with this one.
    const pairs = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT b."listingId"::text AS id FROM "commerce_order_items" a
      JOIN "commerce_order_items" b ON b."orderId" = a."orderId" AND b."listingId" <> a."listingId"
      JOIN "commerce_orders" o ON o."id" = a."orderId" AND o."status" <> 'CANCELLED'
      WHERE a."listingId" = ${product.listingId}::uuid
      GROUP BY b."listingId" HAVING count(DISTINCT a."orderId") >= 2
      ORDER BY count(DISTINCT a."orderId") DESC LIMIT 4`);
    const rows = await this.prisma.commerceListing.findMany({
      where: {
        AND: [
          PUBLIC_LISTING,
          { id: { not: product.listingId } },
          {
            OR: [
              { id: { in: pairs.map((p) => p.id) } },
              ...(product.category
                ? [{ globalProduct: { category: product.category } }]
                : []),
            ],
          },
        ],
      },
      include: listingInclude,
      take: 12,
    });
    const items = await this.withStock(rows);
    const together = new Set(pairs.map((p) => p.id));
    return {
      product,
      boughtTogether: items.filter((i) => together.has(i.listingId)),
      related: items.filter((i) => !together.has(i.listingId)).slice(0, 8),
    };
  }

  async zoneFor(pin: string, db: Db = this.prisma) {
    const zones = await db.commerceZone.findMany({
      where: { isActive: true, warehouse: { isActive: true } },
    });
    return matchZone(pin, zones);
  }

  async serviceability(
    pin: string,
    db: Db = this.prisma,
  ): Promise<CommerceServiceabilityDto> {
    const zone = flag('FASTQUE_DELIVERY_ENABLED')
      ? await this.zoneFor(pin, db)
      : null;
    if (!zone)
      return {
        pincode: pin,
        serviceable: false,
        deliveryCharge: null,
        freeAbove: null,
        minDays: null,
        maxDays: null,
        cod: false,
        message: 'FastQue does not deliver to this PIN code yet.',
      };
    const cod = zone.codEligible && flag('FASTQUE_COD_ENABLED');
    return {
      pincode: pin,
      serviceable: true,
      deliveryCharge: money(zone.deliveryCharge),
      freeAbove: zone.freeAbove ? money(zone.freeAbove) : null,
      minDays: zone.minDays,
      maxDays: zone.maxDays,
      cod,
      message: `Delivery in ${zone.minDays === zone.maxDays ? zone.maxDays : `${zone.minDays}–${zone.maxDays}`} days${cod ? ' · Cash on Delivery available' : ''}.`,
    };
  }

  async sitemapIds(): Promise<string[]> {
    const rows = await this.prisma.commerceListing.findMany({
      where: PUBLIC_LISTING,
      select: { globalProductId: true },
      take: 5000,
    });
    return rows.map((r) => r.globalProductId);
  }
}
