import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminCommerceService } from './admin-commerce.service';
import {
  AdminCommerceController,
  SalonCommerceController,
  ShopController,
  SupplierPortalController,
} from './commerce.controller';
import { MarketplaceService } from './marketplace.service';
import { PurchaseOrderService } from './purchase-order.service';
import { SupplierService } from './supplier.service';

/** Inventory Phases 4–5: supplier marketplace, purchase orders, salon and customer selling. */
@Module({
  imports: [NotificationsModule],
  controllers: [
    SalonCommerceController,
    SupplierPortalController,
    ShopController,
    AdminCommerceController,
  ],
  providers: [
    PurchaseOrderService,
    SupplierService,
    MarketplaceService,
    AdminCommerceService,
  ],
})
export class CommerceModule {}
