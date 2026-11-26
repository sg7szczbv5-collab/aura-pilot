import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MAPS_PROVIDER, pxPerKmToGoogleZoom } from '../maps/config';
import { GoogleCityMap } from '../maps/GoogleCityMap';
import { VectorCityMap, type VectorCityMapProps, type VectorRoute, type VectorZone } from './VectorCityMap';

export interface LatLng {
  lat: number;
  lng: number;
}

export type MapMarkerKind =
  | 'car'
  | 'pickup'
  | 'dropoff'
  | 'pin'
  | 'me'
  | 'dot'
  | 'cluster';

export type MapMarkerTone = 'ink' | 'go' | 'mute' | 'white' | 'danger';

export type MapMarker = {
  id: string;
  pos: LatLng;
  kind: MapMarkerKind;
  heading?: number;
  tone?: MapMarkerTone;
  label?: string;
  sub?: string;
  active?: boolean;
  pulse?: boolean;
  onClick?: () => void;
};

export interface MapRoute {
  id?: string;
  pts?: LatLng[];
  path?: LatLng[];
  width?: number;
  color?: string;
  tone?: MapMarkerTone | string;
  dashed?: boolean;
}

export interface MapZone {
  id?: string;
  center: LatLng;
  radiusKm: number;
  kind?: string;
  label?: string;
  active?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

export type RouteInput = MapRoute | LatLng[];

export type MapPadding =
  | number
  | [number, number, number, number]
  | { top?: number; bottom?: number; left?: number; right?: number };

export interface CityMapProps {
  center?: LatLng;
  zoom?: number;
  markers?: MapMarker[];
  route?: LatLng[];
  routes?: RouteInput[];
  zones?: MapZone[];
  heat?: LatLng[];
  theme?: 'light' | 'dark' | string;
  controls?: boolean;
  labels?: boolean;
  fit?: LatLng[] | boolean;
  fitKey?: string | number;
  padding?: MapPadding;
  interactive?: boolean;
  onPick?: ((pos: LatLng) => void) | Dispatch<SetStateAction<LatLng>>;
  onCenterChange?: ((center: LatLng, zoom?: number) => void) | Dispatch<SetStateAction<LatLng>>;
  children?: ReactNode;
  fallback?: ReactNode;
  className?: string;
}

interface LineFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
}

interface LineFeatureCollection {
  type: 'FeatureCollection';
  features: LineFeature[];
}

const DEFAULT_CENTER: LatLng = {
  lat: 24.7136,
  lng: 46.6753,
};

/**
 * AURA screens give zoom in pixels per kilometre (22 … 260, the CityMap convention also
 * used by GoogleCityMap); values ≥ 21 are converted to a Mapbox zoom level (512-px tiles,
 * hence one level below Google's). Smaller values are taken as a Mapbox zoom already.
 */
export function normalizeMapboxZoom(rawZoom: number | undefined, lat = DEFAULT_CENTER.lat): number {
  if (typeof rawZoom !== 'number' || Number.isNaN(rawZoom)) return 11.5;
  const z = rawZoom >= 21 ? pxPerKmToGoogleZoom(rawZoom, lat) - 1 : rawZoom;
  return Math.min(Math.max(z, 2), 20);
}

const ZONE_COLORS: Record<string, string> = { restricted: '#d64545', high_demand: '#78B83F', airport: '#3f6fd6' };

/** Circle of radiusKm around center as a GeoJSON polygon ring (64 points). */
function circleRing(center: LatLng, radiusKm: number): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return ring;
}

function getMapboxToken(): string {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const globalProcess = (
    globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }
  ).process;

  return (
    viteEnv?.VITE_MAPBOX_ACCESS_TOKEN ||
    viteEnv?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    globalProcess?.env?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    globalProcess?.env?.VITE_MAPBOX_ACCESS_TOKEN ||
    ''
  );
}

function getMarkerColor(marker: MapMarker): string {
  if (marker.tone === 'danger') return '#ef4444';
  if (marker.tone === 'go') return '#10b981';
  if (marker.tone === 'mute') return '#64748b';
  if (marker.tone === 'white') return '#ffffff';
  if (marker.kind === 'pickup') return '#10b981';
  if (marker.kind === 'dropoff') return '#f59e0b';
  if (marker.kind === 'car') return '#0ea5e9';
  return '#111827';
}

function createMarkerElement(marker: MapMarker, showLabels: boolean): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.alignItems = 'center';
  wrapper.style.gap = '4px';
  wrapper.style.cursor = marker.onClick ? 'pointer' : 'default';
  wrapper.style.userSelect = 'none';

  const dot = document.createElement('div');
  const size = marker.active ? 18 : marker.kind === 'cluster' ? 24 : 14;
  const color = getMarkerColor(marker);

  dot.style.width = `${size}px`;
  dot.style.height = `${size}px`;
  dot.style.borderRadius = marker.kind === 'dropoff' ? '3px' : '9999px';
  dot.style.backgroundColor = color;
  dot.style.border = marker.active ? '3px solid #ffffff' : '2px solid #ffffff';
  dot.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.35)';
  dot.style.display = 'flex';
  dot.style.alignItems = 'center';
  dot.style.justifyContent = 'center';
  dot.style.fontSize = '10px';
  dot.style.fontWeight = '700';
  dot.style.color = color === '#ffffff' ? '#111827' : '#ffffff';

  if (typeof marker.heading === 'number') {
    dot.style.transform = `rotate(${marker.heading}deg)`;
  }

  if (marker.kind === 'car') {
    dot.textContent = '▲';
  } else if (marker.kind === 'cluster' && marker.label) {
    dot.textContent = marker.label;
  }

  wrapper.appendChild(dot);

  if (showLabels && marker.label && marker.kind !== 'cluster') {
    const badge = document.createElement('span');
    badge.textContent = marker.label;
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '6px';
    badge.style.backgroundColor = 'rgba(15, 23, 42, 0.88)';
    badge.style.color = '#ffffff';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = '600';
    badge.style.whiteSpace = 'nowrap';
    badge.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
    wrapper.appendChild(badge);
  }

  if (marker.onClick) {
    wrapper.addEventListener('click', (event) => {
      event.stopPropagation();
      marker.onClick?.();
    });
  }

  return wrapper;
}

function normalizePadding(padding: MapPadding | undefined): number | mapboxgl.PaddingOptions {
  if (typeof padding === 'number') return padding;
  if (Array.isArray(padding)) {
    const [top = 48, right = 48, bottom = 48, left = 48] = padding;
    return { top, right, bottom, left };
  }
  if (padding && typeof padding === 'object') {
    return {
      top: padding.top ?? 48,
      right: padding.right ?? 48,
      bottom: padding.bottom ?? 48,
      left: padding.left ?? 48,
    };
  }
  return 48;
}

function extractRoutePoints(input: RouteInput): LatLng[] {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.pts)) return input.pts;
  if (Array.isArray(input.path)) return input.path;
  return [];
}

function MapboxCityMap({
  center = DEFAULT_CENTER,
  zoom = 11.5,
  markers = [],
  route = [],
  routes = [],
  zones = [],
  theme = 'light',
  controls = true,
  labels = true,
  fit,
  fitKey,
  padding,
  interactive = true,
  onPick,
  onCenterChange,
  children,
  fallback,
  className = '',
}: CityMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const onPickRef = useRef(onPick);
  const onCenterChangeRef = useRef(onCenterChange);

  onPickRef.current = onPick;
  onCenterChangeRef.current = onCenterChange;

  const token = getMapboxToken();
  const safeZoom = normalizeMapboxZoom(zoom, center.lat);
  const dark = theme === 'dark';
  /** Token rejected / style not loadable → show the fallback map instead of a blank one. */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !token || mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: dark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/streets-v12',
      center: [center.lng, center.lat],
      zoom: safeZoom,
      interactive,
    });

    if (controls) {
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      map.addControl(
        new mapboxgl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserHeading: true,
        }),
        'top-right'
      );
    }

    map.on('error', (e) => {
      const status = (e?.error as { status?: number } | undefined)?.status;
      if (status === 401 || status === 403) setFailed(true);
    });

    map.on('click', (e) => {
      onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onCenterChangeRef.current?.({ lat: c.lat, lng: c.lng });
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [token, interactive, controls, dark]);

  // Zones (service areas, surge, airport, restricted) as translucent circles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sourceId = 'aura-zones-source';
    const data = {
      type: 'FeatureCollection' as const,
      features: zones
        .filter((z) => typeof z.center?.lat === 'number' && z.radiusKm > 0)
        .map((z) => ({
          type: 'Feature' as const,
          properties: { color: ZONE_COLORS[z.kind ?? ''] ?? '#8b8e91', opacity: z.active === false ? 0.04 : 0.12, width: z.selected ? 3 : 1.5 },
          geometry: { type: 'Polygon' as const, coordinates: [circleRing(z.center, z.radiusKm)] },
        })),
    };
    const apply = () => {
      const m = mapRef.current;
      if (!m) return;
      const src = m.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
      if (src) return src.setData(data as unknown as Parameters<mapboxgl.GeoJSONSource['setData']>[0]);
      m.addSource(sourceId, { type: 'geojson', data: data as never });
      m.addLayer({ id: 'aura-zones-fill', type: 'fill', source: sourceId, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] } });
      m.addLayer({ id: 'aura-zones-line', type: 'line', source: sourceId, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] } });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [zones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (Array.isArray(fit) && fit.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      fit.forEach((pt) => {
        if (typeof pt?.lat === 'number' && typeof pt?.lng === 'number') {
          bounds.extend([pt.lng, pt.lat]);
        }
      });
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          padding: normalizePadding(padding),
          maxZoom: 14,
          duration: 500,
        });
        return;
      }
    }

    map.easeTo({
      center: [center.lng, center.lat],
      zoom: safeZoom,
      duration: 500,
    });
  }, [center.lat, center.lng, safeZoom, fit, fitKey, padding]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const nextMarkers = markers
      .filter(
        (m) =>
          typeof m.pos?.lat === 'number' &&
          typeof m.pos?.lng === 'number' &&
          !Number.isNaN(m.pos.lat) &&
          !Number.isNaN(m.pos.lng)
      )
      .map((item) => {
        const el = createMarkerElement(item, labels);
        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([item.pos.lng, item.pos.lat])
          .addTo(map);
        return marker;
      });

    markersRef.current = nextMarkers;
  }, [markers, labels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = 'aura-active-route-source';
    const layerId = 'aura-active-route-layer';

    const allPaths: LatLng[][] = [
      ...(route.length >= 2 ? [route] : []),
      ...routes.map(extractRoutePoints).filter((path) => path.length >= 2),
    ];

    const features: LineFeature[] = allPaths.map((path) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: path
          .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
          .map((p) => [p.lng, p.lat] as [number, number]),
      },
    }));

    const applyRoute = () => {
      if (!mapRef.current) return;

      const existingSource = mapRef.current.getSource(sourceId) as
        | mapboxgl.GeoJSONSource
        | undefined;

      const geojsonData: LineFeatureCollection = {
        type: 'FeatureCollection',
        features,
      };

      if (existingSource) {
        existingSource.setData(geojsonData as unknown as Parameters<mapboxgl.GeoJSONSource['setData']>[0]);
      } else {
        mapRef.current.addSource(sourceId, {
          type: 'geojson',
          data: geojsonData as unknown as Parameters<mapboxgl.Map['addSource']>[1] extends { data?: infer D } ? D : never,
        });

        mapRef.current.addLayer({
          id: layerId,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#10b981',
            'line-width': 4,
          },
        });
      }
    };

    if (map.isStyleLoaded()) {
      applyRoute();
    } else {
      map.once('load', applyRoute);
    }
  }, [route, routes]);

  if ((!token || failed) && fallback) return <>{fallback}</>;

  if (!token) {
    return (
      <div
        className={`relative flex h-full min-h-[360px] w-full items-center justify-center rounded-xl border border-amber-500/40 bg-slate-900 p-6 text-center text-sm text-amber-200 ${className}`}
      >
        تعذر العثور على رمز Mapbox العام (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`). تأكد من ضبطه في Vercel وإعادة النشر.
        {fallback}
        {children}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative h-full min-h-[420px] w-full overflow-hidden rounded-xl ${className}`}
    >
      {children}
    </div>
  );
}

const VECTOR_TONES = ['go', 'ink', 'mute'] as const;

/** Current CityMap props → the offline vector map's props. */
function toVectorProps(p: CityMapProps): VectorCityMapProps {
  const routes: VectorRoute[] = [
    ...(p.route?.length ? [{ id: 'route', pts: p.route }] : []),
    ...(p.routes ?? []).map((r, i): VectorRoute =>
      Array.isArray(r)
        ? { id: `r${i}`, pts: r }
        : {
            id: r.id ?? `r${i}`,
            pts: r.pts ?? r.path ?? [],
            tone: VECTOR_TONES.includes(r.tone as (typeof VECTOR_TONES)[number]) ? (r.tone as VectorRoute['tone']) : 'go',
            dashed: r.dashed,
            width: r.width,
          },
    ),
  ];
  const pad = p.padding;
  const padding: [number, number, number, number] | undefined =
    typeof pad === 'number'
      ? [pad, pad, pad, pad]
      : Array.isArray(pad)
        ? pad
        : pad
          ? [pad.top ?? 80, pad.right ?? 40, pad.bottom ?? 120, pad.left ?? 40]
          : undefined;
  return {
    theme: p.theme === 'dark' ? 'dark' : 'light',
    markers: p.markers,
    routes,
    zones: p.zones?.map((z, i) => ({ ...z, id: z.id ?? `z${i}`, kind: (z.kind ?? 'service') as VectorZone['kind'] })),
    heat: p.heat,
    fit: Array.isArray(p.fit) ? p.fit : undefined,
    fitKey: p.fitKey == null ? undefined : String(p.fitKey),
    padding,
    center: p.center,
    zoom: p.zoom,
    interactive: p.interactive,
    controls: p.controls,
    labels: p.labels,
    onPick: p.onPick as ((pos: LatLng) => void) | undefined,
    onCenterChange: p.onCenterChange as ((c: LatLng) => void) | undefined,
    className: p.className,
    children: p.children,
  };
}

/**
 * Provider switch, with a map always on screen:
 *   Google Maps — VITE_MAPS_PROVIDER=google + VITE_GOOGLE_MAPS_API_KEY (src/maps/config.ts)
 *   Mapbox      — VITE_MAPBOX_ACCESS_TOKEN or NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN
 *   offline     — the built-in vector map of Riyadh (no key needed)
 * Each one falls back to the next if it is not configured or fails to load.
 */
export function CityMap(props: CityMapProps) {
  const offline = <VectorCityMap {...toVectorProps(props)} />;
  const mapbox = getMapboxToken() ? <MapboxCityMap {...props} fallback={offline} /> : offline;
  if (MAPS_PROVIDER === 'google') return <GoogleCityMap {...props} fallback={mapbox} />;
  return mapbox;
}

export default CityMap;
