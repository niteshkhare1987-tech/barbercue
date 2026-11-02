import { createHash } from 'crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CommerceErrorCode,
  ORDER_ACCEPT_HOURS,
  PICKUP_DAYS,
  RETURN_DAYS,
  canTransition,
  listingProblems,
  newPickupCode,
  type CompletePickupInput,
  type CreateListingInput,
  type ListingChannel,
  type ListingDto,
  type MarketOrderDto,
  type MarketOrderStatus,
  type PlaceMarketOrderInput,
  type ShopProductDetailDto,
  type ShopProductDto,
  type ShopProductQuery,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { DbDeadlineSchedulerService } from '../common/db-deadline-scheduler/db-deadline-scheduler.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMMERCE_TX,
  ensureSalonProduct,
  money,
  orderNumber,
  piecesToStock,
  writeMovement,
} from './commerce-ledger';

type Tx = Prisma.TransactionClient;
type Actor = 'BUYER' | 'SELLER' | 'SYSTEM' | 'ADMIN';

export const listingInclude = {
  salon: {
    select: { name: true, status: true, city: { select: { name: true } } },
  },
  inventoryProduct: {
    select: {
      globalProductId: true,
      globalProduct: {
        select: { brand: true, category: true, mrp: true, currency: true },
      },
    },
  },
} satisfies Prisma.MarketListingInclude;
type ListingRow = Prisma.MarketListingGetPayload<{
  include: typeof listingInclude;
}>;

export function toListingDto(l: ListingRow): ListingDto {
  return {
    id: l.id,
    channel: l.channel,
    status: l.status,
    salonId: l.salonId,
    salonName: l.salon.name,
    cityName: l.salon.city?.name ?? null,
    inventoryProductId: l.inventoryProductId,
    globalProductId: l.inventoryProduct.globalProductId,
    title: l.title,
    brand: l.inventoryProduct.globalProduct?.brand ?? null,
    category: l.inventoryProduct.globalProduct?.category ?? null,
    unitPrice: money(l.unitPrice),
    mrp: l.inventoryProduct.globalProduct?.mrp
      ? money(l.inventoryProduct.globalProduct.mrp)
      : null,
    currency: l.inventoryProduct.globalProduct?.currency ?? 'INR',
    quantityListed: l.quantityListed,
    quantityReserved: l.quantityReserved,
    quantitySold: l.quantitySold,
    available: l.quantityListed - l.quantityReserved - l.quantitySold,
    batchNumber: l.batchNumber,
    expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null,
    photoUrls: l.photoUrls,
    description: l.description,
    reviewNote: l.reviewNote,
    createdAt: l.createdAt.toISOString(),
  };
}

export const orderInclude = {
  sellerSalon: {
    select: {
      name: true,
      addressLine: true,
      phone: true,
      city: { select: { name: true } },
      paymentPolicy: { select: { paymentQrImageUrl: true } },
    },
  },
  buyerSalon: { select: { name: true } },
  items: {
    include: {
      listing: {
        select: {
          photoUrls: true,
          inventoryProductId: true,
          inventoryProduct: { select: { globalProductId: true, unit: true } },
        },
      },
    },
  },
} satisfies Prisma.MarketOrderInclude;
type OrderRow = Prisma.MarketOrderGetPayload<{ include: typeof orderInclude }>;

export function toOrderDto(
  o: OrderRow,
  viewer: 'BUYER' | 'SELLER' | 'ADMIN',
): MarketOrderDto {
  return {
    id: o.id,
    number: o.number,
    channel: o.channel,
    status: o.status,
    seller: {
      salonId: o.sellerSalonId,
      name: o.sellerSalon.name,
      address: o.sellerSalon.addressLine,
      cityName: o.sellerSalon.city?.name ?? null,
      phone: o.sellerSalon.phone,
    },
    buyer: { salonId: o.buyerSalonId, name: o.buyerSalon?.name ?? null },
    items: o.items.map((i) => ({
      listingId: i.listingId,
      title: i.title,
      quantity: i.quantity,
      unitPrice: money(i.unitPrice),
      imageUrl: i.listing.photoUrls[0] ?? null,
    })),
    total: money(o.total),
    currency: o.currency,
    paymentMethod: o.paymentMethod,
    paid: !!o.paidAt,
    // Only the customer who ordered sees the code; the seller must be told it at pickup.
    pickupCode: viewer === 'BUYER' ? o.pickupCode : null,
    upiQrImageUrl:
      o.paymentMethod === 'UPI_TO_SALON'
        ? (o.sellerSalon.paymentPolicy?.paymentQrImageUrl ?? null)
        : null,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    note: o.note,
    cancelReason: o.cancelReason,
    returnReason: o.returnReason,
    disputeReason: o.disputeReason,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

const err = (code: string, message: string, status = HttpStatus.CONFLICT) =>
  new AppException(code, message, status);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/**
 * Inventory Phases 4–5 — selling stock a salon holds: to other salons (SALON) and to customers for
 * pickup (CUSTOMER). Listings are checked for eligibility and go live only after FastQue admin
 * approval. Ordering reserves listed quantity under a row lock, so nothing is oversold; the
 * seller's stock is deducted exactly once (on dispatch / on pickup) and a buying salon's stock goes
 * up when it confirms receipt. Orders not accepted in 48 h, or not collected in 7 days, expire and
 * release their reservation. Payment is settled at the salon or on invoice — never through FastQue.
 */
@Injectable()
export class MarketplaceService implements OnModuleInit {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly scheduler?: DbDeadlineSchedulerService,
  ) {}

  onModuleInit(): void {
    this.scheduler?.register({
      name: 'marketplace-order-expiry',
      domain: 'inventory',
      nextDueAt: async () =>
        (
          await this.prisma.marketOrder.findFirst({
            where: {
              status: { in: ['PLACED', 'READY_FOR_PICKUP'] },
              expiresAt: { not: null },
            },
            orderBy: { expiresAt: 'asc' },
            select: { expiresAt: true },
          })
        )?.expiresAt ?? null,
      runDue: () => this.expireDue().then(() => undefined),
    });
  }

  // ---------- Listings (seller) ----------

  async createListing(
    userId: string,
    salonId: string,
    input: CreateListingInput,
  ): Promise<ListingDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const product = await this.prisma.inventoryProduct.findFirst({
      where: { id: input.inventoryProductId, salonId },
      select: {
        id: true,
        name: true,
        isActive: true,
        stockOnHand: true,
        unit: true,
        globalProductId: true,
        globalProduct: {
          select: { name: true, verificationStatus: true, productType: true },
        },
      },
    });
    if (!product)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'Product not found.',
        HttpStatus.NOT_FOUND,
      );
    const open = await this.prisma.marketListing.findMany({
      where: {
        inventoryProductId: product.id,
        status: { in: ['PENDING_REVIEW', 'ACTIVE', 'PAUSED'] },
      },
      select: { quantityListed: true, quantitySold: true },
    });
    // Listings are in whole pieces; stock may be counted in ml/g (one piece = one catalog pack).
    let piecesInStock = 0;
    try {
      const perPiece = await piecesToStock(
        this.prisma,
        1,
        { unit: product.unit },
        product.globalProductId,
      );
      piecesInStock = Math.floor(
        Number(product.stockOnHand) / Number(perPiece) + 1e-9,
      );
    } catch {
      piecesInStock = 0;
    }
    const problems = listingProblems({
      channel: input.channel,
      quantity: input.quantity,
      stockOnHand: piecesInStock,
      alreadyListed: open.reduce(
        (a, l) => a + l.quantityListed - l.quantitySold,
        0,
      ),
      productActive: product.isActive,
      catalogVerified: product.globalProduct?.verificationStatus === 'VERIFIED',
      productType: product.globalProduct?.productType ?? null,
      sealed: input.sealed,
      photoCount: input.photoUrls.length,
      expiryDate: input.expiryDate ?? null,
      today: today(),
      hasProvenance: !!(input.invoiceUrl || input.provenanceNote?.trim()),
    });
    if (problems.length)
      throw err(
        CommerceErrorCode.LISTING_NOT_ELIGIBLE,
        problems.join(' '),
        HttpStatus.BAD_REQUEST,
      );
    const listing = await this.prisma.$transaction(async (tx) => {
      const l = await tx.marketListing.create({
        data: {
          salonId,
          inventoryProductId: product.id,
          channel: input.channel,
          title: (product.globalProduct?.name ?? product.name).slice(0, 160),
          unitPrice: new Prisma.Decimal(input.unitPrice),
          quantityListed: input.quantity,
          batchNumber: input.batchNumber?.trim() || null,
          expiryDate: input.expiryDate
            ? new Date(`${input.expiryDate}T00:00:00.000Z`)
            : null,
          sealed: true,
          photoUrls: input.photoUrls,
          invoiceUrl: input.invoiceUrl ?? null,
          provenanceNote: input.provenanceNote?.trim() || null,
          description: input.description?.trim() || null,
          createdByUserId: userId,
        },
        include: listingInclude,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'MARKET_LISTING_SUBMITTED',
          entityType: 'MarketListing',
          entityId: l.id,
          metadata: { salonId, channel: l.channel, quantity: l.quantityListed },
        },
      });
      return l;
    });
    return toListingDto(listing);
  }

  async myListings(userId: string, salonId: string): Promise<ListingDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const rows = await this.prisma.marketListing.findMany({
      where: { salonId },
      include: listingInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toListingDto);
  }

  async setListingStatus(
    userId: string,
    salonId: string,
    id: string,
    action: 'pause' | 'resume' | 'end',
  ): Promise<ListingDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const from =
      action === 'pause'
        ? ['ACTIVE']
        : action === 'resume'
          ? ['PAUSED']
          : ['PENDING_REVIEW', 'ACTIVE', 'PAUSED'];
    const to =
      action === 'pause' ? 'PAUSED' : action === 'resume' ? 'ACTIVE' : 'ENDED';
    const { count } = await this.prisma.marketListing.updateMany({
      where: { id, salonId, status: { in: from as never } },
      data: { status: to },
    });
    if (!count)
      throw err(
        CommerceErrorCode.LISTING_UNAVAILABLE,
        `This listing can't be ${action === 'end' ? 'ended' : action + 'd'} now.`,
      );
    return toListingDto(
      await this.prisma.marketListing.findUniqueOrThrow({
        where: { id },
        include: listingInclude,
      }),
    );
  }

  // ---------- Browsing ----------

  /** Other salons' approved B2B listings, for a salon buying. */
  async salonMarket(
    userId: string,
    salonId: string,
    q?: string,
  ): Promise<ListingDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const rows = await this.prisma.marketListing.findMany({
      where: {
        channel: 'SALON',
        status: 'ACTIVE',
        salonId: { not: salonId },
        salon: { status: 'ACTIVE' },
        ...(q?.trim()
          ? { title: { contains: q.trim(), mode: 'insensitive' } }
          : {}),
      },
      include: listingInclude,
      orderBy: { unitPrice: 'asc' },
      take: 100,
    });
    return rows.map(toListingDto).filter((l) => l.available > 0);
  }

  private customerListingWhere(query: {
    q?: string;
    category?: string;
    brand?: string;
    cityId?: string;
  }): Prisma.MarketListingWhereInput {
    const term = query.q?.trim();
    return {
      channel: 'CUSTOMER',
      status: 'ACTIVE',
      salon: {
        status: 'ACTIVE',
        ...(query.cityId ? { cityId: query.cityId } : {}),
      },
      inventoryProduct: {
        globalProduct: {
          verificationStatus: 'VERIFIED',
          ...(query.category
            ? { category: { equals: query.category, mode: 'insensitive' } }
            : {}),
          ...(query.brand
            ? { brand: { equals: query.brand, mode: 'insensitive' } }
            : {}),
        },
      },
      ...(term
        ? {
            OR: [
              { title: { contains: term, mode: 'insensitive' } },
              {
                inventoryProduct: {
                  globalProduct: {
                    brand: { contains: term, mode: 'insensitive' },
                  },
                },
              },
            ],
          }
        : {}),
    };
  }

  /** Customer shop: one card per product with the lowest price across salons. Public. */
  async shopProducts(query: ShopProductQuery): Promise<{
    items: ShopProductDto[];
    categories: string[];
    brands: string[];
  }> {
    const rows = await this.prisma.marketListing.findMany({
      where: this.customerListingWhere(query),
      include: {
        ...listingInclude,
        inventoryProduct: {
          select: {
            globalProductId: true,
            globalProduct: {
              select: {
                name: true,
                brand: true,
                category: true,
                mrp: true,
                currency: true,
                images: {
                  take: 1,
                  orderBy: { sortOrder: 'asc' },
                  select: { url: true },
                },
              },
            },
          },
        },
      },
      take: 1000,
    });
    const byProduct = new Map<string, ShopProductDto>();
    for (const l of rows) {
      const g = l.inventoryProduct.globalProduct;
      const available = l.quantityListed - l.quantityReserved - l.quantitySold;
      if (!g || !l.inventoryProduct.globalProductId || available <= 0) continue;
      const id = l.inventoryProduct.globalProductId;
      const cur = byProduct.get(id);
      if (!cur)
        byProduct.set(id, {
          globalProductId: id,
          name: g.name,
          brand: g.brand,
          category: g.category,
          imageUrl: g.images[0]?.url ?? l.photoUrls[0] ?? null,
          mrp: g.mrp ? money(g.mrp) : null,
          lowestPrice: money(l.unitPrice),
          sellerCount: 1,
          currency: g.currency ?? 'INR',
        });
      else {
        cur.sellerCount += 1;
        if (l.unitPrice.lessThan(cur.lowestPrice))
          cur.lowestPrice = money(l.unitPrice);
      }
    }
    const items = [...byProduct.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, query.limit);
    const all = [...byProduct.values()];
    return {
      items,
      categories: [
        ...new Set(all.map((p) => p.category).filter((c): c is string => !!c)),
      ].sort(),
      brands: [
        ...new Set(all.map((p) => p.brand).filter((b): b is string => !!b)),
      ].sort(),
    };
  }

  async shopProduct(
    globalProductId: string,
    cityId?: string,
  ): Promise<ShopProductDetailDto> {
    const g = await this.prisma.globalProduct.findFirst({
      where: { id: globalProductId, verificationStatus: 'VERIFIED' },
      select: {
        name: true,
        brand: true,
        category: true,
        description: true,
        packSize: true,
        packUnit: true,
        mrp: true,
        currency: true,
        images: {
          take: 1,
          orderBy: { sortOrder: 'asc' },
          select: { url: true },
        },
      },
    });
    if (!g)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'Product not found.',
        HttpStatus.NOT_FOUND,
      );
    const rows = await this.prisma.marketListing.findMany({
      where: {
        ...this.customerListingWhere({ cityId }),
        inventoryProduct: { globalProductId },
      },
      include: listingInclude,
      orderBy: { unitPrice: 'asc' },
    });
    const offers = rows.map(toListingDto).filter((l) => l.available > 0);
    if (!offers.length)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'No salon is selling this product right now.',
        HttpStatus.NOT_FOUND,
      );
    return {
      globalProductId,
      name: g.name,
      brand: g.brand,
      category: g.category,
      imageUrl: g.images[0]?.url ?? offers[0].photoUrls[0] ?? null,
      mrp: g.mrp ? money(g.mrp) : null,
      lowestPrice: offers[0].unitPrice,
      sellerCount: new Set(offers.map((o) => o.salonId)).size,
      currency: g.currency ?? 'INR',
      description: g.description,
      packSize: g.packSize?.toFixed(3) ?? null,
      packUnit: g.packUnit,
      offers,
    };
  }

  // ---------- Placing orders ----------

  /** Customer checkout: one order per selling salon, each a pickup there. */
  async placeCustomerOrders(
    userId: string,
    idempotencyKey: string | undefined,
    input: PlaceMarketOrderInput,
  ): Promise<MarketOrderDto[]> {
    if (input.paymentMethod === 'INVOICE')
      throw err(
        CommerceErrorCode.ORDER_TRANSITION,
        'Choose pay at pickup or UPI to the salon.',
        HttpStatus.BAD_REQUEST,
      );
    return this.place(userId, null, 'CUSTOMER', idempotencyKey, input);
  }

  /** A salon buying another salon's listed stock (settled on the seller's invoice). */
  async placeSalonOrder(
    userId: string,
    buyerSalonId: string,
    idempotencyKey: string | undefined,
    input: PlaceMarketOrderInput,
  ): Promise<MarketOrderDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, buyerSalonId);
    return this.place(userId, buyerSalonId, 'SALON', idempotencyKey, {
      ...input,
      paymentMethod: 'INVOICE',
    });
  }

  private async place(
    userId: string,
    buyerSalonId: string | null,
    channel: ListingChannel,
    idempotencyKey: string | undefined,
    input: PlaceMarketOrderInput,
  ): Promise<MarketOrderDto[]> {
    const key = idempotencyKey?.trim();
    if (!key)
      throw err(
        CommerceErrorCode.ORDER_TRANSITION,
        'An Idempotency-Key header is required.',
        HttpStatus.BAD_REQUEST,
      );
    const listings = await this.prisma.marketListing.findMany({
      where: { id: { in: input.items.map((i) => i.listingId) } },
      select: { id: true, salonId: true },
    });
    const sellers = [...new Set(listings.map((l) => l.salonId))];
    if (listings.length !== new Set(input.items.map((i) => i.listingId)).size)
      throw err(
        CommerceErrorCode.LISTING_UNAVAILABLE,
        'One of the items is no longer available.',
      );
    const out: MarketOrderDto[] = [];
    for (const sellerSalonId of sellers) {
      if (sellerSalonId === buyerSalonId)
        throw err(
          CommerceErrorCode.OWN_LISTING,
          "You can't buy your own shop's stock.",
          HttpStatus.BAD_REQUEST,
        );
      const items = input.items.filter(
        (i) =>
          listings.find((l) => l.id === i.listingId)!.salonId === sellerSalonId,
      );
      const orderKey = `${key}:${sellerSalonId}`.slice(0, 128);
      const existing = await this.prisma.marketOrder.findUnique({
        where: {
          buyerUserId_idempotencyKey: {
            buyerUserId: userId,
            idempotencyKey: orderKey,
          },
        },
        include: orderInclude,
      });
      if (existing) {
        out.push(toOrderDto(existing, 'BUYER'));
        continue;
      }
      if (input.paymentMethod === 'UPI_TO_SALON') {
        const policy = await this.prisma.salonPaymentPolicy.findUnique({
          where: { salonId: sellerSalonId },
          select: { paymentQrImageUrl: true },
        });
        if (!policy?.paymentQrImageUrl)
          throw err(
            CommerceErrorCode.ORDER_TRANSITION,
            "This salon doesn't take UPI orders yet. Choose pay at pickup.",
            HttpStatus.BAD_REQUEST,
          );
      }
      const order = await this.prisma.$transaction(async (tx) => {
        const ids = items.map((i) => i.listingId).sort();
        const locked = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            channel: string;
            title: string;
            unitPrice: Prisma.Decimal;
            quantityListed: number;
            quantityReserved: number;
            quantitySold: number;
          }>
        >(
          Prisma.sql`SELECT "id", "status", "channel", "title", "unitPrice", "quantityListed", "quantityReserved", "quantitySold"
            FROM "market_listings" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
        );
        let total = new Prisma.Decimal(0);
        for (const i of items) {
          const l = locked.find((x) => x.id === i.listingId)!;
          if (l.status !== 'ACTIVE' || l.channel !== channel)
            throw err(
              CommerceErrorCode.LISTING_UNAVAILABLE,
              `${l.title} is no longer available.`,
            );
          const available =
            l.quantityListed - l.quantityReserved - l.quantitySold;
          if (i.quantity > available)
            throw err(
              CommerceErrorCode.NOT_ENOUGH_AVAILABLE,
              `Only ${available} of ${l.title} left.`,
            );
          await tx.marketListing.update({
            where: { id: l.id },
            data: { quantityReserved: { increment: i.quantity } },
          });
          total = total.plus(l.unitPrice.times(i.quantity));
        }
        const created = await tx.marketOrder.create({
          data: {
            number: orderNumber(),
            channel,
            sellerSalonId,
            buyerUserId: userId,
            buyerSalonId,
            total,
            currency: 'INR',
            paymentMethod: input.paymentMethod,
            pickupCode: channel === 'CUSTOMER' ? newPickupCode() : null,
            idempotencyKey: orderKey,
            note: input.note?.trim() || null,
            expiresAt: new Date(Date.now() + ORDER_ACCEPT_HOURS * 3600_000),
            items: {
              create: items.map((i) => {
                const l = locked.find((x) => x.id === i.listingId)!;
                return {
                  listingId: l.id,
                  title: l.title,
                  quantity: i.quantity,
                  unitPrice: l.unitPrice,
                };
              }),
            },
          },
          include: orderInclude,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'MARKET_ORDER_PLACED',
            entityType: 'MarketOrder',
            entityId: created.id,
            metadata: {
              channel,
              sellerSalonId,
              buyerSalonId,
              total: total.toFixed(2),
            },
          },
        });
        return created;
      }, COMMERCE_TX);
      this.scheduler?.signal('inventory');
      await this.notifyOwners(
        sellerSalonId,
        {
          orderId: order.id,
          number: order.number,
          status: 'PLACED',
          role: 'seller',
        },
        `dashboard/salons/${sellerSalonId}/inventory/orders`,
      );
      out.push(toOrderDto(order, 'BUYER'));
    }
    return out;
  }

  // ---------- Lists ----------

  async sellerOrders(
    userId: string,
    salonId: string,
  ): Promise<MarketOrderDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const rows = await this.prisma.marketOrder.findMany({
      where: { sellerSalonId: salonId },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((o) => toOrderDto(o, 'SELLER'));
  }

  async salonPurchases(
    userId: string,
    salonId: string,
  ): Promise<MarketOrderDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const rows = await this.prisma.marketOrder.findMany({
      where: { buyerSalonId: salonId },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((o) => toOrderDto(o, 'BUYER'));
  }

  async customerOrders(userId: string): Promise<MarketOrderDto[]> {
    const rows = await this.prisma.marketOrder.findMany({
      where: { buyerUserId: userId, channel: 'CUSTOMER' },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((o) => toOrderDto(o, 'BUYER'));
  }

  // ---------- Transitions ----------

  private async load(id: string): Promise<OrderRow> {
    const o = await this.prisma.marketOrder.findUnique({
      where: { id },
      include: orderInclude,
    });
    if (!o)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'Order not found.',
        HttpStatus.NOT_FOUND,
      );
    return o;
  }

  private async sellerOrder(
    userId: string,
    salonId: string,
    id: string,
  ): Promise<OrderRow> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const o = await this.load(id);
    if (o.sellerSalonId !== salonId)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'Order not found.',
        HttpStatus.NOT_FOUND,
      );
    return o;
  }

  private async buyerOrder(
    userId: string,
    id: string,
    buyerSalonId?: string,
  ): Promise<OrderRow> {
    if (buyerSalonId)
      await this.salonAccess.assertOwnerOrAdminAccess(userId, buyerSalonId);
    const o = await this.load(id);
    const mine = buyerSalonId
      ? o.buyerSalonId === buyerSalonId
      : o.buyerUserId === userId && o.channel === 'CUSTOMER';
    if (!mine)
      throw err(
        CommerceErrorCode.NOT_FOUND,
        'Order not found.',
        HttpStatus.NOT_FOUND,
      );
    return o;
  }

  /**
   * Moves an order from its current status to `to` (if that actor may), applying `effect` inside
   * the same transaction. The status guard in the UPDATE makes concurrent moves safe: only one wins.
   */
  private async transition(
    o: OrderRow,
    to: MarketOrderStatus,
    by: Actor,
    actorUserId: string,
    data: Prisma.MarketOrderUpdateManyMutationInput,
    effect?: (tx: Tx) => Promise<void>,
  ): Promise<OrderRow> {
    if (!canTransition(o.status, to, by, o.channel))
      throw err(
        CommerceErrorCode.ORDER_TRANSITION,
        `This order is ${o.status.toLowerCase().replace(/_/g, ' ')} and can't become ${to.toLowerCase().replace(/_/g, ' ')}.`,
      );
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.marketOrder.updateMany({
        where: { id: o.id, status: o.status },
        data: { status: to, ...data },
      });
      if (!count)
        throw err(
          CommerceErrorCode.ORDER_TRANSITION,
          'This order just changed. Reload and try again.',
        );
      if (effect) await effect(tx);
      await tx.auditLog.create({
        data: {
          actorUserId: by === 'SYSTEM' ? null : actorUserId,
          action: `MARKET_ORDER_${to}`,
          entityType: 'MarketOrder',
          entityId: o.id,
          metadata: { from: o.status, by },
        },
      });
    }, COMMERCE_TX);
    const fresh = await this.load(o.id);
    await this.notifyStatus(fresh, by);
    return fresh;
  }

  /** Releases the reservation (cancel / expire). */
  private release(o: OrderRow) {
    return async (tx: Tx) => {
      for (const i of o.items)
        await tx.marketListing.update({
          where: { id: i.listingId },
          data: { quantityReserved: { decrement: i.quantity } },
        });
    };
  }

  /** Reserved → sold, and the seller's stock goes down — exactly once per item. */
  private fulfil(o: OrderRow, actorUserId: string) {
    return async (tx: Tx) => {
      for (const i of o.items) {
        const product = i.listing.inventoryProduct;
        const qty = await piecesToStock(
          tx,
          i.quantity,
          product,
          product.globalProductId,
        );
        const movementId = await writeMovement(tx, {
          salonId: o.sellerSalonId,
          productId: i.listing.inventoryProductId,
          actorUserId,
          kind: 'CONSUMPTION',
          quantityDelta: qty.negated(),
          reason: `Sold on order ${o.number}`,
          reference: `order:${o.number}`,
          key: `market-order:${o.id}:${i.id}:out`,
        });
        await tx.marketOrderItem.update({
          where: { id: i.id },
          data: { sellerMovementId: movementId },
        });
        await tx.marketListing.update({
          where: { id: i.listingId },
          data: {
            quantityReserved: { decrement: i.quantity },
            quantitySold: { increment: i.quantity },
          },
        });
      }
    };
  }

  /** A buying salon's stock goes up (on its own receipt confirmation, or an admin's resolution). */
  private receiveIntoBuyer(o: OrderRow, actorUserId: string) {
    return async (tx: Tx) => {
      for (const i of o.items) {
        const gid = i.listing.inventoryProduct.globalProductId;
        if (!gid || !o.buyerSalonId) continue;
        const product = await ensureSalonProduct(
          tx,
          o.buyerSalonId,
          gid,
          'PROFESSIONAL',
        );
        const qty = await piecesToStock(tx, i.quantity, product, gid);
        const movementId = await writeMovement(tx, {
          salonId: o.buyerSalonId,
          productId: product.id,
          actorUserId,
          kind: 'PURCHASE',
          quantityDelta: qty,
          unitCost: i.unitPrice
            .times(i.quantity)
            .dividedBy(qty)
            .toDecimalPlaces(2),
          reason: `Bought from ${o.sellerSalon.name} (order ${o.number})`,
          reference: `order:${o.number}`,
          key: `market-order:${o.id}:${i.id}:in`,
        });
        await tx.marketOrderItem.update({
          where: { id: i.id },
          data: { buyerMovementId: movementId },
        });
      }
    };
  }

  /** Stock back to the seller (approved return, or a cancelled dispute). */
  private restockSeller(o: OrderRow, actorUserId: string, why: string) {
    return async (tx: Tx) => {
      for (const i of o.items) {
        const product = i.listing.inventoryProduct;
        const qty = await piecesToStock(
          tx,
          i.quantity,
          product,
          product.globalProductId,
        );
        const movementId = await writeMovement(tx, {
          salonId: o.sellerSalonId,
          productId: i.listing.inventoryProductId,
          actorUserId,
          kind: 'ADJUSTMENT',
          quantityDelta: qty,
          reason: `${why} (order ${o.number})`,
          reference: `order:${o.number}`,
          key: `market-order:${o.id}:${i.id}:back`,
        });
        await tx.marketOrderItem.update({
          where: { id: i.id },
          data: { returnMovementId: movementId },
        });
      }
    };
  }

  async sellerAction(
    userId: string,
    salonId: string,
    id: string,
    action: 'accept' | 'ready' | 'dispatch' | 'cancel' | 'mark-paid',
    reason?: string,
  ): Promise<MarketOrderDto> {
    const o = await this.sellerOrder(userId, salonId, id);
    let row: OrderRow;
    if (action === 'accept')
      row = await this.transition(o, 'ACCEPTED', 'SELLER', userId, {
        acceptedAt: new Date(),
        expiresAt: null,
      });
    else if (action === 'ready')
      row = await this.transition(o, 'READY_FOR_PICKUP', 'SELLER', userId, {
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + PICKUP_DAYS * 864e5),
      });
    else if (action === 'dispatch')
      row = await this.transition(
        o,
        'DISPATCHED',
        'SELLER',
        userId,
        { dispatchedAt: new Date() },
        this.fulfil(o, userId),
      );
    else if (action === 'cancel') {
      if (!reason || reason.trim().length < 3)
        throw err(
          CommerceErrorCode.ORDER_TRANSITION,
          'Tell the buyer why.',
          HttpStatus.BAD_REQUEST,
        );
      row = await this.transition(
        o,
        'CANCELLED',
        'SELLER',
        userId,
        { cancelledAt: new Date(), cancelReason: reason.trim() },
        this.release(o),
      );
    } else {
      if (o.paidAt) return toOrderDto(o, 'SELLER');
      await this.prisma.marketOrder.update({
        where: { id },
        data: { paidAt: new Date() },
      });
      await this.prisma.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'MARKET_ORDER_MARKED_PAID',
          entityType: 'MarketOrder',
          entityId: id,
          metadata: { salonId },
        },
      });
      row = await this.load(id);
    }
    if (action !== 'mark-paid') this.scheduler?.signal('inventory');
    return toOrderDto(row, 'SELLER');
  }

  /** Customer pickup: the seller enters the code the customer shows; stock is deducted now. */
  async completePickup(
    userId: string,
    salonId: string,
    id: string,
    input: CompletePickupInput,
  ): Promise<MarketOrderDto> {
    const o = await this.sellerOrder(userId, salonId, id);
    const given = createHash('sha256').update(input.pickupCode).digest();
    const expected = createHash('sha256')
      .update(o.pickupCode ?? '')
      .digest();
    if (!o.pickupCode || !given.equals(expected))
      throw err(
        CommerceErrorCode.PICKUP_CODE,
        "That pickup code doesn't match this order.",
        HttpStatus.BAD_REQUEST,
      );
    if (!input.paid && !o.paidAt)
      throw err(
        CommerceErrorCode.ORDER_TRANSITION,
        'Take the payment before handing over the order.',
        HttpStatus.BAD_REQUEST,
      );
    const row = await this.transition(
      o,
      'COMPLETED',
      'SELLER',
      userId,
      {
        completedAt: new Date(),
        expiresAt: null,
        ...(o.paidAt ? {} : { paidAt: new Date() }),
      },
      this.fulfil(o, userId),
    );
    return toOrderDto(row, 'SELLER');
  }

  async returnDecision(
    userId: string,
    salonId: string,
    id: string,
    approve: boolean,
    note?: string | null,
  ): Promise<MarketOrderDto> {
    const o = await this.sellerOrder(userId, salonId, id);
    const row = approve
      ? await this.transition(
          o,
          'RETURNED',
          'SELLER',
          userId,
          { resolutionNote: note?.trim() || null },
          this.restockSeller(o, userId, 'Customer return'),
        )
      : await this.transition(o, 'COMPLETED', 'SELLER', userId, {
          resolutionNote: note?.trim() || 'Return not accepted',
        });
    return toOrderDto(row, 'SELLER');
  }

  async buyerCancel(
    userId: string,
    id: string,
    reason: string,
    buyerSalonId?: string,
  ): Promise<MarketOrderDto> {
    const o = await this.buyerOrder(userId, id, buyerSalonId);
    const row = await this.transition(
      o,
      'CANCELLED',
      'BUYER',
      userId,
      { cancelledAt: new Date(), cancelReason: reason.trim() },
      this.release(o),
    );
    return toOrderDto(row, 'BUYER');
  }

  async confirmReceipt(
    userId: string,
    buyerSalonId: string,
    id: string,
  ): Promise<MarketOrderDto> {
    const o = await this.buyerOrder(userId, id, buyerSalonId);
    const row = await this.transition(
      o,
      'COMPLETED',
      'BUYER',
      userId,
      { completedAt: new Date() },
      this.receiveIntoBuyer(o, userId),
    );
    return toOrderDto(row, 'BUYER');
  }

  async dispute(
    userId: string,
    buyerSalonId: string,
    id: string,
    reason: string,
  ): Promise<MarketOrderDto> {
    const o = await this.buyerOrder(userId, id, buyerSalonId);
    const row = await this.transition(o, 'DISPUTED', 'BUYER', userId, {
      disputeReason: reason.trim(),
    });
    return toOrderDto(row, 'BUYER');
  }

  async requestReturn(
    userId: string,
    id: string,
    reason: string,
  ): Promise<MarketOrderDto> {
    const o = await this.buyerOrder(userId, id);
    if (
      !o.completedAt ||
      Date.now() - o.completedAt.getTime() > RETURN_DAYS * 864e5
    )
      throw err(
        CommerceErrorCode.ORDER_TRANSITION,
        `Returns can be asked for within ${RETURN_DAYS} days of pickup.`,
      );
    const row = await this.transition(o, 'RETURN_REQUESTED', 'BUYER', userId, {
      returnReason: reason.trim(),
    });
    return toOrderDto(row, 'BUYER');
  }

  /** Admin: settle a disputed salon order — completed (buyer gets the stock) or cancelled (back to seller). */
  async adminResolve(
    userId: string,
    id: string,
    outcome: 'COMPLETED' | 'CANCELLED',
    note: string,
  ): Promise<MarketOrderDto> {
    const o = await this.load(id);
    const row =
      outcome === 'COMPLETED'
        ? await this.transition(
            o,
            'COMPLETED',
            'ADMIN',
            userId,
            { completedAt: new Date(), resolutionNote: note },
            this.receiveIntoBuyer(o, userId),
          )
        : await this.transition(
            o,
            'CANCELLED',
            'ADMIN',
            userId,
            {
              cancelledAt: new Date(),
              cancelReason: note,
              resolutionNote: note,
            },
            this.restockSeller(o, userId, 'Dispute cancelled'),
          );
    return toOrderDto(row, 'ADMIN');
  }

  /** Orders not accepted in time, or not collected in time, expire and release their reservation. */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.prisma.marketOrder.findMany({
      where: {
        status: { in: ['PLACED', 'READY_FOR_PICKUP'] },
        expiresAt: { lte: now },
      },
      include: orderInclude,
      take: 100,
    });
    let n = 0;
    for (const o of due) {
      try {
        await this.transition(
          o,
          'EXPIRED',
          'SYSTEM',
          o.buyerUserId,
          {
            cancelledAt: now,
            cancelReason:
              o.status === 'PLACED'
                ? 'Not accepted in time'
                : 'Not collected in time',
          },
          this.release(o),
        );
        n += 1;
      } catch (e) {
        this.logger.warn(
          `Order ${o.number} not expired: ${e instanceof Error ? e.message : 'unknown error'}`,
        );
      }
    }
    return n;
  }

  // ---------- Notifications ----------

  private async notifyOwners(
    salonId: string,
    payload: Record<string, unknown>,
    deepLink: string,
  ) {
    const owners = await this.prisma.userRole.findMany({
      where: { salonId, role: 'SALON_OWNER' },
      select: { userId: true },
    });
    for (const o of owners)
      await this.notifications.notify(
        o.userId,
        'owner.marketplace.order',
        payload,
        deepLink,
      );
  }

  private async notifyStatus(o: OrderRow, by: Actor) {
    const payload = { orderId: o.id, number: o.number, status: o.status };
    if (by !== 'SELLER')
      await this.notifyOwners(
        o.sellerSalonId,
        { ...payload, role: 'seller' },
        `dashboard/salons/${o.sellerSalonId}/inventory/orders`,
      );
    if (by !== 'BUYER') {
      if (o.channel === 'CUSTOMER')
        await this.notifications.notify(
          o.buyerUserId,
          'shop.order.updated',
          payload,
          `shop/orders`,
        );
      else if (o.buyerSalonId)
        await this.notifyOwners(
          o.buyerSalonId,
          { ...payload, role: 'buyer' },
          `dashboard/salons/${o.buyerSalonId}/inventory/orders`,
        );
    }
  }
}
