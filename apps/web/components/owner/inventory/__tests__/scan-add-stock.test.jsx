import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { Role } from '@barbercue/shared';
import { cameraErrorText, createScannerKeyBuffer, parsePackagingText } from '../../../../lib/product-scan';
import { canOpenAdminPath } from '../../../../lib/admin-route-access';
import { adminNavFor } from '../../../admin/shell/admin-nav';
import { BarcodeScanner } from '../BarcodeScanner';
import { ScanAddStock } from '../ScanAddStock';
import { apiFetch } from '../../../../lib/api';

jest.mock('../../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('../../../../lib/use-inventory-lookups', () => ({
  inventoryBase: (id) => `dashboard/salons/${id}/inventory`,
  useInventoryLookups: () => ({ categories: [], suppliers: [{ id: 'sup-1', name: 'Ravi Traders' }], complete: true, loading: false, error: null }),
}));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const byText = (tree, type, text) => tree.root.find((n) => n.type === type && textOf(n).includes(text));
const inputById = (tree, id) => tree.root.find((n) => (n.type === 'input' || n.type === 'select') && n.props.id === id);

describe('packaging text and hardware scanners', () => {
  it('reads labelled MRP and pack size, and suggests name/brand lines', () => {
    const guess = parsePackagingText('GILLETTE\nSensitive Shave Gel\nNet Vol. 195 ml\nMRP ₹ 249.00 (incl. of all taxes)\nMfd by Procter & Gamble');
    expect(guess).toEqual({ brand: 'GILLETTE', name: 'Sensitive Shave Gel', packSize: 195, packUnit: 'MILLILITER', mrp: 249 });
    expect(parsePackagingText('Hair Wax\n१०० g').packSize).toBe(100);
    expect(parsePackagingText('nothing useful').mrp).toBeNull();
  });

  it('treats very fast keys ending in Enter as a scanner, never normal typing', () => {
    const codes = [];
    const feed = createScannerKeyBuffer((c) => codes.push(c));
    '8901234567890'.split('').forEach((k, i) => feed(k, 1000 + i * 10));
    expect(feed('Enter', 1140)).toBe(true);
    'hello12'.split('').forEach((k, i) => feed(k, 5000 + i * 200));
    expect(feed('Enter', 6500)).toBe(false);
    expect(codes).toEqual(['8901234567890']);
  });

  it('explains camera problems in plain words', () => {
    const named = (name) => Object.assign(new Error('x'), { name });
    expect(cameraErrorText(named('NotAllowedError'))).toMatch(/permission was turned off/);
    expect(cameraErrorText(named('NotFoundError'))).toMatch(/No camera was found/);
    expect(cameraErrorText(named('NotReadableError'))).toMatch(/used by another app/);
  });
});

describe('BarcodeScanner', () => {
  beforeEach(() => {
    globalThis.window = { addEventListener: jest.fn(), removeEventListener: jest.fn(), isSecureContext: true };
    globalThis.navigator = {};
  });
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.navigator;
  });

  it('typed barcodes are looked up; the button waits for input', () => {
    const onDetected = jest.fn();
    let tree;
    act(() => { tree = TestRenderer.create(<BarcodeScanner onDetected={onDetected} busy={false} />); });
    const lookUp = byText(tree, 'button', 'Look up');
    expect(lookUp.props.disabled).toBe(true);
    act(() => tree.root.find((n) => n.type === 'input' && n.props.inputMode === 'numeric').props.onChange({ target: { value: ' 5901234123457 ' } }));
    act(() => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(onDetected).toHaveBeenCalledWith('5901234123457', undefined);
  });

  it('says why when the browser has no camera access', async () => {
    let tree;
    act(() => { tree = TestRenderer.create(<BarcodeScanner onDetected={jest.fn()} busy={false} />); });
    await act(async () => byText(tree, 'button', 'Scan with camera').props.onClick());
    expect(textOf(tree.root)).toContain("can't use the camera");
  });
});

describe('Scan / Add stock', () => {
  const found = {
    barcode: { code: '05901234123457', display: '5901234123457', format: 'GTIN' },
    status: 'FOUND',
    pendingProductId: null,
    suggestion: null,
    salonStock: [{ inventoryProductId: 'inv-1', usage: 'PROFESSIONAL', stockOnHand: '4.000', unit: 'MILLILITER' }],
    product: {
      id: 'gp-1', name: 'Sensitive Shave Gel', brand: 'Gillette', packSize: '195.000', packUnit: 'MILLILITER', mrp: '249.00',
      verificationStatus: 'VERIFIED', barcodes: [{ display: '5901234123457' }], imageUrls: [],
    },
  };

  beforeEach(() => {
    apiFetch.mockReset();
    globalThis.window = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    globalThis.navigator = {};
    globalThis.requestAnimationFrame = (fn) => fn();
  });
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.navigator;
  });

  async function scan(tree, code) {
    act(() => tree.root.find((n) => n.type === 'input' && n.props.inputMode === 'numeric').props.onChange({ target: { value: code } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  }

  it('a known product shows its details and stock, and adding stock sends one retry-safe request', async () => {
    apiFetch.mockImplementation((path) =>
      Promise.resolve(path.includes('/lookup') ? found : { product: { name: 'Sensitive Shave Gel', unit: 'MILLILITER', stockOnHand: '14.000' }, movement: {} }),
    );
    let tree;
    await act(async () => { tree = TestRenderer.create(<ScanAddStock salonId="s1" />); });
    await scan(tree, '5901234123457');
    expect(apiFetch.mock.calls[0][0]).toBe('dashboard/salons/s1/inventory/catalog/lookup?barcode=5901234123457');
    const text = textOf(tree.root);
    expect(text).toContain('Sensitive Shave Gel');
    expect(text).toContain('Verified');
    expect(text).toContain('Used on services: 4 ml');

    act(() => inputById(tree, 'recv-qty').props.onChange({ target: { value: '10' } }));
    act(() => inputById(tree, 'recv-cost').props.onChange({ target: { value: '120' } }));
    act(() => inputById(tree, 'recv-supplier').props.onChange({ target: { value: 'sup-1' } }));
    act(() => byText(tree, 'button', 'Sold to customers').props.onClick());
    const receiveForm = tree.root.findAll((n) => n.type === 'form')[1];
    await act(async () => receiveForm.props.onSubmit({ preventDefault() {} }));
    const [path, options] = apiFetch.mock.calls[1];
    expect(path).toBe('dashboard/salons/s1/inventory/receive');
    expect(options.headers['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(options.body)).toMatchObject({ globalProductId: 'gp-1', usage: 'RETAIL', quantity: 10, unitCost: 120, supplierId: 'sup-1', unit: 'EACH' });
    expect(textOf(tree.root)).toContain('You now have 14 ml');
  });

  it('asks for a quantity and price before sending anything', async () => {
    apiFetch.mockResolvedValue(found);
    let tree;
    await act(async () => { tree = TestRenderer.create(<ScanAddStock salonId="s1" />); });
    await scan(tree, '5901234123457');
    await act(async () => tree.root.findAll((n) => n.type === 'form')[1].props.onSubmit({ preventDefault() {} }));
    expect(textOf(tree.root)).toContain('Enter how many you received.');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('an unknown barcode opens the new-product form, which saves it for this salon', async () => {
    apiFetch.mockImplementation((path) =>
      Promise.resolve(
        path.includes('/lookup')
          ? { ...found, status: 'NOT_FOUND', product: null, salonStock: [] }
          : { ...found.product, id: 'gp-new', name: 'QA Wax', verificationStatus: 'PENDING' },
      ),
    );
    let tree;
    await act(async () => { tree = TestRenderer.create(<ScanAddStock salonId="s1" />); });
    await scan(tree, '5901234123457');
    expect(textOf(tree.root)).toContain("isn't in the FastQue catalog yet");
    act(() => inputById(tree, 'new-name').props.onChange({ target: { value: 'QA Wax' } }));
    act(() => inputById(tree, 'new-mrp').props.onChange({ target: { value: '249' } }));
    await act(async () => byText(tree, 'button', 'Save product').props.onClick());
    const [path, options] = apiFetch.mock.calls[1];
    expect(path).toBe('dashboard/salons/s1/inventory/catalog/products');
    expect(JSON.parse(options.body)).toMatchObject({ barcode: '5901234123457', name: 'QA Wax', mrp: 249, dataSource: 'SALON_SUBMITTED' });
    expect(textOf(tree.root)).toContain('Waiting for FastQue review');
  });
});

describe('admin inventory pages', () => {
  it('all admin viewers see the Inventory menu; others do not', () => {
    const ids = (roles) => adminNavFor(roles).filter((i) => i.group === 'INVENTORY').map((i) => i.id);
    expect(ids([Role.PLATFORM_VIEWER])).toEqual(['inventory-overview', 'product-catalog', 'catalog-import']);
    expect(ids([Role.SALES_ADMIN])).toEqual([]);
    expect(canOpenAdminPath([Role.CO_FOUNDER], '/dashboard/admin/inventory/catalog')).toBe(true);
    expect(canOpenAdminPath([Role.HR_ADMIN], '/dashboard/admin/inventory')).toBe(false);
  });
});
