/**
 * MAЯPS — exploration vehicle: enter / exit and battery (Stage 8).
 *
 * ENTER / EXIT
 *   - Enter: the astronaut must be within CONFIG.vehicle.enterRadiusMeters of the vehicle (default 75 m).
 *     The vehicle never moves by itself, so there is no entering from far away. No terrain restriction.
 *   - Exit: possible anywhere. The vehicle stays where it is.
 *   - Key E, the button in the Vehicle panel of the HUD, or the arrival window ("Exit Vehicle").
 *   - Inside the vehicle astronaut and vehicle move together (astronaut.js uses the vehicle profile).
 *
 * BATTERY (all values in CONFIG.vehicle.battery)
 *   - Consumption by distance driven (percent per km) and by operating time (percent per hour,
 *     counted only while the astronaut is inside = vehicle systems active).
 *   - Charging only at the landing base (CONFIG.vehicle.base.radiusMeters around the actual landing
 *     position), automatic, at chargeRatePercentPerMinute of simulated time.
 *   - A record is written every eventStepPercent of change (mission.records.batteryEvents); consumption
 *     steps, charging start/stop/full, low battery and empty battery are also written to the event log.
 *   - Low battery: notification at lowThresholdPercent. The astronaut is never forced to return.
 *   - At 0 % the vehicle cannot move (astronaut.js blocks it). Walking is still possible.
 *   - The astronaut's suit has no energy or oxygen limits.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, MOVEMENT_MODE, appState, getCurrentMission, missionTimestamp } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onMissionTick } from './mission-manager.js';
import { onFrame } from './simulation.js';
import { addMissionEvent } from './records.js';
import { showToast } from './ui.js';
import { distanceMeters } from './geodesy.js';
import { getTerrainAt } from './terrain.js';
import { clamp, formatDistance, isFiniteNumber } from './utils.js';

const DEFAULT_ENTER_RADIUS_METERS = 75;
const UI_INTERVAL_MS = 200;

let ui = null;          // { stateEl, button }
let lastUiAt = 0;
let track = null;       // battery bookkeeping of the current mission

/* ------------------------------------------------------------------ helpers */

function enterRadius() {
  const r = CONFIG.vehicle.enterRadiusMeters;
  return isFiniteNumber(r) && r > 0 ? r : DEFAULT_ENTER_RADIUS_METERS;
}

function exploringMission() {
  const mission = getCurrentMission();
  return mission && mission.phase === LIFECYCLE.EXPLORATION_ACTIVE ? mission : null;
}

function hasPositions(mission) {
  const a = mission.astronaut;
  const v = mission.vehicle;
  return isFiniteNumber(a.latitude) && isFiniteNumber(a.longitude) &&
    isFiniteNumber(v.latitude) && isFiniteNumber(v.longitude);
}

function distanceToVehicle(mission) {
  const a = mission.astronaut;
  const v = mission.vehicle;
  return distanceMeters(a.latitude, a.longitude, v.latitude, v.longitude);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Whether the vehicle is inside the charging area around the landing base. */
export function isVehicleAtBase(mission) {
  const base = mission.landing && mission.landing.actual;
  const v = mission.vehicle;
  if (!base || !isFiniteNumber(v.latitude) || !isFiniteNumber(v.longitude)) return false;
  return distanceMeters(v.latitude, v.longitude, base.latitude, base.longitude) <= CONFIG.vehicle.base.radiusMeters;
}

/* ------------------------------------------------------------------ enter / exit */

export function enterVehicle() {
  const mission = exploringMission();
  if (!mission || !hasPositions(mission)) return false;
  if (mission.insideVehicle) {
    showToast('You are already inside the vehicle.', 'warning');
    return false;
  }

  const distance = distanceToVehicle(mission);
  if (distance > enterRadius()) {
    showToast(`The vehicle is ${formatDistance(distance)} away. Get within ${enterRadius()} m to enter it (use Return to Vehicle).`, 'warning');
    return false;
  }

  const a = mission.astronaut;
  const v = mission.vehicle;
  const terrain = getTerrainAt(v.latitude, v.longitude);
  a.latitude = v.latitude;
  a.longitude = v.longitude;
  if (terrain.insideDem) a.altitude = terrain.elevation;
  a.isMoving = false;
  a.speedMetersPerSecond = 0;
  a.movementMode = MOVEMENT_MODE.VEHICLE;
  v.headingDegrees = a.headingDegrees;
  mission.insideVehicle = true;

  addMissionEvent(mission, {
    type: 'VEHICLE_ENTERED',
    severity: 'info',
    message: 'Astronaut entered the vehicle.',
    latitude: v.latitude,
    longitude: v.longitude,
    data: { batteryPercent: round1(v.batteryPercent) }
  });
  emit(EVENTS.VEHICLE_ENTERED, { mission });
  emit(EVENTS.POSITION_UPDATED, { mission, teleported: true });
  return true;
}

export function exitVehicle() {
  const mission = exploringMission();
  if (!mission || !hasPositions(mission)) return false;
  if (!mission.insideVehicle) return false;

  const a = mission.astronaut;
  const v = mission.vehicle;
  mission.insideVehicle = false;
  a.movementMode = MOVEMENT_MODE.WALKING;
  a.isMoving = false;
  a.speedMetersPerSecond = 0;
  v.headingDegrees = a.headingDegrees;
  v.latitude = a.latitude;     // the vehicle stays exactly where the astronaut got out
  v.longitude = a.longitude;

  addMissionEvent(mission, {
    type: 'VEHICLE_EXITED',
    severity: 'info',
    message: 'Astronaut exited the vehicle. The vehicle stays parked here.',
    latitude: v.latitude,
    longitude: v.longitude,
    data: { batteryPercent: round1(v.batteryPercent) }
  });
  emit(EVENTS.VEHICLE_EXITED, { mission });
  emit(EVENTS.VEHICLE_POSITION_UPDATED, { mission });
  emit(EVENTS.POSITION_UPDATED, { mission });
  return true;
}

export function toggleVehicle() {
  const mission = exploringMission();
  if (!mission) return false;
  return mission.insideVehicle ? exitVehicle() : enterVehicle();
}

/* ------------------------------------------------------------------ battery */

function trackFor(mission) {
  if (!track || track.missionId !== mission.id) {
    const percent = mission.vehicle.batteryPercent;
    track = {
      missionId: mission.id,
      lastDistance: mission.vehicle.distanceTravelledMeters,
      stepAnchor: percent,
      low: percent <= CONFIG.vehicle.battery.lowThresholdPercent,
      empty: percent <= 0,
      charging: false,
      lastTenth: Math.round(percent * 10)
    };
  }
  return track;
}

function pushBatteryRecord(mission, type, percent, extra = {}) {
  const v = mission.vehicle;
  mission.records.batteryEvents.push({
    timestamp: missionTimestamp(mission),
    elapsedMs: mission.clock.elapsedMs,
    type,
    batteryPercent: round1(percent),
    latitude: v.latitude,
    longitude: v.longitude,
    distanceTravelledMeters: Math.round(v.distanceTravelledMeters),
    insideVehicle: Boolean(mission.insideVehicle),
    ...extra
  });
}

function logBattery(mission, type, severity, message, percent) {
  const v = mission.vehicle;
  addMissionEvent(mission, {
    type,
    severity,
    message,
    latitude: v.latitude,
    longitude: v.longitude,
    data: { batteryPercent: round1(percent) }
  });
}

function onTick({ mission, simDt }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE || !hasPositions(mission)) return;

  const v = mission.vehicle;
  const cfg = CONFIG.vehicle.battery;
  const t = trackFor(mission);
  const before = v.batteryPercent;

  // Consumption: distance driven since the last tick + operating time (astronaut inside).
  const driven = Math.max(0, v.distanceTravelledMeters - t.lastDistance);
  t.lastDistance = v.distanceTravelledMeters;
  let delta = -(driven / 1000) * cfg.consumptionPercentPerKm;
  if (mission.insideVehicle) delta -= (simDt / 3600) * cfg.consumptionPercentPerHour;

  // Charging only at the landing base.
  const charging = isVehicleAtBase(mission) && before < 100;
  if (charging) delta += (simDt / 60) * cfg.chargeRatePercentPerMinute;

  v.batteryPercent = clamp(before + delta, 0, 100);
  const percent = v.batteryPercent;

  // Charging state changes.
  if (charging && !t.charging) {
    t.charging = true;
    v.isCharging = true;
    pushBatteryRecord(mission, 'charging-started', percent);
    logBattery(mission, 'BATTERY_CHARGING_STARTED', 'info', `Battery charging at the landing base (${Math.round(percent)} %).`, percent);
  } else if (!charging && t.charging) {
    t.charging = false;
    v.isCharging = false;
    if (percent >= 99.95) {
      v.batteryPercent = 100;
      pushBatteryRecord(mission, 'charging-complete', 100);
      logBattery(mission, 'BATTERY_FULL', 'success', 'Battery fully charged.', 100);
      showToast('Vehicle battery fully charged.', 'success');
    } else {
      pushBatteryRecord(mission, 'charging-stopped', percent);
      logBattery(mission, 'BATTERY_CHARGING_STOPPED', 'info', `Charging stopped (${Math.round(percent)} %).`, percent);
    }
    t.stepAnchor = v.batteryPercent;
  }

  // One record per step of eventStepPercent.
  const step = Math.max(0.5, cfg.eventStepPercent);
  while (t.stepAnchor - v.batteryPercent >= step) {
    t.stepAnchor -= step;
    pushBatteryRecord(mission, 'consumption', t.stepAnchor);
    logBattery(mission, 'BATTERY_CONSUMPTION', 'info', `Battery at ${Math.round(t.stepAnchor)} %.`, t.stepAnchor);
  }
  while (v.batteryPercent - t.stepAnchor >= step) {
    t.stepAnchor += step;
    pushBatteryRecord(mission, 'charging', t.stepAnchor);
  }

  // Low and empty battery.
  if (!t.low && v.batteryPercent <= cfg.lowThresholdPercent) {
    t.low = true;
    pushBatteryRecord(mission, 'low', v.batteryPercent);
    logBattery(mission, 'BATTERY_LOW', 'warning', `Low battery: ${Math.round(v.batteryPercent)} %.`, v.batteryPercent);
    showToast(`Low vehicle battery: ${Math.round(v.batteryPercent)} %`, 'warning');
  } else if (t.low && v.batteryPercent > cfg.lowThresholdPercent + 1) {
    t.low = false;
  }
  if (!t.empty && v.batteryPercent <= 0) {
    t.empty = true;
    pushBatteryRecord(mission, 'empty', 0);
    logBattery(mission, 'BATTERY_EMPTY', 'error', 'The vehicle battery is empty. The vehicle cannot move.', 0);
    showToast('Vehicle battery empty. Exit the vehicle to continue on foot.', 'error');
  } else if (t.empty && v.batteryPercent > 0.5) {
    t.empty = false;
  }

  const tenth = Math.round(v.batteryPercent * 10);
  if (tenth !== t.lastTenth) {
    t.lastTenth = tenth;
    emit(EVENTS.BATTERY_UPDATED, { mission, batteryPercent: v.batteryPercent });
  }
}

/* ------------------------------------------------------------------ interface */

function inputAllowed() {
  if (!exploringMission()) return false;
  if (appState.currentSection !== 'mission-view') return false;
  if (document.querySelector('#modal-root .modal-backdrop')) return false;
  const el = document.activeElement;
  return !(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function onKeyDown(event) {
  if (event.key !== 'e' && event.key !== 'E') return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (!inputAllowed()) return;
  event.preventDefault();
  toggleVehicle();
}

function buildUi() {
  const panel = document.querySelector('#mission-view-root .ev-tr .ev-panel:last-child');
  if (!panel) {
    console.warn('[MAЯPS] The Vehicle panel of the HUD was not found. Use the E key to enter or exit the vehicle.');
    return;
  }
  const box = document.createElement('div');
  box.className = 'vehicle-actions';
  box.innerHTML = `
    <div class="ev-row"><span class="ev-label">Status</span><span class="ev-value" data-v="state">—</span></div>
    <button type="button" class="btn btn-small" data-v="button" disabled>Enter Vehicle (E)</button>`;
  panel.appendChild(box);
  ui = { stateEl: box.querySelector('[data-v="state"]'), button: box.querySelector('[data-v="button"]') };
  ui.button.addEventListener('click', () => {
    toggleVehicle();
    ui.button.blur();   // the arrow keys must keep controlling the astronaut
  });
}

function refreshUi() {
  if (!ui) return;
  const now = performance.now();
  if (now - lastUiAt < UI_INTERVAL_MS) return;
  lastUiAt = now;

  const mission = getCurrentMission();
  if (!mission || !hasPositions(mission)) return;

  const exploring = mission.phase === LIFECYCLE.EXPLORATION_ACTIVE;
  const inside = Boolean(mission.insideVehicle);
  const distance = distanceToVehicle(mission);

  let text = inside ? 'Occupied' : `Parked · ${formatDistance(distance)} away`;
  if (mission.vehicle.isCharging) text += ' · Charging';
  if (ui.stateEl.textContent !== text) ui.stateEl.textContent = text;

  const label = inside ? 'Exit Vehicle (E)' : 'Enter Vehicle (E)';
  if (ui.button.textContent !== label) ui.button.textContent = label;
  ui.button.disabled = !exploring || (!inside && distance > enterRadius());
  ui.button.title = !inside && distance > enterRadius() ? `Get within ${enterRadius()} m of the vehicle` : '';
}

/* ------------------------------------------------------------------ init */

export function initVehicle() {
  buildUi();
  window.addEventListener('keydown', onKeyDown);

  on(EVENTS.MISSION_STARTED, () => { track = null; });
  on(EVENTS.MISSION_ENDED, () => { track = null; });
  on('VEHICLE_EXIT_REQUESTED', () => { exitVehicle(); });   // sent by the arrival window

  onMissionTick(onTick);
  onFrame(refreshUi);
}