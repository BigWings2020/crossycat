import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const statsEl = document.getElementById('stats');

// ===== Scene / renderer =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x404858);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200);
camera.position.set(4, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ===== Lighting =====
// PBR environment so MeshStandardMaterial reflections look correct
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 1.4; // boost IBL contribution

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x40424a, 0.9));

const key = new THREE.DirectionalLight(0xfff1d6, 3.5);
key.position.set(6, 8, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -5;
key.shadow.camera.right = 5;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -5;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 30;
key.shadow.bias = -0.0005;
scene.add(key);

const rim = new THREE.DirectionalLight(0xaac8ff, 1.2);
rim.position.set(-6, 4, -3);
scene.add(rim);

const fill = new THREE.DirectionalLight(0xffe8c4, 0.7);
fill.position.set(2, 3, -6);
scene.add(fill);

// ===== Ground =====
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(20, 64),
  new THREE.MeshStandardMaterial({ color: 0x5a6478, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(20, 20, 0x9aa6bc, 0x6e7a8e);
grid.position.y = 0.001;
scene.add(grid);

// ===== Controls =====
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.5, 0);

// ===== Wireframe overlay state =====
const wireMaterial = new THREE.MeshBasicMaterial({
  color: 0x00ff99,
  wireframe: true,
  transparent: true,
  opacity: 0.85,
  depthTest: true,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
const solidMeshes = []; // original meshes
const wireMeshes = [];  // wireframe overlays (siblings of solid)
const meshOrigMaterial = new Map();   // mesh -> original Material(s)
const meshUnlitMaterial = new Map();  // mesh -> cached unlit twin(s)

function makeUnlitFrom(mat) {
  return new THREE.MeshBasicMaterial({
    map: mat.map ?? null,
    color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
    vertexColors: !!mat.vertexColors,
    transparent: !!mat.transparent,
    opacity: mat.opacity ?? 1,
    alphaMap: mat.alphaMap ?? null,
    alphaTest: mat.alphaTest ?? 0,
    side: mat.side ?? THREE.FrontSide,
  });
}

function getUnlitMaterial(mesh) {
  if (!meshUnlitMaterial.has(mesh)) {
    const orig = meshOrigMaterial.get(mesh);
    meshUnlitMaterial.set(
      mesh,
      Array.isArray(orig) ? orig.map(makeUnlitFrom) : makeUnlitFrom(orig)
    );
  }
  return meshUnlitMaterial.get(mesh);
}

// ===== Load GLB =====
const loader = new GLTFLoader();
loader.load(
  'Car_Green.glb',
  (gltf) => {
    const model = gltf.scene;

    // Collect first; don't mutate the tree while traversing or new wire
    // children get re-visited and we recurse forever.
    let meshCount = 0, triCount = 0;
    const collected = [];
    model.traverse(obj => {
      if (obj.isMesh) collected.push(obj);
    });
    for (const obj of collected) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      meshCount++;
      const geo = obj.geometry;
      if (geo?.index) triCount += geo.index.count / 3;
      else if (geo?.attributes?.position) triCount += geo.attributes.position.count / 3;
      solidMeshes.push(obj);
      meshOrigMaterial.set(obj, obj.material);
      const wire = new THREE.Mesh(geo, wireMaterial);
      wire.visible = false;
      wire.castShadow = false;
      wire.receiveShadow = false;
      wire.userData.isWireOverlay = true; // safety marker if anything else traverses
      obj.add(wire);
      wireMeshes.push(wire);
    }

    // Auto-center and frame
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.x += -center.x;
    model.position.y += -box.min.y;       // rest on the ground
    model.position.z += -center.z;
    scene.add(model);

    // Frame the camera to fit the model
    const maxDim = Math.max(size.x, size.y, size.z);
    const fitDist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360)) * 1.7;
    camera.position.set(fitDist * 0.7, fitDist * 0.55, fitDist * 0.9);
    controls.target.set(0, size.y * 0.5, 0);
    controls.update();

    statsEl.textContent =
      `Car_Green.glb\n` +
      `meshes: ${meshCount}\n` +
      `tris: ${Math.round(triCount).toLocaleString()}\n` +
      `bbox: ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;

    // Sync initial panel state once meshes exist
    applyVisibility();
  },
  (xhr) => {
    if (xhr.total) {
      const pct = (xhr.loaded / xhr.total * 100).toFixed(0);
      statsEl.textContent = `loading ${pct}%`;
    }
  },
  (err) => {
    statsEl.textContent = 'failed to load: ' + (err?.message || err);
    console.error(err);
  }
);

// ===== Panel wiring =====
const wireCb = document.getElementById('wire');
const solidCb = document.getElementById('solid');
const unlitCb = document.getElementById('unlit');
const gridCb = document.getElementById('grid');
const exposureSlider = document.getElementById('exposure');
const expVal = document.getElementById('expVal');

function applyVisibility() {
  // Swap each mesh to its unlit twin or the original material based on the toggle.
  for (const m of solidMeshes) {
    m.material = unlitCb.checked ? getUnlitMaterial(m) : meshOrigMaterial.get(m);
    // Hide the solid render (but keep the node visible) so the wireframe child still draws.
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat) mat.visible = solidCb.checked;
  }
  for (const w of wireMeshes) w.visible = wireCb.checked;
  grid.visible = gridCb.checked;
  ground.visible = gridCb.checked;
}

wireCb.addEventListener('change', applyVisibility);
solidCb.addEventListener('change', applyVisibility);
unlitCb.addEventListener('change', applyVisibility);
gridCb.addEventListener('change', applyVisibility);

exposureSlider.addEventListener('input', () => {
  const v = parseFloat(exposureSlider.value);
  renderer.toneMappingExposure = v;
  expVal.textContent = v.toFixed(2);
});

// ===== Texture modal =====
const TEX_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
  'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap',
  'iridescenceMap', 'specularMap', 'specularIntensityMap', 'specularColorMap',
];

const showTexBtn = document.getElementById('showTex');
const texModal = document.getElementById('texModal');
const texList = document.getElementById('texList');
const texClose = texModal.querySelector('.close');

function openTextureModal() {
  texList.innerHTML = '';
  const seen = new Set();
  let found = 0;

  for (const mesh of solidMeshes) {
    const orig = meshOrigMaterial.get(mesh);
    const mats = Array.isArray(orig) ? orig : [orig];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of TEX_SLOTS) {
        const tex = mat[slot];
        if (!tex || seen.has(tex)) continue;
        seen.add(tex);
        const card = makeTextureCard(slot, tex, mat.name || '');
        if (card) { texList.appendChild(card); found++; }
      }
    }
  }

  if (found === 0) {
    const note = document.createElement('div');
    note.style.opacity = '0.7';
    note.textContent = 'This model has no image textures (likely vertex-color shaded).';
    texList.appendChild(note);
  }
  texModal.classList.add('show');
}

function makeTextureCard(slot, tex, matName) {
  const img = tex.image;
  const card = document.createElement('div');
  card.className = 'tex-card';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dims = img ? `${img.width}×${img.height}` : 'no image';
  meta.textContent = `${slot}${matName ? ' · ' + matName : ''}  ${dims}`;
  card.appendChild(meta);

  const canvas = document.createElement('canvas');
  if (img && img.width) {
    const maxW = 480;
    const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      meta.textContent += '  (cannot draw: ' + e.message + ')';
    }
  } else {
    canvas.width = 32; canvas.height = 32;
  }
  card.appendChild(canvas);
  return card;
}

function closeTextureModal() { texModal.classList.remove('show'); }

showTexBtn.addEventListener('click', openTextureModal);
texClose.addEventListener('click', closeTextureModal);
texModal.addEventListener('click', e => { if (e.target === texModal) closeTextureModal(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeTextureModal(); });

// ===== Loop =====
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  renderer.render(scene, camera);
}
tick();
