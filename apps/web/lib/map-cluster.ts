// Grid-based marker clustering for the Discover map. Pure (no Leaflet import) so it is unit-tested
// and cheap: points are projected to Web-Mercator pixels at the current zoom and bucketed into
// square cells. One DOM marker per cell, so a city view never renders hundreds of overlapping pins.

export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface Cluster<T extends GeoPoint> {
  key: string;
  lat: number;
  lng: number;
  items: T[];
}

/** Default cell size in screen pixels. Larger = fewer, bigger clusters. */
export const CLUSTER_CELL_PX = 64;

/** At or above this zoom every salon gets its own pin (street level). */
export const CLUSTER_MAX_ZOOM = 16;

/** Ratings are drawn on pins only from this zoom up, where pins have room to be legible. */
export const RATING_BADGE_MIN_ZOOM = 14;

export function projectToPixels(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = 256 * 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function clusterPoints<T extends GeoPoint>(points: T[], zoom: number, cellPx = CLUSTER_CELL_PX): Cluster<T>[] {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (zoom >= CLUSTER_MAX_ZOOM) {
    return valid.map((p) => ({ key: `p:${p.id}`, lat: p.lat, lng: p.lng, items: [p] }));
  }
  const cells = new Map<string, T[]>();
  for (const point of valid) {
    const { x, y } = projectToPixels(point.lat, point.lng, zoom);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(point);
    else cells.set(key, [point]);
  }
  return [...cells.entries()].map(([key, items]) =>
    items.length === 1
      ? { key: `p:${items[0].id}`, lat: items[0].lat, lng: items[0].lng, items }
      : {
          key: `c:${key}`,
          lat: items.reduce((sum, p) => sum + p.lat, 0) / items.length,
          lng: items.reduce((sum, p) => sum + p.lng, 0) / items.length,
          items,
        },
  );
}

/** The rectangle that contains every point, or null when there are none. */
export function boundsOf(points: GeoPoint[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return null;
  return {
    minLat: Math.min(...valid.map((p) => p.lat)),
    maxLat: Math.max(...valid.map((p) => p.lat)),
    minLng: Math.min(...valid.map((p) => p.lng)),
    maxLng: Math.max(...valid.map((p) => p.lng)),
  };
}

/** Rounds bounds for the URL (≈11 m) so tiny pans don't produce new, uncacheable searches. */
export function roundBounds(b: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
  const r = (n: number) => String(Math.round(n * 10_000) / 10_000);
  return { minLat: r(b.minLat), maxLat: r(b.maxLat), minLng: r(b.minLng), maxLng: r(b.maxLng) };
}
