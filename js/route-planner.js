/**
 * MAЯPS — route planner: A* over a terrain grid.
 *
 * planRoutes({ from, to, profile, obstacles }) returns up to three routes:
 *   1. Recommended: the lowest-cost route found by A*.
 *   2. Alternatives 1 and 2: A* again after raising the cost of the cells around the previous routes
 *      (CONFIG.routePlanning.alternatives). An alternative is accepted only if at least
 *      minDifferenceRatio of its cells lie outside the corridor of every previous route.
 *
 * The grid is a window around the start and the destination. Each cell stores elevation, slope, speed and
 * whether it is blocked. The cost of a step combines distance, slope, elevation change, mobility
 * (slow terrain), known/detected hazards and the penalty of previous routes (weights in config.js).
 * A cell is blocked by: slopes above the profile limit, the edge of the DEM or the study region, and
 * obstacles that the profile cannot cross. Only obstacles that are KNOWN or ALREADY DETECTED are used:
 * hidden obstacles are unknown to the planner (that is why detecting one can force a recalculation).
 *
 * SIMULATION NOTES
 *   - Terrain slope uses the real MOLA grid plus SIMULATED micro-relief (see terrain.js).
 *   - Obstacles are drawn on the grid as circles of radius max(physical radius, avoid radius of its type),
 *     marking every cell that touches the circle. An obstacle that contains the start or the destination
 *     is not blocking (it is only expensive), so you can always leave and arrive.
 *   - The route is straightened (line of sight) and sampled every 40 m or more.
 *
 * evaluateRoute(points, options) measures an existing route against the current obstacles.
 * Each route has: label, recommended, points[{latitude,longitude}], distanceMeters, timeSeconds, safetyScore,
 * scores{slope,obstacles,hazards}, meanSlopeDegrees, maxSlopeDegrees, minClearanceMeters, cost,
 * cumulativeDistance[], cumulativeTime[] (aligned with points).
 */
import { CONFIG } from './config.js';
import { getTerrainAt } from './terrain.js';
import { distanceMeters, toLocalMeters, fromLocalMeters, isInsideRegion } from './geodesy.js';
import { classifySlope, getSpeedMetersPerSecond } from './astronaut.js';
import { clamp, isFiniteNumber } from './utils.js';

const SQRT2 = Math.SQRT2;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const SAFE_CLEARANCE_METERS = 300;       // obstacle clearance that gives the full obstacle score
const HAZARD_NEAR_MARGIN_METERS = 500;   // "near a hazard" = within its radius plus this margin
const MIN_POINT_SPACING_METERS = 40;
const MAX_ROUTE_POINTS = 3000;
const MAX_LOOKAHEAD_CELLS = 60;
const MIN_CORRIDOR_CELLS = 2;
const MAX_ATTEMPTS_PER_ROUTE = 2;

/* ------------------------------------------------------------------ obstacles */

function isVisible(o) {
  return Boolean(o) && (o.known === true || o.detected === true);
}

function obstacleBlocks(o, profile) {
  const type = CONFIG.obstacleTypes[o.type];
  if (type && type.blockingMode === 'height') {
    const height = isFiniteNumber(o.heightMeters) ? o.heightMeters : type.defaultHeightMeters;
    return height > profile.obstacleClearanceMeters;
  }
  return true;
}

function exclusionRadius(o) {
  const type = CONFIG.obstacleTypes[o.type];
  const physical = isFiniteNumber(o.radiusMeters) ? o.radiusMeters : 0;
  const avoid = type && isFiniteNumber(type.avoidRadiusMeters) ? type.avoidRadiusMeters : 0;
  return Math.max(physical, avoid, 1);
}

function prepareObstacles(obstacles, profile) {
  const list = [];
  for (const o of obstacles || []) {
    if (!isVisible(o) || !isFiniteNumber(o.latitude) || !isFiniteNumber(o.longitude)) continue;
    list.push({
      o,
      exclusion: exclusionRadius(o),
      radius: isFiniteNumber(o.radiusMeters) ? o.radiusMeters : 0,
      blocks: obstacleBlocks(o, profile),
      hazardLike: o.type === 'hazard-zone' || o.type === 'crater'
    });
  }
  return list;
}

/* ------------------------------------------------------------------ grid */

function validPoint(p) {
  return Boolean(p) && isFiniteNumber(p.latitude) && isFiniteNumber(p.longitude);
}

function buildGrid(from, to, profileKey, obstacles) {
  const rp = CONFIG.routePlanning;
  const profile = CONFIG.movement.profiles[profileKey];

  const straight = distanceMeters(from.latitude, from.longitude, to.latitude, to.longitude);
  const originLat = (from.latitude + to.latitude) / 2;
  const originLon = (from.longitude + to.longitude) / 2;
  const f = toLocalMeters(from.latitude, from.longitude, originLat, originLon);
  const t = toLocalMeters(to.latitude, to.longitude, originLat, originLon);

  const margin = clamp(0.5 * straight + 2000, 3000, rp.windowMarginMeters);
  const minX = Math.min(f.x, t.x) - margin;
  const maxX = Math.max(f.x, t.x) + margin;
  const minY = Math.min(f.y, t.y) - margin;
  const maxY = Math.max(f.y, t.y) + margin;
  const width = maxX - minX;
  const height = maxY - minY;

  // The cell grows only if the window would have more cells than allowed.
  const cell = Math.max(rp.cellSizeMeters, Math.sqrt((width * height) / rp.maxWindowCells));
  const nx = Math.ceil(width / cell) + 1;
  const ny = Math.ceil(height / cell) + 1;
  const n = nx * ny;

  const blocked = new Uint8Array(n);
  const slope = new Float32Array(n);
  const elev = new Float32Array(n);
  const speed = new Float32Array(n);
  const hazard = new Float32Array(n);

  for (let j = 0; j < ny; j += 1) {
    const y = minY + (j + 0.5) * cell;
    for (let i = 0; i < nx; i += 1) {
      const x = minX + (i + 0.5) * cell;
      const idx = j * nx + i;
      const ll = fromLocalMeters(x, y, originLat, originLon);

      if (!isInsideRegion(ll.latitude, ll.longitude)) {
        blocked[idx] = 1;
        continue;
      }
      const terrain = getTerrainAt(ll.latitude, ll.longitude);
      if (!terrain.insideDem) {
        blocked[idx] = 1;
        continue;
      }
      elev[idx] = terrain.elevation;
      slope[idx] = terrain.slopeDegrees;
      if (classifySlope(terrain.slopeDegrees, profileKey) === 'impassable') blocked[idx] = 1;
      speed[idx] = getSpeedMetersPerSecond(terrain.slopeDegrees, profileKey);
    }
  }

  const startI = clamp(Math.floor((f.x - minX) / cell), 0, nx - 1);
  const startJ = clamp(Math.floor((f.y - minY) / cell), 0, ny - 1);
  const goalI = clamp(Math.floor((t.x - minX) / cell), 0, nx - 1);
  const goalJ = clamp(Math.floor((t.y - minY) / cell), 0, ny - 1);
  const startIdx = startJ * nx + startI;
  const goalIdx = goalJ * nx + goalI;

  // Obstacles: every cell touched by the exclusion circle is blocked (or only expensive).
  const w = rp.weights;
  for (const entry of prepareObstacles(obstacles, profile)) {
    const p = toLocalMeters(entry.o.latitude, entry.o.longitude, originLat, originLon);
    const excl = entry.exclusion;
    const containsEndpoint =
      Math.hypot(p.x - f.x, p.y - f.y) < excl || Math.hypot(p.x - t.x, p.y - t.y) < excl;
    const weight = entry.o.known === true ? w.knownHazard : w.detectedObstacle;

    const i0 = clamp(Math.floor((p.x - excl - minX) / cell), 0, nx - 1);
    const i1 = clamp(Math.floor((p.x + excl - minX) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((p.y - excl - minY) / cell), 0, ny - 1);
    const j1 = clamp(Math.floor((p.y + excl - minY) / cell), 0, ny - 1);

    for (let j = j0; j <= j1; j += 1) {
      const cy = minY + (j + 0.5) * cell;
      const dy = Math.max(Math.abs(p.y - cy) - cell / 2, 0);
      for (let i = i0; i <= i1; i += 1) {
        const cx = minX + (i + 0.5) * cell;
        const dx = Math.max(Math.abs(p.x - cx) - cell / 2, 0);
        if (Math.hypot(dx, dy) > excl) continue;
        const idx = j * nx + i;
        if (entry.blocks && !containsEndpoint) blocked[idx] = 1;
        else if (weight > hazard[idx]) hazard[idx] = weight;
      }
    }
  }

  // The start and the destination can always be left / reached.
  blocked[startIdx] = 0;
  blocked[goalIdx] = 0;

  return {
    nx, ny, n, cell, minX, minY, originLat, originLon,
    fx: f.x, fy: f.y, tx: t.x, ty: t.y,
    startIdx, goalIdx, blocked, slope, elev, speed, hazard, profile, straight
  };
}

/* ------------------------------------------------------------------ A* */

function createHeap() {
  const keys = [];
  const vals = [];
  return {
    size() {
      return keys.length;
    },
    push(key, val) {
      let i = keys.length;
      keys.push(key);
      vals.push(val);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent] <= key) break;
        keys[i] = keys[parent];
        vals[i] = vals[parent];
        i = parent;
      }
      keys[i] = key;
      vals[i] = val;
    },
    pop() {
      const top = vals[0];
      const lastKey = keys.pop();
      const lastVal = vals.pop();
      const n = keys.length;
      if (n > 0) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && keys[c + 1] < keys[c]) c += 1;
          if (keys[c] >= lastKey) break;
          keys[i] = keys[c];
          vals[i] = vals[c];
          i = c;
        }
        keys[i] = lastKey;
        vals[i] = lastVal;
      }
      return top;
    }
  };
}

function runAStar(grid, penalty) {
  const { nx, ny, n, cell, blocked, slope, elev, speed, hazard, startIdx, goalIdx, profile } = grid;
  const w = CONFIG.routePlanning.weights;
  const normalSpeed = profile.speedsMetersPerSecond.normal;
  const maxSlope = profile.maxSlopeDegrees;

  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const goalI = goalIdx % nx;
  const goalJ = (goalIdx - goalI) / nx;
  const heuristic = (i, j) => {
    const dx = Math.abs(i - goalI);
    const dy = Math.abs(j - goalJ);
    return w.distance * cell * (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy));
  };

  const heap = createHeap();
  g[startIdx] = 0;
  heap.push(heuristic(startIdx % nx, Math.floor(startIdx / nx)), startIdx);

  while (heap.size() > 0) {
    const idx = heap.pop();
    if (closed[idx]) continue;
    closed[idx] = 1;
    if (idx === goalIdx) break;

    const i = idx % nx;
    const j = (idx - i) / nx;

    for (const [di, dj] of NEIGHBORS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nidx = nj * nx + ni;
      if (blocked[nidx] || closed[nidx]) continue;

      const diagonal = di !== 0 && dj !== 0;
      if (diagonal && (blocked[j * nx + ni] || blocked[nj * nx + i])) continue;   // no squeezing between obstacles

      const dist = diagonal ? cell * SQRT2 : cell;
      const ratio = (slope[idx] + slope[nidx]) / 2 / maxSlope;
      const cost =
        w.distance * dist +
        w.slope * dist * ratio * ratio +
        w.elevationChange * Math.abs(elev[nidx] - elev[idx]) +
        w.mobilityPenalty * dist * Math.max(0, 1 - speed[nidx] / normalSpeed) +
        (hazard[nidx] + penalty[nidx]) * dist;

      const tentative = g[idx] + cost;
      if (tentative < g[nidx]) {
        g[nidx] = tentative;
        parent[nidx] = idx;
        heap.push(tentative + heuristic(ni, nj), nidx);
      }
    }
  }

  if (!Number.isFinite(g[goalIdx])) return null;

  const path = [];
  for (let cur = goalIdx; cur !== -1; cur = parent[cur]) path.push(cur);
  path.reverse();
  return { path, cost: g[goalIdx] };
}

/* ------------------------------------------------------------------ alternatives */

function corridorMask(grid, path, corridorMeters) {
  const { nx, ny, n, cell } = grid;
  const r = Math.max(MIN_CORRIDOR_CELLS, Math.ceil(corridorMeters / cell));
  const mask = new Uint8Array(n);
  for (const idx of path) {
    const i = idx % nx;
    const j = (idx - i) / nx;
    for (let dj = -r; dj <= r; dj += 1) {
      const nj = j + dj;
      if (nj < 0 || nj >= ny) continue;
      for (let di = -r; di <= r; di += 1) {
        const ni = i + di;
        if (ni < 0 || ni >= nx || di * di + dj * dj > r * r) continue;
        mask[nj * nx + ni] = 1;
      }
    }
  }
  return mask;
}

function outsideFraction(path, mask) {
  let outside = 0;
  for (const idx of path) if (!mask[idx]) outside += 1;
  return outside / path.length;
}

function addPenalty(penalty, mask, factor) {
  for (let k = 0; k < mask.length; k += 1) if (mask[k]) penalty[k] += factor;
}

/* ------------------------------------------------------------------ path to points */

function lineClear(grid, a, b, penalty) {
  const { nx, blocked, hazard } = grid;
  const dx = b.i - a.i;
  const dy = b.j - a.j;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
  const ia = a.j * nx + a.i;
  const ib = b.j * nx + b.i;
  const limit = Math.max(hazard[ia] + penalty[ia], hazard[ib] + penalty[ib]) + 1e-6;
  for (let s = 1; s < steps; s += 1) {
    const t = s / steps;
    const c = Math.round(a.j + dy * t) * nx + Math.round(a.i + dx * t);
    if (blocked[c] || hazard[c] + penalty[c] > limit) return false;
  }
  return true;
}

/** Removes the staircase of the grid path: keeps only the cells that a straight line cannot skip. */
function smoothPath(grid, path, penalty) {
  const { nx } = grid;
  const cells = path.map((idx) => ({ i: idx % nx, j: Math.floor(idx / nx) }));
  const kept = [0];
  let current = 0;
  while (current < cells.length - 1) {
    let next = current + 1;
    for (let k = Math.min(cells.length - 1, current + MAX_LOOKAHEAD_CELLS); k > current + 1; k -= 1) {
      if (lineClear(grid, cells[current], cells[k], penalty)) {
        next = k;
        break;
      }
    }
    kept.push(next);
    current = next;
  }
  return kept.map((k) => path[k]);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function buildPoints(grid, idxPath, from, to) {
  const local = [{ x: grid.fx, y: grid.fy }];
  for (let k = 1; k < idxPath.length - 1; k += 1) {
    const idx = idxPath[k];
    const i = idx % grid.nx;
    const j = (idx - i) / grid.nx;
    local.push({ x: grid.minX + (i + 0.5) * grid.cell, y: grid.minY + (j + 0.5) * grid.cell });
  }
  local.push({ x: grid.tx, y: grid.ty });

  let length = 0;
  for (let k = 1; k < local.length; k += 1) {
    length += Math.hypot(local[k].x - local[k - 1].x, local[k].y - local[k - 1].y);
  }
  const spacing = Math.max(MIN_POINT_SPACING_METERS, length / MAX_ROUTE_POINTS);

  const points = [{ latitude: from.latitude, longitude: from.longitude }];
  for (let k = 1; k < local.length; k += 1) {
    const a = local[k - 1];
    const b = local[k];
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(segment / spacing));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const ll = fromLocalMeters(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, grid.originLat, grid.originLon);
      points.push({ latitude: round6(ll.latitude), longitude: round6(ll.longitude) });
    }
  }
  points[points.length - 1] = { latitude: to.latitude, longitude: to.longitude };
  return points;
}

/* ------------------------------------------------------------------ route evaluation */

function measureRoute(points, profileKey, obstacles) {
  const profile = CONFIG.movement.profiles[profileKey];
  const rp = CONFIG.routePlanning;
  const prepared = prepareObstacles(obstacles, profile);

  const cumulativeDistance = [0];
  const cumulativeTime = [0];
  let distance = 0;
  let time = 0;
  let slopeSum = 0;
  let maxSlope = 0;
  let nearHazardLength = 0;
  let minClearance = Infinity;
  let blockedBy = null;

  const checkPoint = (p) => {
    for (const e of prepared) {
      const d = distanceMeters(p.latitude, p.longitude, e.o.latitude, e.o.longitude);
      const clearance = d - e.radius;
      if (clearance < minClearance) minClearance = clearance;
      if (e.blocks && d < e.exclusion && blockedBy === null) blockedBy = e.o.id;
    }
  };

  checkPoint(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const d = distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
    const midLat = (a.latitude + b.latitude) / 2;
    const midLon = (a.longitude + b.longitude) / 2;

    const terrain = getTerrainAt(midLat, midLon);
    const slopeDeg = terrain.insideDem ? terrain.slopeDegrees : 0;
    let speed = getSpeedMetersPerSecond(slopeDeg, profileKey);
    if (speed <= 0) speed = profile.speedsMetersPerSecond.verySlow;

    distance += d;
    time += d / speed;
    slopeSum += slopeDeg * d;
    if (slopeDeg > maxSlope) maxSlope = slopeDeg;

    for (const e of prepared) {
      if (!e.hazardLike) continue;
      const dm = distanceMeters(midLat, midLon, e.o.latitude, e.o.longitude);
      if (dm < e.exclusion + HAZARD_NEAR_MARGIN_METERS) {
        nearHazardLength += d;
        break;
      }
    }
    checkPoint(b);
    cumulativeDistance.push(Math.round(distance * 10) / 10);
    cumulativeTime.push(Math.round(time * 10) / 10);
  }

  const meanSlope = distance > 0 ? slopeSum / distance : 0;
  const slopeScore = 100 * (1 - clamp(0.5 * (meanSlope / profile.maxSlopeDegrees) + 0.5 * (maxSlope / profile.maxSlopeDegrees), 0, 1));
  const obstacleScore = prepared.length > 0 ? 100 * clamp(minClearance / SAFE_CLEARANCE_METERS, 0, 1) : 100;
  const hazardScore = 100 * (1 - (distance > 0 ? clamp(nearHazardLength / distance, 0, 1) : 0));

  const sw = rp.safetyWeights;
  const totalWeight = sw.slope + sw.obstacles + sw.hazards || 1;
  const safetyScore = Math.round((sw.slope * slopeScore + sw.obstacles * obstacleScore + sw.hazards * hazardScore) / totalWeight);

  return {
    distanceMeters: distance,
    timeSeconds: time,
    safetyScore,
    scores: { slope: Math.round(slopeScore), obstacles: Math.round(obstacleScore), hazards: Math.round(hazardScore) },
    meanSlopeDegrees: meanSlope,
    maxSlopeDegrees: maxSlope,
    minClearanceMeters: Number.isFinite(minClearance) ? minClearance : null,
    blocked: blockedBy !== null,
    blockedBy,
    cumulativeDistance,
    cumulativeTime
  };
}

/**
 * Measures an existing route (array of {latitude, longitude}) against the current obstacles.
 * `blocked` is true if it crosses an obstacle that the profile cannot cross (the route is no longer suitable).
 */
export function evaluateRoute(points, { profile = 'astronaut', obstacles = [] } = {}) {
  if (!Array.isArray(points) || points.length < 2 || !CONFIG.movement.profiles[profile]) return null;
  return measureRoute(points, profile, obstacles);
}

/* ------------------------------------------------------------------ main entry point */

/**
 * Plans the recommended route and up to CONFIG.routePlanning.alternatives.count alternatives.
 * Returns { routes, error, cellSizeMeters, cells, computeMs }. `routes` is empty if there is no route
 * (then `error` explains why). If fewer than three valid routes exist, only those are returned.
 */
export function planRoutes({ from, to, profile = 'astronaut', obstacles = [] } = {}) {
  const started = performance.now();
  const fail = (message) => ({
    routes: [],
    error: message,
    cellSizeMeters: null,
    cells: 0,
    computeMs: Math.round(performance.now() - started)
  });

  if (!validPoint(from) || !validPoint(to)) return fail('Invalid start or destination.');
  if (!CONFIG.movement.profiles[profile]) return fail(`Unknown mobility profile: ${profile}`);
  if (!isInsideRegion(from.latitude, from.longitude) || !isInsideRegion(to.latitude, to.longitude)) {
    return fail('The start or the destination is outside the study region.');
  }

  const grid = buildGrid(from, to, profile, obstacles);
  const rp = CONFIG.routePlanning;
  const alt = rp.alternatives;
  const penalty = new Float32Array(grid.n);
  const corridorMeters = clamp(0.12 * grid.straight, 2 * grid.cell, alt.corridorMeters);
  const maxRoutes = 1 + Math.max(0, alt.count);

  const routes = [];
  const masks = [];

  for (let k = 0; k < maxRoutes; k += 1) {
    let accepted = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ROUTE && !accepted; attempt += 1) {
      const run = runAStar(grid, penalty);
      if (!run) break;

      const mask = corridorMask(grid, run.path, corridorMeters);
      if (k > 0) {
        const different = masks.every((m) => outsideFraction(run.path, m) >= alt.minDifferenceRatio);
        if (!different) {
          addPenalty(penalty, mask, alt.penaltyFactor);   // push the next attempt further away
          continue;
        }
      }

      const smoothed = smoothPath(grid, run.path, penalty);
      const points = buildPoints(grid, smoothed, from, to);
      const measured = measureRoute(points, profile, obstacles);
      routes.push({
        label: k === 0 ? 'Recommended Route' : `Alternative Route ${k}`,
        recommended: k === 0,
        points,
        cost: run.cost,
        ...measured
      });
      masks.push(mask);
      addPenalty(penalty, mask, alt.penaltyFactor);
      accepted = true;
    }
    if (!accepted) break;
  }

  if (routes.length === 0) {
    return fail('No traversable route was found. The destination may be surrounded by obstacles or steep terrain.');
  }
  return {
    routes,
    error: null,
    cellSizeMeters: grid.cell,
    cells: grid.n,
    computeMs: Math.round(performance.now() - started)
  };
}