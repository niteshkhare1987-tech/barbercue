import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  INVENTORY_PATHS,
  Role,
  SERVICE_USAGE_PATHS,
  inventoryDashboardQuerySchema,
  putServiceRecipeSchema,
  recordServiceUsageSchema,
  reverseServiceUsageSchema,
  serviceVisitsQuerySchema,
  type AuthenticatedUser,
  type InventoryDashboardQuery,
  type PutServiceRecipeInput,
  type RecordServiceUsageInput,
  type ReverseServiceUsageInput,
  type ServiceVisitsQuery,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ServiceUsageService } from './service-usage.service';

const ROOT = `dashboard/salons/:salonId/${INVENTORY_PATHS.root}`;
const VISIT = `dashboard/${SERVICE_USAGE_PATHS.queueEntries}/:queueEntryId/${SERVICE_USAGE_PATHS.productUsage}`;

/**
 * Inventory Phase 2 — Service Consumption. Owner/admin: service recipes, the visits list (to fill in
 * or correct products used), corrections and the inventory dashboard. Barbers additionally reach
 * the two per-visit routes, limited in the service to visits they are serving.
 */
@Controller()
export class ServiceUsageController {
  constructor(private readonly usage: ServiceUsageService) {}

  @Get(`${ROOT}/${SERVICE_USAGE_PATHS.recipes}`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  listRecipes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.usage.listRecipes(user.id, salonId);
  }

  @Put(`${ROOT}/${SERVICE_USAGE_PATHS.recipes}/:serviceId`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  putRecipe(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body(new ZodValidationPipe(putServiceRecipeSchema))
    body: PutServiceRecipeInput,
  ) {
    return this.usage.putRecipe(user.id, salonId, serviceId, body);
  }

  @Get(`${ROOT}/${SERVICE_USAGE_PATHS.visits}`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  listVisits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(serviceVisitsQuerySchema))
    query: ServiceVisitsQuery,
  ) {
    return this.usage.listVisits(user.id, salonId, query);
  }

  @Post(
    `${ROOT}/${SERVICE_USAGE_PATHS.usage}/:usageId/${SERVICE_USAGE_PATHS.reverse}`,
  )
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('usageId', ParseUUIDPipe) usageId: string,
    @Body(new ZodValidationPipe(reverseServiceUsageSchema))
    body: ReverseServiceUsageInput,
  ) {
    return this.usage.reverse(user.id, salonId, usageId, body);
  }

  @Get(`${ROOT}/${SERVICE_USAGE_PATHS.dashboard}`)
  @Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  dashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(inventoryDashboardQuerySchema))
    query: InventoryDashboardQuery,
  ) {
    return this.usage.dashboard(user.id, salonId, query);
  }

  @Get(VISIT)
  @Roles(Role.SALON_STAFF, Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  visitOptions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('queueEntryId', ParseUUIDPipe) queueEntryId: string,
  ) {
    return this.usage.getVisitOptions(user.id, queueEntryId);
  }

  @Post(VISIT)
  @Roles(Role.SALON_STAFF, Role.SALON_OWNER, Role.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Param('queueEntryId', ParseUUIDPipe) queueEntryId: string,
    @Body(new ZodValidationPipe(recordServiceUsageSchema))
    body: RecordServiceUsageInput,
  ) {
    return this.usage.recordForVisit(user.id, queueEntryId, body);
  }
}
