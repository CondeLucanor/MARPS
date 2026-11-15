/**
 * MAЯPS — simulation loop.
 * Runs a fixed-step loop on top of requestAnimationFrame.
 *   onSimStep(fn):  fn(realDtSeconds) is called at a fixed rate (CONFIG.simulation.fixedStepSeconds).
 *   onFrame(fn):    fn(realDtSeconds) is called once per drawn frame (use it for display updates).
 * This module knows nothing about missions or time multipliers: mission-manager.js applies them.
 * When the browser tab is hidden the browser stops the loop, so the simulation also stops.
 */
import { CONFIG } from './config.js';

const stepCallbacks = new Set();
const frameCallbacks = new Set();

let started = false;
let lastTimestamp = null;
let accumulator = 0;

export function onSimStep(fn) {
  stepCallbacks.add(fn);
  return () => stepCallbacks.delete(fn);
}

export function onFrame(fn) {
  frameCallbacks.add(fn);
  return () => frameCallbacks.delete(fn);
}

function runCallbacks(set, dt) {
  for (const fn of [...set]) {
    try {
      fn(dt);
    } catch (err) {
      console.error('[MAЯPS] Error in the simulation loop:', err);
    }
  }
}

function frame(timestamp) {
  requestAnimationFrame(frame);

  if (lastTimestamp === null) lastTimestamp = timestamp;
  let dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;
  dt = Math.min(Math.max(dt, 0), CONFIG.simulation.maxFrameSeconds);

  const step = CONFIG.simulation.fixedStepSeconds;
  accumulator += dt;

  let steps = 0;
  while (accumulator >= step && steps < CONFIG.simulation.maxStepsPerFrame) {
    runCallbacks(stepCallbacks, step);
    accumulator -= step;
    steps += 1;
  }
  // If the step limit was reached, discard the backlog instead of trying to catch up.
  if (steps >= CONFIG.simulation.maxStepsPerFrame) accumulator = 0;

  runCallbacks(frameCallbacks, dt);
}

export function startSimulationLoop() {
  if (started) return;
  started = true;
  requestAnimationFrame(frame);
}