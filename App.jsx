import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { io } from 'socket.io-client';
import { api, searchPlaces, getRoute, TYPES, ERR, fmtDist, fmtDur, fmtAgo, fmtClock, num, stepText, arrowAngle, haversine, bearing, angleDiff, distToRoute } from './lib.js';

const STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};
const EMPTY = { type: 'FeatureCollection', features: [] };

function pinEl(type, onClick) {
  const el = document.createElement('button');
  el.className = 'pin';
  el.style.background = TYPES[type].color;
  el.textContent = TYPES[type].icon;
  el.setAttribute('aria-label', TYPES[type].label);
  el.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return el;
}

function Arrow({ angle = 0 }) {
  return (
    <svg viewBox="0 0 48 48" className="arrow" style={{ transform: `rotate(${angle}deg)` }} aria-hidden="true">
      <path d="M24 6 L38 24 H29 V42 H19 V24 H10 Z" fill="currentColor" />
    </svg>
  );
}

export default function App() {
  const mapEl = useRef(null), mapRef = useRef(null);
  const markers = useRef(new Map()), meMarker = useRef(null), destMarker = useRef(null);
  const socketRef = useRef(null);
  const posRef = useRef(null), lastPos = useRef(null), lastFetch = useRef({ t: 0, pos: null });
  const alerted = useRef(new Set()), spoken = useRef(new Set()), lastReroute = useRef(0);
  const firstFix = useRef(true), mutedRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  const [pos, setPos] = useState(null);
  const [follow, setFollow] = useState(true);
  const [reports, setReports] = useState([]);
  const [panel, setPanel] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dest, setDest] = useState(null);
  const [route, setRoute] = useState(null);
  const [nav, setNav] = useState(null);
  const [toast, setToast] = useState(null);
  const [alertR, setAlertR] = useState(null);
  const [muted, setMuted] = useState(false);
  const [geoErr, setGeoErr] = useState(false);

  posRef.current = pos;
  mutedRef.current = muted;

  const flash = useCallback(msg => {
    setToast(msg);
    clearTimeout(flash.t);
    flash.t = setTimeout(() => setToast(null), 3500);
  }, []);

  const speak = useCallback(text => {
    if (mutedRef.current || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const v = voices.find(x => /^(ckb|ku)/i.test(x.lang)) || voices.find(x => /^ar/i.test(x.lang));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'ar';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }, []);

  const applyReport = useCallback(r => {
    setReports(list => {
      if (r.denies - r.confirms >= 3 || new Date(r.expires_at) < new Date())
        return list.filter(x => x.id !== r.id);
      return list.some(x => x.id === r.id)
        ? list.map(x => (x.id === r.id ? { ...x, ...r } : x))
        : [...list, r];
    });
  }, []);

  /* ---------- نەخشە ---------- */
  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapEl.current, style: STYLE, center: [44.0092, 36.1911], zoom: 12,
      attributionControl: false, pitchWithRotate: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
    map.on('dragstart', () => setFollow(false));
    map.on('click', e => {
      if (e.originalEvent.target.closest?.('.pin')) return;
      const d = { lat: e.lngLat.lat, lng: e.lngLat.lng, label: 'شوێنی هەڵبژێردراو' };
      setDest(d); setPanel({ kind: 'dest' }); setResults([]);
    });
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 11 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1D6BE8', 'line-width': 7 } });
      setMapReady(true);
    });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  useEffect(() => {
    const src = mapRef.current?.getSource('route');
    if (src) src.setData(route ? { type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords } } : EMPTY);
  }, [route, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    destMarker.current?.remove(); destMarker.current = null;
    if (dest && (panel?.kind === 'dest' || route)) {
      const el = document.createElement('div'); el.className = 'dest';
      destMarker.current = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([dest.lng, dest.lat]).addTo(map);
    }
  }, [dest, route, panel?.kind]);

  /* ---------- GPS ---------- */
  useEffect(() => {
    if (!navigator.geolocation) { setGeoErr(true); return; }
    const id = navigator.geolocation.watchPosition(
      p => {
        setGeoErr(false);
        const cur = { lat: p.coords.latitude, lng: p.coords.longitude };
        let heading = Number.isFinite(p.coords.heading) ? p.coords.heading : null;
        const prev = lastPos.current;
        if (heading == null && prev && haversine(prev, cur) > 4) heading = bearing(prev, cur);
        if (!prev || haversine(prev, cur) > 4) lastPos.current = cur;
        setPos({ ...cur, heading, speed: p.coords.speed });
      },
      () => setGeoErr(true),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!pos || !map) return;
    if (!meMarker.current) {
      const el = document.createElement('div'); el.className = 'me';
      meMarker.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([pos.lng, pos.lat]).addTo(map);
    }
    meMarker.current.setLngLat([pos.lng, pos.lat]);
    if (pos.heading != null) meMarker.current.setRotation(pos.heading);
    if (firstFix.current) { map.jumpTo({ center: [pos.lng, pos.lat], zoom: 15 }); firstFix.current = false; return; }
    if (follow) {
      map.easeTo({
        center: [pos.lng, pos.lat],
        zoom: nav ? 17 : Math.max(map.getZoom(), 15),
        bearing: nav && pos.heading != null ? pos.heading : map.getBearing(),
        pitch: nav ? 55 : 0,
        duration: 900, essential: true,
      });
    }
  }, [pos, follow, !!nav, mapReady]);

  /* ---------- ڕاپۆرتەکان + Socket ---------- */
  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socketRef.current = s;
    s.on('connect', () => { const p = posRef.current; if (p) s.emit('subscribe', { lat: p.lat, lng: p.lng }); });
    s.on('report:new', applyReport);
    s.on('report:update', applyReport);
    const tick = setInterval(() => setReports(l => l.filter(r => new Date(r.expires_at) > new Date())), 60000);
    return () => { s.close(); clearInterval(tick); };
  }, [applyReport]);

  useEffect(() => {
    if (!pos) return;
    const f = lastFetch.current;
    if (f.pos && haversine(f.pos, pos) < 1500 && Date.now() - f.t < 60000) return;
    lastFetch.current = { t: Date.now(), pos: { lat: pos.lat, lng: pos.lng } };
    socketRef.current?.emit('subscribe', { lat: pos.lat, lng: pos.lng });
    api.reports(pos.lat, pos.lng).then(setReports).catch(() => {});
  }, [pos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ids = new Set(reports.map(r => r.id));
    for (const [id, mk] of markers.current) if (!ids.has(id)) { mk.remove(); markers.current.delete(id); }
    for (const r of reports) if (!markers.current.has(r.id)) {
      markers.current.set(r.id, new maplibregl.Marker({ element: pinEl(r.type, () => setPanel({ kind: 'report', id: r.id })), anchor: 'center' })
        .setLngLat([r.lng, r.lat]).addTo(map));
    }
  }, [reports, mapReady]);

  // ئاگادارکردنەوە کاتێک ڕاپۆرتێک لە پێشەوەیە
  useEffect(() => {
    if (!pos) return;
    if (pos.speed != null && pos.speed < 1.5) return;
    for (const r of reports) {
      if (alerted.current.has(r.id)) continue;
      const d = haversine(pos, r);
      if (d > 400) continue;
      if (pos.heading != null && angleDiff(bearing(pos, r), pos.heading) > 70) continue;
      alerted.current.add(r.id);
      setAlertR({ ...r, d });
      speak(`${TYPES[r.type].label} لە پێشەوەیە`);
      setTimeout(() => setAlertR(a => (a?.id === r.id ? null : a)), 10000);
      break;
    }
  }, [pos, reports, speak]);

  /* ---------- ڕێنیشاندان ---------- */
  const stopNav = useCallback(() => {
    setNav(null); setRoute(null); setDest(null); setPanel(null); setFollow(false);
    mapRef.current?.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }, []);

  const plan = useCallback(async (d, keepNav = false) => {
    const p = posRef.current;
    if (!p) { flash('چاوەڕێی دیاریکردنی شوێنەکەت بکە'); return; }
    try {
      const r = await getRoute(p, d);
      const rt = { coords: r.geometry.coordinates, distance: r.distance, duration: r.duration, steps: r.legs[0].steps };
      setDest(d); setRoute(rt);
      if (keepNav) { spoken.current.clear(); setNav({ stepIdx: Math.min(1, rt.steps.length - 1) }); return; }
      setPanel({ kind: 'route' });
      const b = rt.coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(rt.coords[0], rt.coords[0]));
      setFollow(false);
      mapRef.current.fitBounds(b, { padding: { top: 130, bottom: 260, left: 40, right: 40 }, duration: 900 });
    } catch { flash('نەتوانرا ڕێگا بدۆزرێتەوە'); }
  }, [flash]);

  const startNav = () => {
    spoken.current.clear();
    setNav({ stepIdx: Math.min(1, route.steps.length - 1) });
    setPanel(null); setFollow(true);
    speak(stepText(route.steps[0]));
  };

  useEffect(() => {
    if (!nav || !route || !pos) return;
    const steps = route.steps, idx = nav.stepIdx, st = steps[idx];
    if (!st) return;
    const loc = st.maneuver.location;
    const d = haversine(pos, { lat: loc[1], lng: loc[0] });
    const last = idx === steps.length - 1;
    if (last && d < 30) { speak('گەیشتیت بە مەبەست'); flash('گەیشتیت بە مەبەست 🏁'); stopNav(); return; }
    if (!last && d < 25) { setNav({ stepIdx: idx + 1 }); return; }
    if (d < 350 && !spoken.current.has(`${idx}f`)) { spoken.current.add(`${idx}f`); speak(`دوای ${fmtDist(d)}، ${stepText(st)}`); }
    if (d < 70 && !spoken.current.has(`${idx}n`)) { spoken.current.add(`${idx}n`); speak(stepText(st)); }
    if (distToRoute(route.coords, pos) > 90 && Date.now() - lastReroute.current > 12000) {
      lastReroute.current = Date.now();
      flash('ڕێگا دووبارە دەدۆزرێتەوە...');
      plan(dest, true);
    }
  }, [pos]);

  useEffect(() => {
    if (!nav || !('wakeLock' in navigator)) return;
    let lock;
    navigator.wakeLock.request('screen').then(l => (lock = l)).catch(() => {});
    return () => { lock?.release?.(); };
  }, [!!nav]);

  /* ---------- کارەکان ---------- */
  const doSearch = async e => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try { setResults(await searchPlaces(query.trim())); }
    catch { flash('گەڕان سەرکەوتوو نەبوو'); }
    setBusy(false);
  };

  const pickResult = r => {
    const d = { lat: +r.lat, lng: +r.lon, label: r.display_name };
    setResults([]); setQuery(''); plan(d);
  };

  const sendReport = async type => {
    if (!pos) { flash('چاوەڕێی دیاریکردنی شوێنەکەت بکە'); return; }
    try {
      const r = await api.createReport({ type, lat: pos.lat, lng: pos.lng });
      alerted.current.add(r.id); applyReport(r); setPanel(null);
      flash('ڕاپۆرتەکە نێردرا. سوپاس!');
    } catch (e) { flash(ERR[e.message] || 'هەڵەیەک ڕوویدا'); }
  };

  const vote = async (id, v) => {
    try {
      applyReport(await api.vote(id, v)); setPanel(null); setAlertR(null);
      flash(v === 'confirm' ? 'سوپاس! ڕاپۆرتەکە پشتڕاستکرایەوە' : 'سوپاس بۆ هەواڵدانەوەکەت');
    } catch (e) { flash(ERR[e.message] || 'هەڵەیەک ڕوویدا'); }
  };

  /* ---------- نیشاندان ---------- */
  const sel = panel?.kind === 'report' ? reports.find(r => r.id === panel.id) : null;
  let navInfo = null;
  if (nav && route?.steps[nav.stepIdx]) {
    const st = route.steps[nav.stepIdx], loc = st.maneuver.location;
    const toMan = pos ? haversine(pos, { lat: loc[1], lng: loc[0] }) : st.distance;
    let rem = toMan;
    for (let i = nav.stepIdx; i < route.steps.length; i++) rem += route.steps[i].distance;
    const secs = route.duration * Math.min(1, rem / route.distance);
    navInfo = { st, toMan, rem, secs };
  }
  const sheetOpen = !!(panel && (panel.kind !== 'report' || sel));

  return (
    <>
      <div id="map" ref={mapEl} />

      {geoErr && <div className="banner warn">GPS چالاک نییە. ڕێگە بدە بە شوێن لە ڕێکخستنەکانی وێبگەڕ.</div>}

      {!nav && (
        <div className="top">
          <form className="search" onSubmit={doSearch}>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="بگەڕێ بۆ شوێنێک..." aria-label="گەڕان" enterKeyHint="search" />
            <button type="submit" disabled={busy} aria-label="گەڕان">{busy ? '…' : '🔍'}</button>
          </form>
          {results.length > 0 && (
            <ul className="results">
              {results.map(r => (
                <li key={r.place_id}><button onClick={() => pickResult(r)}>{r.display_name}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {navInfo && (
        <div className="top">
          <div className="hud">
            {navInfo.st.maneuver.type === 'arrive' ? <span className="flag">🏁</span> : <Arrow angle={arrowAngle(navInfo.st.maneuver)} />}
            <div>
              <div className="dist">{fmtDist(navInfo.toMan)}</div>
              <div className="txt">{stepText(navInfo.st)}</div>
            </div>
          </div>
        </div>
      )}

      {alertR && (
        <div className="alert" style={{ background: TYPES[alertR.type].color, top: nav ? 'calc(var(--sat) + 124px)' : undefined }} role="alert">
          <span className="alert-ic">{TYPES[alertR.type].icon}</span>
          <div className="alert-tx"><b>{TYPES[alertR.type].label}</b><small>{fmtDist(alertR.d)} لە پێشەوە</small></div>
          <button onClick={() => vote(alertR.id, 'confirm')}>هەیە</button>
          <button onClick={() => vote(alertR.id, 'deny')}>نەماوە</button>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      {!sheetOpen && (
        <div className="fabs" style={nav ? { bottom: 'calc(var(--sab) + 120px)' } : undefined}>
          <button className="round" onClick={() => setMuted(m => !m)} aria-label="دەنگ">{muted ? '🔇' : '🔊'}</button>
          {!follow && <button className="round" onClick={() => { setFollow(true); if (pos) mapRef.current.easeTo({ center: [pos.lng, pos.lat], zoom: 16, duration: 600 }); }} aria-label="شوێنی من">🎯</button>}
          <button className="report-fab" onClick={() => setPanel({ kind: 'picker' })}><b>+</b> ڕاپۆرت</button>
        </div>
      )}

      {navInfo && !sheetOpen && (
        <div className="navbar">
          <div className="stat"><b>{fmtClock(new Date(Date.now() + navInfo.secs * 1000))}</b><small>گەیشتن</small></div>
          <div className="stat"><b>{fmtDur(navInfo.secs)}</b><small>ماوە</small></div>
          <div className="stat"><b>{fmtDist(navInfo.rem)}</b><small>مەودا</small></div>
          <button className="end" onClick={stopNav}>تەواو</button>
        </div>
      )}

      {panel?.kind === 'picker' && (
        <div className="sheet">
          <div className="sheet-h"><h2>چی ڕوویداوە؟</h2><button className="x" onClick={() => setPanel(null)} aria-label="داخستن">✕</button></div>
          <div className="types">
            {Object.entries(TYPES).map(([k, t]) => (
              <button key={k} className="type" style={{ background: t.color }} onClick={() => sendReport(k)}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {sel && (
        <div className="sheet">
          <div className="sheet-h">
            <div className="rep-t"><span className="rep-ic" style={{ background: TYPES[sel.type].color }}>{TYPES[sel.type].icon}</span>
              <div><h2>{TYPES[sel.type].label}</h2><small>{fmtAgo(sel.created_at)}</small></div></div>
            <button className="x" onClick={() => setPanel(null)} aria-label="داخستن">✕</button>
          </div>
          <p className="counts">{num(sel.confirms)} کەس پشتڕاستیان کردەوە · {num(sel.denies)} کەس ڕەتیان کردەوە</p>
          <p className="ask">ئایا ئێستاش لێرەیە؟</p>
          <div className="row">
            <button className="btn ok" onClick={() => vote(sel.id, 'confirm')}>بەڵێ، هەیە</button>
            <button className="btn no" onClick={() => vote(sel.id, 'deny')}>نەماوە</button>
          </div>
        </div>
      )}

      {panel?.kind === 'dest' && dest && (
        <div className="sheet">
          <div className="sheet-h"><h2>{dest.label}</h2><button className="x" onClick={() => { setPanel(null); setDest(null); }} aria-label="داخستن">✕</button></div>
          <div className="row">
            <button className="btn go" onClick={() => plan(dest)}>ڕێنیشاندان</button>
          </div>
        </div>
      )}

      {panel?.kind === 'route' && route && (
        <div className="sheet">
          <div className="sheet-h"><h2 className="clip">{dest?.label}</h2></div>
          <div className="trip">
            <div><b>{fmtDur(route.duration)}</b><small>کاتی ڕێگا</small></div>
            <div><b>{fmtDist(route.distance)}</b><small>مەودا</small></div>
            <div><b>{fmtClock(new Date(Date.now() + route.duration * 1000))}</b><small>گەیشتن</small></div>
          </div>
          <div className="row">
            <button className="btn go" onClick={startNav}>دەست پێ بکە</button>
            <button className="btn no" onClick={stopNav}>هەڵوەشاندنەوە</button>
          </div>
        </div>
      )}
    </>
  );
}
