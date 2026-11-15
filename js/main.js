/**
 * MAЯPS — application entry point (loaded by index.html).
 * Initialises every module in order.
 */
import * as state from './state.js';
import * as events from './events.js';
import * as missionManager from './mission-manager.js';
import { initNavigation } from './navigation.js';
import { startSimulationLoop } from './simulation.js';
import { initMissionManager } from './mission-manager.js';
import { initMissionView } from './mission-view.js';
import { initMissionSetup } from './mission-setup.js';
import { showToast } from './ui.js';
import * as terrain from './terrain.js';
import * as terrainLayers from './terrain-layers.js';
import * as mapBridge from './map-bridge.js';
import * as landing from './landing.js';
import * as environment from './environment.js';
import * as landingFlow from './landing-flow.js';
import * as astronaut from './astronaut.js';
import * as panoramaManager from './panorama-manager.js';
import * as explorationView from './exploration-view.js';
import * as scientificPoints from './scientific-points.js';
import * as obstacles from './obstacles.js';
import * as routePlanner from './route-planner.js';
import * as navigationSystem from './navigation-system.js';
import * as vehicle from './vehicle.js';
import * as sensors from './sensors.js';
import * as missionLog from './mission-log.js';
import * as missionArchive from './mission-archive.js';
import * as dataExport from './data-export.js';
import * as dataImport from './data-import.js';
import * as diagnostics from './diagnostics.js';

function boot() {
  try {
    initNavigation();
    initMissionView();
    initMissionSetup();
    initMissionManager();
    landing.initLanding();
    // landing-flow must start AFTER landing: both draw in the same side panel.
    landingFlow.initLandingFlow();
    environment.initEnvironment();
    astronaut.initAstronaut();
    explorationView.initExplorationView();
    scientificPoints.initScientificPoints();
    obstacles.initObstacles();
    // vehicle adds its button to the HUD built by exploration-view, so it starts AFTER it.
    // vehicle, sensors and the log recorder run their tick AFTER astronaut (they use its updated position).
    vehicle.initVehicle();
    sensors.initSensors();
    missionLog.initMissionLog();
    missionArchive.initMissionArchive();
    // navigation-system must start AFTER exploration-view (it adds its bar to that screen)
    // and AFTER landing / landing-flow (all three share the side panel).
    navigationSystem.initNavigationSystem();
    mapBridge.initMapBridge();
    startSimulationLoop();

    terrain.loadTerrain()
      .then((info) => {
        showToast(`Terrain loaded: ${info.ncols} × ${info.nrows} cells.`, 'success');
      })
      .catch((err) => {
        console.error('[MAЯPS] Terrain error:', err);
        showToast(`Terrain data could not be loaded: ${err.message}`, 'error');
      });

    // Handy for testing from the browser Console (F12). It does not affect the application.
    window.MARPS = {
      state, events, missionManager, terrain, terrainLayers, mapBridge, landing,
      environment, landingFlow, astronaut, panoramaManager, explorationView,
      scientificPoints, obstacles, routePlanner, navigationSystem, vehicle, sensors,
      missionLog, missionArchive, dataExport, dataImport, diagnostics
    };
  } catch (err) {
    console.error('[MAЯPS] Startup error:', err);
    showToast('MAЯPS failed to start. Open the browser Console (F12) for details.', 'error');
  }
}

boot();