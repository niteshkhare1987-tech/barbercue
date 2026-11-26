import { randomBytes, randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type CommerceTicketMessage } from '@prisma/client';
import sharp from 'sharp';
import type { z } from 'zod';
import {
  paise,
  rupeesOf,
  type CommerceBannerDto,
  type CommerceListQuery,
  type CommerceListingDetailInput,
  type CommerceProductDto,
  type CommercePromotionInput,
  type CommerceReviewInput,
  type CommerceReviewsDto,
  type CommerceTicketDto,
  type CommerceTicketInput,
  type CommerceTicketStaffInput,
  type commerceBannerSchema,
  type commerceReturnPolicySchema,
  type commerceReviewModerateSchema,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { detectImageMimeType } from '../storage/image-signature';
import { PrivateObjectStorageService } from '../storage/private-object-storage.service';
import { CommerceCatalogService, priceNow } from './commerce-catalog.service';
import type { CommerceOrderRow } from './commerce-orders.service';
import { CommerceOutboxService } from './commerce-outbox.service';
import {
  TX_OPTIONS,
  conflict,
  fail,
  indiaToday,
  notFound,
  type Db,
} from './commerce-support';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_OPEN_TICKETS = 5;

export const inWindow = (
  now = new Date(),
): { AND: Array<Record<string, unknown>> } => ({
  AND: [
    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
  ],
});

/** Customer-facing extras: reviews, support, offers, product details, banners, files. */
@Injectable()
export class CommerceEngageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CommerceCatalogService,
    private readonly outbox: CommerceOutboxService,
    private readonly storage: PrivateObjectStorageService,
  ) {}

  private audit(
    db: Db,
    actorUserId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject = {},
  ) {
    return db.auditLog.create({
      data: { actorUserId, action, entityType, entityId, metadata },
    });
  }

  // ---------- Reviews ----------

  async review(
    o: CommerceOrderRow,
    input: CommerceReviewInput,
    userId: string | null,
  ) {
    const item = o.items.find((i) => i.id === input.orderItemId);
    if (!item) throw notFound('The product');
    if (o.status !== 'DELIVERED')
      throw conflict(
        'COMMERCE_REVIEW',
        'You can review a product after it is delivered.',
      );
    try {
      const r = await this.prisma.commerceReview.create({
        data: {
          listingId: item.listingId,
          orderItemId: item.id,
          orderId: o.id,
          customerUserId: userId,
          displayName: input.displayName,
          rating: input.rating,
          body: input.body || null,
        },
      });
      return { id: r.id, status: r.status };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw conflict(
          'COMMERCE_REVIEW',
          'You have already reviewed this product.',
        );
      throw e;
    }
  }

  async reviews(globalProductId: string): Promise<CommerceReviewsDto> {
    const offer = await this.catalog.offer(globalProductId);
    if (!offer) return { average: null, count: 0, stars: {}, items: [] };
    const where = { listingId: offer.listingId, status: 'PUBLISHED' };
    const [groups, items] = await Promise.all([
      this.prisma.commerceReview.groupBy({
        by: ['rating'],
        where,
        _count: true,
      }),
      this.prisma.commerceReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    const count = groups.reduce((n, g) => n + g._count, 0);
    return {
      count,
      average: count
        ? Math.round(
            (groups.reduce((n, g) => n + g.rating * g._count, 0) / count) * 10,
          ) / 10
        : null,
      stars: Object.fromEntries(groups.map((g) => [g.rating, g._count])),
      items: items.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        rating: r.rating,
        body: r.body,
        reply: r.reply,
        createdAt: r.createdAt.toISOString(),
        verifiedPurchase: true,
      })),
    };
  }

  async reviewList(q: CommerceListQuery) {
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.commerceReview.count({ where }),
      this.prisma.commerceReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const names = await this.listingNames(rows.map((r) => r.listingId));
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map((r) => ({ ...r, productName: names.get(r.listingId) })),
    };
  }
  async moderateReview(
    id: string,
    input: z.infer<typeof commerceReviewModerateSchema>,
    by: string,
  ) {
    if (!(await this.prisma.commerceReview.findUnique({ where: { id } })))
      throw notFound('The review');
    const r = await this.prisma.commerceReview.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.reply !== undefined ? { reply: input.reply || null } : {}),
      },
    });
    await this.audit(
      this.prisma,
      by,
      `COMMERCE_REVIEW_${input.status}`,
      'CommerceReview',
      id,
    );
    return r;
  }

  async listingNames(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.commerceListing.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, globalProduct: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.id, r.globalProduct.name]));
  }

  // ---------- Support ----------

  private ticketDto(
    t: {
      id: string;
      number: string;
      category: string;
      subject: string;
      status: string;
      priority: string;
      createdAt: Date;
      updatedAt: Date;
      messages: CommerceTicketMessage[];
    },
    orderNumber: string,
    productName: string | null,
    staff: boolean,
  ): CommerceTicketDto {
    return {
      id: t.id,
      number: t.number,
      orderNumber,
      productName,
      category: t.category,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      messages: t.messages
        .filter((m) => staff || !m.internal)
        .map((m) => ({
          id: m.id,
          from: m.authorKind === 'STAFF' ? 'STAFF' : 'CUSTOMER',
          body: m.body,
          internal: m.internal,
          createdAt: m.createdAt.toISOString(),
        })),
    };
  }

  async openTicket(
    o: CommerceOrderRow,
    input: CommerceTicketInput,
    userId: string | null,
  ): Promise<CommerceTicketDto[]> {
    const item = input.orderItemId
      ? o.items.find((i) => i.id === input.orderItemId)
      : null;
    if (input.orderItemId && !item) throw notFound('The product');
    await this.prisma.$transaction(async (tx) => {
      // One order at a time, so the open-ticket limit cannot be raced.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "commerce_orders" WHERE "id" = ${o.id}::uuid FOR UPDATE`,
      );
      const open = await tx.commerceTicket.count({
        where: { orderId: o.id, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      });
      if (open >= MAX_OPEN_TICKETS)
        throw conflict(
          'COMMERCE_TICKET',
          'You already have several open requests for this order. Please reply there.',
        );
      const t = await tx.commerceTicket.create({
        data: {
          number: `FQT-${randomBytes(4).toString('hex').toUpperCase()}`,
          orderId: o.id,
          sellerId: o.sellerId,
          listingId: item?.listingId ?? null,
          shipmentId: o.shipments[0]?.id ?? null,
          customerUserId: userId ?? o.customerUserId,
          category: input.category,
          subject: input.subject,
          messages: {
            create: {
              authorKind: 'CUSTOMER',
              authorUserId: userId,
              body: input.body,
            },
          },
        },
      });
      await this.audit(
        tx,
        userId,
        'COMMERCE_TICKET_OPENED',
        'CommerceTicket',
        t.id,
        { orderId: o.id, category: input.category },
      );
    }, TX_OPTIONS);
    return this.ticketsFor(o);
  }

  async ticketsFor(o: CommerceOrderRow): Promise<CommerceTicketDto[]> {
    const rows = await this.prisma.commerceTicket.findMany({
      where: { orderId: o.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((t) =>
      this.ticketDto(
        t,
        o.orderNumber,
        o.items.find((i) => i.listingId === t.listingId)?.productName ?? null,
        false,
      ),
    );
  }

  async customerReply(
    o: CommerceOrderRow,
    ticketId: string,
    body: string,
    userId: string | null,
  ) {
    const t = await this.prisma.commerceTicket.findFirst({
      where: { id: ticketId, orderId: o.id },
    });
    if (!t) throw notFound('The request');
    if (t.status === 'CLOSED')
      throw conflict('COMMERCE_TICKET', 'This request is closed.');
    await this.prisma.$transaction([
      this.prisma.commerceTicketMessage.create({
        data: {
          ticketId,
          authorKind: 'CUSTOMER',
          authorUserId: userId,
          body,
        },
      }),
      this.prisma.commerceTicket.update({
        where: { id: ticketId },
        data: {
          status: t.status === 'OPEN' ? 'OPEN' : 'IN_PROGRESS',
          resolvedAt: null,
        },
      }),
    ]);
    return this.ticketsFor(o);
  }

  async tickets(q: CommerceListQuery) {
    const where: Prisma.CommerceTicketWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q, mode: 'insensitive' } },
              { subject: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceTicket.count({ where }),
      this.prisma.commerceTicket.findMany({
        where,
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: [{ createdAt: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const orders = new Map(
      (
        await this.prisma.commerceOrder.findMany({
          where: { id: { in: rows.map((r) => r.orderId) } },
          select: {
            id: true,
            orderNumber: true,
            contactName: true,
            contactPhone: true,
            status: true,
          },
        })
      ).map((o) => [o.id, o]),
    );
    const names = await this.listingNames(
      rows.map((r) => r.listingId).filter((x): x is string => !!x),
    );
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map((t) => {
        const o = orders.get(t.orderId);
        return {
          ...this.ticketDto(
            t,
            o?.orderNumber ?? '',
            (t.listingId && names.get(t.listingId)) || null,
            true,
          ),
          orderId: t.orderId,
          orderStatus: o?.status,
          customer: o?.contactName,
          phone: o?.contactPhone,
          assignedToUserId: t.assignedToUserId,
        };
      }),
    };
  }

  async staffTicket(id: string, input: CommerceTicketStaffInput, by: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.commerceTicket.findUnique({ where: { id } });
      if (!t) throw notFound('The request');
      const reply = !!input.body && !input.internal;
      const status =
        input.status ??
        (reply && ['OPEN', 'IN_PROGRESS'].includes(t.status)
          ? 'WAITING_CUSTOMER'
          : t.status);
      let messageId: string | null = null;
      if (input.body)
        messageId = (
          await tx.commerceTicketMessage.create({
            data: {
              ticketId: id,
              authorKind: 'STAFF',
              authorUserId: by,
              body: input.body,
              internal: input.internal,
            },
          })
        ).id;
      await tx.commerceTicket.update({
        where: { id },
        data: {
          status,
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assignToMe ? { assignedToUserId: by } : {}),
          ...(reply && !t.firstResponseAt
            ? { firstResponseAt: new Date() }
            : {}),
          resolvedAt: ['RESOLVED', 'CLOSED'].includes(status)
            ? (t.resolvedAt ?? new Date())
            : null,
        },
      });
      await this.audit(
        tx,
        by,
        'COMMERCE_TICKET_UPDATED',
        'CommerceTicket',
        id,
        { status, replied: reply, internalNote: !!input.body && !reply },
      );
      if (reply && messageId) {
        const o = await tx.commerceOrder.findUniqueOrThrow({
          where: { id: t.orderId },
          select: { orderNumber: true, customerUserId: true },
        });
        await this.outbox.add(tx, {
          dedupeKey: `commerce-ticket:${messageId}`,
          userId: o.customerUserId,
          type: 'commerce.ticket.updated',
          payload: { orderNumber: o.orderNumber, ticket: t.number },
          deepLink: `shop/delivery/${o.orderNumber}`,
        });
      }
    }, TX_OPTIONS);
    return { id };
  }

  // ---------- Offers ----------

  promotions() {
    return this.prisma.commercePromotion.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  /** Offers running now, so product pages can name them. Area offers are shown with their areas. */
  async liveOffers(listingId: string) {
    const rows = await this.prisma.commercePromotion.findMany({
      where: { isActive: true, listingIds: { has: listingId }, ...inWindow() },
      take: 10,
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      buyQty: p.buyQty,
      getQty: p.getQty,
      value: p.value.toFixed(2),
      listingIds: p.listingIds,
      areaOnly: p.pinRules.length > 0,
    }));
  }
  async savePromotion(
    id: string | null,
    input: CommercePromotionInput,
    by: string,
  ) {
    const { confirmBelowCost, ...data } = input;
    const listingIds = [...new Set(input.listingIds)];
    const rows = await this.prisma.commerceListing.findMany({
      where: { id: { in: listingIds } },
      include: { batches: { where: { onHand: { gt: 0 } } } },
    });
    if (rows.length !== listingIds.length)
      throw notFound('One of the products');
    if (!confirmBelowCost) {
      const worst = (l: (typeof rows)[number]) =>
        Math.max(0, ...l.batches.map((b) => paise(b.unitCost.toFixed(2))));
      const loses =
        input.kind === 'BUNDLE'
          ? paise(input.value) < rows.reduce((n, l) => n + worst(l), 0)
          : rows.some((l) => {
              const p = paise(priceNow(l));
              const net =
                input.kind === 'PERCENT'
                  ? p * (1 - Number(input.value) / 100)
                  : (p * input.buyQty) / (input.buyQty + input.getQty);
              return net < worst(l);
            });
      if (loses)
        throw conflict(
          'COMMERCE_BELOW_COST',
          'This offer sells below cost. Confirm to continue.',
        );
    }
    const values = {
      ...data,
      listingIds,
      startsAt: data.startsAt ? new Date(data.startsAt) : null,
      endsAt: data.endsAt ? new Date(data.endsAt) : null,
    };
    if (
      id &&
      !(await this.prisma.commercePromotion.findUnique({ where: { id } }))
    )
      throw notFound('The offer');
    const row = id
      ? await this.prisma.commercePromotion.update({
          where: { id },
          data: values,
        })
      : await this.prisma.commercePromotion.create({ data: values });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_PROMOTION_SAVED',
      'CommercePromotion',
      row.id,
      { kind: row.kind, belowCostConfirmed: !!confirmBelowCost },
    );
    return row;
  }

  // ---------- Product details ----------

  detail(listingId: string) {
    return this.prisma.commerceListingDetail.findUnique({
      where: { listingId },
    });
  }
  async saveDetail(
    listingId: string,
    input: CommerceListingDetailInput,
    by: string,
  ) {
    if (
      !(await this.prisma.commerceListing.findUnique({
        where: { id: listingId },
      }))
    )
      throw notFound('The product');
    const row = await this.prisma.commerceListingDetail.upsert({
      where: { listingId },
      create: { listingId, ...input },
      update: input,
    });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_DETAIL_SAVED',
      'CommerceListing',
      listingId,
    );
    return row;
  }
  /** Everything extra the product page shows; only what staff really filled in. */
  async productExtras(globalProductId: string) {
    const offer = await this.catalog.offer(globalProductId);
    if (!offer) throw notFound('The product');
    const [detail, images, offers] = await Promise.all([
      this.detail(offer.listingId),
      this.prisma.globalProductImage.findMany({
        where: { productId: globalProductId },
        orderBy: { sortOrder: 'asc' },
        select: { url: true },
        take: 10,
      }),
      this.liveOffers(offer.listingId),
    ]);
    let variants: Array<{
      productId: string;
      label: string;
      price: string;
      availability: string;
    }> = [];
    if (detail?.variantGroup) {
      const rows = await this.prisma.commerceListingDetail.findMany({
        where: { variantGroup: detail.variantGroup },
        take: 30,
      });
      const labels = new Map(rows.map((r) => [r.listingId, r.variantLabel]));
      variants = (await this.catalog.byListingIds([...labels.keys()])).map(
        (p) => ({
          productId: p.productId,
          label: labels.get(p.listingId) || p.variant || p.name,
          price: p.price,
          availability: p.availability,
        }),
      );
    }
    return {
      ingredients: detail?.ingredients ?? null,
      usage: detail?.usage ?? null,
      benefits: detail?.benefits ?? null,
      warnings: detail?.warnings ?? null,
      countryOfOrigin: detail?.countryOfOrigin ?? null,
      manufacturer: detail?.manufacturer ?? null,
      shelfLifeMonths: detail?.shelfLifeMonths ?? null,
      images: images.map((i) => i.url).filter((u) => u.startsWith('https://')),
      variants,
      offers,
    };
  }

  // ---------- Banners, return policies ----------

  async banners(): Promise<CommerceBannerDto[]> {
    const rows = await this.prisma.commerceBanner.findMany({
      where: { isActive: true, ...inWindow() },
      orderBy: { sortOrder: 'asc' },
      take: 5,
    });
    return rows.map(({ id, title, subtitle, imageUrl, linkPath }) => ({
      id,
      title,
      subtitle,
      imageUrl,
      linkPath,
    }));
  }
  allBanners() {
    return this.prisma.commerceBanner.findMany({
      orderBy: { sortOrder: 'asc' },
      take: 100,
    });
  }
  async saveBanner(
    id: string | null,
    input: z.infer<typeof commerceBannerSchema>,
    by: string,
  ) {
    if (id && !(await this.prisma.commerceBanner.findUnique({ where: { id } })))
      throw notFound('The banner');
    const data = {
      ...input,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
    };
    const row = id
      ? await this.prisma.commerceBanner.update({ where: { id }, data })
      : await this.prisma.commerceBanner.create({ data });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_BANNER_SAVED',
      'CommerceBanner',
      row.id,
    );
    return row;
  }
  policies() {
    return this.prisma.commerceReturnPolicy.findMany({
      orderBy: { category: 'asc' },
    });
  }
  async savePolicy(
    input: z.infer<typeof commerceReturnPolicySchema>,
    by: string,
  ) {
    const { category, ...rest } = input;
    const row = await this.prisma.commerceReturnPolicy.upsert({
      where: { category },
      create: input,
      update: rest,
    });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_RETURN_POLICY_SAVED',
      'CommerceReturnPolicy',
      category,
      rest,
    );
    return row;
  }

  // ---------- Bag sync, recommendations, counters ----------

  async bag(userId: string) {
    const row = await this.prisma.commerceSavedBag.findUnique({
      where: { userId },
    });
    const saved = (row?.items ?? []) as Array<{
      listingId: string;
      quantity: number;
    }>;
    const products = await this.catalog.byListingIds(
      saved.map((i) => i.listingId),
    );
    return saved.flatMap((i) => {
      const product = products.find((p) => p.listingId === i.listingId);
      return product ? [{ product, quantity: i.quantity }] : [];
    });
  }
  async saveBag(
    userId: string,
    items: Array<{ listingId: string; quantity: number }>,
  ): Promise<void> {
    await this.prisma.commerceSavedBag.upsert({
      where: { userId },
      create: { userId, items },
      update: { items },
    });
  }
  /** Products in the categories this customer actually bought, leaving out what they already have. */
  async recommendations(userId: string): Promise<CommerceProductDto[]> {
    const bought = await this.prisma.commerceOrderItem.findMany({
      where: {
        order: { customerUserId: userId, status: { not: 'CANCELLED' } },
      },
      select: { listingId: true, category: true },
      take: 200,
      orderBy: { order: { placedAt: 'desc' } },
    });
    const categories = [
      ...new Set(bought.map((b) => b.category).filter((c): c is string => !!c)),
    ].slice(0, 5);
    return this.catalog.inCategories(
      categories,
      bought.map((b) => b.listingId),
    );
  }
  async count(metric: string): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`INSERT INTO "commerce_daily_stats" ("day", "metric", "count") VALUES (${indiaToday()}::date, ${metric}, 1)
        ON CONFLICT ("day", "metric") DO UPDATE SET "count" = "commerce_daily_stats"."count" + 1`,
    );
  }

  // ---------- Photos (private storage) ----------

  /** Decodes and re-encodes, so only real photos are kept and location data is removed. */
  async addPhoto(
    o: { id: string },
    kind: 'RETURN_PHOTO' | 'DELIVERY_PROOF',
    file: Express.Multer.File | undefined,
    returnId: string | null,
    by: string | null,
  ) {
    if (!file?.buffer?.length)
      throw fail('COMMERCE_PHOTO', 'Choose a photo to upload.');
    if (
      file.buffer.length > MAX_PHOTO_BYTES ||
      !detectImageMimeType(file.buffer)
    )
      throw fail(
        'COMMERCE_PHOTO',
        'Upload a JPG, PNG or WebP photo up to 5 MB.',
      );
    if (returnId) {
      const r = await this.prisma.commerceReturn.findFirst({
        where: { id: returnId, orderId: o.id },
      });
      if (!r) throw notFound('The return');
      if (!['REQUESTED', 'APPROVED'].includes(r.status))
        throw conflict(
          'COMMERCE_PHOTO',
          'Photos can be added until the return is received.',
        );
    }
    const existing = await this.prisma.commerceFile.count({
      where: returnId ? { returnId } : { orderId: o.id, kind },
    });
    if (existing >= MAX_FILES)
      throw conflict('COMMERCE_PHOTO', `At most ${MAX_FILES} photos.`);
    let body: Buffer;
    try {
      body = await sharp(file.buffer, { limitInputPixels: 50_000_000 })
        .rotate()
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      throw fail('COMMERCE_PHOTO', 'This photo could not be read.');
    }
    const storageKey = `commerce/${o.id}/${randomUUID()}.jpg`;
    await this.storage.put(storageKey, body, 'image/jpeg');
    try {
      const f = await this.prisma.commerceFile.create({
        data: {
          kind,
          orderId: o.id,
          returnId,
          storageKey,
          mimeType: 'image/jpeg',
          sizeBytes: body.length,
          uploadedById: by,
        },
      });
      await this.audit(
        this.prisma,
        by,
        `COMMERCE_${kind}_ADDED`,
        'CommerceOrder',
        o.id,
        { fileId: f.id },
      );
      return { id: f.id };
    } catch (e) {
      await this.storage.delete(storageKey);
      throw e;
    }
  }
  files(orderId: string) {
    return this.prisma.commerceFile.findMany({
      where: { orderId },
      select: { id: true, kind: true, returnId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  async file(id: string, orderId?: string) {
    const f = await this.prisma.commerceFile.findFirst({
      where: { id, ...(orderId ? { orderId } : {}) },
    });
    const body = f ? await this.storage.get(f.storageKey) : null;
    if (!f || !body)
      throw fail(
        'COMMERCE_NOT_FOUND',
        'The photo was not found.',
        HttpStatus.NOT_FOUND,
      );
    return { body, mimeType: f.mimeType };
  }

  // ---------- Suggested support reply ----------

  /** Built only from this order's own facts. Staff read, edit and send it; nothing is sent by itself. */
  async suggestReply(ticketId: string) {
    const t = await this.prisma.commerceTicket.findUnique({
      where: { id: ticketId },
    });
    if (!t) throw notFound('The request');
    const o = await this.prisma.commerceOrder.findUniqueOrThrow({
      where: { id: t.orderId },
      include: {
        shipments: { orderBy: { createdAt: 'desc' }, take: 1 },
        returns: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const s = o.shipments[0];
    const d = (x: Date) => x.toISOString().slice(0, 10);
    const facts: string[] = [`Order ${o.orderNumber} is ${o.status}.`];
    if (['DELIVERY', 'OTHER'].includes(t.category)) {
      if (o.deliveredAt) facts.push(`It was delivered on ${d(o.deliveredAt)}.`);
      else if (s)
        facts.push(
          `It was sent with ${s.courier}${s.trackingNumber ? `, tracking number ${s.trackingNumber}` : ''}${s.expectedOn ? `, expected ${d(s.expectedOn)}` : ''}.`,
        );
      else if (o.status !== 'CANCELLED')
        facts.push(
          `It has not been shipped yet. The estimate given at checkout was ${o.minDays}–${o.maxDays} days from ${d(o.placedAt)}.`,
        );
    }
    if (t.category === 'CANCELLATION')
      facts.push(
        ['PLACED', 'CONFIRMED', 'PROCESSING'].includes(o.status)
          ? 'You can still cancel it from your order page.'
          : 'It can no longer be cancelled.',
      );
    if (t.category === 'RETURN_REFUND') {
      const r = o.returns[0];
      facts.push(
        r
          ? `Return ${r.number} is ${r.status}.`
          : 'No return has been requested yet. Eligible products show a return button on your order page.',
      );
    }
    if (t.category === 'PAYMENT')
      facts.push(
        `It is Cash on Delivery, total ₹${rupeesOf(paise(o.total.toFixed(2)))}.`,
      );
    if (t.category === 'INVOICE')
      facts.push('You can print the invoice from your order page.');
    return {
      reply: `Hello ${o.contactName}, ${facts.join(' ')}`,
      basis: 'This order’s status, shipment and return records.',
    };
  }
}
