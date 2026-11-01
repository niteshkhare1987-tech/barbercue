import { Module } from '@nestjs/common';
import { AssignmentReleaseModule } from '../queue/assignment-release.module';
import { StorageModule } from '../storage/storage.module';
import { AdminInventoryController } from './admin-inventory.controller';
import { AdminInventoryService } from './admin-inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { OpenBeautyFactsClient } from './open-beauty-facts.client';
import { ProductCatalogController } from './product-catalog.controller';
import { ProductCatalogService } from './product-catalog.service';
import { ServiceUsageController } from './service-usage.controller';
import { ServiceUsageService } from './service-usage.service';

@Module({
  // AssignmentReleaseModule provides the shared ServiceCompletedHook (Phase 2 auto-deduction).
  imports: [StorageModule, AssignmentReleaseModule],
  controllers: [
    InventoryController,
    ProductCatalogController,
    AdminInventoryController,
    ServiceUsageController,
  ],
  providers: [
    InventoryService,
    ProductCatalogService,
    AdminInventoryService,
    OpenBeautyFactsClient,
    ServiceUsageService,
  ],
})
export class InventoryModule {}
