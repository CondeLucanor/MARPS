/**
 * MAЯPS — mission manager: mission lifecycle, simulated mission clock and the mission bar.
 *
 * Other modules use:
 *   startMission(name)      creates the mission (called by mission-setup.js)
 *   setPhase(phase)         moves the mission to the next lifecycle phase
 *   pauseMission / resumeMission / requestEndMission
 *   onMissionTick(fn)       fn({ mission, realDt, simDt }) every simulation step while the mission is running
 *
 * Pause is only allowed during exploration.
 * Time multiplier: mission.settings.timeMultiplier during exploration,
 * CONFIG.simulation.preExplorationMultiplier before it.
 */
import { CONFIG } from './config.js';
import {
  appState,
  LIFECYCLE,
  createMission,
  nextMissionId,
  getCurrentMission,
  missionTimestamp
} from './state.js';
import { emit, EVENTS } from './events.js';
import { onSimStep, onFrame } from './simulation.js';
import { addMissionEvent } from './records.js';
import { pad2 } from './utils.js';
import { showToast, confirmDialog } from './ui.js';
import { navigateTo } from './navigation.js';

export const PHASE_LABELS = Object.freeze({
  [LIFECYCLE.NO_ACTIVE_MISSION]: 'No active mission',
  [LIFECYCLE.MISSION_SETUP]: 'Mission setup',
  [LIFECYCLE.LANDING_SITE_SELECTION]: 'Landing site selection',
  [LIFECYCLE.LANDING_ANALYSIS]: 'Landing analysis',
  [LIFECYCLE.LANDING_SIMULATION]: 'Landing simulation',
  [LIFECYCLE.POSITION_DETERMINATION]: 'Position determination',
  [LIFECYCLE.LANDING_CONFIRMATION]: 'Landing confirmation',
  [LIFECYCLE.EXPLORATION_ACTIVE]: 'Exploration',
  [LIFECYCLE.MISSION_PAUSED]: 'Paused',
  [LIFECYCLE.MISSION_ENDED]: 'Ended'
});

// Expected transitions. An unexpected one is still applied, but a warning is written to the Console.
const EXPECTED_TRANSITIONS = {
  [LIFECYCLE.MISSION_SETUP]: [LIFECYCLE.LANDING_SITE_SELECTION],
  [LIFECYCLE.LANDING_SITE_SELECTION]: [LIFECYCLE.LANDING_ANALYSIS],
  [LIFECYCLE.LANDING_ANALYSIS]: [LIFECYCLE.LANDING_SITE_SELECTION, LIFECYCLE.LANDING_SIMULATION],
  [LIFECYCLE.LANDING_SIMULATION]: [LIFECYCLE.POSITION_DETERMINATION],
  [LIFECYCLE.POSITION_DETERMINATION]: [LIFECYCLE.LANDING_CONFIRMATION],
  [LIFECYCLE.LANDING_CONFIRMATION]: [LIFECYCLE.LANDING_SITE_SELECTION, LIFECYCLE.EXPLORATION_ACTIVE]
};

const tickListeners = new Set();

/** Subscribes to the mission tick. Returns a function that removes the subscription. */
export function onMissionTick(fn) {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

/** Simulated seconds per real second for the current phase of a mission. */
export function getTimeMultiplier(mission) {
  if (mission.phase === LIFECYCLE.EXPLORATION_ACTIVE) return mission.settings.timeMultiplier;
  return CONFIG.simulation.preExplorationMultiplier;
}

/** Formats elapsed milliseconds as HH:MM:SS (hours may exceed 24). */
export function formatElapsed(elapsedMs) {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/* ------------------------------------------------------------------ lifecycle */

/** Creates and starts a new mission. Returns the mission, or null if one is already active. */
export function startMission(name) {
  if (appState.currentMission) {
    showToast('A mission is already active. End it before starting a new one.', 'warning');
    return null;
  }

  const cleanName = String(name || '').trim().slice(0, 60);
  const mission = createMission(nextMissionId(), cleanName);
  mission.phase = LIFECYCLE.MISSION_SETUP;

  appState.currentMission = mission;
  appState.missionActive = true;
  appState.missionPaused = false;

  addMissionEvent(mission, {
    type: 'MISSION_CREATED',
    severity: 'success',
    message: `Mission "${mission.name}" created (${mission.id}).`
  });
  emit(EVENTS.MISSION_STARTED, { mission });

  setPhase(LIFECYCLE.LANDING_SITE_SELECTION);
  return mission;
}

/** Internal: changes the phase, records it and announces it. */
function applyPhase(mission, newPhase) {
  const from = mission.phase;
  if (from === newPhase) return;

  const expected = EXPECTED_TRANSITIONS[from];
  if (expected && !expected.includes(newPhase)) {
    console.warn(`[MAЯPS] Unexpected phase transition: ${from} -> ${newPhase}`);
  }

  mission.phase = newPhase;
  addMissionEvent(mission, {
    type: 'PHASE_CHANGED',
    message: `Phase: ${PHASE_LABELS[newPhase]}.`,
    data: { from, to: newPhase }
  });
  emit(EVENTS.MISSION_PHASE_CHANGED, { mission, from, to: newPhase });
  refreshMissionBar();
}

/** Moves the active mission to a new lifecycle phase. Pause and end have their own functions. */
export function setPhase(newPhase) {
  const mission = getCurrentMission();
  if (!mission) {
    console.error('[MAЯPS] setPhase called without an active mission.');
    return false;
  }
  if (!Object.values(LIFECYCLE).includes(newPhase)) {
    console.error(`[MAЯPS] Unknown phase: ${newPhase}`);
    return false;
  }
  if (newPhase === LIFECYCLE.MISSION_PAUSED || newPhase === LIFECYCLE.MISSION_ENDED) {
    console.error('[MAЯPS] Use pauseMission() or endMission() for this phase.');
    return false;
  }
  applyPhase(mission, newPhase);
  return true;
}

export function pauseMission() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return false;

  appState.missionPaused = true;
  applyPhase(mission, LIFECYCLE.MISSION_PAUSED);
  emit(EVENTS.MISSION_PAUSED, { mission });
  return true;
}

export function resumeMission() {
  const mission = getCurrentMission();
  if (!mission || mission.phase !== LIFECYCLE.MISSION_PAUSED) return false;

  appState.missionPaused = false;
  applyPhase(mission, LIFECYCLE.EXPLORATION_ACTIVE);
  emit(EVENTS.MISSION_RESUMED, { mission });
  return true;
}

export function togglePause() {
  const mission = getCurrentMission();
  if (!mission) return;
  if (mission.phase === LIFECYCLE.MISSION_PAUSED) resumeMission();
  else pauseMission();
}

/** Asks for confirmation and then ends the mission. */
export async function requestEndMission() {
  const mission = getCurrentMission();
  if (!mission) return false;

  const confirmed = await confirmDialog({
    title: 'End mission',
    message: `End mission "${mission.name}"? It will be moved to the Mission Archive. The archive only lasts while this browser page stays open, so export the mission if you want to keep it.`,
    confirmLabel: 'End Mission',
    cancelLabel: 'Cancel',
    danger: true
  });
  if (!confirmed) return false;

  return endMission();
}

export function endMission() {
  const mission = getCurrentMission();
  if (!mission) return false;

  mission.status = 'ENDED';
  mission.phase = LIFECYCLE.MISSION_ENDED;
  mission.endTime = missionTimestamp(mission);
  addMissionEvent(mission, {
    type: 'MISSION_ENDED',
    severity: 'warning',
    message: `Mission ended after ${formatElapsed(mission.clock.elapsedMs)} of simulated time.`
  });

  appState.missions.push(mission);
  appState.currentMission = null;
  appState.missionActive = false;
  appState.missionPaused = false;

  emit(EVENTS.MISSION_ENDED, { mission });
  emit(EVENTS.ARCHIVE_UPDATED, { missions: appState.missions });
  refreshMissionBar();

  navigateTo('mission-view');
  showToast(`Mission ${mission.id} ended and stored in the Mission Archive (this session only).`, 'success');
  return true;
}

/* ------------------------------------------------------------------ mission bar */

function refreshMissionBar() {
  const bar = document.getElementById('mission-bar');
  if (!bar) return;

  const mission = getCurrentMission();
  if (!mission) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const nameEl = document.getElementById('mission-bar-name');
  const phaseEl = document.getElementById('mission-bar-phase');
  const pauseBtn = document.getElementById('btn-pause');

  nameEl.textContent = `${mission.name} · ${mission.id}`;
  phaseEl.textContent = PHASE_LABELS[mission.phase];
  phaseEl.classList.toggle('badge-warn', mission.phase === LIFECYCLE.MISSION_PAUSED);

  const canPause = mission.phase === LIFECYCLE.EXPLORATION_ACTIVE || mission.phase === LIFECYCLE.MISSION_PAUSED;
  pauseBtn.disabled = !canPause;
  pauseBtn.textContent = mission.phase === LIFECYCLE.MISSION_PAUSED ? 'Resume Mission' : 'Pause Mission';
}

let lastClockText = '';

function refreshClock() {
  const mission = getCurrentMission();
  const text = mission ? formatElapsed(mission.clock.elapsedMs) : '--:--:--';
  if (text === lastClockText) return;
  lastClockText = text;
  const clockEl = document.getElementById('mission-bar-clock');
  if (clockEl) clockEl.textContent = text;
}

/* ------------------------------------------------------------------ init */

export function initMissionManager() {
  document.getElementById('btn-pause')?.addEventListener('click', togglePause);
  document.getElementById('btn-end')?.addEventListener('click', requestEndMission);

  // Fixed-step update: advances the simulated mission clock and announces the tick.
  onSimStep((realDt) => {
    const mission = appState.currentMission;
    if (!mission || appState.missionPaused || mission.phase === LIFECYCLE.MISSION_SETUP) return;

    const simDt = realDt * getTimeMultiplier(mission);
    mission.clock.elapsedMs += simDt * 1000;

    for (const fn of [...tickListeners]) {
      try {
        fn({ mission, realDt, simDt });
      } catch (err) {
        console.error('[MAЯPS] Error in a mission tick listener:', err);
      }
    }
  });

  onFrame(refreshClock);
  refreshMissionBar();
  refreshClock();
}