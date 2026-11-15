/**
 * MAЯPS — central event bus.
 * Modules never call each other to announce changes: they emit events here and any module can listen.
 */
import { CONFIG } from './config.js';

export const EVENTS = Object.freeze({
  // Mission lifecycle
  MISSION_STARTED: 'MISSION_STARTED',
  MISSION_PAUSED: 'MISSION_PAUSED',
  MISSION_RESUMED: 'MISSION_RESUMED',
  MISSION_ENDED: 'MISSION_ENDED',
  MISSION_PHASE_CHANGED: 'MISSION_PHASE_CHANGED',

  // Landing
  LANDING_SELECTED: 'LANDING_SELECTED',
  LANDING_ANALYZED: 'LANDING_ANALYZED',
  LANDING_CONFIRMED: 'LANDING_CONFIRMED',
  LIDAR_ACQUIRED: 'LIDAR_ACQUIRED',

  // Exploration
  POSITION_UPDATED: 'POSITION_UPDATED',
  VEHICLE_POSITION_UPDATED: 'VEHICLE_POSITION_UPDATED',
  DESTINATION_SELECTED: 'DESTINATION_SELECTED',
  DESTINATION_REACHED: 'DESTINATION_REACHED',
  ROUTE_UPDATED: 'ROUTE_UPDATED',
  ROUTE_RECALCULATED: 'ROUTE_RECALCULATED',
  OBSTACLE_DETECTED: 'OBSTACLE_DETECTED',
  ENVIRONMENT_UPDATED: 'ENVIRONMENT_UPDATED',
  SCIENTIFIC_POINT_VISITED: 'SCIENTIFIC_POINT_VISITED',
  VEHICLE_ENTERED: 'VEHICLE_ENTERED',
  VEHICLE_EXITED: 'VEHICLE_EXITED',
  BATTERY_UPDATED: 'BATTERY_UPDATED',

  // Application
  SECTION_CHANGED: 'SECTION_CHANGED',
  ARCHIVE_UPDATED: 'ARCHIVE_UPDATED',
  TERRAIN_LOADED: 'TERRAIN_LOADED',
  LOG_ENTRY_ADDED: 'LOG_ENTRY_ADDED'
});

const listeners = new Map();

/** Subscribes to an event. Returns a function that removes the subscription. */
export function on(eventName, handler) {
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(handler);
  return () => off(eventName, handler);
}

export function off(eventName, handler) {
  const set = listeners.get(eventName);
  if (set) set.delete(handler);
}

export function once(eventName, handler) {
  const unsubscribe = on(eventName, (payload) => {
    unsubscribe();
    handler(payload);
  });
  return unsubscribe;
}

/** Notifies all subscribers. An error in one subscriber never stops the others. */
export function emit(eventName, payload) {
  if (CONFIG.debug.logEvents) console.log(`[MAЯPS event] ${eventName}`, payload);
  const set = listeners.get(eventName);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[MAЯPS] Error in a listener of ${eventName}:`, err);
    }
  }
}