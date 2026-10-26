import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { ShopActivityPanel } from '../ShopActivityPanel';
import { addDays, istToday, presetRange, rangeError } from '../shop-activity-range';
import { apiFetch } from '../../../lib/api';

jest.mock('../../../lib/api', () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {},
}));

// 2026-10-26 20:00 UTC is already 2026-10-27 01:30 in India — the filter must follow IST.
const NOW = new Date('2026-10-26T20:00:00.000Z');

const counts = (bookings, queue) => ({
  bookings: { total: 0, confirmed: 0, completed: 0, cancelled: 0, noShow: 0, ...bookings },
  queue: { joined: 0, served: 0, dropped: 0, liveNow: 0, ...queue },
});

function report(from, to, shops = []) {
  return {
    from,
    to,
    timeZone: 'Asia/Kolkata',
    generatedAt: NOW.toISOString(),
    ...counts({ total: 7, confirmed: 3, completed: 2, cancelled: 1, noShow: 1 }, { joined: 5, served: 3, dropped: 1, liveNow: 2 }),
    shops,
  };
}

const shop = (id, name, c) => ({ id, publicId: `BC-${id}`, name, status: 'ACTIVE', ...c });

function requestedRange(call) {
  const url = new URL(`http://x/${call[0]}`);
  return { path: url.pathname, from: url.searchParams.get('from'), to: url.searchParams.get('to') };
}

const textOf = (node) =>
  typeof node === 'string' ? node : (node.children ?? []).map(textOf).join('');

async function render(props = {}) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<ShopActivityPanel {...props} />);
  });
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  return tree;
}

const button = (tree, label) => tree.root.find((n) => n.type === 'button' && textOf(n) === label);

describe('shop activity date range helpers', () => {
  it('uses the India calendar day, not the browser or UTC day', () => {
    expect(istToday(NOW)).toBe('2026-10-27');
  });

  it('builds inclusive quick-pick ranges that end today', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-10-27', to: '2026-10-27' });
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(presetRange('last7', NOW)).toEqual({ from: '2026-10-21', to: '2026-10-27' });
    expect(presetRange('last30', NOW)).toEqual({ from: '2026-09-28', to: '2026-10-27' });
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('explains invalid custom ranges before any request is sent', () => {
    expect(rangeError('2026-10-01', '2026-10-31')).toBeNull();
    expect(rangeError('', '2026-10-31')).toMatch(/both/);
    expect(rangeError('2026-10-31', '2026-10-01')).toMatch(/on or after/);
    expect(rangeError('2026-01-01', '2026-10-31')).toMatch(/92 days/);
  });
});

describe('ShopActivityPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval };
    globalThis.document = { visibilityState: 'visible' };
    apiFetch.mockReset();
    apiFetch.mockImplementation((path) => {
      const { from, to } = requestedRange([path]);
      return Promise.resolve(
        report(from, to, [
          shop('b', 'Bravo Cuts', counts({ total: 5, confirmed: 2, completed: 2, noShow: 1 }, { joined: 4, served: 3, liveNow: 1 })),
          shop('a', 'Alpha Salon', counts({ total: 2, confirmed: 1, cancelled: 1 }, { joined: 1, dropped: 1, liveNow: 1 })),
        ]),
      );
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete globalThis.window;
    delete globalThis.document;
  });

  it("loads today's IST activity by default and shows platform totals plus one row per shop", async () => {
    const tree = await render();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(requestedRange(apiFetch.mock.calls[0])).toEqual({
      path: '/admin/shop-activity',
      from: '2026-10-27',
      to: '2026-10-27',
    });
    expect(button(tree, 'Today').props['aria-pressed']).toBe(true);

    const totals = tree.root.find((n) => n.props['aria-label'] === 'All shops in this period');
    const totalCells = totals.findAllByType('article').map((a) => textOf(a));
    expect(totalCells).toEqual([
      '7Bookings', '3Confirmed', '2Completed', '1Cancelled', '1No-show',
      '5Queue joined', '3Served', '1Dropped', '2In queue now',
    ]);

    const rows = tree.root.findByType('tbody').findAllByType('tr');
    expect(rows.map((r) => r.findAllByType('td').map(textOf))).toEqual([
      ['5', '2', '2', '0', '1', '4', '3', '0', '1'],
      ['2', '1', '0', '1', '0', '1', '0', '1', '1'],
    ]);
    expect(textOf(rows[0].findByType('th'))).toBe('Bravo CutsBC-b');
  });

  it('refetches with the chosen quick pick', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Last 7 days').props.onClick());
    await act(async () => { jest.advanceTimersByTime(1); });

    expect(requestedRange(apiFetch.mock.calls.at(-1))).toMatchObject({ from: '2026-10-21', to: '2026-10-27' });
    expect(button(tree, 'Last 7 days').props['aria-pressed']).toBe(true);
    expect(button(tree, 'Today').props['aria-pressed']).toBe(false);
  });

  it('applies a valid custom range and blocks an invalid one', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Custom range').props.onClick());

    const input = (id) => tree.root.find((n) => n.type === 'input' && n.props.id === id);
    await act(async () => input('shop-activity-from').props.onChange({ target: { value: '2026-10-30' } }));
    await act(async () => input('shop-activity-to').props.onChange({ target: { value: '2026-10-01' } }));
    expect(button(tree, 'Apply').props.disabled).toBe(true);
    expect(textOf(tree.root.find((n) => n.props.role === 'alert'))).toMatch(/on or after/);

    const callsBefore = apiFetch.mock.calls.length;
    await act(async () => input('shop-activity-from').props.onChange({ target: { value: '2026-10-01' } }));
    await act(async () => input('shop-activity-to').props.onChange({ target: { value: '2026-10-31' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    await act(async () => { jest.advanceTimersByTime(1); });

    expect(apiFetch.mock.calls.length).toBe(callsBefore + 1);
    expect(requestedRange(apiFetch.mock.calls.at(-1))).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
  });

  it("filters shop rows with the admin page's search box", async () => {
    const tree = await render({ search: 'bc-a' });
    const rows = tree.root.findByType('tbody').findAllByType('tr');
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0].findByType('th'))).toBe('Alpha SalonBC-a');
  });

  it('says so plainly when the period had no activity', async () => {
    apiFetch.mockImplementation((path) => {
      const { from, to } = requestedRange([path]);
      return Promise.resolve(report(from, to, []));
    });
    const tree = await render();
    expect(tree.root.findAll((n) => n.type === 'p' && textOf(n) === 'No bookings or queue activity in this period.')).toHaveLength(1);
  });
});
