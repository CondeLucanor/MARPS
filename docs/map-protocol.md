# MAЯPS ↔ Map message protocol (version 1)

The map (`map/map.html`) runs inside an `<iframe>` of the main application and talks to it only
through `window.postMessage`. The map keeps NO mission data of its own: it draws what the application
sends and reports user actions.

## 1. Transport and security

- Every message is `{ type: string, payload: any }`.
- The map sends with `window.parent.postMessage(message, window.location.origin)`.
- The map must only accept messages where `event.source === window.parent` and
  `event.origin === window.location.origin`.
- The application ignores messages that do not come from the iframe, from another origin, with an
  unknown `type` or with an invalid payload. It also drops more than 40 messages per second.
- Payloads are plain JSON-compatible objects.

## 2. Conventions

- Latitude: planetocentric degrees, -90..90.
- Longitude: east-positive degrees, **0..360** (the whole study region is 300..360). If Leaflet works
  with -180..180, convert inside the map module.
- Elevation in metres relative to the Martian areoid. Slope in degrees.
- A latitude/longitude of `null` means "not available: hide that marker".
- Asset URLs sent by the application (images) are absolute.

## 3. Start-up handshake

1. The application creates the iframe when the user first opens the Map section.
2. When the map is ready to receive messages it sends `MAP_READY`.
3. The application answers with `INIT_MAP`, `MAP_SHOWN`, and then the data messages (section 4).
   Nothing is sent before `MAP_READY`.

## 4. Application → Map

| type | payload | Notes |
|---|---|---|
| `INIT_MAP` *(extension)* | `{ protocolVersion, region: {name, latMin, latMax, lonMin, lonMax, center:{latitude, longitude}}, coordinateSystem }` | Sent once after `MAP_READY`. |
| `MAP_SHOWN` *(extension)* | `null` | The map section became visible. Call `map.invalidateSize()`. |
| `SET_MAP_MODE` *(extension)* | `{ mode, missionActive, missionPhase }` | `mode`: see below. |
| `UPDATE_TERRAIN_LAYERS` *(extension)* | `{ bounds:{latMin,latMax,lonMin,lonMax}, width, height, imageLayout, elevation:{dataUrl, minElevationMeters, maxElevationMeters, legend, provenance}, slope:{dataUrl, maxSlopeDegrees, legend, provenance} }` | Two PNG data-URL images covering `bounds` in plain lat/lon layout (left = lonMin, top = latMax). Use them as elevation and slope overlay layers. Optional: the map may use its own layers. |
| `UPDATE_LANDING` *(extension)* | `{ planned, actual, lidar, errorRadiusMeters, confirmed }` | `planned`, `actual`, `lidar`: `{latitude, longitude}` or `null`. Draw the error circle around `planned`. |
| `UPDATE_ASTRONAUT_POSITION` | `{ latitude, longitude, headingDegrees?, precisionMeters?, insideVehicle? }` | Throttled (max about 4/s) and only when changed. |
| `UPDATE_VEHICLE_POSITION` | `{ latitude, longitude, headingDegrees? }` | Same. |
| `UPDATE_ROUTE` | `{ recommended: [{latitude,longitude}…], alternatives: [[{latitude,longitude}…], …], selectedIndex }` | `selectedIndex` 0 = recommended, 1.. = alternatives[i-1]. Empty arrays = no route. |
| `UPDATE_OBSTACLES` | `[{ id, type, latitude, longitude, known, detected, radiusMeters }]` | Only obstacles the user may see (known or already detected). `type`: `rock`, `crater`, `hazard-zone`. The whole list is resent when it changes. |
| `UPDATE_SCIENTIFIC_POINTS` | `[{ id, name, type, latitude, longitude, description, image, visited }]` | `image` is an absolute URL or `null`. |
| `INSPECT_RESULT` *(extension)* | `{ requestId, latitude, longitude, elevation, slopeDegrees, provenance }` | Answer to `INSPECT_POINT`. `elevation`/`slopeDegrees` can be `null`. |

`SET_MAP_MODE.mode`:

- `browse`: the map may be inspected (coordinates, elevation, scientific point info). No mission action.
- `landing-selection`: a click on the map selects the landing point (`LANDING_LOCATION_SELECTED`).
- `exploration`: a scientific point may be chosen as destination (`DESTINATION_SELECTED`).

## 5. Map → Application

| type | payload | Notes |
|---|---|---|
| `MAP_READY` *(extension)* | `null` | Send once, when the map can receive messages. |
| `LANDING_LOCATION_SELECTED` | `{ latitude, longitude, elevation? }` | Only in `landing-selection` mode. `elevation` is optional and IGNORED: the application computes it from the real DEM. The point must be inside the region. Do not draw the landing marker yourself: wait for `UPDATE_LANDING`. |
| `DESTINATION_SELECTED` | `{ id }` | Only in `exploration` mode. `id` is a scientific point id (letters, digits, `_`, `-`, max 64). |
| `INSPECT_POINT` *(extension)* | `{ requestId, latitude, longitude }` | To show elevation and slope of any point. `requestId` is a string or number you choose; it is echoed in `INSPECT_RESULT`. |

## 6. Rules for the map

- Do not keep or duplicate mission state. Redraw from the last message received.
- Do not send messages in a loop or on every mouse move. Send only on user actions.
- Layers must be individually togglable: terrain elevation, slope, obstacles, scientific points,
  route, astronaut and vehicle position.
- No manual distance measurement, arbitrary markers or favourites.
- Mission archive reconstruction (Stage 17) will add messages to this document. They are not part of version 1.