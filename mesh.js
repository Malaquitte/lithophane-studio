// Pure geometry: no DOM, no three.js. Runs in the browser and in Node (see test/mesh.test.mjs).

// ---------- Image → light map → thickness ----------

function boxBlur(src, cols, rows, r) {
  // separable box blur, run twice ≈ gaussian
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src);
  const pass = (a, b, horiz) => {
    const n = horiz ? cols : rows, m = horiz ? rows : cols;
    for (let j = 0; j < m; j++) {
      let acc = 0;
      const at = i => horiz ? a[j * cols + Math.min(n - 1, Math.max(0, i))] : a[Math.min(n - 1, Math.max(0, i)) * cols + j];
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < n; i++) {
        b[horiz ? j * cols + i : i * cols + j] = acc / (2 * r + 1);
        acc += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let k = 0; k < 2; k++) { pass(out, tmp, true); pass(tmp, out, false); }
  return out;
}

/**
 * rgba: Uint8ClampedArray (cols*rows*4).
 * Returns light (0..1, 1 = lets the most light through) and thickness (mm) per grid point.
 */
export function processImage(rgba, cols, rows, o) {
  const n = cols * rows;
  let lum = new Float32Array(n);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const sx = o.mirror ? cols - 1 - x : x;
      const i = (y * cols + sx) * 4;
      lum[y * cols + x] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    }
  if (o.blur > 0) lum = boxBlur(lum, cols, rows, Math.max(1, Math.round(o.blur * Math.max(cols, rows) / 300)));

  const c = Math.max(-254, Math.min(254, o.con * 2.55));
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const bri = o.bri / 100 * 255;
  const ig = 1 / o.gam;
  const span = o.maxT - o.minT;
  const borderPx = o.border > 0 ? Math.round(o.border / (o.widthMM / cols)) : 0;

  const light = new Float32Array(n), thick = new Float32Array(n);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const k = y * cols + x;
      let v = cf * (lum[k] + bri - 128) + 128;
      v = Math.pow(Math.min(255, Math.max(0, v)) / 255, ig);
      if (o.invert) v = 1 - v;
      const edge = borderPx > 0 && (x < borderPx || x >= cols - borderPx || y < borderPx || y >= rows - borderPx);
      if (edge) v = 0;
      light[k] = v;
      thick[k] = o.maxT - v * span; // bright → thin
    }
  return { light, thick };
}

// ---------- Thickness grid → closed solid ----------

/**
 * Builds a watertight, outward-facing indexed mesh.
 * flat: lies on the bed (thickness along Z). curved / cylinder: stand upright (image height along Z).
 * Output is centred on X/Y with its lowest point at Z = 0.
 */
export function buildMesh(thick, cols, rows, o) {
  const wrap = o.shape === 'cylinder';
  const W = o.widthMM;
  const dx = wrap ? W / cols : W / (cols - 1);
  const H = (rows - 1) * dx, dy = dx; // square pixels
  const theta = (o.curveDeg || 120) * Math.PI / 180;

  const nG = cols * rows;
  const pos = new Float32Array(nG * 2 * 3);
  const vThick = new Float32Array(nG * 2);

  const put = (vi, px, py, t) => {
    let X, Y, Z;
    if (o.shape === 'curved') {
      const R = W / theta, ang = px / W * theta, r = R + t;
      X = r * Math.sin(ang); Y = R - r * Math.cos(ang); Z = py;
    } else if (wrap) {
      const R = W / (2 * Math.PI), ang = px / W * 2 * Math.PI, r = R + t;
      X = r * Math.sin(ang); Y = -r * Math.cos(ang); Z = py;
    } else { X = px; Y = py; Z = t; }
    pos[vi * 3] = X; pos[vi * 3 + 1] = Y; pos[vi * 3 + 2] = Z;
  };

  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const k = y * cols + x, px = x * dx - W / 2, py = H / 2 - y * dy, t = thick[k];
      put(k, px, py, t);        // relief surface
      put(nG + k, px, py, 0);   // back surface
      vThick[k] = vThick[nG + k] = t;
    }

  const segX = wrap ? cols : cols - 1;
  const walls = (wrap ? 0 : 2 * (rows - 1)) + 2 * segX;
  const index = new Uint32Array((2 * segX * (rows - 1) * 2 + walls * 2) * 3);
  let f = 0;
  const tri = (a, b, c) => { index[f++] = a; index[f++] = b; index[f++] = c; };
  const T = (x, y) => y * cols + (x % cols), B = (x, y) => nG + T(x, y);

  for (let y = 0; y < rows - 1; y++)
    for (let x = 0; x < segX; x++) {
      tri(T(x, y), T(x + 1, y), T(x + 1, y + 1)); tri(T(x, y), T(x + 1, y + 1), T(x, y + 1));
      tri(B(x, y), B(x + 1, y + 1), B(x + 1, y)); tri(B(x, y), B(x, y + 1), B(x + 1, y + 1));
    }
  // wall under each relief boundary edge P→Q
  const wall = (P, Q) => { tri(Q, P, P + nG); tri(Q, P + nG, Q + nG); };
  for (let x = 0; x < segX; x++) { wall(T(x, 0), T(x + 1, 0)); wall(T(x + 1, rows - 1), T(x, rows - 1)); }
  if (!wrap)
    for (let y = 0; y < rows - 1; y++) { wall(T(cols - 1, y), T(cols - 1, y + 1)); wall(T(0, y + 1), T(0, y)); }

  // orientation depends on the shape mapping; make normals point out
  if (signedVolume(pos, index) < 0)
    for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], pos[i + a]); mx[a] = Math.max(mx[a], pos[i + a]); }
  const off = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) pos[i + a] -= off[a];

  return { positions: pos, index, thickness: vThick, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

export function signedVolume(pos, index) {
  let v = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
       - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
       + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

// ---------- Exporters ----------

export function toSTL(pos, index) {
  const nTri = index.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const head = 'Lithophane Studio binary STL';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let off = 84;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(off, nx / l, true); dv.setFloat32(off + 4, ny / l, true); dv.setFloat32(off + 8, nz / l, true); off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, pos[p], true); dv.setFloat32(off + 4, pos[p + 1], true); dv.setFloat32(off + 8, pos[p + 2], true); off += 12;
    }
    off += 2; // attribute byte count = 0
  }
  return buf;
}

export function toOBJ(pos, index) {
  const lines = ['# Lithophane Studio', `# ${pos.length / 3} vertices, ${index.length / 3} triangles, units: mm`];
  for (let i = 0; i < pos.length; i += 3) lines.push(`v ${pos[i].toFixed(3)} ${pos[i + 1].toFixed(3)} ${pos[i + 2].toFixed(3)}`);
  for (let i = 0; i < index.length; i += 3) lines.push(`f ${index[i] + 1} ${index[i + 1] + 1} ${index[i + 2] + 1}`);
  return lines.join('\n') + '\n';
}

export const stlBytes = nTri => 84 + nTri * 50;
