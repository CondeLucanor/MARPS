/**
 * MAЯPS — small general-purpose helpers shared by all modules.
 */

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  
  export function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  
  export function degToRad(degrees) {
    return (degrees * Math.PI) / 180;
  }
  
  export function radToDeg(radians) {
    return (radians * 180) / Math.PI;
  }
  
  /** Returns an angle in the range [0, 360). */
  export function normalizeAngle360(degrees) {
    return ((degrees % 360) + 360) % 360;
  }
  
  /** Shortest signed difference (b - a) in degrees, in the range (-180, 180]. */
  export function angleDifference(a, b) {
    let diff = normalizeAngle360(b - a);
    if (diff > 180) diff -= 360;
    return diff;
  }
  
  export function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  
  export function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
  }
  
  export function pad2(n) {
    return String(n).padStart(2, '0');
  }
  
  /** Formats a timestamp (milliseconds) as HH:MM:SS. */
  export function formatClock(timestampMs) {
    const d = new Date(timestampMs);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  
  /** Formats a duration in seconds, e.g. "1 h 05 min" or "42 s". */
  export function formatDuration(totalSeconds) {
    if (!isFiniteNumber(totalSeconds) || totalSeconds < 0) return '—';
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h} h ${pad2(m)} min`;
    if (m > 0) return `${m} min ${pad2(sec)} s`;
    return `${sec} s`;
  }
  
  export function formatDistance(meters) {
    if (!isFiniteNumber(meters)) return '—';
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
    return `${Math.round(meters)} m`;
  }
  
  /** Formats a coordinate pair, e.g. "49.8000° N, 339.3000° E". */
  export function formatCoordinate(latitude, longitude, decimals = 4) {
    if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return '—';
    const ns = latitude >= 0 ? 'N' : 'S';
    return `${Math.abs(latitude).toFixed(decimals)}° ${ns}, ${longitude.toFixed(decimals)}° E`;
  }
  
  /** Seeded pseudo-random generator (mulberry32). Returns a function that gives numbers in [0, 1). */
  export function createRng(seed) {
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  
  /** Standard normal random number (Box–Muller) from a generator returning values in [0, 1). */
  export function randomNormal(rng = Math.random) {
    let u = 0;
    while (u === 0) u = rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  
  export function deepClone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }