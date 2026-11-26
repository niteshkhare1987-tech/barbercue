import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  guestWalkInSchema, type GuestWalkInInput,
} from '@barbercue/shared';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { QueueService } from './queue.service';
import { PrismaService } from '../prisma/prisma.service';

// Production traffic reaches this API through shared proxies (the website's Next.js rewrite and Railway's edge), so a per-client-address
// counter would be ONE bucket for every guest on the platform: three joins a minute for everybody, and one noisy client could lock
// everyone out. The guest limits are therefore keyed by what is actually being protected: the shop for joins (bounds spam into one
// queue without letting a busy shop starve another) and the ticket for everything a guest does afterwards.
type TrackerRequest = { params?: Record<string, string> };
const byShop = (req: TrackerRequest) => `guest-join:salon:${req.params?.salonId ?? 'unknown'}`;
const byTicket = (req: TrackerRequest) => `guest-ticket:${req.params?.id ?? 'unknown'}`;
const GUEST_JOIN_LIMIT = { default: { limit: 20, ttl: 60_000, getTracker: byShop } };
const GUEST_MUTATION_LIMIT = { default: { limit: 12, ttl: 60_000, getTracker: byTicket } };
const GUEST_READ_LIMIT = { default: { limit: 60, ttl: 60_000, getTracker: byTicket } };
// Guest customers provide name, mobile number and service. No account creation,
// trust elevation to an existing account or bogus phone verification occurs.
export const guestJoinSchema = guestWalkInSchema;

@Public()
@Controller()
export class QueueGuestController {
  constructor(
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('salons/:salonId/queue/guest-join')
  @Throttle(GUEST_JOIN_LIMIT)
  join(
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(guestJoinSchema)) body: GuestWalkInInput,
  ) {
    return this.queueService.joinGuestWalkIn(
      salonId, body.serviceIds ?? body.serviceId!, body.contactName, body.contactPhone,
    );
  }

  @Get('queue-entries/:id/guest-status')
  @Throttle(GUEST_READ_LIMIT)
  getStatus(
    @Param('id') id: string,
    @Headers('x-queue-guest-token') guestToken: string,
  ) {
    return this.queueService.getGuestEntry(id, guestToken ?? '');
  }

  @Post('queue-entries/:id/guest-cancel')
  @Throttle(GUEST_MUTATION_LIMIT)
  cancel(
    @Param('id') id: string,
    @Headers('x-queue-guest-token') guestToken: string,
  ) {
    return this.queueService.cancelGuestEntry(id, guestToken ?? '');
  }

  @Post('queue-entries/:id/guest-arrival-response')
  @Throttle(GUEST_MUTATION_LIMIT)
  respondArrival(
    @Param('id') id: string,
    @Headers('x-queue-guest-token') guestToken: string,
    @Body() body: { arrived?: unknown },
  ) {
    if (typeof body?.arrived !== 'boolean') {
      throw new BadRequestException('Arrival response must be true or false.');
    }
    return this.queueService.respondArrival(id, body.arrived, { guestAccessToken: guestToken });
  }

  @Post('queue-entries/:id/guest-device')
  @Throttle(GUEST_MUTATION_LIMIT)
  registerGuestDevice(
    @Param('id') id: string,
    @Headers('x-queue-guest-token') guestToken: string,
    @Body() body: { expoPushToken?: unknown },
  ) {
    if (typeof body?.expoPushToken !== 'string') {
      throw new BadRequestException('Expo push token is required.');
    }
    return this.queueService.registerGuestPush(id, guestToken ?? '', body.expoPushToken);
  }

  @Get('queue-entries/:id/guest-shop-contact')
  @Throttle(GUEST_READ_LIMIT)
  async getShopContact(
    @Param('id') id: string,
    @Headers('x-queue-guest-token') guestToken: string,
  ): Promise<{ shopPhone: string | null }> {
    const ticket = await this.queueService.getGuestEntry(id, guestToken ?? '');
    const shop = await this.prisma.salon.findUnique({
      where: { id: ticket.salonId },
      select: { phone: true, showPhoneToCustomers: true },
    });
    const raw = shop?.showPhoneToCustomers ? shop.phone : null;
    const dialable = raw?.replace(/[\s().-]/g, '') ?? '';
    return { shopPhone: /^\+?[0-9]{7,15}$/.test(dialable) ? dialable : null };
  }
}
