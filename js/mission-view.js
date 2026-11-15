/**
 * MAЯPS — Mission View section (shell).
 * Chooses which of the three screens is visible:
 *   welcome         no active mission
 *   pre-exploration landing flow (the work happens on the Map section)
 *   exploration     first-person view (added in a later stage)
 */
import { LIFECYCLE, getCurrentMission } from './state.js';
import { on, EVENTS } from './events.js';
import { navigateTo } from './navigation.js';

const PRE_EXPLORATION_PHASES = new Set([
  LIFECYCLE.LANDING_SITE_SELECTION,
  LIFECYCLE.LANDING_ANALYSIS,
  LIFECYCLE.LANDING_SIMULATION,
  LIFECYCLE.POSITION_DETERMINATION,
  LIFECYCLE.LANDING_CONFIRMATION
]);

const EXPLORATION_PHASES = new Set([
  LIFECYCLE.EXPLORATION_ACTIVE,
  LIFECYCLE.MISSION_PAUSED
]);

const PRE_EXPLORATION_TEXT = {
  [LIFECYCLE.LANDING_SITE_SELECTION]: 'Choose a landing site and an error radius on the map. The first-person view opens once the landing is confirmed.',
  [LIFECYCLE.LANDING_ANALYSIS]: 'The landing site is being analysed. Review the terrain safety report on the map.',
  [LIFECYCLE.LANDING_SIMULATION]: 'The descent to the surface is in progress.',
  [LIFECYCLE.POSITION_DETERMINATION]: 'The LiDAR is determining the position after landing.',
  [LIFECYCLE.LANDING_CONFIRMATION]: 'Review the actual landing position and confirm it on the map to start exploring.'
};

export function initMissionView() {
  document.getElementById('btn-welcome-start')?.addEventListener('click', () => navigateTo('mission-setup'));
  document.getElementById('btn-go-landing')?.addEventListener('click', () => navigateTo('map'));

  on(EVENTS.MISSION_STARTED, updateMode);
  on(EVENTS.MISSION_PHASE_CHANGED, updateMode);
  on(EVENTS.MISSION_ENDED, updateMode);
  updateMode();
}

function updateMode() {
  const section = document.getElementById('section-mission-view');
  if (!section) return;

  const mission = getCurrentMission();
  let mode = 'welcome';
  if (mission) {
    if (PRE_EXPLORATION_PHASES.has(mission.phase)) mode = 'pre-exploration';
    else if (EXPLORATION_PHASES.has(mission.phase)) mode = 'exploration';
  }
  section.dataset.mode = mode;

  const textEl = document.getElementById('pre-exploration-text');
  if (textEl) textEl.textContent = mission ? (PRE_EXPLORATION_TEXT[mission.phase] || '') : '';
}