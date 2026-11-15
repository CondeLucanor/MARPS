/**
 * MAЯPS — scientific points: predefined dataset, mission copy and automatic visits.
 *
 * The points come from data/scientific-points.json. At the start of every mission each point is copied
 * into mission.scientificPoints (with visited = false). No point is ever generated during a mission.
 *
 * A visit is registered automatically when the astronaut (or the vehicle with the astronaut inside)
 * gets within CONFIG.scientificPoints.arrivalRadiusMeters of the point. It is stored in
 * mission.records.scientificVisits, logged, and announced with EVENTS.SCIENTIFIC_POINT_VISITED.
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, missionTimestamp } from './state.js';
import { on, emit, EVENTS } from './events.js';
import { onMissionTick } from './mission-manager.js';
import { addMissionEvent } from './records.js';
import { distanceMeters, isInsideRegion } from './geodesy.js';
import { showToast } from './ui.js';
import { isFiniteNumber, deepClone } from './utils.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let dataset = null;
let loadPromise = null;

/* ------------------------------------------------------------------ data */

function normalize(raw) {
  if (!raw || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (!isFiniteNumber(raw.latitude) || !isFiniteNumber(raw.longitude)) return null;
  if (!isInsideRegion(raw.latitude, raw.longitude)) return null;
  return {
    id: raw.id,
    name: String(raw.name || raw.id).slice(0, 80),
    type: String(raw.type || 'geological-feature').slice(0, 40),
    latitude: raw.latitude,
    longitude: raw.longitude,
    description: String(raw.description || '').slice(0, 600),
    image: typeof raw.image === 'string' && raw.image.length > 0 ? raw.image : null,
    visited: false,
    visitedAt: null
  };
}

/** Loads the dataset once. Resolves with an array (empty if the file is missing or invalid). */
export function loadScientificPointData() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const response = await fetch(CONFIG.scientificPoints.file);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const list = Array.isArray(json) ? json : json.points;
      if (!Array.isArray(list)) throw new Error('unexpected format');

      const seen = new Set();
      const points = [];
      for (const raw of list) {
        const point = normalize(raw);
        if (!point || seen.has(point.id)) {
          console.warn('[MAЯPS] A scientific point was ignored (invalid, outside the region or duplicated):', raw);
          continue;
        }
        seen.add(point.id);
        points.push(point);
      }
      const sp = CONFIG.scientificPoints;
      if (sp.assignImagesByOrder) {
        points.forEach((p, i) => {
          if (i < sp.imageCount) p.image = `${sp.imageFolder}/acidalia${i + 1}.${sp.imageExtension}`;
        });
      }
      dataset = points;
    } catch (err) {
      dataset = [];
      console.error(`[MAЯPS] Could not load ${CONFIG.scientificPoints.file}: ${err.message}`);
      showToast('The scientific points could not be loaded. Check data/scientific-points.json.', 'error');
    }
    return dataset;
  })();
  return loadPromise;
}

function populate(mission) {
  if (!dataset || mission.scientificPoints.length > 0) return;
  mission.scientificPoints = dataset.map((p) => deepClone(p));
}

/** A scientific point of a mission by id, or null. */
export function getScientificPoint(mission, id) {
  return mission.scientificPoints.find((p) => p.id === id) || null;
}

/* ------------------------------------------------------------------ visits */

function onTick({ mission }) {
  if (mission.phase !== LIFECYCLE.EXPLORATION_ACTIVE) return;
  const a = mission.astronaut;
  if (!isFiniteNumber(a.latitude) || !isFiniteNumber(a.longitude)) return;

  const radius = CONFIG.scientificPoints.arrivalRadiusMeters;
  for (const point of mission.scientificPoints) {
    if (point.visited) continue;
    const distance = distanceMeters(a.latitude, a.longitude, point.latitude, point.longitude);
    if (distance > radius) continue;

    point.visited = true;
    point.visitedAt = missionTimestamp(mission);

    mission.records.scientificVisits.push({
      id: point.id,
      name: point.name,
      timestamp: point.visitedAt,
      elapsedMs: mission.clock.elapsedMs,
      latitude: point.latitude,
      longitude: point.longitude,
      astronautLatitude: a.latitude,
      astronautLongitude: a.longitude,
      distanceMeters: distance
    });

    addMissionEvent(mission, {
      type: 'SCIENTIFIC_POINT_VISITED',
      severity: 'success',
      message: `Scientific point visited: ${point.name}.`,
      latitude: point.latitude,
      longitude: point.longitude,
      data: { id: point.id, distanceMeters: distance }
    });
    emit(EVENTS.SCIENTIFIC_POINT_VISITED, { mission, point });
    showToast(`Scientific point visited: ${point.name}`, 'success');
  }
}

/* ------------------------------------------------------------------ init */

export function initScientificPoints() {
  loadScientificPointData().then(() => {
    // A mission may have started while the file was still loading.
    const mission = window.MARPS && window.MARPS.state ? window.MARPS.state.getCurrentMission() : null;
    if (mission) populate(mission);
  });

  on(EVENTS.MISSION_STARTED, ({ mission }) => {
    loadScientificPointData().then(() => populate(mission));
  });
  onMissionTick(onTick);
}