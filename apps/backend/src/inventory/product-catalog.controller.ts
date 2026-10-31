import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import {
  CATALOG_PATHS,
  INVENTORY_PATHS,
  Role,
  SALON_PHOTO_UPLOAD,
  catalogLookupQuerySchema,
  receiveCatalogStockSchema,
  submitCatalogProductSchema,
  transferStockSchema,
  type AuthenticatedUser,
  type CatalogLookupQuery,
  type ReceiveCatalogStockInput,
  type SubmitCatalogProductInput,
  type TransferStockInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  detectImageMimeType,
  extensionForMimeType,
} from '../storage/image-signature';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ProductCatalogService } from './product-catalog.service';

const ROOT = `dashboard/salons/:salonId/${INVENTORY_PATHS.root}`;
const CATALOG = `${ROOT}/${CATALOG_PATHS.catalog}`;

/**
 * Inventory Phase 1, salon side: barcode lookup against the Global Product Master, submitting an
 * unknown product (with packaging photos), receiving stock of a catalog product, and moving stock
 * between the professional and retail shelves. Owner/admin only, like the rest of inventory.
 */
@Controller()
@Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN)
export class ProductCatalogController {
  constructor(
    private readonly catalog: ProductCatalogService,
    private readonly salonAccess: SalonAccessService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get(`${CATALOG}/${CATALOG_PATHS.lookup}`)
  lookup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(catalogLookupQuerySchema))
    query: CatalogLookupQuery,
  ) {
    return this.catalog.lookup(user.id, salonId, query);
  }

  @Post(`${CATALOG}/${CATALOG_PATHS.products}`)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(submitCatalogProductSchema))
    body: SubmitCatalogProductInput,
  ) {
    return this.catalog.submit(user.id, salonId, body);
  }

  /** A packaging photo for a product being submitted; the file type is checked from its bytes. */
  @Post(`${CATALOG}/${CATALOG_PATHS.images}`)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: SALON_PHOTO_UPLOAD.maxBytes, files: 1 },
    }),
  )
  async uploadImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ url: string }> {
    await this.salonAccess.assertOwnerOrAdminAccess(user.id, salonId);
    if (!file?.buffer?.length)
      throw new AppException(
        'PHOTO_REQUIRED',
        'Choose a photo to upload.',
        HttpStatus.BAD_REQUEST,
      );
    const mime = detectImageMimeType(file.buffer);
    if (!mime)
      throw new AppException(
        'PHOTO_TYPE_NOT_ALLOWED',
        'Use a JPEG, PNG or WebP photo.',
        HttpStatus.BAD_REQUEST,
      );
    const key = `catalog-products/${salonId}/${randomUUID()}.${extensionForMimeType(mime)}`;
    return { url: await this.storage.putPublicObject(key, file.buffer, mime) };
  }

  @Post(`${ROOT}/${CATALOG_PATHS.receive}`)
  async receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(receiveCatalogStockSchema))
    body: ReceiveCatalogStockInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalog.receive(
      user.id,
      salonId,
      idempotencyKey,
      body,
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Post(
    `${ROOT}/${INVENTORY_PATHS.products}/:productId/${CATALOG_PATHS.transfer}`,
  )
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(transferStockSchema)) body: TransferStockInput,
  ) {
    return this.catalog.transfer(
      user.id,
      salonId,
      productId,
      idempotencyKey,
      body,
    );
  }
}
