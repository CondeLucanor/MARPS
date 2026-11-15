/**
 * MAЯPS — generates the elevation and slope images that the map shows as layers.
 * Both images cover the whole DEM in a plain latitude/longitude layout:
 *   image x: longitude from bounds.lonMin (left) to bounds.lonMax (right), east-positive.
 *   image y: latitude from bounds.latMax (top) to bounds.latMin (bottom).
 * Only REAL DEM data is drawn (no simulated micro-relief).
 * The result is generated once and cached.
 */
import { CONFIG } from './config.js';
import { getRawGrid } from './terrain.js';
import { clamp } from './utils.js';

const SLOPE_MAX_DEGREES = 30;

const ELEVATION_STOPS = [
  [0.0, [12, 24, 64]],
  [0.25, [24, 96, 140]],
  [0.5, [34, 211, 216]],
  [0.7, [190, 226, 200]],
  [0.85, [214, 170, 120]],
  [1.0, [245, 240, 235]]
];

const SLOPE_STOPS = [
  [0.0, [34, 211, 216]],
  [0.4, [242, 184, 75]],
  [1.0, [255, 107, 106]]
];

let cache = null;

function rampColor(stops, t) {
  const u = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i += 1) {
    if (u <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (u - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function legend(stops, valueAt) {
  return stops.map(([t, c]) => ({ value: Math.round(valueAt(t)), color: `rgb(${c[0]},${c[1]},${c[2]})` }));
}

/**
 * Returns { bounds, width, height, elevation: {...}, slope: {...} } or null if the terrain is not loaded.
 * The `dataUrl` fields are PNG images encoded as data URLs.
 */
export function renderTerrainLayers() {
  if (cache) return cache;
  const g = getRawGrid();
  if (!g) return null;

  const R = CONFIG.mars.radiusMeters;
  const width = CONFIG.map.layerImageWidth;
  const height = Math.round((width * g.nrows) / g.ncols);

  const elevCanvas = document.createElement('canvas');
  elevCanvas.width = width;
  elevCanvas.height = height;
  const slopeCanvas = document.createElement('canvas');
  slopeCanvas.width = width;
  slopeCanvas.height = height;

  const elevCtx = elevCanvas.getContext('2d');
  const slopeCtx = slopeCanvas.getContext('2d');
  const elevImage = elevCtx.createImageData(width, height);
  const slopeImage = slopeCtx.createImageData(width, height);

  const range = g.maxElevation - g.minElevation || 1;
  const value = (row, col) => g.data[clamp(row, 0, g.nrows - 1) * g.ncols + clamp(col, 0, g.ncols - 1)];

  for (let py = 0; py < height; py += 1) {
    const row = Math.min(g.nrows - 1, Math.floor(((py + 0.5) * g.nrows) / height));
    const latRad = (g.yll + (g.nrows - row - 0.5) * g.dy) / R;
    const cosLat = Math.max(0.05, Math.cos(latRad));

    for (let px = 0; px < width; px += 1) {
      const col = Math.min(g.ncols - 1, Math.floor(((px + 0.5) * g.ncols) / width));
      const z = value(row, col);
      const index = (py * width + px) * 4;
      if (Number.isNaN(z)) continue; // stays transparent

      const [r, gr, b] = rampColor(ELEVATION_STOPS, (z - g.minElevation) / range);
      elevImage.data[index] = r;
      elevImage.data[index + 1] = gr;
      elevImage.data[index + 2] = b;
      elevImage.data[index + 3] = 255;

      const zE = value(row, col + 1);
      const zW = value(row, col - 1);
      const zN = value(row - 1, col);
      const zS = value(row + 1, col);
      const gx = !Number.isNaN(zE) && !Number.isNaN(zW) ? (zE - zW) / (2 * g.dx * cosLat) : 0;
      const gy = !Number.isNaN(zN) && !Number.isNaN(zS) ? (zN - zS) / (2 * g.dy) : 0;
      const slopeDeg = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;

      const t = slopeDeg / SLOPE_MAX_DEGREES;
      const [sr, sg, sb] = rampColor(SLOPE_STOPS, t);
      slopeImage.data[index] = sr;
      slopeImage.data[index + 1] = sg;
      slopeImage.data[index + 2] = sb;
      slopeImage.data[index + 3] = Math.round(clamp(t * 1.6, 0, 0.85) * 255);
    }
  }

  elevCtx.putImageData(elevImage, 0, 0);
  slopeCtx.putImageData(slopeImage, 0, 0);

  cache = {
    bounds: { ...g.bounds },
    width,
    height,
    imageLayout: 'Plain latitude/longitude. Left = lonMin, right = lonMax (east-positive 0-360). Top = latMax, bottom = latMin.',
    elevation: {
      dataUrl: elevCanvas.toDataURL('image/png'),
      minElevationMeters: g.minElevation,
      maxElevationMeters: g.maxElevation,
      legend: legend(ELEVATION_STOPS, (t) => g.minElevation + t * range),
      provenance: CONFIG.provenance.realDem
    },
    slope: {
      dataUrl: slopeCanvas.toDataURL('image/png'),
      maxSlopeDegrees: SLOPE_MAX_DEGREES,
      legend: legend(SLOPE_STOPS, (t) => t * SLOPE_MAX_DEGREES),
      provenance: CONFIG.provenance.realDem
    }
  };
  return cache;
}