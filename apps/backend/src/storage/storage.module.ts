import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { PrivateObjectStorageService } from './private-object-storage.service';

/**
 * Photo storage — a Railway-mounted volume at launch, S3-compatible object storage (Cloudflare
 * R2) pluggable later without a code change. See ObjectStorageService's doc comment for the
 * driver-selection order.
 *
 * Its own module rather than a provider inside SalonSetupModule: storage is infrastructure, not
 * salon-setup domain logic, and the next consumer that needs it (Style Advisor result images,
 * say) should import this rather than reach into another feature module.
 */
@Module({
  providers: [ObjectStorageService, PrivateObjectStorageService],
  exports: [ObjectStorageService, PrivateObjectStorageService],
})
export class StorageModule {}
