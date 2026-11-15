/**
 * MAЯPS — Mission Log (Stage 9): position recording + the log view.
 *
 * RECORDING
 *   Astronaut and vehicle positions are recorded every CONFIG.log.positionIntervalSeconds of SIMULATED time
 *   (exploration only). Because a simulation step can be longer than the interval (x30 multiplier), each
 *   record is interpolated between the previous and the current step, so the timestamps are exact.
 *   Records: mission.records.astronautPositions / vehiclePositions.
 *   Environment (30 s) is recorded by environment.js; events by every module through records.js.
 *
 * LOG VIEW (createLogView) is shared by the Mission Log section (live) and the Mission Archive (saved missions).
 * It reads the mission data only, so an imported mission shows exactly what was recorded.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, appState, getCurrentMission } from './state.js';
import { on, EVENTS } from './events.js';
import { onMissionTick, PHASE_LABELS, formatElapsed } from './mission-manager.js';
import { onFrame } from './simulation.js';
import { getElevation } from './terrain.js';
import {
  angleDifference, normalizeAngle360, escapeHtml, formatClock, formatDistance, formatDuration,
  formatCoordinate, isFiniteNumber
} from './utils.js';
import { exportMission } from './data-export.js';

/* ------------------------------------------------------------------ recording */

let rec = null;   // { missionId, nextDueMs, prev }

function snapshot(mission) {
  const a = mission.astronaut;
  const v = mission.vehicle;
  return {
    ms: mission.clock.elapsedMs,
    aLat: a.latitude, aLon: a.longitude, aAlt: a.altitude, aHead: a.headingDegrees,
    vLat: v.latitude, vLon: v.longitude, vHead: v.headingDegrees
  };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function pushRecords(mission, prev, snap, f, dueMs) {
  const p = prev || snap;
  const mix = (k) => {
    const x = p[k];
    const y = snap[k];
    if (isFiniteNumber(x) && isFiniteNumber(y)) return x + (y - x) * f;
    return isFiniteNumber(y) ? y : null;
  };
  const heading = (k) => r1(normalizeAngle360(p[k] + angleDifference(p[k], snap[k]) * f));
  const timestamp = mission.startTime + dueMs;
  const a = mission.astronaut;
  const v = mission.vehicle;
  const inside = Boolean(mission.insideVehicle);

  const alt = mix('aAlt');
  mission.records.astronautPositions.push({
    timestamp,
    elapsedMs: dueMs,
    latitude: r6(mix('aLat')),
    longitude: r6(mix('aLon')),
    altitude: alt === null ? null : r1(alt),
    headingDegrees: heading('aHead'),
    precisionMeters: isFiniteNumber(a.precisionMeters) ? r1(a.precisionMeters) : null,
    movementMode: a.movementMode || (inside ? 'vehicle' : 'walking')
  });

  const vLat = mix('vLat');
  const vLon = mix('vLon');
  if (vLat !== null && vLon !== null) {
    const vAlt = inside ? alt : getElevation(vLat, vLon);
    mission.records.vehiclePositions.push({
      timestamp,
      elapsedMs: dueMs,
      latitude: r6(vLat),
      longitude: r6(vLon),
      altitude: isFiniteNumber(vAlt) ? r1(vAlt) : null,
      headingDegrees: heading('vHead'),
      batteryPercent: isFiniteNumber(v.batteryPercent) ? r1(v.batteryPercent) : null,
      status: inside ? 'driven' : 'parked'
    });
  }
}

function onTick({ mission }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  if (!isFiniteNumber(mission.astronaut.latitude) || !isFiniteNumber(mission.astronaut.longitude)) return;

  if (!rec || rec.missionId !== mission.id) rec = { missionId: mission.id, nextDueMs: mission.clock.elapsedMs, prev: null };
  const snap = snapshot(mission);
  const interval = Math.max(1, CONFIG.log.positionIntervalSeconds) * 1000;

  let guard = 0;
  while (snap.ms >= rec.nextDueMs && guard < 200) {
    guard += 1;
    let f = 1;
    if (rec.prev && snap.ms > rec.prev.ms) f = Math.min(1, Math.max(0, (rec.nextDueMs - rec.prev.ms) / (snap.ms - rec.prev.ms)));
    pushRecords(mission, rec.prev, snap, f, rec.nextDueMs);
    rec.nextDueMs += interval;
  }
  rec.prev = snap;
}

/* ------------------------------------------------------------------ formatting helpers */

function fmt(value, decimals, unit = '') {
  return isFiniteNumber(value) ? `${value.toFixed(decimals)}${unit}` : '—';
}

function elapsedOf(mission, record) {
  if (isFiniteNumber(record.elapsedMs)) return record.elapsedMs;
  return isFiniteNumber(record.timestamp) ? record.timestamp - mission.startTime : 0;
}

function timeHtml(mission, record) {
  if (!isFiniteNumber(record.timestamp)) return '—';
  return `${escapeHtml(formatClock(record.timestamp))} <span class="muted">T+${escapeHtml(formatElapsed(elapsedOf(mission, record)))}</span>`;
}

function table(headers, rows) {
  if (rows.length === 0) return '<p class="muted">No records.</p>';
  const head = headers.map((h) => `<th>${h}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="log-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function limited(list, limit, key) {
  const shown = list.length > limit ? list.slice(-limit) : list;
  const note = list.length > limit
    ? `<p class="hint">Showing the last ${limit} of ${list.length}. <button type="button" class="btn btn-small" data-more="${key}">Show earlier</button></p>`
    : '';
  return { shown, note };
}

const sev = (s) => (['info', 'success', 'warning', 'error'].includes(s) ? s : 'info');

/* ------------------------------------------------------------------ sections */

const DEFS = [
  {
    key: 'events', title: 'Events', open: true, limit: 200,
    count: (m) => m.records.missionEvents.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.missionEvents, limit, 'events');
      if (shown.length === 0) return '<p class="muted">No events.</p>';
      const items = shown.map((e) =>
        `<li class="sev-${sev(e.severity)}"><span class="log-time">${timeHtml(m, e)}</span> — ${escapeHtml(e.message ?? e.description ?? '')}</li>`
      ).join('');
      return `${note}<ul class="log-events">${items}</ul>`;
    }
  },
  {
    key: 'astronaut', title: 'Astronaut positions', open: false, limit: 100,
    count: (m) => m.records.astronautPositions.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.astronautPositions, limit, 'astronaut');
      return note + table(
        ['Time', 'Latitude', 'Longitude', 'Altitude', 'Orientation', 'Precision', 'Mode'],
        shown.map((p) => [
          timeHtml(m, p), fmt(p.latitude, 5, '°'), fmt(p.longitude, 5, '°'), fmt(p.altitude, 0, ' m'),
          fmt(p.headingDegrees, 0, '°'), isFiniteNumber(p.precisionMeters) ? `±${p.precisionMeters.toFixed(1)} m` : '—',
          escapeHtml(p.movementMode ?? '—')
        ])
      );
    }
  },
  {
    key: 'vehicle', title: 'Vehicle positions', open: false, limit: 100,
    count: (m) => m.records.vehiclePositions.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.vehiclePositions, limit, 'vehicle');
      return note + table(
        ['Time', 'Latitude', 'Longitude', 'Altitude', 'Orientation', 'Battery', 'Status'],
        shown.map((p) => [
          timeHtml(m, p), fmt(p.latitude, 5, '°'), fmt(p.longitude, 5, '°'), fmt(p.altitude, 0, ' m'),
          fmt(p.headingDegrees, 0, '°'), fmt(p.batteryPercent, 0, ' %'), escapeHtml(p.status ?? '—')
        ])
      );
    }
  },
  {
    key: 'environment', title: 'Environmental measurements (simulated)', open: false, limit: 100,
    count: (m) => m.records.environmentMeasurements.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.environmentMeasurements, limit, 'environment');
      return note + table(
        ['Time', 'Latitude', 'Longitude', 'Temperature', 'Wind', 'Radiation', 'Provenance'],
        shown.map((p) => [
          timeHtml(m, p), fmt(p.latitude, 4, '°'), fmt(p.longitude, 4, '°'), fmt(p.temperatureC, 1, ' °C'),
          fmt(p.windSpeedMps, 1, ' m/s'), fmt(p.radiationMicroSvPerHour, 1, ' µSv/h'), escapeHtml(p.provenance ?? '—')
        ])
      );
    }
  },
  {
    key: 'routes', title: 'Routes', open: false, limit: 50,
    count: (m) => m.records.routes.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.routes, limit, 'routes');
      return note + table(
        ['Time', 'Reason', 'Destination', 'Profile', 'Routes calculated'],
        shown.map((r) => [
          timeHtml(m, r),
          escapeHtml(String(r.reason ?? '—').replace(/-/g, ' ')),
          escapeHtml(r.destinationName ?? '—'),
          escapeHtml(r.profile ?? '—'),
          (Array.isArray(r.routes) ? r.routes : []).map((x, i) =>
            `${i === r.selectedIndex ? '▶ ' : ''}${escapeHtml(x.label ?? '')}: ${escapeHtml(formatDistance(x.distanceMeters))}, ${escapeHtml(formatDuration(x.timeSeconds))}, safety ${isFiniteNumber(x.safetyScore) ? x.safetyScore : '—'}`
          ).join('<br>')
        ])
      );
    }
  },
  {
    key: 'obstacles', title: 'Obstacles (known and detected)', open: false, limit: 1000,
    count: (m) => m.obstacles.filter((o) => o.known === true || o.detected === true).length,
    render: (m) => {
      const list = m.obstacles.filter((o) => o.known === true || o.detected === true);
      return table(
        ['ID', 'Type', 'Origin', 'Detection time', 'Sensor', 'Coordinates'],
        list.map((o) => [
          escapeHtml(o.id), escapeHtml(o.type), o.known === true ? 'Known (orbital survey)' : 'Detected in mission',
          o.known === true || !isFiniteNumber(o.detectionTime) ? '—' : timeHtml(m, { timestamp: o.detectionTime }),
          escapeHtml(o.sourceSensor ?? '—'), escapeHtml(formatCoordinate(o.latitude, o.longitude, 3))
        ])
      );
    }
  },
  {
    key: 'science', title: 'Scientific points', open: false, limit: 1000,
    count: (m) => m.records.scientificVisits.length,
    render: (m) => {
      const visitOf = (id) => m.records.scientificVisits.find((v) => v.id === id);
      return table(
        ['Name', 'Type', 'Status', 'Visit time', 'Coordinates'],
        m.scientificPoints.map((p) => {
          const visit = visitOf(p.id);
          return [
            escapeHtml(p.name ?? p.id), escapeHtml(String(p.type ?? '').replace(/-/g, ' ')),
            visit || p.visited ? 'Visited' : 'Pending', visit ? timeHtml(m, visit) : '—',
            escapeHtml(formatCoordinate(p.latitude, p.longitude, 3))
          ];
        })
      );
    }
  },
  {
    key: 'battery', title: 'Battery history', open: false, limit: 100,
    count: (m) => m.records.batteryEvents.length,
    render: (m, limit) => {
      const { shown, note } = limited(m.records.batteryEvents, limit, 'battery');
      return note + table(
        ['Time', 'Type', 'Battery', 'Distance driven', 'Inside vehicle'],
        shown.map((b) => [
          timeHtml(m, b), escapeHtml(String(b.type ?? '—').replace(/-/g, ' ')), fmt(b.batteryPercent, 1, ' %'),
          isFiniteNumber(b.distanceTravelledMeters) ? escapeHtml(formatDistance(b.distanceTravelledMeters)) : '—',
          b.insideVehicle ? 'Yes' : 'No'
        ])
      );
    }
  }
];

function summaryHtml(m) {
  const l = m.landing || {};
  const point = (p) => (p ? escapeHtml(formatCoordinate(p.latitude, p.longitude)) : '—');
  const started = isFiniteNumber(m.startTime) ? new Date(m.startTime).toLocaleString() : '—';
  const ended = isFiniteNumber(m.endTime) ? new Date(m.endTime).toLocaleString() : '—';
  return `
    <table class="kv">
      <tr><th>ID</th><td class="mono">${escapeHtml(m.id)}</td></tr>
      <tr><th>Name</th><td>${escapeHtml(m.name)}</td></tr>
      <tr><th>Status</th><td>${escapeHtml(m.status)}${m.imported ? ' · imported' : ''} · ${escapeHtml(PHASE_LABELS[m.phase] || m.phase)}</td></tr>
      <tr><th>Started / ended</th><td>${escapeHtml(started)} / ${escapeHtml(ended)}</td></tr>
      <tr><th>Simulated duration</th><td>${escapeHtml(formatDuration(m.clock.elapsedMs / 1000))}</td></tr>
      <tr><th>Planned landing</th><td class="mono">${point(l.planned)}</td></tr>
      <tr><th>Actual landing</th><td class="mono">${point(l.actual)}</td></tr>
    </table>
    <button type="button" class="btn btn-small" data-export>Export Mission Data</button>`;
}

/* ------------------------------------------------------------------ view */

/** Builds the log inside `container`. Returns { update(mission, force), destroy() }. */
export function createLogView(container) {
  container.innerHTML =
    '<div class="card log-summary"></div>' +
    DEFS.map((d) => `<details class="log-section" data-sec="${d.key}"${d.open ? ' open' : ''}><summary></summary><div class="log-body"></div></details>`).join('');

  const summaryEl = container.querySelector('.log-summary');
  const sections = DEFS.map((d) => {
    const details = container.querySelector(`details[data-sec="${d.key}"]`);
    return { d, details, summary: details.querySelector('summary'), body: details.querySelector('.log-body') };
  });
  const limits = {};
  const cache = new Map();
  let current = null;
  let shownId = null;

  function setHtml(el, html, key) {
    if (cache.get(key) === html) return;
    el.innerHTML = html;
    cache.set(key, html);
  }

  function update(mission, force = false) {
    if (!mission) return;
    if (mission.id !== shownId) {
      shownId = mission.id;
      for (const d of DEFS) limits[d.key] = d.limit;
      cache.clear();
    }
    if (force) cache.clear();
    current = mission;

    setHtml(summaryEl, summaryHtml(mission), 'summary');
    for (const s of sections) {
      setHtml(s.summary, `${escapeHtml(s.d.title)} (${s.d.count(mission)})`, `t:${s.d.key}`);
      if (s.details.open) setHtml(s.body, s.d.render(mission, limits[s.d.key]), `b:${s.d.key}`);
    }
  }

  const onToggle = () => { if (current) update(current); };
  sections.forEach((s) => s.details.addEventListener('toggle', onToggle));

  container.addEventListener('click', (event) => {
    const more = event.target.closest('[data-more]');
    if (more && current) {
      limits[more.dataset.more] = (limits[more.dataset.more] || 100) + 300;
      update(current, true);
      return;
    }
    if (event.target.closest('[data-export]') && current) exportMission(current);
  });

  return { update, destroy() { container.innerHTML = ''; current = null; } };
}

/* ------------------------------------------------------------------ section init */

let view = null;
let lastRefreshAt = 0;
let emptyEl = null;
let viewEl = null;

function refresh(force = false) {
  if (!view) return;
  const mission = getCurrentMission();
  emptyEl.hidden = Boolean(mission);
  viewEl.hidden = !mission;
  if (mission) view.update(mission, force);
}

export function initMissionLog() {
  on(EVENTS.MISSION_STARTED, () => { rec = null; });
  on(EVENTS.MISSION_ENDED, () => { rec = null; });
  onMissionTick(onTick);

  const root = document.getElementById('log-root');
  if (!root) return;
  root.innerHTML = `
    <h2>Mission Log</h2>
    <div class="card" id="log-empty">
      <p>There is no active mission. The Mission Log shows the current mission only.</p>
      <p class="hint">Finished missions are in the Mission Archive.</p>
    </div>
    <div id="log-view"></div>`;
  emptyEl = document.getElementById('log-empty');
  viewEl = document.getElementById('log-view');
  view = createLogView(viewEl);

  on(EVENTS.SECTION_CHANGED, (p) => { if (p.section === 'mission-log') refresh(true); });
  on(EVENTS.MISSION_STARTED, () => refresh(true));
  on(EVENTS.MISSION_ENDED, () => refresh(true));
  onFrame(() => {
    if (appState.currentSection !== 'mission-log') return;
    const now = performance.now();
    if (now - lastRefreshAt < 1000) return;
    lastRefreshAt = now;
    refresh(false);
  });
  refresh(true);
}