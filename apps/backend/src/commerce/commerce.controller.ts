import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import {
  ADMIN_PATHS,
  COMMERCE_PATHS as P,
  CommerceErrorCode,
  INVENTORY_PATHS,
  Role,
  adminResolveSchema,
  adminReviewSchema,
  cancelSchema,
  completePickupSchema,
  createListingSchema,
  createPurchaseOrderSchema,
  disputeSchema,
  goodsReceiptSchema,
  placeMarketOrderSchema,
  returnDecisionSchema,
  returnRequestSchema,
  shopProductQuerySchema,
  supplierApplicationSchema,
  supplierOfferSchema,
  supplierOrderDecisionSchema,
  updateSupplierProfileSchema,
  type AdminReviewInput,
  type AuthenticatedUser,
  type CancelInput,
  type CompletePickupInput,
  type CreateListingInput,
  type CreatePurchaseOrderInput,
  type GoodsReceiptInput,
  type PlaceMarketOrderInput,
  type ShopProductQuery,
  type SupplierApplicationInput,
  type SupplierOfferInput,
  type SupplierOrderDecisionInput,
  type UpdateSupplierProfileInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppException } from '../common/exceptions/app.exception';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AdminCommerceService } from './admin-commerce.service';
import { MarketplaceService } from './marketplace.service';
import { PurchaseOrderService } from './purchase-order.service';
import { SupplierService } from './supplier.service';

const ROOT = `dashboard/salons/:salonId/${INVENTORY_PATHS.root}`;
const OWNER = [Role.SALON_OWNER, Role.PLATFORM_ADMIN];
const reasonSchema = z
  .object({ reason: z.string().trim().min(3).max(300) })
  .strict();
const urlSchema = z.object({ url: z.string().trim().url().max(500) }).strict();
const linkSchema = z
  .object({ marketplaceSupplierId: z.string().uuid().nullable() })
  .strict();
const compareSchema = z
  .object({
    globalProductId: z.string().uuid(),
    quantity: z.coerce.number().positive().max(100000),
  })
  .strict();
const qSchema = z.object({ q: z.string().trim().max(80).optional() }).strict();
const statusSchema = z
  .object({ status: z.string().trim().max(30).optional() })
  .strict();
const cityQuery = z.object({ cityId: z.string().uuid().optional() }).strict();

function csvText(file: Express.Multer.File | undefined): string {
  if (!file?.buffer?.length)
    throw new AppException(
      CommerceErrorCode.OFFER_INVALID,
      'Choose a CSV file.',
      HttpStatus.BAD_REQUEST,
    );
  const text = file.buffer.toString('utf8');
  if (text.includes('\u0000'))
    throw new AppException(
      CommerceErrorCode.OFFER_INVALID,
      'That is not a CSV text file.',
      HttpStatus.BAD_REQUEST,
    );
  // Drop a byte-order mark some spreadsheet apps add.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
const csvUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 1_000_000, files: 1 },
});

/** A route `:action` limited to known words (path patterns can't do this in this Express version). */
function oneOf<T extends string>(action: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(action))
    throw new AppException(
      CommerceErrorCode.NOT_FOUND,
      'Unknown action.',
      HttpStatus.NOT_FOUND,
    );
  return action as T;
}

/** Salon side of B2B purchasing and selling (owner / delegated admin). */
@Controller()
@Roles(...OWNER)
export class SalonCommerceController {
  constructor(
    private readonly pos: PurchaseOrderService,
    private readonly market: MarketplaceService,
  ) {}

  @Get(`${ROOT}/${P.compare}`)
  compare(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(compareSchema))
    q: z.infer<typeof compareSchema>,
  ) {
    return this.pos.compare(u.id, salonId, q.globalProductId, q.quantity);
  }

  @Get(`${ROOT}/marketplace-suppliers`)
  suppliers(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.pos.marketplaceSuppliers(u.id, salonId);
  }

  @Get(`${ROOT}/marketplace-suppliers/:supplierId/offers`)
  supplierCatalog(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ) {
    return this.pos.supplierCatalog(u.id, salonId, supplierId);
  }

  @Put(`${ROOT}/${INVENTORY_PATHS.suppliers}/:supplierId/${P.linkSupplier}`)
  link(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body(new ZodValidationPipe(linkSchema)) b: z.infer<typeof linkSchema>,
  ) {
    return this.pos.linkSupplier(
      u.id,
      salonId,
      supplierId,
      b.marketplaceSupplierId,
    );
  }

  @Get(`${ROOT}/${P.purchaseOrders}`)
  listPos(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.pos.list(u.id, salonId);
  }

  @Post(`${ROOT}/${P.purchaseOrders}`)
  createPo(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(createPurchaseOrderSchema))
    b: CreatePurchaseOrderInput,
  ) {
    return this.pos.create(u.id, salonId, b);
  }

  @Get(`${ROOT}/${P.purchaseOrders}/:id`)
  getPo(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.pos.get(u.id, salonId, id);
  }

  @Post(`${ROOT}/${P.purchaseOrders}/:id/${P.place}`)
  @HttpCode(HttpStatus.OK)
  placePo(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.pos.place(u.id, salonId, id);
  }

  @Post(`${ROOT}/${P.purchaseOrders}/:id/${P.cancel}`)
  @HttpCode(HttpStatus.OK)
  cancelPo(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelSchema)) b: CancelInput,
  ) {
    return this.pos.cancel(u.id, salonId, id, b);
  }

  @Post(`${ROOT}/${P.purchaseOrders}/:id/${P.invoice}`)
  @HttpCode(HttpStatus.OK)
  invoice(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(urlSchema)) b: z.infer<typeof urlSchema>,
  ) {
    return this.pos.addInvoice(u.id, salonId, id, b.url);
  }

  @Post(`${ROOT}/${P.purchaseOrders}/:id/${P.receive}`)
  @HttpCode(HttpStatus.OK)
  receive(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(new ZodValidationPipe(goodsReceiptSchema)) b: GoodsReceiptInput,
  ) {
    return this.pos.receive(u.id, salonId, id, key, b);
  }

  // Listings (selling)
  @Get(`${ROOT}/${P.listings}`)
  listings(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.market.myListings(u.id, salonId);
  }

  @Post(`${ROOT}/${P.listings}`)
  createListing(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Body(new ZodValidationPipe(createListingSchema)) b: CreateListingInput,
  ) {
    return this.market.createListing(u.id, salonId, b);
  }

  @Post(`${ROOT}/${P.listings}/:id/:action`)
  @HttpCode(HttpStatus.OK)
  listingAction(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'pause' | 'resume' | 'end',
  ) {
    return this.market.setListingStatus(
      u.id,
      salonId,
      id,
      oneOf(action, ['pause', 'resume', 'end'] as const),
    );
  }

  // Orders this salon is selling
  @Get(`${ROOT}/${P.sales}`)
  sales(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.market.sellerOrders(u.id, salonId);
  }

  @Post(`${ROOT}/${P.sales}/:id/${P.cancel}`)
  @HttpCode(HttpStatus.OK)
  sellerCancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>,
  ) {
    return this.market.sellerAction(u.id, salonId, id, 'cancel', b.reason);
  }

  @Post(`${ROOT}/${P.sales}/:id/${P.complete}`)
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(completePickupSchema)) b: CompletePickupInput,
  ) {
    return this.market.completePickup(u.id, salonId, id, b);
  }

  @Post(`${ROOT}/${P.sales}/:id/${P.returnDecision}`)
  @HttpCode(HttpStatus.OK)
  returnDecision(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(returnDecisionSchema))
    b: { approve: boolean; note?: string | null },
  ) {
    return this.market.returnDecision(u.id, salonId, id, b.approve, b.note);
  }

  @Post(`${ROOT}/${P.sales}/:id/:action`)
  @HttpCode(HttpStatus.OK)
  sellerAction(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'accept' | 'ready' | 'dispatch' | 'mark-paid',
  ) {
    return this.market.sellerAction(
      u.id,
      salonId,
      id,
      oneOf(action, ['accept', 'ready', 'dispatch', 'mark-paid'] as const),
    );
  }

  // Buying from other salons
  @Get(`${ROOT}/${P.salonMarket}`)
  salonMarket(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Query(new ZodValidationPipe(qSchema)) q: z.infer<typeof qSchema>,
  ) {
    return this.market.salonMarket(u.id, salonId, q.q);
  }

  @Post(`${ROOT}/${P.salonMarket}/orders`)
  placeSalonOrder(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(new ZodValidationPipe(placeMarketOrderSchema))
    b: PlaceMarketOrderInput,
  ) {
    return this.market.placeSalonOrder(u.id, salonId, key, b);
  }

  @Get(`${ROOT}/${P.purchases}`)
  purchases(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
  ) {
    return this.market.salonPurchases(u.id, salonId);
  }

  @Post(`${ROOT}/${P.purchases}/:id/${P.cancel}`)
  @HttpCode(HttpStatus.OK)
  buyerCancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>,
  ) {
    return this.market.buyerCancel(u.id, id, b.reason, salonId);
  }

  @Post(`${ROOT}/${P.purchases}/:id/${P.confirmReceipt}`)
  @HttpCode(HttpStatus.OK)
  confirmReceipt(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.market.confirmReceipt(u.id, salonId, id);
  }

  @Post(`${ROOT}/${P.purchases}/:id/${P.dispute}`)
  @HttpCode(HttpStatus.OK)
  dispute(
    @CurrentUser() u: AuthenticatedUser,
    @Param('salonId', ParseUUIDPipe) salonId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(disputeSchema)) b: { reason: string },
  ) {
    return this.market.dispute(u.id, salonId, id, b.reason);
  }
}

/** Supplier portal: any signed-in user; access = membership of an approved supplier (checked in the service). */
@Controller(P.supplierRoot)
export class SupplierPortalController {
  constructor(private readonly suppliers: SupplierService) {}

  @Get(P.me)
  me(@CurrentUser() u: AuthenticatedUser) {
    return this.suppliers.me(u.id);
  }

  @Post(P.apply)
  apply(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(supplierApplicationSchema))
    b: SupplierApplicationInput,
  ) {
    return this.suppliers.apply(u.id, b);
  }

  @Patch(P.me)
  update(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateSupplierProfileSchema))
    b: UpdateSupplierProfileInput,
  ) {
    return this.suppliers.updateProfile(u.id, b);
  }

  @Get('catalog-search')
  search(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(qSchema)) q: z.infer<typeof qSchema>,
  ) {
    return this.suppliers.searchCatalog(u.id, q.q ?? '');
  }

  @Get(P.offers)
  offers(@CurrentUser() u: AuthenticatedUser) {
    return this.suppliers.listOffers(u.id);
  }

  @Put(P.offers)
  upsertOffer(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(supplierOfferSchema)) b: SupplierOfferInput,
  ) {
    return this.suppliers.upsertOffer(u.id, b);
  }

  @Post(P.offersImportPreview)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(csvUpload)
  preview(
    @CurrentUser() u: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.suppliers.importPreview(u.id, csvText(file));
  }

  @Post(P.offersImportCommit)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(csvUpload)
  commit(
    @CurrentUser() u: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.suppliers.importCommit(u.id, csvText(file));
  }

  @Get(P.supplierOrders)
  orders(@CurrentUser() u: AuthenticatedUser) {
    return this.suppliers.orders(u.id);
  }

  @Post(`${P.supplierOrders}/:id/:action`)
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'confirm' | 'reject' | 'dispatch',
    @Body(new ZodValidationPipe(supplierOrderDecisionSchema))
    b: SupplierOrderDecisionInput,
  ) {
    return this.suppliers.decide(
      u.id,
      id,
      oneOf(action, ['confirm', 'reject', 'dispatch'] as const) === 'confirm'
        ? 'CONFIRMED'
        : action === 'reject'
          ? 'REJECTED'
          : 'DISPATCHED',
      b,
    );
  }
}

/** Customer shop: browsing is public; ordering and order history need a customer sign-in. */
@Controller(P.shopRoot)
export class ShopController {
  constructor(private readonly market: MarketplaceService) {}

  @Public()
  @Get(P.products)
  products(
    @Query(new ZodValidationPipe(shopProductQuerySchema)) q: ShopProductQuery,
  ) {
    return this.market.shopProducts(q);
  }

  @Public()
  @Get(`${P.products}/:globalProductId`)
  product(
    @Param('globalProductId', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(cityQuery)) q: z.infer<typeof cityQuery>,
  ) {
    return this.market.shopProduct(id, q.cityId);
  }

  @Roles(Role.CUSTOMER)
  @Post(P.orders)
  place(
    @CurrentUser() u: AuthenticatedUser,
    @Headers('Idempotency-Key') key: string | undefined,
    @Body(new ZodValidationPipe(placeMarketOrderSchema))
    b: PlaceMarketOrderInput,
  ) {
    return this.market.placeCustomerOrders(u.id, key, b);
  }

  @Roles(Role.CUSTOMER)
  @Get(P.orders)
  orders(@CurrentUser() u: AuthenticatedUser) {
    return this.market.customerOrders(u.id);
  }

  @Roles(Role.CUSTOMER)
  @Post(`${P.orders}/:id/${P.cancel}`)
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>,
  ) {
    return this.market.buyerCancel(u.id, id, b.reason);
  }

  @Roles(Role.CUSTOMER)
  @Post(`${P.orders}/:id/${P.requestReturn}`)
  @HttpCode(HttpStatus.OK)
  requestReturn(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(returnRequestSchema)) b: { reason: string },
  ) {
    return this.market.requestReturn(u.id, id, b.reason);
  }
}

const VIEW = [Role.PLATFORM_ADMIN, Role.CO_FOUNDER, Role.PLATFORM_VIEWER];
const MANAGE = [Role.PLATFORM_ADMIN, Role.CO_FOUNDER];

/** FastQue admin: suppliers, listing moderation, marketplace orders and disputes. */
@Controller(ADMIN_PATHS.admin)
export class AdminCommerceController {
  constructor(
    private readonly admin: AdminCommerceService,
    private readonly market: MarketplaceService,
  ) {}

  @Roles(...VIEW)
  @Get(P.adminSuppliers)
  suppliers(
    @Query(new ZodValidationPipe(statusSchema)) q: z.infer<typeof statusSchema>,
  ) {
    return this.admin.suppliers(q.status);
  }

  @Roles(...MANAGE)
  @Post(`${P.adminSuppliers}/:id/${P.review}`)
  @HttpCode(HttpStatus.OK)
  reviewSupplier(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(adminReviewSchema)) b: AdminReviewInput,
  ) {
    return this.admin.reviewSupplier(u.id, id, b);
  }

  @Roles(...VIEW)
  @Get(P.adminListings)
  listings(
    @Query(new ZodValidationPipe(statusSchema)) q: z.infer<typeof statusSchema>,
  ) {
    return this.admin.listings(q.status);
  }

  @Roles(...MANAGE)
  @Post(`${P.adminListings}/:id/${P.review}`)
  @HttpCode(HttpStatus.OK)
  reviewListing(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(adminReviewSchema)) b: AdminReviewInput,
  ) {
    return this.admin.reviewListing(u.id, id, b);
  }

  @Roles(...VIEW)
  @Get(P.adminOrders)
  orders(
    @Query(new ZodValidationPipe(statusSchema)) q: z.infer<typeof statusSchema>,
  ) {
    return this.admin.orders(q.status);
  }

  @Roles(...MANAGE)
  @Post(`${P.adminOrders}/:id/${P.resolve}`)
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(adminResolveSchema))
    b: { outcome: 'COMPLETED' | 'CANCELLED'; note: string },
  ) {
    return this.market.adminResolve(u.id, id, b.outcome, b.note);
  }
}
