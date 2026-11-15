/**
 * MAЯPS — Mars geodesy helpers.
 * Convention used by the whole application:
 *   latitude  = planetocentric latitude in degrees (-90 to 90)
 *   longitude = east-positive longitude in degrees (0 to 360)
 * The real elevation grid (MOLA) uses an equidistant cylindrical projection with longitudes from
 * -180 to 180; the conversion is done only in latLonToDemMeters / demMetersToLatLon.
 */
import { CONFIG } from './config.js';
import { degToRad, radToDeg, normalizeAngle360, isFiniteNumber } from './utils.js';

const R = CONFIG.mars.radiusMeters;

/** Returns a longitude in the range [0, 360). */
export function normalizeLongitude(lon) {
  let l = lon % 360;
  if (l < 0) l += 360;
  return l;
}

/** Shortest signed longitude difference (lon2 - lon1) in degrees, in (-180, 180]. */
export function longitudeDifference(lon1, lon2) {
  let d = normalizeLongitude(lon2 - lon1);
  if (d > 180) d -= 360;
  return d;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const p1 = degToRad(lat1);
  const p2 = degToRad(lat2);
  const dp = p2 - p1;
  const dl = degToRad(longitudeDifference(lon1, lon2));
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from point 1 to point 2 (0 = north, 90 = east). */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const p1 = degToRad(lat1);
  const p2 = degToRad(lat2);
  const dl = degToRad(longitudeDifference(lon1, lon2));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeAngle360(radToDeg(Math.atan2(y, x)));
}

/** Point reached from (lat, lon) travelling `distM` metres along `bearingDeg`. */
export function destinationPoint(lat, lon, bearingDeg, distM) {
  const delta = distM / R;
  const theta = degToRad(bearingDeg);
  const p1 = degToRad(lat);
  const l1 = degToRad(lon);
  const sinP2 = Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(theta);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const l2 = l1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(p1),
    Math.cos(delta) - Math.sin(p1) * sinP2
  );
  return { latitude: radToDeg(p2), longitude: normalizeLongitude(radToDeg(l2)) };
}

/**
 * Random point inside a circle of radius `radiusM` around (lat, lon), generated geographically
 * (random bearing + random distance on the sphere, uniform over the area).
 */
export function randomPointWithinRadius(lat, lon, radiusM, rng = Math.random) {
  const bearing = rng() * 360;
  const dist = radiusM * Math.sqrt(rng());
  const point = destinationPoint(lat, lon, bearing, dist);
  return { ...point, distanceMeters: dist, bearingDegrees: bearing };
}

export function metersPerDegreeLatitude() {
  return (R * Math.PI) / 180;
}

export function metersPerDegreeLongitude(lat) {
  return ((R * Math.PI) / 180) * Math.cos(degToRad(lat));
}

/** Local east/north offset in metres of a point relative to an origin (accurate for short distances). */
export function toLocalMeters(lat, lon, originLat, originLon) {
  return {
    x: longitudeDifference(originLon, lon) * metersPerDegreeLongitude(originLat),
    y: (lat - originLat) * metersPerDegreeLatitude()
  };
}

/** Inverse of toLocalMeters. */
export function fromLocalMeters(x, y, originLat, originLon) {
  return {
    latitude: originLat + y / metersPerDegreeLatitude(),
    longitude: normalizeLongitude(originLon + x / metersPerDegreeLongitude(originLat))
  };
}

export function isValidCoordinate(lat, lon) {
  return isFiniteNumber(lat) && isFiniteNumber(lon) && lat >= -90 && lat <= 90 && lon >= 0 && lon <= 360;
}

export function isInsideRegion(lat, lon) {
  const r = CONFIG.region;
  return isValidCoordinate(lat, lon) && lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax;
}

/** Converts (lat, lon 0-360) to metres in the DEM projection (longitude shown as -180..180). */
export function latLonToDemMeters(lat, lon) {
  const lonSigned = normalizeLongitude(lon) > 180 ? normalizeLongitude(lon) - 360 : normalizeLongitude(lon);
  return { x: R * degToRad(lonSigned), y: R * degToRad(lat) };
}

/** Converts DEM projection metres back to (lat, lon 0-360). */
export function demMetersToLatLon(x, y) {
  return { latitude: radToDeg(y / R), longitude: normalizeLongitude(radToDeg(x / R)) };
}