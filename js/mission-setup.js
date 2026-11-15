/**
 * MAЯPS — Mission Setup section.
 * Always accessible. Without an active mission: form to create one.
 * With an active mission: summary + the option to start another one. Starting another one asks for
 * confirmation, ends and archives the current mission (nothing is discarded) and starts the new one.
 * Simulation parameters are edited in js/config.js, not here.
 */
import { CONFIG } from './config.js';
import { getCurrentMission } from './state.js';
import { on, EVENTS } from './events.js';
import { escapeHtml, formatDuration } from './utils.js';
import { navigateTo } from './navigation.js';
import { startMission, endMission, PHASE_LABELS } from './mission-manager.js';
import { showToast, confirmDialog } from './ui.js';

let root = null;

export function initMissionSetup() {
  root = document.getElementById('setup-root');
  if (!root) return;

  on(EVENTS.MISSION_STARTED, render);
  on(EVENTS.MISSION_PHASE_CHANGED, render);
  on(EVENTS.MISSION_ENDED, render);
  on(EVENTS.SECTION_CHANGED, (payload) => {
    if (payload.section === 'mission-setup') render();
  });

  // Event delegation: keeps working after the content is redrawn.
  root.addEventListener('click', (event) => {
    if (event.target.closest('#setup-create')) createFromForm();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'setup-name') createFromForm();
  });

  render();
}

async function createFromForm() {
  const input = document.getElementById('setup-name');
  const name = input ? input.value : '';

  const current = getCurrentMission();
  if (current) {
    const ok = await confirmDialog({
      title: 'A mission is already active',
      message: `Mission "${current.name}" is still active and must be ended first. If you continue, it will be ended and moved to the Mission Archive (this session only: export it to keep it), and the new mission will start.`,
      confirmLabel: 'End it and start the new mission',
      cancelLabel: 'Keep the current mission',
      danger: true
    });
    if (!ok || getCurrentMission() !== current) return;
    endMission();
  }

  const mission = startMission(name);
  if (mission) {
    showToast(`Mission ${mission.id} created. Select a landing site on the map.`, 'success');
    navigateTo('map');
  }
}

function parametersCard() {
  const sim = CONFIG.simulation;
  return `
    <div class="card">
      <h3>Simulation parameters</h3>
      <table class="kv">
        <tr><th>Region</th><td>${escapeHtml(CONFIG.region.name)}</td></tr>
        <tr><th>Elevation data</th><td>Real MOLA grid, ${Math.round(CONFIG.terrain.cellSizeMeters)} m per cell</td></tr>
        <tr><th>Time multiplier (exploration)</th><td>×${sim.timeMultiplier}</td></tr>
        <tr><th>Time multiplier (landing)</th><td>×${sim.preExplorationMultiplier}</td></tr>
      </table>
      <p class="hint">To change these values, edit <span class="mono">js/config.js</span> and reload the page.</p>
    </div>`;
}

function newMissionCard(active) {
  return `
    <div class="card">
      <h3>${active ? 'Start another mission' : 'New mission'}</h3>
      <label for="setup-name">Mission name</label>
      <input id="setup-name" type="text" maxlength="60" autocomplete="off" placeholder="e.g. Acidalia survey">
      <p class="hint">Optional. If left empty, the mission ID is used as the name. IDs (MISSION_001, MISSION_002…) are assigned automatically.${active ? ' You will be asked to confirm: the current mission is ended and archived first.' : ''}</p>
      <button id="setup-create" class="btn btn-primary" type="button">${active ? 'End current mission and start new' : 'Create mission'}</button>
    </div>`;
}

function render() {
  if (!root) return;
  const mission = getCurrentMission();

  // Keep what the user is typing if the screen is redrawn.
  const previous = document.getElementById('setup-name');
  const typed = previous ? previous.value : '';

  if (!mission) {
    root.innerHTML = `<h2>Mission Setup</h2>${newMissionCard(false)}${parametersCard()}`;
  } else {
    const started = new Date(mission.startTime).toLocaleString();
    root.innerHTML = `
      <h2>Mission Setup</h2>
      <div class="card">
        <h3>Active mission</h3>
        <table class="kv">
          <tr><th>ID</th><td class="mono">${escapeHtml(mission.id)}</td></tr>
          <tr><th>Name</th><td>${escapeHtml(mission.name)}</td></tr>
          <tr><th>Phase</th><td>${escapeHtml(PHASE_LABELS[mission.phase])}</td></tr>
          <tr><th>Started</th><td>${escapeHtml(started)}</td></tr>
          <tr><th>Simulated time elapsed</th><td>${escapeHtml(formatDuration(mission.clock.elapsedMs / 1000))}</td></tr>
          <tr><th>Time multiplier (exploration)</th><td>×${mission.settings.timeMultiplier}</td></tr>
          <tr><th>Events recorded</th><td>${mission.records.missionEvents.length}</td></tr>
        </table>
        <p class="hint">Parameters cannot be changed during a mission.</p>
      </div>
      ${newMissionCard(true)}
      ${parametersCard()}`;
  }

  const input = document.getElementById('setup-name');
  if (input && typed) input.value = typed;
}