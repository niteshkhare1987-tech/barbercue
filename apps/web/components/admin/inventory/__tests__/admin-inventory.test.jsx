import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { Role } from '@barbercue/shared';
import { AdminInventoryOverview } from '../AdminInventoryOverview';
import { AdminProductCatalog } from '../AdminProductCatalog';
import { apiFetch } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth-context';

const replace = jest.fn();
let search = '';
let params = new URLSearchParams();
const stableParams = () => (params.toString() === search ? params : (params = new URLSearchParams(search)));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/dashboard/admin/inventory',
  useSearchParams: () => stableParams(),
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href, className }) => <a href={href} className={className}>{children}</a> }));
jest.mock('../../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('../../../../lib/auth-context', () => ({ useAuth: jest.fn() }));
jest.mock('../../shell/admin-filters', () => ({ useAdminFilters: () => ({ range: { from: '2026-10-01', to: '2026-10-31' } }) }));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const overview = (shops) => ({
  range: { from: '2026-10-01', to: '2026-10-31' },
  salonId: null,
  kpis: {
    shopsUsingInventory: shops.length, productsTracked: 12, stockValue: '18250.00', lowStockItems: 2, outOfStockItems: 1,
    purchasesValue: '9500.00', purchaseEntries: 7, consumptionEntries: 15, lossEntries: 1, catalogVerified: 40, catalogPending: 3,
  },
  shops,
  topProducts: [{ globalProductId: 'g1', name: 'Shave Gel', brand: 'Gillette', salons: 2 }],
});
const shop = (id, name) => ({ salonId: id, name, city: 'Greater Noida', productsTracked: 6, stockValue: '9125.00', lowStockItems: 1, outOfStockItems: 0, movementsInRange: 9, lastStockUpdate: '2026-10-30T10:00:00.000Z' });

beforeEach(() => {
  apiFetch.mockReset();
  replace.mockReset();
  search = '';
});

describe('admin inventory overview', () => {
  it('shows platform KPIs, the shop table and the review prompt', async () => {
    apiFetch.mockResolvedValue(overview([shop('s1', 'Sharp Gents'), shop('s2', 'Glow Ladies')]));
    let tree;
    await act(async () => { tree = TestRenderer.create(<AdminInventoryOverview />); });
    expect(apiFetch).toHaveBeenCalledWith('admin/inventory-overview?from=2026-10-01&to=2026-10-31');
    const text = textOf(tree.root);
    expect(text).toContain('Stock value₹18,250');
    expect(text).toContain('Catalog: to review3');
    expect(text).toContain('3 catalog products are waiting for review');
    expect(tree.root.findByType('tbody').findAllByType('tr')).toHaveLength(2);
  });

  it('filters by shop through the URL, keeping every shop in the picker', async () => {
    search = 'salonId=s2';
    apiFetch.mockImplementation((path) =>
      Promise.resolve(path.includes('salonId=s2') ? { ...overview([shop('s2', 'Glow Ladies')]), salonId: 's2' } : overview([shop('s1', 'Sharp Gents'), shop('s2', 'Glow Ladies')])),
    );
    let tree;
    await act(async () => { tree = TestRenderer.create(<AdminInventoryOverview />); });
    expect(apiFetch).toHaveBeenCalledWith('admin/inventory-overview?from=2026-10-01&to=2026-10-31&salonId=s2');
    const picker = tree.root.find((n) => n.type === 'select' && n.props['aria-label'] === 'Filter by shop');
    expect(picker.findAllByType('option').map(textOf)).toEqual(['All shops', 'Sharp Gents · Greater Noida', 'Glow Ladies · Greater Noida']);
    expect(tree.root.findByType('tbody').findAllByType('tr')).toHaveLength(1);
    act(() => picker.props.onChange({ target: { value: '' } }));
    expect(replace).toHaveBeenCalledWith('/dashboard/admin/inventory');
  });
});

describe('admin product catalog', () => {
  const pending = {
    id: 'g9', name: 'QA Shave Cream', brand: 'QA', category: 'Shaving', packSize: '200.000', packUnit: 'MILLILITER', mrp: '199.00',
    dataSource: 'SALON_SUBMITTED', sourceLicense: null, verificationStatus: 'PENDING', barcodes: [{ display: '8901234567893' }], imageUrls: [],
    submittedBySalon: { id: 's1', name: 'Sharp Gents' }, reviewNote: null, salonsStocking: 2, possibleDuplicates: [{ id: 'g1', name: 'QA Shave Cream', brand: 'QA' }],
  };

  it('lists products to review, warns about duplicates, and verifies', async () => {
    jest.useFakeTimers();
    useAuth.mockReturnValue({ user: { roles: [Role.PLATFORM_ADMIN] } });
    apiFetch.mockResolvedValue({ items: [pending], nextCursor: null, hasMore: false });
    let tree;
    await act(async () => { tree = TestRenderer.create(<AdminProductCatalog />); });
    await act(async () => { jest.runOnlyPendingTimers(); });
    expect(apiFetch.mock.calls[0][0]).toBe('admin/inventory-catalog?limit=25&status=PENDING');
    const text = textOf(tree.root);
    expect(text).toContain('Added by a salon (Sharp Gents)');
    expect(text).toContain('Possible duplicate of: QA Shave Cream');
    await act(async () => tree.root.find((n) => n.type === 'button' && textOf(n) === 'Verify').props.onClick());
    expect(apiFetch).toHaveBeenCalledWith('admin/inventory-catalog/g9', { method: 'PATCH', body: JSON.stringify({ action: 'VERIFY' }) });
    jest.useRealTimers();
  });

  it('viewers can browse but cannot verify or import', async () => {
    jest.useFakeTimers();
    search = 'view=import';
    useAuth.mockReturnValue({ user: { roles: [Role.PLATFORM_VIEWER] } });
    apiFetch.mockResolvedValue({ items: [pending], nextCursor: null, hasMore: false });
    let tree;
    await act(async () => { tree = TestRenderer.create(<AdminProductCatalog />); });
    await act(async () => { jest.runOnlyPendingTimers(); });
    expect(textOf(tree.root)).not.toContain('Import products from a CSV');
    expect(tree.root.findAll((n) => n.type === 'button' && textOf(n) === 'Verify')).toHaveLength(0);
    jest.useRealTimers();
  });

  it('CSV import: check the file first, then import only the new rows', async () => {
    search = 'view=import';
    useAuth.mockReturnValue({ user: { roles: [Role.CO_FOUNDER] } });
    apiFetch.mockImplementation((path) =>
      Promise.resolve(
        path.endsWith('/preview')
          ? { headerErrors: [], summary: { NEW: 1, EXISTS: 1, DUPLICATE_IN_FILE: 0, INVALID: 1 }, rows: [
              { line: 2, barcode: '5901234123457', name: 'Gel', status: 'NEW', errors: [] },
              { line: 3, barcode: '123', name: 'Bad', status: 'INVALID', errors: ['The barcode is too short.'] },
            ] }
          : { created: 1, skipped: 2 },
      ),
    );
    let tree;
    await act(async () => { tree = TestRenderer.create(<AdminProductCatalog />); });
    const fileInput = tree.root.find((n) => n.type === 'input' && n.props.type === 'file');
    act(() => fileInput.props.onChange({ target: { files: [new Blob(['barcode,name'])] } }));
    await act(async () => tree.root.find((n) => n.type === 'button' && textOf(n) === 'Check file').props.onClick());
    expect(textOf(tree.root)).toContain('1 to add · 1 already in the catalog · 0 repeated · 1 with errors');
    expect(textOf(tree.root)).toContain('The barcode is too short.');
    await act(async () => tree.root.find((n) => n.type === 'button' && textOf(n) === 'Import 1 product').props.onClick());
    expect(textOf(tree.root)).toContain('Say where the data came from');
    const [ref, lic] = tree.root.findAll((n) => n.type === 'input' && n.props.maxLength >= 80);
    act(() => ref.props.onChange({ target: { value: 'Distributor list' } }));
    act(() => lic.props.onChange({ target: { value: 'Supplied by distributor' } }));
    await act(async () => tree.root.find((n) => n.type === 'button' && textOf(n) === 'Import 1 product').props.onClick());
    expect(apiFetch.mock.calls.at(-1)[0]).toBe('admin/inventory-catalog/import/commit');
    expect(textOf(tree.root)).toContain('Added 1 product to the catalog as verified. 2 rows were skipped.');
  });
});
