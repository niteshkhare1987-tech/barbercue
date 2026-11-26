import { Module } from '@nestjs/common';
import { ShopCatalogService } from './shop-catalog.service';
import { ShopOrderService } from './shop-order.service';
import { ShopSellerService } from './shop-seller.service';
import {
  ShopAdminController,
  ShopCustomerController,
  ShopOwnerController,
  ShopPublicController,
} from './shop.controller';

/** FastQue Marketplace — the public beauty marketplace on top of the inventory master catalog. */
@Module({
  controllers: [
    ShopPublicController,
    ShopCustomerController,
    ShopOwnerController,
    ShopAdminController,
  ],
  providers: [ShopCatalogService, ShopOrderService, ShopSellerService],
  // Used by CommerceModule to place salon orders from a mixed bag.
  exports: [ShopOrderService],
})
export class ShopModule {}
