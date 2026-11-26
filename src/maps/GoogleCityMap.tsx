/**
 * Google Maps implementation of the CityMap API (same props), so every screen
 * switches provider without changes. Markers are AdvancedMarkerElements drawn in
 * the AURA map language; routes are polylines; zones are circles.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LatLng } from '../core/types'
import type { CityMapProps, MapMarker, MapRoute, MapZone } from '../map/CityMap'
import { useI18n } from '../i18n/I18n'
import { GOOGLE_MAP_ID, pxPerKmToGoogleZoom } from './config'
import { loadGoogleMaps, onGoogleAuthFailure } from './googleLoader'

const INK = '#101112'
const GO = '#78B83F'
const MUTE = '#8b8e91'
const TONE: Record<string, string> = { ink: INK, go: GO, mute: MUTE, white: '#ffffff', danger: '#d64545' }
const RIYADH: LatLng = { lat: 24.7136, lng: 46.6753 }

function markerElement(m: MapMarker, dark: boolean): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:relative;transform:translateY(50%);display:flex;flex-direction:column;align-items:center;'
  const color = TONE[m.tone ?? (m.kind === 'car' ? (dark ? 'white' : 'ink') : 'ink')]
  let dot = ''
  switch (m.kind) {
    case 'car':
      dot = `<svg width="22" height="34" viewBox="0 0 22 34" style="transform:rotate(${m.heading ?? 0}deg);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">
        <rect x="2" y="1" width="18" height="32" rx="7" fill="${color}"/>
        <rect x="5" y="7" width="12" height="6" rx="2" fill="${color === '#ffffff' ? INK : '#ffffff'}" opacity=".55"/>
        <rect x="5" y="22" width="12" height="5" rx="2" fill="${color === '#ffffff' ? INK : '#ffffff'}" opacity=".35"/></svg>`
      break
    case 'pickup':
      dot = `<div style="width:18px;height:18px;border-radius:50%;background:${INK};border:4px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`
      break
    case 'dropoff':
      dot = `<div style="width:16px;height:16px;border-radius:4px;background:${INK};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`
      break
    case 'me':
      dot = `<div style="width:16px;height:16px;border-radius:50%;background:${GO};border:3px solid #fff;box-shadow:0 0 0 8px rgba(120,184,63,.22)"></div>`
      break
    case 'cluster':
      dot = `<div style="min-width:28px;height:28px;padding:0 6px;border-radius:14px;background:${INK};color:#fff;font:600 12px system-ui;display:flex;align-items:center;justify-content:center">${m.label ?? ''}</div>`
      break
    default:
      dot = `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff"></div>`
  }
  el.innerHTML = dot
  if (m.label && m.kind !== 'cluster') {
    const pill = document.createElement('div')
    pill.textContent = m.sub ? `${m.label} · ${m.sub}` : m.label
    pill.style.cssText = `margin-top:4px;padding:3px 8px;border-radius:999px;background:${dark ? '#1c1d1f' : '#fff'};color:${dark ? '#fff' : INK};font:600 11px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.15)`
    el.appendChild(pill)
  }
  if (m.onClick) el.style.cursor = 'pointer'
  return el
}

function toPaddingTuple(padding: CityMapProps['padding']): [number, number, number, number] {
  if (typeof padding === 'number') return [padding, padding, padding, padding]
  if (Array.isArray(padding)) {
    return [padding[0] ?? 80, padding[1] ?? 40, padding[2] ?? 120, padding[3] ?? 40]
  }
  if (padding && typeof padding === 'object') {
    return [padding.top ?? 80, padding.right ?? 40, padding.bottom ?? 120, padding.left ?? 40]
  }
  return [80, 40, 120, 40]
}

export function GoogleCityMap(props: CityMapProps & { fallback?: ReactNode }) {
  const {
    theme = 'light',
    markers = [],
    routes = [],
    zones = [],
    fit,
    fitKey,
    padding = [80, 40, 120, 40],
    center,
    zoom = 70,
    interactive = true,
    onPick,
    onCenterChange,
    className,
    children,
    fallback,
  } = props
  const { lang } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const gRef = useRef<typeof google | null>(null)
  const markerObjs = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>())
  const lineObjs = useRef(new Map<string, google.maps.Polyline>())
  const zoneObjs = useRef(new Map<string, google.maps.Circle>())
  const cbs = useRef({ onPick, onCenterChange })
  cbs.current = { onPick, onCenterChange }
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const dark = theme === 'dark'
  const fitPoints = Array.isArray(fit) ? fit : []

  // Create the map once.
  useEffect(() => {
    let dead = false
    loadGoogleMaps(lang)
      .then((g) => {
        if (dead || !host.current) return
        gRef.current = g
        const c = center ?? fitPoints[0] ?? RIYADH
        const map = new g.maps.Map(host.current, {
          center: c,
          zoom: pxPerKmToGoogleZoom(zoom, c.lat),
          mapId: GOOGLE_MAP_ID,
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: interactive ? 'greedy' : 'none',
          keyboardShortcuts: interactive,
          colorScheme: dark ? g.maps.ColorScheme.DARK : g.maps.ColorScheme.LIGHT,
        })
        map.addListener('idle', () => {
          const p = map.getCenter()
          if (p) cbs.current.onCenterChange?.({ lat: p.lat(), lng: p.lng() })
        })
        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (e.latLng) cbs.current.onPick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() })
        })
        mapRef.current = map
        setReady(true)
      })
      .catch(() => !dead && setFailed(true))
    const off = onGoogleAuthFailure(() => !dead && setFailed(true))
    return () => {
      dead = true
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow an explicit center / zoom from the screen.
  useEffect(() => {
    try {
      const map = mapRef.current
      if (!ready || !map || !center) return
      map.panTo(center)
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, center?.lat, center?.lng]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const map = mapRef.current
      if (!ready || !map) return
      const c = map.getCenter()
      const z = pxPerKmToGoogleZoom(zoom, c?.lat() ?? RIYADH.lat)
      if (Math.abs((map.getZoom() ?? z) - z) > 0.3) map.setZoom(z)
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, zoom])

  // Fit to points (trip overview) when the key changes.
  useEffect(() => {
    try {
      const map = mapRef.current
      const g = gRef.current
      if (!ready || !map || !g || !fitPoints.length) return
      if (fitPoints.length === 1) {
        map.panTo(fitPoints[0])
        return
      }
      const [top, right, bottom, left] = toPaddingTuple(padding)
      const b = new g.maps.LatLngBounds()
      fitPoints.forEach((p) => b.extend(p))
      map.fitBounds(b, { top, right, bottom, left })
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Markers (reconciled by id).
  useEffect(() => {
    try {
      const map = mapRef.current
      const g = gRef.current
      if (!ready || !map || !g) return
      const live = new Set<string>()
      for (const m of markers) {
        live.add(m.id)
        let obj = markerObjs.current.get(m.id)
        if (!obj) {
          obj = new g.maps.marker.AdvancedMarkerElement({ map, position: m.pos, content: markerElement(m, dark), zIndex: m.kind === 'car' ? 1 : 10 })
          markerObjs.current.set(m.id, obj)
        } else {
          obj.position = m.pos
          obj.content = markerElement(m, dark)
        }
        const click = m.onClick
        obj.gmpClickable = !!click
        ;(obj as unknown as { __aura?: () => void }).__aura?.()
        if (click) {
          const l = obj.addListener('gmp-click', click)
          ;(obj as unknown as { __aura?: () => void }).__aura = () => l.remove()
        }
      }
      for (const [id, obj] of markerObjs.current) {
        if (!live.has(id)) {
          obj.map = null
          markerObjs.current.delete(id)
        }
      }
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, markers, dark])

  // Routes.
  useEffect(() => {
    try {
      const map = mapRef.current
      const g = gRef.current
      if (!ready || !map || !g) return
      const live = new Set<string>()
      routes.forEach((item, idx) => {
        const r: MapRoute = Array.isArray(item) ? { id: `route-${idx}`, pts: item } : item
        const routeId = r.id ?? `route-${idx}`
        const routePath = r.pts ?? r.path ?? []
        live.add(routeId)
        const color = r.color ?? (r.tone === 'go' ? GO : r.tone === 'mute' ? MUTE : dark ? '#ffffff' : INK)
        const opts: google.maps.PolylineOptions = {
          map,
          path: routePath,
          strokeColor: color,
          strokeOpacity: r.dashed ? 0 : 0.95,
          strokeWeight: r.width ?? 5,
          icons: r.dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, scale: 3 }, offset: '0', repeat: '14px' }] : undefined,
        }
        const obj = lineObjs.current.get(routeId)
        if (obj) obj.setOptions(opts)
        else lineObjs.current.set(routeId, new g.maps.Polyline(opts))
      })
      for (const [id, obj] of lineObjs.current) {
        if (!live.has(id)) {
          obj.setMap(null)
          lineObjs.current.delete(id)
        }
      }
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, routes, dark])

  // Zones.
  useEffect(() => {
    try {
      const map = mapRef.current
      const g = gRef.current
      if (!ready || !map || !g) return
      const live = new Set<string>()
      zones.forEach((z: MapZone, idx) => {
        const zoneId = z.id ?? `zone-${idx}`
        live.add(zoneId)
        const color = z.kind === 'restricted' ? '#d64545' : z.kind === 'high_demand' ? GO : z.kind === 'airport' ? '#3f6fd6' : MUTE
        const opts: google.maps.CircleOptions = {
          map,
          center: z.center,
          radius: z.radiusKm * 1000,
          strokeColor: color,
          strokeWeight: z.selected ? 3 : 1.5,
          fillColor: color,
          fillOpacity: z.active === false ? 0.04 : 0.12,
          clickable: !!z.onClick,
        }
        let obj = zoneObjs.current.get(zoneId)
        if (obj) obj.setOptions(opts)
        else {
          obj = new g.maps.Circle(opts)
          zoneObjs.current.set(zoneId, obj)
        }
        g.maps.event.clearListeners(obj, 'click')
        if (z.onClick) obj.addListener('click', z.onClick)
      })
      for (const [id, obj] of zoneObjs.current) {
        if (!live.has(id)) {
          obj.setMap(null)
          zoneObjs.current.delete(id)
        }
      }
    } catch (e) {
      console.warn("Google map error, using the fallback map", e)
      setFailed(true)
    }
  }, [ready, zones])

  if (failed) return <>{fallback}</>
  return (
    <div className={className ?? 'absolute inset-0'}>
      <div ref={host} className="absolute inset-0" style={{ background: dark ? '#141516' : '#eceeea' }} />
      {children}
    </div>
  )
}
