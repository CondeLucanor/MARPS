/**
 * MAЯPS — central configuration.
 * Every adjustable parameter of the simulation lives here.
 * Units are given in the property names (Meters, Seconds, Degrees, Percent).
 */
export const CONFIG = {

    app: {
      name: 'MAЯPS',
      subtitle: 'Mars Astronaut Route Planning & Simulation',
      tagline: 'Mission planning and exploration system — Acidalia Planitia',
      exportFormat: 'MAЯPS-MISSION',
      schemaVersion: 1,
      missionIdPrefix: 'MISSION_'
    },
  
    debug: {
      // Set to true at the end of the project to be warned (in the Console) of any module that failed to load.
      reportMissingModules: false,
      logEvents: false
    },
  // Leaflet map integration (see docs/map-protocol.md)
  map: {
    // Main file of the independent map. Change only this line if your colleague names it differently.
    url: 'map/map.html',
    // null = the map is served from the same origin as the app (normal case).
    // If the map is hosted elsewhere, write its origin, e.g. 'https://example.org'.
    allowedOrigin: null,
    protocolVersion: 1,
    // Minimum real time between position messages sent to the map.
    positionUpdateIntervalMs: 250,
    // Width in pixels of the elevation and slope images generated for the map.
    layerImageWidth: 960,
    // If the map does not announce itself in this time, a warning is shown.
    readyTimeoutMs: 8000
  },
    mars: {
      radiusMeters: 3396190
    },
  
    coordinateSystem: {
      description: 'Mars planetocentric latitude (degrees), east-positive longitude (0 to 360 degrees), elevation in metres relative to the Martian areoid.'
    },
  
    provenance: {
      realDem: 'real-MOLA-DEM',
      interpolated: 'interpolated',
      simulated: 'simulated'
    },
  
    // Study region: Mare Acidalium quadrangle, which contains Acidalia Planitia.
    region: {
      name: 'Acidalia Planitia',
      latMin: 30,
      latMax: 65,
      lonMin: 300,
      lonMax: 360,
      center: { latitude: 49.8, longitude: 339.3 }
    },
  
    // Real MOLA elevation grid (463 m global DEM, resampled). Values checked against the .asc header.
    terrain: {
      file: 'data/terrain-acidalia.asc',
      ncols: 1920,
      nrows: 1120,
      xllcorner: -3556558.4,
      yllcorner: 1778279.2,
      cellSizeMeters: 1852.374166666667,
      noDataValue: -32768,
      headerToleranceMeters: 1
    },
  
    // The real DEM is coarse (about 1.85 km per cell). Small-scale roughness is added as SIMULATED data
    // and is always labelled as such.
    terrainModel: {
      microRelief: {
        enabled: true,
        seed: 20260101,
        wavelengthMeters: [1200, 5000],
        extraSlopeDegrees: [5, 9],
        reliefScaleMeters: 400
      }
    },
  
    simulation: {
      // Simulated seconds per real second during exploration. 1 = real time.
      timeMultiplier: 30,
      // Multiplier used before exploration starts (landing flow).
      preExplorationMultiplier: 1,
      fixedStepSeconds: 0.1,
      maxStepsPerFrame: 50,
      maxFrameSeconds: 0.25
    },
  
    landing: {
      errorRadius: { minMeters: 0, maxMeters: 20000, defaultMeters: 250 },
      safety: {
        weights: { slope: 0.35, roughness: 0.15, craterProximity: 0.20, obstacleProximity: 0.20, elevation: 0.10 },
        thresholds: { safe: 80, moderate: 50 },
        slopeGoodDegrees: 3,
        slopeBadDegrees: 15,
        roughnessGoodMeters: 40,
        roughnessBadMeters: 400,
        craterDangerDistanceMeters: 500,
        craterSafeDistanceMeters: 4000,
        obstacleDangerDistanceMeters: 200,
        obstacleSafeDistanceMeters: 2500,
        elevationGoodMeters: -4500,
        elevationBadMeters: -1000
      },
      descentDurationSeconds: 12,
      lidar: {
        acquisitionDurationSeconds: 8,
        positionSigmaMeters: 4,
        precisionMeters: 4
      }
    },
  
    movement: {
      turnRateDegreesPerSecond: 70,
      mouseSensitivityDegreesPerPixel: 0.18,
      pitchLimitDegrees: 40,
      backwardSpeedFactor: 0.5,
      profiles: {
        astronaut: {
          label: 'Astronaut',
          speedsMetersPerSecond: { normal: 1.4, slow: 0.7, verySlow: 0.3 },
          slopeClassesDegrees: { normalMax: 8, slowMax: 16, verySlowMax: 24 },
          maxSlopeDegrees: 24,
          obstacleClearanceMeters: 0.4,
          minTraversability: 0.15
        },
        vehicle: {
          label: 'Exploration vehicle',
          speedsMetersPerSecond: { normal: 6, slow: 3, verySlow: 1.2 },
          slopeClassesDegrees: { normalMax: 6, slowMax: 12, verySlowMax: 20 },
          maxSlopeDegrees: 20,
          obstacleClearanceMeters: 0.8,
          minTraversability: 0.3
        }
      }
    },
  
    routePlanning: {
      cellSizeMeters: 250,
      windowMarginMeters: 30000,
      maxWindowCells: 400000,
      weights: {
        distance: 1,
        slope: 3,
        elevationChange: 0.5,
        knownHazard: 8,
        detectedObstacle: 20,
        mobilityPenalty: 4
      },
      alternatives: {
        count: 2,
        penaltyFactor: 4,
        corridorMeters: 600,
        minDifferenceRatio: 0.15
      },
      safetyWeights: { slope: 0.4, obstacles: 0.3, hazards: 0.3 },
      offRouteThresholdMeters: 150,
      recalcCooldownSeconds: 20,
      arrivalRadiusMeters: 60
    },
  
    vehicle: {
      battery: {
        initialPercent: 100,
        consumptionPercentPerKm: 0.35,
        consumptionPercentPerHour: 1.2,
        lowThresholdPercent: 20,
        eventStepPercent: 2,
        chargeRatePercentPerMinute: 8
      },
      base: { radiusMeters: 120 },
      // The astronaut can enter the vehicle only when closer than this (the vehicle never moves by itself).
      enterRadiusMeters: 75
    },
  
    sensors: {
      vehicleLidar: { rangeMeters: 500, scanIntervalSeconds: 2 },
      helmetStereo: {
        scanIntervalSeconds: 2,
        basePrecisionMeters: 1.5,
        driftMetersPerKm: 0.8,
        maxPrecisionMeters: 25,
        noiseFraction: 0.15,
        fixResetRadiusMeters: 200
      }
    },
  
    // blockingMode: 'height' = blocks a profile only if the obstacle is taller than its clearance;
    //               'always' = blocks every profile.
    obstacleTypes: {
      rock: { label: 'Rock', avoidRadiusMeters: 80, defaultHeightMeters: 0.7, blockingMode: 'height' },
      crater: { label: 'Crater', avoidRadiusMeters: 400, defaultHeightMeters: 0, blockingMode: 'always' },
      'hazard-zone': { label: 'Hazard zone', avoidRadiusMeters: 900, defaultHeightMeters: 0, blockingMode: 'always' }
    },
  
    obstacles: {
      file: 'data/obstacles.json',
      detectionRadiusMeters: { astronaut: 120, vehicle: 450 }
    },
  
    environment: {
      updateIntervalSeconds: 30,
      // Anchor values are SIMULATED. Between anchors the values are interpolated continuously.
      anchors: [
        { id: 'cydonia-mesas', name: 'Cydonia mesas', latitude: 40.75, longitude: 350.5, temperatureC: -58, windSpeedMps: 6.5, radiationMicroSvPerHour: 27.5 },
        { id: 'southern-plains', name: 'Southern plains', latitude: 38.0, longitude: 338.8, temperatureC: -60, windSpeedMps: 6.0, radiationMicroSvPerHour: 27.0 },
        { id: 'central-plains', name: 'Central plains', latitude: 49.8, longitude: 339.3, temperatureC: -68, windSpeedMps: 8.5, radiationMicroSvPerHour: 28.0 },
        { id: 'acidalia-colles', name: 'Acidalia Colles', latitude: 50.9, longitude: 336.9, temperatureC: -70, windSpeedMps: 9.0, radiationMicroSvPerHour: 28.5 },
        { id: 'northern-plains', name: 'Northern plains', latitude: 60.0, longitude: 340.0, temperatureC: -78, windSpeedMps: 10.5, radiationMicroSvPerHour: 30.0 },
        { id: 'lomonosov', name: 'Lomonosov region', latitude: 64.9, longitude: 350.5, temperatureC: -84, windSpeedMps: 11.5, radiationMicroSvPerHour: 31.0 },
        { id: 'western-plains', name: 'Western plains', latitude: 45.0, longitude: 310.0, temperatureC: -65, windSpeedMps: 7.5, radiationMicroSvPerHour: 27.5 }
      ],
      interpolationPower: 2,
      diurnal: { periodSeconds: 88775, temperatureAmplitudeC: 22, windAmplitudeMps: 3 },
      noise: { temperatureC: 0.6, windSpeedMps: 0.5, radiationMicroSvPerHour: 0.8, seed: 7 }
    },
  
    scientificPoints: {
      file: 'data/scientific-points.json',
      arrivalRadiusMeters: 100,
      // Imágenes: assets/images/acidalia/acidalia1.jpg, acidalia2.jpg...
      // Se asignan por el orden de los puntos en el JSON (el 1º punto = acidalia1).
      imageFolder: 'assets/images/acidalia',
      imageExtension: 'jpg',
      imageCount: 8,
      assignImagesByOrder: true
    },
    // Panorama zones. The image shown is chosen by the nearest zone centre. You can edit the centres freely.
    panoramas: {
      horizontalFovDegrees: 140,
      blendWidthMeters: 40000,
      zones: [
        { id: 'panorama-1', file: 'assets/images/panoramas/panorama-1.jpg', label: 'Northern plains', latitude: 60, longitude: 335 },
        { id: 'panorama-2', file: 'assets/images/panoramas/panorama-2.jpg', label: 'Central plains', latitude: 50, longitude: 340 },
        { id: 'panorama-3', file: 'assets/images/panoramas/panorama-3.jpg', label: 'Southern plains', latitude: 40, longitude: 335 },
        { id: 'panorama-4', file: 'assets/images/panoramas/panorama-4.jpg', label: 'Cydonia mesas', latitude: 41, longitude: 350 },
        { id: 'panorama-5', file: 'assets/images/panoramas/panorama-5.jpg', label: 'Eastern plains', latitude: 52, longitude: 352 },
        { id: 'panorama-6', file: 'assets/images/panoramas/panorama-6.jpg', label: 'Western plains', latitude: 48, longitude: 315 }
      ]
    },
  
    log: {
      positionIntervalSeconds: 5
    },
  
    notifications: {
      toastDurationMs: 5000,
      maxToasts: 4
    }
  };