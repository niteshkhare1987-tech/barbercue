import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { ServiceUsageDialog } from '../ServiceUsageDialog';
import { apiFetch } from '../../../../lib/api';

jest.mock('../../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('../../parts', () => ({
  ...jest.requireActual('../../parts'),
  Dialog: ({ title, children }) => <div role="dialog" aria-label={title}>{children}</div>,
}));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const button = (tree, label) => tree.root.find((n) => n.type === 'button' && textOf(n).includes(label));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const product = (id, name, over = {}) => ({
  productId: id, name, brand: null, imageUrl: null, categoryId: 'cat-cream', stockOnHand: '2.000', unit: 'EACH',
  contentSize: '200.000', contentUnit: 'MILLILITER', recentRank: null, ...over,
});
const options = (over = {}) => ({
  queueEntryId: 'q1', salonId: 's1', tokenNumber: 7, customerName: 'Ravi', status: 'IN_SERVICE', hasAnythingToRecord: true,
  products: [product('gel', 'Shave gel', { recentRank: 0 }), product('foam', 'Shave foam'), product('blade', 'Blade', { categoryId: 'cat-blade', contentSize: null, contentUnit: null })],
  services: [
    {
      serviceId: 'shave', serviceName: 'Classic Shave', recorded: null,
      lines: [
        { id: 'r1', inventoryCategoryId: 'cat-cream', categoryName: 'Shaving cream', quantity: '10.000', unit: 'MILLILITER', defaultProductId: null, defaultProductName: null, autoDeduct: false, productIds: ['gel', 'foam'] },
        { id: 'r2', inventoryCategoryId: 'cat-blade', categoryName: 'Blades', quantity: '1.000', unit: 'EACH', defaultProductId: 'blade', defaultProductName: 'Blade', autoDeduct: false, productIds: ['blade'] },
      ],
    },
  ],
  ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('choosing the products used for a service', () => {
  it('shows photo cards per recipe line, preselects only the salon-approved default, and saves then completes', async () => {
    apiFetch.mockImplementation((path, opts) => Promise.resolve(opts?.method === 'POST' ? { services: [] } : options()));
    const onComplete = jest.fn();
    const onSaved = jest.fn();
    let tree;
    await act(async () => { tree = TestRenderer.create(<ServiceUsageDialog queueEntryId="q1" mode="complete" onClose={jest.fn()} onComplete={onComplete} onSaved={onSaved} />); });
    await flush();
    expect(apiFetch.mock.calls[0][0]).toBe('dashboard/queue-entries/q1/product-usage');
    const text = textOf(tree.root);
    expect(text).toContain('Shaving cream · 10 ml');
    expect(text).toContain('Used recently');
    const cards = tree.root.findAll((n) => n.type === 'button' && n.props['aria-pressed'] !== undefined);
    // No cream is assumed; the blade (an owner-set default) is.
    expect(cards.filter((c) => c.props['aria-pressed']).map(textOf)).toEqual([expect.stringContaining('Blade')]);

    await act(async () => cards.find((c) => textOf(c).includes('Shave gel')).props.onClick());
    await act(async () => button(tree, 'Save and complete').props.onClick());
    const [path, opts] = apiFetch.mock.calls[1];
    expect(path).toBe('dashboard/queue-entries/q1/product-usage');
    expect(JSON.parse(opts.body)).toEqual({
      services: [{ serviceId: 'shave', items: [
        { productId: 'gel', quantity: 10, unit: 'MILLILITER', ruleId: 'r1' },
        { productId: 'blade', quantity: 1, unit: 'EACH', ruleId: 'r2' },
      ] }],
    });
    expect(onSaved).toHaveBeenCalledWith('2 products taken off stock.');
    expect(onComplete).toHaveBeenCalled();
  });

  it('services without a recipe complete straight away, exactly as before', async () => {
    apiFetch.mockResolvedValue(options({ hasAnythingToRecord: false }));
    const onComplete = jest.fn();
    const onClose = jest.fn();
    await act(async () => { TestRenderer.create(<ServiceUsageDialog queueEntryId="q1" mode="complete" onClose={onClose} onComplete={onComplete} />); });
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('a barber can always complete without recording, and amounts can be changed', async () => {
    apiFetch.mockImplementation((path, opts) => Promise.resolve(opts?.method === 'POST' ? { services: [] } : options()));
    const onComplete = jest.fn();
    let tree;
    await act(async () => { tree = TestRenderer.create(<ServiceUsageDialog queueEntryId="q1" mode="complete" onClose={jest.fn()} onComplete={onComplete} />); });
    await flush();
    const amount = tree.root.find((n) => n.type === 'input' && n.props.id === 'amt-r2');
    await act(async () => amount.props.onChange({ target: { value: '2' } }));
    await act(async () => button(tree, 'Complete without recording').props.onClick());
    expect(onComplete).toHaveBeenCalled();
    expect(apiFetch.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  });

  it('shows what was already recorded instead of asking again', async () => {
    apiFetch.mockResolvedValue(options({
      services: [{ ...options().services[0], recorded: { id: 'u1', status: 'RECORDED', source: 'AUTO', recordedAt: 'x', staffName: null, items: [{ productId: 'gel', productName: 'Shave gel', quantity: '0.050', unit: 'EACH', enteredQuantity: '10.000', enteredUnit: 'MILLILITER' }] } }],
    }));
    let tree;
    await act(async () => { tree = TestRenderer.create(<ServiceUsageDialog queueEntryId="q1" mode="complete" onClose={jest.fn()} onComplete={jest.fn()} />); });
    await flush();
    expect(textOf(tree.root)).toContain('Already recorded: Shave gel 10 ml');
    expect(button(tree, 'Complete service')).toBeTruthy();
  });
});
