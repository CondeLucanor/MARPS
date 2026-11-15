/**
 * MAЯPS — Mission Archive (Stage 9).
 * Lists the missions of THIS browser session (ended missions) and the imported ones. Nothing survives a page
 * refresh: export a mission to keep it. Selecting a mission shows its landing data, the reconstructed map
 * (mission-map.js) and the complete Mission Log (mission-log.js), all read from the recorded data.
 */
import { appState } from './state.js';
import { on, EVENTS } from './events.js';
import { escapeHtml, formatCoordinate, formatDistance, formatDuration, isFiniteNumber } from './utils.js';
import { showToast, showModal } from './ui.js';
import { exportMission } from './data-export.js';
import { importMissionFile } from './data-import.js';
import { createLogView } from './mission-log.js';
import { createMissionMap } from './mission-map.js';

let root = null;
let selectedId = null;
let logView = null;
let mapView = null;

function disposeViews() {
  if (mapView) { mapView.destroy(); mapView = null; }
  if (logView) { logView.destroy(); logView = null; }
}

const when = (ts) => (isFiniteNumber(ts) ? new Date(ts).toLocaleString() : '—');

function landingText(m) {
  const p = (m.landing && (m.landing.actual || m.landing.planned)) || null;
  return p ? escapeHtml(formatCoordinate(p.latitude, p.longitude, 3)) : '—';
}

function listHtml() {
  const missions = [...appState.missions].reverse();
  const rows = missions.map((m) => `
    <tr>
      <td class="mono">${escapeHtml(m.id)}</td>
      <td>${escapeHtml(m.name)}${m.imported ? ' <span class="badge">Imported</span>' : ''}</td>
      <td>${escapeHtml(when(m.startTime))}</td>
      <td>${escapeHtml(when(m.endTime))}</td>
      <td class="mono">${landingText(m)}</td>
      <td>${escapeHtml(m.status)}</td>
      <td class="archive-actions">
        <button type="button" class="btn btn-small btn-primary" data-act="view" data-id="${escapeHtml(m.id)}">View</button>
        <button type="button" class="btn btn-small" data-act="export" data-id="${escapeHtml(m.id)}">Export</button>
      </td>
    </tr>`).join('');

  return `
    <h2>Mission Archive</h2>
    <div class="card">
      <p>The archive holds only the missions of this browser session and the ones imported from JSON. Nothing is stored automatically: export a mission to keep it, because closing or refreshing the page deletes it.</p>
      <button type="button" class="btn btn-primary" data-act="import">Import Mission Data</button>
      <input type="file" id="archive-file" accept=".json,application/json" hidden>
    </div>
    ${missions.length === 0
      ? '<div class="card"><p class="muted">No missions in this session yet. End a mission or import a JSON file.</p></div>'
      : `<div class="card archive-scroll"><table class="log-table"><thead><tr><th>ID</th><th>Name</th><th>Start</th><th>End</th><th>Landing</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}`;
}

function landingCardHtml(m) {
  const l = m.landing || {};
  const point = (p) => (p ? escapeHtml(formatCoordinate(p.latitude, p.longitude)) : '—');
  const a = l.analysis;
  return `
    <div class="card">
      <h3>Landing information</h3>
      <table class="kv">
        <tr><th>Planned landing</th><td class="mono">${point(l.planned)}</td></tr>
        <tr><th>Actual landing</th><td class="mono">${point(l.actual)}</td></tr>
        <tr><th>Error distance</th><td>${isFiniteNumber(l.errorDistanceMeters) ? escapeHtml(formatDistance(l.errorDistanceMeters)) : '—'}${isFiniteNumber(l.errorRadiusMeters) ? ` <span class="muted">(radius ${escapeHtml(formatDistance(l.errorRadiusMeters))})</span>` : ''}</td></tr>
        <tr><th>LiDAR estimate</th><td class="mono">${point(l.lidar)}${l.lidar && isFiniteNumber(l.lidar.precisionMeters) ? ` <span class="muted">±${l.lidar.precisionMeters} m</span>` : ''}</td></tr>
        <tr><th>Elevation</th><td>${l.actual && isFiniteNumber(l.actual.elevation) ? `${Math.round(l.actual.elevation)} m` : '—'}</td></tr>
        <tr><th>Safety analysis</th><td>${a && isFiniteNumber(a.score) ? `${a.score}/100 (${escapeHtml(a.classification || '—')})` : '—'}</td></tr>
        <tr><th>Simulated duration</th><td>${escapeHtml(formatDuration(m.clock.elapsedMs / 1000))}</td></tr>
      </table>
    </div>`;
}

function detailHtml(m) {
  return `
    <div class="btn-row">
      <button type="button" class="btn" data-act="back">← Back to the archive</button>
      <button type="button" class="btn" data-act="export" data-id="${escapeHtml(m.id)}">Export Mission Data</button>
    </div>
    <h2>${escapeHtml(m.name)} <span class="muted mono">${escapeHtml(m.id)}</span></h2>
    ${landingCardHtml(m)}
    <div class="card"><h3>Mission map</h3><div id="archive-map"></div></div>
    <h3>Mission Log</h3>
    <div id="archive-log"></div>`;
}

function render() {
  if (!root) return;
  disposeViews();
  const mission = selectedId ? appState.missions.find((m) => m.id === selectedId) : null;
  if (!mission) {
    selectedId = null;
    root.innerHTML = listHtml();
    return;
  }
  root.innerHTML = detailHtml(mission);
  mapView = createMissionMap(root.querySelector('#archive-map'), mission);
  logView = createLogView(root.querySelector('#archive-log'));
  logView.update(mission, true);
}

async function handleImport(file) {
  const result = await importMissionFile(file);
  if (result.ok) {
    showToast(`Mission ${result.mission.id} imported into the archive (this session only).`, 'success');
    selectedId = null;
    render();
  } else {
    await showModal({ title: 'Import failed', bodyHtml: `<p>${escapeHtml(result.error)}</p>` });
  }
}

function onClick(event) {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'import') {
    const input = root.querySelector('#archive-file');
    if (input) input.click();
  } else if (act === 'view') {
    selectedId = el.dataset.id;
    render();
    const section = document.getElementById('section-mission-archive');
    if (section) section.scrollTop = 0;
  } else if (act === 'back') {
    selectedId = null;
    render();
  } else if (act === 'export') {
    const mission = appState.missions.find((m) => m.id === el.dataset.id);
    if (mission) exportMission(mission);
  }
}

export function initMissionArchive() {
  root = document.getElementById('archive-root');
  if (!root) return;
  root.addEventListener('click', onClick);
  root.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'archive-file') {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) handleImport(file);
    }
  });
  on(EVENTS.ARCHIVE_UPDATED, render);
  render();
}