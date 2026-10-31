import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AdminInventoryController } from './admin-inventory.controller';
import { AdminInventoryService } from './admin-inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { OpenBeautyFactsClient } from './open-beauty-facts.client';
import { ProductCatalogController } from './product-catalog.controller';
import { ProductCatalogService } from './product-catalog.service';

@Module({
  imports: [StorageModule],
  controllers: [
    InventoryController,
    ProductCatalogController,
    AdminInventoryController,
  ],
  providers: [
    InventoryService,
    ProductCatalogService,
    AdminInventoryService,
    OpenBeautyFactsClient,
  ],
})
export class InventoryModule {}
