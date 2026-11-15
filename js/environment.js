/**
 * MAЯPS — environmental simulation: temperature, wind speed and radiation.
 *
 * ALL VALUES ARE SIMULATED (provenance: "simulated"). They are built from:
 *   1. CONFIG.environment.anchors: reference values at several places of the region. Between anchors
 *      the values are interpolated continuously (inverse-distance weighting), so they never jump
 *      from one zone to another.
 *   2. A day/night cycle that depends on the simulated time and the longitude.
 *   3. A slow, smooth variation (noise) that changes gradually with time.
 *
 * Measurements are recorded every CONFIG.environment.updateIntervalSeconds of SIMULATED time while the
 * mission is in exploration. They are stored in mission.records.environmentMeasurements (the Mission
 * Log shows them in their own section) and the latest one in mission.environment.current.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, missionTimestamp } from './state.js';
import { emit, EVENTS } from './events.js';
import { onMissionTick } from './mission-manager.js';
import { distanceMeters } from './geodesy.js';
import { clamp, lerp, isFiniteNumber } from './utils.js';

const ENV = CONFIG.environment;
const NOISE_PERIOD_SECONDS = 600;   // how slowly the smooth variation changes

const FALLBACK_VALUES = { temperatureC: -65, windSpeedMps: 8, radiationMicroSvPerHour: 28 };

/* ------------------------------------------------------------------ smooth noise (deterministic) */

function hash01(i, seed) {
  let h = Math.imul(i | 0, 0x45d9f3b) ^ Math.imul((seed | 0) + 0x9e3779b9, 0x119de1f3);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D noise in [-1, 1]. It changes gradually with t (no sudden jumps). */
function smoothNoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return lerp(hash01(i, seed), hash01(i + 1, seed), s) * 2 - 1;
}

/* ------------------------------------------------------------------ interpolation between zones */

function interpolateAnchors(lat, lon) {
  const anchors = ENV.anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) return { ...FALLBACK_VALUES };

  let sumW = 0;
  let temperature = 0;
  let wind = 0;
  let radiation = 0;

  for (const a of anchors) {
    const d = distanceMeters(lat, lon, a.latitude, a.longitude);
    if (d < 1) {
      return {
        temperatureC: a.temperatureC,
        windSpeedMps: a.windSpeedMps,
        radiationMicroSvPerHour: a.radiationMicroSvPerHour
      };
    }
    const w = 1 / Math.pow(d, ENV.interpolationPower);
    sumW += w;
    temperature += a.temperatureC * w;
    wind += a.windSpeedMps * w;
    radiation += a.radiationMicroSvPerHour * w;
  }
  return {
    temperatureC: temperature / sumW,
    windSpeedMps: wind / sumW,
    radiationMicroSvPerHour: radiation / sumW
  };
}

/**
 * Simulated environment at a point and a moment.
 * elapsedSeconds = simulated seconds since the start of the mission.
 */
export function sampleEnvironment(lat, lon, elapsedSeconds) {
  const base = interpolateAnchors(lat, lon);
  const d = ENV.diurnal;
  const n = ENV.noise;

  // Fraction of the Martian day at this longitude (0 = local midnight).
  const dayFraction = (((elapsedSeconds / d.periodSeconds + lon / 360) % 1) + 1) % 1;
  const tn = elapsedSeconds / NOISE_PERIOD_SECONDS;

  const temperatureC =
    base.temperatureC +
    d.temperatureAmplitudeC * Math.cos(2 * Math.PI * (dayFraction - 0.58)) +
    n.temperatureC * smoothNoise(tn, n.seed + 11);

  const windSpeedMps = Math.max(
    0,
    base.windSpeedMps +
      d.windAmplitudeMps * Math.cos(2 * Math.PI * (dayFraction - 0.65)) +
      n.windSpeedMps * smoothNoise(tn, n.seed + 23)
  );

  const radiationMicroSvPerHour = Math.max(
    0,
    base.radiationMicroSvPerHour + n.radiationMicroSvPerHour * smoothNoise(tn, n.seed + 37)
  );

  return { temperatureC, windSpeedMps, radiationMicroSvPerHour };
}

/* ------------------------------------------------------------------ measurements */

function currentPosition(mission) {
  const a = mission.astronaut;
  if (isFiniteNumber(a.latitude) && isFiniteNumber(a.longitude)) return a;
  if (mission.landing.actual) return mission.landing.actual;
  if (mission.landing.planned) return mission.landing.planned;
  return null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Measures the environment at the astronaut (or landing) position and stores it in
 * mission.environment.current. If `record` is true it is also added to the mission records.
 * Returns the measurement, or null if the mission has no position yet.
 */
export function measureEnvironment(mission, { record = false } = {}) {
  const position = currentPosition(mission);
  if (!position) return null;

  const values = sampleEnvironment(position.latitude, position.longitude, mission.clock.elapsedMs / 1000);
  const measurement = {
    timestamp: missionTimestamp(mission),
    latitude: position.latitude,
    longitude: position.longitude,
    temperatureC: round2(values.temperatureC),
    windSpeedMps: round2(values.windSpeedMps),
    radiationMicroSvPerHour: round2(values.radiationMicroSvPerHour),
    provenance: CONFIG.provenance.simulated
  };

  mission.environment.current = measurement;
  if (record) {
    mission.records.environmentMeasurements.push({ ...measurement });
    mission.environment.lastRecordElapsedMs = mission.clock.elapsedMs;
  }
  emit(EVENTS.ENVIRONMENT_UPDATED, { mission, measurement, recorded: Boolean(record) });
  return measurement;
}

function onTick({ mission }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const last = mission.environment.lastRecordElapsedMs;
  const intervalMs = clamp(ENV.updateIntervalSeconds, 1, 3600) * 1000;
  if (typeof last === 'number' && mission.clock.elapsedMs - last < intervalMs) return;
  measureEnvironment(mission, { record: true });
}

export function initEnvironment() {
  onMissionTick(onTick);
}