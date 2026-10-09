import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { processImage, buildMesh, toSTL, toOBJ, stlBytes } from './mesh.js';

const $ = id => document.getElementById(id);

// ---------- State ----------
const DEFAULTS = {
  shape: 'flat', width: 100, curve: 120, maxT: 3, minT: 0.6, border: 3, res: 300,
  bri: 0, con: 0, gam: 1, blur: 0, invert: false, mirror: false,
};
const STORE = 'lithophane-settings-v2';
const S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE)) || {}); } catch { /* private mode */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* ignore */ } };

let img = null;
let mesh = null, model = null, light = null, gridDims = null;
let view = 'solid', wireOn = false, regenTimer = null;

const SHAPE_HINT = {
  flat: 'A panel to stand in front of a window or a lamp.',
  curved: 'An arched panel that stands on its own, with a tea light behind it.',
  cylinder: 'A closed lampshade that sits over an LED light. Width is the circumference.',
};

// ---------- Three setup ----------
const host = $('canvasHost');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
host.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// low raking key light: the way you inspect a relief by eye
scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8c86, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(-220, -60, 110); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.3); fill.position.set(160, -200, 120); scene.add(fill);

// print bed under the model: 10 mm cells, rebuilt to fit the model
let grid = null;
function fitGrid(sx, sy) {
  const cells = Math.ceil(Math.max(sx, sy) * 1.5 / 20) * 2;
  if (grid?.userData.cells === cells) return;
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(cells * 10, cells, 0xc2c2bd, 0xd2d2ce);
  grid.rotation.x = Math.PI / 2; grid.position.z = -0.05; grid.userData.cells = cells;
  if (grid) grid.visible = view === 'solid';
  scene.add(grid);
}

const solidMat = new THREE.MeshStandardMaterial({ color: 0xfafaf8, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
const litMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function frame() {
  const [sx, sy, sz] = model ? model.size : [S.width, S.width * 0.75, 3];
  const r = Math.max(sx, sy, sz);
  const standing = S.shape !== 'flat';
  fitGrid(sx, sy);
  controls.target.set(0, 0, standing ? sz / 2 : 0);
  if (standing) camera.position.set(r * 0.35, -r * 2.1, sz * 0.85);
  else camera.position.set(0, -r * 0.72, r * 1.25); // looking down at the face, slightly from the front
  controls.update();
}

// ---------- Image → model ----------
function gridSize() {
  const long = S.res, a = img.width / img.height;
  return a >= 1
    ? [long, Math.max(2, Math.round(long / a))]
    : [Math.max(2, Math.round(long * a)), long];
}

function sample(cols, rows) {
  const c = document.createElement('canvas');
  c.width = cols; c.height = rows;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cols, rows); // transparent PNG → white
  ctx.drawImage(img, 0, 0, cols, rows);
  return processImage(ctx.getImageData(0, 0, cols, rows).data, cols, rows, { ...S, widthMM: S.width });
}

function lightCanvas(L, cols, rows) {
  const c = document.createElement('canvas');
  c.width = cols; c.height = rows;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(cols, rows);
  for (let i = 0; i < L.length; i++) { const g = Math.round(L[i] * 255); id.data.set([g, g, g, 255], i * 4); }
  ctx.putImageData(id, 0, 0);
  return c;
}

function litColors(thick) {
  // how much light passes through each point: thin = warm glow, thick = dark
  const col = new Float32Array(thick.length * 3), span = Math.max(0.01, S.maxT - S.minT);
  for (let i = 0; i < thick.length; i++) {
    const k = Math.pow(Math.min(1, Math.max(0, (S.maxT - thick[i]) / span)), 1.5);
    const v = 0.03 + 0.97 * k;
    col[i * 3] = v; col[i * 3 + 1] = v * (0.82 + 0.12 * k); col[i * 3 + 2] = v * (0.55 + 0.3 * k);
  }
  return col;
}

function regen() {
  if (!img) return;
  $('loading').hidden = false;
  // let the spinner paint before the heavy work (setTimeout, not rAF: rAF stalls in background tabs)
  setTimeout(() => {
    const t0 = performance.now();
    try {
      const [cols, rows] = gridSize();
      const { light: L, thick } = sample(cols, rows);
      const first = !model;
      model = buildMesh(thick, cols, rows, { shape: S.shape, widthMM: S.width, curveDeg: S.curve });
      light = L; gridDims = [cols, rows];

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(litColors(model.thickness), 3));
      g.setIndex(new THREE.BufferAttribute(model.index, 1));
      g.computeVertexNormals();
      if (mesh) { mesh.geometry.dispose(); mesh.geometry = g; }
      else { mesh = new THREE.Mesh(g, solidMat); scene.add(mesh); }
      applyView();
      if (first) frame(); else fitGrid(model.size[0], model.size[1]);

      const tris = model.index.length / 3;
      $('sSize').textContent = model.size.map(v => v.toFixed(v < 10 ? 1 : 0)).join(' × ') + ' mm';
      $('sTris').textContent = (tris >= 1e6 ? (tris / 1e6).toFixed(1) + ' M' : Math.round(tris / 1e3) + ' k') + ' triangles';
      $('sFile').textContent = fmtBytes(stlBytes(tris));
      setExport(true);
      if (view === 'map') drawMap();
    } catch (e) {
      console.error(e);
      toast('Could not build the model: ' + e.message, true);
    }
    $('loading').hidden = true;
    console.debug(`[lithophane] regen ${Math.round(performance.now() - t0)} ms`);
  }, 30);
}
function scheduleRegen() { save(); clearTimeout(regenTimer); regenTimer = setTimeout(regen, 160); }

// ---------- Views ----------
function applyView() {
  $('viewport').classList.toggle('lit', view === 'lit');
  host.hidden = view === 'map';
  $('imgCanvas').hidden = view !== 'map' || !img;
  if (grid) grid.visible = view === 'solid';
  if (mesh) { mesh.material = view === 'lit' ? litMat : solidMat; mesh.material.wireframe = wireOn; }
  $('vpTools').hidden = $('readout').hidden = !img || view === 'map';
}
function drawMap() {
  if (!light) return;
  const src = lightCanvas(light, ...gridDims), cv = $('imgCanvas');
  cv.width = src.width; cv.height = src.height;
  cv.getContext('2d').drawImage(src, 0, 0);
}

// ---------- Export ----------
function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB'; }
function fileBase() { return `lithophane-${{ flat: 'flat', curved: 'curved', cylinder: 'cylinder' }[S.shape]}-${S.width}mm`; }
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast(`Downloaded ${name} · ${fmtBytes(blob.size)}`);
}
function setExport(on) { ['exStl', 'exObj', 'exPng'].forEach(id => $(id).disabled = !on); }

$('exStl').addEventListener('click', () => model && download(new Blob([toSTL(model.positions, model.index)], { type: 'model/stl' }), fileBase() + '.stl'));
$('exObj').addEventListener('click', () => model && download(new Blob([toOBJ(model.positions, model.index)], { type: 'model/obj' }), fileBase() + '.obj'));
$('exPng').addEventListener('click', () => {
  if (!img) return;
  // full-resolution light map (capped at 2400 px on the long side)
  const long = Math.min(2400, Math.max(img.width, img.height)), a = img.width / img.height;
  const cols = a >= 1 ? long : Math.max(2, Math.round(long * a)), rows = a >= 1 ? Math.max(2, Math.round(long / a)) : long;
  lightCanvas(sample(cols, rows).light, cols, rows).toBlob(b => download(b, fileBase() + '-lightmap.png'), 'image/png');
});

// ---------- Loading images ----------
function loadImage(src, name) {
  const im = new Image();
  im.onload = () => {
    img = im; model = null;
    $('thumb').src = src; $('thumbName').textContent = `${name} · ${im.width}×${im.height} px`;
    $('thumbWrap').hidden = false; $('drop').hidden = true; $('empty').hidden = true;
    regen();
  };
  im.onerror = () => toast('Could not read this image. Use JPG, PNG or WEBP.', true);
  im.src = src;
}
function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('That file is not an image.', true);
  loadImage(URL.createObjectURL(file), file.name);
}
$('file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => $('file').click()));
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('clearImg').addEventListener('click', () => {
  img = null; model = null; light = null;
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }
  $('thumbWrap').hidden = true; $('drop').hidden = false; $('empty').hidden = false;
  ['sSize', 'sTris', 'sFile'].forEach(id => $(id).textContent = '');
  setExport(false); applyView();
});
$('sample').addEventListener('click', () => loadImage(makeSample(), 'sample.png'));

// drag & drop anywhere on the page
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; $('drop').classList.add('over'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; $('drop').classList.remove('over'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; $('drop').classList.remove('over');
  loadFile(e.dataTransfer.files[0]);
});
addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

function makeSample() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 600;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 600);
  sky.addColorStop(0, '#0d1633'); sky.addColorStop(0.6, '#3b4f86'); sky.addColorStop(1, '#e9b27a');
  g.fillStyle = sky; g.fillRect(0, 0, 900, 600);
  const moon = g.createRadialGradient(640, 170, 10, 640, 170, 140);
  moon.addColorStop(0, '#fffbe8'); moon.addColorStop(0.45, '#fff2c8'); moon.addColorStop(0.5, 'rgba(255,240,200,.35)'); moon.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = moon; g.fillRect(0, 0, 900, 600);
  g.fillStyle = '#05070d';
  g.beginPath(); g.moveTo(0, 600); g.lineTo(0, 430); g.lineTo(170, 300); g.lineTo(300, 400); g.lineTo(460, 250);
  g.lineTo(650, 440); g.lineTo(780, 360); g.lineTo(900, 450); g.lineTo(900, 600); g.fill();
  g.fillStyle = '#1b2240';
  g.beginPath(); g.moveTo(0, 600); g.lineTo(0, 520); g.lineTo(260, 460); g.lineTo(520, 540); g.lineTo(900, 480); g.lineTo(900, 600); g.fill();
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.7})`; g.fillRect(Math.random() * 900, Math.random() * 260, 2, 2); }
  return c.toDataURL('image/png');
}

// ---------- Controls ----------
const SLIDERS = {
  width: v => v + ' mm', curve: v => v + '°', maxT: v => (+v).toFixed(1) + ' mm', minT: v => (+v).toFixed(1) + ' mm',
  border: v => (+v).toFixed(1) + ' mm', bri: v => (v > 0 ? '+' : '') + v, con: v => (v > 0 ? '+' : '') + v,
  gam: v => (+v).toFixed(2), blur: v => +v ? (+v).toFixed(1) : 'off',
};
function paint(el) {
  $('o-' + el.id).textContent = SLIDERS[el.id](el.value);
  el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
}
function syncUI() {
  for (const id in SLIDERS) { $(id).value = S[id]; paint($(id)); }
  for (const [id, key] of [['shape', 'shape'], ['quality', 'res']])
    $(id).querySelectorAll('button').forEach(b => {
      const on = b.dataset.val === String(S[key]);
      b.classList.toggle('active', on); b.setAttribute('aria-checked', on);
    });
  $('invert').checked = S.invert; $('mirror').checked = S.mirror;
  $('curveField').hidden = S.shape !== 'curved';
  $('shapeHint').textContent = SHAPE_HINT[S.shape];
  $('widthName').textContent = S.shape === 'cylinder' ? 'Circumference' : 'Width';
}

for (const id in SLIDERS) {
  const el = $(id);
  el.addEventListener('input', () => {
    S[id] = parseFloat(el.value);
    // keep min < max
    if (id === 'minT' && S.minT > S.maxT - 0.2) { S.maxT = Math.min(10, +(S.minT + 0.2).toFixed(1)); $('maxT').value = S.maxT; paint($('maxT')); }
    if (id === 'maxT' && S.maxT < S.minT + 0.2) { S.minT = Math.max(0.2, +(S.maxT - 0.2).toFixed(1)); $('minT').value = S.minT; paint($('minT')); }
    paint(el); scheduleRegen();
  });
  el.addEventListener('dblclick', () => { S[id] = DEFAULTS[id]; syncUI(); scheduleRegen(); });
}
['invert', 'mirror'].forEach(k => $(k).addEventListener('change', e => { S[k] = e.target.checked; scheduleRegen(); }));
$('shape').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.val === S.shape) return;
  S.shape = b.dataset.val; syncUI(); model = null; scheduleRegen();
});
$('quality').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.res = +b.dataset.val; syncUI(); scheduleRegen();
});
$('resetAll').addEventListener('click', () => { Object.assign(S, DEFAULTS); syncUI(); model = null; scheduleRegen(); toast('Recommended values restored'); });

$('viewModes').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  view = b.dataset.mode;
  $('viewModes').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  applyView();
  if (view === 'map') drawMap();
});
$('resetView').addEventListener('click', frame);
$('wire').addEventListener('click', () => {
  wireOn = !wireOn; $('wire').setAttribute('aria-pressed', wireOn);
  if (mesh) mesh.material.wireframe = wireOn;
});

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.classList.toggle('err', err); t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, err ? 5000 : 2800);
}

syncUI();
frame();
