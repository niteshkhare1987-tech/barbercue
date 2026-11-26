import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  Role,
  SALON_QUEUE_PATHS,
  joinWalkInSchema,
  type AuthenticatedUser,
  type JoinWalkInInput,
} from '@barbercue/shared';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { QueueService } from './queue.service';

/**
 * Mounted at `salons/:salonId/queue`. SalonsController's `GET
 * salons/:countryCode/:citySlug/:salonSlug` is a fully-wildcard 3-segment route under the same
 * `salons` prefix, so it structurally matches this controller's routes too (`salons/:salonId/
 * queue/status` is also 3 segments after `salons/`) — Nest/Express matches by registration order,
 * not pattern specificity, so this only works because QueueModule is imported before SalonsModule
 * in app.module.ts. This was broken in production until that ordering fix (same root cause as the
 * booking-info routes — see BookingInfoController's doc comment and app.module.ts).
 */
@Controller('salons/:salonId/queue')
export class SalonQueueController {
  constructor(private readonly queueService: QueueService) {}

  @Public()
  @Get(SALON_QUEUE_PATHS.status)
  getStatus(@Param('salonId') salonId: string) {
    return this.queueService.getQueueStatus(salonId);
  }

  @Roles(Role.CUSTOMER)
  @Post(SALON_QUEUE_PATHS.join)
  @Idempotent()
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(joinWalkInSchema)) body: JoinWalkInInput,
  ) {
    return this.queueService.joinWalkIn(user.id, salonId, body.serviceIds ?? body.serviceId, {
      name: body.contactName,
      phone: body.contactPhone,
    });
  }
}
