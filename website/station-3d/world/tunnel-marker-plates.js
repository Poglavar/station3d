// Renders tunnel-wall distance markers as text plates: one canvas atlas of
// "◀ 345" plates (chevron + number), merged quads, one mesh per atlas chunk so
// a whole network costs a couple of draw calls. Shared by the planner tube
// (planner-elevation.js) and the engineered bored tunnels (rails.js) — each
// supplies world-placed markers and gets back ready meshes.
//
// Orientation contract: `dirX/dirZ` is the plate's TEXT direction (the reading
// direction on the wall as seen by the driver the plate is meant for); the
// quad's U×V normal then faces the track centre on both walls. The chevron is
// drawn at the −U end, so it physically points the way the COUNTDOWN runs
// (toward the portal that plate's number measures to) while the digits read
// correctly — right wall: text runs −chainage, chevron points +chainage;
// left wall: text runs +chainage, chevron points −chainage.
import * as THREE from 'three';
import { PLATE_CELL, plateContentLayout } from '../core/tunnel-marker-plate-layout.js';

// Big enough to READ from a moving cab, which is the whole point: at 0.55 m the
// digits were a smudge by the time they were beside you. The bore is a swept box
// with flat walls at least 5 m off centre and a 6.2 m ceiling, so a 4.8 × 3.0 m
// marking sits comfortably on the wall — its top edge reaches 3.4 m above the
// tunnel floor, well clear of the crown.
const PLATE_W_M = 4.8;            // along the wall
const PLATE_H_M = 3.0;
// The cell aspect (512×320 = 1.6) matches PLATE_W_M / PLATE_H_M, so the paint is
// never stretched on the wall. Resolution tracks the physical size: at the old
// 256×160 a plate three times as large would have been three times as soft.
// Cell size, UV inset and the content margin live in the layout module — the
// invariant that no paint escapes the cell is checked against them headlessly.
const { widthPx: CELL_W_PX, heightPx: CELL_H_PX, insetPx: CELL_INSET_PX, fontPx: DIGIT_FONT_PX } = PLATE_CELL;
const ATLAS_COLS = 4;
const MAX_PLATES_PER_MESH = 32;   // ≤ 2048×2560 px atlas, safe on mobile GPUs
const OUTLINE_PX = 10;

// One marking per unique text, PAINTED on the wall: no plaque, no border, no
// dark backing — just chevron and digits in white, on transparent pixels, so the
// tunnel's own surface shows through exactly as painted signage does. The dark
// rounded sign it replaced read as a plastic plate stuck to the concrete.
//
// The thin dark outline is not decoration: a bore wall can be pale concrete or
// near-black stone depending on the world, and white-on-white would vanish.
function drawPlate(ctx, x0, y0, text) {
    ctx.save();
    ctx.translate(x0, y0);
    ctx.font = `700 ${DIGIT_FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const layout = plateContentLayout(
        text,
        (digits) => ctx.measureText(digits).width,
        OUTLINE_PX,
    );
    const { arrow } = layout;
    ctx.translate(CELL_W_PX / 2, CELL_H_PX / 2);
    ctx.scale(layout.scale, layout.scale);
    ctx.translate(-layout.total / 2, 0);

    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(12,16,22,0.55)';
    ctx.lineWidth = OUTLINE_PX;
    ctx.fillStyle = '#f2f5f8';

    // An arrow with a shaft, not a bare wedge: a lone triangle beside a number
    // is ambiguous at speed. One path for the whole silhouette — stroking head
    // and shaft separately would draw the outline through the join between them.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(arrow.headW, -arrow.headH / 2);
    ctx.lineTo(arrow.headW, -arrow.shaftH / 2);
    ctx.lineTo(arrow.totalW, -arrow.shaftH / 2);
    ctx.lineTo(arrow.totalW, arrow.shaftH / 2);
    ctx.lineTo(arrow.headW, arrow.shaftH / 2);
    ctx.lineTo(arrow.headW, arrow.headH / 2);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();

    const baselineNudge = DIGIT_FONT_PX * 0.04;
    ctx.strokeText(layout.digits, layout.textX, baselineNudge);
    ctx.fillText(layout.digits, layout.textX, baselineNudge);
    ctx.restore();
}

function buildAtlas(texts) {
    const rows = Math.ceil(texts.length / ATLAS_COLS);
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_COLS * CELL_W_PX;
    canvas.height = Math.max(1, rows) * CELL_H_PX;
    const ctx = canvas.getContext('2d');
    const uvByText = new Map();
    texts.forEach((text, i) => {
        const col = i % ATLAS_COLS;
        const row = Math.floor(i / ATLAS_COLS);
        drawPlate(ctx, col * CELL_W_PX, row * CELL_H_PX, text);
        uvByText.set(String(text), {
            u0: (col * CELL_W_PX + CELL_INSET_PX) / canvas.width,
            u1: ((col + 1) * CELL_W_PX - CELL_INSET_PX) / canvas.width,
            v0: (row * CELL_H_PX + CELL_INSET_PX) / canvas.height,
            v1: ((row + 1) * CELL_H_PX - CELL_INSET_PX) / canvas.height,
        });
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;                    // UVs below address canvas rows directly
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { texture, uvByText };
}

// markers: [{ x, y, z, dirX, dirZ, text }] — (x,y,z) the plate CENTRE in world
// space, (dirX,dirZ) the horizontal TEXT direction (need not be unit): the
// direction the digits read in, on the wall of the driver the plate serves.
// Returns an array of meshes (one per atlas chunk); [] when nothing to draw.
export function buildTunnelMarkerPlates(markers) {
    if (!Array.isArray(markers) || markers.length === 0) return [];
    const meshes = [];
    for (let start = 0; start < markers.length; start += MAX_PLATES_PER_MESH) {
        const chunk = markers.slice(start, start + MAX_PLATES_PER_MESH);
        const texts = [...new Set(chunk.map((m) => String(m.text)))];
        const { texture, uvByText } = buildAtlas(texts);
        const positions = [];
        const uvs = [];
        const indices = [];
        for (const m of chunk) {
            const uv = uvByText.get(String(m.text));
            if (!uv) continue;
            const len = Math.hypot(m.dirX, m.dirZ);
            if (!(len > 1e-6)) continue;
            const ux = m.dirX / len;
            const uz = m.dirZ / len;
            const hw = PLATE_W_M / 2;
            const hh = PLATE_H_M / 2;
            // Plate basis: U along the text direction, V straight up. The quad
            // normal U×V faces the track centre on both walls (right wall text
            // runs −chainage, left wall text runs +chainage).
            const corners = [
                [m.x - ux * hw, m.y - hh, m.z - uz * hw, uv.u0, uv.v1],   // bottom-left
                [m.x + ux * hw, m.y - hh, m.z + uz * hw, uv.u1, uv.v1],   // bottom-right
                [m.x - ux * hw, m.y + hh, m.z - uz * hw, uv.u0, uv.v0],   // top-left
                [m.x + ux * hw, m.y + hh, m.z + uz * hw, uv.u1, uv.v0],   // top-right
            ];
            const base = positions.length / 3;
            for (const [px, py, pz, u, v] of corners) {
                positions.push(px, py, pz);
                uvs.push(u, v);
            }
            indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
        }
        if (indices.length === 0) { texture.dispose(); continue; }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            // Paint, not a plate: everything outside the glyphs is transparent so
            // the wall shows through. alphaTest rather than blending keeps the
            // edges crisp and avoids depth-sorting artefacts against the tube.
            transparent: true,
            alphaTest: 0.35,
            // Reflective paint in an unlit tube: tone mapping must not dim it.
            toneMapped: false,
            // Paint is coplanar with the wall, so the offset is what keeps it
            // from z-fighting the swept face at grazing angles.
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'TunnelDistanceMarkers';
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        meshes.push(mesh);
    }
    return meshes;
}

