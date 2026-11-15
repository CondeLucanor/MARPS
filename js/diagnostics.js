/**
 * MAЯPS — diagnostics (Stage 10). FOR TESTING ONLY, from the browser Console:
 *   MARPS.diagnostics.runChecks()          checks the current mission (or pass a mission)
 * It does not change anything: the export/import round trip builds a copy in memory and does not register it.
 */
import { CONFIG } from './config.js';
import { appState, getCurrentMission } from './state.js';
import { buildExportObject } from './data-export.js';
import { buildMissionFromJson } from './data-import.js';
import { distanceMeters } from './geodesy.js';

function intervals(list) {
  const out = [];
  for (let i = 1; i < list.length; i += 1) out.push(list[i].elapsedMs - list[i - 1].elapsedMs);
  return out;
}

export function runChecks(mission = getCurrentMission() || appState.missions[appState.missions.length - 1]) {
  if (!mission) {
    console.warn('[MAЯPS] There is no mission to check.');
    return [];
  }
  const r = mission.records;
  const results = [];
  const add = (test, ok, detail) => results.push({ test, result: ok === null ? 'n/a' : ok ? 'OK' : 'FAIL', detail });

  // 1. Chronological events.
  const ordered = r.missionEvents.every((e, i) => i === 0 || e.timestamp >= r.missionEvents[i - 1].timestamp);
  add('Events in chronological order', ordered, `${r.missionEvents.length} events`);

  // 2. Position interval (5 s).
  const want = CONFIG.log.positionIntervalSeconds * 1000;
  const pi = intervals(r.astronautPositions);
  if (pi.length) {
    const worst = Math.max(...pi.map((d) => Math.abs(d - want)));
    add(`Astronaut positions every ${CONFIG.log.positionIntervalSeconds} s`, worst <= 2, `${r.astronautPositions.length} records, worst deviation ${Math.round(worst)} ms`);
  } else add('Astronaut positions every 5 s', null, 'not enough records');

  // 3. Environment interval (30 s, within one simulation step).
  const ei = intervals(r.environmentMeasurements);
  if (ei.length) {
    const step = CONFIG.simulation.fixedStepSeconds * mission.settings.timeMultiplier * 1000;
    const wantEnv = CONFIG.environment.updateIntervalSeconds * 1000;
    const ok = ei.every((d) => d >= wantEnv - 1 && d <= wantEnv + step + 1);
    add(`Environment every ${CONFIG.environment.updateIntervalSeconds} s`, ok, `${r.environmentMeasurements.length} records, min ${Math.min(...ei)} ms, max ${Math.max(...ei)} ms`);
  } else add('Environment every 30 s', null, 'not enough records');

  // 4. Landing error inside the radius.
  const l = mission.landing;
  if (l.planned && l.actual && Number.isFinite(l.errorRadiusMeters)) {
    const d = distanceMeters(l.planned.latitude, l.planned.longitude, l.actual.latitude, l.actual.longitude);
    add('Actual landing inside the error radius', d <= l.errorRadiusMeters + 1, `${Math.round(d)} m of ${l.errorRadiusMeters} m`);
  } else add('Actual landing inside the error radius', null, 'no landing data');

  // 5. Consistency between records.
  const visited = mission.scientificPoints.filter((p) => p.visited).length;
  add('Scientific visits match visited points', visited === r.scientificVisits.length, `${visited} visited, ${r.scientificVisits.length} records`);
  const detected = mission.obstacles.filter((o) => o.known !== true && o.detected).length;
  const detectedEvents = r.missionEvents.filter((e) => e.type === 'OBSTACLE_DETECTED').length;
  add('Detected obstacles match logged events', detected === detectedEvents, `${detected} detected, ${detectedEvents} events`);

  // 6. Export -> import round trip (in memory, not registered).
  try {
    const copy = buildMissionFromJson(JSON.parse(JSON.stringify(buildExportObject(mission))));
    const same = ['astronautPositions', 'vehiclePositions', 'routes', 'environmentMeasurements', 'scientificVisits', 'batteryEvents', 'missionEvents']
      .every((k) => copy.records[k].length === r[k].length);
    const sameLanding = JSON.stringify(copy.landing.actual) === JSON.stringify(l.actual && { latitude: l.actual.latitude, longitude: l.actual.longitude, elevation: l.actual.elevation });
    add('Export → import reproduces the records', same && copy.obstacles.length === mission.obstacles.length, 'record counts compared');
    add('Export → import reproduces the landing', sameLanding || !l.actual, 'actual landing compared');
  } catch (err) {
    add('Export → import round trip', false, err.message);
  }

  console.table(results);
  return results;
}