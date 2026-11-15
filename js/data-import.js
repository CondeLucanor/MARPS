/**
 * MAЯPS — JSON import and validation (Stage 9).
 *
 * Validates: file format and schema version, mission ID, data types, timestamps and coordinates
 * (latitude -90..90, longitude 0..360). An invalid file is rejected with a clear message and nothing is
 * added. A mission whose ID already exists in this session is rejected (duplicate import).
 * Only known fields are copied into the new mission object.
 *
 *   buildMissionFromJson(json)   validates and builds a mission (does NOT register it)
 *   registerImportedMission(m)   adds it to the archive (duplicate check)
 *   importMissionFile(file)      reads a File and does all of the above; returns { ok, mission | error }
 */
import { CONFIG } from './config.js';
import { LIFECYCLE, appState, createMission } from './state.js';
import { emit, EVENTS } from './events.js';
import { isFiniteNumber as num } from './utils.js';
import { isValidCoordinate } from './geodesy.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ITEMS = 1000000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

class ImportError extends Error {}

function fail(message) {
  throw new ImportError(message);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const coordOk = (o) => isObj(o) && isValidCoordinate(o.latitude, o.longitude);
const optNum = (v) => v === null || v === undefined || num(v);
const coordNullable = (o) =>
  (o.latitude === null || o.latitude === undefined) && (o.longitude === null || o.longitude === undefined)
    ? true
    : isValidCoordinate(o.latitude, o.longitude);

function checkArray(json, key, test, required = true) {
  const list = json[key];
  if (list === undefined && !required) return [];
  if (!Array.isArray(list)) fail(`"${key}" must be a list.`);
  if (list.length > MAX_ITEMS) fail(`"${key}" has too many entries.`);
  for (let i = 0; i < list.length; i += 1) {
    if (!isObj(list[i]) || !test(list[i])) {
      fail(`"${key}" entry ${i + 1} has missing or invalid data (check timestamp, coordinates and number types).`);
    }
  }
  return list;
}

function pointOrNull(value, name, extraKeys = []) {
  if (value === null || value === undefined) return null;
  if (!coordOk(value)) fail(`landing.${name} has invalid coordinates (latitude -90..90, longitude 0..360).`);
  const out = { latitude: value.latitude, longitude: value.longitude };
  for (const k of extraKeys) {
    if (num(value[k])) out[k] = value[k];
    else if (typeof value[k] === 'string') out[k] = value[k].slice(0, 80);
  }
  return out;
}

/** Validates the JSON object and builds a mission. Throws ImportError with a readable message. */
export function buildMissionFromJson(json) {
  if (!isObj(json)) fail('The file does not contain a JSON object.');
  if (json.format !== CONFIG.app.exportFormat) {
    fail(`This is not a MAЯPS mission file (the "format" field must be "${CONFIG.app.exportFormat}").`);
  }
  if (json.schemaVersion !== CONFIG.app.schemaVersion) {
    fail(`Unsupported schema version (${String(json.schemaVersion).slice(0, 20)}). This application reads version ${CONFIG.app.schemaVersion}.`);
  }

  const m = json.mission;
  if (!isObj(m)) fail('The "mission" section is missing.');
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) fail('The mission ID is missing or invalid.');
  if (!num(m.startTime)) fail('mission.startTime must be a number.');
  if (!optNum(m.endTime)) fail('mission.endTime must be a number or null.');
  if (!num(m.elapsedMs) || m.elapsedMs < 0) fail('mission.elapsedMs must be a number of 0 or more.');
  if (!isObj(m.landing)) fail('mission.landing is missing.');

  const planned = pointOrNull(m.landing.planned, 'planned', ['elevation']);
  const actual = pointOrNull(m.landing.actual, 'actual', ['elevation']);
  const lidar = pointOrNull(m.landing.lidar, 'lidar',
    ['precisionMeters', 'estimationErrorMeters', 'acquiredAt', 'source', 'provenance']);

  const positionTest = (o) =>
    num(o.timestamp) && coordOk(o) && optNum(o.altitude) && optNum(o.headingDegrees) && optNum(o.precisionMeters);

  const astronautPositions = checkArray(json, 'astronautPositions', positionTest);
  const vehiclePositions = checkArray(json, 'vehiclePositions', (o) => num(o.timestamp) && coordOk(o) && optNum(o.altitude));
  const events = checkArray(json, 'missionEvents', (o) =>
    num(o.timestamp) && typeof o.type === 'string' &&
    (typeof o.message === 'string' || typeof o.description === 'string') && coordNullable(o));
  const environment = checkArray(json, 'environmentMeasurements', (o) =>
    num(o.timestamp) && coordOk(o) && num(o.temperatureC) && num(o.windSpeedMps) && num(o.radiationMicroSvPerHour));
  const routes = checkArray(json, 'routes', (o) =>
    num(o.timestamp) && Array.isArray(o.points) && o.points.every(coordOk));
  const obstacles = checkArray(json, 'obstacles', (o) =>
    typeof o.id === 'string' && ID_RE.test(o.id) && typeof o.type === 'string' && coordOk(o));
  const visits = checkArray(json, 'scientificVisits', (o) => typeof o.id === 'string' && num(o.timestamp));
  const battery = checkArray(json, 'batteryEvents', (o) => num(o.timestamp) && num(o.batteryPercent));
  const points = checkArray(json, 'scientificPoints', (o) =>
    typeof o.id === 'string' && ID_RE.test(o.id) && coordOk(o), false);

  const mission = createMission(m.id, typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : m.id);
  mission.status = m.status === 'ENDED' ? 'ENDED' : 'INCOMPLETE';
  mission.phase = LIFECYCLE.MISSION_ENDED;
  mission.startTime = m.startTime;
  mission.endTime = num(m.endTime) ? m.endTime : m.startTime + m.elapsedMs;
  mission.clock.elapsedMs = m.elapsedMs;
  if (isObj(m.settings) && num(m.settings.timeMultiplier)) mission.settings.timeMultiplier = m.settings.timeMultiplier;

  const analysis = isObj(m.landing.analysis) ? m.landing.analysis : null;
  mission.landing = {
    planned,
    analysis: analysis ? {
      score: num(analysis.score) ? analysis.score : null,
      classification: typeof analysis.classification === 'string' ? analysis.classification.slice(0, 20) : null,
      elevationMeters: num(analysis.elevationMeters) ? analysis.elevationMeters : null,
      slopeDegrees: num(analysis.slopeDegrees) ? analysis.slopeDegrees : null
    } : null,
    errorRadiusMeters: num(m.landing.errorRadiusMeters) ? m.landing.errorRadiusMeters : null,
    actual,
    errorDistanceMeters: num(m.landing.errorDistanceMeters) ? m.landing.errorDistanceMeters : null,
    lidar,
    confirmed: m.landing.confirmed === true
  };

  const af = isObj(m.astronautFinal) ? m.astronautFinal : {};
  if (num(af.latitude) && num(af.longitude)) {
    mission.astronaut.latitude = af.latitude;
    mission.astronaut.longitude = af.longitude;
  }
  const vf = isObj(m.vehicleFinal) ? m.vehicleFinal : {};
  if (num(vf.latitude) && num(vf.longitude)) {
    mission.vehicle.latitude = vf.latitude;
    mission.vehicle.longitude = vf.longitude;
  }
  if (num(vf.batteryPercent)) mission.vehicle.batteryPercent = vf.batteryPercent;
  if (num(vf.distanceTravelledMeters)) mission.vehicle.distanceTravelledMeters = vf.distanceTravelledMeters;

  mission.obstacles = obstacles;
  mission.scientificPoints = points;
  mission.records = {
    astronautPositions,
    vehiclePositions,
    environmentMeasurements: environment,
    missionEvents: events
      .map((e, i) => ({
        id: typeof e.id === 'string' ? e.id.slice(0, 20) : `EVT_${String(i + 1).padStart(4, '0')}`,
        timestamp: e.timestamp,
        elapsedMs: num(e.elapsedMs) ? e.elapsedMs : e.timestamp - mission.startTime,
        type: String(e.type).slice(0, 60),
        severity: SEVERITIES.has(e.severity) ? e.severity : 'info',
        message: String(e.message ?? e.description).slice(0, 500),
        latitude: num(e.latitude) ? e.latitude : null,
        longitude: num(e.longitude) ? e.longitude : null,
        data: isObj(e.data) ? e.data : null
      }))
      .sort((a, b) => a.timestamp - b.timestamp),
    routes,
    batteryEvents: battery,
    scientificVisits: visits
  };
  mission.counters = { event: mission.records.missionEvents.length, route: routes.length };
  mission.imported = true;
  return mission;
}

/** Adds a built mission to the session archive. Throws ImportError if the ID already exists. */
export function registerImportedMission(mission) {
  const duplicate = appState.missions.some((x) => x.id === mission.id) ||
    (appState.currentMission && appState.currentMission.id === mission.id);
  if (duplicate) fail(`A mission with ID ${mission.id} already exists in this session. It was not imported again.`);
  appState.missions.push(mission);
  emit(EVENTS.ARCHIVE_UPDATED, { missions: appState.missions });
}

/** Reads, validates and registers a JSON file. Returns { ok: true, mission } or { ok: false, error }. */
export async function importMissionFile(file) {
  try {
    if (!file) fail('No file selected.');
    if (file.size > MAX_FILE_BYTES) fail('The file is too large (limit 100 MB).');
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch (err) {
      fail('The file is not valid JSON.');
    }
    const mission = buildMissionFromJson(json);
    registerImportedMission(mission);
    return { ok: true, mission };
  } catch (err) {
    if (err instanceof ImportError) return { ok: false, error: err.message };
    console.error('[MAЯPS] Import failed:', err);
    return { ok: false, error: 'The file could not be read. Open the Console (F12) for details.' };
  }
}