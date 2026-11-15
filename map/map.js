/* Load Leaflet from several sources, in order, then start the app.
   For fully offline use, download leaflet.js / leaflet.css and put "leaflet/leaflet.js" first in this list. */
(function loadLeaflet() {
  const sources = [
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  ];
  let i = 0;
  function next() {
    if (i >= sources.length) {
      document.getElementById("map").innerHTML =
        "<p style='padding:20px'>Could not load the Leaflet library from any source. " +
        "Check your internet connection or download Leaflet locally.</p>";
      return;
    }
    const s = document.createElement("script");
    s.src = sources[i++];
    s.onload = init;
    s.onerror = next;
    document.head.appendChild(s);
  }
  next();
})();

function init() {
/* ---------- 1. Configuration ---------- */

// Basemap: the colored Geologic Map of Mars (USGS SIM 3292), rendered from the PDF and reprojected
// from Robinson to equirectangular (full globe: lon -180..180, lat -90..90). No online tiles are used.
// The image is embedded in this file (window.MARS_BASE_DATA, defined in the first <script> block).
// To use a separate file instead, delete that block and keep mars-geologic.jpg next to index.html.
const BASE_IMAGE = {
  url: window.MARS_BASE_DATA || "mars-geologic.jpg",
  attribution: "Geologic map: USGS SIM 3292 (Tanaka et al., 2014)"
};

const CATEGORIES = {
  mountain: { label: "Volcanoes & mountains", color: "#ff7043", icon: "▲" },
  canyon:   { label: "Canyons & basins",      color: "#ffca28", icon: "◆" },
  crater:   { label: "Craters",               color: "#90caf9", icon: "●" },
  mission:  { label: "Landing sites",         color: "#81c784", icon: "★" },
  landform: { label: "Mesas, hills & landforms", color: "#4dd0e1", icon: "◈" },
  "unit-A": { label: "Geologic units: Amazonian", color: "#ce93d8", icon: "■" },
  "unit-H": { label: "Geologic units: Hesperian", color: "#f48fb1", icon: "■" },
  "unit-N": { label: "Geologic units: Noachian",  color: "#80cbc4", icon: "■" }
};

// Longitudes are given as Mars East longitude (0–360) and converted below.
const PLACES = [
  { name: "Olympus Mons", cat: "mountain", lat: 18.65, lon: 226.2,
    info: "The tallest known volcano in the solar system, about 22 km high." },
  { name: "Arsia Mons", cat: "mountain", lat: -8.35, lon: 239.9, info: "Southernmost of the three Tharsis Montes." },
  { name: "Pavonis Mons", cat: "mountain", lat: 0.8, lon: 246.7, info: "Middle volcano of the Tharsis Montes chain." },
  { name: "Ascraeus Mons", cat: "mountain", lat: 11.8, lon: 255.5, info: "Northernmost of the Tharsis Montes." },
  { name: "Elysium Mons", cat: "mountain", lat: 25.0, lon: 147.2, info: "Main volcano of the Elysium volcanic province." },
  { name: "Valles Marineris", cat: "canyon", lat: -14.0, lon: 301, info: "A canyon system over 4,000 km long, the largest in the solar system." },
  { name: "Hellas Planitia", cat: "canyon", lat: -42.4, lon: 70.5, info: "A huge impact basin, among the deepest points on Mars." },
  { name: "Argyre Planitia", cat: "canyon", lat: -49.7, lon: 316, info: "A large, ancient impact basin in the southern highlands." },
  { name: "Acidalia Planitia", cat: "canyon", lat: 46.7, lon: 339.2,
    info: "A large, dark plain in Mars's northern lowlands, west of Tharsis; the map opens here." },
  { name: "Utopia Planitia", cat: "canyon", lat: 46.7, lon: 117.5, info: "A vast northern plain, the largest recognized impact basin on Mars." },
  { name: "Gale Crater", cat: "crater", lat: -5.4, lon: 137.8, info: "154 km crater with a central mound, Aeolis Mons (Mount Sharp)." },
  { name: "Jezero Crater", cat: "crater", lat: 18.38, lon: 77.58, info: "Ancient lake bed with a river delta." },
  { name: "Gusev Crater", cat: "crater", lat: -14.5, lon: 175.4, info: "Crater that may once have held a lake." },
  { name: "Curiosity (MSL)", cat: "mission", lat: -4.59, lon: 137.44, info: "NASA rover, landed August 2012 in Gale Crater." },
  { name: "Perseverance", cat: "mission", lat: 18.44, lon: 77.45, info: "NASA rover, landed February 2021 in Jezero Crater." },
  { name: "Opportunity", cat: "mission", lat: -1.95, lon: 354.47, info: "NASA rover, landed January 2004 at Meridiani Planum." },
  { name: "Spirit", cat: "mission", lat: -14.57, lon: 175.47, info: "NASA rover, landed January 2004 in Gusev Crater." },
  { name: "Viking 1", cat: "mission", lat: 22.27, lon: 312.05, info: "NASA lander, 1976, first successful Mars lander." },
  { name: "Mars Pathfinder", cat: "mission", lat: 19.13, lon: 326.78, info: "NASA lander with the Sojourner rover, 1997." },
  { name: "Phoenix", cat: "mission", lat: 68.22, lon: 234.3, info: "NASA lander that studied water ice near the north pole, 2008." },
  { name: "InSight", cat: "mission", lat: 4.5, lon: 135.6, info: "NASA lander that studied Mars's interior (seismology), 2018." },
  { name: "Zhurong (Tianwen-1)", cat: "mission", lat: 25.07, lon: 109.93, info: "Chinese rover, landed May 2021 in Utopia Planitia." },
  // Acidalia Planitia landmarks (IAU/USGS gazetteer values; craters from Wikipedia crater lists)
  { name: "Bamberg Crater", cat: "crater", lat: 40.0, lon: 356.8, minor: true,
    info: "Impact crater in Acidalia Planitia, about 58.3 km across. Sits near the highland–lowland transition; gullies have been imaged on its walls." },
  { name: "Arandas Crater", cat: "crater", lat: 42.7, lon: 344.9, minor: true,
    info: "Impact crater in Acidalia Planitia, about 25.1 km across. Fresh-looking crater with a well-preserved ejecta blanket, one of the two craters flanking the Cydonia 'Face' region." },
  { name: "Bonestell Crater", cat: "crater", lat: 42.3, lon: 329.5, minor: true,
    info: "Impact crater in Acidalia Planitia, about 42.4 km across. Large crater in the western part of the plain." },
  { name: "Kunowsky Crater", cat: "crater", lat: 57.1, lon: 350.3, minor: true,
    info: "Impact crater in Acidalia Planitia, about 67.4 km across. Large crater in the northern part of the plain." },
  { name: "Lomonosov Crater", cat: "crater", lat: 65.2, lon: 350.8, minor: true,
    info: "Impact crater in Acidalia Planitia, about 153 km across. One of the largest craters in the Mare Acidalium region, near the plain's northern edge." },
  { name: "Sklodowska Crater", cat: "crater", lat: 33.7, lon: 357.1, minor: true,
    info: "Impact crater in Acidalia Planitia, about 124 km across. Large crater on the southern margin of the plain, near Cydonia Mensae." },
  { name: "Pohl Crater", cat: "crater", lat: 34.03, lon: 323.0, minor: true,
    info: "Impact crater in Acidalia Planitia, about 111 km across. Large crater on the south-western margin of the plain." },
  { name: "Sytinskaya Crater", cat: "crater", lat: 42.7, lon: 306.9, minor: true,
    info: "Impact crater in Acidalia Planitia, about 93.2 km across. Large crater on the western side of the plain." },
  { name: "Gamboa Crater", cat: "crater", lat: 40.77, lon: 315.57, minor: true,
    info: "Impact crater in Acidalia Planitia, about 33 km across. Crater in the western part of Acidalia Planitia." },
  { name: "Davies Crater", cat: "crater", lat: 46.0, lon: 0.0, minor: true,
    info: "Impact crater in Acidalia Planitia, about 49.2 km across. Crater on the Prime Meridian, on the plain's eastern side." },
  { name: "Lagarto Crater", cat: "crater", lat: 50.2, lon: 351.6, minor: true,
    info: "Impact crater in Acidalia Planitia, about 19.5 km across. Mid-sized crater in the north-eastern plain." },
  { name: "Mohawk Crater", cat: "crater", lat: 43.2, lon: 354.6, minor: true,
    info: "Impact crater in Acidalia Planitia, about 17.5 km across. Mid-sized crater in the Cydonia region." },
  { name: "Lota Crater", cat: "crater", lat: 46.7, lon: 348.1, minor: true,
    info: "Impact crater in Acidalia Planitia, about 15.4 km across. Mid-sized crater in the eastern plain." },
  { name: "Elath Crater", cat: "crater", lat: 46.2, lon: 346.3, minor: true,
    info: "Impact crater in Acidalia Planitia, about 13.2 km across. Mid-sized crater in the eastern plain." },
  { name: "Yakima Crater", cat: "crater", lat: 43.4, lon: 356.8, minor: true,
    info: "Impact crater in Acidalia Planitia, about 13 km across. Small crater on the plain's eastern edge." },
  { name: "Dein Crater", cat: "crater", lat: 38.5, lon: 357.4, minor: true,
    info: "Impact crater in Acidalia Planitia, about 26 km across. Crater on the south-eastern margin of the plain." },
  { name: "Eagle Crater (Acidalia)", cat: "crater", lat: 44.2, lon: 351.8, minor: true,
    info: "Impact crater in Acidalia Planitia, about 13 km across. Small crater in the Cydonia region. Not to be confused with Opportunity's Eagle Crater at Meridiani Planum." },
  { name: "Freedom Crater", cat: "crater", lat: 43.7, lon: 350.9, minor: true,
    info: "Impact crater in Acidalia Planitia, about 12.9 km across. Small crater in the Cydonia region." },
  { name: "Hope Crater", cat: "crater", lat: 45.2, lon: 349.7, minor: true,
    info: "Impact crater in Acidalia Planitia, about 7.3 km across. Small crater in the eastern plain." },
  { name: "Apt Crater", cat: "crater", lat: 40.2, lon: 350.4, minor: true,
    info: "Impact crater in Acidalia Planitia, about 10 km across. Small crater close to the 'Face on Mars' mesa." },
  { name: "Rauna Crater", cat: "crater", lat: 35.6, lon: 327.9, minor: true,
    info: "Impact crater in Acidalia Planitia, about 2.5 km across. Small crater in the south-western plain." },
  { name: "Acidalia Mensa", cat: "landform", lat: 46.69, lon: 334.66,
    info: "Remnant mesa-like landform in the plain; its margin has been interpreted as a possible ancient shoreline." },
  { name: "Acidalia Colles", cat: "landform", lat: 50.34, lon: 336.91,
    info: "Cluster of small hills and knobs about 360 km long; gullies have been observed on the hills." },
  { name: "Cydonia Mensae", cat: "landform", lat: 33.69, lon: 347.0,
    info: "Region of flat-topped mesas on the southern margin of Acidalia Planitia, about 800 km across." },
  { name: "Face on Mars (Cydonia)", cat: "landform", lat: 40.75, lon: 350.54,
    info: "Roughly 2 km mesa that looked like a face in a 1976 Viking 1 image. Later images show an ordinary eroded hill." },
  { name: "Mare Acidalium (albedo feature)", cat: "landform", lat: 45.0, lon: 330.0,
    info: "Dark classical albedo feature seen from Earth by telescope, which gave Acidalia Planitia its name." }
];

/* ---------- Geologic map units ----------
   Source: Tanaka et al. (2014), Geologic Map of Mars, USGS Scientific Investigations Map 3292.
   Each row: [unit label, name, [[lat, east lon], ...] type-area centers, character, interpretation, crater-count localities]
   The first uppercase letter of the label gives the epoch: A = Amazonian, H = Hesperian, N = Noachian. */
const UNITS = [
  // Lowland
  ["mAl", "Middle Amazonian lowland unit", [[51.43, 118.45]], "Hummocky to undulating plains grading into knob fields; internally layered, tens of meters thick.", "Ice-rich loess; periglacial modification formed thumbprint terrain.", ""],
  ["lHl", "Late Hesperian lowland unit", [[21.40, 118.20]], "Planar to undulating, hundreds of meters to kilometers thick; continuous across most of the northern plains.", "Fluvial, lacustrine, marine and colluvial sediments from outflow channels and bounding highlands, intercalated with lava and volcaniclastic rocks; modified by periglaciation.", "1, 6, 10, 11"],
  // Impact
  ["AHi", "Amazonian and Hesperian impact unit", [[23.17, 207.77]], "Craters with rims and ejecta blankets; blanket thickness from meters to a few hundred meters. Global occurrence.", "Upturned, ejected and brecciated target rocks and sediments, with local impact melt.", ""],
  // Polar
  ["lApc", "Late Amazonian polar cap unit", [[83.00, 317.85], [-86.04, 291.81]], "Hummocky and pitted, very high albedo; mostly under 2 m (north) to under 10 m (south) thick.", "Residual ice (H2O in the north, mainly CO2 in the south) with dust lags.", ""],
  ["lApd", "Late Amazonian polar dunes unit", [[81.21, 217.34]], "Dune mounds tens to hundreds of meters across, low albedo, meter-scale ripples; surrounds Planum Boreum.", "Wind-blown sand organized into dune forms by variable wind activity and permafrost development.", ""],
  ["Apu", "Amazonian polar undivided unit", [[80.97, 0.00], [-83.15, 64.91]], "Plateaus hundreds of km across with layers meters thick; exceeds 1,000 m thick in places. Forms Planum Australe and upper Planum Boreum.", "Water ice with minor dust; local lower sequences of frozen dunes with interbedded ice layers.", ""],
  ["Ap", "Amazonian polar unit", [[-76.62, 287.50]], "Plains-forming deposit near Cavi Angusti, up to 1,000 m thick, relatively low radar dielectric constant.", "Mainly water ice and minor lithic fines; pits may be thermokarst forms.", ""],
  ["Hp", "Hesperian polar unit", [[-77.78, 332.51]], "Plains with narrow sinuous anabranching ridges and irregular depressions, hundreds of meters thick; surrounds Planum Australe.", "Water-ice sheets, perhaps from cryovolcanism or precipitation, covered by a thin periglacially deformed mantle.", "48"],
  ["Hpu", "Hesperian polar undivided unit", [[80.28, 302.72]], "Plateau-forming deposits with decameter-thick layers, locally over 1,000 m; forms the base of Planum Boreum.", "Roughly equal water ice and lithic fines, possibly from lowland flooding or eolian activity.", ""],
  ["Hpe", "Hesperian polar edifice unit", [[75.94, 206.23], [-75.96, 341.69]], "Shields and cones with summit and flank depressions, hundreds of meters thick; forms Scandia Tholi and Sisyphi Tholus.", "Cryovolcanic, sedimentary or igneous ice-rich constructs, degraded by mass wasting and sublimation.", ""],
  // Basin
  ["eAb", "Early Amazonian basin unit", [[37.44, 111.17]], "Basin-floor plains with hummocky and troughed textures, under 100 m thick in most places; central Utopia and western Hellas.", "Lacustrine and/or sheet-flood deposits, perhaps modified by compaction and thermokarst.", "3, 5, 41"],
  ["lHb", "Late Hesperian basin unit", [[-40.80, 64.00]], "Basin-floor plains, finely layered in places, hundreds of meters thick; covers central Hellas Planitia.", "Ice-rich eolian, lacustrine and/or volcanic air-fall deposits; margins eroded and back-wasted.", "39"],
  ["eHb", "Early Hesperian basin unit", [[-37.95, 78.84]], "Plains deposit on the eastern margins of Hellas Planitia, several hundred meters thick near its contact with unit HNb.", "Basin fill of eolian, lacustrine and/or volcanic origin; tectonically contracted.", "44"],
  ["HNb", "Hesperian and Noachian basin unit", [[-33.53, 59.53]], "Low-lying plains-forming deposit in Argyre and western Hellas Planitiae, at least hundreds of meters thick.", "Basin fill of eolian, lacustrine and/or volcanic origin; sinuous ridges in Argyre interpreted as inverted channels or eskers.", "40"],
  // Volcanic
  ["lAv", "Late Amazonian volcanic unit", [[26.27, 192.67]], "Planar deposits with lobate scarps hundreds to over 1,000 km long, meters to tens of meters thick; covers Amazonis Planitia and Marte Vallis.", "Largely unmodified flood lavas, sourced from fissures and shields.", "9, 21"],
  ["lAvf", "Late Amazonian volcanic field unit", [[-2.13, 253.85]], "Flows tens of km long from shields and fissure vents; central Tharsis rise and Cerberus Fossae.", "Largely unmodified lava flows and vents.", ""],
  ["Av", "Amazonian volcanic unit", [[34.82, 135.11]], "Rugged, hummocky, pitted fields of poorly defined flows forming plains hundreds to over 1,000 km across.", "Lava and perhaps volcaniclastic flows from Elysium Mons and an unknown source northwest of Olympus Mons.", "4"],
  ["AHv", "Amazonian and Hesperian volcanic unit", [[-22.76, 242.33]], "Stacked, gently sloping lobate flows hundreds of km long; forms most of the Tharsis and Elysium rises; cumulative thickness hundreds of meters to several km.", "Undifferentiated flood lavas from regional fissure and vent systems.", ""],
  ["lHv", "Late Hesperian volcanic unit", [[-18.84, 256.12]], "Lobate flows in patches hundreds to over 1,000 km across; Tharsis region, southwestern Hesperia Planum, Orcus Patera.", "Undifferentiated flood lavas from regional fissure and vent systems.", "17, 29"],
  ["lHvf", "Late Hesperian volcanic field unit", [[-12.31, 257.63]], "Patches of lobate flows from low shields and fissure vents; Syria Planum, western Tempe Terra, western Elysium Mons.", "Volcanoes and lava flows.", ""],
  ["eHv", "Early Hesperian volcanic unit", [[-25.34, 279.97]], "Planar high plains in and near Tharsis, Syrtis Major, Hesperia Planum and Gusev crater; marked by wrinkle ridges.", "Flood lavas from regional fissure and vent systems; tectonically contracted.", "38, 42"],
  ["lNv", "Late Noachian volcanic unit", [[-55.89, 67.99]], "Planar deposits in Malea and Thaumasia Plana, Icaria Fossae area and east of Hellas; some degraded craters, wrinkle ridges.", "Degraded lava and volcaniclastic flows; tectonically contracted.", "46, 47"],
  ["Ave", "Amazonian volcanic edifice", [[18.89, 225.86]], "Shield edifices hundreds of km across and several to over 10 km high: Olympus, Alba, Ascraeus, Pavonis and Arsia Montes.", "Volcanoes of lava flows and possible volcaniclastic rocks, deformed by summit collapse and gravity spreading of flanks.", ""],
  ["Hve", "Hesperian volcanic edifice unit", [[24.65, 146.80]], "Shield-like edifices tens to hundreds of km across, up to a few km thick; Tharsis and Elysium rises, Hadriacus Mons, Apollinaris Mons.", "Volcanic edifices of lava flows with pyroclastic and volcaniclastic deposits; modified by summit collapse and fluvial dissection.", ""],
  ["Nve", "Noachian volcanic edifice unit", [[-8.11, 174.50]], "Irregular edifices marked by troughs and peaks, up to a few km thick; Amphitrites and Peneus Paterae, Tyrrhenus Mons.", "Degraded volcanic edifices of lava, pyroclastic and volcaniclastic deposits; domed by intrusions and tectonically contracted.", ""],
  // Apron
  ["lAa", "Late Amazonian apron unit", [[4.33, 243.07]], "Concentrically ribbed, knobby lobes extending up to 500 km from shield edifices; meters to tens of meters thick.", "Drop moraines left by cold-based glaciers.", ""],
  ["Aa", "Amazonian apron unit", [[-8.04, 281.80], [30.17, 214.65]], "Lobes bounded by scarps with transverse ridges, up to 1,000 m thick; surrounds Olympus Mons and covers parts of Valles Marineris.", "Landslide and gravity-spreading deposits from Olympus Mons flanks and Valles Marineris walls.", ""],
  ["ANa", "Amazonian and Noachian apron unit", [[-43.22, 26.66]], "Irregular knobs and mesas with aprons hundreds of meters thick; Deuteronilus and Protonilus Mensae and east of Hellas.", "Ice-rich Amazonian materials over relict Noachian highland, modified by thermokarst.", ""],
  // Transition
  ["AHtu", "Amazonian and Hesperian transition undivided unit", [[-2.37, 240.33]], "Irregular layered plateaus hundreds to over 1,000 km across, up to ~3,000 m thick; dense linear ridges and grooves.", "Fine-grained eolian sediments and/or pyroclastic air-fall deposits; ridges and grooves form yardangs.", "25, 27, 30"],
  ["Htu", "Hesperian transition undivided unit", [[-6.41, 156.42], [-6.17, 286.05]], "Layered irregular plateaus hundreds of km across, hundreds of meters to kilometers thick; southern Elysium Planitia and Valles Marineris.", "Fine-grained eolian and/or pyroclastic sediments modified by fluvial dissection; includes hydrated sulfate signatures.", "26, 28"],
  ["lHt", "Late Hesperian transition unit", [[18.13, 117.11]], "Relatively smooth plains with small knobs and mesas, tens to hundreds of meters thick; along the highland/lowland boundary.", "Mass-wasting, fluvial/lacustrine and other sediments, possibly volcanic rocks; tectonically contracted.", "8, 15"],
  ["eHt", "Early Hesperian transition unit", [[13.38, 116.70]], "Undulating to moderately rugged plains with low knobs and mesas, tens to hundreds of meters thick; also Acidalia Mensa.", "Mass-wasting, fluvial/lacustrine and other sediments, possibly volcanic rocks; tectonically contracted.", "2, 16"],
  ["Ht", "Hesperian transition unit", [[1.75, 325.45]], "Knobs, mesas, aprons and plains in highland canyons and chaotic terrain, hundreds of meters thick; Xanthe and Margaritifer Terrae.", "Mixture of sediments and blocks of broken-up, mass-wasted and collapsed material.", ""],
  ["Hto", "Hesperian transition outflow unit", [[19.33, 326.45]], "Plains deposits dissected by anabranching channels, meters to tens of meters thick; Chryse Planitia. Mars Pathfinder landing site.", "Outflow channel fluvial and debris-flow deposits from catastrophic erosion of highland rocks.", "12"],
  ["HNt", "Hesperian and Noachian transition unit", [[10.96, 111.71]], "Knobs, mesas, aprons and plains along the highland/lowland boundary, tens to hundreds of meters thick.", "Noachian impact breccias, sediments and volcanics with Hesperian mass-wasted aprons; tectonically contracted.", "18"],
  // Highland
  ["HNhu", "Hesperian and Noachian highland undivided unit", [[5.97, 2.33]], "Mound-forming, light-toned, layered; hundreds of meters to several km thick; Meridiani Planum.", "Undifferentiated friable sedimentary, volcanic and impact rocks, altered by weathering; hydrated sulfate signatures.", "24"],
  ["Nhu", "Noachian highland undivided unit", [[-25.80, 288.53]], "Forms canyon walls, high plains and channel floors; layered, hundreds of meters to several km thick; Valles Marineris walls.", "Undifferentiated friable sedimentary, impact and volcanic materials; tectonically contracted in places.", "37"],
  ["eHh", "Early Hesperian highland unit", [[15.88, 293.44]], "Relatively smooth high plains extending hundreds of km, up to hundreds of meters thick; plateaus around the Tharsis rise.", "Undifferentiated impact, volcanic, eolian and fluvial/lacustrine materials.", ""],
  ["lNh", "Late Noachian highland unit", [[-20.74, 354.35]], "Mostly plains forming, rugged in places; common in highland depressions, may be hundreds of meters thick.", "Undifferentiated impact, volcanic, fluvial and basin material, lightly to heavily degraded and/or deformed.", "13, 34, 35"],
  ["mNh", "Middle Noachian highland unit", [[-47.17, 349.33]], "Uneven to rolling, high-relief outcrops, commonly layered in crater walls; extensive in the equatorial to southern highlands.", "Undifferentiated impact, volcanic, fluvial and basin materials, moderately to heavily degraded.", "7, 14, 19, 20, 22, 23, 31"],
  // The published type-area coordinates for eNh are identical to lNh; shifted 1.5 deg east here so both markers are visible.
  ["eNh", "Early Noachian highland unit", [[-20.74, 355.85]], "Rugged, very high-relief outcrops; thickness commonly exceeds a few km; densely cratered. (Published coordinates equal those of unit lNh; marker shifted 1.5 deg east for visibility.)", "Undifferentiated impact, volcanic, fluvial and basin materials, heavily degraded and tectonically deformed in places.", "33, 36"],
  ["Nhe", "Noachian highland edifice unit", [[-34.72, 214.85]], "Irregular edifices marked by troughs and peaks, a few km thick; southern highlands, mostly 30 to 70 deg S.", "Mainly undifferentiated, degraded volcanic materials.", ""],
  ["mNhm", "Middle Noachian highland massif unit", [[-44.48, 307.54]], "High-relief massifs tens of km across separated by broad linear troughs; surrounds Argyre and part of Isidis.", "Ancient crustal rocks uplifted by large basin-forming impacts.", ""],
  ["eNhm", "Early Noachian highland massif unit", [[-26.00, 63.24]], "High-relief massifs forming an annulus around most of Hellas Planitia, kilometers thick.", "Primitive, degraded crustal rocks uplifted by a large basin-forming impact.", "43, 45"]
];

UNITS.forEach(([label, name, sites, character, interpretation, localities]) => {
  const epoch = label.match(/[A-Z]/)[0];
  sites.forEach(([lat, lon]) => {
    PLACES.push({
      name: label + ": " + name,
      cat: "unit-" + epoch,
      lat, lon,
      info: "<b>Character:</b> " + character + "<br><b>Interpretation:</b> " + interpretation +
            (localities ? "<br><b>Crater-count localities:</b> " + localities : "") +
            "<br><small>Source: USGS SIM 3292 (Tanaka et al., 2014)</small>"
    });
  });
});

/* ---------- 2. Helpers ---------- */

const toLng = e => ((e + 180) % 360 + 360) % 360 - 180;   // 0..360 E  ->  -180..180
const toEast = lng => (lng + 360) % 360;

function makeIcon(cat, minor) {
  const c = CATEGORIES[cat];
  return L.divIcon({
    className: "",
    html: `<div style="color:${c.color};font-size:${cat.startsWith("unit-") ? 14 : (minor ? 13 : 20)}px;text-shadow:0 0 3px #000,0 0 6px #000;
                       transform:translate(-50%,-50%);line-height:1">${c.icon}</div>`,
    iconSize: [0, 0]
  });
}

/* ---------- 3. Map setup ---------- */

// The basemap image is equirectangular (plate carrée), so use Leaflet's EPSG:4326 CRS.
const map = L.map("map", {
  crs: L.CRS.EPSG4326,
  zoomSnap: 0.5,
  minZoom: 1,
  maxZoom: 8,
  maxBounds: [[-90, -180], [90, 180]],
  maxBoundsViscosity: 1.0
}).setView([46.7, toLng(339.2)], 3);   // Acidalia Planitia (46.7°N, 339.2°E)

// Because the map uses EPSG:4326, an image covering the whole globe maps linearly onto lat/lng bounds.
const baseLayer = L.imageOverlay(BASE_IMAGE.url, [[-90, -180], [90, 180]], {
  attribution: BASE_IMAGE.attribution
}).addTo(map);
baseLayer.on("error", () => {
  const n = document.getElementById("notice");
  n.textContent = "Could not load the base map image.";
  n.style.display = "block";
});

// Viking MDIM 2.1 color mosaic, tiled with gdal2tiles (--profile=geodetic, zoom 0-8).
// This gdal2tiles build numbers geodetic zoom N as 2^N tiles wide, while Leaflet's EPSG4326 zoom N is 2^(N+1) wide,
// so tile zoom = Leaflet zoom + 1 (zoomOffset: 1). gdal2tiles rows start at the bottom (tms).
const marsColor = L.tileLayer("mars_tiles/{z}/{x}/{y}.png", {
  tms: true,
  zoomOffset: 1,
  minNativeZoom: 0,
  maxNativeZoom: 7,   // = gdal zoom 8 - 1
  tileSize: 256,
  opacity: 0.9,
  noWrap: true,
  bounds: [[-90, -180], [90, 180]],
  attribution: "Viking MDIM 2.1 Color Mosaic (USGS)"
});

L.control.scale({ metric: true, imperial: false }).addTo(map);

// Mars graticule (every 30°)
const graticule = L.layerGroup();
for (let lng = -180; lng <= 180; lng += 30)
  L.polyline([[-90, lng], [90, lng]], { color: "#fff", weight: 1, opacity: 0.25, interactive: false }).addTo(graticule);
for (let lat = -60; lat <= 60; lat += 30)
  L.polyline([[lat, -180], [lat, 180]], { color: lat === 0 ? "#ffd180" : "#fff",
             weight: 1, opacity: lat === 0 ? 0.5 : 0.25, interactive: false }).addTo(graticule);
graticule.addTo(map);
L.control.layers(null, { "Geologic map": baseLayer, "Viking color mosaic": marsColor, "Grid": graticule }, { position: "topright" }).addTo(map);

/* ---------- 4. Markers, filters, search ---------- */

// Geologic-unit markers start hidden because the colored basemap already shows the units;
// tick them in the sidebar to see their descriptions.
const active = new Set(Object.keys(CATEGORIES).filter(k => !k.startsWith("unit-")));
const markers = new Map();

PLACES.forEach(p => {
  const lng = toLng(p.lon);
  const m = L.marker([p.lat, lng], { icon: makeIcon(p.cat, p.minor), title: p.name });
  m.bindPopup(`<h3>${p.name}</h3><em>${CATEGORIES[p.cat].label}</em><p>${p.info}</p>
               <small>${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°E</small>`, { maxWidth: 320 });
  markers.set(p, m);
});

const filtersEl = document.getElementById("filters");
Object.entries(CATEGORIES).forEach(([key, c]) => {
  const label = document.createElement("label");
  label.innerHTML = `<input type="checkbox" ${active.has(key) ? "checked" : ""}> <span style="color:${c.color}">${c.icon}</span> ${c.label}`;
  label.querySelector("input").addEventListener("change", e => {
    e.target.checked ? active.add(key) : active.delete(key);
    refresh();
  });
  filtersEl.appendChild(label);
});

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
searchEl.addEventListener("input", refresh);

function refresh() {
  const q = searchEl.value.trim().toLowerCase();
  listEl.innerHTML = "";
  PLACES.forEach(p => {
    const m = markers.get(p);
    const visible = active.has(p.cat) && (!q || (p.name + " " + p.info).toLowerCase().includes(q));
    if (visible) {
      m.addTo(map);
      const li = document.createElement("li");
      li.innerHTML = `${p.name}<small>${CATEGORIES[p.cat].label}</small>`;
      li.addEventListener("click", () => {
        map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 4), { duration: 1.2 });
        m.openPopup();
      });
      listEl.appendChild(li);
    } else {
      map.removeLayer(m);
    }
  });
}
refresh();

/* ---------- 5. Cursor coordinates ---------- */

const coordsEl = document.getElementById("coords");
map.on("mousemove", e => {
  const lat = Math.max(-90, Math.min(90, e.latlng.lat));
  coordsEl.textContent = `Lat ${lat.toFixed(2)}°, Lon ${toEast(e.latlng.lng).toFixed(2)}°E`;
});
/* ---------- 6. Integration with MAЯPS (postMessage) ---------- */

let mapMode = 'browse';   // 'browse' | 'landing-selection' | 'exploration'
const landingLayer = L.layerGroup().addTo(map);

function sendToApp(type, payload) {
  window.parent.postMessage({ type, payload }, window.location.origin);
}

// Click on the map: in landing-selection mode it reports the chosen point (longitude 0-360).
map.on("click", e => {
  if (mapMode !== "landing-selection") return;
  const lat = Math.max(-90, Math.min(90, e.latlng.lat));
  sendToApp("LANDING_LOCATION_SELECTED", {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(toEast(e.latlng.lng).toFixed(6)),
    elevation: null   // the application computes the elevation from its own DEM
  });
});

function drawLanding(p) {
  landingLayer.clearLayers();
  if (!p) return;
  const add = (pt, color, text, radius, fillOpacity) => {
    if (!pt) return;
    L.circleMarker([pt.latitude, toLng(pt.longitude)], {
      radius, color, weight: 2, fillColor: color, fillOpacity
    }).bindTooltip(text).addTo(landingLayer);
  };
  // Drawing order matters: the LiDAR estimate is only a few metres from the actual position, so it is
  // drawn first as a larger ring and the actual position is drawn on top as a small solid dot.
  add(p.lidar, "#4ade9b", "LiDAR position", 12, 0.08);
  add(p.planned, "#22d3d8", "Planned landing", 7, 0.5);
  add(p.actual, "#f2b84b", "Actual landing", 5, 0.9);
}
const positionLayer = L.layerGroup().addTo(map); 

let astronautMarker = null; 

let vehicleMarker = null; 

  

function setPositionMarker(existing, payload, color, text, radius) { 

  const valid = payload && typeof payload.latitude === "number" && typeof payload.longitude === "number"; 

  if (!valid) { 

    if (existing) positionLayer.removeLayer(existing); 

    return null; 

  } 

  const latlng = [payload.latitude, toLng(payload.longitude)]; 

  if (existing) { 

    existing.setLatLng(latlng); 

    return existing; 

  } 

  return L.circleMarker(latlng, { radius, color, weight: 2, fillColor: color, fillOpacity: 0.9 }) 

    .bindTooltip(text).addTo(positionLayer); 

} 
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "SET_MAP_MODE":
      if (msg.payload && typeof msg.payload.mode === "string") mapMode = msg.payload.mode;
      map.getContainer().style.cursor = mapMode === "landing-selection" ? "crosshair" : "";
      break;
    case "UPDATE_LANDING":
      drawLanding(msg.payload);
      break;
      case "UPDATE_VEHICLE_POSITION": 

      vehicleMarker = setPositionMarker(vehicleMarker, msg.payload, "#ff9800", "Vehicle", 9); 

      break; 

    case "UPDATE_ASTRONAUT_POSITION": 

      astronautMarker = setPositionMarker(astronautMarker, msg.payload, "#ffffff", "Astronaut", 5); 

      break; 
    case "MAP_SHOWN":
      map.invalidateSize();
      break;
    default:
      // Other layers (terrain, route, obstacles, scientific points, positions) are added in later stages.
      break;
  }
});

// Tell the application the map is ready. It is sent at the end of init(), when Leaflet already exists.
sendToApp("MAP_READY", null);

} // end init