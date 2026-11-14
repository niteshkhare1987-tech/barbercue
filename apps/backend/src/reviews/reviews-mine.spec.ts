import { ReviewsService } from './reviews.service';

describe('ReviewsService.listMine', () => {
  it('lists only the caller’s reviews with salon and visit context', async () => {
    const prisma = {
      review: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'r1',
            bookingId: 'b1',
            salonId: 's1',
            rating: 4,
            comment: 'Nice',
            ownerResponse: null,
            createdAt: new Date('2026-11-01T10:00:00Z'),
            updatedAt: new Date('2026-11-01T10:00:00Z'),
            salon: {
              name: 'Vida',
              slug: 'vida',
              city: { slug: 'ghaziabad', countryCode: 'IN' },
            },
            booking: {
              slotStart: new Date('2026-10-31T08:00:00Z'),
              service: { name: 'Haircut' },
            },
          },
        ]),
      },
    };
    const service = new ReviewsService(prisma as never);
    const page = await service.listMine('c1', 'not-a-uuid');

    const call = prisma.review.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ customerId: 'c1' });
    expect(call.cursor).toBeUndefined(); // junk cursors are ignored, never passed to Prisma
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      salonName: 'Vida',
      citySlug: 'ghaziabad',
      serviceName: 'Haircut',
      visitDate: '2026-10-31T08:00:00.000Z',
      rating: 4,
    });
  });
});
