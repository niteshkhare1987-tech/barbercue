import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { AnalyticsView, PredictionsView, ReorderSummary } from '../ForecastViews';
import { apiFetch } from '../../../../lib/api';

jest.mock('../../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }) => <a href={href}>{children}</a> }));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (tree, label) => tree.root.find((n) => n.type === 'button' && textOf(n).includes(label));

const prediction = (over = {}) => ({
  productId: 'p1', name: 'Shave gel', categoryName: 'Shaving cream', supplierName: 'Ravi Traders', unit: 'MILLILITER', stockOnHand: '150.000',
  leadTimeDays: 5, bookedDemand14Days: 0, status: 'ORDER_NOW', confidence: 'HIGH', dailyRate: 25, averageDaily14: 25, averageDaily56: 25, trend: 'STEADY',
  daysLeft: 6, stockOutDate: '2026-11-08', reorderDate: '2026-11-02', reorderPoint: 200, suggestedOrderQuantity: 400,
  explanation: 'Order now: about 6 days left and delivery takes 5 days.', expiry: [], ...over,
});
const predictions = (over = {}) => ({
  asOf: '2026-11-02', method: 'weighted-moving-average-v1',
  settings: { leadTimeDays: 5, safetyDays: 3, coverDays: 14, alertsEnabled: true },
  suppliers: [{ id: 'sup1', name: 'Ravi Traders', leadTimeDays: null }],
  summary: { orderNow: 1, orderSoon: 0, outOfStock: 0, notEnoughData: 1, expiringAtRisk: 1 },
  products: [
    prediction({ expiry: [{ batchNumber: 'B-77', expiryDate: '2026-11-05', receivedAt: 'x', remaining: 100, daysToExpiry: 3, atRisk: 100 }] }),
    prediction({ productId: 'p2', name: 'Blade', unit: 'EACH', stockOnHand: '20.000', status: 'NO_DATA', confidence: 'NOT_ENOUGH_DATA', dailyRate: null, daysLeft: null, stockOutDate: null, reorderDate: null, suggestedOrderQuantity: null, explanation: 'Not enough data: record use for at least a week to get a prediction.' }),
  ],
  alerts: [{ id: 'a1', kind: 'REORDER', productId: 'p1', title: 'Reorder Shave gel', detail: 'Suggested order: 400 ml.', createdAt: 'x' }],
  ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('predictions', () => {
  it('shows the server forecast, says "not enough data" honestly, and lists alerts', async () => {
    apiFetch.mockResolvedValue(predictions());
    let tree;
    await act(async () => { tree = TestRenderer.create(<PredictionsView salonId="s1" />); });
    await flush();
    expect(apiFetch.mock.calls[0][0]).toBe('dashboard/salons/s1/inventory/predictions');
    const t = textOf(tree.root);
    expect(t).toContain('Order now');
    expect(t).toContain('2026-11-02');
    expect(t).toContain('400 ml');
    expect(t).toContain('Batch B-77');
    expect(t).toContain('may not be used in time');
    expect(t).toContain('Not enough data');
    expect(t).toContain('Reorder Shave gel');
  });

  it('saves assumptions and a supplier delivery time, and dismisses an alert', async () => {
    apiFetch.mockImplementation((path, opts) => Promise.resolve(opts?.method ? {} : predictions()));
    let tree;
    await act(async () => { tree = TestRenderer.create(<PredictionsView salonId="s1" />); });
    await flush();
    const input = (id) => tree.root.find((n) => n.type === 'input' && n.props.id === id);
    await act(async () => input('fc-lead').props.onChange({ target: { value: '7' } }));
    await act(async () => input('fc-sup-sup1').props.onChange({ target: { value: '10' } }));
    await act(async () => button(tree, 'Save').props.onClick());
    const puts = apiFetch.mock.calls.filter(([, o]) => o?.method === 'PUT');
    expect(puts[0][0]).toBe('dashboard/salons/s1/inventory/forecast-settings');
    expect(JSON.parse(puts[0][1].body)).toEqual({ leadTimeDays: 7, safetyDays: 3, coverDays: 14, alertsEnabled: true });
    expect(puts[1][0]).toBe('dashboard/salons/s1/inventory/suppliers/sup1/lead-time');
    expect(JSON.parse(puts[1][1].body)).toEqual({ leadTimeDays: 10 });
    await act(async () => button(tree, 'Dismiss').props.onClick());
    expect(apiFetch.mock.calls.some(([p]) => p === 'dashboard/salons/s1/inventory/alerts/a1/dismiss')).toBe(true);
  });

  it('the Overview card lists what to order', async () => {
    apiFetch.mockResolvedValue(predictions());
    let tree;
    await act(async () => { tree = TestRenderer.create(<ReorderSummary salonId="s1" />); });
    await flush();
    expect(textOf(tree.root)).toContain('Shave gel');
    expect(textOf(tree.root)).toContain('order by 2026-11-02');
    expect(textOf(tree.root)).not.toContain('Blade');
  });
});

describe('consumption analytics', () => {
  it('shows totals, weeks and products, and offers a CSV download', async () => {
    apiFetch.mockResolvedValue({
      range: { from: '2026-10-04', to: '2026-11-02' }, currency: 'INR',
      totals: { receivedValue: '200.00', usedValue: '1350.00', lostValue: '0.00', stockValue: '1250.00' },
      byWeek: [{ weekStart: '2026-10-26', usedValue: '350.00', receivedValue: '200.00', lostValue: '0.00' }],
      byCategory: [{ categoryName: 'Shaving cream', usedValue: '1350.00', receivedValue: '200.00' }],
      products: [{ productId: 'p1', name: 'Shave gel', categoryName: 'Shaving cream', unit: 'MILLILITER', receivedQuantity: '100.000', receivedValue: '200.00', usedQuantity: '675.000', usedValue: '1350.00', lostQuantity: '0.000', lostValue: '0.00', stockOnHand: '625.000', stockValue: '1250.00' }],
    });
    let tree;
    await act(async () => { tree = TestRenderer.create(<AnalyticsView salonId="s1" />); });
    await flush();
    expect(apiFetch.mock.calls[0][0]).toBe('dashboard/salons/s1/inventory/analytics?days=30');
    const t = textOf(tree.root);
    expect(t).toContain('₹1,350');
    expect(t).toContain('675 ml');
    expect(t).toContain('2026-10-26');
    expect(button(tree, 'Download CSV').props.disabled).toBe(false);
  });
});
