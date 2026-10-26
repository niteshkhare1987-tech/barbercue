import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { CommandCenter } from '../CommandCenter';
import { csvCell, describeChange, formatKpi, shopsCsv } from '../format';
import { presetRange } from '../../shop-activity-range';
import { apiFetch } from '../../../../lib/api';

jest.mock('../../../../lib/api', () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {},
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }) => <a href={href}>{children}</a>,
}));

const NOW = new Date('2026-10-26T20:00:00.000Z'); // 27 Oct 01:30 IST

const k = (current, previous) => ({ current, previous });
function overview(from, to) {
  return {
    from,
    to,
    previousFrom: '2026-08-29',
    previousTo: '2026-09-27',
    timeZone: 'Asia/Kolkata',
    generatedAt: NOW.toISOString(),
    kpis: {
      registeredSalons: k(12, 10),
      newSalons: k(2, 1),
      servingSalons: k(5, 4),
      appointmentsBooked: k(40, 32),
      appointmentsCompleted: k(30, 30),
      walkInsServed: k(20, 10),
      completedVisits: k(50, 40),
      cancelled: k(4, 2),
      noShow: k(1, 0),
      cancellationRatePercent: k(11.4, 6.3),
      noShowRatePercent: k(3.2, null),
      completedServiceValuePaise: k(1750000, 1400000),
      walkInValueEstimatePaise: k(600000, 300000),
      averageVisitValuePaise: k(35000, 35000),
      completedServiceMinutes: k(1500, 1200),
      openSalonsNow: 9,
      platformRevenuePaise: null,
    },
    trend: [
      { date: from, appointmentsCompleted: 2, walkInsServed: 1, serviceValuePaise: 1000 },
      { date: to, appointmentsCompleted: 0, walkInsServed: 3, serviceValuePaise: 2000 },
    ],
    adoption: {
      asOf: '2026-10-27',
      windowDays: 30,
      totalSalons: 12,
      counts: { HIGHLY_ACTIVE: 3, MODERATELY_ACTIVE: 2, LOW_USAGE: 1, AT_RISK: 1, DORMANT: 2, NEVER_ACTIVATED: 2, RECENTLY_ONBOARDED: 1 },
    },
    shops: [
      { id: 'a', publicId: 'BC-1', name: 'Alpha Salon', city: 'Pune', status: 'ACTIVE', registeredAt: NOW.toISOString(), adoption: 'HIGHLY_ACTIVE', completedVisits: 30, appointmentsCompleted: 20, walkInsServed: 10, cancelled: 2, noShow: 1, serviceValuePaise: 1000000 },
      { id: 'b', publicId: 'BC-2', name: '=HYPERLINK("x")', city: 'Delhi', status: 'ACTIVE', registeredAt: NOW.toISOString(), adoption: 'AT_RISK', completedVisits: 20, appointmentsCompleted: 10, walkInsServed: 10, cancelled: 2, noShow: 0, serviceValuePaise: 750000 },
    ],
    shopsTotal: 2,
    shopsLimit: 100,
  };
}

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));

async function render() {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<CommandCenter />);
  });
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  return tree;
}

describe('command center formatting', () => {
  it('shows "—" for figures that cannot be measured, never 0', () => {
    expect(formatKpi(null, 'percent')).toBe('—');
    expect(formatKpi(null, 'money')).toBe('—');
  });

  it('writes change out in words, with percentage points for rates', () => {
    expect(describeChange(k(50, 40), 'count')).toEqual({ text: '+10 (+25%)', direction: 'up' });
    expect(describeChange(k(11.4, 6.3), 'percent')).toEqual({ text: '+5.1 pts', direction: 'up' });
    expect(describeChange(k(3, 0), 'count')).toEqual({ text: '+3', direction: 'up' });
    expect(describeChange(k(3.2, null), 'percent')).toEqual({ text: 'No comparison', direction: 'none' });
    expect(describeChange(k(5, 5), 'count')).toEqual({ text: 'No change', direction: 'flat' });
  });

  it('neutralises spreadsheet formulas in CSV exports', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell(-5)).toBe('"-5"');
    const csv = shopsCsv(overview('2026-09-28', '2026-10-27'));
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(csv).toContain('"BC-1","Alpha Salon","Pune","ACTIVE","Highly active","30","20","10","2","1","10000.00"');
  });

  it('builds calendar-month quick picks in India time', () => {
    expect(presetRange('thisMonth', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-27' });
    expect(presetRange('lastMonth', NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('lastMonth', new Date('2026-03-10T06:00:00Z'))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('CommandCenter', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    globalThis.window = { setTimeout, clearTimeout };
    apiFetch.mockReset();
    apiFetch.mockImplementation((path) => {
      const url = new URL(`http://x/${path}`);
      return Promise.resolve(overview(url.searchParams.get('from'), url.searchParams.get('to')));
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete globalThis.window;
  });

  it('loads the last 30 IST days from the analytics overview by default', async () => {
    await render();
    const url = new URL(`http://x/${apiFetch.mock.calls[0][0]}`);
    expect(url.pathname).toBe('/admin/analytics/overview');
    expect([url.searchParams.get('from'), url.searchParams.get('to')]).toEqual(['2026-09-28', '2026-10-27']);
  });

  it('renders every KPI with its change, and platform revenue as not tracked rather than zero', async () => {
    const tree = await render();
    const tiles = tree.root.findAll((n) => n.type === 'article');
    const byLabel = Object.fromEntries(tiles.map((t) => [textOf(t.findByType('h3')), t]));

    expect(textOf(byLabel['Completed visits'].findByType('strong'))).toBe('50');
    expect(textOf(byLabel['Completed visits'])).toContain('+10 (+25%)');
    expect(textOf(byLabel['Completed service value'].findByType('strong'))).toBe('₹17,500');
    expect(textOf(byLabel['Completed service value'])).toContain('Includes ₹6,000 estimated walk-in value');
    expect(textOf(byLabel['No-show rate'])).toContain('No comparison');
    expect(textOf(byLabel['Serving salons'])).toContain('9 open for customers right now');
    expect(textOf(byLabel['FastQue platform revenue'].findByType('strong'))).toBe('Not tracked yet');
  });

  it('shows the adoption split with counts and shares, and one row per active salon', async () => {
    const tree = await render();
    const adoption = tree.root.find((n) => n.props.className && String(n.props.className).includes('adoptionList'));
    expect(textOf(adoption)).toContain('Highly active3 · 25%');
    expect(textOf(adoption)).toContain('Never activated2 · 17%');

    // The trend chart carries its own screen-reader table; pick the salon table by its caption.
    const table = tree.root.findAllByType('table').find((t) => textOf(t.findByType('caption')).startsWith('Salon performance'));
    const rows = table.findByType('tbody').findAllByType('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].findAllByType('td').map(textOf)).toEqual(['Pune', 'Highly active', '30', '20', '10', '2', '1', '₹10,000']);
  });

  it('switches to a calendar-month preset', async () => {
    const tree = await render();
    const button = tree.root.find((n) => n.type === 'button' && textOf(n) === 'This month');
    await act(async () => button.props.onClick());
    await act(async () => { jest.advanceTimersByTime(1); });
    const url = new URL(`http://x/${apiFetch.mock.calls.at(-1)[0]}`);
    expect([url.searchParams.get('from'), url.searchParams.get('to')]).toEqual(['2026-10-01', '2026-10-27']);
  });
});
