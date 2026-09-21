// VENDORED from zagreb-zgrade-datiranje/facade-3d/js/facade-builder.js — keep in sync.
// Builds a THREE.Group from a Zagreb facade JSON spec (schema in that repo's PROMPT.md).
// Local frame: origin = bottom-left of facade, x along the wall, y up, z out of the wall.

import * as THREE from 'three';

const WALL_THICKNESS = 0.12;
const DEFAULT_RECESS = 0.15;   // glass/leaf recess into the wall
const FRAME_INSET = 0.08;      // window frame profile width
const FRAME_DEPTH = 0.05;
const GLASS_DARK = '#1a2026';
const GLASS_SHOP = '#2a3a44';
const FRAME_DEFAULT = '#4a4a42';
const DECOR_DEFAULT = '#e9e2cf';

function ts() { return new Date().toISOString(); }
function warn(msg) { console.warn(`[${ts()}] facade-builder: ${msg}`); }

// ---- material cache (one MeshLambertMaterial per color string) ----
const materialCache = new Map();
function mat(color) {
  const key = color || '#cccccc';
  if (!materialCache.has(key)) materialCache.set(key, new THREE.MeshLambertMaterial({ color: key }));
  return materialCache.get(key);
}

function darken(hex, f) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(1 - f);
  return '#' + c.getHexString();
}

// ---- small geometry helpers ----
function rectShape(x, y, w, h) {
  const s = new THREE.Shape();
  s.moveTo(x, y);
  s.lineTo(x + w, y);
  s.lineTo(x + w, y + h);
  s.lineTo(x, y + h);
  s.lineTo(x, y);
  return s;
}

function rectPath(x, y, w, h) {
  const p = new THREE.Path();
  p.moveTo(x, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.lineTo(x, y);
  return p;
}

function extrude(shape, depth, zOffset = 0) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  if (zOffset) g.translate(0, 0, zOffset);
  return g;
}

function box(w, h, d, color, cx, cy, cz) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(cx, cy, cz);
  return m;
}

// Extra height an arch adds above the rectangular opening top.
function archHeight(arch, w) {
  if (arch === 'round') return w / 2;
  if (arch === 'segmental') return Math.min(0.4, 0.12 * w);
  return 0;
}

// Path used as a hole: rectangular opening with an arched top.
function openingHole(ox, oy, ow, oh, arch) {
  const p = new THREE.Path();
  const left = ox, right = ox + ow, bottom = oy, topRect = oy + oh, cx = ox + ow / 2;
  p.moveTo(left, bottom);
  p.lineTo(right, bottom);
  p.lineTo(right, topRect);
  if (arch === 'round') {
    p.absarc(cx, topRect, ow / 2, 0, Math.PI, false);
  } else if (arch === 'segmental') {
    const ah = archHeight('segmental', ow);
    p.quadraticCurveTo(cx, topRect + 2 * ah, left, topRect);
  } else {
    p.lineTo(left, topRect);
  }
  p.lineTo(left, bottom);
  return p;
}

// ---- opening assembly (glass, frame, surround, pediment, sill) ----
// zBase = wall front face for this opening (0 for wall, bayDepth for bay openings).
function buildOpeningAssembly(group, op, zBase) {
  const ox = op.x, ow = op.w, oh = op.h;
  const oy = op.y; // absolute bottom (already includes floorY + sill)
  const cx = ox + ow / 2;
  const arch = op.arch || 'flat';
  const recess = typeof op.depth === 'number' ? op.depth : DEFAULT_RECESS;
  const ah = archHeight(arch, ow);

  // Glass: dark recessed plane covering the opening bounding box.
  const glassColor = op.type === 'shopfront' ? GLASS_SHOP : GLASS_DARK;
  const glassH = oh + ah;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(ow, glassH), mat(glassColor));
  glass.position.set(cx, oy + glassH / 2, zBase - recess);
  group.add(glass);

  // Frame: thin rectangular profile inset from the opening rect.
  if (ow > FRAME_INSET * 2.2 && oh > FRAME_INSET * 2.2) {
    const fs = rectShape(ox, oy, ow, oh);
    fs.holes.push(rectPath(ox + FRAME_INSET, oy + FRAME_INSET, ow - 2 * FRAME_INSET, oh - 2 * FRAME_INSET));
    const fg = extrude(fs, FRAME_DEPTH, zBase - recess);
    group.add(new THREE.Mesh(fg, mat(op.frameColor || FRAME_DEFAULT)));
  }

  // sillLedge: protruding box below the opening.
  const hasSillLedge = !!op.sillLedge;
  if (hasSillLedge) {
    group.add(box(ow + 0.2, 0.08, 0.12, op.frameColor || FRAME_DEFAULT, cx, oy - 0.04, zBase + 0.06));
  }

  // surround: profiled frame around the opening, protruding forward.
  const sur = op.surround;
  let surW = 0;
  if (sur && typeof sur.width === 'number' && sur.width > 0) {
    surW = sur.width;
    const sDepth = typeof sur.depth === 'number' ? sur.depth : 0.08;
    const growBottom = !hasSillLedge;
    const ox2 = ox - surW, ow2 = ow + 2 * surW;
    const oy2 = growBottom ? oy - surW : oy;
    const oh2 = (oy + oh + surW) - oy2;
    const ss = rectShape(ox2, oy2, ow2, oh2);
    ss.holes.push(rectPath(ox, oy, ow, oh + ah));
    group.add(new THREE.Mesh(extrude(ss, sDepth, zBase), mat(sur.color || DECOR_DEFAULT)));
  }

  // pediment: sits on top of the surround / opening.
  const ped = op.pediment;
  if (ped && ped.type) {
    const pDepth = typeof ped.depth === 'number' ? ped.depth : 0.12;
    const color = ped.color || DECOR_DEFAULT;
    const baseW = ow + 2 * surW;
    const topY = oy + oh + ah + surW;
    let shape;
    if (ped.type === 'triangular') {
      const pedH = Math.min(0.6, 0.35 * baseW);
      shape = new THREE.Shape();
      shape.moveTo(cx - baseW / 2, topY);
      shape.lineTo(cx + baseW / 2, topY);
      shape.lineTo(cx, topY + pedH);
      shape.lineTo(cx - baseW / 2, topY);
    } else if (ped.type === 'segmental') {
      const segH = Math.min(0.6, 0.2 * baseW);
      shape = new THREE.Shape();
      shape.moveTo(cx - baseW / 2, topY);
      shape.lineTo(cx + baseW / 2, topY);
      shape.quadraticCurveTo(cx, topY + 2 * segH, cx - baseW / 2, topY);
    } else { // flat lintel
      shape = rectShape(cx - baseW / 2, topY, baseW, 0.2);
    }
    group.add(new THREE.Mesh(extrude(shape, pDepth, zBase), mat(color)));
  }
}

// ---- wall floor strip with holes for its (non-bay) openings ----
// Rustication grooves are facade slits: they run up to windows/doors but never
// across them. rustStyle 'bands' = horizontal only; 'blocks' = ashlar with
// vertical joints alternating per row like brick bond.
function buildFloorStrip(group, width, floorY, height, color, holes, rusticated, rustStyle, floorOps) {
  const shape = rectShape(0, floorY, width, height);
  for (const h of holes) shape.holes.push(h);
  const g = extrude(shape, WALL_THICKNESS);
  g.translate(0, 0, -WALL_THICKNESS); // wall body behind front face (z=0)
  group.add(new THREE.Mesh(g, mat(color)));

  if (!rusticated) return;
  const grooveColor = darken(color, 0.15);
  const GAP = 0.06; // clearance kept around openings
  const ops = floorOps || [];

  // Merged x-intervals blocked by openings overlapping the vertical range [yLo, yHi].
  const blockedAt = (yLo, yHi) => {
    const iv = [];
    for (const op of ops) {
      const archExtra = op.arch === 'round' ? op.w / 2 : op.arch === 'segmental' ? 0.2 * op.w : 0;
      if (op.y - GAP < yHi && op.y + op.h + archExtra + GAP > yLo) iv.push([op.x - GAP, op.x + op.w + GAP]);
    }
    iv.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of iv) {
      if (merged.length && a <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
      } else {
        merged.push([a, b]);
      }
    }
    return merged;
  };

  const ROW_H = 0.55;
  const grooveYs = [];
  for (let gy = floorY + ROW_H; gy < floorY + height - 0.05; gy += ROW_H) grooveYs.push(gy);

  // Horizontal grooves, segmented around openings.
  for (const gy of grooveYs) {
    const blocked = blockedAt(gy - 0.02, gy + 0.02);
    let x = 0;
    const emit = (from, to) => {
      if (to - from > 0.08) group.add(box(to - from, 0.03, 0.02, grooveColor, (from + to) / 2, gy, 0.01));
    };
    for (const [a, b] of blocked) {
      emit(x, Math.min(a, width));
      x = Math.max(x, b);
    }
    emit(x, width);
  }

  // Vertical joints in running-bond pattern (blocks style only).
  if (rustStyle === 'blocks') {
    const BLOCK_W = 1.1;
    const rows = [floorY, ...grooveYs, floorY + height];
    for (let r = 0; r < rows.length - 1; r++) {
      const yLo = rows[r], yHi = rows[r + 1];
      const rh = yHi - yLo;
      if (rh < 0.1) continue;
      const blocked = blockedAt(yLo + 0.02, yHi - 0.02);
      const start = r % 2 ? BLOCK_W / 2 : BLOCK_W;
      for (let jx = start; jx < width - 0.05; jx += BLOCK_W) {
        if (blocked.some(([a, b]) => jx > a && jx < b)) continue;
        group.add(box(0.03, rh - 0.06, 0.02, grooveColor, jx, (yLo + yHi) / 2, 0.01));
      }
    }
  }
}

// ---- bay (erker): own front wall with holes + side walls ----
function buildBay(group, bay, wallColor, openings) {
  const x = bay.x, w = bay.width, y0 = bay.y0, y1 = bay.y1;
  const depth = typeof bay.depth === 'number' ? bay.depth : 0.8;
  const h = y1 - y0;

  // Front wall extruded with the bay's openings as holes.
  const shape = rectShape(x, y0, w, h);
  for (const op of openings) shape.holes.push(openingHole(op.x, op.y, op.w, op.h, op.arch || 'flat'));
  const fg = extrude(shape, WALL_THICKNESS);
  fg.translate(0, 0, depth - WALL_THICKNESS); // front face at z=depth
  group.add(new THREE.Mesh(fg, mat(wallColor)));

  // Solid thin side walls connecting wall face to bay front.
  group.add(box(WALL_THICKNESS, h, depth, wallColor, x + WALL_THICKNESS / 2, y0 + h / 2, depth / 2));
  group.add(box(WALL_THICKNESS, h, depth, wallColor, x + w - WALL_THICKNESS / 2, y0 + h / 2, depth / 2));

  // Openings pushed forward with the bay.
  for (const op of openings) buildOpeningAssembly(group, op, depth);
}

// ---- balcony ----
function buildBalcony(group, b) {
  const x = b.x, w = b.width, y = b.y;
  const depth = typeof b.depth === 'number' ? b.depth : 1.0;
  const parapet = b.parapet || 'solid';
  const color = b.color || (parapet === 'iron' ? '#3f3f3f' : '#cfcabb');
  const cx = x + w / 2;

  // Slab.
  group.add(box(w, 0.22, depth, color, cx, y - 0.11, depth / 2));

  const railColor = color;
  const zFront = depth;               // outer edge
  const zBackRailShift = 0.04;
  if (parapet === 'solid') {
    const ph = 1.0, t = 0.08, cyw = y + ph / 2;
    group.add(box(w, ph, t, color, cx, cyw, zFront - t / 2));                 // front
    group.add(box(t, ph, depth, color, x + t / 2, cyw, depth / 2));           // left
    group.add(box(t, ph, depth, color, x + w - t / 2, cyw, depth / 2));       // right
  } else {
    const isIron = parapet === 'iron';
    const ph = 0.9;
    const bar = isIron ? 0.025 : 0.06;
    const spacing = isIron ? 0.15 : 0.25;
    const limit = isIron ? 24 : 20;
    const railT = isIron ? 0.04 : 0.06;
    // top + bottom rails on three sides
    for (const railY of [y + ph, y + 0.12]) {
      group.add(box(w, railT, railT, color, cx, railY, zFront - railT / 2));
      group.add(box(railT, railT, depth, color, x + railT / 2, railY, depth / 2));
      group.add(box(railT, railT, depth, color, x + w - railT / 2, railY, depth / 2));
    }
    // vertical bars along the front
    const n = Math.min(limit, Math.max(2, Math.floor(w / spacing)));
    for (let i = 0; i <= n; i++) {
      const bx = x + (w * i) / n;
      group.add(box(bar, ph, bar, color, bx, y + ph / 2, zFront - bar / 2));
    }
  }
}

export function buildFacade(spec) {
  const group = new THREE.Group();
  if (!spec || typeof spec !== 'object') {
    warn('spec is not an object; returning empty group');
    return group;
  }

  const width = typeof spec.width === 'number' ? spec.width : 12;
  const wallColor = spec.wallColor || '#c9b98d';
  const floors = Array.isArray(spec.floors) ? spec.floors : [];

  // Cumulative floor Y positions (bottom of each floor).
  const floorY = [];
  let acc = 0;
  for (const f of floors) {
    floorY.push(acc);
    acc += (f && typeof f.height === 'number') ? f.height : 3.6;
  }
  const totalHeight = acc;

  // Normalize openings and resolve absolute bottom y.
  const openings = [];
  if (Array.isArray(spec.openings)) {
    spec.openings.forEach((op, i) => {
      if (!op || typeof op !== 'object') { warn(`opening[${i}] not an object; skipped`); return; }
      const fi = op.floor;
      if (typeof fi !== 'number' || fi < 0 || fi >= floors.length) { warn(`opening[${i}] has invalid floor ${fi}; skipped`); return; }
      if (typeof op.x !== 'number' || typeof op.w !== 'number' || typeof op.h !== 'number') { warn(`opening[${i}] missing x/w/h; skipped`); return; }
      const type = op.type || 'window';
      const defaultSill = type === 'window' ? 0.85 : 0;
      const sill = typeof op.sill === 'number' ? op.sill : defaultSill;
      openings.push(Object.assign({}, op, { type, y: floorY[fi] + sill }));
    });
  }

  // Assign openings to bays (center x within bay x-range AND vertical center within [y0,y1]).
  const bays = Array.isArray(spec.bays) ? spec.bays : [];
  const bayOf = new Map();
  for (const op of openings) {
    const cx = op.x + op.w / 2;
    const midY = op.y + op.h / 2;
    for (const bay of bays) {
      if (!bay || typeof bay.x !== 'number' || typeof bay.width !== 'number') continue;
      if (cx >= bay.x && cx <= bay.x + bay.width && midY >= bay.y0 && midY <= bay.y1) {
        bayOf.set(op, bay);
        break;
      }
    }
  }

  // Wall floor strips (openings not belonging to a bay become holes).
  floors.forEach((f, fi) => {
    if (!f || typeof f !== 'object') { warn(`floor[${fi}] not an object; skipped`); return; }
    const height = typeof f.height === 'number' ? f.height : 3.6;
    const color = f.wallColor || wallColor;
    const floorOps = openings.filter((op) => op.floor === fi && !bayOf.has(op));
    const holes = floorOps.map((op) => openingHole(op.x, op.y, op.w, op.h, op.arch || 'flat'));
    buildFloorStrip(group, width, floorY[fi], height, color, holes, !!f.rusticated, f.rustication || 'bands', floorOps);
  });

  // Non-bay opening assemblies at the wall face.
  for (const op of openings) {
    if (!bayOf.has(op)) buildOpeningAssembly(group, op, 0);
  }

  // Bays.
  for (const bay of bays) {
    if (!bay || typeof bay.x !== 'number' || typeof bay.width !== 'number') { warn('malformed bay; skipped'); continue; }
    const ops = openings.filter((op) => bayOf.get(op) === bay);
    buildBay(group, bay, wallColor, ops);
  }

  // Bands (full-width or x0..x1 boxes).
  if (Array.isArray(spec.bands)) {
    spec.bands.forEach((bd, i) => {
      if (!bd || typeof bd.y !== 'number') { warn(`band[${i}] malformed; skipped`); return; }
      const x0 = typeof bd.x0 === 'number' ? bd.x0 : 0;
      const x1 = typeof bd.x1 === 'number' ? bd.x1 : width;
      const h = typeof bd.height === 'number' ? bd.height : 0.3;
      const d = typeof bd.depth === 'number' ? bd.depth : 0.12;
      group.add(box(x1 - x0, h, d, bd.color || DECOR_DEFAULT, (x0 + x1) / 2, bd.y, d / 2));
    });
  }

  // Pilasters (vertical strips).
  if (Array.isArray(spec.pilasters)) {
    spec.pilasters.forEach((pl, i) => {
      if (!pl || typeof pl.x !== 'number' || typeof pl.y0 !== 'number' || typeof pl.y1 !== 'number') { warn(`pilaster[${i}] malformed; skipped`); return; }
      const w = typeof pl.width === 'number' ? pl.width : 0.4;
      const d = typeof pl.depth === 'number' ? pl.depth : 0.08;
      const h = pl.y1 - pl.y0;
      group.add(box(w, h, d, pl.color || wallColor, pl.x + w / 2, pl.y0 + h / 2, d / 2));
    });
  }

  // Balconies.
  if (Array.isArray(spec.balconies)) {
    spec.balconies.forEach((b, i) => {
      if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.width !== 'number') { warn(`balcony[${i}] malformed; skipped`); return; }
      buildBalcony(group, b);
    });
  }

  // Ornaments (protruding block per entry; x,y = center).
  if (Array.isArray(spec.ornaments)) {
    spec.ornaments.forEach((o, i) => {
      if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') { warn(`ornament[${i}] malformed; skipped`); return; }
      const w = typeof o.w === 'number' ? o.w : 0.4;
      const h = typeof o.h === 'number' ? o.h : 0.4;
      const d = typeof o.depth === 'number' ? o.depth : 0.12;
      group.add(box(w, h, d, o.color || DECOR_DEFAULT, o.x, o.y, d / 2));
    });
  }

  // Eaves on top of the last floor.
  if (spec.eaves && typeof spec.eaves === 'object') {
    const e = spec.eaves;
    const h = typeof e.height === 'number' ? e.height : 0.5;
    const d = typeof e.depth === 'number' ? e.depth : 0.45;
    group.add(box(width, h, d, e.color || DECOR_DEFAULT, width / 2, totalHeight + h / 2, d / 2));
  }

  return group;
}
