/**
 * MAЯPS — astronaut (and vehicle) movement.
 *
 * - The heading (mission.astronaut.headingDegrees) is the ONE variable that both the arrow keys and the
 *   mouse change. Pitch (looking up/down) is independent of the heading and limited.
 * - Rotation runs every drawn frame (smooth, uses real time). Translation runs on the simulation tick
 *   and uses simulated time, so it follows the time multiplier.
 * - Speed depends on the terrain slope (Normal / Slow / Very Slow), using the mobility profile of the
 *   astronaut or of the vehicle when mission.insideVehicle is true. Speeds are in CONFIG.movement.profiles.
 * - Movement is blocked by: slopes above the profile limit, obstacles that the profile cannot clear,
 *   and the edge of the study region. Routes are never touched here, so stopping never loses them.
 *
 * Positions are in mission.astronaut / mission.vehicle. When the astronaut is inside the vehicle both
 * move together; when walking the vehicle stays where it is.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, MOVEMENT_MODE, getCurrentMission } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onMissionTick } from './mission-manager.js';
import { onFrame } from './simulation.js';
import { getTerrainAt } from './terrain.js';
import { destinationPoint, distanceMeters, isInsideRegion } from './geodesy.js';
import { clamp, normalizeAngle360, isFiniteNumber } from './utils.js';
import { showToast } from './ui.js';

/** Key state, written by exploration-view.js. */
export const controls = { forward: false, backward: false, left: false, right: false };

const BLOCK_MESSAGES = {
  slope: 'Movement blocked: the terrain ahead is too steep.',
  obstacle: 'Movement blocked: obstacle ahead.',
  region: 'Movement blocked: edge of the study region.',
  battery: 'Movement blocked: the vehicle battery is empty. Exit the vehicle and walk, or recharge at the landing base.'
};

const DEFAULT_OBSTACLE_RADIUS_METERS = 5;
const BLOCK_TOAST_COOLDOWN_MS = 4000;

let travelMeters = 0;   // signed distance travelled (forward positive); drives the forward-movement visual
let lastBlockToastAt = 0;
const status = { terrainType: 'unknown', slopeDegrees: null, blockedReason: null };

export function getTravelMeters() {
  return travelMeters;
}

export function getMovementStatus() {
  return { ...status };
}

export function clearControls() {
  controls.forward = false;
  controls.backward = false;
  controls.left = false;
  controls.right = false;
}

/* ------------------------------------------------------------------ terrain-dependent speed */

/** 'normal' | 'slow' | 'verySlow' | 'impassable' for a slope and a mobility profile. */
export function classifySlope(slopeDegrees, profileKey = 'astronaut') {
  const profile = CONFIG.movement.profiles[profileKey];
  if (!profile || !isFiniteNumber(slopeDegrees)) return 'normal';
  const c = profile.slopeClassesDegrees;
  if (slopeDegrees > Math.min(c.verySlowMax, profile.maxSlopeDegrees)) return 'impassable';
  if (slopeDegrees <= c.normalMax) return 'normal';
  if (slopeDegrees <= c.slowMax) return 'slow';
  return 'verySlow';
}

/** Forward speed in m/s on a slope (0 if impassable). Also used to estimate travel times. */
export function getSpeedMetersPerSecond(slopeDegrees, profileKey = 'astronaut') {
  const profile = CONFIG.movement.profiles[profileKey];
  const cls = classifySlope(slopeDegrees, profileKey);
  if (!profile || cls === 'impassable') return 0;
  return profile.speedsMetersPerSecond[cls];
}

/* ------------------------------------------------------------------ camera */

function explorationMission() {
  const mission = getCurrentMission();
  return mission && mission.phase === LIFECYCLE.EXPLORATION_ACTIVE ? mission : null;
}

function syncVehicleHeading(mission) {
  if (mission.insideVehicle) mission.vehicle.headingDegrees = mission.astronaut.headingDegrees;
}

/** Turns the view. Used by the mouse: dHeading changes the shared heading, dPitch looks up (+) or down (-). */
export function lookBy(dHeadingDegrees, dPitchDegrees) {
  const mission = explorationMission();
  if (!mission) return;
  const a = mission.astronaut;
  a.headingDegrees = normalizeAngle360(a.headingDegrees + dHeadingDegrees);
  const limit = CONFIG.movement.pitchLimitDegrees;
  a.pitchDegrees = clamp(a.pitchDegrees + dPitchDegrees, -limit, limit);
  syncVehicleHeading(mission);
}

/** Keyboard rotation, every drawn frame. */
function onFrameRotate(realDt) {
  const mission = explorationMission();
  if (!mission) return;
  const turn = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  if (turn === 0) return;
  const a = mission.astronaut;
  a.headingDegrees = normalizeAngle360(a.headingDegrees + turn * CONFIG.movement.turnRateDegreesPerSecond * realDt);
  syncVehicleHeading(mission);
}

/* ------------------------------------------------------------------ obstacles */

/** First obstacle that blocks a move to (lat, lon), or null. Every obstacle blocks, detected or not. */
function findBlockingObstacle(mission, profile, fromLat, fromLon, toLat, toLon) {
  for (const o of mission.obstacles) {
    if (!isFiniteNumber(o.latitude) || !isFiniteNumber(o.longitude)) continue;

    const type = CONFIG.obstacleTypes[o.type];
    if (type && type.blockingMode === 'height') {
      const height = isFiniteNumber(o.heightMeters) ? o.heightMeters : type.defaultHeightMeters;
      if (height <= profile.obstacleClearanceMeters) continue;   // low enough to cross
    }

    const radius = isFiniteNumber(o.radiusMeters) ? o.radiusMeters : DEFAULT_OBSTACLE_RADIUS_METERS;
    const dNew = distanceMeters(toLat, toLon, o.latitude, o.longitude);
    if (dNew >= radius) continue;
    // Allow leaving an obstacle you are already inside.
    const dOld = distanceMeters(fromLat, fromLon, o.latitude, o.longitude);
    if (dNew < dOld) return o;
  }
  return null;
}

/* ------------------------------------------------------------------ translation */

function setBlocked(mission, reason) {
  const a = mission.astronaut;
  a.isMoving = false;
  a.speedMetersPerSecond = 0;
  status.blockedReason = reason;

  const now = performance.now();
  if (now - lastBlockToastAt > BLOCK_TOAST_COOLDOWN_MS) {
    lastBlockToastAt = now;
    showToast(BLOCK_MESSAGES[reason] || 'Movement blocked.', 'warning');
  }
}

function onTick({ mission, simDt }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const a = mission.astronaut;
  if (!isFiniteNumber(a.latitude) || !isFiniteNumber(a.longitude)) return;

  const inVehicle = Boolean(mission.insideVehicle);
  const profileKey = inVehicle ? 'vehicle' : 'astronaut';
  const profile = CONFIG.movement.profiles[profileKey];
  a.movementMode = inVehicle ? MOVEMENT_MODE.VEHICLE : MOVEMENT_MODE.WALKING;

  // Terrain under the astronaut decides the speed class (automatic, no manual speed control).
  const here = getTerrainAt(a.latitude, a.longitude);
  const slopeHere = here.insideDem ? here.slopeDegrees : 0;
  status.terrainType = here.terrainType;
  status.slopeDegrees = here.insideDem ? here.slopeDegrees : null;

  let speedClass = classifySlope(slopeHere, profileKey);
  if (speedClass === 'impassable') speedClass = 'verySlow';   // lets you walk out of a steep spot
  a.speedClass = speedClass;

  const direction = (controls.forward ? 1 : 0) - (controls.backward ? 1 : 0);
  if (direction === 0) {
    a.isMoving = false;
    a.speedMetersPerSecond = 0;
    status.blockedReason = null;
    return;
  }

  if (inVehicle && mission.vehicle.batteryPercent <= 0) {
    setBlocked(mission, 'battery');
    return;
  }
  const speed = profile.speedsMetersPerSecond[speedClass] * (direction < 0 ? CONFIG.movement.backwardSpeedFactor : 1);
  const distance = speed * simDt;
  const bearing = direction > 0 ? a.headingDegrees : normalizeAngle360(a.headingDegrees + 180);
  const next = destinationPoint(a.latitude, a.longitude, bearing, distance);

  const there = getTerrainAt(next.latitude, next.longitude);
  const slopeLimit = Math.min(profile.slopeClassesDegrees.verySlowMax, profile.maxSlopeDegrees);

  if (!isInsideRegion(next.latitude, next.longitude) || !there.insideDem) {
    setBlocked(mission, 'region');
    return;
  }
  if (there.slopeDegrees > slopeLimit && there.slopeDegrees > slopeHere) {
    setBlocked(mission, 'slope');
    return;
  }
  if (findBlockingObstacle(mission, profile, a.latitude, a.longitude, next.latitude, next.longitude)) {
    setBlocked(mission, 'obstacle');
    return;
  }

  status.blockedReason = null;
  a.latitude = next.latitude;
  a.longitude = next.longitude;
  a.altitude = there.elevation;
  a.isMoving = true;
  a.speedMetersPerSecond = speed;
  travelMeters += direction * distance;

  if (inVehicle) {
    const v = mission.vehicle;
    v.latitude = next.latitude;
    v.longitude = next.longitude;
    v.headingDegrees = a.headingDegrees;
    v.distanceTravelledMeters += distance;
    emit(EVENTS.VEHICLE_POSITION_UPDATED, { mission });
  }
  emit(EVENTS.POSITION_UPDATED, { mission });
}

/* ------------------------------------------------------------------ testing helper */

/**
 * FOR TESTING FROM THE CONSOLE ONLY (it is not part of the simulation): places the astronaut at a point.
 * Example: MARPS.astronaut.debugSetPosition(40.75, 350.54)
 */
export function debugSetPosition(latitude, longitude) {
  const mission = getCurrentMission();
  if (!mission || !isFiniteNumber(mission.astronaut.latitude)) {
    console.warn('[MAЯPS] debugSetPosition needs an active mission that has landed.');
    return null;
  }
  const terrain = getTerrainAt(latitude, longitude);
  if (!terrain.insideDem) {
    console.warn('[MAЯPS] That point is outside the terrain data.');
    return null;
  }
  const a = mission.astronaut;
  a.latitude = latitude;
  a.longitude = longitude;
  a.altitude = terrain.elevation;
  if (mission.insideVehicle) {
    mission.vehicle.latitude = latitude;
    mission.vehicle.longitude = longitude;
  }
  emit(EVENTS.POSITION_UPDATED, { mission, teleported: true });
  return { latitude, longitude, elevation: terrain.elevation, slopeDegrees: terrain.slopeDegrees, terrainType: terrain.terrainType };
}

/* ------------------------------------------------------------------ init */

function resetMovement() {
  travelMeters = 0;
  status.terrainType = 'unknown';
  status.slopeDegrees = null;
  status.blockedReason = null;
  clearControls();
}

export function initAstronaut() {
  on(EVENTS.MISSION_STARTED, resetMovement);
  on(EVENTS.MISSION_ENDED, resetMovement);
  on(EVENTS.MISSION_PAUSED, clearControls);
  on(EVENTS.MISSION_PHASE_CHANGED, ({ to }) => {
    if (to !== LIFECYCLE.EXPLORATION_ACTIVE) clearControls();
  });

  onMissionTick(onTick);
  onFrame(onFrameRotate);
}