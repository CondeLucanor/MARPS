/**
 * MAЯPS — landing site selection and terrain analysis (Stage 4).
 *
 * Flow:
 *   1. The map sends the clicked point (EVENTS.LANDING_SELECTED).
 *   2. analyzeLandingSite() computes elevation, slope, roughness and distances, and a 0-100 safety score.
 *   3. The result is stored in mission.landing and shown in #map-side-panel.
 *   4. "Proceed to landing" stores the error radius and moves to LANDING_SIMULATION (Stage 5).
 *
 * DATA NOTES (shown to the user in the panel):
 *   - Elevation: real MOLA grid.
 *   - Slope and roughness: derived from the real grid at its resolution (coarse, about 1.85 km per cell).
 *   - Craters and known obstacles: taken from data/obstacles.json (simulated dataset). If the file is
 *     missing, those two factors are not evaluated and the remaining weights are rescaled.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, getCurrentMission } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { escapeHtml, formatDistance, formatCoordinate, isFiniteNumber } from './utils.js';
import { distanceMeters, destinationPoint, isInsideRegion, normalizeLongitude } from './geodesy.js';
import * as terrain from './terrain.js';
import { setPhase } from './mission-manager.js';
import { addMissionEvent } from './records.js';
import { showToast, confirmDialog } from './ui.js';

// If the elevation function of your terrain.js has another name, add it to this list.
const ELEVATION_FUNCTION_NAMES = [
  'getElevation',
  'getElevationAt',
  'elevationAt',
  'sampleElevation',
  'getElevationMeters'
];

const CLASS_LABELS = { safe: 'Safe', moderate: 'Moderate', dangerous: 'Dangerous' };
const CLASS_STYLES = {
  safe: 'color:var(--success);border-color:var(--success);background:rgba(74,222,155,0.12)',
  moderate: 'color:var(--warn);border-color:var(--warn);background:rgba(242,184,75,0.14)',
  dangerous: 'color:var(--danger);border-color:var(--danger);background:rgba(255,107,107,0.14)'
};

let panel = null;
let panelOwned = false;     // true while this module's content is in the side panel
let obstacleDataset = null; // { craters: [], knownObstacles: [] } or null if unavailable

/* ------------------------------------------------------------------ terrain access */

function resolveElevationFunction() {
  for (const name of ELEVATION_FUNCTION_NAMES) {
    if (typeof terrain[name] === 'function') return terrain[name];
  }
  return null;
}

/** Elevation in metres, or null if there is no valid data at that point. */
function readElevation(lat, lon) {
  const fn = resolveElevationFunction();
  if (!fn) {
    throw new Error(
      'landing.js cannot find the elevation function in terrain.js. Add its name to ELEVATION_FUNCTION_NAMES in js/landing.js.'
    );
  }
  let value = fn(lat, lon);
  if (value && typeof value === 'object') value = value.elevation ?? value.elevationMeters ?? null;
  if (!isFiniteNumber(value) || value === CONFIG.terrain.noDataValue) return null;
  return value;
}

/** Slope (degrees) and roughness (metres) around a point, from the real grid. */
function computeSlopeAndRoughness(lat, lon, centerElevation) {
  const d = CONFIG.terrain.cellSizeMeters;
  const at = (bearing) => {
    const p = destinationPoint(lat, lon, bearing, d);
    return readElevation(p.latitude, p.longitude);
  };

  const north = at(0);
  const east = at(90);
  const south = at(180);
  const west = at(270);

  let slopeDegrees = null;
  if ([north, east, south, west].every(isFiniteNumber)) {
    const dzdx = (east - west) / (2 * d);
    const dzdy = (north - south) / (2 * d);
    slopeDegrees = (Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * 180) / Math.PI;
  }

  const samples = [centerElevation];
  for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const e = at(bearing);
    if (isFiniteNumber(e)) samples.push(e);
  }
  let roughnessMeters = null;
  if (samples.length >= 6) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    roughnessMeters = Math.sqrt(variance);
  }
  return { slopeDegrees, roughnessMeters };
}

/* ------------------------------------------------------------------ obstacle dataset */

async function loadObstacleDataset() {
  try {
    const response = await fetch(CONFIG.obstacles.file);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const list = Array.isArray(json) ? json : json.obstacles;
    if (!Array.isArray(list)) throw new Error('unexpected format');

    const valid = list.filter((o) => isFiniteNumber(o.latitude) && isFiniteNumber(o.longitude));
    obstacleDataset = {
      craters: valid.filter((o) => o.type === 'crater'),
      // Obstacles with detected === true are known from the start; the others are found during exploration.
      knownObstacles: valid.filter((o) => o.type !== 'crater' && o.detected === true)
    };
  } catch (err) {
    obstacleDataset = null;
    console.info(`[MAЯPS] ${CONFIG.obstacles.file} not available yet (${err.message}). Crater and obstacle factors are not evaluated.`);
  }
}

function nearestDistance(lat, lon, items) {
  let best = null;
  for (const item of items) {
    const d = distanceMeters(lat, lon, item.latitude, item.longitude);
    if (best === null || d < best) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ safety score */

/** 1 when value is at `good`, 0 when it is at `bad`, linear in between (works in both directions). */
function ramp(value, good, bad) {
  const t = (value - good) / (bad - good);
  return 1 - Math.min(1, Math.max(0, t));
}

function buildFactors(m) {
  const S = CONFIG.landing.safety;
  const W = S.weights;
  const factors = [];
  const missing = [];

  if (isFiniteNumber(m.slopeDegrees)) {
    factors.push({
      key: 'slope', label: 'Slope', valueText: `${m.slopeDegrees.toFixed(1)}°`,
      score: ramp(m.slopeDegrees, S.slopeGoodDegrees, S.slopeBadDegrees), weight: W.slope
    });
  } else missing.push('slope');

  if (isFiniteNumber(m.roughnessMeters)) {
    factors.push({
      key: 'roughness', label: 'Roughness', valueText: `${Math.round(m.roughnessMeters)} m`,
      score: ramp(m.roughnessMeters, S.roughnessGoodMeters, S.roughnessBadMeters), weight: W.roughness
    });
  } else missing.push('roughness');

  if (obstacleDataset) {
    const c = m.nearestCraterMeters;
    factors.push({
      key: 'crater', label: 'Crater proximity',
      valueText: c === null ? 'none in dataset' : formatDistance(c),
      score: c === null ? 1 : ramp(c, S.craterSafeDistanceMeters, S.craterDangerDistanceMeters),
      weight: W.craterProximity
    });
    const o = m.nearestObstacleMeters;
    factors.push({
      key: 'obstacle', label: 'Known obstacle proximity',
      valueText: o === null ? 'none in dataset' : formatDistance(o),
      score: o === null ? 1 : ramp(o, S.obstacleSafeDistanceMeters, S.obstacleDangerDistanceMeters),
      weight: W.obstacleProximity
    });
  } else {
    missing.push('crater proximity', 'known obstacle proximity');
  }

  factors.push({
    key: 'elevation', label: 'Elevation', valueText: `${Math.round(m.elevationMeters)} m`,
    score: ramp(m.elevationMeters, S.elevationGoodMeters, S.elevationBadMeters), weight: W.elevation
  });

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  for (const f of factors) {
    f.contributionPoints = (100 * f.weight * f.score) / totalWeight;
    f.maxPoints = (100 * f.weight) / totalWeight;
    f.lostPoints = f.maxPoints - f.contributionPoints;
  }
  const score = Math.round(factors.reduce((sum, f) => sum + f.contributionPoints, 0));
  return { factors, missing, score };
}

function classify(score) {
  const t = CONFIG.landing.safety.thresholds;
  if (score >= t.safe) return 'safe';
  if (score >= t.moderate) return 'moderate';
  return 'dangerous';
}

/**
 * Analyses a candidate landing site. Returns a plain data object (it is stored in mission.landing.analysis),
 * or null if the point cannot be analysed.
 */
export function analyzeLandingSite(latitude, longitude) {
  const lat = Number(latitude);
  const lon = normalizeLongitude(Number(longitude));

  if (!isInsideRegion(lat, lon)) {
    showToast('That point is outside the Acidalia Planitia study region.', 'warning');
    return null;
  }

  let elevation;
  let derived;
  try {
    elevation = readElevation(lat, lon);
    if (elevation === null) {
      showToast('There is no elevation data at that point. Choose another one.', 'warning');
      return null;
    }
    derived = computeSlopeAndRoughness(lat, lon, elevation);
  } catch (err) {
    console.error('[MAЯPS]', err);
    showToast('The terrain could not be read. Open the Console (F12) for details.', 'error');
    return null;
  }

  const measurements = {
    elevationMeters: elevation,
    slopeDegrees: derived.slopeDegrees,
    roughnessMeters: derived.roughnessMeters,
    nearestCraterMeters: obstacleDataset ? nearestDistance(lat, lon, obstacleDataset.craters) : null,
    nearestObstacleMeters: obstacleDataset ? nearestDistance(lat, lon, obstacleDataset.knownObstacles) : null
  };

  const { factors, missing, score } = buildFactors(measurements);
  const classification = classify(score);

  const explanation = factors
    .filter((f) => f.lostPoints >= 3)
    .sort((a, b) => b.lostPoints - a.lostPoints)
    .slice(0, 3)
    .map((f) => `${f.label} (${f.valueText}) lowers the score by ${Math.round(f.lostPoints)} points.`);

  return {
    latitude: lat,
    longitude: lon,
    ...measurements,
    score,
    classification,
    factors: factors.map((f) => ({
      key: f.key, label: f.label, valueText: f.valueText,
      subScore: Math.round(f.score * 100), weight: f.weight, lostPoints: Math.round(f.lostPoints * 10) / 10
    })),
    notEvaluated: missing,
    explanation,
    provenance: {
      elevation: CONFIG.provenance.realDem,
      slope: 'derived from the real MOLA grid (coarse resolution)',
      roughness: 'derived from the real MOLA grid (coarse resolution)',
      craters: obstacleDataset ? CONFIG.provenance.simulated : 'not available'
    }
  };
}

/* ------------------------------------------------------------------ selection handling */

function handleSelection(payload) {
  const p = payload && payload.payload ? payload.payload : payload;
  const lat = Number(p && p.latitude);
  const lon = Number(p && p.longitude);

  const mission = getCurrentMission();
  if (!mission) {
    showToast('Start a mission before selecting a landing site.', 'warning');
    return;
  }
  if (mission.phase !== LIFECYCLE.LANDING_SITE_SELECTION && mission.phase !== LIFECYCLE.LANDING_ANALYSIS) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error('[MAЯPS] LANDING_SELECTED received without valid coordinates:', payload);
    return;
  }

  const analysis = analyzeLandingSite(lat, lon);
  if (!analysis) return;

  mission.landing.planned = {
    latitude: analysis.latitude,
    longitude: analysis.longitude,
    elevation: analysis.elevationMeters
  };
  mission.landing.analysis = analysis;
  if (mission.landing.errorRadiusMeters === null) {
    mission.landing.errorRadiusMeters = CONFIG.landing.errorRadius.defaultMeters;
  }

  addMissionEvent(mission, {
    type: 'LANDING_SELECTED',
    severity: analysis.classification === 'dangerous' ? 'warning' : 'info',
    message: `Landing site selected at ${formatCoordinate(analysis.latitude, analysis.longitude)}. Safety ${analysis.score}/100 (${CLASS_LABELS[analysis.classification]}).`,
    latitude: analysis.latitude,
    longitude: analysis.longitude,
    data: { score: analysis.score, classification: analysis.classification }
  });

  if (mission.phase === LIFECYCLE.LANDING_SITE_SELECTION) setPhase(LIFECYCLE.LANDING_ANALYSIS);
  emit(EVENTS.LANDING_ANALYZED, { mission, analysis });
  refreshPanel();
}

function chooseAnotherSite() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.LANDING_ANALYSIS) return;

  mission.landing.planned = null;
  mission.landing.analysis = null;
  setPhase(LIFECYCLE.LANDING_SITE_SELECTION);
  refreshPanel();
}

async function proceedToLanding() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.LANDING_ANALYSIS || !mission.landing.analysis) return;

  const range = CONFIG.landing.errorRadius;
  const input = document.getElementById('landing-radius');
  const raw = input ? input.value.trim() : '';
  const radius = Number(raw);
  if (raw === '' || !Number.isFinite(radius) || radius < range.minMeters || radius > range.maxMeters) {
    showToast(`Enter a landing error radius between ${range.minMeters} and ${range.maxMeters} metres.`, 'error');
    return;
  }

  const analysis = mission.landing.analysis;
  if (analysis.classification === 'dangerous') {
    const ok = await confirmDialog({
      title: 'Dangerous landing site',
      message: `This site has a safety score of ${analysis.score}/100 (Dangerous). You can still land here. Do you want to proceed?`,
      confirmLabel: 'Proceed anyway',
      cancelLabel: 'Go back',
      danger: true
    });
    if (!ok) return;
    // The mission may have changed while the dialog was open.
    if (getCurrentMission() !== mission || mission.phase !== LIFECYCLE.LANDING_ANALYSIS) return;
  }

  mission.landing.errorRadiusMeters = radius;
  addMissionEvent(mission, {
    type: 'LANDING_PLAN_ACCEPTED',
    message: `Landing plan accepted with an error radius of ${radius} m.`,
    latitude: analysis.latitude,
    longitude: analysis.longitude,
    data: { errorRadiusMeters: radius }
  });
  setPhase(LIFECYCLE.LANDING_SIMULATION);
  showToast('Landing plan saved. Descent starting.', 'success');
}

/* ------------------------------------------------------------------ side panel */

function refreshPanel() {
  if (!panel) return;
  const mission = getCurrentMission();
  const inLandingPhase =
    mission && (mission.phase === LIFECYCLE.LANDING_SITE_SELECTION || mission.phase === LIFECYCLE.LANDING_ANALYSIS);

  if (!inLandingPhase) {
    if (panelOwned) {
      panel.innerHTML = '';
      panelOwned = false;
    }
    return;
  }

  panelOwned = true;
  const analysis = mission.landing.analysis;
  panel.innerHTML = analysis ? analysisHtml(analysis, mission) : promptHtml();
}

function promptHtml() {
  return `
    <h3>Landing site selection</h3>
    <div class="card">
      <p>Click a point on the map to analyse it as a landing site.</p>
      <p class="hint">The analysis uses the real MOLA elevation grid. Zoom in for a more precise selection.</p>
    </div>`;
}

function analysisHtml(a, mission) {
  const radius = mission.landing.errorRadiusMeters ?? CONFIG.landing.errorRadius.defaultMeters;
  const range = CONFIG.landing.errorRadius;

  const factorRows = a.factors.map((f) => `
    <tr>
      <th>${escapeHtml(f.label)}</th>
      <td>${escapeHtml(f.valueText)} <span class="muted">· ${f.subScore}/100 · weight ${f.weight}</span></td>
    </tr>`).join('');

  const explanation = a.explanation.length
    ? `<ul>${a.explanation.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    : '<p>No factor lowers the score significantly.</p>';

  const notEvaluated = a.notEvaluated.length
    ? `<p class="hint">Not evaluated (no data yet): ${escapeHtml(a.notEvaluated.join(', '))}. The remaining weights were rescaled.</p>`
    : '';

  const warning = a.classification === 'dangerous'
    ? `<p style="color:var(--danger)"><strong>Warning:</strong> this is a dangerous landing area. You can still proceed.</p>`
    : '';

  return `
    <h3>Landing analysis</h3>
    <div class="card">
      <p><span class="badge" style="${CLASS_STYLES[a.classification]}">${CLASS_LABELS[a.classification]} · ${a.score}/100</span></p>
      ${warning}
      <table class="kv">
        <tr><th>Coordinates</th><td class="mono">${escapeHtml(formatCoordinate(a.latitude, a.longitude))}</td></tr>
        <tr><th>Elevation</th><td>${Math.round(a.elevationMeters)} m</td></tr>
        <tr><th>Slope</th><td>${a.slopeDegrees === null ? '—' : a.slopeDegrees.toFixed(1) + '°'}</td></tr>
        <tr><th>Roughness</th><td>${a.roughnessMeters === null ? '—' : Math.round(a.roughnessMeters) + ' m'}</td></tr>
        <tr><th>Nearest crater</th><td>${nearestText(a.nearestCraterMeters, a)}</td></tr>
        <tr><th>Nearest known obstacle</th><td>${nearestText(a.nearestObstacleMeters, a)}</td></tr>
      </table>
      <h3>Main factors</h3>
      ${explanation}
      <table class="kv">${factorRows}</table>
      ${notEvaluated}
      <p class="hint">Elevation: real MOLA data. Slope and roughness: derived from that grid at about ${Math.round(CONFIG.terrain.cellSizeMeters)} m per cell. Craters and obstacles: simulated dataset.</p>
    </div>
    <div class="card">
      <label for="landing-radius">Landing error radius (metres, ${range.minMeters}–${range.maxMeters})</label>
      <input id="landing-radius" type="number" min="${range.minMeters}" max="${range.maxMeters}" step="1" value="${radius}">
      <p class="hint">The actual landing point is generated randomly within this radius of the selected site.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="landing-back" class="btn" type="button">Choose another site</button>
        <button id="landing-proceed" class="btn btn-primary" type="button">Proceed to landing</button>
      </div>
    </div>`;
}

function nearestText(distance, analysis) {
  if (!analysis.provenance || analysis.provenance.craters === 'not available') return 'no data';
  return distance === null ? 'none in dataset' : escapeHtml(formatDistance(distance));
}

/* ------------------------------------------------------------------ init */

export function initLanding() {
  panel = document.getElementById('map-side-panel');
  loadObstacleDataset();

  on(EVENTS.LANDING_SELECTED, handleSelection);
  on(EVENTS.MISSION_STARTED, refreshPanel);
  on(EVENTS.MISSION_PHASE_CHANGED, refreshPanel);
  on(EVENTS.MISSION_ENDED, refreshPanel);

  if (panel) {
    // Event delegation: keeps working after the panel content is redrawn.
    panel.addEventListener('click', (event) => {
      if (event.target.closest('#landing-back')) chooseAnotherSite();
      else if (event.target.closest('#landing-proceed')) proceedToLanding();
    });
  }
  refreshPanel();
}