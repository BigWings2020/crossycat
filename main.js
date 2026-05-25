import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ===== Constants =====
const TILE = 1;
const HOP_MS = 140;
const BACK_LIMIT = 6;
const VIEW_HALF_X     = 18;
const OBSTACLE_HALF_X = 15;
const VEHICLE_HALF_X  = 16;
const CAM_OFFSET = new THREE.Vector3(3, 12, 8);
const CAM_LOOK_AHEAD_Z = -3;
// Dynamic zoom: fast forward progress → zoom out (camera.zoom = 1, the
// authored framing). Idle / lateral-only → zoom in toward 2× (closer).
const CAM_ZOOM_OUT = 1.0;
const CAM_ZOOM_IN  = 2.0; // max zoom in: 1.0x more than the original framing (2× closer)
const PROGRESS_TARGET    = 3.0; // tiles/sec of forward motion that maps to full zoom-out
// Asymmetric EMA: the running average DECAYS (zoom-in direction) twice as fast
// as it RAMPS UP (zoom-out direction), so sitting still penalises you more
// than catching up does — sustained forward motion is needed to stay zoomed out.
const PROGRESS_SMOOTHING_RAMP  = 0.4;
const PROGRESS_SMOOTHING_DECAY = 0.8;
// Spring-damped zoom for momentum: critically damped so it doesn't oscillate.
const ZOOM_STIFFNESS = 1.6;
const ZOOM_DAMPING   = 2.0 * Math.sqrt(ZOOM_STIFFNESS);
const TRAIN_WARN_TIME = 1.6;
const LOG_REST_REL = -0.20; // resting log depth below the water surface
const LOG_SINK_REL = -0.07; // extra dip when the cat is standing on the log
const CAT_LOG_LIFT =  0.40; // extra height the (now-smaller) cat sits above the log's pivot
const RAILROAD_LIFT = 0.06; // railroad lane sits this much above the base ground
const WATER_DROP    = -0.20; // water lane sits this much below (doubled again)
const GROUND_WIDTH = VIEW_HALF_X * 2 + 4;
const LANE_THICKNESS = 0.4; // each lane is a block this tall; sides fill the step at elevation changes
function laneSurfaceY(type) {
  if (type === 'railroad') return RAILROAD_LIFT;
  if (type === 'water')    return WATER_DROP;
  return 0;
}

const GRASS_BLADES_MAX     = 2400;
const FLOWERS_PER_COLOR_MAX = 360;

// ===== Scene =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bd4ff);
scene.fog = new THREE.Fog(0x9bd4ff, 26, 46);

const aspect = innerWidth / innerHeight;
const camSize = 7;
const camera = new THREE.OrthographicCamera(
  -camSize * aspect, camSize * aspect, camSize, -camSize, 0.1, 140
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

addEventListener('resize', () => {
  const a = innerWidth / innerHeight;
  camera.left = -camSize * a;
  camera.right = camSize * a;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ===== IBL environment (so MeshStandardMaterial GLBs aren't pitch black) =====
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 1.2;

// ===== Lights =====
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
scene.add(new THREE.HemisphereLight(0xc0e6ff, 0x4d6b2e, 0.55));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22;
sun.shadow.camera.right = 22;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -24;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 90;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const sunTarget = new THREE.Object3D();
scene.add(sunTarget);
sun.target = sunTarget;

// Soft cool fill from the opposite side
const fill = new THREE.DirectionalLight(0xb8d4ff, 0.25);
fill.position.set(-15, 18, -10);
scene.add(fill);

// ===== Hash =====
function hashRand(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ===== Water shader (two textured layers at different scales + speeds) =====
const WATER_TEX_SCALE_A     = 4.0;   // world units per repeat for layer A
const WATER_TEX_SCALE_B     = 5.5;   // layer B uses a larger tile so the two patterns drift
const WATER_LAYER_B_SPEED   = 0.7;   // layer B scrolls slightly slower than the logs (which match layer A = 1.0)
const waterTexBase = new THREE.TextureLoader().load('water.png');
waterTexBase.wrapS = waterTexBase.wrapT = THREE.RepeatWrapping;
waterTexBase.colorSpace = THREE.SRGBColorSpace;
waterTexBase.anisotropy = 8;

const waterVertexShader = `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const waterFragmentShader = `
  uniform sampler2D map;
  uniform vec2 uScaleA;
  uniform vec2 uScaleB;
  uniform vec2 uOffsetA;
  uniform vec2 uOffsetB;
  varying vec3 vWorld;
  void main() {
    vec2 uvA = vWorld.xz * uScaleA + uOffsetA;
    vec2 uvB = vWorld.xz * uScaleB + uOffsetB;
    vec3 colA = texture2D(map, uvA).rgb;
    vec3 colB = texture2D(map, uvB).rgb;
    // Soft additive blend: average the two layers, then boost where both
    // are bright (caustic-on-caustic intersection) for a shimmer effect.
    vec3 col = (colA + colB) * 0.5;
    float ca = max(0.0, dot(colA, vec3(0.333)) - 0.6);
    float cb = max(0.0, dot(colB, vec3(0.333)) - 0.6);
    col += vec3(ca * cb * 6.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeWaterMaterialForLane() {
  return new THREE.ShaderMaterial({
    uniforms: {
      map:      { value: waterTexBase },
      uScaleA:  { value: new THREE.Vector2(1 / WATER_TEX_SCALE_A, 1 / WATER_TEX_SCALE_A) },
      uScaleB:  { value: new THREE.Vector2(1 / WATER_TEX_SCALE_B, 1 / WATER_TEX_SCALE_B) },
      uOffsetA: { value: new THREE.Vector2(0, 0) },
      uOffsetB: { value: new THREE.Vector2(0.37, 0.19) }, // start B out of phase
    },
    vertexShader: waterVertexShader,
    fragmentShader: waterFragmentShader,
  });
}

function updateWaterTextures(camX, dt) {
  for (const lane of lanes.values()) {
    if (lane.type !== 'water' || !lane.waterMat) continue;
    const u = lane.waterMat.uniforms;
    // Decrease offset.x to make the sampled texture content drift in +lane.dir.
    u.uOffsetA.value.x -= lane.dir * lane.speed * dt / WATER_TEX_SCALE_A;
    u.uOffsetB.value.x -= lane.dir * lane.speed * WATER_LAYER_B_SPEED * dt / WATER_TEX_SCALE_B;
  }
}

// ===== Water wall texture (stone wall around the water trench) =====
const waterWallTex = new THREE.TextureLoader().load('water_wall.png');
waterWallTex.wrapS = waterWallTex.wrapT = THREE.RepeatWrapping;
waterWallTex.colorSpace = THREE.SRGBColorSpace;
waterWallTex.anisotropy = 8;
// 20 reps across GROUND_WIDTH → each repeat covers 2 world units. Texture's
// V (height) is meant to be the full wall height in one go: moss/water line
// at the bottom, stone blocks at the top.
waterWallTex.repeat.set(20, 1);
const waterWallMat = new THREE.MeshLambertMaterial({ map: waterWallTex });

function updateWaterWallTexture(camX) {
  // Each repeat covers 2 world units (GROUND_WIDTH / repeat.x = 40/20). Cancel
  // the lane group's integer snap so the wall pattern stays anchored in world.
  waterWallTex.offset.x = (Math.round(camX) - GROUND_WIDTH / 2) / 2;
}

// ===== Road texture (curbs + asphalt baked in) =====
const ROAD_TEX_SCALE_X = 2.7; // matches the source aspect (~2.7:1) for no horizontal stretch
const ROAD_TEX_SCALE_Y = 1;
const roadTexBase = new THREE.TextureLoader().load('road.png');
roadTexBase.wrapS = roadTexBase.wrapT = THREE.RepeatWrapping;
roadTexBase.colorSpace = THREE.SRGBColorSpace;
roadTexBase.anisotropy = 8;

function makeRoadTextureForLane() {
  const tex = roadTexBase.clone();
  tex.needsUpdate = true;
  tex.repeat.set(GROUND_WIDTH / ROAD_TEX_SCALE_X, TILE / ROAD_TEX_SCALE_Y);
  return tex;
}

function updateRoadTextures(camX) {
  const offsetX = (Math.round(camX) - GROUND_WIDTH / 2) / ROAD_TEX_SCALE_X;
  for (const lane of lanes.values()) {
    if (lane.roadTex) lane.roadTex.offset.x = offsetX;
  }
}

// ===== Railroad texture (single shared material — every railroad lane looks identical) =====
const RAIL_TEX_SCALE_X = 3; // each repeat covers ~3 world units → ~13 reps per lane
const railroadTex = new THREE.TextureLoader().load('railroad.png');
railroadTex.wrapS = railroadTex.wrapT = THREE.RepeatWrapping;
railroadTex.colorSpace = THREE.SRGBColorSpace;
railroadTex.anisotropy = 8;
// Show the entire texture height in one lane so the ballast on both sides
// of the rails is visible (no cropping).
railroadTex.repeat.set(GROUND_WIDTH / RAIL_TEX_SCALE_X, 1);
railroadTex.offset.set(0, 0);
const railroadMat = new THREE.MeshLambertMaterial({ map: railroadTex });
railroadMat.color.setRGB(1.3, 1.3, 1.3); // boost brightness above 1×

function updateRailroadTexture(camX) {
  railroadTex.offset.x = (Math.round(camX) - GROUND_WIDTH / 2) / RAIL_TEX_SCALE_X;
}

// ===== Meadow grass texture =====
// One square texture instance spans MEADOW_TEX_SCALE world units in BOTH axes
// (aspect preserved = no stretching). Each grass lane is 1 unit deep so it
// only shows a 1/MEADOW_TEX_SCALE slice — different lanes sample different
// slices via per-lane texture clones whose offsets are anchored to world Z.
// Walk forward across grass and you see the whole texture, continuously.
const MEADOW_TEX_SCALE = 8;
const meadowTexBase = new THREE.TextureLoader().load('meadow.png');
meadowTexBase.wrapS = meadowTexBase.wrapT = THREE.RepeatWrapping;
meadowTexBase.colorSpace = THREE.SRGBColorSpace;
meadowTexBase.anisotropy = 8;

function makeMeadowTextureForLane(z) {
  const tex = meadowTexBase.clone();
  tex.needsUpdate = true;
  // Negative repeat.y flips V so the texture continues across adjacent lanes
  // without mirroring (the plane's local +y maps to world -z after rotation).
  tex.repeat.set(GROUND_WIDTH / MEADOW_TEX_SCALE, -TILE / MEADOW_TEX_SCALE);
  tex.offset.y = (z + 0.5 * TILE) / MEADOW_TEX_SCALE;
  return tex;
}

function updateMeadowTexture(camX) {
  const offsetX = (Math.round(camX) - GROUND_WIDTH / 2) / MEADOW_TEX_SCALE;
  for (const lane of lanes.values()) {
    if (lane.meadowTex) lane.meadowTex.offset.x = offsetX;
  }
}

// ===== Shared materials =====
const M = {
  orange:    new THREE.MeshLambertMaterial({ color: 0xff9a3c }),
  catWhite:  new THREE.MeshLambertMaterial({ color: 0xfff1d6 }),
  catStripe: new THREE.MeshLambertMaterial({ color: 0xb84e15 }),
  black:     new THREE.MeshLambertMaterial({ color: 0x1a1a1a }),
  pink:      new THREE.MeshLambertMaterial({ color: 0xff9aaa }),
  trunk:     new THREE.MeshLambertMaterial({ color: 0x6a3f1c }),
  trunkRing: new THREE.MeshLambertMaterial({ color: 0x8a5a30 }),
  pineA:     new THREE.MeshLambertMaterial({ color: 0x2a7036 }),
  pineB:     new THREE.MeshLambertMaterial({ color: 0x1f5a28 }),
  leafA:     new THREE.MeshLambertMaterial({ color: 0x40a04a }),
  leafB:     new THREE.MeshLambertMaterial({ color: 0x368a3e }),
  bushA:     new THREE.MeshLambertMaterial({ color: 0x357f37 }),
  bushB:     new THREE.MeshLambertMaterial({ color: 0x2b6b2c }),
  bladeA:    new THREE.MeshLambertMaterial({ color: 0x3f9c3c }),
  rock:      new THREE.MeshLambertMaterial({ color: 0x9a9a9a }),
  stone:     new THREE.MeshLambertMaterial({ color: 0x787878 }),
  stoneDark: new THREE.MeshLambertMaterial({ color: 0x5e5e5e }),
  grassA:    new THREE.MeshLambertMaterial({ color: 0x69b834 }),
  grassB:    new THREE.MeshLambertMaterial({ color: 0x5fa92e }),
  sideGrass: new THREE.MeshLambertMaterial({ color: 0x5a3f25 }),
  sideRoad:  new THREE.MeshLambertMaterial({ color: 0x222226 }),
  sideWater: new THREE.MeshLambertMaterial({ color: 0x174d78 }),
  sideRail:  new THREE.MeshLambertMaterial({ color: 0x352a1f }),
  road:      new THREE.MeshLambertMaterial({ color: 0x3c3c42 }),
  roadDark:  new THREE.MeshLambertMaterial({ color: 0x2f2f34 }),
  rail:      new THREE.MeshLambertMaterial({ color: 0x8a6a45 }),
  trackMetal:new THREE.MeshLambertMaterial({ color: 0x2a2a2a }),
  tie:       new THREE.MeshLambertMaterial({ color: 0x4a311e }),
  tieLight:  new THREE.MeshLambertMaterial({ color: 0x5e4028 }),
  line:      new THREE.MeshBasicMaterial({ color: 0xffeb88 }),
  win:       new THREE.MeshLambertMaterial({ color: 0xb6dfff }),
  pole:      new THREE.MeshLambertMaterial({ color: 0x4a4a4a }),
  signalBox: new THREE.MeshLambertMaterial({ color: 0x202020 }),
  sigGreen:  new THREE.MeshLambertMaterial({ color: 0x55ff55, emissive: 0x22aa22, emissiveIntensity: 1.5 }),
  sigRed:    new THREE.MeshLambertMaterial({ color: 0xff3030, emissive: 0xdd1010, emissiveIntensity: 2.0 }),
  sigRedDim: new THREE.MeshLambertMaterial({ color: 0x661111, emissive: 0x330808, emissiveIntensity: 1.0 }),
  flowerW:   new THREE.MeshLambertMaterial({ color: 0xffffff }),
  flowerY:   new THREE.MeshLambertMaterial({ color: 0xffd84a }),
  flowerP:   new THREE.MeshLambertMaterial({ color: 0xc774ff }),
};

// ===== Cat =====
function buildCat() {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.7), M.orange);
  body.position.y = 0.4;
  body.castShadow = true;
  g.add(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.5), M.catWhite);
  belly.position.set(0, 0.3, 0);
  g.add(belly);

  for (let i = 0; i < 4; i++) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.05), M.catStripe);
    stripe.position.set(0, 0.58, -0.22 + i * 0.13);
    g.add(stripe);
  }

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.45), M.orange);
  head.position.set(0, 0.72, -0.4);
  head.castShadow = true;
  g.add(head);

  const face = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.28, 0.04), M.catWhite);
  face.position.set(0, 0.68, -0.628);
  g.add(face);

  const earGeo = new THREE.ConeGeometry(0.14, 0.28, 4);
  const earL = new THREE.Mesh(earGeo, M.orange);
  earL.position.set(-0.17, 1.07, -0.4);
  earL.rotation.y = Math.PI / 4;
  g.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.17;
  g.add(earR);

  const innerEarGeo = new THREE.ConeGeometry(0.07, 0.16, 4);
  const innerL = new THREE.Mesh(innerEarGeo, M.pink);
  innerL.position.set(-0.17, 1.02, -0.4);
  innerL.rotation.y = Math.PI / 4;
  g.add(innerL);
  const innerR = innerL.clone();
  innerR.position.x = 0.17;
  g.add(innerR);

  const eyeGeo = new THREE.BoxGeometry(0.09, 0.09, 0.04);
  const eyeL = new THREE.Mesh(eyeGeo, M.black);
  eyeL.position.set(-0.13, 0.78, -0.65);
  g.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.13;
  g.add(eyeR);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.04), M.pink);
  nose.position.set(0, 0.62, -0.65);
  g.add(nose);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.55), M.orange);
  tail.position.set(0, 0.55, 0.55);
  tail.rotation.x = -0.5;
  g.add(tail);
  const tailTip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), M.catWhite);
  tailTip.position.set(0, 0.72, 0.82);
  g.add(tailTip);

  const legGeo = new THREE.BoxGeometry(0.12, 0.22, 0.12);
  for (const [x, z] of [[-0.18, -0.25], [0.18, -0.25], [-0.18, 0.25], [0.18, 0.25]]) {
    const leg = new THREE.Mesh(legGeo, M.orange);
    leg.position.set(x, 0.11, z);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

// ===== Trees =====
function buildPineTree(seed) {
  // Prefer the GLB tree once it's loaded. Each instance gets a yaw and a
  // small size variation so the forest doesn't look like one cloned model.
  if (treeTemplate) {
    const t = treeTemplate.clone(true);
    t.scale.multiplyScalar(0.5 + seed * 1.5); // 0.5x–2.0x size variation
    return t;
  }
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.4, 0.24), M.trunk);
  trunk.position.y = 0.2;
  trunk.castShadow = true;
  g.add(trunk);

  const useLight = seed < 0.5;
  const leafMat = useLight ? M.pineA : M.pineB;
  const layers = [
    { size: 0.95, h: 0.45, y: 0.4 },
    { size: 0.78, h: 0.42, y: 0.78 },
    { size: 0.58, h: 0.40, y: 1.12 },
    { size: 0.34, h: 0.36, y: 1.44 },
  ];
  for (const l of layers) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(l.size, l.h, l.size), leafMat);
    m.position.y = l.y;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

function buildLeafyTree(seed) {
  if (tree2Template) {
    const t = tree2Template.clone(true);
    t.scale.multiplyScalar(0.5 + seed * 1.5); // same 0.5×–2.0× range as the pine
    return t;
  }
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.55, 0.28), M.trunk);
  trunk.position.y = 0.275;
  trunk.castShadow = true;
  g.add(trunk);
  const leafMat = seed < 0.5 ? M.leafA : M.leafB;
  const clusters = [
    [0, 0.92, 0, 0.85],
    [-0.32, 0.92, 0, 0.5],
    [0.32, 0.92, 0, 0.5],
    [0, 0.92, -0.32, 0.5],
    [0, 0.92, 0.32, 0.5],
    [0, 1.32, 0, 0.55],
  ];
  for (const [dx, dy, dz, s] of clusters) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), leafMat);
    m.position.set(dx, dy, dz);
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

function buildBush(seed) {
  if (bushTemplate) {
    const b = bushTemplate.clone(true);
    b.scale.multiplyScalar(0.7 + seed * 0.8); // 0.7×–1.5× variation
    return b;
  }
  const g = new THREE.Group();
  const mat = seed < 0.5 ? M.bushA : M.bushB;
  const main = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.55, 0.75), mat);
  main.position.y = 0.275;
  main.castShadow = true;
  g.add(main);
  if (seed > 0.35) {
    const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.35), mat);
    tuft.position.set(0.25, 0.55, -0.18);
    tuft.castShadow = true;
    g.add(tuft);
  }
  return g;
}

function buildRock(seed) {
  const g = new THREE.Group();
  const r = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.5), M.rock);
  r.position.y = 0.16;
  r.castShadow = true;
  g.add(r);
  if (seed > 0.5) {
    const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.25), M.stone);
    r2.position.set(-0.2, 0.1, 0.2);
    r2.castShadow = true;
    g.add(r2);
  }
  return g;
}

// ===== Vehicles =====
const carPalette = [0xff3344, 0x2aa1ff, 0xffd536, 0xb766ff, 0x39d978, 0xff7740];
function buildCar() {
  const g = new THREE.Group();
  const color = carPalette[Math.floor(Math.random() * carPalette.length)];
  const carMat = new THREE.MeshLambertMaterial({ color });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.32, 0.7), carMat);
  body.position.y = 0.3;
  body.castShadow = true;
  g.add(body);

  const top = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.3, 0.65), carMat);
  top.position.set(-0.15, 0.62, 0);
  top.castShadow = true;
  g.add(top);

  const win = new THREE.Mesh(new THREE.BoxGeometry(0.77, 0.22, 0.66), M.win);
  win.position.set(-0.15, 0.62, 0);
  g.add(win);

  const wheelGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.18, 12);
  for (const [x, z] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
    const w = new THREE.Mesh(wheelGeo, M.black);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.14, z);
    g.add(w);
  }

  const lightMat = new THREE.MeshLambertMaterial({ color: 0xfff5b8, emissive: 0xffa040, emissiveIntensity: 1.2 });
  for (const z of [-0.25, 0.25]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.05), lightMat);
    l.position.set(0.68, 0.3, z);
    g.add(l);
  }
  // Tail lights
  const tailMat = new THREE.MeshLambertMaterial({ color: 0xff5050, emissive: 0x991010, emissiveIntensity: 1.0 });
  for (const z of [-0.25, 0.25]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.04), tailMat);
    l.position.set(-0.82, 0.32, z);
    g.add(l);
  }

  g.userData.width = 1.4;
  return g;
}

// ===== GLB vehicles =====
const carTemplates = []; // [{ template, weight }] — weight controls spawn frequency
let semiTemplate = null;

// Generic preprocessing: rotate long axis onto X, center on origin, rest on
// ground, and scale so the X length matches `targetLen`. `forwardSign` picks
// which way the model points in its local frame (+1 if its natural forward
// is +Z, -1 if -Z). The matching rotation is +π/2 or -π/2 around Y.
function preprocessVehicleGLB(gltfScene, targetLen, forwardSign = +1, colorTint = null) {
  gltfScene.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        // These GLBs default to metallicFactor=1, so the env map dominates
        // and the base color texture barely shows. Force a flat diffuse look.
        if (m.isMeshStandardMaterial) {
          m.metalness = 0;
          m.roughness = 0.85;
          // Optional per-channel tint: pass a Color where dropping one channel
          // more than the others both dims the model AND pushes its hue
          // further from white (more apparent saturation).
          if (colorTint) m.color.multiply(colorTint);
        }
      }
    }
  });

  const wrapper = new THREE.Group();
  wrapper.add(gltfScene);

  const box0 = new THREE.Box3().setFromObject(gltfScene);
  const size0 = box0.getSize(new THREE.Vector3());

  if (size0.z > size0.x) {
    gltfScene.rotation.y = forwardSign * Math.PI / 2;
  }
  gltfScene.updateMatrixWorld(true);

  const box1 = new THREE.Box3().setFromObject(gltfScene);
  const size1 = box1.getSize(new THREE.Vector3());
  const center1 = box1.getCenter(new THREE.Vector3());
  gltfScene.position.x = -center1.x;
  gltfScene.position.y = -box1.min.y;
  gltfScene.position.z = -center1.z;

  const scale = targetLen / Math.max(0.001, size1.x);
  wrapper.scale.setScalar(scale);
  wrapper.userData.width = targetLen;
  return wrapper;
}

function makeCarMesh() {
  if (carTemplates.length > 0) {
    const total = carTemplates.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    let picked = carTemplates[0];
    for (const e of carTemplates) {
      r -= e.weight;
      if (r <= 0) { picked = e; break; }
    }
    const c = picked.template.clone(true);
    c.userData.width = picked.template.userData.width;
    return c;
  }
  return buildCar();
}

function makeTruckMesh() {
  if (semiTemplate) {
    const c = semiTemplate.clone(true);
    c.userData.width = semiTemplate.userData.width;
    return c;
  }
  return buildTruck();
}

// Swap any placeholder procedural meshes for the freshly-loaded GLB once it lands.
function swapVehiclesOfKind(kind, makeFn) {
  for (const lane of lanes.values()) {
    if (lane.type !== 'road') continue;
    for (const v of lane.vehicles) {
      if (v.kind !== kind) continue;
      const replacement = makeFn();
      replacement.position.copy(v.mesh.position);
      replacement.rotation.y = v.mesh.rotation.y;
      scene.remove(v.mesh);
      scene.add(replacement);
      v.mesh = replacement;
      v.w = replacement.userData.width;
    }
  }
}

const gltfLoader = new GLTFLoader();
gltfLoader.load(
  'Cab.glb',
  (gltf) => {
    // Darker + more saturated yellow: cut R/G to 0.75 and B further to 0.5,
    // which pushes the cab's color away from white toward true yellow.
    carTemplates.push({
      template: preprocessVehicleGLB(gltf.scene, 1.4, +1, new THREE.Color(0.75, 0.75, 0.5)),
      weight: 1.0,
    });
    swapVehiclesOfKind('car', makeCarMesh);
  },
  undefined,
  (err) => console.error('Failed to load Cab.glb', err)
);
gltfLoader.load(
  'Car_Green.glb',
  (gltf) => {
    carTemplates.push({ template: preprocessVehicleGLB(gltf.scene, 1.4, +1), weight: 1.0 });
    swapVehiclesOfKind('car', makeCarMesh);
  },
  undefined,
  (err) => console.error('Failed to load Car_Green.glb', err)
);
gltfLoader.load(
  'van.glb',
  (gltf) => {
    // Slightly longer than the cab/car_green to read as a van.
    carTemplates.push({ template: preprocessVehicleGLB(gltf.scene, 1.7, +1), weight: 1.0 });
    swapVehiclesOfKind('car', makeCarMesh);
  },
  undefined,
  (err) => console.error('Failed to load van.glb', err)
);
gltfLoader.load(
  'sportscar.glb',
  (gltf) => {
    // Low-slung sports car — slightly shorter than a sedan, and weight 0.25
    // means it shows up roughly 1/13 of car spawns (vs ~1/4 for the common ones).
    carTemplates.push({ template: preprocessVehicleGLB(gltf.scene, 1.485, +1), weight: 0.25 });
    swapVehiclesOfKind('car', makeCarMesh);
  },
  undefined,
  (err) => console.error('Failed to load sportscar.glb', err)
);
gltfLoader.load(
  'semi.glb',
  (gltf) => {
    semiTemplate = preprocessVehicleGLB(gltf.scene, 2.8, +1);
    swapVehiclesOfKind('truck', makeTruckMesh);
  },
  undefined,
  (err) => console.error('Failed to load semi.glb', err)
);
gltfLoader.load(
  'freight_locomotive.glb',
  // 1.2× scale: locomotive target length 3.2 * 1.2 = 3.84
  (gltf) => { locomotiveTemplate = preprocessVehicleGLB(gltf.scene, 3.84, +1); },
  undefined,
  (err) => console.error('Failed to load freight_locomotive.glb', err)
);
gltfLoader.load(
  'freight_car1.glb',
  // 1.2× scale: freight car target length 2.6 * 1.2 = 3.12
  (gltf) => { freightCarTemplate = preprocessVehicleGLB(gltf.scene, 3.12, +1); },
  undefined,
  (err) => console.error('Failed to load freight_car1.glb', err)
);
gltfLoader.load(
  'freight_car2.glb',
  // Same target length as freight_car1 so they slot interchangeably into a train.
  (gltf) => { freightCar2Template = preprocessVehicleGLB(gltf.scene, 3.12, +1); },
  undefined,
  (err) => console.error('Failed to load freight_car2.glb', err)
);

// ===== Tree GLBs (replace the procedural pine + leafy trees) =====
let treeTemplate = null;
let tree2Template = null;
let bushTemplate = null;

function preprocessTreeGLB(gltfScene, targetH) {
  gltfScene.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.isMeshStandardMaterial) {
          m.metalness = 0;
          m.roughness = 0.85;
        }
      }
    }
  });

  const wrapper = new THREE.Group();
  wrapper.add(gltfScene);

  const box = new THREE.Box3().setFromObject(gltfScene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  gltfScene.position.x = -center.x;
  gltfScene.position.y = -box.min.y; // sit on the ground (y = 0)
  gltfScene.position.z = -center.z;

  wrapper.scale.setScalar(targetH / Math.max(0.001, size.y));
  return wrapper;
}

function refreshAllGrassObstacles() {
  for (const lane of lanes.values()) {
    if (lane.type !== 'grass') continue;
    for (const mesh of lane.obstacleMeshes.values()) scene.remove(mesh);
    lane.obstacleMeshes.clear();
  }
}

gltfLoader.load(
  'tree.glb?v=3',
  (gltf) => {
    console.log('tree.glb loaded:', gltf.scene);
    treeTemplate = preprocessTreeGLB(gltf.scene, 1.6);
    // Clear out every existing tree mesh; the sliding-window updater will
    // immediately repopulate them, this time as clones of the GLB template.
    refreshAllGrassObstacles();
  },
  undefined,
  (err) => console.error('Failed to load tree.glb', err)
);

gltfLoader.load(
  'tree2.glb',
  (gltf) => {
    console.log('tree2.glb loaded:', gltf.scene);
    tree2Template = preprocessTreeGLB(gltf.scene, 1.6);
    refreshAllGrassObstacles();
  },
  undefined,
  (err) => console.error('Failed to load tree2.glb', err)
);

gltfLoader.load(
  'bush.glb',
  (gltf) => {
    console.log('bush.glb loaded:', gltf.scene);
    // Bushes are short and wide, ~0.5 units tall.
    bushTemplate = preprocessTreeGLB(gltf.scene, 0.5);
    refreshAllGrassObstacles();
  },
  undefined,
  (err) => console.error('Failed to load bush.glb', err)
);

// ===== Direction sign GLBs =====
// Loaded as templates that get cloned per-sign-tile; each clone keeps a
// `signKind` ('left' | 'right' | 'uturn') so the pickup handler knows how
// much to rotate the camera by.
const signTemplates = { left: null, right: null, uturn: null };

function loadSign(kind, file) {
  gltfLoader.load(
    file,
    (gltf) => {
      signTemplates[kind] = preprocessTreeGLB(gltf.scene, 1.8);
      // Late-arriving template: flush any debug spawns that were waiting on it.
      if (typeof spawnDebugStartSigns === 'function') spawnDebugStartSigns();
    },
    undefined,
    (err) => console.error('Failed to load ' + file, err)
  );
}
loadSign('left',  'sign_left.glb');
loadSign('right', 'sign_right.glb');
loadSign('uturn', 'sign_uturn.glb');

function buildTruck() {
  const g = new THREE.Group();
  const trailerColor = [0xeeeeee, 0xe6c042, 0xff8855, 0x7ec8ff][Math.floor(Math.random() * 4)];
  const cabMat = new THREE.MeshLambertMaterial({ color: 0x2a3a55 });
  const trailerMat = new THREE.MeshLambertMaterial({ color: trailerColor });

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 0.7), cabMat);
  cab.position.set(0.65, 0.5, 0);
  cab.castShadow = true;
  g.add(cab);

  const win = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.72), M.win);
  win.position.set(0.6, 0.68, 0);
  g.add(win);

  const trailer = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.75, 0.75), trailerMat);
  trailer.position.set(-0.45, 0.5, 0);
  trailer.castShadow = true;
  g.add(trailer);

  const wheelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.18, 12);
  for (const [x, z] of [[-0.95, -0.42], [-0.95, 0.42], [-0.35, -0.42], [-0.35, 0.42], [0.7, -0.42], [0.7, 0.42]]) {
    const w = new THREE.Mesh(wheelGeo, M.black);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.15, z);
    g.add(w);
  }

  g.userData.width = 2.0;
  return g;
}

// Log textures: shared bark wrap for the cylinder side + ring-cross-section for the caps.
const logSideTex = new THREE.TextureLoader().load('log.png?v=2');
logSideTex.wrapS = logSideTex.wrapT = THREE.RepeatWrapping;
logSideTex.colorSpace = THREE.SRGBColorSpace;
logSideTex.anisotropy = 8;
// CylinderGeometry's default UV has U=circumference, V=length. Rotate the
// texture 90° in UV space so the image's X axis runs ALONG the length and
// its Y axis wraps AROUND the circumference. After rotation, repeat.x=1
// stretches one full image X across the whole log length, and repeat.y=3
// wraps the (short) image Y three times around so the density stays ~isotropic.
logSideTex.center.set(0.5, 0.5);
logSideTex.rotation = Math.PI / 2;
logSideTex.repeat.set(1, 3);
const logSideMat = new THREE.MeshLambertMaterial({ map: logSideTex });
logSideMat.color.setRGB(1.18, 1.18, 1.18); // slight brightness boost

const logEndTex = new THREE.TextureLoader().load('log_end.png');
logEndTex.colorSpace = THREE.SRGBColorSpace;
logEndTex.anisotropy = 8;
const logEndMat = new THREE.MeshLambertMaterial({ map: logEndTex });
logEndMat.color.setRGB(1.18, 1.18, 1.18);

function buildLog(len) {
  const g = new THREE.Group();
  // Open-ended cylinder for the side so the bark wrap shows, no built-in caps.
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, len, 16, 1, true),
    logSideMat
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.24;
  body.castShadow = true;
  g.add(body);
  // CircleGeometry caps with the ring texture, set just past each cylinder end.
  const ringGeo = new THREE.CircleGeometry(0.32, 16);
  const r1 = new THREE.Mesh(ringGeo, logEndMat);
  r1.rotation.y = -Math.PI / 2;
  r1.position.set(-len / 2 - 0.01, 0.24, 0);
  g.add(r1);
  const r2 = r1.clone();
  r2.rotation.y = Math.PI / 2;
  r2.position.x = len / 2 + 0.01;
  g.add(r2);
  g.userData.width = len;
  return g;
}

// Procedural fallback used while the GLBs are still loading.
function buildTrainProcedural() {
  const g = new THREE.Group();
  const trainColor = [0xcc2222, 0x224488, 0x2a8855, 0x884422][Math.floor(Math.random() * 4)];
  const mat = new THREE.MeshLambertMaterial({ color: trainColor });

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.95, 0.85), mat);
  body.position.y = 0.6;
  body.castShadow = true;
  g.add(body);

  const win = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.3, 0.87), M.win);
  win.position.y = 0.78;
  g.add(win);

  const front = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.6), M.black);
  front.position.set(1.85, 0.45, 0);
  g.add(front);

  const chim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8), M.black);
  chim.position.set(1.2, 1.18, 0);
  g.add(chim);

  const lightMat = new THREE.MeshLambertMaterial({ color: 0xfff7c8, emissive: 0xffaa30, emissiveIntensity: 2.0 });
  const l = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.18), lightMat);
  l.position.set(1.95, 0.5, 0);
  g.add(l);

  g.userData.width = 3.7;
  return g;
}

// GLB-based train: one locomotive (at the leading +X end) + 1-3 freight cars
// trailing behind it. Templates are loaded asynchronously below.
let locomotiveTemplate = null;
let freightCarTemplate  = null;
let freightCar2Template = null;

function buildTrain() {
  if (!locomotiveTemplate) return buildTrainProcedural();

  // Available freight templates — randomly mixed per car so a train can have
  // both kinds of cars.
  const freightPool = [];
  if (freightCarTemplate)  freightPool.push(freightCarTemplate);
  if (freightCar2Template) freightPool.push(freightCar2Template);
  if (freightPool.length === 0) return buildTrainProcedural();

  const g = new THREE.Group();
  const locLen   = locomotiveTemplate.userData.width;
  const carLen   = freightPool[0].userData.width; // both freight templates use the same target length
  const carGap   = 0.08;

  // 25% chance to roll a long train.
  const longTrain = Math.random() < 0.25;
  const numCars = longTrain
    ? 4 + Math.floor(Math.random() * 4) // 4–7 freight cars
    : 1 + Math.floor(Math.random() * 3); // 1–3 freight cars

  const totalLen = locLen + numCars * carLen + numCars * carGap;
  const halfLen  = totalLen / 2;

  const loc = locomotiveTemplate.clone(true);
  loc.position.x = halfLen - locLen / 2; // front of train
  g.add(loc);

  let cursorX = halfLen - locLen - carGap;
  for (let i = 0; i < numCars; i++) {
    const template = freightPool[Math.floor(Math.random() * freightPool.length)];
    const car = template.clone(true);
    car.position.x = cursorX - carLen / 2;
    g.add(car);
    cursorX -= carLen + carGap;
  }

  g.userData.width = totalLen;
  return g;
}

function buildRailSignal() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), M.pole);
  base.position.y = 0.04;
  g.add(base);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), M.pole);
  pole.position.y = 0.64;
  pole.castShadow = true;
  g.add(pole);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.5, 0.26), M.signalBox);
  head.position.y = 1.42;
  head.castShadow = true;
  g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.08), M.signalBox);
  visor.position.set(0, 1.42, 0.18);
  g.add(visor);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), M.sigGreen);
  light.position.set(0, 1.42, 0.16);
  g.add(light);
  g.userData.light = light;
  return g;
}

// ===== Global instanced decor (grass & flowers) =====
const grassGeo = new THREE.BoxGeometry(0.06, 0.22, 0.06);
const flowerGeo = new THREE.BoxGeometry(0.1, 0.08, 0.1);
const grassMesh = new THREE.InstancedMesh(grassGeo, M.bladeA, GRASS_BLADES_MAX);
grassMesh.frustumCulled = false;
scene.add(grassMesh);
const flowerMeshes = [
  new THREE.InstancedMesh(flowerGeo, M.flowerW, FLOWERS_PER_COLOR_MAX),
  new THREE.InstancedMesh(flowerGeo, M.flowerY, FLOWERS_PER_COLOR_MAX),
  new THREE.InstancedMesh(flowerGeo, M.flowerP, FLOWERS_PER_COLOR_MAX),
];
for (const fm of flowerMeshes) {
  fm.frustumCulled = false;
  scene.add(fm);
}

const _m = new THREE.Matrix4();
const _hide = new THREE.Matrix4().makeScale(0, 0, 0);
let lastDecorSnap = NaN;
let decorDirty = true;

function updateDecor(camX) {
  const snap = Math.round(camX);
  if (snap === lastDecorSnap && !decorDirty) return;
  lastDecorSnap = snap;
  decorDirty = false;

  const minX = snap - OBSTACLE_HALF_X;
  const maxX = snap + OBSTACLE_HALF_X;
  let gi = 0;
  const fi = [0, 0, 0];

  for (const lane of lanes.values()) {
    if (lane.type !== 'grass') continue;
    const lz = lane.z;
    for (let x = minX; x <= maxX; x++) {
      if (isObstacleAt(x, lz)) continue;

      const numBlades = 3 + Math.floor(hashRand(x, lz + 1000) * 3);
      for (let k = 0; k < numBlades && gi < GRASS_BLADES_MAX; k++) {
        const sx = hashRand(x * 7 + k * 19, lz * 11 + k * 3);
        const sz = hashRand(x * 13 + k * 7, lz * 5 + k * 23);
        const sy = hashRand(x + k * 37, lz + k * 41);
        _m.makeTranslation(
          x + (sx - 0.5) * 0.85,
          0.11 + sy * 0.10,
          lz + (sz - 0.5) * 0.85
        );
        grassMesh.setMatrixAt(gi++, _m);
      }

      // Flowers come from the meadow texture now — no instanced flowers needed.
    }
  }

  for (; gi < GRASS_BLADES_MAX; gi++) grassMesh.setMatrixAt(gi, _hide);
  grassMesh.instanceMatrix.needsUpdate = true;
  for (let c = 0; c < 3; c++) {
    for (let f = fi[c]; f < FLOWERS_PER_COLOR_MAX; f++) {
      flowerMeshes[c].setMatrixAt(f, _hide);
    }
    flowerMeshes[c].instanceMatrix.needsUpdate = true;
  }
}

// ===== Lane system =====
const lanes = new Map();
let furthestZ = 0;
let earliestZ = 0;

function makeLane(z) {
  if (lanes.has(z)) return lanes.get(z);

  let type;
  if (z <= 2 && z >= -2) {
    type = 'grass';
  } else {
    const prev = lanes.get(z + 1);
    const r = Math.random();
    if (r < 0.20) type = 'grass';
    else if (r < 0.55) type = 'road';
    else if (r < 0.80) type = (prev?.type === 'water')
      ? (Math.random() < 0.4 ? 'water' : 'grass') // 40% chance to continue → multi-lane waterway
      : 'water';
    else type = (prev?.type === 'railroad') ? 'road' : 'railroad';
  }

  const lane = {
    z, type,
    dir: Math.random() < 0.5 ? 1 : -1,
    speed: 0,
    vehicles: [],
    obstacleMeshes: new Map(),
    groundGroup: new THREE.Group(),
    signal: null,
    trainTimer: 0,
    trainSpeed: 0,
  };

  lane.surfaceY = laneSurfaceY(type);
  lane.groundGroup.position.set(0, lane.surfaceY, z);
  scene.add(lane.groundGroup);

  const groundWidth = VIEW_HALF_X * 2 + 4;
  if (type === 'grass') {
    lane.meadowTex = makeMeadowTextureForLane(z);
    lane.meadowMat = new THREE.MeshLambertMaterial({ map: lane.meadowTex });
    // Direction sign — turning the camera left, right, or 180°. Hash-keyed so
    // the same world location always (de)spawns the same sign. Tries multiple
    // x slots so an obstacle in the first slot doesn't lose the sign entirely.
    if (z < 0 && hashRand(z, 13371) < 0.80) {
      let px = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = Math.floor((hashRand(z, 13372 + attempt) - 0.5) * 14); // -7..+6
        if (!isObstacleAt(candidate, z)) { px = candidate; break; }
      }
      if (px !== null) {
        const r = hashRand(z, 13379);
        const kind = r < 0.35 ? 'left' : r < 0.70 ? 'right' : 'uturn';
        spawnSign(px, z, kind);
      }
    }
  } else if (type === 'water') {
    lane.waterMat = makeWaterMaterialForLane();
  } else if (type === 'road') {
    lane.roadTex = makeRoadTextureForLane();
    lane.roadMat = new THREE.MeshLambertMaterial({ map: lane.roadTex });
  }
  const groundMat =
    type === 'grass' ? lane.meadowMat
    : type === 'water' ? lane.waterMat
    : type === 'road'  ? lane.roadMat
    :                    railroadMat;
  // Render the lane as a block so elevation steps don't leave a gap to the sky.
  // BoxGeometry face order: [+X, -X, +Y (TOP), -Y, +Z, -Z]. We give the top its
  // textured material and the four (visible) sides a dark earth color.
  const sideMat =
    type === 'grass' ? M.sideGrass
    : type === 'water' ? M.sideWater
    : type === 'road'  ? M.sideRoad
    :                    M.sideRail;
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(groundWidth, LANE_THICKNESS, TILE),
    [sideMat, sideMat, groundMat, sideMat, sideMat, sideMat]
  );
  // Top face at y=0 in group space (which is lane.surfaceY in world).
  ground.position.y = -LANE_THICKNESS / 2;
  ground.receiveShadow = true;
  ground.castShadow = true;
  lane.groundGroup.add(ground);

  if (type === 'road') {
    lane.speed = 1.5 + Math.random() * 3.5;
    const num = 3;
    const spacing = (VEHICLE_HALF_X * 2) / num;
    for (let i = 0; i < num; i++) {
      const isTruck = Math.random() < 0.3;
      const v = isTruck ? makeTruckMesh() : makeCarMesh();
      const startX = -VEHICLE_HALF_X + i * spacing + Math.random() * 2;
      v.position.set(startX, 0, z);
      v.rotation.y = lane.dir > 0 ? 0 : Math.PI;
      scene.add(v);
      const honker = !isTruck && Math.random() < 0.3; // ~30% of cars are honkers
      lane.vehicles.push({
        mesh: v,
        x: startX,
        w: v.userData.width,
        kind: isTruck ? 'truck' : 'car',
        honkable: honker,
        honkCooldown: 0, // ready to honk as soon as the cat steps in front
      });
    }
  } else if (type === 'water') {
    const prevLane = lanes.get(z + 1);
    const continuingFromWater = prevLane?.type === 'water';

    const speedLo = 0.9, speedHi = 2.3;
    lane.speed = speedLo + Math.random() * (speedHi - speedLo);
    if (continuingFromWater) {
      // Adjacent water lanes share direction, so if their speeds match closely
      // the cat can get stranded waiting for the next log to drift over. Force
      // a minimum gap by re-sampling outside a forbidden band around prevLane.
      const minDiff = 0.5;
      const lowBand  = Math.max(0, Math.min(speedHi, prevLane.speed - minDiff) - speedLo);
      const highBand = Math.max(0, speedHi - Math.max(speedLo, prevLane.speed + minDiff));
      const total = lowBand + highBand;
      if (total > 0) {
        const r = Math.random() * total;
        lane.speed = r < lowBand
          ? speedLo + r
          : Math.max(speedLo, prevLane.speed + minDiff) + (r - lowBand);
      }
    }

    // Stone walls span the trench depth + a small rim above ground level.
    // For a contiguous multi-lane waterway we skip the walls between adjacent
    // water lanes so it reads as one wide river.
    const wallHeight = -WATER_DROP + 0.08;       // bottom at water surface, top ~0.08 above ground
    const wallCenterY = wallHeight / 2;          // in group space (group at lane.surfaceY)
    const wallGeo = new THREE.BoxGeometry(GROUND_WIDTH, wallHeight, 0.18);
    const wallMats = [
      M.stone, M.stone, M.stone, M.stone,
      waterWallMat,  // +Z face (camera-facing)
      waterWallMat,  // -Z face
    ];

    // Back wall (+Z side, toward the previous lane). Skip if continuing water.
    if (!continuingFromWater) {
      const backWall = new THREE.Mesh(wallGeo, wallMats);
      backWall.position.set(0, wallCenterY, 0.46);
      backWall.castShadow = true;
      lane.groundGroup.add(backWall);
      lane.backWall = backWall;
    } else {
      // We came after another water lane — strip ITS front wall, since it's
      // now buried between two water lanes.
      if (prevLane.frontWall) {
        prevLane.groundGroup.remove(prevLane.frontWall);
        prevLane.frontWall = null;
      }
      // Share direction so the waterway flows the same way, but keep each
      // lane's randomly-rolled speed so adjacent logs visibly drift at
      // different rates.
      lane.dir = prevLane.dir;
    }

    // Front wall (-Z side, toward the next lane). Always add; may be stripped
    // later if a subsequent water lane is generated next to this one.
    const frontWall = new THREE.Mesh(wallGeo, wallMats);
    frontWall.position.set(0, wallCenterY, -0.46);
    frontWall.castShadow = true;
    lane.groundGroup.add(frontWall);
    lane.frontWall = frontWall;
    const logLen = 2 + Math.floor(Math.random() * 2);
    const num = 3;
    const spacing = (VEHICLE_HALF_X * 2) / num;
    for (let i = 0; i < num; i++) {
      const log = buildLog(logLen);
      const startX = -VEHICLE_HALF_X + i * spacing + Math.random() * 2;
      log.position.set(startX, lane.surfaceY + LOG_REST_REL, z);
      scene.add(log);
      lane.vehicles.push({ mesh: log, x: startX, w: logLen, isLog: true });
    }
  } else if (type === 'railroad') {
    // Signal post (left of camera, just within the lane). Ties and rails come
    // from the railroad texture applied to the ground plane.
    const signal = buildRailSignal();
    signal.position.set(-8, 0, 0.4);
    lane.groundGroup.add(signal);
    lane.signal = signal;

    lane.trainTimer = 5 + Math.random() * 6;
    lane.trainSpeed = 8 + Math.random() * 4;
  }

  lanes.set(z, lane);
  if (z < furthestZ) furthestZ = z;
  if (z > earliestZ) earliestZ = z;
  decorDirty = true;
  return lane;
}

function disposeLane(lane) {
  scene.remove(lane.groundGroup);
  for (const v of lane.vehicles) scene.remove(v.mesh);
  for (const mesh of lane.obstacleMeshes.values()) scene.remove(mesh);
  lane.obstacleMeshes.clear();
  if (lane.meadowTex) lane.meadowTex.dispose();
  if (lane.meadowMat) lane.meadowMat.dispose();
  if (lane.waterMat)  lane.waterMat.dispose();
  if (lane.roadTex)   lane.roadTex.dispose();
  if (lane.roadMat)   lane.roadMat.dispose();
}

// ===== Grass obstacles =====
function isObstacleAt(x, z) {
  if (z === 0 && Math.abs(x) <= 1) return false;
  const lane = lanes.get(z);
  if (!lane || lane.type !== 'grass') return false;
  return hashRand(x, z) < 0.20;
}

// Mirrors the kind-selection branch in makeGrassObstacleMesh. A bush is a
// "soft" obstacle: it doesn't block the cat — the cat hops onto it.
function isBushAt(x, z) {
  if (!isObstacleAt(x, z)) return false;
  const t = hashRand(x + 1234, z + 5678);
  return t >= 0.80 && t < 0.92;
}

function makeGrassObstacleMesh(x, z) {
  if (!isObstacleAt(x, z)) return null;
  const t = hashRand(x + 1234, z + 5678);
  const seed = hashRand(x + 9999, z + 1111);
  if (t < 0.55) return buildPineTree(seed);
  if (t < 0.80) return buildLeafyTree(seed);
  if (t < 0.92) return buildBush(seed);
  return buildRock(seed);
}

function updateGrassObstacles(camX) {
  const minX = Math.floor(camX) - OBSTACLE_HALF_X;
  const maxX = Math.floor(camX) + OBSTACLE_HALF_X;
  for (const lane of lanes.values()) {
    if (lane.type !== 'grass') continue;
    for (const [x, mesh] of [...lane.obstacleMeshes.entries()]) {
      if (x < minX || x > maxX) {
        scene.remove(mesh);
        lane.obstacleMeshes.delete(x);
      }
    }
    for (let x = minX; x <= maxX; x++) {
      if (lane.obstacleMeshes.has(x)) continue;
      const obs = makeGrassObstacleMesh(x, lane.z);
      if (obs) {
        obs.position.set(x, 0, lane.z);
        scene.add(obs);
        lane.obstacleMeshes.set(x, obs);
      }
    }
  }
}

function updateLaneGroups(camX) {
  const snapped = Math.round(camX);
  for (const lane of lanes.values()) {
    lane.groundGroup.position.x = snapped;
  }
}

function updateVehicles(camX, dt) {
  for (const lane of lanes.values()) {
    for (const v of lane.vehicles) {
      v.x += lane.dir * lane.speed * dt;
      const rel = v.x - camX;
      if (rel > VEHICLE_HALF_X) v.x -= VEHICLE_HALF_X * 2;
      else if (rel < -VEHICLE_HALF_X) v.x += VEHICLE_HALF_X * 2;
      v.mesh.position.x = v.x;

      // Honk once per approach when the cat is in this car's path ahead of it.
      // didHonkThisApproach resets as soon as the cat leaves the front zone, so
      // the next entry triggers another honk reliably (no cooldown lockout).
      if (v.honkable) {
        const sameLane = catZ === lane.z;
        const ahead = sameLane ? (catWorldX - v.x) * lane.dir : -Infinity;
        const inFront = sameLane && ahead > 0 && ahead < 4;
        if (inFront && !v.didHonkThisApproach) {
          playHonk();
          v.didHonkThisApproach = true;
        } else if (!inFront) {
          v.didHonkThisApproach = false;
        }
      }
    }
  }
}

function updateLogSinking(dt) {
  for (const lane of lanes.values()) {
    if (lane.type !== 'water') continue;
    for (const v of lane.vehicles) {
      if (!v.isLog) continue;
      const targetY = lane.surfaceY + LOG_REST_REL + ((onLog && onLog.v === v) ? LOG_SINK_REL : 0);
      v.mesh.position.y += (targetY - v.mesh.position.y) * Math.min(1, dt * 9);
    }
  }
}

function updateTrains(camX, dt) {
  for (let i = trains.length - 1; i >= 0; i--) {
    const t = trains[i];
    t.x += t.dir * t.speed * dt;
    t.mesh.position.x = t.x;
    if (Math.abs(t.x - camX) > VEHICLE_HALF_X + t.w / 2 + 4) {
      scene.remove(t.mesh);
      trains.splice(i, 1);
    }
  }
}

function updateRailroads(camX, dt, now) {
  for (const lane of lanes.values()) {
    if (lane.type !== 'railroad') continue;
    lane.trainTimer -= dt;
    if (lane.trainTimer <= 0) {
      lane.trainTimer = 6 + Math.random() * 6; // longer gap — the freight train takes a while to clear
      spawnTrain(lane, camX);
    }
    // Account for the train's actual length so the signal stays red until the whole
    // chain of cars has rolled past the visible area.
    const hasActive = trains.some(t => t.lane === lane && Math.abs(t.x - camX) < VEHICLE_HALF_X + t.w / 2 + 2);
    const warning = lane.trainTimer < TRAIN_WARN_TIME || hasActive;
    if (warning) {
      const blinkOn = Math.floor(now / 220) % 2 === 0;
      lane.signal.userData.light.material = blinkOn ? M.sigRed : M.sigRedDim;
    } else {
      lane.signal.userData.light.material = M.sigGreen;
    }
  }
}

function spawnTrain(lane, camX) {
  const t = buildTrain();
  const L = t.userData.width;
  // Place the train so its leading end is just off-screen.
  const startX = lane.dir > 0
    ? camX - VEHICLE_HALF_X - L / 2 - 1
    : camX + VEHICLE_HALF_X + L / 2 + 1;
  t.position.set(startX, lane.surfaceY, lane.z);
  t.rotation.y = lane.dir > 0 ? 0 : Math.PI;
  scene.add(t);
  trains.push({ mesh: t, x: startX, lane, dir: lane.dir, speed: lane.trainSpeed, w: L });
}

// ===== Game state =====
const CAT_SCALE = 0.8; // overall cat size relative to its modelled dimensions
const cat = buildCat();
cat.scale.setScalar(CAT_SCALE);
scene.add(cat);

let catX = 0, catZ = 0;
let catWorldX = 0, catWorldZ = 0;
let hopStart = 0, hopFromX = 0, hopFromZ = 0, hopFromY = 0, hopToX = 0, hopToZ = 0, hopActive = false;
let catFacing = 0;
let onLog = null;
let logOffsetX = 0;
let score = 0;
let bestScore = parseInt(localStorage.getItem('crossycat-best') || '0', 10) || 0;
let gameOver = false;
let deathReason = null;
let minZReached = 0;
let cameraZ = 0;
let cameraX = 0;
let progressAvg = PROGRESS_TARGET; // start zoomed out — assume the player is about to move
let lastZForZoom = 0;
let zoomVel = 0; // spring velocity, gives the zoom momentum

function updateCameraZoom(dt) {
  // Forward progress is positive when catWorldZ decreases (cat advances -Z).
  const dz = lastZForZoom - catWorldZ;
  lastZForZoom = catWorldZ;
  const instProgress = Math.max(0, dz / Math.max(dt, 1e-6));
  const smoothing = instProgress > progressAvg
    ? PROGRESS_SMOOTHING_RAMP
    : PROGRESS_SMOOTHING_DECAY;
  progressAvg += (instProgress - progressAvg) * Math.min(1, dt * smoothing);

  const norm = Math.min(1, progressAvg / PROGRESS_TARGET);
  const targetZoom = CAM_ZOOM_IN - norm * (CAM_ZOOM_IN - CAM_ZOOM_OUT);

  // Critically-damped spring: accel = k*(target - x) - c*v, integrate v then x.
  const accel = ZOOM_STIFFNESS * (targetZoom - camera.zoom) - ZOOM_DAMPING * zoomVel;
  zoomVel += accel * dt;
  camera.zoom += zoomVel * dt;
  camera.updateProjectionMatrix();
}

const inputQueue = [];
const trains = [];

// ===== Audio: one pool per known sound file, two selectable channels (jump/honk).
// The debug menu's dropdowns swap which file each channel plays, or mute it entirely.
const SOUND_FILES = {
  jump:   { url: 'jump.wav',     volume: 0.45 },
  honk:   { url: 'honk.wav?v=2', volume: 0.35 },
  splash: { url: 'splash.wav',   volume: 0.7, playbackRate: 1.2, preservesPitch: false },
};
const POOL_SIZE = 4;
const audioPools = {};
for (const id of Object.keys(SOUND_FILES)) {
  const cfg = SOUND_FILES[id];
  const pool = { items: [], idx: 0 };
  for (let i = 0; i < POOL_SIZE; i++) {
    const a = new Audio(cfg.url);
    a.preload = 'auto';
    a.volume = cfg.volume;
    if (cfg.playbackRate !== undefined) a.playbackRate = cfg.playbackRate;
    if (cfg.preservesPitch !== undefined) a.preservesPitch = cfg.preservesPitch;
    pool.items.push(a);
  }
  audioPools[id] = pool;
}

let jumpSelection = 'jump'; // which file plays for hops
let honkSelection = 'honk'; // which file plays for car horns

function setMuteAll(mute) {
  for (const id of Object.keys(audioPools)) {
    for (const a of audioPools[id].items) a.muted = mute;
  }
  musicAudio.muted = mute;
  waterAmbient.muted = mute;
}

function setSoundVolume(id, v) {
  if (id === 'music') {
    musicAudio.volume = v;
    return;
  }
  if (id === 'waterAmbient') {
    waterAmbientMaxVol = v;       // proximity fade is applied on top of this in tickWaterAmbient
    return;
  }
  const p = audioPools[id];
  if (!p) return;
  for (const a of p.items) a.volume = v;
}

function playSound(id, opts) {
  if (!id || id === 'none') return;
  const p = audioPools[id];
  if (!p) return;
  const sfx = p.items[p.idx];
  p.idx = (p.idx + 1) % POOL_SIZE;
  sfx.currentTime = 0;
  if (opts && opts.pitchVariation) {
    // ±(pitchVariation*100)% pitch jitter; needs preservesPitch=false to
    // actually shift pitch with the rate.
    sfx.preservesPitch = false;
    sfx.playbackRate = 1 + (Math.random() - 0.5) * 2 * opts.pitchVariation;
  }
  sfx.play().catch(() => {}); // ignore autoplay-policy rejections before first input
}

function playJump() { playSound(jumpSelection); }
function playHonk() { playSound(honkSelection, { pitchVariation: 0.1 }); }

// Background music — looped, starts on the first user interaction (browsers
// block .play() before any gesture, so we retry whenever input fires).
const MUSIC_TRACKS = {
  shuffle1: 'music.mp3',
  shuffle2: 'music2.mp3',
};
let currentMusicId = 'shuffle1';
const musicAudio = new Audio(MUSIC_TRACKS[currentMusicId]);
musicAudio.loop = true;
musicAudio.preload = 'auto';
musicAudio.volume = 0.3;
let musicOn = true;

function applyMusic() {
  if (musicOn) {
    if (musicAudio.paused) musicAudio.play().catch(() => {});
  } else {
    musicAudio.pause();
  }
}

function selectMusicTrack(id) {
  if (id === 'none') {
    musicOn = false;
    musicAudio.pause();
    return;
  }
  const url = MUSIC_TRACKS[id];
  if (!url) return;
  if (currentMusicId !== id) {
    musicAudio.pause();
    musicAudio.src = url;
    musicAudio.load();
    currentMusicId = id;
  }
  musicOn = true;
  applyMusic();
}

['keydown', 'pointerdown', 'touchstart'].forEach(ev => {
  addEventListener(ev, applyMusic, { passive: true });
});

// Water ambient — distant splashes / fountain. Loops the first 60 seconds so
// we don't sit through the full 5-minute recording, and the volume fades in
// as the cat gets within a few lanes of any water lane.
const WATER_AMBIENT_LOOP_SECS = 60;
const WATER_AMBIENT_FADE_LANES = 4; // fully audible at 0 lanes away, silent at >= 4
const waterAmbient = new Audio('water_ambient.wav');
waterAmbient.preload = 'auto';
waterAmbient.loop = true;          // browser handles end-of-file fallback
waterAmbient.volume = 0;
let waterAmbientOn = true;
let waterAmbientMaxVol = 0.5;       // controlled by debug slider

function tickWaterAmbient(dt) {
  // Restart at 60s so we only ever hear the opening minute.
  if (waterAmbient.currentTime > WATER_AMBIENT_LOOP_SECS) {
    waterAmbient.currentTime = 0;
  }
  let minDist = Infinity;
  for (const lane of lanes.values()) {
    if (lane.type !== 'water') continue;
    const d = Math.abs(lane.z - catZ);
    if (d < minDist) minDist = d;
  }
  const proximity = Math.max(0, 1 - minDist / WATER_AMBIENT_FADE_LANES);
  const targetVol = waterAmbientOn ? proximity * waterAmbientMaxVol : 0;
  // Smooth crossfade rather than a snap.
  waterAmbient.volume += (targetVol - waterAmbient.volume) * Math.min(1, dt * 2.5);
}

['keydown', 'pointerdown', 'touchstart'].forEach(ev => {
  addEventListener(ev, () => {
    if (waterAmbient.paused) waterAmbient.play().catch(() => {});
  }, { passive: true });
});

// ===== Water splash particles =====
// ===== Rotate-screen power-up =====
const powerUps = [];
const powerUpGeo = new THREE.OctahedronGeometry(0.5);
// MeshBasicMaterial ignores lighting → always bright, unmissable.
const powerUpMat = new THREE.MeshBasicMaterial({ color: 0xff33ff });
let targetRotationDeg  = 0;   // accumulated rotation target (degrees)
let currentRotationDeg = 0;   // smoothed value applied to the canvas

function spawnRotatePowerUp(x, z) {
  const wrapper = new THREE.Group();
  const mesh = new THREE.Mesh(powerUpGeo, powerUpMat);
  mesh.position.y = 0.9;
  wrapper.add(mesh);
  wrapper.position.set(x, 0, z);
  wrapper.userData = { tx: x, tz: z, mesh, bobPhase: Math.random() * Math.PI * 2 };
  scene.add(wrapper);
  powerUps.push(wrapper);
  console.log('Power-up spawned at', x, z);
}

function updatePowerUps(dt, now) {
  for (let i = powerUps.length - 1; i >= 0; i--) {
    const p = powerUps[i];
    p.rotation.y += dt * 1.8;
    p.userData.mesh.position.y = 0.6 + Math.sin(now * 0.003 + p.userData.bobPhase) * 0.18;

    // Pickup if the cat is sitting on this tile.
    if (!gameOver && catX === p.userData.tx && catZ === p.userData.tz) {
      targetRotationDeg += 90;
      scene.remove(p);
      powerUps.splice(i, 1);
      continue;
    }
    // Despawn when it's left behind well beyond the back of view.
    if (catWorldZ - p.userData.tz > 25) {
      scene.remove(p);
      powerUps.splice(i, 1);
    }
  }
}

function updateScreenRotation(dt) {
  // Smooth the rotation accumulator; the actual rotation is applied to the
  // camera position in the tick (orbit around the vertical axis through the
  // lookAt point).
  currentRotationDeg += (targetRotationDeg - currentRotationDeg) * Math.min(1, dt * 3);
}

// ===== Direction signs (turn-left / turn-right / u-turn pickups) =====
// Sign-kind → rotation delta in degrees (applied to targetRotationDeg).
// +90° matches the existing power-up's "rotate right" effect: at +90 the
// previous forward (-Z) becomes +X, i.e. the cat now hops to the old right.
const SIGN_ROT_DEG = { left: -90, right: 90, uturn: 180 };
const signs = [];

function spawnSign(x, z, kind) {
  const template = signTemplates[kind];
  if (!template) return; // GLB still loading — just skip this slot
  const mesh = template.clone(true);
  mesh.position.set(x, 0, z);
  // Face the camera (looking down +Z) so the sign's printed side is visible
  // when the cat approaches from in front (cat moves toward -Z).
  scene.add(mesh);
  signs.push({ mesh, tx: x, tz: z, kind });
}

function updateSigns(dt) {
  // Y-axis billboard: rotate each sign so its +Z (assumed printed face) points
  // toward the orthographic camera's view origin. Same formula regardless of
  // sign position because the camera is orthographic.
  const rotRad = currentRotationDeg * Math.PI / 180;
  const c = Math.cos(rotRad), s = Math.sin(rotRad);
  const offX = CAM_OFFSET.x;
  const offZ = CAM_OFFSET.z - CAM_LOOK_AHEAD_Z;
  const signRotY = Math.atan2(offX * c - offZ * s, offX * s + offZ * c);

  for (let i = signs.length - 1; i >= 0; i--) {
    const sign = signs[i];
    sign.mesh.rotation.y = signRotY;
    // Pickup if the cat is sitting on this tile.
    if (!gameOver && catX === sign.tx && catZ === sign.tz) {
      targetRotationDeg += SIGN_ROT_DEG[sign.kind] || 0;
      scene.remove(sign.mesh);
      signs.splice(i, 1);
      continue;
    }
    // Despawn well behind the camera. Cat advances toward -Z, so a sign is
    // behind when its z is larger than catWorldZ.
    if (sign.tz - catWorldZ > 25) {
      scene.remove(sign.mesh);
      signs.splice(i, 1);
    }
  }
}

const splashParticles = [];
const splashGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const splashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

// ===== Roadkill: pixelated blood splat + tire marks =====
let catDeathPos = null;            // { x, z, laneZ, surfaceY } for a car/train death
const bloodSplats = [];            // initial burst of pixel cubes at death
const tireMarks = [];              // accumulates as later cars drive over
const bloodGeo = new THREE.BoxGeometry(0.06, 0.025, 0.06);
const bloodMatA = new THREE.MeshBasicMaterial({ color: 0x6a0000 });
const bloodMatB = new THREE.MeshBasicMaterial({ color: 0x8a1010 });

function spawnBloodSplat(x, y, z) {
  for (let i = 0; i < 38; i++) {
    const c = new THREE.Mesh(bloodGeo, Math.random() < 0.5 ? bloodMatA : bloodMatB);
    // sqrt distribution → denser near the center
    const r = Math.pow(Math.random(), 0.5) * 0.45;
    const a = Math.random() * Math.PI * 2;
    c.position.set(
      x + Math.cos(a) * r,
      y + 0.005 + Math.random() * 0.025,
      z + Math.sin(a) * r
    );
    c.rotation.y = Math.random() * Math.PI * 2;
    scene.add(c);
    bloodSplats.push(c);
  }
}

// Drip a pair of small pixel cubes at the car's current wheels — accumulates
// into a long bloody tire trail as the car keeps driving.
function spawnTireDrop(x, y, z) {
  for (const zOff of [-0.22, 0.22]) {
    const c = new THREE.Mesh(bloodGeo, Math.random() < 0.5 ? bloodMatA : bloodMatB);
    c.position.set(
      x + (Math.random() - 0.5) * 0.07,
      y + 0.01 + Math.random() * 0.025,
      z + zOff + (Math.random() - 0.5) * 0.06
    );
    scene.add(c);
    tireMarks.push(c);
  }
}

const TIRE_MARKS_MAX = 700;       // safety cap so an idle game-over doesn't pile up forever
const SMEAR_GROW_PER_PASS = 0.2;  // how much each car extends the smear after it clears
const SMEAR_MAX_GLOBAL    = 6.0;  // hard cap on smear length
let   smearMaxDist        = 0.4;  // current per-car smear length, ahead of the cat

function updateTireMarks() {
  if (!catDeathPos) return;
  const lane = lanes.get(catDeathPos.laneZ);
  if (!lane || lane.type !== 'road') return;
  if (tireMarks.length >= TIRE_MARKS_MAX) return;

  for (const v of lane.vehicles) {
    // Signed distance ALONG the lane's direction of travel.
    // > 0 means the car has already rolled over the cat; < 0 means approaching.
    const passedDist = (v.x - catDeathPos.x) * lane.dir;

    // Drip a pair of pixel cubes per frame, but only behind the car (after it
    // has rolled over), and only up to the current smear length.
    if (passedDist > 0 && passedDist < smearMaxDist) {
      spawnTireDrop(v.x, catDeathPos.surfaceY, catDeathPos.z);
    }

    // When a car has driven well past the existing smear, bump the smear
    // length so the NEXT car will stretch the trail a bit further.
    if (passedDist > smearMaxDist + 1.5 && !v._smearDone) {
      v._smearDone = true;
      smearMaxDist = Math.min(smearMaxDist + SMEAR_GROW_PER_PASS, SMEAR_MAX_GLOBAL);
    } else if (passedDist < -1 && v._smearDone) {
      v._smearDone = false; // car wrapped around, ready to extend again next pass
    }
  }
}

function spawnWaterSplash(x, y, z) {
  for (let i = 0; i < 30; i++) {
    const cube = new THREE.Mesh(splashGeo, splashMat);
    cube.position.set(x, y, z);
    const ang = Math.random() * Math.PI * 2;
    const horiz = 0.9 + Math.random() * 1.6;
    const vert  = 2.0 + Math.random() * 2.0;
    cube.userData.vel = new THREE.Vector3(
      Math.cos(ang) * horiz,
      vert,
      Math.sin(ang) * horiz
    );
    cube.userData.life = 0;
    cube.userData.maxLife = 0.9 + Math.random() * 0.5;
    scene.add(cube);
    splashParticles.push(cube);
  }
}

function updateSplashes(dt) {
  for (let i = splashParticles.length - 1; i >= 0; i--) {
    const p = splashParticles[i];
    p.userData.vel.y -= 7.5 * dt; // gravity
    p.position.addScaledVector(p.userData.vel, dt);
    p.userData.life += dt;
    const t = p.userData.life / p.userData.maxLife;
    p.scale.setScalar(Math.max(0.05, 1 - t));
    if (p.userData.life >= p.userData.maxLife) {
      scene.remove(p);
      splashParticles.splice(i, 1);
    }
  }
}

const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const gameOverEl = document.getElementById('gameover');
const finalScoreEl = document.getElementById('finalScore');
scoreEl.textContent = '0';
bestEl.textContent = 'Best: ' + bestScore;

// DEBUG: signs guaranteed at game start. Called on initial world creation AND
// when the GLB loads late (in case the file wasn't ready the first time).
const DEBUG_START_SIGNS = [{ x: 0, z: -2, kind: 'uturn' }];
let debugStartSignsSpawned = false;

function spawnDebugStartSigns() {
  if (debugStartSignsSpawned) return;
  // Only fire once all referenced templates are loaded.
  if (DEBUG_START_SIGNS.some(d => !signTemplates[d.kind])) return;
  for (const d of DEBUG_START_SIGNS) spawnSign(d.x, d.z, d.kind);
  debugStartSignsSpawned = true;
}

function spawnInitialWorld() {
  for (let z = 4; z >= -22; z--) makeLane(z);
  debugStartSignsSpawned = false;
  spawnDebugStartSigns();
}
spawnInitialWorld();

// ===== Input =====
// Convert a screen-space input (sx along screen X, sz along screen Y where
// −1 = up on screen) into a world tile direction, applying the current camera
// rotation. With rotation always at a multiple of 90° the result is exact;
// during the smooth lerp between rotations the dominant axis is picked.
function screenToWorldDir(sx, sz) {
  const rad = currentRotationDeg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const wx = sx * c - sz * s;
  const wz = sx * s + sz * c;
  if (Math.abs(wx) > Math.abs(wz)) return [Math.sign(wx), 0];
  return [0, Math.sign(wz)];
}

addEventListener('keydown', e => {
  if (gameOver) {
    if (e.code === 'Space' || e.code === 'Enter') restart();
    return;
  }
  let sx = 0, sz = 0;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') sz = -1;
  else if (e.code === 'ArrowDown' || e.code === 'KeyS') sz = 1;
  else if (e.code === 'ArrowLeft' || e.code === 'KeyA') sx = -1;
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') sx = 1;
  else return;
  e.preventDefault();
  const [dx, dz] = screenToWorldDir(sx, sz);
  if (inputQueue.length < 2) inputQueue.push([dx, dz]);
});

let touchStartX = 0, touchStartY = 0, touchActive = false;
addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchActive = true;
}, { passive: true });
addEventListener('touchend', e => {
  if (!touchActive) return;
  touchActive = false;
  if (gameOver) { restart(); return; }
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  let sx = 0, sz = 0;
  if (Math.abs(dx) < 25 && Math.abs(dy) < 25) {
    sz = -1; // tap = hop forward in screen space
  } else if (Math.abs(dx) > Math.abs(dy)) {
    sx = dx > 0 ? 1 : -1;
  } else {
    sz = dy < 0 ? -1 : 1;
  }
  const [worldDx, worldDz] = screenToWorldDir(sx, sz);
  if (inputQueue.length < 2) inputQueue.push([worldDx, worldDz]);
}, { passive: true });

// ===== Game logic =====
function tryHop(dx, dz) {
  if (hopActive) return;
  const fromX = onLog ? Math.round(catWorldX) : catX;
  const nx = fromX + dx;
  const nz = catZ + dz;

  makeLane(nz);
  // Bushes are soft obstacles — the cat lands on top instead of being blocked.
  if (isObstacleAt(nx, nz) && !isBushAt(nx, nz)) return;
  playJump();

  hopFromX = catWorldX;
  hopFromZ = catWorldZ;
  hopFromY = cat.position.y;
  hopToX = nx;
  hopToZ = nz;
  hopStart = performance.now();
  hopActive = true;
  catX = nx;
  catZ = nz;

  if (dz < 0) catFacing = 0;
  else if (dz > 0) catFacing = Math.PI;
  else if (dx > 0) catFacing = -Math.PI / 2;
  else if (dx < 0) catFacing = Math.PI / 2;
  cat.rotation.y = catFacing;

  onLog = null;

  if (nz < minZReached) {
    minZReached = nz;
    score = -minZReached;
    scoreEl.textContent = score;
    if (score > bestScore) {
      bestScore = score;
      bestEl.textContent = 'Best: ' + bestScore;
      localStorage.setItem('crossycat-best', String(bestScore));
    }
  }
}

function onLanded() {
  const lane = lanes.get(catZ);
  if (!lane) return;
  if (lane.type === 'water') {
    let foundLog = null;
    for (const v of lane.vehicles) {
      if (v.isLog && Math.abs(v.x - catWorldX) <= v.w / 2 + 0.2) { foundLog = v; break; }
    }
    if (foundLog) {
      onLog = { v: foundLog, lane };
      logOffsetX = catWorldX - foundLog.x;
    } else {
      die('water');
    }
  } else if (lane.type === 'road') {
    for (const v of lane.vehicles) {
      if (Math.abs(v.x - catWorldX) < v.w / 2 + 0.25) { die('car'); return; }
    }
  } else if (lane.type === 'railroad') {
    for (const t of trains) {
      if (t.lane.z === catZ && Math.abs(t.x - catWorldX) < t.w / 2 + 0.25) { die('train'); return; }
    }
  }
}

function die(reason) {
  if (gameOver) return;
  gameOver = true;
  deathReason = reason;
  hopActive = false;
  onLog = null;
  finalScoreEl.textContent = score;
  gameOverEl.classList.add('show');

  if (reason === 'car' || reason === 'train') {
    cat.scale.set(1.35 * CAT_SCALE, 0.08 * CAT_SCALE, 1.35 * CAT_SCALE);
    cat.position.y = 0.02;
    cat.rotation.y = catFacing;
    const deathLane = lanes.get(catZ);
    catDeathPos = {
      x: catWorldX,
      z: catWorldZ,
      laneZ: catZ,
      surfaceY: deathLane ? deathLane.surfaceY : 0,
    };
    spawnBloodSplat(catWorldX, catDeathPos.surfaceY, catWorldZ);
  } else if (reason === 'water') {
    // Cat vanishes, replaced by a burst of small white cubes.
    cat.visible = false;
    const lane = lanes.get(catZ);
    const surfaceY = lane ? lane.surfaceY : WATER_DROP;
    spawnWaterSplash(catWorldX, surfaceY, catWorldZ);
    playSound('splash');
  }
}

function restart() {
  for (const lane of lanes.values()) disposeLane(lane);
  lanes.clear();
  for (const t of trains) scene.remove(t.mesh);
  trains.length = 0;

  catX = 0; catZ = 0;
  catWorldX = 0; catWorldZ = 0;
  cat.position.set(0, 0, 0);
  cat.rotation.y = 0;
  cat.scale.setScalar(CAT_SCALE);
  cat.visible = true;
  for (const p of splashParticles) scene.remove(p);
  splashParticles.length = 0;
  for (const m of bloodSplats) scene.remove(m);
  bloodSplats.length = 0;
  for (const m of tireMarks) scene.remove(m);
  tireMarks.length = 0;
  catDeathPos = null;
  smearMaxDist = 0.4;
  for (const p of powerUps) scene.remove(p);
  powerUps.length = 0;
  for (const s of signs) scene.remove(s.mesh);
  signs.length = 0;
  targetRotationDeg = 0;
  currentRotationDeg = 0;
  catFacing = 0;
  hopActive = false;
  onLog = null;
  score = 0;
  minZReached = 0;
  cameraZ = 0;
  cameraX = 0;
  progressAvg = PROGRESS_TARGET;
  lastZForZoom = 0;
  zoomVel = 0;
  camera.zoom = CAM_ZOOM_OUT;
  camera.updateProjectionMatrix();
  furthestZ = 0;
  earliestZ = 0;
  scoreEl.textContent = '0';
  gameOverEl.classList.remove('show');
  gameOver = false;
  deathReason = null;
  inputQueue.length = 0;
  decorDirty = true;
  lastDecorSnap = NaN;

  spawnInitialWorld();
}

// ===== Main loop =====
let lastT = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  updateVehicles(cameraX, dt);
  updateLogSinking(dt);
  updateSplashes(dt);
  updateTireMarks();
  tickWaterAmbient(dt);
  updatePowerUps(dt, now);
  updateSigns(dt);
  updateScreenRotation(dt);
  updateTrains(cameraX, dt);
  updateRailroads(cameraX, dt, now);
  updateWaterTextures(cameraX, dt);

  if (!gameOver) {
    if (!hopActive && inputQueue.length > 0) {
      const [dx, dz] = inputQueue.shift();
      tryHop(dx, dz);
    }

    if (hopActive) {
      const tt = Math.min(1, (now - hopStart) / HOP_MS);
      catWorldX = hopFromX + (hopToX - hopFromX) * tt;
      catWorldZ = hopFromZ + (hopToZ - hopFromZ) * tt;
      cat.position.x = catWorldX;
      cat.position.z = catWorldZ;
      const landingLane = lanes.get(catZ);
      let landingY = landingLane ? landingLane.surfaceY : 0;
      // Water hops always either land on a log or die — anticipate the log
      // so the cat doesn't briefly snap to the water surface mid-landing.
      if (landingLane?.type === 'water') landingY += LOG_REST_REL + LOG_SINK_REL + CAT_LOG_LIFT;
      // Landing on a bush tile: the cat perches on top of the foliage.
      else if (landingLane?.type === 'grass' && isBushAt(catX, catZ)) landingY += 0.35;
      // Arc + smooth lift from the starting Y, settling on the target lane's surface.
      cat.position.y = hopFromY * (1 - tt) + landingY * tt + Math.sin(tt * Math.PI) * 0.45;
      const sq = 1 + Math.sin(tt * Math.PI) * 0.15;
      cat.scale.set(CAT_SCALE, CAT_SCALE * sq, CAT_SCALE);
      if (tt >= 1) {
        hopActive = false;
        cat.position.y = landingY;
        cat.scale.setScalar(CAT_SCALE);
        onLanded();
      }
    } else if (onLog) {
      catWorldX = onLog.v.x + logOffsetX;
      cat.position.x = catWorldX;
      // Sink with the log, but lifted so the smaller cat stops clipping into it.
      const targetY = onLog.lane.surfaceY + LOG_REST_REL + LOG_SINK_REL + CAT_LOG_LIFT;
      cat.position.y += (targetY - cat.position.y) * Math.min(1, dt * 9);
    }

    if (!hopActive && !gameOver) {
      const lane = lanes.get(catZ);
      if (lane?.type === 'road') {
        for (const v of lane.vehicles) {
          if (Math.abs(v.x - catWorldX) < v.w / 2 + 0.25) { die('car'); break; }
        }
      } else if (lane?.type === 'railroad') {
        for (const t of trains) {
          if (t.lane.z === catZ && Math.abs(t.x - catWorldX) < t.w / 2 + 0.25) { die('train'); break; }
        }
      }
    }

    if (minZReached - catZ < -BACK_LIMIT) die('eagle');

    const targetCamZ = Math.min(cameraZ, catWorldZ);
    cameraZ += (targetCamZ - cameraZ) * Math.min(1, dt * 6);
    cameraX += (catWorldX - cameraX) * Math.min(1, dt * 8);

    const targetGen = Math.floor(catWorldZ) - 20;
    while (furthestZ > targetGen) makeLane(furthestZ - 1);

    const removeAfter = Math.ceil(catWorldZ) + 14;
    for (const [z, lane] of [...lanes.entries()]) {
      if (z > removeAfter) {
        disposeLane(lane);
        lanes.delete(z);
        decorDirty = true;
      }
    }
  }

  updateLaneGroups(cameraX);
  updateMeadowTexture(cameraX);
  updateRoadTextures(cameraX);
  updateRailroadTexture(cameraX);
  updateWaterWallTexture(cameraX);
  updateGrassObstacles(cameraX);
  updateDecor(cameraX);

  // Orbit the camera around the lookAt point on the vertical (Y) axis. At
  // currentRotationDeg = 0 this is identical to the authored framing.
  {
    const lookAtX = cameraX;
    const lookAtZ = cameraZ + CAM_LOOK_AHEAD_Z;
    const offX = CAM_OFFSET.x;
    const offZ = CAM_OFFSET.z - CAM_LOOK_AHEAD_Z;
    const rad = currentRotationDeg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    camera.position.set(
      lookAtX + offX * c - offZ * s,
      CAM_OFFSET.y,
      lookAtZ + offX * s + offZ * c
    );
    camera.lookAt(lookAtX, 0, lookAtZ);
  }
  updateCameraZoom(dt);

  sunTarget.position.set(cameraX, 0, cameraZ);
  sun.position.set(cameraX + 22, 30, cameraZ + 16);

  renderer.render(scene, camera);
  if (wireframeOn) {
    // Second pass: solid scene already in the framebuffer, draw wireframe over.
    scene.overrideMaterial = wireframeOverlayMat;
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = true;
    scene.overrideMaterial = null;
  }
  updatePerfStats(dt, now);
}

// ===== Wireframe overlay =====
// polygonOffset pulls the wires slightly toward the camera so they don't z-fight
// with the underlying solid surface.
const wireframeOverlayMat = new THREE.MeshBasicMaterial({
  color: 0x00ff88,
  wireframe: true,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
let wireframeOn = false;
const wireframeEl = document.getElementById('wireframeOn');
if (wireframeEl) wireframeEl.addEventListener('change', () => { wireframeOn = wireframeEl.checked; });

// ===== Debug perf stats (FPS, draw calls, triangles) =====
const statFpsEl   = document.getElementById('statFps');
const statCallsEl = document.getElementById('statCalls');
const statTrisEl  = document.getElementById('statTris');
let fpsAccumDt = 0, fpsAccumFrames = 0;
let statsLastFlush = 0;

function updatePerfStats(dt, now) {
  fpsAccumDt += dt;
  fpsAccumFrames += 1;
  // Flush every ~250ms so the numbers are stable enough to read.
  if (now - statsLastFlush < 250) return;
  statsLastFlush = now;
  const fps = fpsAccumDt > 0 ? fpsAccumFrames / fpsAccumDt : 0;
  fpsAccumDt = 0; fpsAccumFrames = 0;
  if (statFpsEl)   statFpsEl.textContent   = fps.toFixed(0);
  if (statCallsEl) statCallsEl.textContent = renderer.info.render.calls;
  if (statTrisEl)  statTrisEl.textContent  = renderer.info.render.triangles.toLocaleString();
}

// ===== Debug menu: sound selection + volumes =====
const fxJumpEl  = document.getElementById('fxJump');
const fxHonkEl  = document.getElementById('fxHonk');
const volJumpEl = document.getElementById('volJump');
const volHonkEl = document.getElementById('volHonk');
const volMusicEl = document.getElementById('volMusic');
const musicEl   = document.getElementById('musicTrack');

if (fxJumpEl) {
  fxJumpEl.value = jumpSelection;
  fxJumpEl.addEventListener('change', e => { jumpSelection = e.target.value; });
}
if (fxHonkEl) {
  fxHonkEl.value = honkSelection;
  fxHonkEl.addEventListener('change', e => { honkSelection = e.target.value; });
}
if (volJumpEl) {
  setSoundVolume('jump', parseFloat(volJumpEl.value));
  volJumpEl.addEventListener('input', e => setSoundVolume('jump', parseFloat(e.target.value)));
}
if (volHonkEl) {
  setSoundVolume('honk', parseFloat(volHonkEl.value));
  volHonkEl.addEventListener('input', e => setSoundVolume('honk', parseFloat(e.target.value)));
}
if (volMusicEl) {
  setSoundVolume('music', parseFloat(volMusicEl.value));
  volMusicEl.addEventListener('input', e => setSoundVolume('music', parseFloat(e.target.value)));
}
if (musicEl) {
  musicEl.value = musicOn ? currentMusicId : 'none';
  musicEl.addEventListener('change', e => selectMusicTrack(e.target.value));
}
const waterAmbEl = document.getElementById('waterAmbientOnOff');
const volWaterEl = document.getElementById('volWater');
const volSplashEl = document.getElementById('volSplash');
if (volSplashEl) {
  setSoundVolume('splash', parseFloat(volSplashEl.value));
  volSplashEl.addEventListener('input', e => setSoundVolume('splash', parseFloat(e.target.value)));
}
const muteAllEl = document.getElementById('muteAll');
if (muteAllEl) {
  muteAllEl.addEventListener('change', e => setMuteAll(e.target.checked));
}
const debugToggleEl = document.getElementById('debugToggle');
const debugRootEl   = document.getElementById('debug');
if (debugToggleEl && debugRootEl) {
  debugToggleEl.addEventListener('click', () => {
    const collapsed = debugRootEl.classList.toggle('collapsed');
    debugToggleEl.textContent = collapsed ? '+' : '−';
    debugToggleEl.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
  });
}
const btnRotate45El = document.getElementById('btnRotate45');
if (btnRotate45El) {
  btnRotate45El.addEventListener('click', () => { targetRotationDeg += 90; });
}
const btnResetRotationEl = document.getElementById('btnResetRotation');
if (btnResetRotationEl) {
  btnResetRotationEl.addEventListener('click', () => { targetRotationDeg = 0; });
}
if (waterAmbEl) {
  waterAmbEl.value = waterAmbientOn ? 'on' : 'off';
  waterAmbEl.addEventListener('change', e => { waterAmbientOn = (e.target.value === 'on'); });
}
if (volWaterEl) {
  setSoundVolume('waterAmbient', parseFloat(volWaterEl.value));
  volWaterEl.addEventListener('input', e => setSoundVolume('waterAmbient', parseFloat(e.target.value)));
}

tick();
