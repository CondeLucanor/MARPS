/**
 * MAЯPS — mission map for the Mission Archive (Stage 9).
 * Redraws a mission ONLY from its recorded data (it works the same for imported missions).
 * It is a canvas map (not Leaflet): it draws landing points, planned routes, the astronaut and vehicle
 * tracks, known/detected obstacles and scientific points. The terrain relief is NOT drawn.
 * Mouse: drag = pan, wheel = zoom. Hover shows details.
 */
import { CONFIG } from './config.js';
import { formatDistance, formatCoordinate, isFiniteNumber } from './utils.js';
import { isValidCoordinate, metersPerDegreeLatitude } from './geodesy.js';
import { isTerrainLoaded } from './terrain.js';
import { renderTerrainLayers } from './terrain-layers.js';
const LAYERS = [
  ['landing', 'Landing'], ['routes', 'Planned routes'], ['track', 'Astronaut track'],
  ['vehicle', 'Vehicle track'], ['obstacles', 'Obstacles'], ['science', 'Scientific points']
];
const GRID_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
const SCALE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
const CYAN = '#22d3d8';

export function createMissionMap(container, mission) {
  const rec = mission.records || {};
  const valid = (p) => Boolean(p) && isValidCoordinate(p.latitude, p.longitude);
  const track = (rec.astronautPositions || []).filter(valid);
  const vtrack = (rec.vehiclePositions || []).filter(valid);
  const routes = (rec.routes || []).filter((r) => Array.isArray(r.points) && r.points.length > 1);
  const obstacles = (mission.obstacles || []).filter((o) => valid(o) && (o.known === true || o.detected === true));
  const science = (mission.scientificPoints || []).filter(valid);
  const landing = mission.landing || {};
  const enabled = { landing: true, routes: true, track: true, vehicle: true, obstacles: true, science: true };

  container.innerHTML = `
    <div class="mm-toolbar">
      ${LAYERS.map(([k, label]) => `<label class="mm-layer"><input type="checkbox" data-layer="${k}" checked> ${label}</label>`).join('')}
      <button type="button" class="btn btn-small" data-fit>Fit view</button>
    </div>
    <div class="mm-stage"><canvas></canvas><div class="mm-tip" hidden></div></div>
    <p class="hint">Redrawn only from the recorded mission data. Positions, routes, obstacles and sensor data are simulated. The background shows the real MOLA elevation (low = dark blue, high = light).</p>`;

  const stage = container.querySelector('.mm-stage');
  const canvas = container.querySelector('canvas');
  const tip = container.querySelector('.mm-tip');
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let lat0 = CONFIG.region.center.latitude;
  let lon0 = CONFIG.region.center.longitude;
  let scale = 10000;     // pixels per degree of latitude
  let needsFit = true;
  let hits = [];
  let raf = 0;
  let drag = null;
    // Relieve de fondo (elevación real MOLA), la misma imagen que usa el mapa Leaflet.
    let terrainImg = null;
    let terrainBounds = null;
    try {
      const layers = isTerrainLoaded() ? renderTerrainLayers() : null;
      if (layers) {
        terrainBounds = layers.bounds;
        const img = new Image();
        img.onload = () => { terrainImg = img; schedule(); };
        img.src = layers.elevation.dataUrl;
      }
    } catch (err) {
      console.warn('[MAЯPS] The terrain background could not be drawn:', err);
    }
  
    function drawTerrain() {
      if (!terrainImg || !terrainBounds) return;
      const b = terrainBounds;
      const [x1, y1] = proj(b.latMax, b.lonMin);
      const [x2, y2] = proj(b.latMin, b.lonMax);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(terrainImg, x1, y1, x2 - x1, y2 - y1);
      ctx.globalAlpha = 1;
    }

  const cosLat = () => Math.cos((lat0 * Math.PI) / 180);
  const proj = (lat, lon) => [w / 2 + (lon - lon0) * cosLat() * scale, h / 2 - (lat - lat0) * scale];
  const metersToPx = (m) => (m / metersPerDegreeLatitude()) * scale;

  function fit() {
    const pts = [];
    const add = (p) => { if (valid(p)) pts.push([p.latitude, p.longitude]); };
    [landing.planned, landing.actual, landing.lidar].forEach(add);
    track.forEach(add);
    vtrack.forEach(add);
    routes.forEach((r) => r.points.forEach(add));
    obstacles.forEach(add);
    science.forEach(add);
    if (pts.length === 0) {
      const r = CONFIG.region;
      pts.push([r.latMin, r.lonMin], [r.latMax, r.lonMax]);
    }
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    lat0 = (minLat + maxLat) / 2;
    lon0 = (minLon + maxLon) / 2;
    const c = cosLat();
    const spanLat = Math.max(maxLat - minLat, 0.01);
    const spanLon = Math.max(maxLon - minLon, 0.01);
    scale = Math.min((w * 0.8) / (spanLon * c), (h * 0.8) / spanLat);
    scale = Math.min(5e6, Math.max(5, scale));
  }

  function line(points, color, width, dash) {
    ctx.beginPath();
    let lx = null;
    let ly = null;
    for (const p of points) {
      const [x, y] = proj(p.latitude, p.longitude);
      if (lx !== null && Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) continue;
      if (lx === null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function label(text, x, y, color = '#e9eef3') {
    ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function ring(lat, lon, radius, color, fill, text) {
    const [x, y] = proj(lat, lon);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); }
    if (text) hits.push({ x, y, r: radius + 6, text });
  }

  function drawGrid() {
    const c = cosLat();
    const stepLat = GRID_STEPS.find((s) => s * scale >= 80) || 20;
    const stepLon = GRID_STEPS.find((s) => s * scale * c >= 80) || 20;
    const decimals = (s) => Math.max(0, -Math.floor(Math.log10(s)));
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const latMin = lat0 - h / 2 / scale;
    const latMax = lat0 + h / 2 / scale;
    const lonMin = lon0 - w / 2 / (scale * c);
    const lonMax = lon0 + w / 2 / (scale * c);
    let n = 0;
    for (let la = Math.ceil(latMin / stepLat) * stepLat; la <= latMax && n < 80; la += stepLat, n += 1) {
      const y = proj(la, lon0)[1];
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      label(`${la.toFixed(decimals(stepLat))}°`, 4, y - 3, '#93a1ae');
    }
    n = 0;
    for (let lo = Math.ceil(lonMin / stepLon) * stepLon; lo <= lonMax && n < 80; lo += stepLon, n += 1) {
      const x = proj(lat0, lo)[0];
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      label(`${lo.toFixed(decimals(stepLon))}°E`, x + 3, h - 6, '#93a1ae');
    }
    // Study region boundary.
    const r = CONFIG.region;
    const [x1, y1] = proj(r.latMax, r.lonMin);
    const [x2, y2] = proj(r.latMin, r.lonMax);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(34,211,216,0.25)';
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
  }

  function drawScaleBar() {
    const metersPerPx = metersPerDegreeLatitude() / scale;
    const nice = SCALE_STEPS.find((m) => m / metersPerPx >= 80) ||1000000 ;
    const px = nice / metersPerPx;
    ctx.strokeStyle = '#e9eef3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w - 20 - px, h - 24); ctx.lineTo(w - 20, h - 24);
    ctx.moveTo(w - 20 - px, h - 29); ctx.lineTo(w - 20 - px, h - 19);
    ctx.moveTo(w - 20, h - 29); ctx.lineTo(w - 20, h - 19);
    ctx.stroke();
    label(formatDistance(nice), w - 20 - px, h - 34);
  }

  function draw() {
    raf = 0;
    if (w < 10 || h < 10) return;
    hits = [];
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    drawTerrain();
    drawGrid();

    if (enabled.routes) routes.forEach((r) => line(r.points, 'rgba(34,211,216,0.5)', 2, [7, 5]));
    if (enabled.vehicle && vtrack.length > 1) line(vtrack, '#ff9800', 2);
    if (enabled.track && track.length > 1) line(track, '#ffffff', 2);

    if (enabled.track && track.length) {
      const last = track[track.length - 1];
      ring(last.latitude, last.longitude, 5, '#ffffff', true, `Last astronaut position\n${formatCoordinate(last.latitude, last.longitude)}`);
    }
    if (enabled.vehicle && vtrack.length) {
      const last = vtrack[vtrack.length - 1];
      ring(last.latitude, last.longitude, 6, '#ff9800', true, `Last vehicle position\n${formatCoordinate(last.latitude, last.longitude)}`);
    }

    if (enabled.obstacles) {
      for (const o of obstacles) {
        const radius = isFiniteNumber(o.radiusMeters) ? Math.max(3, metersToPx(o.radiusMeters)) : 4;
        const [x, y] = proj(o.latitude, o.longitude);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(34,211,216,0.14)';
        if (o.type !== 'rock') ctx.fill();
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(o.known === true ? [5, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        hits.push({ x, y, r: Math.max(radius, 8), text: `${o.id} · ${o.type}\n${o.known === true ? 'Known from orbit' : `Detected by ${o.sourceSensor || 'sensor'}`}` });
      }
    }

    if (enabled.science) {
      for (const p of science) {
        const [x, y] = proj(p.latitude, p.longitude);
        const visited = p.visited === true || (rec.scientificVisits || []).some((v) => v.id === p.id);
        ctx.beginPath();
        ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath();
        ctx.strokeStyle = visited ? '#4ade9b' : '#e9eef3';
        ctx.lineWidth = 2;
        ctx.stroke();
        label(String(p.name || p.id).slice(0, 40), x + 10, y + 4, visited ? '#4ade9b' : '#e9eef3');
        hits.push({ x, y, r: 10, text: `${p.name || p.id}\n${visited ? 'Visited' : 'Pending'}` });
      }
    }

    if (enabled.landing) {
      if (landing.planned && valid(landing.planned)) {
        if (isFiniteNumber(landing.errorRadiusMeters) && metersToPx(landing.errorRadiusMeters) > 4) {
          const [x, y] = proj(landing.planned.latitude, landing.planned.longitude);
          ctx.beginPath();
          ctx.arc(x, y, metersToPx(landing.errorRadiusMeters), 0, Math.PI * 2);
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(34,211,216,0.35)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ring(landing.planned.latitude, landing.planned.longitude, 7, CYAN, false,
          `Planned landing\n${formatCoordinate(landing.planned.latitude, landing.planned.longitude)}`);
      }
      if (landing.lidar && valid(landing.lidar)) {
        ring(landing.lidar.latitude, landing.lidar.longitude, 12, '#4ade9b', false, 'LiDAR position');
      }
      if (landing.actual && valid(landing.actual)) {
        ring(landing.actual.latitude, landing.actual.longitude, 5, '#f2b84b', true,
          `Actual landing\n${formatCoordinate(landing.actual.latitude, landing.actual.longitude)}`);
      }
    }
    drawScaleBar();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    const nw = Math.floor(rect.width);
    const nh = Math.floor(rect.height);
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    if (needsFit && w > 10 && h > 10) { fit(); needsFit = false; }
    schedule();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  container.querySelector('.mm-toolbar').addEventListener('change', (e) => {
    const key = e.target && e.target.dataset ? e.target.dataset.layer : null;
    if (key) { enabled[key] = e.target.checked; schedule(); }
  });
  container.querySelector('[data-fit]').addEventListener('click', () => { fit(); schedule(); });

  canvas.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (drag && e.pointerId === drag.id) {
      lon0 -= (e.clientX - drag.x) / (scale * cosLat());
      lat0 += (e.clientY - drag.y) / scale;
      drag.x = e.clientX;
      drag.y = e.clientY;
      tip.hidden = true;
      schedule();
      return;
    }
    let best = null;
    let bestDistance = Infinity;
    for (const hit of hits) {
      const d = Math.hypot(hit.x - px, hit.y - py);
      if (d <= hit.r && d < bestDistance) { best = hit; bestDistance = d; }
    }
    if (best) {
      tip.textContent = best.text;
      tip.style.left = `${Math.min(px + 12, w - 200)}px`;
      tip.style.top = `${py + 12}px`;
      tip.hidden = false;
    } else {
      tip.hidden = true;
    }
  });
  const endDrag = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const c = cosLat();
    const gLat = lat0 - (py - h / 2) / scale;
    const gLon = lon0 + (px - w / 2) / (scale * c);
    scale = Math.min(5e6, Math.max(5, scale * Math.exp(-e.deltaY * 0.0015)));
    lat0 = gLat + (py - h / 2) / scale;
    lon0 = gLon - (px - w / 2) / (scale * cosLat());
    schedule();
  }, { passive: false });

  return {
    destroy() {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      container.innerHTML = '';
    }
  };
}