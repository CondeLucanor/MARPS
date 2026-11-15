/**
 * MAЯPS — navigation system: destinations, route selection, HUD status, dynamic recalculation,
 * off-route detection, "Return to Vehicle" and the arrival window.
 *
 * Single entry point for choosing a destination: EVENTS.DESTINATION_SELECTED with { id, source }.
 *   id = a scientific point id (SCI_001...) or "VEHICLE" (Return to Vehicle).
 * The map, the buttons of this module and the arrival window all use it.
 *
 * Data in the mission (mission.navigation):
 *   destinationId, routes { recommended, alternatives[] }, selectedRouteIndex,
 *   status { destinationName, remainingDistanceMeters, etaSeconds, bearingDegrees, deviationMeters, routeIndex }
 *   reachedDestinationId
 * Every calculation is stored in mission.records.routes (the points of the selected route are decimated).
 *
 * The astronaut is NOT moved automatically: the route is a guide shown in the HUD and on the map.
 * Stopping, pausing or changing section never loses the selected route.
 *
 * The interface is drawn in two places: the side panel of the Map section and a compact bar over the
 * first-person view (route chips, destination picker, Return to Vehicle).
 *
 * "Exit Vehicle" in the arrival window emits the event "VEHICLE_EXIT_REQUESTED" (handled by the vehicle stage).
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, appState, getCurrentMission, missionTimestamp } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onFrame } from './simulation.js';
import { addMissionEvent } from './records.js';
import { showToast, showModal } from './ui.js';
import { distanceMeters, bearingDegrees } from './geodesy.js';
import {
  escapeHtml,
  formatCoordinate,
  formatDistance,
  formatDuration,
  isFiniteNumber
} from './utils.js';
import { planRoutes, evaluateRoute } from './route-planner.js';
import { clearControls } from './astronaut.js';

const VEHICLE_ID = 'VEHICLE';
const SHIP_ID = 'SHIP';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS_INTERVAL_MS = 100;
const UI_REFRESH_MS = 1000;
const OFF_ROUTE_CONFIRM_MS = 1500;
const LOOKAHEAD_METERS = 120;
const SEARCH_BACK = 30;
const SEARCH_FORWARD = 600;
const FULL_SCAN_DISTANCE_METERS = 400;
const RECORD_MAX_POINTS = 600;

let panel = null;
let bar = null;
let calculating = false;
let arrivalWindowOpen = false;
let lastRecalcAt = -Infinity;     // real time (performance.now) of the last calculation
let offRouteSince = null;
let progressIndex = 0;
let selectedPointId = null;
let lastStatusAt = 0;
let lastUiAt = 0;
let lastPanelHtml = '';
let lastBarHtml = '';

/* ------------------------------------------------------------------ helpers */

function nextFrames(count) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function routeList(mission) {
  const r = mission.navigation.routes;
  return r ? [r.recommended, ...(r.alternatives || [])].filter(Boolean) : [];
}

function selectedRoute(mission) {
  const list = routeList(mission);
  return list[mission.navigation.selectedRouteIndex] || null;
}

function currentProfile(mission) {
  return mission.insideVehicle ? 'vehicle' : 'astronaut';
}

function routeSummary(route) {
  return `${formatDistance(route.distanceMeters)}, ${formatDuration(route.timeSeconds)}, safety ${route.safetyScore}/100`;
}

function decimate(points, maxPoints) {
  if (points.length <= maxPoints) return points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push({ latitude: points[i].latitude, longitude: points[i].longitude });
  const last = points[points.length - 1];
  out.push({ latitude: last.latitude, longitude: last.longitude });
  return out;
}

function humanize(text) {
  return String(text || '').replace(/-/g, ' ');
}

/** { id, kind, name, latitude, longitude } for a scientific point id or for "VEHICLE". */
function resolveTarget(mission, id) {
  if (id === VEHICLE_ID) {
    const v = mission.vehicle;
    if (!isFiniteNumber(v.latitude) || !isFiniteNumber(v.longitude)) return null;
    return { id, kind: 'vehicle', name: 'Vehicle', latitude: v.latitude, longitude: v.longitude };
  }
  if (id === SHIP_ID) {
    const s = mission.landing && mission.landing.actual;
    if (!s || !isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return null;
    return { id, kind: 'ship', name: 'Landing ship', latitude: s.latitude, longitude: s.longitude };
  }
  const point = mission.scientificPoints.find((p) => p.id === id);
  if (!point) return null;
  return { id, kind: 'science', name: point.name, latitude: point.latitude, longitude: point.longitude, point };
}

function resetModuleState() {
  calculating = false;
  arrivalWindowOpen = false;
  lastRecalcAt = -Infinity;
  offRouteSince = null;
  progressIndex = 0;
  selectedPointId = null;
  lastPanelHtml = '';
  lastBarHtml = '';
}

function addRouteRecord(mission, reason, target, routes, selectedIndex, profile) {
  mission.counters.route += 1;
  const a = mission.astronaut;
  const selected = routes[selectedIndex];
  mission.records.routes.push({
    id: `ROUTE_${String(mission.counters.route).padStart(3, '0')}`,
    timestamp: missionTimestamp(mission),
    elapsedMs: mission.clock.elapsedMs,
    reason,
    destinationId: target.id,
    destinationName: target.name,
    profile,
    from: { latitude: a.latitude, longitude: a.longitude },
    to: { latitude: target.latitude, longitude: target.longitude },
    selectedIndex,
    routes: routes.map((r) => ({
      label: r.label,
      recommended: r.recommended,
      distanceMeters: r.distanceMeters,
      timeSeconds: r.timeSeconds,
      safetyScore: r.safetyScore
    })),
    points: decimate(selected.points, RECORD_MAX_POINTS)
  });
}

/* ------------------------------------------------------------------ route calculation */

function applyRoutes(mission, target, result, reason, profile) {
  const nav = mission.navigation;
  nav.destinationId = target.id;
  nav.routes = { recommended: result.routes[0], alternatives: result.routes.slice(1) };
  nav.selectedRouteIndex = 0;
  progressIndex = 0;
  offRouteSince = null;
  lastRecalcAt = performance.now();

  const a = mission.astronaut;
  const best = result.routes[0];
  const count = result.routes.length;
  addRouteRecord(mission, reason, target, result.routes, 0, profile);
  emit(EVENTS.ROUTE_UPDATED, { mission, reason });

  if (reason === 'initial' || reason === 'return-to-vehicle' || reason === 'return-to-ship') {
    addMissionEvent(mission, {
      type: 'ROUTE_CALCULATED',
      severity: 'success',
      message: `Routes calculated to ${target.name}: ${count} route${count > 1 ? 's' : ''}. Recommended: ${routeSummary(best)}.`,
      latitude: a.latitude,
      longitude: a.longitude,
      data: { destinationId: target.id, routeCount: count, reason }
    });
    showToast(`Route calculated: ${count} route${count > 1 ? 's' : ''} available.`, 'success');
  } else {
    const why = reason === 'obstacle' ? 'new obstacle' : reason === 'profile-change' ? 'mobility profile changed' : 'off route';
    addMissionEvent(mission, {
      type: 'ROUTE_CHANGED',
      severity: 'warning',
      message: `Route recalculated (${why}). New recommended route: ${routeSummary(best)}.`,
      latitude: a.latitude,
      longitude: a.longitude,
      data: { destinationId: target.id, routeCount: count, reason }
    });
    emit(EVENTS.ROUTE_RECALCULATED, { mission, reason });
    showToast('Route Recalculated', 'info');
  }
}

/** reason: 'initial' | 'return-to-vehicle' | 'obstacle' | 'off-route' */
async function calculateRoutes(mission, target, reason) {
  if (calculating) return false;
  calculating = true;
  refreshUi(true);
  await nextFrames(2);   // lets the screen show "Calculating routes…" before the heavy work

  let ok = false;
  try {
    if (getCurrentMission() !== mission) return false;
    const a = mission.astronaut;
    const profile = currentProfile(mission);
    const result = planRoutes({
      from: { latitude: a.latitude, longitude: a.longitude },
      to: { latitude: target.latitude, longitude: target.longitude },
      profile,
      obstacles: mission.obstacles
    });

    if (result.error || result.routes.length === 0) {
      showToast(result.error || 'No route was found.', 'error');
      if (reason === 'initial' || reason === 'return-to-vehicle' || reason === 'return-to-ship') clearDestination(mission, { silent: true });
      return false;
    }
    applyRoutes(mission, target, result, reason, profile);
    ok = true;
  } catch (err) {
    console.error('[MAЯPS] Route calculation failed:', err);
    showToast('The route could not be calculated. Open the Console (F12) for details.', 'error');
  } finally {
    calculating = false;
    refreshUi(true);
  }
  return ok;
}

function clearDestination(mission, { silent = false } = {}) {
  const nav = mission.navigation;
  const had = Boolean(nav.destinationId);
  nav.destinationId = null;
  nav.routes = { recommended: null, alternatives: [] };
  nav.selectedRouteIndex = 0;
  nav.status = null;
  progressIndex = 0;
  offRouteSince = null;
  if (had && !silent) {
    addMissionEvent(mission, { type: 'DESTINATION_CLEARED', message: 'Destination cleared.' });
  }
  emit(EVENTS.ROUTE_UPDATED, { mission, reason: 'cleared' });
  refreshUi(true);
}

function selectRoute(index) {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const list = routeList(mission);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
  if (index === mission.navigation.selectedRouteIndex) return;
  const target = resolveTarget(mission, mission.navigation.destinationId);
  if (!target) return;

  mission.navigation.selectedRouteIndex = index;
  progressIndex = 0;
  offRouteSince = null;

  const route = list[index];
  const a = mission.astronaut;
  addRouteRecord(mission, 'route-selected', target, list, index, currentProfile(mission));
  addMissionEvent(mission, {
    type: 'ROUTE_CHANGED',
    message: `Route changed to ${route.label}: ${routeSummary(route)}.`,
    latitude: a.latitude,
    longitude: a.longitude,
    data: { destinationId: target.id, routeIndex: index }
  });
  emit(EVENTS.ROUTE_UPDATED, { mission, reason: 'route-selected' });
  refreshUi(true);
}

/* ------------------------------------------------------------------ events */

function onDestinationSelected(payload) {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) {
    showToast('Destinations can only be chosen while exploration is active.', 'warning');
    return;
  }
  const id = payload && typeof payload.id === 'string' ? payload.id : '';
  if (!ID_PATTERN.test(id)) return;

  if (id === VEHICLE_ID && mission.insideVehicle) {
    showToast('You are already inside the vehicle.', 'warning');
    return;
  }
  const target = resolveTarget(mission, id);
  if (!target) {
    showToast('That destination does not exist.', 'warning');
    return;
  }
  if (calculating) {
    showToast('Routes are being calculated. Please wait.', 'warning');
    return;
  }

  const nav = mission.navigation;
  nav.destinationId = id;
  nav.routes = { recommended: null, alternatives: [] };
  nav.selectedRouteIndex = 0;
  nav.status = null;
  nav.reachedDestinationId = null;
  progressIndex = 0;
  offRouteSince = null;

  const a = mission.astronaut;
  addMissionEvent(mission, {
    type: 'DESTINATION_SELECTED',
    message: id === VEHICLE_ID ? 'Destination selected: return to the vehicle.'
    : id === SHIP_ID ? 'Destination selected: return to the landing ship.'
    : `Destination selected: ${target.name}.`,
    latitude: target.latitude,
    longitude: target.longitude,
    data: { destinationId: id, from: formatCoordinate(a.latitude, a.longitude) }
  });
  calculateRoutes(mission, target, id === VEHICLE_ID ? 'return-to-vehicle' : id === SHIP_ID ? 'return-to-ship' : 'initial');
}

function onObstacleDetected({ mission }) {
  if (!mission || mission !== getCurrentMission()) return;
  const nav = mission.navigation;
  if (!nav.destinationId || calculating) return;
  const route = selectedRoute(mission);
  const target = resolveTarget(mission, nav.destinationId);
  if (!route || !target) return;

  const profile = currentProfile(mission);
  const remaining = route.points.slice(Math.max(0, progressIndex));
  const check = evaluateRoute(remaining, { profile, obstacles: mission.obstacles });

  if (check && check.blocked) {
    calculateRoutes(mission, target, 'obstacle');   // the route is no longer suitable
    return;
  }
  // Still suitable: only its evaluation is refreshed.
  const full = evaluateRoute(route.points, { profile, obstacles: mission.obstacles });
  if (full) {
    route.safetyScore = full.safetyScore;
    route.scores = full.scores;
    route.minClearanceMeters = full.minClearanceMeters;
    emit(EVENTS.ROUTE_UPDATED, { mission, reason: 'reevaluated' });
    refreshUi(true);
  }
}

/* ------------------------------------------------------------------ progress, status, off-route, arrival */

function locateOnRoute(route, lat, lon) {
  const pts = route.points;
  const n = pts.length;

  const scan = (from, to) => {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = from; i <= to; i += 1) {
      const d = distanceMeters(lat, lon, pts[i].latitude, pts[i].longitude);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return { index: best, deviationMeters: bestDistance };
  };

  let found = scan(Math.max(0, progressIndex - SEARCH_BACK), Math.min(n - 1, progressIndex + SEARCH_FORWARD));
  if (found.deviationMeters > FULL_SCAN_DISTANCE_METERS) found = scan(0, n - 1);
  progressIndex = found.index;
  return found;
}

function processNavigation(mission, now) {
  const nav = mission.navigation;
  if (!nav.destinationId) {
    nav.status = null;
    return;
  }
  const target = resolveTarget(mission, nav.destinationId);
  if (!target) {
    clearDestination(mission, { silent: true });
    return;
  }

  const a = mission.astronaut;
  const straight = distanceMeters(a.latitude, a.longitude, target.latitude, target.longitude);
  const route = selectedRoute(mission);
  let deviation = null;

  if (route && route.points.length > 1) {
    const loc = locateOnRoute(route, a.latitude, a.longitude);
    deviation = loc.deviationMeters;
    const last = route.points.length - 1;
    const remainingDistance = Math.max(0, route.cumulativeDistance[last] - route.cumulativeDistance[loc.index]) + deviation;
    const averageSpeed = route.distanceMeters / Math.max(1, route.timeSeconds);
    const eta = Math.max(0, route.timeSeconds - route.cumulativeTime[loc.index]) + deviation / averageSpeed;

    let j = loc.index;
    while (j < last && route.cumulativeDistance[j] - route.cumulativeDistance[loc.index] < LOOKAHEAD_METERS) j += 1;
    const aim = remainingDistance < LOOKAHEAD_METERS ? target : route.points[j];
    nav.status = {
      destinationName: target.name,
      remainingDistanceMeters: remainingDistance,
      etaSeconds: eta,
      bearingDegrees: bearingDegrees(a.latitude, a.longitude, aim.latitude, aim.longitude),
      deviationMeters: deviation,
      routeIndex: nav.selectedRouteIndex
    };
  } else {
    nav.status = {
      destinationName: target.name,
      remainingDistanceMeters: straight,
      etaSeconds: null,
      bearingDegrees: bearingDegrees(a.latitude, a.longitude, target.latitude, target.longitude),
      deviationMeters: null,
      routeIndex: -1
    };
  }

  if (calculating || arrivalWindowOpen) return;

  const arrivalRadius = target.kind === 'science'
    ? CONFIG.scientificPoints.arrivalRadiusMeters
    : CONFIG.routePlanning.arrivalRadiusMeters;
  if (straight <= arrivalRadius) {
    handleArrival(mission, target);
    return;
  }

  const threshold = CONFIG.routePlanning.offRouteThresholdMeters;
  if (route && deviation !== null && deviation > threshold) {
    if (offRouteSince === null) offRouteSince = now;
    const sustained = now - offRouteSince >= OFF_ROUTE_CONFIRM_MS;
    const cooled = now - lastRecalcAt >= CONFIG.routePlanning.recalcCooldownSeconds * 1000;
    if (sustained && cooled) {
      offRouteSince = null;
      addMissionEvent(mission, {
        type: 'OFF_ROUTE_DETECTED',
        severity: 'warning',
        message: `Off route by ${formatDistance(deviation)}. Recalculating.`,
        latitude: a.latitude,
        longitude: a.longitude,
        data: { deviationMeters: deviation }
      });
      calculateRoutes(mission, target, 'off-route');
    }
  } else {
    offRouteSince = null;
  }
}

/* ------------------------------------------------------------------ arrival window and picker */

async function handleArrival(mission, target) {
  const nav = mission.navigation;
  const a = mission.astronaut;
  nav.reachedDestinationId = target.id;

  nav.destinationId = null;
  nav.routes = { recommended: null, alternatives: [] };
  nav.selectedRouteIndex = 0;
  nav.status = null;
  progressIndex = 0;
  offRouteSince = null;

  addMissionEvent(mission, {
    type: 'DESTINATION_REACHED',
    severity: 'success',
    message: `Destination reached: ${target.name}.`,
    latitude: a.latitude,
    longitude: a.longitude,
    data: { destinationId: target.id }
  });
  emit(EVENTS.ROUTE_UPDATED, { mission, reason: 'arrival' });
  emit(EVENTS.DESTINATION_REACHED, {
    mission,
    target: { id: target.id, kind: target.kind, name: target.name, latitude: target.latitude, longitude: target.longitude }
  });
  refreshUi(true);

  if (target.kind === 'vehicle' || target.kind === 'ship') {
    showToast(target.kind === 'ship' ? 'You have reached the landing ship.' : 'You have reached the vehicle.', 'success');
    return;
  }
  arrivalWindowOpen = true;
  clearControls();
  const point = target.point;
  const inVehicle = mission.insideVehicle;
  const actions = inVehicle
  ? [
      { label: 'Exit Vehicle', value: 'exit' },
      { label: 'Return to Ship', value: 'ship' },
      { label: 'Continue Exploration', value: 'continue', variant: 'primary' }
    ]
  : [
      { label: 'Return to Vehicle', value: 'return' },
      { label: 'Return to Ship', value: 'ship' },
      { label: 'Continue Exploration', value: 'continue', variant: 'primary' }
    ];

  let choice = null;
  try {
    choice = await showModal({
      title: `Arrived: ${target.name}`,
      bodyHtml:
      (point.image ? `<img class="point-image" src="${escapeHtml(point.image)}" alt="${escapeHtml(point.name)}" onerror="this.style.display='none'">` : '') +
      `<p class="muted">${escapeHtml(humanize(point.type))}</p>` +
      `<p>${escapeHtml(point.description)}</p>` +
      (point.visited ? '<p><span class="badge badge-ok">Visit registered</span></p>' : ''),
      actions,
      focusIndex: actions.length - 1
    });
  } finally {
    arrivalWindowOpen = false;
  }

  if (getCurrentMission() !== mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  if (choice === 'return') emit(EVENTS.DESTINATION_SELECTED, { id: VEHICLE_ID, source: 'ui' });
  else if (choice === 'ship') emit(EVENTS.DESTINATION_SELECTED, { id: SHIP_ID, source: 'ui' });
  else if (choice === 'continue') openDestinationPicker();
  else if (choice === 'exit') emit('VEHICLE_EXIT_REQUESTED', { mission });
}

async function openDestinationPicker() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE || arrivalWindowOpen) return;
  const a = mission.astronaut;

  const points = mission.scientificPoints
    .map((p) => ({ p, d: distanceMeters(a.latitude, a.longitude, p.latitude, p.longitude) }))
    .sort((x, y) => x.d - y.d);
  if (points.length === 0) {
    showToast('There are no scientific points available.', 'warning');
    return;
  }

  arrivalWindowOpen = true;   // blocks automatic arrival windows while this dialog is open
  clearControls();
  let choice = null;
  try {
    choice = await showModal({
      title: 'Choose a destination',
      bodyHtml: '<p>Select one of the predefined scientific locations. Routes are calculated from your current position.</p>',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Return to Ship', value: SHIP_ID },
        ...points.map(({ p, d }) => ({
          label: `${p.name} · ${formatDistance(d)}${p.visited ? ' · visited' : ''}`,
          value: p.id
        }))
      ],
      focusIndex: 1
    });
  } finally {
    arrivalWindowOpen = false;
  }

  if (typeof choice === 'string' && getCurrentMission() === mission && mission.phase === LIFECYCLE.EXPLORATION_ACTIVE) {
    emit(EVENTS.DESTINATION_SELECTED, { id: choice, source: 'ui' });
  }
}

/* ------------------------------------------------------------------ interface */

function routeOptionHtml(route, index, selected, disabled) {
  return `
    <button type="button" class="route-option${selected ? ' selected' : ''}" data-action="route" data-index="${index}"${disabled ? ' disabled' : ''}>
      <span class="route-option-head">
        <strong>${escapeHtml(route.label)}</strong>
        <span>${index === 0 ? '<span class="badge">Recommended</span> ' : ''}${selected ? '<span class="badge badge-ok">Selected</span>' : ''}</span>
      </span>
      <span class="route-option-metrics">${escapeHtml(formatDistance(route.distanceMeters))} · ${escapeHtml(formatDuration(route.timeSeconds))} · safety ${route.safetyScore}/100</span>
    </button>`;
}

function detailHtml(mission) {
    const detail = selectedPointId ? mission.scientificPoints.find((p) => p.id === selectedPointId) : null;
    if (!detail) return '';
    const a = mission.astronaut;
    const exploring = mission.phase === LIFECYCLE.EXPLORATION_ACTIVE;
    const dd = distanceMeters(a.latitude, a.longitude, detail.latitude, detail.longitude);
    return `<h3>Point details</h3><div class="card">
      ${detail.image ? `<img class="point-image" data-fallback="1" src="${escapeHtml(detail.image)}" alt="${escapeHtml(detail.name)}">` : ''}
      <table class="kv">
        <tr><th>Name</th><td>${escapeHtml(detail.name)}</td></tr>
        <tr><th>Type</th><td>${escapeHtml(humanize(detail.type))}</td></tr>
        <tr><th>Coordinates</th><td class="mono">${escapeHtml(formatCoordinate(detail.latitude, detail.longitude))}</td></tr>
        <tr><th>Distance</th><td>${escapeHtml(formatDistance(dd))}</td></tr>
        <tr><th>Status</th><td>${detail.visited ? 'Visited' : 'Pending'}</td></tr>
      </table>
      <p>${escapeHtml(detail.description)}</p>
      ${detail.image ? '' : '<p class="hint">No image available for this point.</p>'}
      <div class="btn-row">
        <button type="button" class="btn btn-small" data-action="close-details">Close</button>
        <button type="button" class="btn btn-small btn-primary" data-action="go" data-id="${escapeHtml(detail.id)}"${exploring ? '' : ' disabled'}>Go to this point</button>
      </div>
    </div>`;
  }
  function panelHtml(mission) {
  const nav = mission.navigation;
  const exploring = mission.phase === LIFECYCLE.EXPLORATION_ACTIVE;
  const dis = exploring ? '' : ' disabled';
  const a = mission.astronaut;
  const target = nav.destinationId ? resolveTarget(mission, nav.destinationId) : null;
  const routes = routeList(mission);

  let html = detailHtml(mission) + '<h3>Navigation</h3><div class="card">';
  if (calculating) {
    html += '<p class="flow-stage">Calculating routes…</p>';
  } else if (target) {
    const s = nav.status;
    html += `<table class="kv">
      <tr><th>Destination</th><td>${escapeHtml(target.name)}</td></tr>
      <tr><th>Remaining</th><td>${s ? escapeHtml(formatDistance(s.remainingDistanceMeters)) : '—'}</td></tr>
      <tr><th>Arrival (ETA)</th><td>${s && isFiniteNumber(s.etaSeconds) ? escapeHtml(formatDuration(s.etaSeconds)) : '—'}</td></tr>
      <tr><th>Off route by</th><td>${s && isFiniteNumber(s.deviationMeters) ? escapeHtml(formatDistance(s.deviationMeters)) : '—'}</td></tr>
    </table>`;
  } else {
    html += '<p class="muted">No destination selected. Choose one below.</p>';
  }
  html += `<div class="btn-row">
  <button type="button" class="btn btn-small" data-action="ship"${dis}>Return to Ship</button>
  <button type="button" class="btn btn-small" data-action="return"${dis}${mission.insideVehicle ? ' disabled' : ''}>Return to Vehicle</button>
  <button type="button" class="btn btn-small" data-action="clear"${dis}${target ? '' : ' disabled'}>Clear destination</button>
</div></div>`;
  if (routes.length > 0) {
    html += '<h3>Routes</h3><div class="card">';
    routes.forEach((route, index) => {
      html += routeOptionHtml(route, index, index === nav.selectedRouteIndex, !exploring);
    });
    html += `<p class="hint">Terrain and obstacle data are partly simulated. Hidden obstacles are unknown to the planner until they are detected.</p></div>`;
  }

  const points = mission.scientificPoints
    .map((p) => ({ p, d: distanceMeters(a.latitude, a.longitude, p.latitude, p.longitude) }))
    .sort((x, y) => x.d - y.d);

  html += '<h3>Scientific points</h3><div class="card">';
  if (points.length === 0) html += '<p class="muted">No scientific points loaded.</p>';
  for (const { p, d } of points) {
    html += `<div class="dest-row">
      <div class="dest-info"><strong>${escapeHtml(p.name)}</strong><span class="muted">${escapeHtml(humanize(p.type))} · ${escapeHtml(formatDistance(d))}</span></div>
      <span class="badge${p.visited ? ' badge-ok' : ' badge-warn'}">${p.visited ? 'Visited' : 'Pending'}</span>
      <button type="button" class="btn btn-small" data-action="details" data-id="${escapeHtml(p.id)}">Details</button>
      <button type="button" class="btn btn-small btn-primary" data-action="go" data-id="${escapeHtml(p.id)}"${dis}>Go</button>
    </div>`;
  }
  html += '</div>';

  const detail = null; // the details card is now drawn at the top by detailHtml()
  if (detail) {
    const dd = distanceMeters(a.latitude, a.longitude, detail.latitude, detail.longitude);
    html += `<h3>Details</h3><div class="card">
      ${detail.image ? `<img class="point-image" data-fallback="1" src="${escapeHtml(detail.image)}" alt="${escapeHtml(detail.name)}">` : ''}
      <table class="kv">
        <tr><th>Name</th><td>${escapeHtml(detail.name)}</td></tr>
        <tr><th>Type</th><td>${escapeHtml(humanize(detail.type))}</td></tr>
        <tr><th>Coordinates</th><td class="mono">${escapeHtml(formatCoordinate(detail.latitude, detail.longitude))}</td></tr>
        <tr><th>Distance</th><td>${escapeHtml(formatDistance(dd))}</td></tr>
        <tr><th>Status</th><td>${detail.visited ? 'Visited' : 'Pending'}</td></tr>
      </table>
      <p>${escapeHtml(detail.description)}</p>
      ${detail.image ? '' : '<p class="hint">No image available for this point.</p>'}
    </div>`;
  }
  return html;
}

function barHtml(mission) {
  const nav = mission.navigation;
  const exploring = mission.phase === LIFECYCLE.EXPLORATION_ACTIVE;
  const dis = exploring ? '' : ' disabled';
  const routes = routeList(mission);
  let html = '';

  if (calculating) html += '<span class="nav-chip nav-chip-info">Calculating routes…</span>';
  routes.forEach((route, index) => {
    const selected = index === nav.selectedRouteIndex;
    html += `<button type="button" class="nav-chip${selected ? ' selected' : ''}" data-action="route" data-index="${index}"${dis}>
      <span>${index === 0 ? 'Recommended' : `Alternative ${index}`}</span>
      <small>${escapeHtml(formatDistance(route.distanceMeters))} · ${escapeHtml(formatDuration(route.timeSeconds))} · ${route.safetyScore}</small>
    </button>`;
  });
  html += `<button type="button" class="nav-chip" data-action="pick"${dis}><span>Destination…</span></button>`;
  html += `<button type="button" class="nav-chip" data-action="return"${dis}${mission.insideVehicle ? ' disabled' : ''}><span>Return to Vehicle</span></button>`;
  html += `<button type="button" class="nav-chip" data-action="ship"${dis}><span>Return to Ship</span></button>`;
  if (nav.destinationId) html += `<button type="button" class="nav-chip" data-action="clear"${dis}><span>Clear</span></button>`;
  return html;
}

function hookImageFallbacks() {
  if (!panel) return;
  panel.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
    });
  });
}

function refreshUi(force) {
  const mission = getCurrentMission();
  const active = Boolean(mission) &&
    (mission.phase === LIFECYCLE.EXPLORATION_ACTIVE || mission.phase === LIFECYCLE.MISSION_PAUSED);

  if (panel) {
    if (!active) {
      if (panel.dataset.owner === 'navigation') {
        panel.innerHTML = '';
        delete panel.dataset.owner;
      }
      lastPanelHtml = '';
    } else if (force || appState.currentSection === 'map') {
        const html = panelHtml(mission);
        const savedScroll = panel.scrollTop;
      if (html !== lastPanelHtml || panel.dataset.owner !== 'navigation' || !panel.firstChild) {
        panel.innerHTML = html;
        panel.dataset.owner = 'navigation';
        lastPanelHtml = html;
        hookImageFallbacks();
        panel.scrollTop = savedScroll;
      }
    }
  }

  if (bar) {
    if (!active) {
      if (lastBarHtml !== '') {
        bar.innerHTML = '';
        lastBarHtml = '';
      }
    } else {
      const html = barHtml(mission);
      if (html !== lastBarHtml) {
        bar.innerHTML = html;
        lastBarHtml = html;
      }
    }
  }
}

function onUiClick(event) {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const mission = getCurrentMission();
  if (!mission) return;

  const action = el.dataset.action;
  if (action === 'close-details') {
    selectedPointId = null;
    refreshUi(true);
    return;
  }
  if (action === 'details') {
    const id = el.dataset.id;
    if (ID_PATTERN.test(id)) {
        selectedPointId = id;
        if (panel) panel.scrollTop = 0;   // the details card is at the top
      refreshUi(true);
    }
    return;
  }
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;

  if (action === 'go') {
    const id = el.dataset.id;
    if (ID_PATTERN.test(id)) emit(EVENTS.DESTINATION_SELECTED, { id, source: 'ui' });
  } else if (action === 'return') {
    emit(EVENTS.DESTINATION_SELECTED, { id: VEHICLE_ID, source: 'ui' });
} else if (action === 'ship') {
    emit(EVENTS.DESTINATION_SELECTED, { id: SHIP_ID, source: 'ui' });
} else if (action === 'route') {
    selectRoute(Number(el.dataset.index));
  } else if (action === 'clear') {
    clearDestination(mission);
  } else if (action === 'pick') {
    openDestinationPicker();
  }
}

/* ------------------------------------------------------------------ loop and init */

function onFrameTick() {
  const now = performance.now();
  const mission = getCurrentMission();

  if (mission && mission.phase === LIFECYCLE.EXPLORATION_ACTIVE && now - lastStatusAt >= STATUS_INTERVAL_MS) {
    lastStatusAt = now;
    processNavigation(mission, now);
  }
  if (now - lastUiAt >= UI_REFRESH_MS) {
    lastUiAt = now;
    refreshUi(false);
  }
}

/** Entering or exiting the vehicle changes the mobility profile: the current route is planned again. */
function onVehicleModeChanged({ mission }) {
    if (!mission || mission !== getCurrentMission()) return;
    const nav = mission.navigation;
    if (!nav.destinationId) return;
    if (nav.destinationId === VEHICLE_ID && mission.insideVehicle) {
      clearDestination(mission, { silent: true });   // you are already in the vehicle
      return;
    }
    const target = resolveTarget(mission, nav.destinationId);
    if (target) calculateRoutes(mission, target, 'profile-change');
  }
  
  export function initNavigationSystem() {
    on(EVENTS.VEHICLE_ENTERED, onVehicleModeChanged);
    on(EVENTS.VEHICLE_EXITED, onVehicleModeChanged);
  panel = document.getElementById('map-side-panel');
  const root = document.getElementById('mission-view-root');
  if (root) {
    bar = document.createElement('div');
    bar.className = 'nav-bar';
    root.appendChild(bar);
    bar.addEventListener('click', onUiClick);
  }
  if (panel) panel.addEventListener('click', onUiClick);

  on(EVENTS.MISSION_STARTED, resetModuleState);
  on(EVENTS.MISSION_ENDED, () => {
    resetModuleState();
    refreshUi(true);
  });
  on(EVENTS.MISSION_PHASE_CHANGED, () => refreshUi(true));
  on(EVENTS.MISSION_PAUSED, () => refreshUi(true));
  on(EVENTS.MISSION_RESUMED, () => refreshUi(true));
  on(EVENTS.SECTION_CHANGED, () => refreshUi(true));
  on(EVENTS.SCIENTIFIC_POINT_VISITED, () => refreshUi(true));
  on(EVENTS.DESTINATION_SELECTED, onDestinationSelected);
  on(EVENTS.OBSTACLE_DETECTED, onObstacleDetected);

  onFrame(onFrameTick);
}