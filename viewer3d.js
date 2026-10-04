// Vue 3D réaliste d'une montre : boîtier, lunette, verre, cadran, aiguilles et bracelet modélisés en volume.
// Les unités sont celles des illustrations SVG (boîtier rond = rayon 29). Le cadran et le fond de boîte
// sont peints à partir des mêmes dessins que les cartes, puis posés sur les volumes.
import * as THREE from "./vendor/three.module.min.js";
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";

const TEX_HALF = 32;
const METALS = {
  "acier":   { color: "#D2D6DA", rough: .16, brushed: .34 },
  "titane":  { color: "#B4B1AA", rough: .3,  brushed: .42 },
  "doré":    { color: "#E8BE62", rough: .14, brushed: .3 },
  "or-rose": { color: "#E7AC8E", rough: .14, brushed: .3 },
  "bronze":  { color: "#B9844D", rough: .36, brushed: .48 },
  "noir":    { color: "#2B2E33", rough: .22, brushed: .34, metal: .55 },
  "resine":  { color: "#24272C", rough: .55, brushed: .6, metal: 0 }
};
const GEO = {
  rond:    { R: 29, lugs: true,  crownX: 29.4 },
  coussin: { R: 29, lugs: false, crownX: 29.4 },
  octo:    { R: 31, lugs: false, crownX: 28.8 },
  carre:   { R: 27, lugs: false, crownX: 27.4 },
  rect:    { R: 31, lugs: false, crownX: 22.4 },
  tonneau: { R: 34, lugs: false, crownX: 21.4 }
};
// Dimension réelle (mm) que représente le boîtier dessiné : diamètre, largeur (carré) ou hauteur (rectangle, tonneau)
const REF_MM = { rond: 41, coussin: 41, octo: 40.5, carre: 38.2, rect: 43.8, tonneau: 48 };
function realScale(w){ const n = parseFloat(String(w.size || "").replace(",", ".")); const ref = REF_MM[w.shape || "rond"] || 41; return n > 0 ? Math.max(.55, Math.min(1.4, n / ref)) : 1; }

let renderer = null, pmrem = null, envTex = null;

// Studio photo : fond sombre et grandes boîtes à lumière, pour des reflets francs sur le métal.
function studio(){
  const sc = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
  const pos = room.geometry.attributes.position, col = [];
  for (let i = 0; i < pos.count; i++){ const y = pos.getY(i) / 100, v = .035 + .1 * Math.max(0, y) + .02 * (1 - Math.abs(y)); col.push(v, v * 1.02, v * 1.08); }
  room.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  sc.add(room);
  const box = (w, h, x, y, z, int, color = "#ffffff") => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(int), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); sc.add(m); };
  box(120, 40, 0, 85, 30, 3.2);           // plafond
  box(30, 110, -85, 10, 40, 2.4);         // gauche
  box(24, 110, 85, 0, 30, 1.5, "#dfe8ff"); // droite, plus froide
  box(80, 14, 0, -20, 90, 1.1);           // bande frontale basse
  box(50, 50, 30, 40, -85, 1.2);          // contre-jour
  box(16, 16, -30, 50, 80, 6);            // point brillant
  return sc;
}

// ---------- utilitaires ----------
function canvasTex(w, h, draw, srgb = true){
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function svgTexture(svg, bg, px = 2048){
  return new Promise(resolve => {
    if (!svg) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const t = canvasTex(px, px, (g, w, h) => { if (bg){ g.fillStyle = bg; g.fillRect(0, 0, w, h); } g.drawImage(img, 0, 0, w, h); });
        resolve(t);
      } catch(e){ resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
// Coordonnées UV « vues de dessus » : la texture couvre le carré ±TEX_HALF.
function planarUV(geo){
  const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++){
    const x = p.getX(i), y = p.getY(i);
    uv[i*2] = (x + TEX_HALF) / (2 * TEX_HALF); uv[i*2+1] = (y + TEX_HALF) / (2 * TEX_HALF);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}
function noiseTex(size, amp, base, stretch){
  return canvasTex(size, size, (g, w, h) => {
    const im = g.createImageData(w, h);
    for (let y = 0; y < h; y++){
      let run = Math.random();
      for (let x = 0; x < w; x++){
        run = stretch ? run * .92 + Math.random() * .08 : Math.random();
        const v = base + (run - .5) * amp, i = (y * w + x) * 4;
        im.data[i] = im.data[i+1] = im.data[i+2] = v; im.data[i+3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, false);
}

// Géométrie construite à la main : on y verse plusieurs balayages pour n'avoir qu'un maillage par matière.
class Builder {
  constructor(){ this.pos = []; this.uv = []; this.idx = []; }
  vert(p, u, v){ this.pos.push(p.x, p.y, p.z); this.uv.push(u, v); return this.pos.length / 3 - 1; }
  geometry(){
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx); g.computeVertexNormals();
    return g;
  }
}
// Section arrondie (largeur u0..u1, épaisseur 0..th) parcourue en sens direct.
function roundedSection(u0, u1, th, r, n = 4){
  r = Math.min(r, (u1 - u0) / 2 - .01, th / 2 - .01);
  const pts = [], arc = (cx, cy, a0) => { for (let i = 0; i <= n; i++){ const a = a0 + i * Math.PI / 2 / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(u1 - r, r, -Math.PI / 2); arc(u1 - r, th - r, 0); arc(u0 + r, th - r, Math.PI / 2); arc(u0 + r, r, Math.PI);
  return pts;
}
// Balayage d'une section le long d'une courbe de bracelet (repère : X = largeur, n = normale extérieure).
function sweep(b, frameAt, s0, s1, steps, section, lift = 0){
  const ring = [], X = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i <= steps; i++){
    const s = s0 + (s1 - s0) * i / steps, { p, t } = frameAt(s);
    const n = new THREE.Vector3().crossVectors(X, t).normalize();
    const sec = section(s), row = [], u0 = Math.min(...sec.map(q => q[0])), u1 = Math.max(...sec.map(q => q[0]));
    sec.forEach(([u, v]) => row.push(b.vert(new THREE.Vector3().copy(p).addScaledVector(X, u).addScaledVector(n, v + lift), (u - u0) / (u1 - u0 || 1), s / 10)));
    ring.push(row);
  }
  const m = ring[0].length;
  for (let i = 0; i < steps; i++) for (let j = 0; j < m; j++){
    const a = ring[i][j], c = ring[i][(j + 1) % m], d = ring[i+1][j], e = ring[i+1][(j + 1) % m];
    b.idx.push(a, d, c, c, d, e);
  }
  // bouchons
  [[0, 1], [steps, -1]].forEach(([i, dir]) => {
    const row = ring[i], c = new THREE.Vector3();
    row.forEach(k => c.add(new THREE.Vector3(b.pos[k*3], b.pos[k*3+1], b.pos[k*3+2])));
    c.divideScalar(m);
    const ci = b.vert(c, .5, .5), copies = row.map(k => b.vert(new THREE.Vector3(b.pos[k*3], b.pos[k*3+1], b.pos[k*3+2]), 0, 0));
    for (let j = 0; j < m; j++) dir > 0 ? b.idx.push(ci, copies[(j + 1) % m], copies[j]) : b.idx.push(ci, copies[j], copies[(j + 1) % m]);
  });
}

// ---------- contours des boîtiers ----------
function outline(shape, inset = 0){
  const s = new THREE.Shape();
  const rr = (w, h, r) => { w -= inset*2; h -= inset*2; r = Math.max(.5, r - inset); const x = -w/2, y = -h/2; s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); };
  if (shape === "coussin") rr(58, 58, 17);
  else if (shape === "carre") rr(54, 54, 7);
  else if (shape === "rect") rr(44, 62, 6);
  else if (shape === "octo"){ const R = 31 - inset; for (let i = 0; i < 8; i++){ const a = Math.PI/8 + i*Math.PI/4; i ? s.lineTo(R*Math.cos(a), R*Math.sin(a)) : s.moveTo(R*Math.cos(a), R*Math.sin(a)); } s.closePath(); }
  else if (shape === "tonneau"){ const k = 1 - inset / 34; s.moveTo(-16*k, 32*k); s.quadraticCurveTo(0, 36*k, 16*k, 32*k); s.quadraticCurveTo(26*k, 0, 16*k, -32*k); s.quadraticCurveTo(0, -36*k, -16*k, -32*k); s.quadraticCurveTo(-26*k, 0, -16*k, 32*k); }
  else s.absarc(0, 0, 29 - inset, 0, Math.PI*2, false);
  return s;
}
function dialPath(d, grow = 0){
  const p = new THREE.Path();
  if (d.kind === "c") p.absarc(0, 0, d.rx + grow, 0, Math.PI*2, true);
  else { const w = d.rx + grow, h = d.ry + grow, r = d.r + grow; p.moveTo(-w + r, -h); p.quadraticCurveTo(-w, -h, -w, -h + r); p.lineTo(-w, h - r); p.quadraticCurveTo(-w, h, -w + r, h); p.lineTo(w - r, h); p.quadraticCurveTo(w, h, w, h - r); p.lineTo(w, -h + r); p.quadraticCurveTo(w, -h, w - r, -h); p.closePath(); }
  return p;
}

// ---------- aiguilles ----------
function handMesh(style, L, wd, isMinute, mats, lumeOn, blued){
  const g = new THREE.Group(), metal = blued ? mats.blued : mats.hand;
  const ext = (shape, depth, mat, z = 0, bevel = .12) => { const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 16 }); const m = new THREE.Mesh(geo, mat); m.position.z = z; g.add(m); return m; };
  const poly = pts => { const s = new THREE.Shape(); pts.forEach(([x, y], i) => i ? s.lineTo(x, y) : s.moveTo(x, y)); s.closePath(); return s; };
  if (style === "dauphine"){
    // facettes : arête centrale relevée
    const geo = new THREE.BufferGeometry(), h = .55, e = L * .12;
    const v = [0, L, h,  wd, e, 0,  0, -2.2, h,   0, L, h,  0, -2.2, h,  -wd, e, 0];
    geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, metal));
    const base = new THREE.Mesh(new THREE.ShapeGeometry(poly([[0, L], [wd, e], [0, -2.2], [-wd, e]])), metal); base.rotation.x = Math.PI; g.add(base);
  } else if (style === "feuille"){
    const s = new THREE.Shape(); s.moveTo(0, L); s.quadraticCurveTo(wd * 1.5, L * .45, 0, -2); s.quadraticCurveTo(-wd * 1.5, L * .45, 0, L);
    ext(s, .18, metal, 0, .18);
  } else if (style === "glaive"){
    ext(poly([[0, L], [wd, L*.78], [wd*.6, -2.5], [-wd*.6, -2.5], [-wd, L*.78]]), .2, metal);
    if (lumeOn) ext(poly([[0, L - 1.4], [wd*.55, L*.76], [wd*.3, L*.22], [-wd*.3, L*.22], [-wd*.55, L*.76]]), .12, mats.lume, .32, .04);
  } else if (style === "mercedes" && !isMinute){
    const c = L * .7, r = wd * 1.55;
    ext(poly([[-wd*.55, c], [wd*.55, c], [wd*.55, -2.5], [-wd*.55, -2.5]]), .2, metal);
    const ring = new THREE.Shape(); ring.absarc(0, c + r*.6, r, 0, Math.PI*2, false); const hole = new THREE.Path(); hole.absarc(0, c + r*.6, r*.72, 0, Math.PI*2, true); ring.holes.push(hole); ext(ring, .2, metal);
    ext(poly([[0, L], [wd*.9, c + r*1.3], [-wd*.9, c + r*1.3]]), .2, metal);
    const lc = new THREE.Shape(); lc.absarc(0, c + r*.6, r*.72, 0, Math.PI*2, false); ext(lc, .1, mats.lume, .05, .03);
    for (const a of [0, 2.2, -2.2]){ const bar = new THREE.Mesh(new THREE.BoxGeometry(.32, r*.72, .3), metal); bar.position.set(Math.sin(a) * r*.36, c + r*.6 + Math.cos(a) * r*.36, .3); bar.rotation.z = -a; g.add(bar); }
    ext(poly([[-wd*.3, c - .6], [wd*.3, c - .6], [wd*.3, c - .6 - c*.62], [-wd*.3, c - .6 - c*.62]]), .1, mats.lume, .32, .03);
  } else if (style === "mercedes"){
    ext(poly([[0, L], [wd*.75, L*.9], [wd*.6, -2.5], [-wd*.6, -2.5], [-wd*.75, L*.9]]), .2, metal);
    ext(poly([[-wd*.32, L*.86], [wd*.32, L*.86], [wd*.32, L*.24], [-wd*.32, L*.24]]), .1, mats.lume, .32, .03);
  } else {
    const s = new THREE.Shape(); const r = wd * .3; s.moveTo(-wd/2, -3 + r); s.lineTo(-wd/2, L - r); s.quadraticCurveTo(-wd/2, L, -wd/2 + r, L); s.lineTo(wd/2 - r, L); s.quadraticCurveTo(wd/2, L, wd/2, L - r); s.lineTo(wd/2, -3 + r); s.quadraticCurveTo(wd/2, -3, wd/2 - r, -3); s.lineTo(-wd/2 + r, -3); s.quadraticCurveTo(-wd/2, -3, -wd/2, -3 + r);
    ext(s, .2, metal);
    if (lumeOn) ext(poly([[-wd*.25, L - 1], [wd*.25, L - 1], [wd*.25, L*.3 - 1], [-wd*.25, L*.3 - 1]]), .1, mats.lume, .32, .03);
  }
  // canon
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(isMinute ? 1.25 : 1.6, isMinute ? 1.25 : 1.6, .5, 32), metal); hub.rotation.x = Math.PI/2; hub.position.z = .1; g.add(hub);
  return g;
}

// ---------- construction de la montre ----------
async function buildWatch(w, art, texPx = 2048){
  const meta = art.meta, d = meta.d, S = meta.S;
  const shape = w.shape || "rond", G = GEO[shape] || GEO.rond;
  const has = c => (meta.comps || []).includes(c);
  const mt = METALS[w.case] || METALS.acier;
  const quartz = w.movementType === "quartz" || w.movementType === "solaire";
  let T = 2 * G.R * (quartz ? .2 : .26) + (w.bezel === "plongee" ? 2 : 0); if (w.display && w.display !== "analogique") T = 2 * G.R * .3;
  const root = new THREE.Group();

  const metal = (rough, color = mt.color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, metalness: mt.metal ?? 1, roughness: rough, envMapIntensity: 1.25, side: THREE.DoubleSide, ...extra });
  const polished = metal(mt.rough, mt.color, { clearcoat: mt.metal === 0 ? .6 : 0 });
  const brushedMap = noiseTex(256, 70, 150, true);
  const brushed = metal(mt.brushed, mt.color, { roughnessMap: brushedMap });
  const handMetal = meta.light ? new THREE.MeshPhysicalMaterial({ color: "#2A3038", metalness: 1, roughness: .2, side: THREE.DoubleSide }) : (w.case === "doré" || w.case === "or-rose" ? metal(.12) : new THREE.MeshPhysicalMaterial({ color: "#E4E7EA", metalness: 1, roughness: .1, side: THREE.DoubleSide }));
  const mats = {
    hand: handMetal,
    blued: new THREE.MeshPhysicalMaterial({ color: "#2747A0", metalness: 1, roughness: .18, clearcoat: .5, side: THREE.DoubleSide }),
    lume: new THREE.MeshStandardMaterial({ color: "#EFEBD2", roughness: .7, emissive: "#3A4A2A", emissiveIntensity: .25 }),
    red: new THREE.MeshPhysicalMaterial({ color: "#C0392B", metalness: .3, roughness: .35, clearcoat: .6 }),
    gold: new THREE.MeshPhysicalMaterial({ color: "#D9A94A", metalness: 1, roughness: .2 })
  };

  // ---- textures peintes (cadran, fond)
  const [topTex, backTex] = await Promise.all([svgTexture(art.top, meta.dial, texPx), svgTexture(art.back, "#B9BFC5", texPx)]);

  // ---- hauteurs
  const zDial = T * .74, zBezel = T * .86, caseTop = T * .55;

  // ---- carrure
  const strapW = shape === "carre" ? 30 : shape === "rond" ? 27 : 28;
  if (shape === "rond"){
    // carrure et cornes d'un seul bloc : contour vu de dessus, extrudé avec des arêtes adoucies
    const Rc = 28.6, xi = strapW / 2 + .15, xo = xi + 4.4, yt = 35.8;
    const yo = Math.sqrt(Rc*Rc - xo*xo), yi = Math.sqrt(Rc*Rc - xi*xi);
    const sh = new THREE.Shape();
    const lugQ = (sx, sy) => { // une corne : du cercle vers la pointe, puis retour
      sh.lineTo(sx * xo, sy * (yo + 1.5));
      sh.quadraticCurveTo(sx * (xo + .3), sy * (yt - 3), sx * (xo - .2), sy * (yt - .6));
      sh.quadraticCurveTo(sx * (xo - .6), sy * yt, sx * (xo - 1.6), sy * yt);
      sh.lineTo(sx * (xi + 1), sy * yt);
      sh.quadraticCurveTo(sx * xi, sy * yt, sx * xi, sy * (yt - 1));
      sh.lineTo(sx * xi, sy * (yi + .4));
    };
    const lugR = (sx, sy) => { // même corne parcourue dans l'autre sens (intérieur vers extérieur)
      sh.lineTo(sx * xi, sy * (yt - 1));
      sh.quadraticCurveTo(sx * xi, sy * yt, sx * (xi + 1), sy * yt);
      sh.lineTo(sx * (xo - 1.6), sy * yt);
      sh.quadraticCurveTo(sx * (xo - .6), sy * yt, sx * (xo - .2), sy * (yt - .6));
      sh.quadraticCurveTo(sx * (xo + .3), sy * (yt - 3), sx * xo, sy * (yo + 1.5));
    };
    const ang = (x, y) => Math.atan2(y, x);
    sh.moveTo(xi, yi + .4);
    sh.absarc(0, 0, Rc, ang(xi, yi), ang(-xi, yi), false);          // haut (entre les cornes)
    sh.lineTo(-xi, yi + .4); lugR(-1, 1);                           // corne haut gauche
    sh.absarc(0, 0, Rc, ang(-xo, yo), ang(-xo, -yo), false);        // flanc gauche
    lugQ(-1, -1);
    sh.absarc(0, 0, Rc, ang(-xi, -yi), ang(xi, -yi), false);        // bas
    sh.lineTo(xi, -(yi + .4)); lugR(1, -1);
    sh.absarc(0, 0, Rc, ang(xo, -yo), ang(xo, yo), false);          // flanc droit
    lugQ(1, 1);
    const Tc = T * .66;
    const geo = new THREE.ExtrudeGeometry(sh, { depth: Tc - 2.2, bevelEnabled: true, bevelThickness: 1.1, bevelSize: .9, bevelSegments: 5, curveSegments: 72 });
    // les cornes plongent vers le poignet
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++){
      const y = Math.abs(pos.getY(i)), z = pos.getZ(i), x = Math.abs(pos.getX(i));
      if (y > 24 && x < xo + 2){ const t = Math.min(1, (y - 24) / (yt - 24)); const drop = t * t * (Tc * .42); const k = z / (Tc - .2); pos.setZ(i, z - drop * Math.max(.25, k)); }
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, [brushed, polished]); m.position.z = 1.1; root.add(m);
  } else {
    const geo = new THREE.ExtrudeGeometry(outline(shape, 1.4), { depth: caseTop - 3.2, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.4, bevelSegments: 6, curveSegments: 64 });
    const m = new THREE.Mesh(geo, brushed); m.position.z = 1.6; root.add(m);
  }

  // ---- lunette
  const R = meta.ringOut, rIn = d.rx;
  if (shape === "rond" || (d.kind === "c" && shape !== "octo")){
    const insert = meta.insertBezel;
    const pts = insert
      ? [[27.6, T*.66], [28.7, T*.69], [28.9, T*.73], [28.95, T*.8], [28.6, zBezel], [R + .2, zBezel + .05], [R, zBezel - .1]]
      : [[27.6, T*.66], [28.4, T*.68], [28.6, T*.73], [28.3, T*.78], [rIn + 3, zBezel + .4], [rIn + 1.3, zBezel + .3], [rIn + 1, zDial + .9]];
    const fluted = w.bezel === "cannelee" && !insert;
    const geo = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), fluted ? 1440 : 360);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++){
      const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z), a = Math.atan2(z, x), h = pos.getY(i);
      if (insert && r > 28.5 && h > T*.71){ const f = 1 - .022 * (Math.cos(a * 120) > .2 ? 1 : 0); pos.setX(i, x * f); pos.setZ(i, z * f); }
      if (fluted && r > rIn + 1.6 && r < 28.5 && h > T*.74){ const f = (a / (Math.PI * 2) * 72 % 1 + 1) % 1, tri = 1 - Math.abs(f - .5) * 2; pos.setY(i, h + .32 * tri); }
    }
    geo.computeVertexNormals();
    const bz = new THREE.Mesh(geo, fluted ? metal(.06, mt.color, { envMapIntensity: 1.9 }) : polished); bz.rotation.x = Math.PI/2; root.add(bz);
    if (insert){
      const ring = planarUV(new THREE.RingGeometry(R - 6.05, R, 256, 1));
      const insMat = new THREE.MeshPhysicalMaterial({ map: topTex, color: topTex ? "#fff" : "#15181D", roughness: w.bezel === "plongee" ? .12 : .25, metalness: .1, clearcoat: 1, clearcoatRoughness: .05 });
      const im = new THREE.Mesh(ring, insMat); im.position.z = zBezel + .02; root.add(im);
      // flanc intérieur de l'insert jusqu'au cadran
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(rIn, rIn, zBezel - zDial, 128, 1, true), new THREE.MeshStandardMaterial({ color: "#16191D", roughness: .5, side: THREE.BackSide })); wall.rotation.x = Math.PI/2; wall.position.z = (zBezel + zDial) / 2; root.add(wall);
    }
  } else {
    // lunette de forme (carrée, rectangulaire, tonneau, octogonale)
    const s = outline(shape, shape === "octo" ? 2.2 : 1.6); s.holes.push(dialPath(d, shape === "octo" ? 1.6 : .7));
    const geo = new THREE.ExtrudeGeometry(s, { depth: Math.max(.4, zBezel - caseTop - 1.4), bevelEnabled: true, bevelThickness: 1.1, bevelSize: 1, bevelSegments: 5, curveSegments: 64 });
    const bz = new THREE.Mesh(geo, polished); bz.position.z = caseTop + .7; root.add(bz);
    if (shape === "octo"){
      for (let i = 0; i < 8; i++){
        const a = Math.PI/8 + i*Math.PI/4, x = 27 * Math.cos(a), y = 27 * Math.sin(a);
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, .5, 6), polished); screw.rotation.x = Math.PI/2; screw.rotation.y = a; screw.position.set(x, y, zBezel + .55); root.add(screw);
      }
    }
  }

  // ---- cadran
  const dialGeo = planarUV(d.kind === "c" ? new THREE.CircleGeometry(d.rx + .2, 160) : new THREE.ShapeGeometry(new THREE.Shape(dialPath(d, .9).getPoints(48)), 24));
  const tex = (w.dialTexture || "lisse");
  const sun = tex === "soleille";
  const dialMat = new THREE.MeshPhysicalMaterial({ map: topTex, color: topTex ? "#fff" : meta.dial, roughness: sun ? .3 : tex === "lisse" ? .45 : .55, metalness: sun ? .5 : .1, clearcoat: .35, clearcoatRoughness: .3 });
  if (sun){
    dialMat.anisotropy = .85;
    dialMat.anisotropyMap = canvasTex(256, 256, (g, W, H) => { const im = g.createImageData(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){ const a = Math.atan2(y - H/2, x - W/2), i = (y * W + x) * 4; im.data[i] = (-Math.sin(a) * .5 + .5) * 255; im.data[i+1] = (Math.cos(a) * .5 + .5) * 255; im.data[i+2] = 255; im.data[i+3] = 255; } g.putImageData(im, 0, 0); }, false);
  }
  const dial = new THREE.Mesh(dialGeo, dialMat); dial.position.z = zDial; root.add(dial);
  // rehaut (anneau incliné entre cadran et verre)
  if (!meta.insertBezel && d.kind === "c"){
    const reh = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(d.rx + .1, zDial), new THREE.Vector2(d.rx + 1, zDial + .9)], 160), new THREE.MeshPhysicalMaterial({ color: meta.dial, roughness: .5, metalness: .1, side: THREE.DoubleSide }));
    reh.rotation.x = Math.PI/2; root.add(reh);
  }

  // ---- index en relief
  const P = (a, r) => [(d.rx / S) * r * Math.sin(a), (d.ry / S) * r * Math.cos(a)];
  const occ = new Set(meta.occ), idx = meta.idx;
  const appl = meta.light ? handMetal : (w.case === "doré" || w.case === "or-rose" ? metal(.12) : new THREE.MeshPhysicalMaterial({ color: "#E8EBEE", metalness: 1, roughness: .08 }));
  const add = (geo, mat, x, y, z, rot = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.z = rot; root.add(m); return m; };
  if (["batons","appliques","points","explorer"].includes(idx)){
    for (let i = 0; i < 12; i++){
      const hp = ({ 0: 12, 3: 3, 6: 6, 9: 9 })[i]; if (hp !== undefined && occ.has(hp)) continue;
      const a = i * Math.PI / 6, big = i % 3 === 0, [cx, cy] = P(a, S * .84);
      if (idx === "batons" || idx === "appliques"){
        const len = S * (idx === "appliques" ? (big ? .22 : .17) : (big ? .2 : .14)), wd = idx === "appliques" ? (big ? 2.1 : 1.6) : (big ? 1.5 : 1);
        const geo = new RoundedBoxGeometry(wd, len, .7, 2, .25);
        if (i === 0 && idx === "appliques"){ add(geo, appl, cx - 1.55, cy, zDial + .35, -a); add(geo, appl, cx + 1.55, cy, zDial + .35, -a); }
        else add(geo, appl, cx, cy, zDial + .35, -a);
      } else if (i === 0){
        const tri = new THREE.Shape(); const tt = S - 2.2; tri.moveTo(-2.6, tt); tri.lineTo(2.6, tt); tri.lineTo(0, tt - 4.4); tri.closePath();
        const sx = (d.rx / S);
        const fr = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: .5, bevelEnabled: true, bevelThickness: .15, bevelSize: .45, bevelSegments: 2 }), appl); fr.scale.x = sx; fr.position.z = zDial + .05; root.add(fr);
        const lm = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: .6, bevelEnabled: false }), mats.lume); lm.scale.x = sx; lm.position.z = zDial + .1; root.add(lm);
      } else if (big && idx === "points"){
        add(new RoundedBoxGeometry(2.3 + .9, S * .2 + .9, .6, 2, .3), appl, cx, cy, zDial + .3, -a);
        add(new RoundedBoxGeometry(2.3, S * .2, .75, 2, .3), mats.lume, cx, cy, zDial + .4, -a);
      } else if (!(idx === "explorer" && big)){ // 3-6-9 de l'Explorer : chiffres peints
        add(new THREE.CylinderGeometry(2, 2, .6, 40).rotateX(Math.PI/2), appl, cx, cy, zDial + .3);
        add(new THREE.CylinderGeometry(1.55, 1.55, .72, 40).rotateX(Math.PI/2), mats.lume, cx, cy, zDial + .38);
      }
    }
  }

  // ---- aiguilles
  const hands = new THREE.Group(); hands.position.z = zDial; root.add(hands);
  const lumeHands = ["points","explorer"].includes(idx);
  const fat = meta.handStyle === "dauphine" || meta.handStyle === "feuille";
  let hourH = null, minH = null, secH = null, gmtH = null;
  if (meta.display !== "numerique"){
    if (!has("regulator")){ hourH = handMesh(meta.handStyle, S * .54, fat ? 1.9 : 1.6, false, mats, lumeHands, meta.blued); hourH.position.z = 1.0; hands.add(hourH); }
    minH = handMesh(meta.handStyle, S * .84, fat ? 1.5 : 1.15, true, mats, lumeHands, meta.blued); minH.position.z = 1.6; hands.add(minH);
    if (has("gmt")){ gmtH = new THREE.Group(); const L = S * .8; const shaft = new THREE.Mesh(new THREE.BoxGeometry(.7, L - 2, .2), mats.red); shaft.position.y = (L - 2) / 2; gmtH.add(shaft); const tri = new THREE.Shape(); tri.moveTo(0, L); tri.lineTo(2, L - 3.4); tri.lineTo(-2, L - 3.4); tri.closePath(); gmtH.add(new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: .2, bevelEnabled: true, bevelThickness: .06, bevelSize: .06 }), mats.red)); gmtH.position.z = .6; hands.add(gmtH); }
    if (!has("smallsec") || meta.chrono){
      secH = new THREE.Group(); const col = meta.chrono || lumeHands ? mats.red : mats.gold;
      const shaft = new THREE.Mesh(new RoundedBoxGeometry(.5, S - 1.5 + 6, .2, 1, .1), col); shaft.position.y = (S - 1.5 - 6) / 2; secH.add(shaft);
      const cw = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, .22, 32).rotateX(Math.PI/2), col); cw.position.y = -4.2; secH.add(cw);
      if (lumeHands){ const lp = new THREE.Mesh(new THREE.TorusGeometry(1.3, .35, 12, 32), col); lp.position.y = S - 6; secH.add(lp); const lm = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, .2, 32).rotateX(Math.PI/2), mats.lume); lm.position.y = S - 6; secH.add(lm); }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, .5, 32).rotateX(Math.PI/2), col); secH.add(hub);
      secH.position.z = 2.2; hands.add(secH);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(.75, 24, 12, 0, Math.PI*2, 0, Math.PI/2).rotateX(Math.PI/2), handMetal); cap.position.z = 2.5; hands.add(cap);
  }

  // ---- verre
  const glassMat = new THREE.MeshPhysicalMaterial({ color: "#ffffff", metalness: 0, roughness: .02, transmission: 1, thickness: .6, ior: w.glass === "saphir" ? 1.77 : 1.5, transparent: true, opacity: 1, specularIntensity: 1, envMapIntensity: 1.4, attenuationColor: w.glass === "saphir" ? "#e8f0ff" : "#ffffff", attenuationDistance: 40, depthWrite: false });
  const cr = meta.insertBezel ? R - 6 : d.kind === "c" ? d.rx + 1.3 : 0;
  if (cr){
    const dome = w.glass === "hesalite" ? 2.4 : w.glass === "hardlex" ? .9 : .5;
    const sr = (cr * cr + dome * dome) / (2 * dome), th = Math.asin(cr / sr);
    const geo = new THREE.SphereGeometry(sr, 96, 24, 0, Math.PI*2, 0, th).rotateX(Math.PI/2);
    const rim = zBezel + .3;
    const gl = new THREE.Mesh(geo, glassMat); gl.position.z = rim - (sr - dome); gl.renderOrder = 2; root.add(gl);
    const sheen = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 1, roughness: .04, transparent: true, opacity: .1, depthWrite: false, envMapIntensity: 2 }));
    sheen.position.copy(gl.position); sheen.renderOrder = 3; root.add(sheen);
    // loupe de date (cyclope) des Rolex
    if (/rolex/i.test(w.brand || "") && (has("date") || has("daydate")) && occ.has(3)){
      const cy = new THREE.Mesh(new RoundedBoxGeometry(S * .36, S * .3, 1.6, 4, .7), glassMat);
      cy.position.set(d.rx * .66, 0, rim + dome + .2); cy.renderOrder = 4; root.add(cy);
    }
  } else {
    const s = new THREE.Shape(); s.setFromPoints(dialPath(d, 1.3).getPoints(32));
    const gl = new THREE.Mesh(new THREE.ShapeGeometry(s, 24), glassMat); gl.position.z = zBezel + .2; gl.renderOrder = 2; root.add(gl);
  }

  // ---- couronne et poussoirs
  const crown = (x, y, z, r, len, rot = 0) => {
    const geo = new THREE.CylinderGeometry(r, r, len, 48, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++){ const px = pos.getX(i), pz = pos.getZ(i), a = Math.atan2(pz, px), rr = Math.hypot(px, pz); if (rr > r * .9){ const f = 1 - .07 * (Math.floor(a / (Math.PI / 24) + 100) % 2); pos.setX(i, px * f); pos.setZ(i, pz * f); } }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, polished); m.rotation.z = Math.PI/2 + rot; m.position.set(x, y, z); root.add(m);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * .55, r * .55, 2, 24), polished); stem.rotation.z = Math.PI/2 + rot; stem.position.set(x - Math.cos(rot) * len * .7, y - Math.sin(rot) * len * .7, z); root.add(stem);
    const end = new THREE.Mesh(new THREE.CircleGeometry(r * .62, 32), brushed); end.rotation.y = Math.PI/2; end.position.set(x + len / 2 + .01, y, z); if (!rot) root.add(end);
  };
  const zc = T * .4;
  crown(G.crownX + 2.2, 0, zc, 2.6, 3.6);
  if (shape === "rond" && ["plongee","gmt"].includes(w.bezel)){
    for (const sy of [1, -1]){ const g = new THREE.Mesh(new RoundedBoxGeometry(3.4, 3.2, T * .42, 3, .9), brushed); g.position.set(28.6, sy * 4.6, zc + .6); g.rotation.z = sy * .18; root.add(g); }
  }
  if (meta.chrono){ for (const s of [1, -1]){ const a = s * .55, r0 = G.crownX + 1.4; const p = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3.8, 32), polished); p.rotation.z = a - Math.PI/2; p.position.set(r0 * Math.cos(a), r0 * Math.sin(a), zc); root.add(p); const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1, 32), polished); cap.rotation.z = a - Math.PI/2; cap.position.set((r0 + 2) * Math.cos(a), (r0 + 2) * Math.sin(a), zc); root.add(cap); } }

  // ---- fond de boîte
  {
    const geo = planarUV(shape === "rond" ? new THREE.CircleGeometry(25.6, 128) : new THREE.ShapeGeometry(outline(shape, 3), 48));
    const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ map: backTex, color: backTex ? "#fff" : mt.color, metalness: backTex ? .55 : 1, roughness: .32, clearcoat: .5 }));
    m.rotation.y = Math.PI; m.position.z = -.02; root.add(m);
  }

  // ---- attaches du bracelet
  let yA, zA = T * .3;
  if (G.lugs){
    yA = 32.2; zA = T * .22;
  } else {
    yA = ({ coussin: 26, octo: 27, carre: 24, rect: 28, tonneau: 30 })[shape] || 27;
  }

  // ---- bracelet
  const strap = w.strap || "acier";
  const stc = /^#[0-9a-f]{6}$/i.test(w.strapColor || "") ? w.strapColor : ({ cuir: "#6B4226", caoutchouc: "#23282F", nato: "#2B3A55" })[strap] || "#23282F";
  // bracelet ouvert, comme posé pour une photo : chaque brin s'éloigne puis s'enroule vers l'arrière
  const depth = G.R * 1.7;
  const P0 = new THREE.Vector3(0, yA, zA), P1 = new THREE.Vector3(0, yA + 18, zA - 1), P2 = new THREE.Vector3(0, yA + 24, zA - depth * .75), P3 = new THREE.Vector3(0, yA + 10, zA - depth);
  const half = new THREE.CubicBezierCurve3(P0, P1, P2, P3), hl = half.getLength();
  const frameAt = s => { const u = Math.max(0, Math.min(1, s / hl)); return { p: half.getPointAt(u), t: half.getTangentAt(u) }; };
  const both = obj => { root.add(obj); const m = obj.clone(); m.scale.y = -1; root.add(m); };
  const widthAt = s => (G.lugs ? strapW - .4 : strapW) * (1 - .22 * Math.min(1, s / hl));
  const metalStrap = ["acier","jubile","titane","milanais"].includes(strap);
  const bMat = strap === "titane" ? new THREE.MeshPhysicalMaterial({ color: METALS.titane.color, metalness: 1, roughness: .38, roughnessMap: brushedMap }) : new THREE.MeshPhysicalMaterial({ color: (w.case === "doré" && false) ? mt.color : METALS.acier.color, metalness: 1, roughness: .34, roughnessMap: brushedMap });
  const pMat = new THREE.MeshPhysicalMaterial({ color: strap === "titane" ? METALS.titane.color : METALS.acier.color, metalness: 1, roughness: .1 });
  {
    const fa = frameAt;
    if (strap === "acier" || strap === "titane" || strap === "jubile"){
      const outer = new Builder(), center = new Builder();
      const step = strap === "jubile" ? 3.2 : 4.6, gap = .16;
      for (let s = 0, k = 0; s < hl - .5; s += step, k++){
        const s1 = Math.min(hl, s + step) - gap, W = widthAt(s);
        if (strap === "jubile"){
          sweep(outer, fa, s, s1, 4, () => roundedSection(-W/2, -W*.3, 2.5, 1, 5));
          sweep(outer, fa, s, s1, 4, () => roundedSection(W*.3, W/2, 2.5, 1, 5));
          const m1 = s + step / 2;
          sweep(center, fa, s, m1 - gap, 2, () => roundedSection(-W*.3 + .2, -W*.1 - .1, 3.3, .7));
          sweep(center, fa, m1, s1, 2, () => roundedSection(-W*.3 + .2, -W*.1 - .1, 3.3, .7));
          sweep(center, fa, s + step*.25, s1 - step*.25 + gap, 2, () => roundedSection(-W*.1 + .1, W*.1 - .1, 3.5, .8));
          sweep(center, fa, s, m1 - gap, 2, () => roundedSection(W*.1 + .1, W*.3 - .2, 3.3, .7));
          sweep(center, fa, m1, s1, 2, () => roundedSection(W*.1 + .1, W*.3 - .2, 3.3, .7));
        } else {
          sweep(outer, fa, s, s1, 4, () => roundedSection(-W/2, -W*.17 - .1, 2.5, 1.15, 5));
          sweep(outer, fa, s, s1, 4, () => roundedSection(W*.17 + .1, W/2, 2.5, 1.15, 5));
          sweep(strap === "titane" ? outer : center, fa, s, s1, 4, () => roundedSection(-W*.17, W*.17, 2.75, 1.1, 5));
        }
      }
      both(new THREE.Mesh(outer.geometry(), bMat));
      both(new THREE.Mesh(center.geometry(), strap === "jubile" ? pMat : bMat));
    } else {
      const b = new Builder();
      const th = strap === "nato" ? 1.2 : strap === "milanais" ? 1.6 : strap === "caoutchouc" ? 3.2 : 2.8;
      sweep(b, fa, 0, hl, 80, s => roundedSection(-widthAt(s)/2, widthAt(s)/2, th, strap === "nato" ? .5 : 1.2, 3));
      let mat;
      if (strap === "milanais"){
        const map = canvasTex(256, 256, (g, w2, h2) => { g.fillStyle = "#8E959C"; g.fillRect(0, 0, w2, h2); for (let y = 0; y < h2; y += 4) for (let x = 0; x < w2; x += 4){ g.fillStyle = (x + y) % 8 ? "#D9DDE1" : "#B9BFC5"; g.fillRect(x, y, 3, 3); } });
        map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(8, 30);
        mat = new THREE.MeshPhysicalMaterial({ color: "#fff", map, metalness: 1, roughness: .3, bumpMap: map, bumpScale: .4 });
      } else if (strap === "nato"){
        const light = parseInt(stc.slice(1, 3), 16) > 128;
        const map = canvasTex(256, 64, (g, w2, h2) => { g.fillStyle = stc; g.fillRect(0, 0, w2, h2); g.fillStyle = light ? "rgba(27,36,48,.65)" : "rgba(216,221,226,.65)"; g.fillRect(w2*.36, 0, w2*.08, h2); g.fillRect(w2*.56, 0, w2*.08, h2); for (let y = 0; y < h2; y += 2){ g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(0, y, w2, 1); } });
        map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(1, 10);
        mat = new THREE.MeshStandardMaterial({ map, roughness: .9 });
      } else if (strap === "caoutchouc"){
        const bump = canvasTex(64, 64, (g, w2, h2) => { g.fillStyle = "#888"; g.fillRect(0, 0, w2, h2); g.fillStyle = "#333"; g.fillRect(0, 0, w2, h2 * .3); }, false);
        bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(1, 30);
        mat = new THREE.MeshPhysicalMaterial({ color: stc, roughness: .55, bumpMap: bump, bumpScale: .6, sheen: .3 });
      } else {
        const bump = noiseTex(256, 60, 128, false); bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(2, 12);
        mat = new THREE.MeshPhysicalMaterial({ color: stc, roughness: .58, bumpMap: bump, bumpScale: .35, sheen: .5, sheenColor: new THREE.Color(stc).offsetHSL(0, 0, .2), clearcoat: .15 });
        // coutures
        const stitchMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(stc).getHSL({}).l > .5 ? "#6B4A2A" : "#E8D6B8", roughness: .8 });
        const n = Math.floor(hl / 2.3), inst = new THREE.InstancedMesh(new THREE.BoxGeometry(.4, 1.3, .35), stitchMat, n * 2), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
        let c = 0;
        for (let i = 0; i < n; i++){
          const s = 1 + i * 2.3, { p, t } = fa(s), nrm = new THREE.Vector3().crossVectors(X, t).normalize(), W = widthAt(s);
          q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, t, nrm));
          for (const sx of [-1, 1]){ const pp = p.clone().addScaledVector(X, sx * (W/2 - 1.7)).addScaledVector(nrm, th + .02); m4.compose(pp, q, new THREE.Vector3(1, 1, 1)); inst.setMatrixAt(c++, m4); }
        }
        both(inst);
      }
      both(new THREE.Mesh(b.geometry(), mat));
    }
  }
  // fermoir (bracelet métal) ou boucle ardillon (cuir, caoutchouc, tissu) au bout d'un brin
  {
    const { p, t } = frameAt(hl), W = widthAt(hl), X = new THREE.Vector3(1, 0, 0), nrm = new THREE.Vector3().crossVectors(X, t).normalize();
    const g = new THREE.Group();
    if (metalStrap){
      const clasp = new THREE.Mesh(new RoundedBoxGeometry(W + 1, 10, 3.8, 3, 1.2), pMat); clasp.position.set(0, 5, 1.6); g.add(clasp);
      const logo = new THREE.Mesh(new RoundedBoxGeometry(W * .5, 4, .6, 2, .25), bMat); logo.position.set(0, 5, 3.6); g.add(logo);
    } else {
      const r = .75, bw = W + 3, bh = 9, th = strap === "nato" ? 1.2 : strap === "caoutchouc" ? 3.2 : 2.8;
      for (const [x, y, len, rot] of [[0, bh, bw, Math.PI/2], [0, 0, bw, Math.PI/2], [bw/2, bh/2, bh, 0], [-bw/2, bh/2, bh, 0]]){ const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20), polished); c.position.set(x, y, th / 2); c.rotation.z = rot; g.add(c); }
      const tongue = new THREE.Mesh(new THREE.CylinderGeometry(.45, .45, bh, 16), polished); tongue.position.set(0, bh / 2, th + .5); g.add(tongue);
    }
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, t, nrm)); g.position.copy(p); root.add(g);
  }

  const k = realScale(w);
  root.scale.setScalar(k);
  root.userData = { hourH, minH, secH, gmtH, quartz, T: T * k, depth, k };
  return root;
}

// ---------- scène et interactions ----------
function makeContext(opts){
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", ...opts });
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
  r.outputColorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(r);
  return { r, env: pm.fromScene(studio(), .02).texture };
}
function lights(scene){
  const key = new THREE.DirectionalLight("#ffffff", 1.6); key.position.set(-40, 60, 90); scene.add(key);
  const rim = new THREE.DirectionalLight("#cfe0ff", .8); rim.position.set(60, -30, -40); scene.add(rim);
}
function setTime(model, now){
  const { hourH, minH, secH, gmtH, quartz } = model.userData;
  const ms = now.getMilliseconds(), sec = now.getSeconds() + (quartz ? 0 : Math.floor(ms / 125) / 8), min = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + min / 60;
  if (hourH) hourH.rotation.z = -hr / 12 * Math.PI * 2;
  if (minH) minH.rotation.z = -min / 60 * Math.PI * 2;
  if (secH) secH.rotation.z = -sec / 60 * Math.PI * 2;
  if (gmtH) gmtH.rotation.z = -((now.getHours() + min / 60) / 24) * Math.PI * 2;
}
function dispose(root){
  root.traverse(o => { if (o.geometry) o.geometry.dispose(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach(x => { ["map","roughnessMap","bumpMap"].forEach(k => x[k] && x[k].dispose()); x.dispose(); }); });
}

// Vignette « photo studio » : vue de trois quarts, heure classique 10 h 08.
let thumbCtx = null, thumbBg = null;
export async function renderThumb(w, art, size = 360){
  if (!thumbCtx){
    thumbCtx = makeContext({ preserveDrawingBuffer: true, alpha: false });
    thumbBg = canvasTex(512, 512, (g, W, H) => { const gr = g.createRadialGradient(W*.5, H*.36, 0, W*.5, H*.5, W*.75); gr.addColorStop(0, "#36414F"); gr.addColorStop(.55, "#1A212B"); gr.addColorStop(1, "#0B0F14"); g.fillStyle = gr; g.fillRect(0, 0, W, H); });
  }
  const { r, env } = thumbCtx;
  const ss = 2; r.setPixelRatio(1); r.setSize(size * ss, size * ss, false);
  const scene = new THREE.Scene(); scene.environment = env; scene.background = thumbBg; lights(scene);
  const model = await buildWatch(w, art, size > 500 ? 2048 : 1024);
  setTime(model, new Date(2024, 0, 1, 10, 8, 37));
  const pivot = new THREE.Group(); pivot.add(model); scene.add(pivot);
  model.position.z = -model.userData.T / 2;
  pivot.rotation.set(THREE.MathUtils.degToRad(14), THREE.MathUtils.degToRad(-16), 0);
  const camera = new THREE.PerspectiveCamera(26, 1, 1, 2000);
  // cadrage identique pour toutes les montres : une 36 mm paraît plus petite qu'une 44 mm
  const G = GEO[w.shape || "rond"] || GEO.rond, ext = 2 * G.R * model.userData.k + (G.lugs ? 14 : 8) * model.userData.k;
  const span = Math.max(84, ext + 10);
  camera.position.set(0, -3, span / 2 / Math.tan(THREE.MathUtils.degToRad(13)) * 1.02); camera.lookAt(0, -1, 0);
  r.render(scene, camera);
  const out = document.createElement("canvas"); out.width = out.height = size;
  const g2 = out.getContext("2d"); g2.imageSmoothingQuality = "high"; g2.drawImage(r.domElement, 0, 0, size, size);
  const blob = await new Promise(res => out.toBlob(res, "image/jpeg", .88));
  dispose(model);
  return blob;
}

export async function open(stage, w, art, ui){
  if (!renderer){ const c = makeContext(); renderer = c.r; envTex = c.env; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  const canvas = renderer.domElement; canvas.className = "v-canvas";
  stage.appendChild(canvas);
  const scene = new THREE.Scene(); scene.environment = envTex;
  lights(scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  const model = await buildWatch(w, art);
  const pivot = new THREE.Group(); pivot.add(model); scene.add(pivot);
  // cadrage : la tête de montre reste au centre de face, l'ensemble est recentré de profil
  const bb = new THREE.Box3().setFromObject(model), size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
  const headZ = model.userData.T / 2;
  let zoom = 1;
  const fit = (w, h, aspect) => { const vf = THREE.MathUtils.degToRad(camera.fov); return Math.max(h / 2 / Math.tan(vf / 2), w / 2 / (Math.tan(vf / 2) * aspect)) * 1.08; };
  const resize = () => { const r = stage.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px"; camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix(); };
  resize();
  const V = ui.state;
  let raf = 0, alive = true;
  const tick = () => {
    if (!alive) return;
    setTime(model, new Date());
    const side = Math.abs(Math.sin(THREE.MathUtils.degToRad(V.angle)));
    model.position.z = -(headZ + (ctr.z - headZ) * side) ;
    model.position.y = -ctr.y;
    pivot.rotation.set(THREE.MathUtils.degToRad(-V.tilt), THREE.MathUtils.degToRad(V.angle), 0);
    const front = fit(size.x + 8, size.y, camera.aspect), prof = fit(size.z + 8, size.y, camera.aspect);
    camera.position.set(0, 0, (front + (prof - front) * side) / zoom + size.z * .15); camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();
  // zoom au pincement et à la molette
  const pts = new Map(); let pinch0 = 0, zoom0 = 1;
  const onDown = e => { pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 2){ const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0]-b[0], a[1]-b[1]); zoom0 = zoom; V.pinching = true; ui.cancelDrag(); } };
  const onMove = e => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 2 && pinch0){ const [a, b] = [...pts.values()]; zoom = Math.max(.8, Math.min(3.2, zoom0 * Math.hypot(a[0]-b[0], a[1]-b[1]) / pinch0)); } };
  const onUp = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; if (!pts.size) V.pinching = false; };
  const onWheel = e => { e.preventDefault(); zoom = Math.max(.8, Math.min(3.2, zoom * Math.exp(-e.deltaY / 400))); };
  const onDbl = () => { zoom = zoom > 1.2 ? 1 : 2.2; };
  stage.addEventListener("pointerdown", onDown, true); stage.addEventListener("pointermove", onMove, true);
  stage.addEventListener("pointerup", onUp, true); stage.addEventListener("pointercancel", onUp, true);
  stage.addEventListener("wheel", onWheel, { passive: false }); stage.addEventListener("dblclick", onDbl);
  window.addEventListener("resize", resize);
  return {
    close(){
      alive = false; cancelAnimationFrame(raf);
      stage.removeEventListener("pointerdown", onDown, true); stage.removeEventListener("pointermove", onMove, true);
      stage.removeEventListener("pointerup", onUp, true); stage.removeEventListener("pointercancel", onUp, true);
      stage.removeEventListener("wheel", onWheel); stage.removeEventListener("dblclick", onDbl);
      window.removeEventListener("resize", resize);
      dispose(model);
      canvas.remove();
    }
  };
}
