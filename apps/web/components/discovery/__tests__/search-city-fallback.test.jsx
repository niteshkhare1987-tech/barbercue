import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import SearchClient from '../../../app/(public)/search/SearchClient';
import { apiFetch } from '../../../lib/api';

// The City field lists every city with an active salon (GET cities), alphabetically — never a
// global catalogue, and never stuck on "Loading cities…".
const push = jest.fn();
let query = '';
let params = new URLSearchParams();
// Stable per query, like the real hook (a new object every render would refetch in a loop).
const mockSearchParams = () => (params.toString() === query ? params : (params = new URLSearchParams(query)));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => mockSearchParams() }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }) => <a href={href}>{children}</a> }));
jest.mock('../../../lib/auth-context', () => ({ useAuth: () => ({ user: null, status: 'unauthenticated' }) }));
jest.mock('../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class extends Error {} }));
jest.mock('../../discovery/ServiceNameSearchField', () => ({ ServiceNameSearchField: () => null }));
jest.mock('../../ui/SalonImage', () => ({ SalonImage: () => null }));

const cities = [
  { id: 'c2', name: 'Pune', slug: 'pune', countryCode: 'IN', regionCode: null, state: 'Maharashtra', country: 'India' },
  { id: 'c3', name: 'Greater Noida', slug: 'greater-noida', countryCode: 'IN', regionCode: null, state: 'Uttar Pradesh', country: 'India' },
  { id: 'c1', name: 'Bengaluru', slug: 'bengaluru', countryCode: 'IN', regionCode: null, state: 'Karnataka', country: 'India' },
];
const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));

async function render(fail = false) {
  apiFetch.mockImplementation((path) => (path === 'cities' ? (fail ? Promise.reject(new Error('down')) : Promise.resolve(cities)) : Promise.reject(new Error(path))));
  let tree;
  await act(async () => { tree = TestRenderer.create(<SearchClient />); });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  push.mockReset();
  apiFetch.mockReset();
  query = '';
  globalThis.window = { location: { search: '' }, innerHeight: 800, addEventListener() {}, removeEventListener() {}, sessionStorage: { getItem: () => null } };
  globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) }));
});
afterEach(() => { delete globalThis.window; });

it('lists every city with salons alphabetically, and searches the chosen one', async () => {
  const tree = await render();
  const select = tree.root.find((n) => n.type === 'select' && n.props['aria-labelledby'] === 'search-city-label');
  expect(select.findAllByType('option').map(textOf)).toEqual(['All cities', 'Bengaluru, Karnataka', 'Greater Noida, Uttar Pradesh', 'Pune, Maharashtra']);
  expect(textOf(tree.root)).not.toContain('Loading cities');
  expect(apiFetch).not.toHaveBeenCalledWith('countries');
  await act(async () => select.props.onChange({ target: { value: 'pune' } }));
  await act(async () => tree.root.findByProps({ role: 'search' }).props.onSubmit({ preventDefault() {} }));
  expect(push).toHaveBeenLastCalledWith('/search?city=pune&countryCode=IN');
});

it('keeps the city from the link selected, and "All cities" clears it', async () => {
  query = 'city=bengaluru&countryCode=IN';
  window.location.search = '?city=bengaluru&countryCode=IN';
  const tree = await render();
  const select = tree.root.find((n) => n.type === 'select' && n.props['aria-labelledby'] === 'search-city-label');
  expect(select.props.value).toBe('bengaluru');
  // "All cities" really clears the city.
  await act(async () => select.props.onChange({ target: { value: '' } }));
  await act(async () => tree.root.findByProps({ role: 'search' }).props.onSubmit({ preventDefault() {} }));
  expect(push).toHaveBeenLastCalledWith('/search');
});

it('never sits on "Loading cities…" if the city list fails', async () => {
  const tree = await render(true);
  const select = tree.root.find((n) => n.type === 'select' && n.props['aria-labelledby'] === 'search-city-label');
  expect(select.findAllByType('option').map(textOf)).toEqual(['No cities yet']);
});
