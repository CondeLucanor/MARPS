/**
 * MAЯPS — landing flow after the landing plan is accepted (Stage 5).
 *
 *   LANDING_SIMULATION       simulated descent. At touchdown the ACTUAL landing point is generated
 *                            geographically (random bearing and distance on the sphere) inside the
 *                            error radius chosen by the user.
 *   POSITION_DETERMINATION   simulated spacecraft LiDAR: estimates the actual position with a small
 *                            random error (CONFIG.landing.lidar).
 *   LANDING_CONFIRMATION     report with position, battery and conditions.
 *                            "Begin Exploration" starts exploring; "Back to Map" discards this landing
 *                            and reopens landing site selection.
 *
 * SIMULATED: the descent profile, the LiDAR processing, the sensor status and the environment values.
 * The actual landing position is always generated randomly inside the error radius, never by a pixel offset.
 *
 * Data stored in the mission:
 *   mission.landing.actual              { latitude, longitude, elevation }
 *   mission.landing.errorDistanceMeters distance between planned and actual position
 *   mission.landing.lidar               { latitude, longitude, precisionMeters, estimationErrorMeters,
 *                                         acquiredAt, source, provenance }
 *   mission.landing.confirmed           true once exploration starts
 * The side panel (#map-side-panel) shows the progress and the report.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, MOVEMENT_MODE, appState, getCurrentMission, missionTimestamp } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onMissionTick, setPhase } from './mission-manager.js';
import { addMissionEvent } from './records.js';
import { showToast } from './ui.js';
import { navigateTo } from './navigation.js';
import { measureEnvironment } from './environment.js';
import { getElevation } from './terrain.js';
import { randomPointWithinRadius, fromLocalMeters, isInsideRegion } from './geodesy.js';
import { clamp, escapeHtml, formatCoordinate, formatDistance, randomNormal } from './utils.js';

const DESCENT_STAGES = [
  { until: 0.3, text: 'Atmospheric entry' },
  { until: 0.6, text: 'Parachute descent' },
  { until: 0.9, text: 'Powered descent' },
  { until: 1.01, text: 'Touchdown' }
];

const LIDAR_STAGES = [
  { until: 0.4, text: 'Emitting laser pulses' },
  { until: 0.8, text: 'Matching returns against the terrain model' },
  { until: 1.01, text: 'Computing the position estimate' }
];

let panel = null;
let panelOwned = false;   // true while this module's content is in the side panel
let flow = null;          // { missionId, kind, phase, elapsedSec, durationSec, stages, pendingActual }

/* ------------------------------------------------------------------ helpers */

function stageText(stages, progress) {
  for (const stage of stages) {
    if (progress < stage.until) return stage.text;
  }
  return stages[stages.length - 1].text;
}

/** Random actual landing point inside the error radius (generated on the sphere). */
function pickActualLanding(planned, radiusMeters) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const p = randomPointWithinRadius(planned.latitude, planned.longitude, radiusMeters);
    if (!isInsideRegion(p.latitude, p.longitude)) continue;
    const elevation = getElevation(p.latitude, p.longitude);
    if (elevation === null) continue;
    return {
      latitude: p.latitude,
      longitude: p.longitude,
      elevation,
      distanceMeters: p.distanceMeters,
      bearingDegrees: p.bearingDegrees
    };
  }
  // Very unlikely (a point at the border of the region): land exactly on the planned point.
  return {
    latitude: planned.latitude,
    longitude: planned.longitude,
    elevation: planned.elevation,
    distanceMeters: 0,
    bearingDegrees: 0
  };
}

function writePanel(html) {
  if (!panel) return;
  panel.innerHTML = html;
  panelOwned = true;
}

/* ------------------------------------------------------------------ phase handling */

function onPhaseChanged({ mission, to }) {
  if (to === LIFECYCLE.LANDING_SIMULATION) startDescent(mission);
  else if (to === LIFECYCLE.POSITION_DETERMINATION) startLidar(mission);
  else if (to === LIFECYCLE.LANDING_CONFIRMATION) showConfirmation(mission);
  else {
    // Another module (landing.js) draws its own content in the panel for the other phases.
    flow = null;
    panelOwned = false;
  }
}

function resetFlow() {
  flow = null;
  panelOwned = false;
}

function onMissionEnded() {
  flow = null;
  if (panel && panelOwned) panel.innerHTML = '';
  panelOwned = false;
}

/* ------------------------------------------------------------------ 1. descent */

function startDescent(mission) {
  const planned = mission.landing.planned;
  if (!planned) {
    console.error('[MAЯPS] The landing simulation started without a planned landing site.');
    return;
  }
  const radius = Number.isFinite(mission.landing.errorRadiusMeters)
    ? mission.landing.errorRadiusMeters
    : CONFIG.landing.errorRadius.defaultMeters;

  // The actual point is decided now, but only revealed at touchdown.
  const pending = pickActualLanding(planned, radius);

  mission.landing.actual = null;
  mission.landing.errorDistanceMeters = null;
  mission.landing.lidar = null;
  mission.landing.confirmed = false;

  flow = {
    missionId: mission.id,
    kind: 'descent',
    phase: LIFECYCLE.LANDING_SIMULATION,
    elapsedSec: 0,
    durationSec: Math.max(0.5, CONFIG.landing.descentDurationSeconds),
    stages: DESCENT_STAGES,
    pendingActual: pending
  };

  addMissionEvent(mission, {
    type: 'LANDING_DESCENT_STARTED',
    message: `Landing descent started toward ${formatCoordinate(planned.latitude, planned.longitude)}.`,
    latitude: planned.latitude,
    longitude: planned.longitude,
    data: { errorRadiusMeters: radius }
  });

  writePanel(`
    <h3>Landing simulation</h3>
    <div class="card">
      <p id="flow-stage-text" class="flow-stage"></p>
      <div class="progress"><div id="flow-progress-fill" class="progress-fill"></div></div>
      <table class="kv">
        <tr><th>Planned site</th><td class="mono">${escapeHtml(formatCoordinate(planned.latitude, planned.longitude))}</td></tr>
        <tr><th>Error radius</th><td>${escapeHtml(formatDistance(radius))}</td></tr>
      </table>
      <p class="hint">The descent profile is simulated. The actual landing point will be a random point inside the error radius.</p>
    </div>`);
  updateProgressUi(0);
}

function completeDescent(mission, finished) {
  const a = finished.pendingActual;
  mission.landing.actual = { latitude: a.latitude, longitude: a.longitude, elevation: a.elevation };
  mission.landing.errorDistanceMeters = a.distanceMeters;

  addMissionEvent(mission, {
    type: 'LANDING_TOUCHDOWN',
    severity: 'success',
    message: `Touchdown at ${formatCoordinate(a.latitude, a.longitude)}, ${formatDistance(a.distanceMeters)} from the planned site.`,
    latitude: a.latitude,
    longitude: a.longitude,
    data: { errorDistanceMeters: a.distanceMeters, bearingDegrees: a.bearingDegrees }
  });
  setPhase(LIFECYCLE.POSITION_DETERMINATION);
}

/* ------------------------------------------------------------------ 2. spacecraft LiDAR */

function startLidar(mission) {
  flow = {
    missionId: mission.id,
    kind: 'lidar',
    phase: LIFECYCLE.POSITION_DETERMINATION,
    elapsedSec: 0,
    durationSec: Math.max(0.5, CONFIG.landing.lidar.acquisitionDurationSeconds),
    stages: LIDAR_STAGES,
    pendingActual: null
  };

  writePanel(`
    <h3>Position determination</h3>
    <div class="card">
      <p id="flow-stage-text" class="flow-stage"></p>
      <div class="progress"><div id="flow-progress-fill" class="progress-fill"></div></div>
      <p><span class="badge">Touchdown complete</span></p>
      <p class="hint">The spacecraft LiDAR is determining the actual landing position. The LiDAR processing is simulated.</p>
    </div>`);
  updateProgressUi(0);
}

function completeLidar(mission) {
  const actual = mission.landing.actual;
  if (!actual) {
    console.error('[MAЯPS] LiDAR finished without an actual landing position.');
    return;
  }

  // Simulated estimate: the true position plus a small normally distributed error (east and north).
  const sigma = CONFIG.landing.lidar.positionSigmaMeters;
  const dx = randomNormal() * sigma;
  const dy = randomNormal() * sigma;
  const estimate = fromLocalMeters(dx, dy, actual.latitude, actual.longitude);
  const precision = CONFIG.landing.lidar.precisionMeters;

  mission.landing.lidar = {
    latitude: estimate.latitude,
    longitude: estimate.longitude,
    precisionMeters: precision,
    estimationErrorMeters: Math.hypot(dx, dy),
    acquiredAt: missionTimestamp(mission),
    source: 'spacecraft-lidar',
    provenance: CONFIG.provenance.simulated
  };

  emit(EVENTS.LIDAR_ACQUIRED, { mission, lidar: mission.landing.lidar });
  addMissionEvent(mission, {
    type: 'LIDAR_POSITION_ACQUIRED',
    severity: 'success',
    message: `LiDAR position acquired: ${formatCoordinate(estimate.latitude, estimate.longitude)} (precision ±${precision} m).`,
    latitude: estimate.latitude,
    longitude: estimate.longitude,
    data: { source: 'spacecraft-lidar', precisionMeters: precision }
  });

  setPhase(LIFECYCLE.LANDING_CONFIRMATION);
  if (appState.currentSection !== 'map') {
    showToast('Landing complete. Open the Map section to review the report and begin exploration.', 'success');
  }
}

/* ------------------------------------------------------------------ progress */

function onTick({ mission, simDt }) {
  if (!flow || flow.missionId !== mission.id || mission.phase !== flow.phase) return;

  flow.elapsedSec += simDt;
  const progress = clamp(flow.elapsedSec / flow.durationSec, 0, 1);
  updateProgressUi(progress);
  if (progress < 1) return;

  const finished = flow;
  flow = null;
  if (finished.kind === 'descent') completeDescent(mission, finished);
  else completeLidar(mission);
}

function updateProgressUi(progress) {
  if (!flow) return;
  const fill = document.getElementById('flow-progress-fill');
  const text = document.getElementById('flow-stage-text');
  const percent = Math.round(progress * 100);
  if (fill) fill.style.width = `${percent}%`;
  if (text) text.textContent = `${stageText(flow.stages, progress)} — ${percent}%`;
}

/* ------------------------------------------------------------------ 3. confirmation */

function sensorStatuses(mission) {
  const lidar = mission.landing.lidar;
  return [
    {
      name: 'Spacecraft LiDAR',
      status: lidar ? `Position acquired (precision ±${lidar.precisionMeters} m)` : 'No position fix',
      ok: Boolean(lidar)
    },
    { name: 'Vehicle LiDAR', status: 'Ready (simulated self-test)', ok: true },
    { name: 'Helmet stereo cameras', status: 'Ready (simulated self-test)', ok: true }
  ];
}

function showConfirmation(mission) {
  const landing = mission.landing;
  if (!landing.actual) {
    console.error('[MAЯPS] The landing confirmation opened without an actual landing position.');
    return;
  }

  const env = measureEnvironment(mission, { record: false });
  const planned = landing.planned;
  const actual = landing.actual;
  const lidar = landing.lidar;
  const battery = mission.vehicle.batteryPercent;

  const lidarRow = lidar
    ? `<tr><th>LiDAR estimate</th><td class="mono">${escapeHtml(formatCoordinate(lidar.latitude, lidar.longitude))}<br><span class="muted">±${lidar.precisionMeters} m · ${escapeHtml(formatDistance(lidar.estimationErrorMeters))} from the actual position</span></td></tr>`
    : '';

  const envRows = env
    ? `
      <tr><th>Temperature</th><td>${env.temperatureC.toFixed(1)} °C</td></tr>
      <tr><th>Wind speed</th><td>${env.windSpeedMps.toFixed(1)} m/s</td></tr>
      <tr><th>Radiation</th><td>${env.radiationMicroSvPerHour.toFixed(1)} µSv/h</td></tr>`
    : '<tr><th>Environment</th><td>Not available</td></tr>';

  const sensorItems = sensorStatuses(mission)
    .map((s) => `<li><span class="status-dot${s.ok ? '' : ' status-warn'}"></span><span><strong>${escapeHtml(s.name)}</strong><br><span class="muted">${escapeHtml(s.status)}</span></span></li>`)
    .join('');

  writePanel(`
    <h3>Landing confirmation</h3>
    <div class="card">
      <p><span class="badge">Landing complete</span></p>
      <table class="kv">
        <tr><th>Planned landing</th><td class="mono">${escapeHtml(formatCoordinate(planned.latitude, planned.longitude))}</td></tr>
        <tr><th>Actual landing</th><td class="mono">${escapeHtml(formatCoordinate(actual.latitude, actual.longitude))}</td></tr>
        <tr><th>Latitude</th><td class="mono">${actual.latitude.toFixed(5)}°</td></tr>
        <tr><th>Longitude</th><td class="mono">${actual.longitude.toFixed(5)}° E</td></tr>
        <tr><th>Error distance</th><td>${escapeHtml(formatDistance(landing.errorDistanceMeters))} <span class="muted">(allowed radius ${escapeHtml(formatDistance(landing.errorRadiusMeters ?? 0))})</span></td></tr>
        <tr><th>Elevation</th><td>${Math.round(actual.elevation)} m</td></tr>
        ${lidarRow}
      </table>
      <h3>Vehicle and conditions</h3>
      <table class="kv">
        <tr><th>Vehicle battery</th><td>${Math.round(battery)} %</td></tr>
        ${envRows}
      </table>
      <h3>Sensor status</h3>
      <ul class="status-list">${sensorItems}</ul>
      <p class="hint">Environment values and sensor status are simulated. Elevation is from the real MOLA grid.</p>
    </div>
    <div class="btn-row">
      <button id="flow-back" class="btn" type="button">Back to Map</button>
      <button id="flow-begin" class="btn btn-primary" type="button">Begin Exploration</button>
    </div>
    <p class="hint">Back to Map discards this landing and lets you choose a new landing site.</p>`);
}

function beginExploration() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.LANDING_CONFIRMATION || !mission.landing.actual) return;

  const actual = mission.landing.actual;
  const lidar = mission.landing.lidar;

  mission.landing.confirmed = true;

  // Astronaut and vehicle start together at the landing base. The simulation uses the true position.
  const a = mission.astronaut;
  a.latitude = actual.latitude;
  a.longitude = actual.longitude;
  a.altitude = actual.elevation;
  a.headingDegrees = 0;
  a.pitchDegrees = 0;
  a.precisionMeters = lidar ? lidar.precisionMeters : CONFIG.landing.lidar.precisionMeters;
  a.movementMode = MOVEMENT_MODE.WALKING;
  a.speedClass = 'normal';
  a.speedMetersPerSecond = 0;
  a.isMoving = false;

  mission.insideVehicle = false;
  mission.vehicle.latitude = actual.latitude;
  mission.vehicle.longitude = actual.longitude;
  mission.vehicle.headingDegrees = 0;

  addMissionEvent(mission, {
    type: 'LANDING_CONFIRMED',
    severity: 'success',
    message: `Landing confirmed at ${formatCoordinate(actual.latitude, actual.longitude)}.`,
    latitude: actual.latitude,
    longitude: actual.longitude,
    data: { errorDistanceMeters: mission.landing.errorDistanceMeters }
  });
  emit(EVENTS.LANDING_CONFIRMED, { mission });

  measureEnvironment(mission, { record: true });

  if (panel) panel.innerHTML = '';
  panelOwned = false;
  flow = null;

  setPhase(LIFECYCLE.EXPLORATION_ACTIVE);
  addMissionEvent(mission, {
    type: 'EXPLORATION_STARTED',
    severity: 'success',
    message: 'Exploration started.',
    latitude: actual.latitude,
    longitude: actual.longitude
  });
  emit(EVENTS.POSITION_UPDATED, { mission });
  emit(EVENTS.VEHICLE_POSITION_UPDATED, { mission });
  navigateTo('mission-view');
}

function backToMap() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.LANDING_CONFIRMATION) return;

  const landing = mission.landing;
  landing.planned = null;
  landing.analysis = null;
  landing.actual = null;
  landing.errorDistanceMeters = null;
  landing.lidar = null;
  landing.confirmed = false;
  // landing.errorRadiusMeters is kept so the radius field remembers the last value.

  addMissionEvent(mission, {
    type: 'LANDING_RESET',
    severity: 'warning',
    message: 'Returned to the map. The landing was discarded and landing site selection reopened.'
  });
  setPhase(LIFECYCLE.LANDING_SITE_SELECTION);
  navigateTo('map');
}

function onPanelClick(event) {
  if (event.target.closest('#flow-begin')) beginExploration();
  else if (event.target.closest('#flow-back')) backToMap();
}

/* ------------------------------------------------------------------ init */

export function initLandingFlow() {
  panel = document.getElementById('map-side-panel');

  on(EVENTS.MISSION_STARTED, resetFlow);
  on(EVENTS.MISSION_ENDED, onMissionEnded);
  on(EVENTS.MISSION_PHASE_CHANGED, onPhaseChanged);
  onMissionTick(onTick);

  if (panel) panel.addEventListener('click', onPanelClick);
}