/**
 * MAЯPS — terrain: real MOLA elevation grid and terrain queries.
 *
 * DATA PROVENANCE
 *   elevation          real MOLA DEM, bilinearly resampled between cell centres.
 *   demSlopeDegrees    derived from the real DEM.
 *   microSlope/rough.  SIMULATED (the DEM is ~1.85 km per cell, too coarse for local terrain).
 *   slopeDegrees       combination of both (used by movement and landing safety).
 *
 * The grid is an ESRI ASCII grid (.asc). Header keys accepted: ncols, nrows, xllcorner/xllcenter,
 * yllcorner/yllcenter, cellsize or dx/dy, NODATA_value. Row 0 is the northernmost row.
 * Grid coordinates are in the DEM projection (see geodesy.js: latLonToDemMeters).
 */
import { CONFIG } from './config.js';
import { emit, EVENTS } from './events.js';
import { latLonToDemMeters, normalizeLongitude } from './geodesy.js';
import { clamp, lerp, degToRad, radToDeg, isFiniteNumber } from './utils.js';

const R = CONFIG.mars.radiusMeters;

let grid = null;
let status = { state: 'idle', message: '' };
let loadPromise = null;

/* ------------------------------------------------------------------ loading */

function parseAsciiGrid(text) {
  const length = text.length;
  const header = {};
  let pos = 0;

  // Header: lines of the form "key value" until the first numeric line.
  while (pos < length) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = length;
    const line = text.substring(pos, lineEnd).trim();
    if (line === '') {
      pos = lineEnd + 1;
      continue;
    }
    const match = /^([A-Za-z_]+)\s+(\S+)$/.exec(line);
    if (!match) break;
    header[match[1].toLowerCase()] = parseFloat(match[2].replace(/[\u2212\u2013\u2014]/g, '-'));
    pos = lineEnd + 1;
  }

  const ncols = header.ncols;
  const nrows = header.nrows;
  if (!Number.isInteger(ncols) || !Number.isInteger(nrows) || ncols < 2 || nrows < 2) {
    throw new Error('The terrain file header does not contain valid ncols / nrows.');
  }

  const dx = header.dx ?? header.cellsize;
  const dy = header.dy ?? header.cellsize;
  if (!(dx > 0) || !(dy > 0)) {
    throw new Error('The terrain file header has no valid cell size (cellsize or dx/dy).');
  }

  let xll = header.xllcorner;
  if (xll === undefined && header.xllcenter !== undefined) xll = header.xllcenter - dx / 2;
  let yll = header.yllcorner;
  if (yll === undefined && header.yllcenter !== undefined) yll = header.yllcenter - dy / 2;
  if (!isFiniteNumber(xll) || !isFiniteNumber(yll)) {
    throw new Error('The terrain file header has no valid xllcorner / yllcorner.');
  }

  const noData = isFiniteNumber(header.nodata_value) ? header.nodata_value : CONFIG.terrain.noDataValue;

  // The file must be the one the configuration describes.
  const t = CONFIG.terrain;
  if (ncols !== t.ncols || nrows !== t.nrows) {
    throw new Error(`Terrain size ${ncols}x${nrows} does not match CONFIG.terrain (${t.ncols}x${t.nrows}).`);
  }
  if (Math.abs(xll - t.xllcorner) > t.headerToleranceMeters || Math.abs(yll - t.yllcorner) > t.headerToleranceMeters) {
    throw new Error('Terrain corner coordinates do not match CONFIG.terrain.');
  }
  if (Math.abs(dx - t.cellSizeMeters) > 0.01 || Math.abs(dy - t.cellSizeMeters) > 0.01) {
    throw new Error('Terrain cell size does not match CONFIG.terrain.');
  }

  // Data: ncols * nrows numbers separated by whitespace.
  const total = ncols * nrows;
  const data = new Float32Array(total);
  let count = 0;
  let noDataCells = 0;
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let i = pos;

  while (i < length && count < total) {
    if (text.charCodeAt(i) <= 32) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < length && text.charCodeAt(i) > 32) i += 1;
    const value = parseFloat(text.substring(start, i));
    if (!Number.isFinite(value) || Math.abs(value - noData) < 0.5) {
      data[count] = NaN;
      noDataCells += 1;
    } else {
      data[count] = value;
      if (value < minElevation) minElevation = value;
      if (value > maxElevation) maxElevation = value;
    }
    count += 1;
  }
  if (count < total) {
    throw new Error(`The terrain file has ${count} values but ${total} were expected.`);
  }
  if (noDataCells === total) {
    throw new Error('The terrain file contains no valid elevation values.');
  }

  const round6 = (v) => Number(v.toFixed(6));
  const lonMin = normalizeLongitude(radToDeg(xll / R));
  return {
    data,
    ncols,
    nrows,
    xll,
    yll,
    dx,
    dy,
    noDataCells,
    minElevation,
    maxElevation,
    bounds: {
      latMin: round6(radToDeg(yll / R)),
      latMax: round6(radToDeg((yll + nrows * dy) / R)),
      lonMin: round6(lonMin),
      lonMax: round6(lonMin + radToDeg((ncols * dx) / R))
    }
  };
}

/**
 * Loads the terrain file once. Returns a Promise with the grid information.
 * Emits EVENTS.TERRAIN_LOADED when ready. Rejects with a readable Error if something fails.
 */
export function loadTerrain() {
  if (loadPromise) return loadPromise;
  status = { state: 'loading', message: 'Loading terrain data…' };

  loadPromise = (async () => {
    const file = CONFIG.terrain.file;
    let response;
    try {
      response = await fetch(file);
    } catch (err) {
      throw new Error(`Could not read ${file}. Run the application through a local web server (not by opening index.html directly).`);
    }
    if (!response.ok) {
      throw new Error(`${file} was not found (HTTP ${response.status}). Check that the file is in the data/ folder.`);
    }
    const text = await response.text();
    grid = parseAsciiGrid(text);
    status = { state: 'ready', message: '' };
    const info = getGridInfo();
    emit(EVENTS.TERRAIN_LOADED, info);
    return info;
  })().catch((err) => {
    grid = null;
    status = { state: 'error', message: err.message };
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

export function isTerrainLoaded() {
  return grid !== null;
}

export function getTerrainStatus() {
  return { ...status };
}

/** Information about the loaded grid (without the data array), or null. */
export function getGridInfo() {
  if (!grid) return null;
  return {
    ncols: grid.ncols,
    nrows: grid.nrows,
    cellSizeXMeters: grid.dx,
    cellSizeYMeters: grid.dy,
    bounds: { ...grid.bounds },
    minElevationMeters: grid.minElevation,
    maxElevationMeters: grid.maxElevation,
    noDataCells: grid.noDataCells
  };
}

/** Raw grid for modules that need direct access (terrain-layers.js, route planner). Do not modify. */
export function getRawGrid() {
  return grid;
}

/* ------------------------------------------------------------------ real DEM sampling */

function cellValue(row, col) {
  const r = clamp(row, 0, grid.nrows - 1);
  const c = clamp(col, 0, grid.ncols - 1);
  return grid.data[r * grid.ncols + c];
}

/** Bilinear elevation (m) at DEM coordinates (x, y), or null if outside the grid or without data. */
function sampleXY(x, y) {
  const g = grid;
  const cf = (x - g.xll) / g.dx - 0.5;
  const rf = g.nrows - (y - g.yll) / g.dy - 0.5;
  if (cf < -0.5 || cf > g.ncols - 0.5 || rf < -0.5 || rf > g.nrows - 0.5) return null;

  const c0 = Math.floor(cf);
  const r0 = Math.floor(rf);
  const fc = cf - c0;
  const fr = rf - r0;

  const corners = [
    [cellValue(r0, c0), (1 - fc) * (1 - fr)],
    [cellValue(r0, c0 + 1), fc * (1 - fr)],
    [cellValue(r0 + 1, c0), (1 - fc) * fr],
    [cellValue(r0 + 1, c0 + 1), fc * fr]
  ];

  let sum = 0;
  let weight = 0;
  for (const [value, w] of corners) {
    if (Number.isNaN(value) || w <= 0) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

/** Slope (degrees) of the real DEM at DEM coordinates (x, y). East-west distances are scaled by cos(lat). */
function demSlopeXY(x, y) {
  const g = grid;
  const zc = sampleXY(x, y);
  if (zc === null) return null;

  const latDeg = radToDeg(y / R);
  const cosLat = Math.max(0.05, Math.cos(degToRad(latDeg)));

  const gradient = (plus, minus, step) => {
    if (plus !== null && minus !== null) return (plus - minus) / (2 * step);
    if (plus !== null) return (plus - zc) / step;
    if (minus !== null) return (zc - minus) / step;
    return 0;
  };

  const gx = gradient(sampleXY(x + g.dx, y), sampleXY(x - g.dx, y), g.dx * cosLat);
  const gy = gradient(sampleXY(x, y + g.dy), sampleXY(x, y - g.dy), g.dy);
  return radToDeg(Math.atan(Math.hypot(gx, gy)));
}

/** Elevation in metres at (lat, lon), or null if the point is outside the DEM or the terrain is not loaded. */
export function getElevation(lat, lon) {
  if (!grid || !isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  const { x, y } = latLonToDemMeters(lat, lon);
  return sampleXY(x, y);
}

/** Slope in degrees of the REAL DEM at (lat, lon), or null. */
export function getDemSlopeDegrees(lat, lon) {
  if (!grid || !isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  const { x, y } = latLonToDemMeters(lat, lon);
  return demSlopeXY(x, y);
}

/* ------------------------------------------------------------------ simulated micro-relief */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(a, b, t) {
  const u = clamp((t - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

/** Deterministic 2D value noise in [0, 1] with the given wavelength (metres). */
function valueNoise(x, y, wavelength, seed) {
  const fx = x / wavelength;
  const fy = y / wavelength;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** SIMULATED local relief at DEM coordinates. The same point always gives the same result. */
function microReliefXY(x, y) {
  const cfg = CONFIG.terrainModel.microRelief;
  if (!cfg || !cfg.enabled) return { slopeDegrees: 0, roughnessMeters: 0 };

  const fine = valueNoise(x, y, cfg.wavelengthMeters[0], cfg.seed + 1);
  const coarse = valueNoise(x, y, cfg.wavelengthMeters[1], cfg.seed);
  const mask = smoothstep(0.35, 0.75, coarse); // 0 = smooth zone, 1 = rough zone
  const amplitude = lerp(cfg.extraSlopeDegrees[0], cfg.extraSlopeDegrees[1], fine);

  return {
    slopeDegrees: amplitude * mask,
    roughnessMeters: cfg.reliefScaleMeters * mask * (0.25 + 0.75 * fine)
  };
}

/** SIMULATED micro-relief at (lat, lon): { slopeDegrees, roughnessMeters }. */
export function getMicroRelief(lat, lon) {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return { slopeDegrees: 0, roughnessMeters: 0 };
  const { x, y } = latLonToDemMeters(lat, lon);
  return microReliefXY(x, y);
}

/* ------------------------------------------------------------------ combined query */

function classify(slopeDegrees) {
  if (slopeDegrees < 3) return 'plain';
  if (slopeDegrees < 8) return 'undulating';
  if (slopeDegrees < 16) return 'rough';
  return 'steep';
}

/**
 * Everything the simulation needs to know about a point.
 * Always returns an object; check `insideDem` before using the numbers.
 */
export function getTerrainAt(lat, lon) {
  const result = {
    latitude: lat,
    longitude: lon,
    insideDem: false,
    elevation: null,
    demSlopeDegrees: null,
    microSlopeDegrees: 0,
    slopeDegrees: null,
    roughnessMeters: 0,
    terrainType: 'unknown',
    provenance: {
      elevation: CONFIG.provenance.realDem,
      demSlope: CONFIG.provenance.realDem,
      microRelief: CONFIG.provenance.simulated,
      slope: `${CONFIG.provenance.realDem} + ${CONFIG.provenance.simulated}`
    }
  };

  if (!grid || !isFiniteNumber(lat) || !isFiniteNumber(lon)) return result;

  const { x, y } = latLonToDemMeters(lat, lon);
  const elevation = sampleXY(x, y);
  if (elevation === null) return result;

  const demSlope = demSlopeXY(x, y) ?? 0;
  const micro = microReliefXY(x, y);
  const slope = Math.hypot(demSlope, micro.slopeDegrees);

  result.insideDem = true;
  result.elevation = elevation;
  result.demSlopeDegrees = demSlope;
  result.microSlopeDegrees = micro.slopeDegrees;
  result.slopeDegrees = slope;
  result.roughnessMeters = micro.roughnessMeters;
  result.terrainType = classify(slope);
  return result;
}