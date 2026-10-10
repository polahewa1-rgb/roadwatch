const R = 6371000;
const rad = d => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
            Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// دووری لە هێڵی ڕێگاکە (میتر)
export function distToRoute(coords, p) {
  const k = Math.cos(rad(p.lat));
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - p.lng) * k * 111320, ay = (coords[i][1] - p.lat) * 111320;
    const bx = (coords[i + 1][0] - p.lng) * k * 111320, by = (coords[i + 1][1] - p.lat) * 111320;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? -(ax * dx + ay * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

function makeToken() {
  const a = new Uint8Array(16);
  (crypto?.getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256)));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
const token = (() => {
  let t = localStorage.getItem('rw_token');
  if (!t) { t = makeToken(); localStorage.setItem('rw_token', t); }
  return t;
})();

async function req(path, opts = {}) {
  const r = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-device-token': token },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'error');
  return data;
}

export const api = {
  reports: (lat, lng, radius = 8000) => req(`/reports?lat=${lat}&lng=${lng}&radius=${radius}`),
  createReport: body => req('/reports', { method: 'POST', body: JSON.stringify(body) }),
  vote: (id, vote) => req(`/reports/${id}/vote`, { method: 'POST', body: JSON.stringify({ vote }) }),
};

// گەڕان بۆ شوێن (OpenStreetMap Nominatim)
export async function searchPlaces(q) {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ckb,ar,en&q=${encodeURIComponent(q)}`
  );
  return r.json();
}

// ڕێنیشاندان (OSRM)
export async function getRoute(from, to) {
  const r = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`
  );
  const d = await r.json();
  if (d.code !== 'Ok') throw new Error('no route');
  return d.routes[0];
}

const nf = (() => {
  try { return new Intl.NumberFormat('ckb', { maximumFractionDigits: 1 }); }
  catch { return new Intl.NumberFormat('ar', { maximumFractionDigits: 1 }); }
})();
export const num = n => nf.format(n);

export const TYPES = {
  police:   { label: 'پۆلیس',        icon: '👮', color: '#2F5BEA' },
  accident: { label: 'ڕووداو',       icon: '💥', color: '#D93A3F' },
  traffic:  { label: 'ترافیک',       icon: '🚦', color: '#B96F00' },
  hazard:   { label: 'مەترسی',       icon: '⚠️', color: '#D4541E' },
  closure:  { label: 'ڕێگا داخراوە', icon: '⛔', color: '#7B5BD6' },
  camera:   { label: 'کامێرا',       icon: '📷', color: '#0F8A7B' },
};

export function fmtDist(m) {
  if (m < 1000) return `${num(m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50)} م`;
  return `${num(m / 1000)} کم`;
}

export function fmtDur(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${num(min)} خولەک`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${num(h)} کاتژمێر${m ? ` و ${num(m)} خولەک` : ''}`;
}

export function fmtAgo(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'ئێستا';
  if (m < 60) return `${num(m)} خولەک لەمەوبەر`;
  return `${num(Math.floor(m / 60))} کاتژمێر لەمەوبەر`;
}

export function fmtClock(date) {
  try { return date.toLocaleTimeString('ckb', { hour: '2-digit', minute: '2-digit' }); }
  catch { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
}

const DIR = {
  left: 'چەپ', right: 'ڕاست',
  'slight left': 'چەپ', 'slight right': 'ڕاست',
  'sharp left': 'چەپ', 'sharp right': 'ڕاست',
};

export function stepText(step) {
  const { type, modifier, exit } = step.maneuver;
  const name = step.name ? ` بەرەو ${step.name}` : '';
  if (type === 'depart') return `دەست پێ بکە${step.name ? ` لە ${step.name}` : ''}`;
  if (type === 'arrive') return 'گەیشتیت بە مەبەست';
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn')
    return `لە خولگەکەدا دەرچوونی ${exit ? num(exit) : ''} بگرە${name}`;
  if (modifier === 'uturn') return 'ئاوڕ بدەرەوە';
  if (type === 'merge') return `تێکەڵ ببە${name}`;
  if (type === 'fork') return `لە جیابوونەوەکەدا بگرە بۆ ${DIR[modifier] || 'پێشەوە'}${name}`;
  if (type === 'on ramp' || type === 'off ramp') return `بچۆ سەر ڕێگای لاوەکی${name}`;
  if (!modifier || modifier === 'straight' || type === 'continue' || type === 'new name')
    return `ڕاستەوخۆ بەردەوام بە${name}`;
  const slight = modifier.startsWith('slight') ? 'کەمێک ' : modifier.startsWith('sharp') ? 'بە توندی ' : '';
  return `${slight}بپێچە بۆ ${DIR[modifier] || ''}${name}`;
}

export function arrowAngle(m) {
  const map = { straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180,
                'sharp left': -135, left: -90, 'slight left': -45 };
  return map[m?.modifier] ?? 0;
}

export const ERR = {
  'already voted': 'پێشتر دەنگت داوە',
  'cannot vote own report': 'ناتوانیت دەنگ بە ڕاپۆرتی خۆت بدەیت',
  'too many reports': 'ڕاپۆرتی زۆرت ناردووە، کەمێک چاوەڕێ بکە',
  'not found': 'ئەم ڕاپۆرتە ماوەکەی تەواو بووە',
};
