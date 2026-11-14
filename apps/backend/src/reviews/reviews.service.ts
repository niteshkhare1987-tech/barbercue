import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BookingStatus,
  ReviewErrorCode,
  type CreateReviewInput,
  type CustomerReviewDto,
  type PaginatedResult,
  type ReviewDetailDto,
  type UpdateReviewInput,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/exceptions/app.exception';

/**
 * Ratings & Reviews (Phase 16), customer-facing write side. The public read side (aggregate
 * rating, recent ReviewSummaryDto list on a salon's profile page) already existed — see
 * SalonsService.aggregate/getProfile. This is the missing "leave a review" half: exactly one
 * review per booking (Review.bookingId is @unique), only for a booking the caller actually owns
 * and that actually completed.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The customer's own reviews, newest first. Scoped by customerId in the WHERE, so another
   * account's reviews can never be listed. Cursor must be a review id from a previous page.
   */
  async listMine(
    customerId: string,
    cursor: string | undefined,
    limit = 20,
  ): Promise<PaginatedResult<CustomerReviewDto>> {
    const validCursor =
      cursor && /^[0-9a-f-]{36}$/i.test(cursor) ? cursor : undefined;
    const rows = await this.prisma.review.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(validCursor ? { cursor: { id: validCursor }, skip: 1 } : {}),
      include: {
        salon: {
          select: {
            name: true,
            slug: true,
            city: { select: { slug: true, countryCode: true } },
          },
        },
        booking: {
          select: { slotStart: true, service: { select: { name: true } } },
        },
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => ({
        id: r.id,
        bookingId: r.bookingId,
        salonId: r.salonId,
        salonName: r.salon.name,
        salonSlug: r.salon.slug,
        citySlug: r.salon.city.slug,
        countryCode: r.salon.city.countryCode,
        serviceName: r.booking.service.name,
        visitDate: r.booking.slotStart.toISOString(),
        rating: r.rating,
        comment: r.comment,
        ownerResponse: r.ownerResponse,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async create(customerId: string, input: CreateReviewInput): Promise<ReviewDetailDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    });
    // Scoped by customerId in the same check as "exists" — a booking that exists but belongs to
    // someone else reports as not-found, never leaking that it exists (same convention as
    // BookingsService's own ownership checks).
    if (!booking || booking.customerId !== customerId) {
      throw new AppException(
        ReviewErrorCode.BOOKING_NOT_FOUND,
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppException(
        ReviewErrorCode.BOOKING_NOT_COMPLETED,
        'Only a completed booking can be reviewed.',
        HttpStatus.CONFLICT,
      );
    }
    const existing = await this.prisma.review.findUnique({
      where: { bookingId: input.bookingId },
    });
    if (existing) {
      throw new AppException(
        ReviewErrorCode.REVIEW_ALREADY_EXISTS,
        'This booking has already been reviewed.',
        HttpStatus.CONFLICT,
      );
    }

    const review = await this.prisma.review.create({
      data: {
        salonId: booking.salonId,
        customerId,
        bookingId: booking.id,
        rating: input.rating,
        comment: input.comment ?? null,
      },
    });
    return this.toDetailDto(review);
  }

  async update(
    customerId: string,
    reviewId: string,
    input: UpdateReviewInput,
  ): Promise<ReviewDetailDto> {
    const review = await this.getOwnedOrThrow(customerId, reviewId);
    const updated = await this.prisma.review.update({
      where: { id: review.id },
      data: {
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      },
    });
    return this.toDetailDto(updated);
  }

  /** Null (not an error) when this booking has no review yet — that is the normal, expected state
   * for most completed bookings, not a failure. Scoped to the caller's own booking only; the
   * owner-facing equivalent is DashboardReviewsService.list, a different endpoint entirely. */
  async getForBooking(customerId: string, bookingId: string): Promise<ReviewDetailDto | null> {
    const review = await this.prisma.review.findUnique({ where: { bookingId } });
    if (!review || review.customerId !== customerId) return null;
    return this.toDetailDto(review);
  }

  private async getOwnedOrThrow(customerId: string, reviewId: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) {
      throw new AppException(
        ReviewErrorCode.REVIEW_NOT_FOUND,
        'Review not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (review.customerId !== customerId) {
      throw new AppException(
        ReviewErrorCode.NOT_YOUR_REVIEW,
        'You can only edit your own review.',
        HttpStatus.FORBIDDEN,
      );
    }
    return review;
  }

  private toDetailDto(review: {
    id: string;
    bookingId: string;
    salonId: string;
    rating: number;
    comment: string | null;
    ownerResponse: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ReviewDetailDto {
    return {
      id: review.id,
      bookingId: review.bookingId,
      salonId: review.salonId,
      rating: review.rating,
      comment: review.comment,
      ownerResponse: review.ownerResponse,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
    };
  }
}
