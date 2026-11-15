/**
 * MAЯPS — central state. This is the single source of mission data.
 * No other module keeps its own copy of mission data: they all read and modify these objects.
 */
import { CONFIG } from './config.js';

export const LIFECYCLE = Object.freeze({
  NO_ACTIVE_MISSION: 'NO_ACTIVE_MISSION',
  MISSION_SETUP: 'MISSION_SETUP',
  LANDING_SITE_SELECTION: 'LANDING_SITE_SELECTION',
  LANDING_ANALYSIS: 'LANDING_ANALYSIS',
  LANDING_SIMULATION: 'LANDING_SIMULATION',
  POSITION_DETERMINATION: 'POSITION_DETERMINATION',
  LANDING_CONFIRMATION: 'LANDING_CONFIRMATION',
  EXPLORATION_ACTIVE: 'EXPLORATION_ACTIVE',
  MISSION_PAUSED: 'MISSION_PAUSED',
  MISSION_ENDED: 'MISSION_ENDED'
});

export const MOVEMENT_MODE = Object.freeze({
  WALKING: 'walking',
  VEHICLE: 'vehicle'
});

export const appState = {
  currentMission: null,     // the active mission, or null
  missions: [],             // ended missions of this session + imported missions
  currentSection: 'mission-view',
  missionPaused: false,
  missionActive: false,
  missionCounter: 0
};

export function getCurrentMission() {
  return appState.currentMission;
}

/** Returns a mission ID not used by any known mission, e.g. MISSION_001. */
export function nextMissionId() {
  const used = new Set(appState.missions.map((m) => m.id));
  if (appState.currentMission) used.add(appState.currentMission.id);
  let id;
  do {
    appState.missionCounter += 1;
    id = `${CONFIG.app.missionIdPrefix}${String(appState.missionCounter).padStart(3, '0')}`;
  } while (used.has(id));
  return id;
}

/** Current simulated time of a mission, as a timestamp in milliseconds. */
export function missionTimestamp(mission) {
  return mission.startTime + mission.clock.elapsedMs;
}

/** Creates a new empty mission. The key names of `records` match the JSON export schema. */
export function createMission(id, name) {
  return {
    id,
    name: name || id,
    status: 'ACTIVE',
    phase: LIFECYCLE.NO_ACTIVE_MISSION,
    startTime: Date.now(),
    endTime: null,
    clock: { elapsedMs: 0 },
    settings: {
      timeMultiplier: CONFIG.simulation.timeMultiplier
    },
    landing: {
      planned: null,
      analysis: null,
      errorRadiusMeters: null,
      actual: null,
      errorDistanceMeters: null,
      lidar: null,
      confirmed: false
    },
    astronaut: {
      latitude: null,
      longitude: null,
      altitude: null,
      headingDegrees: 0,
      pitchDegrees: 0,
      precisionMeters: null,
      movementMode: MOVEMENT_MODE.WALKING,
      speedClass: 'normal',
      speedMetersPerSecond: 0,
      isMoving: false
    },
    vehicle: {
      latitude: null,
      longitude: null,
      headingDegrees: 0,
      batteryPercent: CONFIG.vehicle.battery.initialPercent,
      isCharging: false,
      distanceTravelledMeters: 0
    },
    insideVehicle: false,
    navigation: {
      destinationId: null,
      routes: { recommended: null, alternatives: [] },
      selectedRouteIndex: 0
    },
    obstacles: [],
    scientificPoints: [],
    environment: { current: null },
    records: {
      astronautPositions: [],
      vehiclePositions: [],
      environmentMeasurements: [],
      missionEvents: [],
      routes: [],
      batteryEvents: [],
      scientificVisits: []
    },
    counters: { event: 0, route: 0 }
  };
}