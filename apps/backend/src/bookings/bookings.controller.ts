import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  BOOKING_PATHS,
  BookingSource,
  Role,
  createBookingSchema,
  rescheduleBookingSchema,
  type AuthenticatedUser,
  type CreateBookingInput,
  type RescheduleBookingInput,
  customerBookingListQuerySchema,
  type CustomerBookingListQuery,
} from '@barbercue/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { BookingsService } from './bookings.service';

const MINE_PAGE_LIMIT = 20;

@Controller(BOOKING_PATHS.bookings)
@Roles(Role.CUSTOMER)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  // Web and mobile both send this so BookingSource is recorded accurately; anything else (or a
  // missing header, e.g. a raw API call) defaults to WEB rather than rejecting the request.
  private resolveSource(request: Request): BookingSource {
    return request.header('X-Client') === 'app'
      ? BookingSource.APP
      : BookingSource.WEB;
  }

  // The zod pipe is scoped to @Body() specifically, not a method-level @UsePipes() — a
  // method-level pipe runs against every parameter, including @CurrentUser() and @Req(), which
  // would fail this schema's validation on those non-body values too (see the same fix in
  // booking-info.controller.ts).
  @Post()
  @Idempotent()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Req() req: Request,
  ) {
    const idempotencyKey = req.header('Idempotency-Key') ?? '';
    return this.bookingsService.create(
      user.id,
      body,
      this.resolveSource(req),
      idempotencyKey,
    );
  }

  @Get(BOOKING_PATHS.mine)
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(customerBookingListQuerySchema))
    query: CustomerBookingListQuery,
  ) {
    const { cursor, ...filters } = query;
    return this.bookingsService.listMine(
      user.id,
      cursor,
      MINE_PAGE_LIMIT,
      filters,
    );
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bookingsService.getOne(user.id, id);
  }

  @Post(`:id/${BOOKING_PATHS.cancel}`)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bookingsService.cancel(user.id, id);
  }

  @Post(`:id/${BOOKING_PATHS.reschedule}`)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rescheduleBookingSchema)) body: RescheduleBookingInput,
  ) {
    return this.bookingsService.reschedule(user.id, id, body);
  }
}
