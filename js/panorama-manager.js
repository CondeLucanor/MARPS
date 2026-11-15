/**
 * MAЯPS — panorama manager: loads the Mars panoramas and draws the first-person background.
 *
 * VISUAL APPROXIMATIONS (this is not a 3D environment):
 *   1. The panoramas are NOT full 360 degree images. Each one is repeated and mirrored so the view can
 *      turn through the full circle without a gap. The number of repetitions is always even, so the
 *      scenery for a given compass heading is always the same.
 *   2. The image shown depends on the geographic position: the nearest zone of CONFIG.panoramas.zones.
 *      Near the boundary of two zones the two images are cross-faded (CONFIG.panoramas.blendWidthMeters).
 *   3. Moving forward is shown with a continuous zoom: the image grows slowly while you advance and is
 *      cross-faded with a smaller copy, so it never jumps. Moving backward plays it in reverse.
 *   4. Looking up or down moves the image. Beyond its edge, the average colour of that edge is used.
 *
 * Uses CONFIG.panoramas: horizontalFovDegrees, blendWidthMeters, zones[].
 * Optional: CONFIG.panoramas.zoomCycleMeters (default 200).
 */
import { CONFIG } from './config.js';
import { distanceMeters } from './geodesy.js';
import { clamp } from './utils.js';

const FORWARD_ZOOM = 1.25;          // image scale reached at the end of one forward-movement cycle
const MIN_VERTICAL_COVER = 1.1;     // the drawn image is at least 10 % taller than the screen
const DEFAULT_ZOOM_CYCLE_METERS = 200;
const MAX_TILES = 8;                // an even number

const zones = [];
let loadPromise = null;

/* ------------------------------------------------------------------ loading */

function averageColor(imageData) {
  const d = imageData.data;
  let r = 0;
  let g = 0;
  let b = 0;
  const count = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  return `rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`;
}

/** Average colour of the top and bottom edge of the image, used to extend it when looking up or down. */
function sampleEdgeColors(zone) {
  try {
    const img = zone.img;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 1;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    const band = Math.max(1, Math.round(img.naturalHeight * 0.04));

    c.drawImage(img, 0, 0, img.naturalWidth, band, 0, 0, 32, 1);
    zone.topColor = averageColor(c.getImageData(0, 0, 32, 1));

    c.clearRect(0, 0, 32, 1);
    c.drawImage(img, 0, img.naturalHeight - band, img.naturalWidth, band, 0, 0, 32, 1);
    zone.bottomColor = averageColor(c.getImageData(0, 0, 32, 1));
  } catch (err) {
    // The default colours are kept.
  }
}

/** Starts loading every panorama (once). Missing images are skipped, not fatal. */
export function loadPanoramas() {
  if (loadPromise) return loadPromise;
  const configured = Array.isArray(CONFIG.panoramas.zones) ? CONFIG.panoramas.zones : [];

  loadPromise = Promise.all(
    configured.map((cfg) => new Promise((resolve) => {
      const zone = { ...cfg, img: null, loaded: false, failed: false, topColor: '#6b4a35', bottomColor: '#3b2a20' };
      zones.push(zone);
      const img = new Image();
      img.onload = () => {
        zone.img = img;
        zone.loaded = true;
        sampleEdgeColors(zone);
        resolve();
      };
      img.onerror = () => {
        zone.failed = true;
        console.warn(`[MAЯPS] Panorama not found or not readable: ${zone.file}`);
        resolve();
      };
      img.src = zone.file;
    }))
  ).then(() => getPanoramaStatus());

  return loadPromise;
}

export function getPanoramaStatus() {
  return {
    total: zones.length,
    loaded: zones.filter((z) => z.loaded).length,
    failed: zones.filter((z) => z.failed).map((z) => z.file)
  };
}

/* ------------------------------------------------------------------ zone selection */

/**
 * The panorama zone(s) for a position.
 * Returns null if no image is available, or { primary, secondary, secondaryWeight, label }.
 * secondaryWeight is between 0 and 0.5 and grows smoothly as the position nears the boundary between zones.
 */
export function getZoneBlend(lat, lon) {
  const usable = zones.filter((z) => z.loaded);
  if (usable.length === 0) return null;

  const ranked = usable
    .map((zone) => ({ zone, distance: distanceMeters(lat, lon, zone.latitude, zone.longitude) }))
    .sort((a, b) => a.distance - b.distance);

  const first = ranked[0];
  if (ranked.length === 1) {
    return { primary: first.zone, secondary: null, secondaryWeight: 0, label: first.zone.label };
  }

  const second = ranked[1];
  const width = Math.max(1, CONFIG.panoramas.blendWidthMeters);
  const weight = clamp(0.5 - (second.distance - first.distance) / (2 * width), 0, 0.5);
  return {
    primary: first.zone,
    secondary: weight > 0.005 ? second.zone : null,
    secondaryWeight: weight,
    label: first.zone.label
  };
}

/* ------------------------------------------------------------------ drawing */

function drawZone(ctx, zone, alpha, w, h, view, hfov, vfov) {
  const img = zone.img;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih || alpha <= 0) return;

  // Choose an even number of repetitions so that the image keeps its proportions as much as possible.
  const maxTiles = (360 * ih * w) / (MIN_VERTICAL_COVER * h * iw * hfov);
  const tiles = clamp(2 * Math.floor(maxTiles / 2), 2, MAX_TILES);
  const span = 360 / tiles;                                  // degrees of azimuth covered by one repetition
  const tileWidth = (span * w) / hfov;
  const drawHeight = Math.max((ih / iw) * tileWidth, MIN_VERTICAL_COVER * h);
  const top = h / 2 - drawHeight / 2 + (view.pitchDegrees / vfov) * h;   // looking up moves the image down

  ctx.globalAlpha = alpha;

  // Beyond the top and bottom edge of the image: its average edge colour.
  ctx.fillStyle = zone.topColor;
  if (top > 0) ctx.fillRect(-w, -2 * h, 3 * w, top + 2 * h + 1);
  ctx.fillStyle = zone.bottomColor;
  const bottom = top + drawHeight;
  if (bottom < h) ctx.fillRect(-w, bottom - 1, 3 * w, 2 * h + 1);

  const a0 = view.headingDegrees - hfov / 2;
  const a1 = view.headingDegrees + hfov / 2;
  const kStart = Math.floor(a0 / span);
  const kEnd = Math.floor(a1 / span);

  for (let k = kStart; k <= kEnd; k += 1) {
    const segStart = Math.max(a0, k * span);
    const segEnd = Math.min(a1, (k + 1) * span);
    if (segEnd <= segStart) continue;

    const f0 = (segStart - k * span) / span;
    const f1 = (segEnd - k * span) / span;
    const mirrored = ((k % 2) + 2) % 2 === 1;
    const s0 = mirrored ? 1 - f1 : f0;
    const s1 = mirrored ? 1 - f0 : f1;
    const sx = s0 * iw;
    const sw = Math.max(1, (s1 - s0) * iw);
    const dx = ((segStart - a0) / hfov) * w;
    const dw = ((segEnd - segStart) / hfov) * w + 0.75;   // a little overlap hides hairline seams

    if (mirrored) {
      ctx.save();
      ctx.translate(dx + dw, top);
      ctx.scale(-1, 1);
      ctx.drawImage(img, sx, 0, sw, ih, 0, 0, dw, drawHeight);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, 0, sw, ih, dx, top, dw, drawHeight);
    }
  }
}

function drawLayer(ctx, blend, layerAlpha, scale, w, h, view, hfov, vfov, horizonY) {
  ctx.save();
  ctx.translate(w / 2, horizonY);
  ctx.scale(scale, scale);
  ctx.translate(-w / 2, -horizonY);
  drawZone(ctx, blend.primary, layerAlpha, w, h, view, hfov, vfov);
  if (blend.secondary) {
    drawZone(ctx, blend.secondary, layerAlpha * blend.secondaryWeight, w, h, view, hfov, vfov);
  }
  ctx.restore();
}

function drawPlaceholder(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#6b4a35');
  g.addColorStop(0.5, '#8a5f43');
  g.addColorStop(0.5, '#4a3226');
  g.addColorStop(1, '#241810');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No panorama image could be loaded. Check the files in assets/images/panoramas/', w / 2, h / 2 + 90);
  ctx.textAlign = 'left';
}

/**
 * Draws the first-person background.
 * view: { latitude, longitude, headingDegrees, pitchDegrees, travelMeters }
 * Returns false if no panorama image is available (a plain placeholder is drawn instead).
 */
export function drawPanorama(ctx, w, h, view) {
  const blend = getZoneBlend(view.latitude, view.longitude);
  if (!blend) {
    drawPlaceholder(ctx, w, h);
    return false;
  }

  const hfov = CONFIG.panoramas.horizontalFovDegrees;
  const vfov = (hfov * h) / w;
  const horizonY = h / 2 + (view.pitchDegrees / vfov) * h;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0.3, blend.primary.topColor);
  sky.addColorStop(0.7, blend.primary.bottomColor);
  ctx.globalAlpha = 1;
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Forward movement: two copies of the scene, one growing and one smaller that fades in.
  const cycle = Math.max(10, CONFIG.panoramas.zoomCycleMeters || DEFAULT_ZOOM_CYCLE_METERS);
  const t = (((view.travelMeters / cycle) % 1) + 1) % 1;
  const scaleBig = 1 + (FORWARD_ZOOM - 1) * t;
  const scaleSmall = scaleBig / FORWARD_ZOOM;

  drawLayer(ctx, blend, 1, scaleBig, w, h, view, hfov, vfov, horizonY);
  if (t > 0.01) drawLayer(ctx, blend, t, scaleSmall, w, h, view, hfov, vfov, horizonY);

  ctx.globalAlpha = 1;
  return true;
}