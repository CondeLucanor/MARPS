/**
 * MAЯPS — obstacles: predefined dataset, mission copy and detection during exploration.
 *
 * Two categories (both predefined, never generated):
 *   known = true    visible from orbit, known from the start (detected = true from the beginning).
 *   known = false   hidden: it is detected when the astronaut (or vehicle) approaches it.
 *
 * Detection: a hidden obstacle is detected when the distance to its EDGE is below the detection radius
 * (CONFIG.obstacles.detectionRadiusMeters: astronaut or vehicle). The source sensor is stored in
 * the record: "helmet-stereo" on foot, "vehicle-lidar" inside the vehicle.
 *
 * Record fields (spec): id, latitude, longitude, type, detectionTime, sourceSensor, detected.
 * Extra fields: name, known, radiusMeters, heightMeters (rocks).
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, missionTimestamp } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onMissionTick } from './mission-manager.js';
import { addMissionEvent } from './records.js';
import { distanceMeters } from './geodesy.js';
import { showToast } from './ui.js';
import { isFiniteNumber, deepClone } from './utils.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SENSOR_LABELS = { 'helmet-stereo': 'helmet stereo cameras', 'vehicle-lidar': 'vehicle LiDAR' };

let dataset = null;
let loadPromise = null;

/* ------------------------------------------------------------------ data */

function normalize(raw) {
  if (!raw || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (!isFiniteNumber(raw.latitude) || !isFiniteNumber(raw.longitude)) return null;
  const type = CONFIG.obstacleTypes[raw.type] ? raw.type : null;
  if (!type) return null;

  const known = raw.known === true;
  const defaults = CONFIG.obstacleTypes[type];
  const record = {
    id: raw.id,
    name: String(raw.name || defaults.label).slice(0, 60),
    type,
    latitude: raw.latitude,
    longitude: raw.longitude,
    radiusMeters: isFiniteNumber(raw.radiusMeters) && raw.radiusMeters > 0 ? raw.radiusMeters : 10,
    known,
    detected: known,
    detectionTime: null,
    sourceSensor: known ? String(raw.sourceSensor || 'orbital-survey') : null
  };
  if (type === 'rock') {
    record.heightMeters = isFiniteNumber(raw.heightMeters) ? raw.heightMeters : defaults.defaultHeightMeters;
  }
  return record;
}

/** Loads the dataset once. Resolves with an array (empty if the file is missing or invalid). */
export function loadObstacleData() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const response = await fetch(CONFIG.obstacles.file);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const list = Array.isArray(json) ? json : json.obstacles;
      if (!Array.isArray(list)) throw new Error('unexpected format');

      const seen = new Set();
      const obstacles = [];
      for (const raw of list) {
        const obstacle = normalize(raw);
        if (!obstacle || seen.has(obstacle.id)) {
          console.warn('[MAЯPS] An obstacle was ignored (invalid or duplicated):', raw);
          continue;
        }
        seen.add(obstacle.id);
        obstacles.push(obstacle);
      }
      dataset = obstacles;
    } catch (err) {
      dataset = [];
      console.error(`[MAЯPS] Could not load ${CONFIG.obstacles.file}: ${err.message}`);
      showToast('The obstacle data could not be loaded. Check data/obstacles.json.', 'error');
    }
    return dataset;
  })();
  return loadPromise;
}

function populate(mission) {
  if (!dataset || mission.obstacles.length > 0) return;
  mission.obstacles = dataset.map((o) => deepClone(o));
}

/* ------------------------------------------------------------------ detection */

function onTick({ mission }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const a = mission.astronaut;
  if (!isFiniteNumber(a.latitude) || !isFiniteNumber(a.longitude)) return;

  const inVehicle = Boolean(mission.insideVehicle);
  const detectionRadius = inVehicle
    ? CONFIG.obstacles.detectionRadiusMeters.vehicle
    : CONFIG.obstacles.detectionRadiusMeters.astronaut;
  const sensor = inVehicle ? 'vehicle-lidar' : 'helmet-stereo';

  for (const obstacle of mission.obstacles) {
    if (obstacle.detected) continue;
    const centerDistance = distanceMeters(a.latitude, a.longitude, obstacle.latitude, obstacle.longitude);
    if (centerDistance - obstacle.radiusMeters > detectionRadius) continue;

    obstacle.detected = true;
    obstacle.detectionTime = missionTimestamp(mission);
    obstacle.sourceSensor = sensor;

    const typeLabel = CONFIG.obstacleTypes[obstacle.type].label;
    addMissionEvent(mission, {
      type: 'OBSTACLE_DETECTED',
      severity: 'warning',
      message: `New obstacle detected: ${typeLabel.toLowerCase()} (${SENSOR_LABELS[sensor]}).`,
      latitude: obstacle.latitude,
      longitude: obstacle.longitude,
      data: { id: obstacle.id, type: obstacle.type, source: sensor }
    });
    emit(EVENTS.OBSTACLE_DETECTED, { mission, obstacle });
    showToast(`New obstacle detected: ${typeLabel}`, 'warning');
  }
}

/* ------------------------------------------------------------------ init */

export function initObstacles() {
  loadObstacleData();
  on(EVENTS.MISSION_STARTED, ({ mission }) => {
    loadObstacleData().then(() => populate(mission));
  });
    // Detection now runs from the sensors (js/sensors.js, Stage 8).
}


/**
 * Stage 8: called by sensors.js at every sensor scan.
 * Detects the hidden obstacles whose edge is within rangeMeters of (centerLat, centerLon).
 * sensor: 'helmet-stereo' | 'vehicle-lidar'. Returns the number of new detections.
 */
export function detectObstaclesAround(mission, sensor, centerLat, centerLon, rangeMeters) {
    let found = 0;
    for (const obstacle of mission.obstacles) {
      if (obstacle.detected) continue;
      const centerDistance = distanceMeters(centerLat, centerLon, obstacle.latitude, obstacle.longitude);
      if (centerDistance - obstacle.radiusMeters > rangeMeters) continue;
  
      obstacle.detected = true;
      obstacle.detectionTime = missionTimestamp(mission);
      obstacle.sourceSensor = sensor;
      found += 1;
  
      const typeLabel = CONFIG.obstacleTypes[obstacle.type].label;
      addMissionEvent(mission, {
        type: 'OBSTACLE_DETECTED',
        severity: 'warning',
        message: `New obstacle detected: ${typeLabel.toLowerCase()} (${SENSOR_LABELS[sensor]}).`,
        latitude: obstacle.latitude,
        longitude: obstacle.longitude,
        data: { id: obstacle.id, type: obstacle.type, source: sensor }
      });
      emit(EVENTS.OBSTACLE_DETECTED, { mission, obstacle });
      showToast(`New obstacle detected: ${typeLabel}`, 'warning');
    }
    return found;
  }