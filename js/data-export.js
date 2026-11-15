/**
 * MAЯPS — JSON export of a mission (Stage 9).
 * Schema: CONFIG.app.exportFormat / CONFIG.app.schemaVersion (see the top-level keys below).
 *
 *   format, schemaVersion, exportedAt
 *   mission { id, name, status, startTime, endTime, elapsedMs, landing, settings, astronautFinal, vehicleFinal }
 *   astronautPositions[], vehiclePositions[], routes[], obstacles[], environmentMeasurements[],
 *   scientificVisits[], batteryEvents[], missionEvents[]  (each event also has description and source)
 *   scientificPoints[]   (extension: the predefined points with their visited state, needed to redraw the map)
 *   simulationMetadata
 *
 * Nothing is stored automatically: the file is only created when the user presses Export.
 */
import { CONFIG } from './config.js';
import { showToast } from './ui.js';

export function buildExportObject(mission) {
  const r = mission.records;
  const a = mission.astronaut;
  const v = mission.vehicle;
  const l = mission.landing || {};

  return {
    format: CONFIG.app.exportFormat,
    schemaVersion: CONFIG.app.schemaVersion,
    exportedAt: Date.now(),
    mission: {
      id: mission.id,
      name: mission.name,
      status: mission.status,
      startTime: mission.startTime,
      endTime: mission.endTime,
      elapsedMs: mission.clock.elapsedMs,
      landing: {
        planned: l.planned,
        analysis: l.analysis,
        errorRadiusMeters: l.errorRadiusMeters,
        actual: l.actual,
        errorDistanceMeters: l.errorDistanceMeters,
        lidar: l.lidar,
        confirmed: l.confirmed
      },
      settings: { ...mission.settings },
      astronautFinal: { latitude: a.latitude, longitude: a.longitude, altitude: a.altitude, headingDegrees: a.headingDegrees },
      vehicleFinal: {
        latitude: v.latitude,
        longitude: v.longitude,
        batteryPercent: v.batteryPercent,
        distanceTravelledMeters: v.distanceTravelledMeters
      }
    },
    astronautPositions: r.astronautPositions,
    vehiclePositions: r.vehiclePositions,
    routes: r.routes,
    obstacles: mission.obstacles,
    environmentMeasurements: r.environmentMeasurements,
    scientificVisits: r.scientificVisits,
    batteryEvents: r.batteryEvents,
    missionEvents: r.missionEvents.map((e) => ({
      ...e,
      description: e.message,
      source: (e.data && e.data.source) || null
    })),
    scientificPoints: mission.scientificPoints,
    simulationMetadata: {
      dataProvenance: CONFIG.provenance.simulated,
      realData: 'Elevation: real MOLA DEM. Environment, sensors, obstacles, landing error and micro-relief: simulated.',
      coordinateSystem: CONFIG.coordinateSystem.description,
      application: CONFIG.app.name,
      timeMultiplier: mission.settings.timeMultiplier
    }
  };
}

export function downloadJson(filename, object) {
  const blob = new Blob([JSON.stringify(object)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Builds and downloads the JSON file of a mission. */
export function exportMission(mission) {
  if (!mission) return false;
  try {
    downloadJson(`MARPS_${mission.id}.json`, buildExportObject(mission));
    showToast(`Mission ${mission.id} exported.`, 'success');
    return true;
  } catch (err) {
    console.error('[MAЯPS] Export failed:', err);
    showToast('The mission could not be exported. Open the Console (F12) for details.', 'error');
    return false;
  }
}