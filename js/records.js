/**
 * MAЯPS — mission records helpers.
 * All events of a mission are stored in mission.records.missionEvents. The Mission Log reads from there.
 * NOTE: event messages may contain user text (e.g. the mission name): escape them when displaying as HTML.
 */
import { missionTimestamp } from './state.js';
import { emit, EVENTS } from './events.js';

/**
 * Adds an event to the mission record and announces it.
 * severity: 'info' | 'success' | 'warning' | 'error'
 */
export function addMissionEvent(mission, { type, message, severity = 'info', latitude = null, longitude = null, data = null }) {
  mission.counters.event += 1;

  const entry = {
    id: `EVT_${String(mission.counters.event).padStart(4, '0')}`,
    timestamp: missionTimestamp(mission),
    elapsedMs: mission.clock.elapsedMs,
    type,
    severity,
    message,
    latitude,
    longitude,
    data
  };

  mission.records.missionEvents.push(entry);
  emit(EVENTS.LOG_ENTRY_ADDED, { missionId: mission.id, entry });
  return entry;
}