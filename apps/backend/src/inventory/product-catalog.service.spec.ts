import { CatalogErrorCode } from '@barbercue/shared';
import { overviewRange } from './admin-inventory.service';
import { ProductCatalogService } from './product-catalog.service';

const SALON = 'salon-a';
const product = (over: Record<string, unknown> = {}) => ({
  id: 'gp-1',
  name: 'Shave Gel',
  brand: 'Gillette',
  manufacturer: null,
  category: 'Shaving',
  subcategory: null,
  description: null,
  packSize: null,
  packUnit: 'MILLILITER',
  mrp: null,
  currency: null,
  hsnCode: null,
  gstRatePercent: null,
  productType: 'BOTH',
  dataSource: 'SALON_SUBMITTED',
  sourceReference: null,
  sourceLicense: null,
  verificationStatus: 'VERIFIED',
  submittedBySalonId: 'salon-b',
  createdAt: new Date('2026-10-31T00:00:00Z'),
  updatedAt: new Date('2026-10-31T00:00:00Z'),
  barcodes: [
    { code: '05901234123457', display: '5901234123457', format: 'GTIN' },
  ],
  images: [],
  ...over,
});

function make(
  opts: {
    found?: ReturnType<typeof product> | null;
    external?: unknown;
    earlier?: { productId: string; kind: string } | null;
    existingInventory?: { id: string } | null;
    priorMovements?: number;
  } = {},
) {
  const prisma = {
    globalProductBarcode: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.found === undefined
            ? null
            : opts.found
              ? { product: opts.found }
              : null,
        ),
    },
    globalProduct: {
      findUnique: jest.fn().mockResolvedValue(opts.found ?? null),
    },
    inventoryProduct: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(opts.existingInventory ?? null),
      create: jest.fn().mockResolvedValue({ id: 'inv-new' }),
      update: jest.fn(),
    },
    inventoryMovement: {
      findUnique: jest.fn().mockResolvedValue(opts.earlier ?? null),
      count: jest.fn().mockResolvedValue(opts.priorMovements ?? 0),
    },
    auditLog: { create: jest.fn() },
  };
  const inventory = {
    createMovement: jest
      .fn()
      .mockResolvedValue({ movement: { id: 'm1' }, created: true }),
    getProduct: jest.fn().mockResolvedValue({ id: 'inv' }),
  };
  const salonAccess = {
    assertOwnerOrAdminAccess: jest.fn().mockResolvedValue('OWNER'),
  };
  const obf = { lookup: jest.fn().mockResolvedValue(opts.external ?? null) };
  return {
    service: new ProductCatalogService(
      prisma as never,
      salonAccess as never,
      inventory as never,
      obf as never,
    ),
    prisma,
    inventory,
    obf,
  };
}

describe('catalog lookup', () => {
  it('refuses a barcode whose check digit is wrong', async () => {
    const { service } = make();
    await expect(
      service.lookup('u', SALON, { barcode: '5901234123458' }),
    ).rejects.toMatchObject({ code: CatalogErrorCode.INVALID_BARCODE });
  });

  it('verified products are shown to everyone', async () => {
    const { service } = make({ found: product() });
    const result = await service.lookup('u', SALON, {
      barcode: '5901234123457',
    });
    expect(result).toMatchObject({
      status: 'FOUND',
      product: { name: 'Shave Gel' },
    });
  });

  it('unverified details are shown only to the salon that added them', async () => {
    const own = make({
      found: product({
        verificationStatus: 'PENDING',
        submittedBySalonId: SALON,
      }),
    });
    expect(
      await own.service.lookup('u', SALON, { barcode: '5901234123457' }),
    ).toMatchObject({ status: 'FOUND_PENDING' });
    const other = make({
      found: product({
        verificationStatus: 'PENDING',
        submittedBySalonId: 'salon-b',
      }),
    });
    const result = await other.service.lookup('u', SALON, {
      barcode: '5901234123457',
    });
    expect(result).toMatchObject({
      status: 'PENDING_ELSEWHERE',
      product: null,
      pendingProductId: 'gp-1',
    });
  });

  it('falls back to the outside suggestion (only if switched on), then not found', async () => {
    const withSuggestion = make({
      found: null,
      external: { source: 'OPEN_BEAUTY_FACTS', name: 'X' },
    });
    expect(
      await withSuggestion.service.lookup('u', SALON, {
        barcode: '5901234123457',
      }),
    ).toMatchObject({ status: 'EXTERNAL' });
    expect(withSuggestion.obf.lookup).toHaveBeenCalledWith('5901234123457');
    const nothing = make({ found: null });
    expect(
      await nothing.service.lookup('u', SALON, { barcode: '5901234123457' }),
    ).toMatchObject({ status: 'NOT_FOUND' });
  });
});

describe('receiving catalog stock', () => {
  const input = {
    globalProductId: 'gp-1',
    usage: 'PROFESSIONAL' as const,
    quantity: 5,
    unitCost: 100,
  };

  it('needs an Idempotency-Key', async () => {
    const { service } = make({ found: product() });
    await expect(
      service.receive('u', SALON, undefined, input),
    ).rejects.toMatchObject({ code: 'INVENTORY_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('first stock of a new product is opening stock; later stock is a purchase', async () => {
    const first = make({ found: product() });
    await first.service.receive('u', SALON, 'k1', input);
    expect(first.prisma.inventoryProduct.create).toHaveBeenCalled();
    expect(first.inventory.createMovement.mock.calls[0][4]).toMatchObject({
      kind: 'OPENING',
      quantity: 5,
      unitCost: 100,
    });

    const later = make({
      found: product(),
      existingInventory: { id: 'inv-1' },
      priorMovements: 2,
    });
    await later.service.receive('u', SALON, 'k2', input);
    expect(later.prisma.inventoryProduct.create).not.toHaveBeenCalled();
    expect(later.inventory.createMovement.mock.calls[0][2]).toBe('inv-1');
    expect(later.inventory.createMovement.mock.calls[0][4]).toMatchObject({
      kind: 'PURCHASE',
    });
  });

  it('a retry repeats the original entry (same product and kind), so nothing is counted twice', async () => {
    const { service, prisma, inventory } = make({
      found: product(),
      earlier: { productId: 'inv-1', kind: 'OPENING' },
    });
    await service.receive('u', SALON, 'k1', input);
    expect(prisma.inventoryProduct.create).not.toHaveBeenCalled();
    expect(inventory.createMovement.mock.calls[0][2]).toBe('inv-1');
    expect(inventory.createMovement.mock.calls[0][4]).toMatchObject({
      kind: 'OPENING',
    });
  });

  it("another salon's unreviewed product needs the shop's own name; rejected products can't be used", async () => {
    const pending = make({
      found: product({
        verificationStatus: 'PENDING',
        submittedBySalonId: 'salon-b',
      }),
    });
    await expect(
      pending.service.receive('u', SALON, 'k', input),
    ).rejects.toMatchObject({ code: CatalogErrorCode.NOT_USABLE });
    await pending.service.receive('u', SALON, 'k', {
      ...input,
      name: 'White tube gel',
    });
    expect(
      pending.prisma.inventoryProduct.create.mock.calls[0][0].data.name,
    ).toBe('White tube gel');

    const rejected = make({
      found: product({ verificationStatus: 'REJECTED' }),
    });
    await expect(
      rejected.service.receive('u', SALON, 'k', input),
    ).rejects.toMatchObject({ code: CatalogErrorCode.NOT_USABLE });
  });
});

describe('admin overview date range', () => {
  it('defaults to the last 30 days and refuses a backwards range', () => {
    const r = overviewRange({ to: '2026-10-31' });
    expect(r.from).toBe('2026-10-02');
    expect(r.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(() =>
      overviewRange({ from: '2026-10-31', to: '2026-10-01' }),
    ).toThrow();
  });
});
