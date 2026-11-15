/**
 * MAЯPS — bridge between the application and the independent Leaflet map (iframe + postMessage).
 * The full protocol is documented in docs/map-protocol.md.
 *
 * The map never keeps mission data of its own: it draws what this module sends and reports user
 * actions (landing click, destination click, point inspection).
 * The iframe is created the first time the Map section is shown, so Leaflet always starts with a real size.
 * Data is sent only while the Map section is visible, and only when it changed (throttled).
 */
import { CONFIG } from './config.js';
import { appState, LIFECYCLE, getCurrentMission } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onFrame } from './simulation.js';
import { isFiniteNumber, formatCoordinate } from './utils.js';
import { isValidCoordinate, isInsideRegion } from './geodesy.js';
import { isTerrainLoaded, getElevation, getTerrainAt } from './terrain.js';
import { renderTerrainLayers } from './terrain-layers.js';
import { showToast } from './ui.js';

// STAGE 2 TEMPORARY: toasts that confirm messages coming from the map. Set to false in Stage 4.
const SHOW_STAGE2_TEST_TOASTS = false;

const FLUSH_INTERVAL_MS = 100;
const MAX_INCOMING_PER_SECOND = 40;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const LANDING_SELECTION_PHASES = new Set([
  LIFECYCLE.LANDING_SITE_SELECTION,
  LIFECYCLE.LANDING_ANALYSIS
]);

let frame = null;
let banner = null;
let ready = false;
let readyTimer = null;
let lastFlushAt = 0;
let lastPositionCheckAt = 0;
let lastAstronautSig = null;
let lastVehicleSig = null;
let rateWindowStart = 0;
let rateWindowCount = 0;
const dirty = new Set();

/* ------------------------------------------------------------------ helpers */

function targetOrigin() {
  return CONFIG.map.allowedOrigin || window.location.origin;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function round6(value) {
  return Number(value.toFixed(6));
}

function toPoint(obj) {
  if (obj && isValidCoordinate(obj.latitude, obj.longitude)) {
    return { latitude: round6(obj.latitude), longitude: round6(obj.longitude) };
  }
  return null;
}

function isMapVisible() {
  return appState.currentSection === 'map';
}

function absoluteUrl(path) {
  if (!path) return null;
  try {
    return new URL(path, document.baseURI).href;
  } catch (err) {
    return null;
  }
}

export function isMapReady() {
  return ready;
}

/** Sends a message to the map. Returns false if the map is not ready. */
export function sendToMap(type, payload) {
  if (!ready || !frame || !frame.contentWindow) return false;
  try {
    frame.contentWindow.postMessage({ type, payload }, targetOrigin());
    return true;
  } catch (err) {
    console.error(`[MAЯPS] Could not send ${type} to the map:`, err);
    return false;
  }
}

/* ------------------------------------------------------------------ iframe */

function ensureFrame() {
  if (frame) return;
  const host = document.getElementById('map-host');
  if (!host) return;

  host.innerHTML = '';

  frame = document.createElement('iframe');
  frame.title = 'MAЯPS interactive map';
  frame.src = CONFIG.map.url;
  host.appendChild(frame);

  banner = document.createElement('div');
  banner.className = 'map-status';
  banner.hidden = true;
  host.appendChild(banner);

  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (ready) return;
    banner.textContent =
      `The map did not respond. Check that ${CONFIG.map.url} exists and that it sends MAP_READY (see docs/map-protocol.md).`;
    banner.hidden = false;
    console.warn(`[MAЯPS] The map at ${CONFIG.map.url} did not send MAP_READY.`);
  }, CONFIG.map.readyTimeoutMs);
}

/* ------------------------------------------------------------------ payload builders */

function buildMode(mission) {
  let mode = 'browse';
  if (mission) {
    if (LANDING_SELECTION_PHASES.has(mission.phase)) mode = 'landing-selection';
    else if (mission.phase === LIFECYCLE.EXPLORATION_ACTIVE) mode = 'exploration';
  }
  return { mode, missionActive: Boolean(mission), missionPhase: mission ? mission.phase : null };
}

function buildAstronaut(mission) {
  if (!mission || !isFiniteNumber(mission.astronaut.latitude) || !isFiniteNumber(mission.astronaut.longitude)) {
    return { latitude: null, longitude: null };
  }
  const a = mission.astronaut;
  return {
    latitude: round6(a.latitude),
    longitude: round6(a.longitude),
    headingDegrees: isFiniteNumber(a.headingDegrees) ? Math.round(a.headingDegrees * 10) / 10 : null,
    precisionMeters: isFiniteNumber(a.precisionMeters) ? a.precisionMeters : null,
    insideVehicle: Boolean(mission.insideVehicle)
  };
}

function buildVehicle(mission) {
  if (!mission || !isFiniteNumber(mission.vehicle.latitude) || !isFiniteNumber(mission.vehicle.longitude)) {
    return { latitude: null, longitude: null };
  }
  const v = mission.vehicle;
  return {
    latitude: round6(v.latitude),
    longitude: round6(v.longitude),
    headingDegrees: isFiniteNumber(v.headingDegrees) ? Math.round(v.headingDegrees * 10) / 10 : null
  };
}

function pointsOf(route) {
  if (!route || !Array.isArray(route.points)) return [];
  const out = [];
  for (const p of route.points) {
    const point = toPoint(p);
    if (point) out.push(point);
  }
  return out;
}

function buildRoute(mission) {
  const routes = mission && mission.navigation && mission.navigation.routes;
  if (!routes) return { recommended: [], alternatives: [], selectedIndex: 0 };
  return {
    recommended: pointsOf(routes.recommended),
    alternatives: (routes.alternatives || []).map(pointsOf),
    selectedIndex: mission.navigation.selectedRouteIndex || 0
  };
}

function buildObstacles(mission) {
  if (!mission) return [];
  return mission.obstacles
    .filter((o) => o.known === true || o.detected === true)
    .filter((o) => isValidCoordinate(o.latitude, o.longitude))
    .map((o) => ({
      id: o.id,
      type: o.type,
      latitude: round6(o.latitude),
      longitude: round6(o.longitude),
      known: o.known === true,
      detected: o.detected === true,
      radiusMeters: (CONFIG.obstacleTypes[o.type] && CONFIG.obstacleTypes[o.type].avoidRadiusMeters) || null
    }));
}

function buildScientificPoints(mission) {
  if (!mission) return [];
  return mission.scientificPoints
    .filter((p) => isValidCoordinate(p.latitude, p.longitude))
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      latitude: round6(p.latitude),
      longitude: round6(p.longitude),
      description: p.description,
      image: absoluteUrl(p.image),
      visited: p.visited === true
    }));
}

function buildLanding(mission) {
  const l = mission && mission.landing;
  return {
    planned: l ? toPoint(l.planned) : null,
    actual: l ? toPoint(l.actual) : null,
    lidar: l ? toPoint(l.lidar) : null,
    errorRadiusMeters: l && isFiniteNumber(l.errorRadiusMeters) ? l.errorRadiusMeters : null,
    confirmed: Boolean(l && l.confirmed)
  };
}

/* ------------------------------------------------------------------ sending (throttled) */

function markDirty(...kinds) {
  for (const kind of kinds) dirty.add(kind);
}

function markAllMissionData() {
  markDirty('mode', 'landing', 'obstacles', 'scientific', 'route');
  lastAstronautSig = null;
  lastVehicleSig = null;
}

function flushDirty() {
  const mission = getCurrentMission();
  const kinds = [...dirty];
  dirty.clear();

  for (const kind of kinds) {
    switch (kind) {
      case 'layers': {
        const layers = isTerrainLoaded() ? renderTerrainLayers() : null;
        if (layers) sendToMap('UPDATE_TERRAIN_LAYERS', layers);
        break;
      }
      case 'mode':
        sendToMap('SET_MAP_MODE', buildMode(mission));
        break;
      case 'landing':
        sendToMap('UPDATE_LANDING', buildLanding(mission));
        break;
      case 'obstacles':
        sendToMap('UPDATE_OBSTACLES', buildObstacles(mission));
        break;
      case 'scientific':
        sendToMap('UPDATE_SCIENTIFIC_POINTS', buildScientificPoints(mission));
        break;
      case 'route':
        sendToMap('UPDATE_ROUTE', buildRoute(mission));
        break;
      default:
        break;
    }
  }
}

function sendPositionsIfChanged() {
  const mission = getCurrentMission();

  const astronaut = buildAstronaut(mission);
  const astronautSig = JSON.stringify(astronaut);
  if (astronautSig !== lastAstronautSig) {
    if (sendToMap('UPDATE_ASTRONAUT_POSITION', astronaut)) lastAstronautSig = astronautSig;
  }

  const vehicle = buildVehicle(mission);
  const vehicleSig = JSON.stringify(vehicle);
  if (vehicleSig !== lastVehicleSig) {
    if (sendToMap('UPDATE_VEHICLE_POSITION', vehicle)) lastVehicleSig = vehicleSig;
  }
}

function onFrameTick() {
  if (!ready || !isMapVisible()) return;
  const now = performance.now();

  if (dirty.size > 0 && now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    lastFlushAt = now;
    flushDirty();
  }
  if (now - lastPositionCheckAt >= CONFIG.map.positionUpdateIntervalMs) {
    lastPositionCheckAt = now;
    sendPositionsIfChanged();
  }
}

/* ------------------------------------------------------------------ incoming messages */

function isRateLimited() {
  const now = performance.now();
  if (now - rateWindowStart > 1000) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > MAX_INCOMING_PER_SECOND;
}

function onWindowMessage(event) {
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.origin !== targetOrigin()) {
    console.warn(`[MAЯPS] Message ignored: unexpected origin ${event.origin}.`);
    return;
  }
  if (isRateLimited()) return;

  const message = event.data;
  if (!isPlainObject(message) || typeof message.type !== 'string') return;
  handleMapMessage(message.type, message.payload);
}

function handleMapMessage(type, payload) {
  switch (type) {
    case 'MAP_READY':
      handleMapReady();
      break;
    case 'LANDING_LOCATION_SELECTED':
      handleLandingSelected(payload);
      break;
    case 'DESTINATION_SELECTED':
      handleDestinationSelected(payload);
      break;
    case 'INSPECT_POINT':
      handleInspectPoint(payload);
      break;
    default:
      console.warn(`[MAЯPS] Unknown message from the map ignored: ${type}`);
  }
}

function handleMapReady() {
  ready = true;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  if (banner) banner.hidden = true;

  sendToMap('INIT_MAP', {
    protocolVersion: CONFIG.map.protocolVersion,
    region: { ...CONFIG.region },
    coordinateSystem: CONFIG.coordinateSystem.description
  });
  sendToMap('MAP_SHOWN', null);

  markDirty('layers');
  markAllMissionData();
}

function handleLandingSelected(payload) {
  if (!isPlainObject(payload) || !isValidCoordinate(payload.latitude, payload.longitude)) {
    console.warn('[MAЯPS] LANDING_LOCATION_SELECTED ignored: invalid coordinates (latitude -90..90, longitude 0..360).');
    return;
  }
  const mission = getCurrentMission();
  if (!mission || !LANDING_SELECTION_PHASES.has(mission.phase)) {
    console.warn('[MAЯPS] LANDING_LOCATION_SELECTED ignored: the mission is not in the landing selection phase.');
    return;
  }
  if (!isInsideRegion(payload.latitude, payload.longitude)) {
    showToast('That point is outside the Acidalia Planitia study region.', 'warning');
    return;
  }

  // The elevation reported by the map is not trusted: the application's DEM is the single source.
  const elevation = isTerrainLoaded() ? getElevation(payload.latitude, payload.longitude) : null;

  emit(EVENTS.LANDING_SELECTED, {
    latitude: payload.latitude,
    longitude: payload.longitude,
    elevation,
    mapElevation: isFiniteNumber(payload.elevation) ? payload.elevation : null,
    source: 'map'
  });

  if (SHOW_STAGE2_TEST_TOASTS) {
    const elevText = elevation === null ? 'elevation not available' : `elevation ${Math.round(elevation)} m`;
    showToast(`[Stage 2 test] Landing point received: ${formatCoordinate(payload.latitude, payload.longitude)}, ${elevText}.`);
  }
}

function handleDestinationSelected(payload) {
  if (!isPlainObject(payload) || typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) {
    console.warn('[MAЯPS] DESTINATION_SELECTED ignored: invalid id.');
    return;
  }
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) {
    console.warn('[MAЯPS] DESTINATION_SELECTED ignored: exploration is not active.');
    return;
  }

  emit(EVENTS.DESTINATION_SELECTED, { id: payload.id, source: 'map' });

  if (SHOW_STAGE2_TEST_TOASTS) {
    showToast(`[Stage 2 test] Destination received: ${payload.id}.`);
  }
}

function handleInspectPoint(payload) {
  if (!isPlainObject(payload) || !isValidCoordinate(payload.latitude, payload.longitude)) {
    console.warn('[MAЯPS] INSPECT_POINT ignored: invalid coordinates.');
    return;
  }
  let requestId = null;
  if (typeof payload.requestId === 'number' && Number.isFinite(payload.requestId)) requestId = payload.requestId;
  else if (typeof payload.requestId === 'string' && payload.requestId.length <= 64) requestId = payload.requestId;

  const terrain = isTerrainLoaded() ? getTerrainAt(payload.latitude, payload.longitude) : null;
  sendToMap('INSPECT_RESULT', {
    requestId,
    latitude: payload.latitude,
    longitude: payload.longitude,
    elevation: terrain && terrain.insideDem ? terrain.elevation : null,
    slopeDegrees: terrain && terrain.insideDem ? terrain.demSlopeDegrees : null,
    provenance: terrain ? terrain.provenance.elevation : null
  });
}

/**
 * FOR TESTING FROM THE CONSOLE ONLY: processes a message as if the map had sent it, skipping the
 * origin check. Example: MARPS.mapBridge.debugInject('DESTINATION_SELECTED', { id: 'SCI_001' })
 */
export function debugInject(type, payload) {
  handleMapMessage(type, payload);
}

/* ------------------------------------------------------------------ init */

function onMapShown() {
  ensureFrame();
  if (!ready) return;
  sendToMap('MAP_SHOWN', null);
  markAllMissionData();
}

export function initMapBridge() {
  window.addEventListener('message', onWindowMessage);

  on(EVENTS.MISSION_STARTED, markAllMissionData);
  on(EVENTS.MISSION_ENDED, markAllMissionData);
  on(EVENTS.MISSION_PHASE_CHANGED, () => markDirty('mode'));
  on(EVENTS.MISSION_PAUSED, () => markDirty('mode'));
  on(EVENTS.MISSION_RESUMED, () => markDirty('mode', 'landing'));

  on(EVENTS.LANDING_SELECTED, () => markDirty('landing'));
  on(EVENTS.LANDING_ANALYZED, () => markDirty('landing'));
  on(EVENTS.LANDING_CONFIRMED, () => markDirty('landing'));
  on(EVENTS.LIDAR_ACQUIRED, () => markDirty('landing'));

  on(EVENTS.ROUTE_UPDATED, () => markDirty('route'));
  on(EVENTS.ROUTE_RECALCULATED, () => markDirty('route'));
  on(EVENTS.OBSTACLE_DETECTED, () => markDirty('obstacles'));
  on(EVENTS.SCIENTIFIC_POINT_VISITED, () => markDirty('scientific'));
  on(EVENTS.TERRAIN_LOADED, () => markDirty('layers'));

  on(EVENTS.SECTION_CHANGED, (payload) => {
    if (payload.section === 'map') onMapShown();
  });

  onFrame(onFrameTick);

  if (appState.currentSection === 'map') onMapShown();
}