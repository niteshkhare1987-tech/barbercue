import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ADMIN_PATHS,
  CATALOG_IMPORT_MAX_BYTES,
  CATALOG_PATHS,
  CatalogErrorCode,
  Role,
  adminCatalogImportSchema,
  adminCatalogListQuerySchema,
  adminCatalogReviewSchema,
  adminInventoryOverviewQuerySchema,
  type AdminCatalogImportInput,
  type AdminCatalogListQuery,
  type AdminCatalogReviewInput,
  type AdminInventoryOverviewQuery,
  type AuthenticatedUser,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppException } from '../common/exceptions/app.exception';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AdminInventoryService } from './admin-inventory.service';

const VIEW = [Role.PLATFORM_ADMIN, Role.CO_FOUNDER, Role.PLATFORM_VIEWER];
const MANAGE = [Role.PLATFORM_ADMIN, Role.CO_FOUNDER];

function csvText(file: Express.Multer.File | undefined): string {
  if (!file?.buffer?.length)
    throw new AppException(
      CatalogErrorCode.IMPORT_INVALID,
      'Choose a CSV file to import.',
      HttpStatus.BAD_REQUEST,
    );
  const text = file.buffer.toString('utf8');
  if (text.includes('\u0000'))
    throw new AppException(
      CatalogErrorCode.IMPORT_INVALID,
      'That file is not a text CSV file.',
      HttpStatus.BAD_REQUEST,
    );
  return text;
}

const csvUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: CATALOG_IMPORT_MAX_BYTES, files: 1 },
});

/**
 * FastQue admin inventory (Inventory Phase 1): platform-wide and shop-wise inventory KPIs, the
 * Global Product Master review queue, and CSV import. Viewing is open to every admin role; reviews
 * and imports change the shared catalog, so they are platform admin / co-founder only.
 */
@Controller(ADMIN_PATHS.admin)
export class AdminInventoryController {
  constructor(private readonly adminInventory: AdminInventoryService) {}

  @Get(CATALOG_PATHS.adminInventoryOverview)
  @Roles(...VIEW)
  @Header('Cache-Control', 'private, no-store')
  overview(
    @Query(new ZodValidationPipe(adminInventoryOverviewQuerySchema))
    query: AdminInventoryOverviewQuery,
  ) {
    return this.adminInventory.overview(query);
  }

  @Get(CATALOG_PATHS.adminCatalog)
  @Roles(...VIEW)
  @Header('Cache-Control', 'private, no-store')
  listCatalog(
    @Query(new ZodValidationPipe(adminCatalogListQuerySchema))
    query: AdminCatalogListQuery,
  ) {
    return this.adminInventory.listCatalog(query);
  }

  @Patch(`${CATALOG_PATHS.adminCatalog}/:productId`)
  @Roles(...MANAGE)
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(adminCatalogReviewSchema))
    body: AdminCatalogReviewInput,
  ) {
    return this.adminInventory.review(user.id, productId, body);
  }

  @Post(`${CATALOG_PATHS.adminCatalog}/${CATALOG_PATHS.adminImportPreview}`)
  @Roles(...MANAGE)
  @UseInterceptors(csvUpload)
  importPreview(@UploadedFile() file: Express.Multer.File | undefined) {
    return this.adminInventory.importPreview(csvText(file));
  }

  @Post(`${CATALOG_PATHS.adminCatalog}/${CATALOG_PATHS.adminImportCommit}`)
  @Roles(...MANAGE)
  @UseInterceptors(csvUpload)
  importCommit(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(adminCatalogImportSchema))
    body: AdminCatalogImportInput,
  ) {
    return this.adminInventory.importCommit(user.id, csvText(file), body);
  }
}
