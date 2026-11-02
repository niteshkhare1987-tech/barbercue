import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { MarketOrdersView, PurchaseOrdersView, SellView } from '../CommerceViews';
import { ShopCart, ShopProduct, addToCart } from '../../../shop/Shop';
import { apiFetch } from '../../../../lib/api';

jest.mock('../../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('../../../../lib/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1', roles: ['CUSTOMER'] } }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href, className }) => <a href={href} className={className}>{children}</a> }));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (tree, label) => tree.root.find((n) => n.type === 'button' && textOf(n).includes(label));
const page = (items) => ({ items, nextCursor: null, hasMore: false });

const listing = (over = {}) => ({
  id: 'l1', channel: 'CUSTOMER', status: 'ACTIVE', salonId: 's9', salonName: 'Sharp Gents', cityName: 'Greater Noida', inventoryProductId: 'p1', globalProductId: 'g1',
  title: 'Serum', brand: 'QA', category: 'Serum', unitPrice: '189.00', mrp: '199.00', currency: 'INR', quantityListed: 3, quantityReserved: 0, quantitySold: 0, available: 3,
  batchNumber: null, expiryDate: '2027-12-31', photoUrls: [], description: null, reviewNote: null, createdAt: 'x', ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const store = {};
  globalThis.window = { localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, prompt: jest.fn() };
});
afterEach(() => {
  delete globalThis.window;
});

describe('customer shop', () => {
  it('compares salons for a product and adds to the cart', async () => {
    apiFetch.mockResolvedValue({ globalProductId: 'g1', name: 'Serum', brand: 'QA', category: 'Serum', imageUrl: null, mrp: '199.00', lowestPrice: '189.00', sellerCount: 1, currency: 'INR', description: null, packSize: '100.000', packUnit: 'MILLILITER', offers: [listing()] });
    let tree;
    await act(async () => { tree = TestRenderer.create(<ShopProduct globalProductId="g1" />); });
    await flush();
    expect(apiFetch.mock.calls[0][0]).toBe('shop/products/g1');
    expect(textOf(tree.root)).toContain('Sharp Gents');
    await act(async () => button(tree, 'Add to cart').props.onClick());
    expect(textOf(tree.root)).toContain('Added to your cart');
    expect(JSON.parse(globalThis.window.localStorage.getItem('fastque-shop-cart-v1'))[0]).toMatchObject({ listingId: 'l1', quantity: 1 });
  });

  it('checks out once with pay-at-pickup and shows the pickup code', async () => {
    addToCart(listing(), 2);
    apiFetch.mockResolvedValue([{ id: 'o1', number: 'FQ-1', seller: { name: 'Sharp Gents' }, pickupCode: '123456' }]);
    let tree;
    await act(async () => { tree = TestRenderer.create(<ShopCart />); });
    await flush();
    expect(textOf(tree.root)).toContain('Collect at Sharp Gents');
    await act(async () => button(tree, 'Place order').props.onClick());
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe('shop/orders');
    expect(opts.headers['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(opts.body)).toEqual({ items: [{ listingId: 'l1', quantity: 2 }], paymentMethod: 'PAY_AT_PICKUP' });
    expect(textOf(tree.root)).toContain('123456');
  });
});

describe('owner commerce screens', () => {
  it('builds a purchase order from a FastQue supplier price list', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({ id: 'po1', number: 'PO-0001', status: 'DRAFT', supplier: { kind: 'MARKETPLACE', id: 'sup1', name: 'QA Distributors' }, items: [], receipts: [], invoiceUrls: [], subtotal: '600.00', deliveryCharge: '40.00', total: '640.00', createdAt: '2026-11-02' });
      if (path.endsWith('/purchase-orders')) return Promise.resolve([]);
      if (path.endsWith('/marketplace-suppliers')) return Promise.resolve([{ id: 'sup1', name: 'QA Distributors', deliversToShopCity: true, defaultLeadTimeDays: 2, deliveryCharge: '40.00', freeDeliveryAbove: null, minimumOrderValue: null, offerCount: 1 }]);
      if (path.includes('/marketplace-suppliers/sup1/offers')) return Promise.resolve([{ id: 'of1', globalProductId: 'g1', productName: 'Serum', brand: 'QA', barcode: '5901234123457', imageUrl: null, supplierSku: null, unitPrice: '50.00', minOrderQuantity: 6, availableQuantity: 100, leadTimeDays: null, isActive: true, updatedAt: 'x' }]);
      if (path.includes('salon-market')) return Promise.resolve([]);
      return Promise.resolve(page([]));
    });
    let tree;
    await act(async () => { tree = TestRenderer.create(<PurchaseOrdersView salonId="s1" />); });
    await flush();
    const supplier = tree.root.find((n) => n.type === 'select' && n.props.id === 'po-supplier');
    await act(async () => supplier.props.onChange({ target: { value: 'sup1' } }));
    await flush();
    const qty = tree.root.find((n) => n.type === 'input' && n.props['aria-label'] === 'Quantity of Serum');
    await act(async () => qty.props.onChange({ target: { value: '12' } }));
    await act(async () => button(tree, 'Save draft').props.onClick());
    const post = apiFetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(post[0]).toBe('dashboard/salons/s1/inventory/purchase-orders');
    expect(JSON.parse(post[1].body)).toEqual({ marketplaceSupplierId: 'sup1', items: [{ globalProductId: 'g1', quantity: 12, unitPrice: 50 }] });
    expect(textOf(tree.root)).toContain('PO-0001');
  });

  it('a listing is sent for FastQue review with its photos and sealed confirmation', async () => {
    apiFetch.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({});
      if (path.endsWith('/listings')) return Promise.resolve([]);
      return Promise.resolve(page([{ id: 'p1', name: 'Serum', unit: 'EACH', stockOnHand: '8.000', isActive: true, globalProductId: 'g1' }]));
    });
    let tree;
    await act(async () => { tree = TestRenderer.create(<SellView salonId="s1" />); });
    await flush();
    const set = async (id, value) => act(async () => tree.root.find((n) => (n.type === 'input' || n.type === 'select') && n.props.id === id).props.onChange({ target: { value } }));
    await set('ls-product', 'p1');
    await set('ls-qty', '3');
    await set('ls-price', '189');
    const link = tree.root.findAll((n) => n.type === 'input' && n.props.placeholder?.startsWith('or paste'))[0];
    await act(async () => link.props.onChange({ target: { value: 'https://example.test/p.jpg' } }));
    await act(async () => button(tree, 'Add').props.onClick());
    const sealed = tree.root.find((n) => n.type === 'input' && n.props.type === 'checkbox');
    await act(async () => sealed.props.onChange({ target: { checked: true } }));
    await act(async () => button(tree, 'Send for review').props.onClick());
    const post = apiFetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(JSON.parse(post[1].body)).toMatchObject({ inventoryProductId: 'p1', channel: 'CUSTOMER', quantity: 3, unitPrice: 189, sealed: true, photoUrls: ['https://example.test/p.jpg'] });
    expect(textOf(tree.root)).toContain('Sent to FastQue for review');
  });

  it('a ready customer order is handed over with the pickup code', async () => {
    const order = { id: 'o1', number: 'FQ-1', channel: 'CUSTOMER', status: 'READY_FOR_PICKUP', seller: { name: 'A' }, buyer: { name: null }, items: [{ listingId: 'l1', title: 'Serum', quantity: 2, unitPrice: '189.00' }], total: '378.00', paymentMethod: 'PAY_AT_PICKUP', paid: false, pickupCode: null, createdAt: '2026-11-02' };
    apiFetch.mockImplementation((path, opts) => Promise.resolve(opts?.method ? {} : path.endsWith('/sales') ? [order] : []));
    globalThis.window.prompt.mockReturnValue('123456');
    let tree;
    await act(async () => { tree = TestRenderer.create(<MarketOrdersView salonId="s1" />); });
    await flush();
    expect(textOf(tree.root)).toContain('Ready for pickup');
    await act(async () => button(tree, 'Hand over').props.onClick());
    const post = apiFetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(post[0]).toBe('dashboard/salons/s1/inventory/sales/o1/complete');
    expect(JSON.parse(post[1].body)).toEqual({ pickupCode: '123456', paid: true });
  });
});
