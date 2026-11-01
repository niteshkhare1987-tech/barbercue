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
  FORECAST_PATHS,
  INVENTORY_PATHS,
  Role,
  forecastSettingsSchema,
  inventoryAnalyticsQuerySchema,
  supplierLeadTimeSchema,
  type AuthenticatedUser,
  type ForecastSettingsInput,
  type InventoryAnalyticsQuery,
  type SupplierLeadTimeInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { InventoryForecastService } from './inventory-forecast.service';

const ROOT = `dashboard/salons/:salonId/${INVENTORY_PATHS.root}`;

/**
 * Inventory Phase 3 — Smart Prediction (owner/admin): per-product predictions, forecasting
 * assumptions, supplier lead times, stock alerts and period analytics.
 */
@Controller()
@Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
export class InventoryForecastController {
  constructor(private readonly forecast: InventoryForecastService) {}

  @Get(`${ROOT}/${FORECAST_PATHS.predictions}`)
  predictions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.forecast.predictions(user.id, salonId);
  }

  @Put(`${ROOT}/${FORECAST_PATHS.settings}`)
  putSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(forecastSettingsSchema))
    body: ForecastSettingsInput,
  ) {
    return this.forecast.putSettings(user.id, salonId, body);
  }

  @Put(
    `${ROOT}/${INVENTORY_PATHS.suppliers}/:supplierId/${FORECAST_PATHS.leadTime}`,
  )
  setLeadTime(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body(new ZodValidationPipe(supplierLeadTimeSchema))
    body: SupplierLeadTimeInput,
  ) {
    return this.forecast.setSupplierLeadTime(
      user.id,
      salonId,
      supplierId,
      body,
    );
  }

  @Post(`${ROOT}/${FORECAST_PATHS.runAlerts}`)
  @HttpCode(HttpStatus.OK)
  runAlerts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.forecast.runAlertsNow(user.id, salonId);
  }

  @Post(`${ROOT}/${FORECAST_PATHS.alerts}/:alertId/${FORECAST_PATHS.dismiss}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('alertId', ParseUUIDPipe) alertId: string,
  ) {
    return this.forecast.dismissAlert(user.id, salonId, alertId);
  }

  @Get(`${ROOT}/${FORECAST_PATHS.analytics}`)
  analytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(inventoryAnalyticsQuerySchema))
    query: InventoryAnalyticsQuery,
  ) {
    return this.forecast.analytics(user.id, salonId, query);
  }
}
