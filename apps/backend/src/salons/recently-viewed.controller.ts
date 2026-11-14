import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  RECENTLY_VIEWED_PATHS,
  Role,
  type AuthenticatedUser,
} from '@barbercue/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RecentlyViewedService } from './recently-viewed.service';

// Customers only, same guard convention as FavoritesController. Never readable by owners/admins.
@Controller(RECENTLY_VIEWED_PATHS.recentlyViewed)
@Roles(Role.CUSTOMER)
export class RecentlyViewedController {
  constructor(private readonly recent: RecentlyViewedService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.recent.list(user.id);
  }

  @Post(':salonId')
  @HttpCode(HttpStatus.OK)
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.recent.record(user.id, salonId);
  }

  @Delete()
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.recent.clear(user.id);
  }

  @Delete(':salonId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.recent.remove(user.id, salonId);
  }
}
