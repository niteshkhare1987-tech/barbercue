"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, LayerGroup, Marker } from "leaflet";
import type { SalonListItemDto } from "@barbercue/shared";
import { MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from "../../lib/dashboard-flags";
import { RATING_BADGE_MIN_ZOOM, boundsOf, clusterPoints } from "../../lib/map-cluster";
import styles from "./map.module.css";

type Leaflet = typeof import("leaflet");

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface Props {
  salons: SalonListItemDto[];
  selectedId: string | null;
  onSelect: (salonId: string | null) => void;
  /** The customer's chosen/GPS location, drawn as a dot. */
  origin: { lat: number; lng: number } | null;
  /** Bounds currently applied in the URL ("Search this area"); the map shows them instead of auto-fitting. */
  appliedBounds: MapBounds | null;
  onSearchArea: (bounds: MapBounds) => void;
  loading: boolean;
}

// India-wide fallback view when nothing has coordinates yet.
const DEFAULT_CENTER: [number, number] = [22.6, 79.0];
const DEFAULT_ZOOM = 5;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Leaflet map for Discover. Loaded only when Map View is chosen (this module is imported with
 * next/dynamic, ssr:false). One marker per cluster cell; programmatic moves are flagged so they never
 * trigger "Search this area" or a re-search loop; every listener and the map are removed on unmount.
 */
export default function SalonMap({ salons, selectedId, onSelect, origin, appliedBounds, onSearchArea, loading }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<Leaflet | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const originRef = useRef<Marker | null>(null);
  const programmatic = useRef(false);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [moved, setMoved] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const located = useMemo(
    () => salons.filter((s): s is SalonListItemDto & { lat: number; lng: number } => s.lat !== null && s.lng !== null),
    [salons],
  );
  const withoutCoords = salons.length - located.length;

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    import("leaflet")
      .then((L) => {
        if (cancelled || !containerRef.current) return;
        leafletRef.current = L;
        map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        const tiles = L.tileLayer(MAP_TILE_URL, { attribution: MAP_TILE_ATTRIBUTION, maxZoom: 19 });
        let tileErrors = 0;
        tiles.on("tileerror", () => {
          tileErrors += 1;
          if (tileErrors > 4) setTileError(true);
        });
        tiles.addTo(map);
        layerRef.current = L.layerGroup().addTo(map);
        map.on("zoomend", () => setZoom(map!.getZoom()));
        map.on("moveend", () => {
          if (programmatic.current) {
            programmatic.current = false;
            return;
          }
          setMoved(true);
        });
        map.on("click", () => onSelectRef.current(null));
        mapRef.current = map;
        setZoom(map.getZoom());
        setReady(true);
      })
      .catch(() => setLoadError(true));
    return () => {
      cancelled = true;
      map?.off();
      map?.remove();
      mapRef.current = null;
      layerRef.current = null;
      originRef.current = null;
    };
  }, []);

  // Frame the results (or the applied search area) whenever the result set changes.
  const resultKey = located.map((s) => s.id).join(",");
  const boundsKey = appliedBounds ? `${appliedBounds.minLat},${appliedBounds.maxLat},${appliedBounds.minLng},${appliedBounds.maxLng}` : "";
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!ready || !map || !L) return;
    const target = appliedBounds ?? boundsOf(located);
    programmatic.current = true;
    if (!target) {
      if (origin) map.setView([origin.lat, origin.lng], 12);
      else programmatic.current = false;
    } else if (target.minLat === target.maxLat && target.minLng === target.maxLng) {
      map.setView([target.minLat, target.minLng], 15);
    } else {
      map.fitBounds(
        [
          [target.minLat, target.minLng],
          [target.maxLat, target.maxLng],
        ],
        { padding: [36, 36], maxZoom: 16 },
      );
    }
    setMoved(false);
    // Only a new result set / applied area re-frames the map — never a selection or zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, resultKey, boundsKey]);

  // Customer location dot.
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!ready || !map || !L) return;
    originRef.current?.remove();
    originRef.current = origin
      ? L.marker([origin.lat, origin.lng], {
          icon: L.divIcon({ className: styles.originIcon, html: "<span></span>", iconSize: [18, 18] }),
          interactive: false,
          keyboard: false,
        }).addTo(map)
      : null;
  }, [ready, origin]);

  // Draw clusters / pins for the current zoom.
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    const layer = layerRef.current;
    if (!ready || !map || !L || !layer) return;
    layer.clearLayers();
    for (const cluster of clusterPoints(located, zoom)) {
      if (cluster.items.length > 1) {
        const count = cluster.items.length;
        const size = count >= 25 ? 56 : count >= 10 ? 48 : 40;
        const containsSelected = cluster.items.some((s) => s.id === selectedId);
        L.marker([cluster.lat, cluster.lng], {
          icon: L.divIcon({
            className: `${styles.clusterIcon} ${containsSelected ? styles.clusterSelected : ""}`,
            html: `<span><b>${count}</b><small>salons</small></span>`,
            iconSize: [size, size],
          }),
          title: `${count} salons — zoom in`,
          keyboard: true,
        })
          .on("click", () => {
            const b = boundsOf(cluster.items)!;
            programmatic.current = true;
            map.fitBounds(
              [
                [b.minLat, b.minLng],
                [b.maxLat, b.maxLng],
              ],
              { padding: [48, 48], maxZoom: 17 },
            );
          })
          .addTo(layer);
        continue;
      }
      const salon = cluster.items[0];
      const selected = salon.id === selectedId;
      const showRating = zoom >= RATING_BADGE_MIN_ZOOM && salon.ratingAverage !== null;
      L.marker([salon.lat, salon.lng], {
        icon: L.divIcon({
          className: `${styles.pinIcon} ${selected ? styles.pinSelected : ""}`,
          html: `<span class="${styles.pinHead}">${showRating ? `<i>★${salon.ratingAverage!.toFixed(1)}</i>` : "<em></em>"}</span>`,
          iconSize: [34, 42],
          iconAnchor: [17, 42],
        }),
        title: escapeHtml(salon.name),
        alt: salon.name,
        keyboard: true,
        zIndexOffset: selected ? 1000 : 0,
      })
        .on("click", (event) => {
          event.originalEvent?.stopPropagation();
          onSelectRef.current(salon.id);
        })
        .addTo(layer);
    }
  }, [ready, located, zoom, selectedId]);

  // Bring a salon selected from the list into view (without re-searching).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedId) return;
    const salon = located.find((s) => s.id === selectedId);
    if (!salon) return;
    if (!map.getBounds().pad(-0.1).contains([salon.lat, salon.lng])) {
      programmatic.current = true;
      map.panTo([salon.lat, salon.lng]);
    }
  }, [ready, selectedId, located]);

  function searchArea() {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    setMoved(false);
    onSearchArea({ minLat: b.getSouth(), maxLat: b.getNorth(), minLng: b.getWest(), maxLng: b.getEast() });
  }

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.map} role="region" aria-label="Map of salon results" />
      {!ready && !loadError && <div className={styles.overlayNote} role="status">Loading map…</div>}
      {loadError && (
        <div className={styles.overlayNote} role="alert">
          The map couldn’t load. Your results are still in the list.
        </div>
      )}
      {tileError && <div className={styles.tileError} role="status">Some map tiles didn’t load. Check your connection.</div>}
      {ready && moved && (
        <button type="button" className={styles.searchArea} onClick={searchArea} disabled={loading}>
          {loading ? "Searching…" : "Search this area"}
        </button>
      )}
      {ready && withoutCoords > 0 && (
        <p className={styles.unmapped}>
          {withoutCoords} {withoutCoords === 1 ? "salon has" : "salons have"} no map location yet — shown in the list only.
        </p>
      )}
    </div>
  );
}
