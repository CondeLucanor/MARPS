/**
 * MAЯPS — sensor simulation (Stage 8). Sensors run in the background; there is no scan screen.
 * Only important outcomes are shown (obstacle detections, position-fix alerts) and everything is logged.
 *
 * ALL SENSOR PROCESSING IS SIMULATED.
 *
 * Vehicle LiDAR (CONFIG.sensors.vehicleLidar)
 *   Active while the astronaut is inside the vehicle. Every scanIntervalSeconds (simulated time) it looks
 *   for hidden obstacles within rangeMeters of the vehicle (distance to the obstacle EDGE).
 *
 * Helmet stereo cameras (CONFIG.sensors.helmetStereo)
 *   - Estimate the astronaut's position every scanIntervalSeconds. The estimate is the true position plus
 *     a random error that follows the localization precision. The result is stored in
 *     mission.sensors.helmetStereo.estimated, and the precision in mission.astronaut.precisionMeters.
 *   - The precision degrades while walking: basePrecisionMeters + driftMetersPerKm per km walked since the
 *     last position fix, limited to maxPrecisionMeters. A fix is recovered inside the vehicle and within
 *     fixResetRadiusMeters of the landing base or of the vehicle.
 *   - While the astronaut is on foot they also detect hidden obstacles within
 *     CONFIG.obstacles.detectionRadiusMeters.astronaut.
 *
 * State: mission.sensors (created at the first exploration tick).
 * Detected obstacles are announced by obstacles.js (OBSTACLE_DETECTED), which triggers route recalculation.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, missionTimestamp } from './state.js';
import { onMissionTick } from './mission-manager.js';
import { addMissionEvent } from './records.js';
import { distanceMeters, fromLocalMeters } from './geodesy.js';
import { detectObstaclesAround } from './obstacles.js';
import { showToast } from './ui.js';
import { clamp, formatDistance, isFiniteNumber, randomNormal } from './utils.js';

const DEGRADED_FACTOR = 2;       // precision worse than 2 x the base value = "degraded"
const MAX_STEP_METERS = 200;     // larger jumps between ticks (console teleports) are not counted as walking

function ensureSensors(mission) {
  if (!mission.sensors) {
    mission.sensors = {
      vehicleLidar: { status: 'standby', scanCount: 0, lastScanElapsedMs: null, detections: 0 },
      helmetStereo: {
        status: 'operating',
        scanCount: 0,
        lastScanElapsedMs: null,
        detections: 0,
        distanceSinceFixMeters: 0,
        lastLatitude: null,
        lastLongitude: null,
        degraded: false,
        estimated: null
      }
    };
  }
  return mission.sensors;
}

/** True when the sensor is due for a scan (and registers it). */
function due(sensor, mission, intervalSeconds) {
  const last = sensor.lastScanElapsedMs;
  if (last !== null && mission.clock.elapsedMs - last < Math.max(0.1, intervalSeconds) * 1000) return false;
  sensor.lastScanElapsedMs = mission.clock.elapsedMs;
  sensor.scanCount += 1;
  return true;
}

function currentPrecision(h) {
  const cfg = CONFIG.sensors.helmetStereo;
  const value = cfg.basePrecisionMeters + cfg.driftMetersPerKm * (h.distanceSinceFixMeters / 1000);
  return clamp(value, cfg.basePrecisionMeters, cfg.maxPrecisionMeters);
}

function hasReferenceFix(mission, inVehicle) {
  if (inVehicle) return true;
  const a = mission.astronaut;
  const radius = CONFIG.sensors.helmetStereo.fixResetRadiusMeters;
  const base = mission.landing && mission.landing.actual;
  if (base && distanceMeters(a.latitude, a.longitude, base.latitude, base.longitude) <= radius) return true;
  const v = mission.vehicle;
  return isFiniteNumber(v.latitude) && isFiniteNumber(v.longitude) &&
    distanceMeters(a.latitude, a.longitude, v.latitude, v.longitude) <= radius;
}

function onTick({ mission }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const a = mission.astronaut;
  if (!isFiniteNumber(a.latitude) || !isFiniteNumber(a.longitude)) return;

  const sensors = ensureSensors(mission);
  const h = sensors.helmetStereo;
  const lidar = sensors.vehicleLidar;
  const hs = CONFIG.sensors.helmetStereo;
  const inVehicle = Boolean(mission.insideVehicle);

  // Distance walked since the last position fix.
  if (h.lastLatitude !== null) {
    const step = distanceMeters(h.lastLatitude, h.lastLongitude, a.latitude, a.longitude);
    if (!inVehicle && step <= MAX_STEP_METERS) h.distanceSinceFixMeters += step;
  }
  h.lastLatitude = a.latitude;
  h.lastLongitude = a.longitude;

  if (hasReferenceFix(mission, inVehicle)) {
    h.distanceSinceFixMeters = 0;
    if (h.degraded) {
      h.degraded = false;
      addMissionEvent(mission, {
        type: 'POSITION_FIX_RECOVERED',
        severity: 'success',
        message: 'Localization precision recovered (position fix acquired).',
        latitude: a.latitude,
        longitude: a.longitude
      });
      showToast('Localization precision recovered.', 'success');
    }
  }

  const precision = currentPrecision(h);
  if (!h.degraded && precision >= hs.basePrecisionMeters * DEGRADED_FACTOR) {
    h.degraded = true;
    addMissionEvent(mission, {
      type: 'POSITION_PRECISION_DEGRADED',
      severity: 'warning',
      message: `Localization precision degraded to ±${precision.toFixed(1)} m. Return near the base or the vehicle to recover it.`,
      latitude: a.latitude,
      longitude: a.longitude,
      data: { precisionMeters: precision }
    });
    showToast(`Localization precision degraded: ±${precision.toFixed(1)} m`, 'warning');
  }

  // Helmet stereo cameras: position estimate (+ obstacle detection on foot).
  if (due(h, mission, hs.scanIntervalSeconds)) {
    const jitter = 1 + hs.noiseFraction * (Math.random() * 2 - 1);
    const scanPrecision = clamp(precision * jitter, 0.1, hs.maxPrecisionMeters);
    const sigma = scanPrecision / 2;
    const dx = randomNormal() * sigma;
    const dy = randomNormal() * sigma;
    const estimate = fromLocalMeters(dx, dy, a.latitude, a.longitude);
    h.estimated = {
      latitude: estimate.latitude,
      longitude: estimate.longitude,
      precisionMeters: scanPrecision,
      errorMeters: Math.hypot(dx, dy),
      elapsedMs: mission.clock.elapsedMs,
      timestamp: missionTimestamp(mission),
      source: 'helmet-stereo',
      provenance: CONFIG.provenance.simulated
    };
    a.precisionMeters = scanPrecision;

    if (!inVehicle) {
      h.detections += detectObstaclesAround(
        mission, 'helmet-stereo', a.latitude, a.longitude, CONFIG.obstacles.detectionRadiusMeters.astronaut
      );
    }
  }

  // Vehicle LiDAR: obstacle detection while driving.
  lidar.status = inVehicle ? 'scanning' : 'standby';
  const v = mission.vehicle;
  if (inVehicle && isFiniteNumber(v.latitude) && due(lidar, mission, CONFIG.sensors.vehicleLidar.scanIntervalSeconds)) {
    lidar.detections += detectObstaclesAround(
      mission, 'vehicle-lidar', v.latitude, v.longitude, CONFIG.sensors.vehicleLidar.rangeMeters
    );
  }
}

/** Short status of both sensors (for the interface and the log). */
export function getSensorSummary(mission) {
  const s = mission && mission.sensors;
  if (!s) return null;
  return {
    vehicleLidar: { status: s.vehicleLidar.status, scans: s.vehicleLidar.scanCount, detections: s.vehicleLidar.detections },
    helmetStereo: {
      status: s.helmetStereo.degraded ? 'degraded' : s.helmetStereo.status,
      scans: s.helmetStereo.scanCount,
      detections: s.helmetStereo.detections,
      precisionMeters: mission.astronaut.precisionMeters,
      distanceSinceFix: formatDistance(s.helmetStereo.distanceSinceFixMeters)
    }
  };
}

export function initSensors() {
  onMissionTick(onTick);
}