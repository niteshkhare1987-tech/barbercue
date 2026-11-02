import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CommerceErrorCode,
  type AdminReviewInput,
  type ListingDto,
  type MarketOrderDto,
  type MarketplaceSupplierDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  listingInclude,
  orderInclude,
  toListingDto,
  toOrderDto,
} from './marketplace.service';
import { supplierInclude, toSupplierDto } from './supplier.service';

/**
 * Inventory Phases 4–5 — FastQue admin control: approve/reject/suspend suppliers, approve or
 * reject listings before anyone can see them, and oversee marketplace orders (disputes are
 * resolved through MarketplaceService.adminResolve). Every decision is audited.
 */
@Injectable()
export class AdminCommerceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async suppliers(status?: string): Promise<MarketplaceSupplierDto[]> {
    const rows = await this.prisma.marketplaceSupplier.findMany({
      where: status ? { status: status as never } : {},
      include: supplierInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toSupplierDto);
  }

  async reviewSupplier(
    userId: string,
    id: string,
    input: AdminReviewInput,
  ): Promise<MarketplaceSupplierDto> {
    const s = await this.prisma.marketplaceSupplier.findUnique({
      where: { id },
    });
    if (!s)
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Supplier not found.',
        HttpStatus.NOT_FOUND,
      );
    const status =
      input.action === 'APPROVE'
        ? 'APPROVED'
        : input.action === 'REJECT'
          ? 'REJECTED'
          : 'SUSPENDED';
    if (input.action === 'SUSPEND' && s.status !== 'APPROVED')
      throw new AppException(
        CommerceErrorCode.SUPPLIER_NOT_APPROVED,
        'Only an approved supplier can be suspended.',
        HttpStatus.CONFLICT,
      );
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.marketplaceSupplier.update({
        where: { id },
        data: {
          status,
          reviewNote: input.note?.trim() || null,
          reviewedByUserId: userId,
          reviewedAt: new Date(),
        },
        include: supplierInclude,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: `SUPPLIER_${status}`,
          entityType: 'MarketplaceSupplier',
          entityId: id,
          metadata: { from: s.status, note: input.note ?? null },
        },
      });
      return u;
    });
    return toSupplierDto(updated);
  }

  async listings(status?: string): Promise<
    (ListingDto & {
      invoiceUrl: string | null;
      provenanceNote: string | null;
    })[]
  > {
    const rows = await this.prisma.marketListing.findMany({
      where: status ? { status: status as never } : {},
      include: listingInclude,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map((l) => ({
      ...toListingDto(l),
      invoiceUrl: l.invoiceUrl,
      provenanceNote: l.provenanceNote,
    }));
  }

  async reviewListing(
    userId: string,
    id: string,
    input: AdminReviewInput,
  ): Promise<ListingDto> {
    const l = await this.prisma.marketListing.findUnique({ where: { id } });
    if (!l)
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Listing not found.',
        HttpStatus.NOT_FOUND,
      );
    const to =
      input.action === 'APPROVE'
        ? 'ACTIVE'
        : input.action === 'REJECT'
          ? 'REJECTED'
          : 'ENDED';
    const allowed =
      input.action === 'SUSPEND' ? ['ACTIVE', 'PAUSED'] : ['PENDING_REVIEW'];
    const { count } = await this.prisma.marketListing.updateMany({
      where: { id, status: { in: allowed as never } },
      data: {
        status: to,
        reviewNote: input.note?.trim() || null,
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    if (!count)
      throw new AppException(
        CommerceErrorCode.LISTING_UNAVAILABLE,
        'This listing was already reviewed.',
        HttpStatus.CONFLICT,
      );
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: `MARKET_LISTING_${to}`,
        entityType: 'MarketListing',
        entityId: id,
        metadata: { from: l.status, note: input.note ?? null },
      },
    });
    const owners = await this.prisma.userRole.findMany({
      where: { salonId: l.salonId, role: 'SALON_OWNER' },
      select: { userId: true },
    });
    for (const o of owners)
      await this.notifications.notify(
        o.userId,
        'owner.marketplace.order',
        { listingId: id, title: l.title, listingStatus: to },
        `dashboard/salons/${l.salonId}/inventory/sell`,
      );
    return toListingDto(
      await this.prisma.marketListing.findUniqueOrThrow({
        where: { id },
        include: listingInclude,
      }),
    );
  }

  async orders(status?: string): Promise<MarketOrderDto[]> {
    const rows = await this.prisma.marketOrder.findMany({
      where: status ? { status: status as never } : {},
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((o) => toOrderDto(o, 'ADMIN'));
  }
}
