/**
 * MAЯPS — first-person Mission View: panorama, camera controls, HUD and overlays.
 *
 * Fills #mission-view-root (the screen is shown by mission-view.js when exploration is active).
 *
 * Controls:
 *   mouse drag      changes the heading (the same variable as the arrow keys) and looks up / down
 *   Left / Right    rotate
 *   Up / Down       move forward / backward (held keys = continuous movement)
 *
 * Overlays (cyan = hazards): compass, route, obstacle symbols and hazard outlines, scientific points.
 * Route, obstacles and scientific points are drawn from the mission data. They appear when the later
 * stages fill that data. Ground positions are projected assuming flat ground at the astronaut's height
 * (a SIMULATED approximation, because the view is a panorama and not a 3D scene).
 *
 * Contract for the navigation stage: the HUD reads mission.navigation.status =
 *   { destinationName, remainingDistanceMeters, etaSeconds, bearingDegrees }
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, appState, getCurrentMission } from './state.js';
import { on, EVENTS } from './events.js';
import { onFrame } from './simulation.js';
import { distanceMeters, bearingDegrees } from './geodesy.js';
import { getElevation } from './terrain.js';
import {
  angleDifference,
  formatDistance,
  formatDuration,
  isFiniteNumber,
  normalizeAngle360,
  radToDeg
} from './utils.js';
import { controls, lookBy, getMovementStatus, getTravelMeters, clearControls } from './astronaut.js';
import { drawPanorama, loadPanoramas } from './panorama-manager.js';
import { showToast } from './ui.js';

const CYAN = '#22d3d8';
const HAZARD_FILL = 'rgba(34, 211, 216, 0.14)';
const HUD_INTERVAL_MS = 100;
const ROUTE_RANGE_METERS = 4000;
const OBSTACLE_RANGE_METERS = 6000;
const POINT_RANGE_METERS = 40000;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SPEED_LABELS = { normal: 'Normal', slow: 'Slow', verySlow: 'Very Slow' };
const BLOCK_TEXT = {
  slope: 'Terrain too steep',
  obstacle: 'Obstacle ahead',
  region: 'Edge of the study region',
  battery: 'Vehicle battery empty'
};
const KEY_MAP = { ArrowUp: 'forward', ArrowDown: 'backward', ArrowLeft: 'left', ArrowRight: 'right' };

let root = null;
let canvas = null;
let ctx = null;
let bannerEl = null;
let messageEl = null;
const fields = {};
let cssWidth = 0;
let cssHeight = 0;
let pixelRatio = 1;
let display = null;     // smoothed position used for drawing: { missionId, latitude, longitude, travel }
let lastHudAt = 0;
let drag = null;
const elevationCache = new Map();

/* ------------------------------------------------------------------ DOM */

function row(label, field) {
  return `<div class="ev-row"><span class="ev-label">${label}</span><span class="ev-value" data-f="${field}">—</span></div>`;
}

function buildDom() {
  root = document.getElementById('mission-view-root');
  if (!root) return false;

  root.innerHTML = `
    <canvas class="ev-canvas"></canvas>

    <div class="ev-hud ev-tl">
      <div class="ev-panel">
        <div class="ev-title">Astronaut</div>
        ${row('Latitude', 'lat')}
        ${row('Longitude', 'lon')}
        ${row('Altitude', 'alt')}
        ${row('Orientation', 'ori')}
        ${row('Precision', 'prec')}
        ${row('Mode', 'mode')}
        ${row('Speed', 'speed')}
        ${row('Terrain', 'terrain')}
      </div>
    </div>

    <div class="ev-hud ev-tr">
      <div class="ev-panel">
        <div class="ev-title">Environment <span class="ev-tag">simulated</span></div>
        ${row('Temperature', 'temp')}
        ${row('Wind speed', 'wind')}
        ${row('Radiation', 'rad')}
      </div>
      <div class="ev-panel">
        <div class="ev-title">Vehicle</div>
        ${row('Battery', 'battery')}
        <div class="ev-bar"><div class="ev-bar-fill" data-f="batteryBar"></div></div>
      </div>
    </div>

    <div class="ev-hud ev-bl">
      <div class="ev-panel">
        <div class="ev-title">Navigation</div>
        ${row('Destination', 'dest')}
        ${row('Remaining', 'remaining')}
        ${row('Arrival (ETA)', 'eta')}
        ${row('Direction', 'direction')}
      </div>
    </div>

    <div class="ev-hud ev-br">
      <div class="ev-panel ev-keys">
        <div class="ev-title">Controls</div>
        <div><kbd>↑</kbd> <kbd>↓</kbd> move forward / backward</div>
        <div><kbd>←</kbd> <kbd>→</kbd> rotate</div>
        <div>Mouse drag: look around</div>
        <div><kbd>E</kbd> enter / exit vehicle</div>
      </div>
    </div>

    <div class="ev-banner" hidden>MISSION PAUSED</div>
    <div class="ev-message" hidden></div>`;

  canvas = root.querySelector('.ev-canvas');
  ctx = canvas.getContext('2d');
  bannerEl = root.querySelector('.ev-banner');
  messageEl = root.querySelector('.ev-message');
  root.querySelectorAll('[data-f]').forEach((el) => {
    fields[el.dataset.f] = el;
  });
  return true;
}

function setText(name, text) {
  const el = fields[name];
  if (el && el.textContent !== text) el.textContent = text;
}

/* ------------------------------------------------------------------ input */

function inputAllowed(checkFocus) {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return false;
  if (appState.currentSection !== 'mission-view') return false;
  if (document.querySelector('#modal-root .modal-backdrop')) return false;
  if (checkFocus) {
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  }
  return true;
}

function onKeyDown(event) {
  const action = KEY_MAP[event.key];
  if (!action || !inputAllowed(true)) return;
  event.preventDefault();
  controls[action] = true;
}

function onKeyUp(event) {
  const action = KEY_MAP[event.key];
  if (action) controls[action] = false;   // always released, so no key can stay "stuck"
}

function setupMouse() {
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !inputAllowed(false)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const sensitivity = CONFIG.movement.mouseSensitivityDegreesPerPixel;
    // Dragging the scene to the right turns the view to the left; dragging down looks up.
    lookBy(-dx * sensitivity, dy * sensitivity);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

/* ------------------------------------------------------------------ sizing and visibility */

function isExplorationVisible() {
  const section = document.getElementById('section-mission-view');
  return Boolean(section && section.dataset.mode === 'exploration' && appState.currentSection === 'mission-view');
}

function resizeIfNeeded() {
  const rect = root.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  if (w === cssWidth && h === cssHeight && ratio === pixelRatio) return;
  cssWidth = w;
  cssHeight = h;
  pixelRatio = ratio;
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
}

function snapDisplay(mission) {
  const a = mission.astronaut;
  display = { missionId: mission.id, latitude: a.latitude, longitude: a.longitude, travel: getTravelMeters() };
}

/* ------------------------------------------------------------------ overlays */

function drawLabel(text, x, y, color = '#e9eef3', align = 'center') {
  ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function makeProjector(mission, width, height) {
  const a = mission.astronaut;
  const hfov = CONFIG.panoramas.horizontalFovDegrees;
  const vfov = (hfov * height) / width;
  const horizonY = height / 2 + (a.pitchDegrees / vfov) * height;
  const cameraHeight = mission.insideVehicle ? 2.4 : 1.7;

  return {
    hfov,
    vfov,
    horizonY,
    /** Screen position of a ground point. `visible` tells if it is inside the field of view. */
    project(lat, lon) {
      const dist = distanceMeters(display.latitude, display.longitude, lat, lon);
      const bearing = bearingDegrees(display.latitude, display.longitude, lat, lon);
      const rel = angleDifference(a.headingDegrees, bearing);
      const depression = radToDeg(Math.atan2(cameraHeight, Math.max(dist, 1)));
      return {
        x: width / 2 + (rel / hfov) * width,
        y: horizonY + (depression / vfov) * height,
        dist,
        bearing,
        rel,
        visible: Math.abs(rel) <= hfov / 2 + 12
      };
    }
  };
}

/* ---- route guidance: animated arrows on the ground + dashed alternatives ---- */

const ARROW_SPACING_METERS = 30;
const ARROW_RANGE_METERS = 450;

function nearestRouteIndex(route) {
  const pts = route.points;
  const step = Math.max(1, Math.floor(pts.length / 400));
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i += step) {
    const d = distanceMeters(display.latitude, display.longitude, pts[i].latitude, pts[i].longitude);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function pointAtDistance(route, s) {
  const cum = route.cumulativeDistance;
  const pts = route.points;
  const last = pts.length - 1;
  if (!cum || s <= 0) return pts[0];
  if (s >= cum[last]) return pts[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const f = (s - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
  return {
    latitude: pts[lo].latitude + (pts[hi].latitude - pts[lo].latitude) * f,
    longitude: pts[lo].longitude + (pts[hi].longitude - pts[lo].longitude) * f
  };
}

function drawArrowHead(x, y, angle, size, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size, -size * 0.9);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size, size * 0.9);
  ctx.closePath();
  ctx.fillStyle = CYAN;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(5, 7, 10, 0.85)';
  ctx.stroke();
  ctx.restore();
}

function drawRoutes(mission, view) {
  const nav = mission.navigation;
  const routes = nav && nav.routes;
  if (!routes) return;

  const list = [];
  if (routes.recommended) list.push({ route: routes.recommended, index: 0 });
  (routes.alternatives || []).forEach((route, i) => list.push({ route, index: i + 1 }));
  const selectedIndex = nav.selectedRouteIndex || 0;

  // Alternatives: thin dashed lines (as before).
  for (const { route, index } of list) {
    if (index === selectedIndex || !route || !Array.isArray(route.points) || route.points.length < 2) continue;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(34, 211, 216, 0.4)';
    ctx.setLineDash([6, 6]);
    const step = Math.max(1, Math.ceil(route.points.length / 600));
    let previous = null;
    ctx.beginPath();
    for (let i = 0; i < route.points.length; i += step) {
      const p = view.project(route.points[i].latitude, route.points[i].longitude);
      const usable = p.visible && p.dist > 2 && p.dist < ROUTE_RANGE_METERS;
      if (usable && previous) ctx.lineTo(p.x, p.y);
      else if (usable) ctx.moveTo(p.x, p.y);
      previous = usable ? p : null;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Selected route: translucent ribbon + moving arrows that show the direction of travel.
  const route = list.find((r) => r.index === selectedIndex);
  if (!route || !route.route.points || route.route.points.length < 2 || !route.route.cumulativeDistance) return;
  const r = route.route;
  const s0 = r.cumulativeDistance[nearestRouteIndex(r)];
  const total = r.cumulativeDistance[r.points.length - 1];
  const sEnd = Math.min(total, s0 + ARROW_RANGE_METERS);

  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(34, 211, 216, 0.28)';
  ctx.beginPath();
  let drawing = false;
  for (let s = s0 + 6; s <= sEnd; s += 10) {
    const pt = pointAtDistance(r, s);
    const p = view.project(pt.latitude, pt.longitude);
    const usable = p.visible && p.dist > 2;
    if (usable && drawing) ctx.lineTo(p.x, p.y);
    else if (usable) { ctx.moveTo(p.x, p.y); drawing = true; }
    else drawing = false;
  }
  ctx.stroke();

  const offset = ((performance.now() / 1000) * 10) % ARROW_SPACING_METERS;   // arrows flow along the route
  const arrows = [];
  for (let s = s0 + offset + 4; s <= sEnd; s += ARROW_SPACING_METERS) {
    const a = pointAtDistance(r, s);
    const b = pointAtDistance(r, s + 6);
    const pa = view.project(a.latitude, a.longitude);
    const pb = view.project(b.latitude, b.longitude);
    if (!pa.visible || pa.dist < 3) continue;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    if (Math.hypot(dx, dy) < 0.01) continue;
    arrows.push({
      x: pa.x,
      y: pa.y,
      angle: Math.atan2(dy, dx),
      size: Math.max(5, Math.min(26, 700 / pa.dist)),
      alpha: Math.max(0.35, 1 - (s - s0) / ARROW_RANGE_METERS)
    });
  }
  for (let i = arrows.length - 1; i >= 0; i -= 1) {   // far to near, so near arrows are on top
    const a = arrows[i];
    drawArrowHead(a.x, a.y, a.angle, a.size, a.alpha);
  }
  ctx.globalAlpha = 1;
}

/** Large arrow at the lower centre: where to move the astronaut (turn left / right / straight). */
function drawGuideArrow(mission, width, height) {
  const nav = mission.navigation && mission.navigation.status;
  if (!nav || !isFiniteNumber(nav.bearingDegrees)) return;
  const rel = angleDifference(mission.astronaut.headingDegrees, nav.bearingDegrees);
  const aligned = Math.abs(rel) < 5;
  const cx = width / 2;
  const cy = height * 0.74;
  const s = Math.min(46, height * 0.07);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rel * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.3);
  ctx.lineTo(s * 0.9, s * 0.2);
  ctx.lineTo(s * 0.3, s * 0.2);
  ctx.lineTo(s * 0.3, s * 1.1);
  ctx.lineTo(-s * 0.3, s * 1.1);
  ctx.lineTo(-s * 0.3, s * 0.2);
  ctx.lineTo(-s * 0.9, s * 0.2);
  ctx.closePath();
  ctx.fillStyle = aligned ? 'rgba(74, 222, 155, 0.9)' : 'rgba(34, 211, 216, 0.9)';
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5, 7, 10, 0.85)';
  ctx.stroke();
  ctx.restore();

  const text = aligned ? 'Straight ahead' : `Turn ${rel > 0 ? 'right' : 'left'} ${Math.round(Math.abs(rel))}°`;
  drawLabel(text, cx, cy + s * 1.1 + 18, aligned ? '#4ade9b' : '#e9eef3');
  if (nav.destinationName) {
    drawLabel(`${nav.destinationName} · ${formatDistance(nav.remainingDistanceMeters)}`, cx, cy + s * 1.1 + 34, '#93a1ae');
  }
}

/** Marker of the landing ship when it is in view. */
function drawShip(mission, view) {
  const s = mission.landing && mission.landing.actual;
  if (!s || !isFiniteNumber(s.latitude)) return;
  const p = view.project(s.latitude, s.longitude);
  if (!p.visible || p.dist > POINT_RANGE_METERS) return;
  ctx.strokeStyle = '#f2b84b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - 10);
  ctx.lineTo(p.x + 8, p.y + 6);
  ctx.lineTo(p.x - 8, p.y + 6);
  ctx.closePath();
  ctx.stroke();
  drawLabel(`Ship · ${formatDistance(p.dist)}`, p.x, p.y - 16, '#f2b84b');
}

function drawObstacles(mission, view, width) {
  for (const o of mission.obstacles || []) {
    if (!(o.known === true || o.detected === true)) continue;
    if (!isFiniteNumber(o.latitude) || !isFiniteNumber(o.longitude)) continue;

    const p = view.project(o.latitude, o.longitude);
    if (!p.visible || p.dist > OBSTACLE_RANGE_METERS) continue;

    const type = CONFIG.obstacleTypes[o.type];
    const radius = isFiniteNumber(o.radiusMeters) ? o.radiusMeters : 5;
    const sizePx = (radToDeg(Math.atan2(radius, Math.max(p.dist, radius))) / view.hfov) * width;

    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2;
    ctx.fillStyle = HAZARD_FILL;

    if (o.type === 'rock') {
      const s = Math.max(7, sizePx);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s);
      ctx.lineTo(p.x + s, p.y + s * 0.6);
      ctx.lineTo(p.x - s, p.y + s * 0.6);
      ctx.closePath();
      ctx.stroke();
    } else {
      const rx = Math.max(8, sizePx);
      const ry = Math.max(3, rx * 0.22);
      ctx.setLineDash(o.type === 'crater' ? [8, 5] : []);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
      if (o.type === 'hazard-zone') ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const label = type ? type.label : 'Obstacle';
    drawLabel(`${label} · ${formatDistance(p.dist)}`, p.x, p.y - 14, CYAN);
  }
}

function drawSciencePoints(mission, view) {
  const destinationId = mission.navigation ? mission.navigation.destinationId : null;
  for (const point of mission.scientificPoints || []) {
    if (!isFiniteNumber(point.latitude) || !isFiniteNumber(point.longitude)) continue;
    const p = view.project(point.latitude, point.longitude);
    if (!p.visible || p.dist > POINT_RANGE_METERS) continue;

    if (!elevationCache.has(point.id)) elevationCache.set(point.id, getElevation(point.latitude, point.longitude));
    const elevation = elevationCache.get(point.id);

    const color = point.visited ? '#4ade9b' : '#e9eef3';
    const s = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - s);
    ctx.lineTo(p.x + s, p.y);
    ctx.lineTo(p.x, p.y + s);
    ctx.lineTo(p.x - s, p.y);
    ctx.closePath();
    ctx.stroke();

    if (point.id === destinationId) {
      ctx.strokeStyle = CYAN;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawLabel(`${point.name} · ${formatDistance(p.dist)}`, p.x, p.y - 16, color);
    if (isFiniteNumber(elevation)) drawLabel(`elev. ${Math.round(elevation)} m`, p.x, p.y - 4 + 28, '#93a1ae');
  }
}

function drawCompass(mission, width) {
  const heading = mission.astronaut.headingDegrees;
  const left = width * 0.28;
  const right = width * 0.72;
  const center = (left + right) / 2;
  const pxPerDegree = (right - left) / 90;

  ctx.save();
  ctx.fillStyle = 'rgba(13, 17, 23, 0.65)';
  ctx.fillRect(left, 8, right - left, 38);
  ctx.beginPath();
  ctx.rect(left, 8, right - left, 38);
  ctx.clip();

  ctx.strokeStyle = 'rgba(233, 238, 243, 0.8)';
  ctx.lineWidth = 1;
  const start = Math.floor((heading - 50) / 5) * 5;
  for (let d = start; d <= heading + 50; d += 5) {
    const x = center + (d - heading) * pxPerDegree;
    const norm = ((d % 360) + 360) % 360;
    const major = norm % 15 === 0;
    ctx.beginPath();
    ctx.moveTo(x, 46);
    ctx.lineTo(x, major ? 34 : 40);
    ctx.stroke();
    if (norm % 45 === 0) {
      drawLabel(CARDINALS[norm / 45], x, 30, norm === 0 ? CYAN : '#e9eef3');
    } else if (major) {
      drawLabel(String(norm), x, 30, '#93a1ae');
    }
  }

  // Direction to the destination (provided by the navigation stage).
  const nav = mission.navigation && mission.navigation.status;
  if (nav && isFiniteNumber(nav.bearingDegrees)) {
    const rel = angleDifference(heading, nav.bearingDegrees);
    const x = center + Math.max(-48, Math.min(48, rel)) * pxPerDegree;
    ctx.fillStyle = CYAN;
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x + 6, 19);
    ctx.lineTo(x, 26);
    ctx.lineTo(x - 6, 19);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = CYAN;
  ctx.beginPath();
  ctx.moveTo(center - 6, 4);
  ctx.lineTo(center + 6, 4);
  ctx.lineTo(center, 12);
  ctx.closePath();
  ctx.fill();
  drawLabel(`${Math.round(heading)}°`, center, 62, '#e9eef3');
}

function drawCenterInfo(mission, width, height) {
  const a = mission.astronaut;
  const movement = getMovementStatus();

  // Small marker at the centre of the view.
  ctx.strokeStyle = 'rgba(34, 211, 216, 0.7)';
  ctx.lineWidth = 1.5;
  const cx = width / 2;
  const cy = height / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();

  // Elevation information.
  const slopeText = isFiniteNumber(movement.slopeDegrees) ? `  ·  slope ${movement.slopeDegrees.toFixed(1)}°` : '';
  const altText = isFiniteNumber(a.altitude) ? `elevation ${Math.round(a.altitude)} m` : 'elevation —';
  drawLabel(`${altText}${slopeText}`, width / 2, height - 14, '#e9eef3');
}

function drawOverlays(mission, width, height) {
  const view = makeProjector(mission, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, view.horizonY);
  ctx.lineTo(width, view.horizonY);
  ctx.stroke();

  drawRoutes(mission, view);
  drawObstacles(mission, view, width);
  drawSciencePoints(mission, view);
  drawShip(mission, view);
  drawCompass(mission, width);
  drawGuideArrow(mission, width, height);
  drawCenterInfo(mission, width, height);
}

/* ------------------------------------------------------------------ HUD */

function cardinalOf(heading) {
  return CARDINALS[Math.round(normalizeAngle360(heading) / 45) % 8];
}

function updateHud(mission) {
  const a = mission.astronaut;
  const movement = getMovementStatus();

  setText('lat', isFiniteNumber(a.latitude) ? `${Math.abs(a.latitude).toFixed(5)}° ${a.latitude >= 0 ? 'N' : 'S'}` : '—');
  setText('lon', isFiniteNumber(a.longitude) ? `${a.longitude.toFixed(5)}° E` : '—');
  setText('alt', isFiniteNumber(a.altitude) ? `${Math.round(a.altitude)} m` : '—');
  setText('ori', `${Math.round(a.headingDegrees)}° ${cardinalOf(a.headingDegrees)}`);
  setText('prec', isFiniteNumber(a.precisionMeters) ? `±${a.precisionMeters.toFixed(1)} m` : '—');
  setText('mode', mission.insideVehicle ? 'In vehicle' : 'On foot');

  const label = SPEED_LABELS[a.speedClass] || '—';
  setText('speed', a.isMoving ? `${label} · ${a.speedMetersPerSecond.toFixed(1)} m/s` : 'Stopped');
  const terrainText = movement.terrainType === 'unknown'
    ? '—'
    : `${movement.terrainType} · ${isFiniteNumber(movement.slopeDegrees) ? movement.slopeDegrees.toFixed(1) : '—'}° · ${label}`;
  setText('terrain', terrainText);

  // Navigation (filled by the route planning stage).
  const nav = mission.navigation && mission.navigation.status;
  if (nav && nav.destinationName) {
    setText('dest', nav.destinationName);
    setText('remaining', formatDistance(nav.remainingDistanceMeters));
    setText('eta', isFiniteNumber(nav.etaSeconds) ? formatDuration(nav.etaSeconds) : '—');
    if (isFiniteNumber(nav.bearingDegrees)) {
      const rel = angleDifference(a.headingDegrees, nav.bearingDegrees);
      const turn = Math.abs(rel) < 5 ? 'ahead' : `${rel > 0 ? 'right' : 'left'} ${Math.round(Math.abs(rel))}°`;
      setText('direction', `${Math.round(nav.bearingDegrees)}° ${cardinalOf(nav.bearingDegrees)} · ${turn}`);
    } else {
      setText('direction', '—');
    }
  } else {
    setText('dest', 'No destination selected');
    setText('remaining', '—');
    setText('eta', '—');
    setText('direction', '—');
  }

  // Vehicle battery.
  const battery = mission.vehicle.batteryPercent;
  if (isFiniteNumber(battery)) {
    setText('battery', `${Math.round(battery)} %`);
    const bar = fields.batteryBar;
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, battery))}%`;
      bar.classList.toggle('low', battery <= CONFIG.vehicle.battery.lowThresholdPercent);
    }
  }

  // Environment (simulated).
  const env = mission.environment.current;
  setText('temp', env ? `${env.temperatureC.toFixed(1)} °C` : '—');
  setText('wind', env ? `${env.windSpeedMps.toFixed(1)} m/s` : '—');
  setText('rad', env ? `${env.radiationMicroSvPerHour.toFixed(1)} µSv/h` : '—');

  // Banner and messages.
  const paused = mission.phase === LIFECYCLE.MISSION_PAUSED;
  if (bannerEl.hidden === paused) bannerEl.hidden = !paused;
  const block = movement.blockedReason ? BLOCK_TEXT[movement.blockedReason] : null;
  if (block) {
    if (messageEl.textContent !== block) messageEl.textContent = block;
    messageEl.hidden = false;
  } else {
    messageEl.hidden = true;
  }
}

/* ------------------------------------------------------------------ frame */

function render(realDt) {
  const mission = getCurrentMission();
  if (!mission || !root || !isExplorationVisible()) return;
  const a = mission.astronaut;
  if (!isFiniteNumber(a.latitude) || !isFiniteNumber(a.longitude)) return;

  resizeIfNeeded();
  if (cssWidth < 50 || cssHeight < 50) return;

  if (!display || display.missionId !== mission.id) snapDisplay(mission);
  // The simulation moves the astronaut 10 times per second: the drawn position follows it smoothly.
  const k = 1 - Math.exp(-realDt * 14);
  display.latitude += (a.latitude - display.latitude) * k;
  display.longitude += (a.longitude - display.longitude) * k;
  display.travel += (getTravelMeters() - display.travel) * k;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  drawPanorama(ctx, cssWidth, cssHeight, {
    latitude: display.latitude,
    longitude: display.longitude,
    headingDegrees: a.headingDegrees,
    pitchDegrees: a.pitchDegrees,
    travelMeters: display.travel
  });
  drawOverlays(mission, cssWidth, cssHeight);

  const now = performance.now();
  if (now - lastHudAt >= HUD_INTERVAL_MS) {
    lastHudAt = now;
    updateHud(mission);
  }
}

/* ------------------------------------------------------------------ init */

export function initExplorationView() {
  if (!buildDom()) return;
  setupMouse();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearControls);

  on(EVENTS.MISSION_STARTED, () => {
    display = null;
    elevationCache.clear();
  });
  on(EVENTS.POSITION_UPDATED, (payload) => {
    if (payload && payload.teleported && payload.mission) snapDisplay(payload.mission);
  });

  onFrame(render);

  loadPanoramas().then((status) => {
    if (status.failed.length > 0) {
      showToast(`${status.failed.length} panorama image(s) could not be loaded. Check assets/images/panoramas/.`, 'warning');
    }
  });
}