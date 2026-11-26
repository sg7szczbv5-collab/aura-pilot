import { useEffect, useRef, type ReactNode } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

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

export interface CityMapProps {
  center?: LatLng;
  zoom?: number;
  markers?: MapMarker[];
  route?: LatLng[];
  routes?: LatLng[][];
  zones?: unknown[];
  theme?: 'light' | 'dark' | string;
  fit?: LatLng[] | boolean;
  fitKey?: string | number;
  padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
  interactive?: boolean;
  onPick?: (pos: LatLng) => void;
  onCenterChange?: (center: LatLng, zoom?: number) => void;
  children?: ReactNode;
  className?: string;
}

const DEFAULT_CENTER: LatLng = {
  lat: 24.7136,
  lng: 46.6753,
};

function getMapboxToken(): string {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const nextEnv = typeof process !== 'undefined' ? process.env : undefined;

  return (
    viteEnv?.VITE_MAPBOX_ACCESS_TOKEN ||
    viteEnv?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    nextEnv?.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    nextEnv?.VITE_MAPBOX_ACCESS_TOKEN ||
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

function createMarkerElement(marker: MapMarker): HTMLDivElement {
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

  if (marker.label && marker.kind !== 'cluster') {
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

export function CityMap({
  center = DEFAULT_CENTER,
  zoom = 11.5,
  markers = [],
  route = [],
  routes = [],
  fit,
  fitKey,
  padding,
  interactive = true,
  onPick,
  onCenterChange,
  children,
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

  useEffect(() => {
    if (!containerRef.current || !token || mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [center.lng, center.lat],
      zoom,
      interactive,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('click', (e) => {
      onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onCenterChangeRef.current?.({ lat: c.lat, lng: c.lng }, map.getZoom());
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [token, interactive]);

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
          padding: typeof padding === 'number' ? padding : 48,
          maxZoom: 15,
          duration: 500,
        });
        return;
      }
    }

    map.easeTo({
      center: [center.lng, center.lat],
      zoom,
      duration: 500,
    });
  }, [center.lat, center.lng, zoom, fit, fitKey, padding]);

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
        const el = createMarkerElement(item);
        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([item.pos.lng, item.pos.lat])
          .addTo(map);
        return marker;
      });

    markersRef.current = nextMarkers;
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = 'aura-active-route-source';
    const layerId = 'aura-active-route-layer';

    const allPaths: LatLng[][] = [
      ...(route.length >= 2 ? [route] : []),
      ...routes.filter((path) => Array.isArray(path) && path.length >= 2),
    ];

    const features: GeoJSON.Feature[] = allPaths.map((path) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: path
          .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
          .map((p) => [p.lng, p.lat]),
      },
    }));

    const applyRoute = () => {
      if (!mapRef.current) return;

      const existingSource = mapRef.current.getSource(sourceId) as
        | mapboxgl.GeoJSONSource
        | undefined;

      const geojsonData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features,
      };

      if (existingSource) {
        existingSource.setData(geojsonData);
      } else {
        mapRef.current.addSource(sourceId, {
          type: 'geojson',
          data: geojsonData,
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

  if (!token) {
    return (
      <div
        className={`relative flex h-full min-h-[360px] w-full items-center justify-center rounded-xl border border-amber-500/40 bg-slate-900 p-6 text-center text-sm text-amber-200 ${className}`}
      >
        تعذر العثور على رمز Mapbox العام (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`). تأكد من ضبطه في Vercel وإعادة النشر.
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

export default CityMap;
