// node test/mesh.test.mjs — checks every shape gives a closed, outward-facing, print-ready solid.
import assert from 'node:assert/strict';
import { processImage, buildMesh, signedVolume, arcAngle, toSTL, toOBJ } from '../mesh.js';

const cols = 40, rows = 30;
const rgba = new Uint8ClampedArray(cols * rows * 4);
for (let i = 0; i < cols * rows; i++) { const v = (i * 37) % 256; rgba.set([v, 255 - v, v, 255], i * 4); }

const base = { bri: 0, con: 0, gam: 1, blur: 0, invert: false, mirror: false, minT: 0.6, maxT: 3, border: 3, widthMM: 100 };

for (const con of [-100, 0, 70, 100]) {
  const { light } = processImage(rgba, cols, rows, { ...base, con, border: 0 });
  assert(light.every(v => v >= 0 && v <= 1), `light in range at con=${con}`);
}
{
  // a black pixel must be thick, a white one thin, unless inverted
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const n = processImage(px, 2, 1, { ...base, border: 0 }).thick;
  assert.equal(n[0], 3); assert.ok(Math.abs(n[1] - 0.6) < 1e-6);
  const inv = processImage(px, 2, 1, { ...base, border: 0, invert: true }).thick;
  assert.ok(Math.abs(inv[0] - 0.6) < 1e-6);
}

for (const shape of ['flat', 'curved', 'cylinder']) {
  for (const blur of [0, 2]) {
    const { thick } = processImage(rgba, cols, rows, { ...base, blur });
    const m = buildMesh(thick, cols, rows, { shape, widthMM: 100, curveDeg: 120 });
    // every directed edge appears once and its reverse once → closed 2-manifold, consistent winding
    const edges = new Map();
    for (let i = 0; i < m.index.length; i += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.index[i + e], b = m.index[i + (e + 1) % 3];
        const k = a + ',' + b;
        assert(!edges.has(k), `${shape}: duplicate directed edge ${k}`);
        edges.set(k, 1);
      }
    for (const k of edges.keys()) { const [a, b] = k.split(','); assert(edges.has(b + ',' + a), `${shape}: open edge ${k}`); }
    const vol = signedVolume(m.positions, m.index);
    assert(vol > 0, `${shape}: volume must be positive (outward normals), got ${vol}`);
    let minZ = Infinity; for (let i = 2; i < m.positions.length; i += 3) minZ = Math.min(minZ, m.positions[i]);
    assert(Math.abs(minZ) < 1e-4, `${shape}: sits on Z=0`);
    const stl = toSTL(m.positions, m.index);
    assert.equal(stl.byteLength, 84 + (m.index.length / 3) * 50);
    assert.equal(new DataView(stl).getUint32(80, true), m.index.length / 3);
    assert(toOBJ(m.positions, m.index).split('\n').filter(l => l.startsWith('f ')).length === m.index.length / 3);
    console.log(`ok ${shape} blur=${blur}: ${m.index.length / 3} tris, vol ${vol.toFixed(0)} mm³, size ${m.size.map(v => v.toFixed(1)).join('×')} mm`);
  }
}
// fixed height: the model is exactly that tall, whatever the grid
for (const shape of ['flat', 'curved', 'cylinder']) {
  const { thick } = processImage(rgba, cols, rows, { ...base, heightMM: 140 });
  const m = buildMesh(thick, cols, rows, { shape, widthMM: 100, heightMM: 140, curveDeg: 120 });
  const h = shape === 'flat' ? m.size[1] : m.size[2];
  assert(Math.abs(h - 140) < 1e-3, `${shape}: height 140 mm, got ${h}`);
  assert(signedVolume(m.positions, m.index) > 0);
}
// fixed radius: the arc follows the width, the radius does not change
{
  const deg = o => arcAngle(o) * 180 / Math.PI;
  assert(Math.abs(deg({ widthMM: 100, radiusMM: 100 }) - 57.2958) < 1e-3);
  assert(Math.abs(deg({ widthMM: 200, radiusMM: 100 }) - 114.5916) < 1e-3);
  assert.equal(Math.round(deg({ widthMM: 400, radiusMM: 20 })), 300); // capped
  assert.equal(Math.round(deg({ widthMM: 100, curveDeg: 90 })), 90);
  const { thick } = processImage(rgba, cols, rows, { ...base, border: 0, maxT: 1, minT: 1 });
  const m = buildMesh(thick, cols, rows, { shape: 'curved', widthMM: 100, heightMM: 60, radiusMM: 80 });
  // back surface sits on a circle of radius 80: chord between ends = 2R sin(θ/2)
  const th = 100 / 80;
  assert(Math.abs(m.size[0] - 2 * 81 * Math.sin(th / 2)) < 0.05, `curved chord ${m.size[0]}`);
}
console.log('all mesh tests passed');
