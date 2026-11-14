import './style.css';
import { AUTOSCALE_TARGETS, BOOT_S, CACHE_STRATEGIES, GEO, GROUPABLE, MAX_GROUP, PALETTE_ORDER, RESIZE_S, SLA, SPECS, TICK, UNLOCKS, USERS_PER_RPS, waveRps } from './config';
import { advise } from './advisor';
import { fieldGuideButtonHtml, guideButtonHtml, initGuide, lessonDiagramsHtml, mountMiniDiagrams, setPlacingHint } from './guideview';
import { NODE_H, NODE_W, Renderer, drawIcon, type ViewState } from './render';
import { World, fmt } from './sim';
import { LESSONS, QUICKSTART, type Lesson } from './tutorial';
import { installSaveAndSandbox } from './menu';
import type { CacheStrategy, NodeKind, SimNode, TierSpec } from './types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let world = new World();
const canvas = $<HTMLCanvasElement>('#board');
let renderer = new Renderer(canvas, world);
const view: ViewState = { selectedNode: null, selected: [], box: null, selectedEdge: null, hoverNode: null, hoverEdge: null, linking: null, placing: null };
let speed = 1;
const lessonsSeen = new Set<number>();
const quick = new Set<string>();

// ------------------------------------------------------------------ helpers

function toast(text: string, kind: 'bad' | 'info' = 'bad') {
  const el = document.createElement('div');
  el.className = kind;
  el.innerHTML = text;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function iconCanvas(kind: NodeKind, size = 30) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = size * dpr;
  c.style.width = c.style.height = `${size}px`;
  const ctx = c.getContext('2d')!;
  ctx.scale((dpr * size) / 34, (dpr * size) / 34);
  drawIcon(ctx, kind, 17, 17);
  return c;
}

const money = (n: number) => (n < 0 ? '−$' : '$') + (Math.abs(n) < 10 && n % 1 !== 0 ? Math.abs(n).toFixed(2) : Math.floor(Math.abs(n)).toLocaleString());
const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms');

// ------------------------------------------------------------------ palette

const toolButtons = new Map<NodeKind, HTMLButtonElement>();
function buildPalette() {
  const p = $('#palette');
  p.innerHTML = '<h3>Components</h3>';
  PALETTE_ORDER.forEach((kind, i) => {
    const spec = SPECS[kind];
    const b = document.createElement('button');
    b.className = 'tool';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.style.background = spec.color;
    ico.appendChild(iconCanvas(kind, 22));
    b.appendChild(ico);
    b.insertAdjacentHTML('beforeend', `<span class="meta"><b>${spec.label}</b><small></small></span><span class="key">${i + 1}</span>`);
    b.onclick = () => startPlacing(kind);
    b.dataset.kind = kind; // hover card: guideview.ts
    p.appendChild(b);
    toolButtons.set(kind, b);
  });
  p.insertAdjacentHTML('beforeend', `<h3 style="margin-top:12px">Controls</h3>
    <div style="font-size:11.5px;color:var(--muted);padding:0 4px;line-height:1.8">
      <kbd>1-9</kbd> place · <kbd>Esc</kbd> cancel<br/>
      drag <b>port ●</b> to connect<br/>
      place with a node selected: <b>auto-wires</b> (<kbd>Alt</kbd> skips)<br/>
      <kbd>Shift</kbd>+click / drag: multi-select<br/>
      <kbd>⌘/Ctrl D</kbd> or <kbd>Alt</kbd>+drag: duplicate<br/>
      <kbd>+</kbd>/<kbd>−</kbd> group size · <kbd>⌘/Ctrl G</kbd> group<br/>
      <kbd>U</kbd> upgrade · <kbd>Del</kbd> sell<br/>
      <kbd>Space</kbd> start / pause · <kbd>F</kbd> fit</div>`);
}

function refreshPalette() {
  for (const [kind, b] of toolButtons) {
    const unlocked = world.unlocked(kind);
    const cost = SPECS[kind].tiers[0].cost;
    b.disabled = !unlocked;
    b.classList.toggle('on', view.placing?.kind === kind);
    b.classList.toggle('new', unlocked && UNLOCKS[kind] === world.waveNum && world.waveNum > 1);
    const small = b.querySelector('small')!;
    const t0 = SPECS[kind].tiers[0];
    const txt = unlocked ? `${t0.perM ? (cost ? `${money(cost)}/mo + usage` : 'pay per request') : `${money(cost)}/mo · ${fmt(t0.cap)} ${SPECS[kind].unit.replace('API ', '')}`}` : `🔒 wave ${UNLOCKS[kind]}`;
    if (small.textContent !== txt) small.textContent = txt;
  }
}

function startPlacing(kind: NodeKind) {
  if (!world.unlocked(kind)) return toast(`${SPECS[kind].label} unlocks at wave ${UNLOCKS[kind]}`);
  if (view.placing?.kind === kind) { view.placing = null; return; }
  // the selected node (if any) becomes the anchor the new one auto-wires to
  const anchor = view.selectedNode != null && view.selected.length <= 1 ? view.selectedNode : null;
  view.placing = { kind, x: -9999, y: -9999, ok: world.money >= SPECS[kind].tiers[0].cost, anchor, wire: wireMode(anchor, kind) };
}

/** How a freshly placed `kind` would hook up to the anchor: same kind copies its links, else anchor → new or new → anchor. */
function wireMode(anchorId: number | null | undefined, kind: NodeKind): 'out' | 'in' | 'copy' | null {
  const a = anchorId != null ? world.node(anchorId) : undefined;
  if (!a) return null;
  if (a.kind === kind) return world.edges.some((e) => e.from === a.id || e.to === a.id) ? 'copy' : null;
  if (SPECS[a.kind].canConnectTo.includes(kind)) return 'out';
  if (SPECS[kind].canConnectTo.includes(a.kind)) return 'in';
  return null;
}

// ------------------------------------------------------------------ selection

const selNodes = () => view.selected.map((id) => world.node(id)).filter((n): n is SimNode => !!n);
function selectOnly(id: number | null) { view.selectedNode = id; view.selected = id == null ? [] : [id]; view.selectedEdge = null; }
function selectMany(ids: number[]) { view.selected = [...new Set(ids)]; view.selectedNode = view.selected[view.selected.length - 1] ?? null; view.selectedEdge = null; }
function toggleSelect(id: number) {
  if (view.selected.includes(id)) selectMany(view.selected.filter((x) => x !== id));
  else selectMany([...view.selected, id]);
}

/** Where copies of `ns` fit: shift down (then right) until they don't overlap anything. */
function freeOffset(ns: SimNode[]) {
  const others = world.nodes.filter((n) => !ns.includes(n));
  const hits = (dx: number, dy: number) => ns.some((a) => others.some((b) => Math.abs(a.x + dx - b.x) < NODE_W + 12 && Math.abs(a.y + dy - b.y) < NODE_H + 12));
  const minY = Math.min(...ns.map((n) => n.y)), maxY = Math.max(...ns.map((n) => n.y));
  const step = maxY - minY + NODE_H + 24;
  for (let i = 1; i < 40; i++) {
    if (!hits(0, step * i)) return { dx: 0, dy: step * i };
    if (!hits(step * i, 0) && i > 3) return { dx: step * i, dy: 0 };
  }
  return { dx: 0, dy: step };
}

function duplicateSelection(at?: { dx: number; dy: number }) {
  const ns = selNodes().filter((n) => n.kind !== 'users');
  if (!ns.length) return null;
  const { dx, dy } = at ?? freeOffset(ns);
  const r = world.duplicate(ns, dx, dy);
  if (typeof r === 'string') { toast(r); return null; }
  selectMany(r.map((n) => n.id));
  return r;
}

function deleteSelection() {
  const ns = selNodes().filter((n) => n.kind !== 'users');
  for (const n of ns) world.removeNode(n.id);
  selectOnly(null);
}

/** Link every source to every target the rules allow. Single pair → show the rule that refused it. */
function connectMany(sources: SimNode[], targets: SimNode[]) {
  let made = 0, refused = 0, err: string | null = null;
  for (const a of sources) for (const t of targets) {
    if (a.id === t.id) continue;
    const e = world.connect(a, t);
    if (e) { refused++; err = e; continue; }
    made++;
    if (a.kind === 'users' && (t.kind === 'server' || t.kind === 'loadbalancer')) quick.add('users-link');
    if (a.kind === 'server' && t.kind === 'database') quick.add('db-link');
  }
  if (!made && err) toast(err);
  else if (made > 1 || refused) toast(`Connected ${made} link${made === 1 ? '' : 's'}${refused ? ` (${refused} not allowed or already there)` : ''}`, 'info');
}

/** A drag from a port: the whole selection if the port belongs to it; dropping on a selection fans out to all of it. */
function linkEnds(from: SimNode, onto: SimNode) {
  const sel = selNodes();
  const fromSel = sel.length > 1 && sel.includes(from);
  const sources = fromSel ? sel : [from];
  const targets = !fromSel && sel.length > 1 && sel.includes(onto) ? sel : [onto];
  return { sources, targets };
}

// ------------------------------------------------------------------ input

let drag: { kind: 'pan' | 'node' | 'box'; sx: number; sy: number; cx: number; cy: number; id?: number; offs?: Map<number, { ox: number; oy: number }>; moved?: boolean; click?: number; copied?: boolean } | null = null;

function local(e: PointerEvent | WheelEvent) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

const snap = (v: number) => Math.round(v / 12) * 12;

canvas.addEventListener('pointerdown', (e) => {
  const { sx, sy } = local(e);
  const p = renderer.toWorld(sx, sy);
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2) { drag = { kind: 'pan', sx, sy, cx: renderer.cam.x, cy: renderer.cam.y }; return; }

  if (view.placing) {
    const kind = view.placing.kind;
    const r = world.addNode(kind, snap(p.x - NODE_W / 2), snap(p.y - NODE_H / 2));
    if (typeof r === 'string') toast(r);
    else {
      const anchor = view.placing.anchor != null ? world.node(view.placing.anchor) : undefined;
      const mode = e.altKey ? null : view.placing.wire;
      if (anchor && mode === 'copy') { const k = world.copyWiring(anchor, r); if (k) toast(`Wired like ${SPECS[anchor.kind].label} #${anchor.id} (${k} link${k === 1 ? '' : 's'})`, 'info'); }
      else if (anchor && mode === 'out') connectMany([anchor], [r]);
      else if (anchor && mode === 'in') connectMany([r], [anchor]);
      if (!e.shiftKey) selectOnly(r.id);
      if (kind === 'server') quick.add('server');
      if (kind === 'database') quick.add('db');
    }
    if (!e.shiftKey) view.placing = null;
    return;
  }
  const port = renderer.portAt(p.x, p.y);
  if (port) { view.linking = { from: port.id, x: p.x, y: p.y, valid: null }; return; }
  const n = renderer.nodeAt(p.x, p.y);
  if (n) {
    let click: number | undefined;
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(n.id);
    else if (view.selected.includes(n.id)) { view.selectedNode = n.id; view.selectedEdge = null; click = n.id; } // keep the group for dragging
    else selectOnly(n.id);
    let moving = view.selected.includes(n.id) ? selNodes() : []; // shift-click that deselected it: don't drag
    // Alt+drag: drag out a copy (of the whole selection) and leave the originals in place
    let copied = false;
    if (e.altKey && moving.length) {
      const copies = duplicateSelection({ dx: 0, dy: 0 });
      if (copies) { moving = copies; copied = true; }
    }
    world.nodes = [...world.nodes.filter((x) => !moving.includes(x)), ...moving]; // bring to front
    drag = { kind: 'node', sx, sy, cx: 0, cy: 0, id: n.id, offs: new Map(moving.map((m) => [m.id, { ox: p.x - m.x, oy: p.y - m.y }])), click, copied };
    return;
  }
  const ed = renderer.edgeAt(p.x, p.y);
  if (ed) { view.selectedEdge = ed.id; view.selectedNode = null; view.selected = []; return; }
  // shift-drag on empty canvas: box select
  if (e.shiftKey) { drag = { kind: 'box', sx, sy, cx: p.x, cy: p.y }; view.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
  selectOnly(null);
  drag = { kind: 'pan', sx, sy, cx: renderer.cam.x, cy: renderer.cam.y };
});

canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = local(e);
  const p = renderer.toWorld(sx, sy);
  if (view.placing) {
    view.placing.x = p.x; view.placing.y = p.y;
    view.placing.ok = world.money >= SPECS[view.placing.kind].tiers[0].cost;
    if (e.altKey) view.placing.wire = null;
    else view.placing.wire = wireMode(view.placing.anchor, view.placing.kind);
  }
  if (view.linking) {
    view.linking.x = p.x; view.linking.y = p.y;
    const t = renderer.nodeAt(p.x, p.y);
    const a = world.node(view.linking.from);
    if (t && a) {
      const { sources, targets } = linkEnds(a, t);
      view.linking.valid = sources.some((s) => targets.some((x) => world.canConnect(s, x) === null));
    } else view.linking.valid = null;
  }
  if (drag && Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
  if (drag?.kind === 'pan') {
    renderer.cam.x = drag.cx - (sx - drag.sx) / renderer.cam.z;
    renderer.cam.y = drag.cy - (sy - drag.sy) / renderer.cam.z;
  } else if (drag?.kind === 'node' && drag.moved) {
    for (const [id, o] of drag.offs!) { const m = world.node(id); if (m) { m.x = snap(p.x - o.ox); m.y = snap(p.y - o.oy); } }
  } else if (drag?.kind === 'box' && view.box) { view.box.x1 = p.x; view.box.y1 = p.y; }
  const hn = renderer.nodeAt(p.x, p.y);
  view.hoverNode = hn?.id ?? null;
  const hp = !drag && !view.placing ? renderer.portAt(p.x, p.y) : null;
  if (hp) view.hoverNode = hp.id;
  view.hoverEdge = !hn && !hp && !drag ? renderer.edgeAt(p.x, p.y)?.id ?? null : null;
  canvas.className = view.placing ? 'placing' : drag?.kind === 'pan' ? 'panning' : view.linking || hp ? 'port' : hn ? 'grab' : '';
});

canvas.addEventListener('pointerup', (e) => {
  const { sx, sy } = local(e);
  const p = renderer.toWorld(sx, sy);
  if (view.linking) {
    const a = world.node(view.linking.from);
    const t = renderer.nodeAt(p.x, p.y);
    if (a && t && t.id !== a.id) { const { sources, targets } = linkEnds(a, t); connectMany(sources, targets); }
    view.linking = null;
  }
  if (drag?.kind === 'box' && view.box) {
    const b = view.box;
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    const inBox = world.nodes.filter((n) => n.x < x1 && n.x + NODE_W > x0 && n.y < y1 && n.y + NODE_H > y0).map((n) => n.id);
    if (inBox.length) selectMany([...view.selected, ...inBox]);
    view.box = null;
  }
  // a plain click (no drag) on a node of a multi-selection narrows the selection to it
  if (drag?.kind === 'node' && !drag.moved && drag.click != null && !drag.copied) selectOnly(drag.click);
  // Alt+click without dragging: don't leave the copies stacked exactly on the originals
  if (drag?.kind === 'node' && !drag.moved && drag.copied) {
    const cs = selNodes();
    const { dx, dy } = freeOffset(cs);
    for (const c of cs) { c.x += dx; c.y += dy; }
  }
  drag = null;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { sx, sy } = local(e);
  if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) renderer.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  else { renderer.cam.x += e.deltaX / renderer.cam.z; }
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Enter' || e.key === 'Escape') ($('#modal .actions .primary') as HTMLButtonElement | null)?.click();
    return;
  }
  if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
  const sel = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelection(); return; }
  if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectMany(world.nodes.filter((n) => n.kind !== 'users').map((n) => n.id)); return; }
  if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); groupSelection(); return; }
  if (mod) return;
  if (e.key === 'Escape') { view.placing = null; view.linking = null; view.box = null; selectOnly(null); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (view.selected.length > 1) deleteSelection();
    else if (sel && sel.kind !== 'users') { world.removeNode(sel.id); selectOnly(null); }
    else if (view.selectedEdge != null) { world.removeEdge(view.selectedEdge); view.selectedEdge = null; }
  } else if (e.key === 'u' || e.key === 'U') { for (const n of view.selected.length > 1 ? selNodes() : sel ? [sel] : []) if (n.kind !== 'users') doUpgrade(n); }
  else if ((e.key === '+' || e.key === '=') && sel) scaleGroup(sel, 1);
  else if ((e.key === '-' || e.key === '_') && sel) scaleGroup(sel, -1);
  else if (e.key === 'f' || e.key === 'F') renderer.fit();
  else if (e.key === ' ') {
    e.preventDefault();
    if (world.phase === 'build') start();
    else setSpeed(speed === 0 ? 1 : 0);
  } else if (/^[1-9]$/.test(e.key)) {
    const kind = PALETTE_ORDER[Number(e.key) - 1];
    if (kind) startPlacing(kind);
  }
});

function scaleGroup(n: SimNode, d: number) {
  if (!GROUPABLE.includes(n.kind)) return;
  const err = world.setCount(n, world.owned(n) + d);
  if (err) toast(err);
}

function groupSelection() {
  const ns = selNodes();
  if (ns.length < 2) return toast(`Select two or more ${GROUPABLE.map((k) => SPECS[k].label).join(' / ')} nodes of the same size to group them`);
  const r = world.merge(ns);
  if (typeof r === 'string') return toast(r);
  selectOnly(r.id);
  toast(`Grouped into ${SPECS[r.kind].label} ×${r.count}`, 'info');
}

function doUpgrade(n: SimNode) {
  const err = world.upgrade(n);
  if (err) toast(err);
}

// ------------------------------------------------------------------ HUD + controls

function setSpeed(s: number) {
  speed = s;
  document.querySelectorAll<HTMLButtonElement>('#speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === s));
}
document.querySelectorAll<HTMLButtonElement>('#speed button').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));

function start() {
  if (world.phase !== 'build') return;
  quick.add('start');
  if (speed === 0) setSpeed(1);
  world.startWave();
}
$('#btn-start').onclick = start;
$('#btn-help').onclick = showLessonIndex;

function setStat(id: string, value: string, sub: string, cls = '') {
  const el = $(`#${id}`);
  el.className = `stat ${cls}`;
  const b = el.querySelector('b')!, s = el.querySelector('small')!;
  if (b.textContent !== value) b.textContent = value;
  if (s.textContent !== sub) s.innerHTML = sub;
}

function refreshHud() {
  const m = world.metrics;
  const w = world.wave;
  const running = world.phase === 'run';
  setStat('s-wave', `${world.waveNum}`, running ? `${w.title} · ${Math.max(0, Math.ceil(w.duration - world.time))}s left` : `next: ${w.title}`);
  setStat('s-users', running ? fmt(m.demand * USERS_PER_RPS) : fmt(w.peakRps * USERS_PER_RPS),
    running ? `${fmt(m.demand)} req/s` : `peak ${fmt(w.peakRps)} req/s incoming`);
  setStat('s-p99', running && m.success > 0.01 ? ms(m.p99) : '—', running ? `p50 ${ms(m.p50)}` : `SLA < ${SLA.p99}ms`,
    !running ? '' : m.p99 > SLA.p99 ? 'bad' : m.p99 > SLA.p99 * 0.6 ? 'warn' : 'good');
  setStat('s-err', running ? (m.errorRate * 100).toFixed(m.errorRate < 0.1 ? 2 : 1) + '%' : '—', running ? `${fmt(m.errors)} failing/s${m.staleRate > 0.005 ? ` · ${(m.staleRate * 100).toFixed(1)}% stale reads` : ''}` : `SLA < ${SLA.errorRate * 100}%`,
    !running ? '' : m.errorRate > SLA.errorRate ? 'bad' : m.errorRate > SLA.errorRate / 3 || m.staleRate > SLA.stale ? 'warn' : 'good');
  const net = m.revenue - m.upkeep;
  setStat('s-money', money(Math.floor(world.money)), running ? `${net >= 0 ? '+' : ''}${money(net)}/mo net` : `bill ${money(world.burn())}/mo`, world.money < 0 ? 'bad' : '');
  const rep = $('#s-rep .meter i');
  rep.style.width = `${world.reputation}%`;
  rep.style.background = world.reputation > 60 ? 'var(--good)' : world.reputation > 30 ? 'var(--warn)' : 'var(--bad)';
  const btn = $<HTMLButtonElement>('#btn-start');
  btn.disabled = world.phase !== 'build';
  btn.textContent = world.phase === 'run' ? `Wave ${world.waveNum} running` : world.phase === 'gameover' ? 'Game over' : `Start wave ${world.waveNum}`;
  btn.classList.toggle('pulse', world.phase === 'build' && quick.has('db-link'));
}


// ------------------------------------------------------------------ inspector

const specLine = (t: TierSpec) => [t.vcpu ? `${t.vcpu} vCPU${t.burst ? ' (burst)' : ''}` : '', t.ram ? `${t.ram} GB` : '', t.tag ?? ''].filter(Boolean).join(' · ');

function settingsHtml(n: SimNode) {
  const opt = (act: string, v: string, label: string, on: boolean) => `<button class="${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
  if (n.kind === 'cache') {
    const cur = CACHE_STRATEGIES[n.strategy];
    return `<div class="settings"><label>Caching strategy</label>
      <div class="seg">${(Object.keys(CACHE_STRATEGIES) as CacheStrategy[]).map((k) => opt('strategy', k, CACHE_STRATEGIES[k].label, n.strategy === k)).join('')}</div>
      <p>${cur.how}</p><div class="connects"><b>Wire it:</b> ${cur.wiring}</div></div>`;
  }
  if (n.kind === 'cdn') return `<div class="settings"><label>What the edge caches</label>
      <div class="seg">${opt('cdnapi', '0', 'Static assets', !n.cdnApi)}${opt('cdnapi', '1', 'Static + public GETs', n.cdnApi)}</div>
      <p>${n.cdnApi ? 'Also caches public (non-personalized) GET responses for 10s: ~40% of reads become edge hits, at the cost of serving data up to 10s stale. With Users → LB also wired, reads go via the CDN too.' : 'Only static files (images, JS, CSS) are cached. Versioned URLs make them safe to cache for a long time.'}</p></div>`;
  const primary = n.kind === 'replica' ? world.parents(n).find((p) => p.kind === 'database') : undefined;
  const match = primary && primary.tier > n.tier
    ? `<div class="settings"><label>Smaller than its primary</label>
      <p>Every replica holds the full database and replays every write, so it needs about the same RAM and CPU as the primary. A small one stays disk-bound however many you add.</p>
      <button class="btn" data-act="tier" data-v="${primary.tier}" ${world.unlocked('upgrade') ? '' : 'disabled'}>Match primary: ${SPECS.replica.tiers[primary.tier].name} · ${money(world.resizeCost(n, primary.tier))}</button></div>`
    : '';
  if (n.kind === 'database' || n.kind === 'replica') return match + `<div class="settings"><label>Connection pooler (RDS Proxy / PgBouncer)</label>
      <div class="seg">${opt('pooler', '0', 'Off', !n.pooler)}${opt('pooler', '1', `On · ${money(11 * Math.max(2, SPECS[n.kind].tiers[n.tier].vcpu))}/mo`, n.pooler)}</div>
      <p>Each app process keeps its own pool of DB connections, and every Postgres connection is a process using ~8 MB. A pooler multiplexes thousands of client connections onto a few hundred real ones.</p></div>`;
  return '';
}

/** a stepper's value as a field you can type into; committed on Enter or blur (see the inspector's change handler) */
const numInput = (act: string, v: number, min: number, max: number) =>
  `<input class="num" type="number" inputmode="numeric" data-num="${act}" value="${v}" min="${min}" max="${max}" step="1" />`;

function groupHtml(n: SimNode) {
  if (!GROUPABLE.includes(n.kind)) return '';
  const unit = SPECS[n.kind].tiers[n.tier].cost;
  const up = world.active(n);
  const a = n.auto;
  const owned = world.owned(n);
  const opt = (act: string, v: string, label: string, on: boolean, off = false) => `<button class="${on ? 'on' : ''}" data-act="${act}" data-v="${v}" ${off ? 'disabled' : ''}>${label}</button>`;
  const locked = !world.unlocked('autoscale');
  const booting = n.instDown.filter((d) => d.boot).length;
  const policy = `<label>Autoscaling (target tracking)</label>
    <div class="seg">${opt('auto', '0', 'Fixed size', !a)}${opt('auto', '1', locked ? `Autoscale 🔒 w${UNLOCKS.autoscale}` : 'Autoscale', !!a, locked)}</div>
    ${a ? `<label>Keep each instance's load near</label>
    <div class="seg">${AUTOSCALE_TARGETS.map((t) => opt('auto-target', String(t), `${Math.round(t * 100)}%`, Math.abs(a.target - t) < 1e-6)).join('')}</div>
    <label>Maximum instances</label>
    <div class="stepper">
      <button class="btn" data-act="auto-max" data-v="-1" ${a.max <= a.min ? 'disabled' : ''}>−</button>
      ${numInput('auto-max', a.max, a.min, MAX_GROUP)}
      <button class="btn" data-act="auto-max" data-v="1" ${a.max >= MAX_GROUP ? 'disabled' : ''}>+</button>
    </div>
    <p>${n.count} running now${booting ? ` (${booting} booting)` : ''}. The minimum is always on and paid up front; instances the policy adds are billed only while they run. It tracks load per instance (requests arriving vs. what one instance handles, like ALB requests per target): above the target it launches enough instances in one step; it removes them slowly, once there is clear headroom. A crashed instance is replaced, not restarted. New ones boot for ~${BOOT_S}s first, so a spike faster than that hits before they help: a lower target or a higher minimum is your headroom.</p>`
    : `<p>A fixed group is sized for peak and bills for it all month. ${locked ? 'Autoscaling unlocks later.' : 'With autoscaling it grows with traffic and shrinks back off-peak.'}</p>`}`;
  return `<div class="settings"><label>${a ? 'Minimum instances' : 'Instances'}</label>
    <div class="stepper">
      <button class="btn" data-act="count" data-v="-1" ${owned <= 1 ? 'disabled' : ''}>−</button>
      ${numInput('count-set', owned, 1, MAX_GROUP)}
      <button class="btn" data-act="count" data-v="1" ${owned >= MAX_GROUP ? 'disabled' : ''}>+ ${money(unit)}</button>
      ${[4, 8, 16].filter((c) => c > owned).slice(0, 2).map((c) => `<button class="btn" data-act="count-set" data-v="${c}">×${c}</button>`).join('')}
    </div>
    <p>${!a && n.count > 1 ? `${up} of ${n.count} serving. ` : ''}N identical ${SPECS[n.kind].tiers[n.tier].name} instances behind one node: capacity, NIC and cost scale with N, each instance keeps its own RAM and DB connection pool, and a crash takes out one instance instead of the whole node. Mid-wave, new instances boot for ~${BOOT_S}s first. (<kbd>+</kbd>/<kbd>−</kbd>)</p>
    ${policy}</div>`;
}

/**
 * Panel that has a mouse button held down on it. Rebuilding its HTML mid-press swaps the button out from
 * under the pointer and the browser never fires the click, so refreshes wait until the press ends.
 */
let pressed: Element | null = null;
window.addEventListener('pointerdown', (ev) => { pressed = (ev.target as Element).closest('#inspector, #advisor'); }, true);
window.addEventListener('pointerup', () => setTimeout(() => (pressed = null)), true); // after the click fires
window.addEventListener('pointercancel', () => (pressed = null), true);

let inspectorHtml = '';
function refreshInspector() {
  const el = $('#inspector');
  if (pressed === el) return;
  if (document.activeElement instanceof HTMLInputElement && el.contains(document.activeElement)) return; // mid-edit
  let html = '';
  const n = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  const e = view.selectedEdge != null ? world.edges.find((x) => x.id === view.selectedEdge) : undefined;
  const many = selNodes();
  if (many.length > 1) {
    const kinds = new Map<NodeKind, number>();
    for (const m of many) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + m.count);
    const sellable = many.filter((m) => m.kind !== 'users');
    const dup = world.duplicateCost(sellable);
    const bill = many.reduce((a, m) => a + (world.phase === 'run' ? m.stats.cost : world.fixedCost(m)), 0);
    const canGroup = world.canMerge(many);
    html = `<div class="head"><div><b>${many.length} nodes selected</b><small>${money(bill)}/mo combined</small></div></div>
      <div class="chips">${[...kinds].map(([k, c]) => `<span class="chip"><i style="background:${SPECS[k].color}"></i>${c} × ${SPECS[k].label}</span>`).join('')}</div>
      <p>Drag any of them to move them together. Drag a port on one of them to connect <b>all</b> of them; drop a link onto one of them to fan out to <b>all</b> of them.</p>
      <ul class="picks">${many.map((m) => `<li data-act="pick" data-v="${m.id}"><i style="background:${SPECS[m.kind].color}"></i>${SPECS[m.kind].label}${m.count > 1 ? ` ×${m.count}` : ''} <span>#${m.id} · ${SPECS[m.kind].tiers[m.tier].name}</span></li>`).join('')}</ul>
      <div class="row">
        <button class="btn" data-act="dup" ${sellable.length ? '' : 'disabled'}>Duplicate · ${money(dup)}</button>
        <button class="btn" data-act="upgrade-all" ${world.unlocked('upgrade') ? '' : 'disabled'}>Upgrade all</button>
      </div>
      <div class="row">
        <button class="btn" data-act="group" ${canGroup ? '' : 'disabled'} title="${canGroup ? 'Merge into one autoscaling group (keeps every link)' : `Needs ${GROUPABLE.map((k) => SPECS[k].label).join(' / ')} nodes of one kind and size`}">Group into one</button>
        <button class="btn danger" data-act="sell-all" ${sellable.length ? '' : 'disabled'}>Sell all · ${money(sellable.reduce((a, m) => a + world.sellValue(m), 0))}</button>
      </div>`;
  } else if (n) {
    const spec = SPECS[n.kind];
    const st = n.stats;
    const tier = spec.tiers[n.tier];
    const up = world.upgradeCost(n);
    const isUsers = n.kind === 'users';
    const running = world.phase === 'run';
    const restart = running && world.isGroup(n) ? ' (rolling, no downtime)' : running && RESIZE_S[n.kind] > 0 ? ` (restarts ~${RESIZE_S[n.kind]}s)` : '';
    const cell = (k: string, v: string, bad?: boolean) => `<div><label>${k}</label><span style="color:${bad ? 'var(--bad)' : 'inherit'}">${v}</span></div>`;
    const cost = world.phase === 'run' ? st.cost : tier.cost + world.poolerCost(n);
    html = `
      <div class="head"><span class="ico" style="background:${spec.color}" data-icon="${n.kind}"></span>
        <div><b>${spec.label} <span style="color:var(--muted);font-weight:400">#${n.id}</span></b><small>${isUsers ? `${GEO.map((g) => `${Math.round(g.share * 100)}% at ${g.rtt}ms`).join(' · ')}` : `${tier.name} · ${specLine(tier) || 'managed'} · ${money(cost)}/mo`}</small></div></div>
      ${st.note ? `<div class="note">⚠ ${st.note}</div>` : ''}
      <div class="grid">
        ${cell('In', `${fmt(st.inRps)}/s`)}
        ${isUsers ? cell('Online', fmt(world.metrics.demand * USERS_PER_RPS)) : `${cell('Capacity', `${fmt(world.cap(n))} ${spec.unit}`)}
        ${cell('Load', `${Math.round(st.util * 100)}%`, st.util > 1)}
        ${cell('Latency', ms(st.latency))}
        ${cell('Dropped', `${fmt(st.dropRps)}/s`, st.dropRps > 0.5)}
        ${st.rows.map(([k, v, bad]) => cell(k, v, bad)).join('')}`}
      </div>
      ${st.ramWhy ? `<p class="why"><b>RAM:</b> ${st.ramWhy}</p>` : ''}
      ${groupHtml(n)}
      ${settingsHtml(n)}
      <p>${spec.blurb}</p>
      <div class="connects"><b>How to wire:</b> ${spec.wiring}</div>
      ${guideButtonHtml(n.kind)}
      ${isUsers ? '' : `
      <table class="tiers">${spec.tiers.map((t, i) => `<tr class="${i === n.tier ? 'cur' : ''}" ${i === n.tier ? '' : `data-act="tier" data-v="${i}" title="Resize to ${t.name}${restart}"`}><td>${i === n.tier ? '▸' : ' '}</td><td>${t.name}</td><td>${t.vcpu ? `${t.vcpu}c/${t.ram}G` : ''}</td><td>${fmt(t.cap)}</td><td>${money(t.cost)}${t.perM ? '+' : ''}</td></tr>`).join('')}</table>
      <div class="row">
        <button class="btn" data-act="upgrade" ${up === null || !world.unlocked('upgrade') ? 'disabled' : ''}>${up === null ? 'Max size' : !world.unlocked('upgrade') ? `Upgrade 🔒 w${UNLOCKS.upgrade}` : `Upgrade · ${money(up)}${restart}`}</button>
        <button class="btn danger" data-act="sell">Sell · ${money(world.sellValue(n))}</button>
      </div>
      <div class="row"><button class="btn" data-act="dup">Duplicate with links · ${money(world.duplicateCost([n]))}</button></div>`}`;
  } else if (e) {
    const a = world.node(e.from), b = world.node(e.to);
    html = `<div class="head"><div><b>Connection</b><small>${a ? SPECS[a.kind].label : '?'} → ${b ? SPECS[b.kind].label : '?'}</small></div></div>
      <div class="grid">
        <div><label>Static</label><span class="c-s">${fmt(e.rps.s)}/s</span></div>
        <div><label>Reads</label><span class="c-r">${fmt(e.rps.r)}/s</span></div>
        <div><label>Writes</label><span class="c-w">${fmt(e.rps.w)}/s</span></div>
        <div><label>Bots</label><span class="c-b">${fmt(e.rps.b)}/s</span></div>
      </div>
      ${a?.kind === 'database' && b?.kind === 'replica' ? '<p>Async replication: every committed write is shipped to the replica and replayed.</p>' : ''}
      ${b?.kind === 'cache' || a?.kind === 'cache' ? '<p>Cache traffic includes GETs, SETs after a miss, and DELETEs (invalidations) after writes.</p>' : ''}
      <div class="row"><button class="btn danger" data-act="unlink">Remove connection</button></div>`;
  }
  if (html !== inspectorHtml) {
    inspectorHtml = html;
    el.innerHTML = html;
    el.querySelectorAll<HTMLElement>('[data-icon]').forEach((x) => x.appendChild(iconCanvas(x.dataset.icon as NodeKind, 24)));
  }
}
$('#inspector').addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  const act = t.dataset?.num;
  const n = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  if (!act || !n) return;
  const v = Math.round(Number(t.value));
  if (Number.isFinite(v)) {
    if (act === 'count-set') { const err = world.setCount(n, v); if (err) toast(err); }
    if (act === 'auto-max') world.setAutoscaleLimits(n, { max: v });
  }
  inspectorHtml = ''; // redraw with the value that actually stuck (clamped, or unchanged if it was refused)
});
$('#inspector').addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (!t.dataset?.num) return;
  if (ev.key === 'Enter') t.blur(); // blur fires change
  if (ev.key === 'Escape') { t.value = t.defaultValue; t.blur(); } // revert: no change event
});
$('#inspector').addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  const act = t?.dataset.act, v = t?.dataset.v ?? '';
  const n = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  if (act === 'upgrade' && n) doUpgrade(n);
  if (act === 'tier' && n) { const err = world.resize(n, Number(v)); if (err) toast(err); }
  if (act === 'strategy' && n) world.setStrategy(n, v as CacheStrategy);
  if (act === 'cdnapi' && n) world.setCdnApi(n, v === '1');
  if (act === 'pooler' && n) world.setPooler(n, v === '1');
  if (act === 'sell' && n) { world.removeNode(n.id); selectOnly(null); }
  if (act === 'count' && n) scaleGroup(n, Number(v));
  if (act === 'count-set' && n) { const err = world.setCount(n, Number(v)); if (err) toast(err); }
  if (act === 'auto' && n) { const err = world.setAutoscale(n, v === '1'); if (err) toast(err); }
  if (act === 'auto-max' && n?.auto) world.setAutoscaleLimits(n, { max: n.auto.max + Number(v) });
  if (act === 'auto-target' && n) world.setAutoscaleLimits(n, { target: Number(v) });
  if (act === 'dup') duplicateSelection();
  if (act === 'group') groupSelection();
  if (act === 'sell-all') deleteSelection();
  if (act === 'upgrade-all') for (const m of selNodes()) if (m.kind !== 'users') doUpgrade(m);
  if (act === 'pick') selectOnly(Number(v));
  if (act === 'unlink' && view.selectedEdge != null) { world.removeEdge(view.selectedEdge); view.selectedEdge = null; }
  inspectorHtml = '';
});

// ------------------------------------------------------------------ advisor / log / quickstart

let advisorHtml = '';
function refreshAdvisor() {
  if (pressed === $('#advisor')) return;
  const html = advise(world).map((h) => `<li class="${h.level}" ${h.node ? `data-node="${h.node}"` : ''}>${h.text}</li>`).join('');
  if (html !== advisorHtml) { advisorHtml = html; $('#advisor ul').innerHTML = html; }
}
$('#advisor').addEventListener('click', (ev) => {
  const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-node]')?.dataset.node;
  if (id) selectOnly(Number(id));
});

let logLen = -1, logTop: unknown = null;
function refreshLog() {
  if (world.log.length === logLen && world.log[0] === logTop) return;
  logLen = world.log.length; logTop = world.log[0];
  $('#log ul').innerHTML = world.log.map((l) => `<li class="${l.kind}">${l.text}</li>`).join('');
}

function refreshQuickstart() {
  const el = $('#quickstart');
  if (world.waveNum > 1 || quick.has('start')) { if (el.innerHTML) el.innerHTML = ''; return; }
  // also detect completion from actual graph state (e.g. if the player did things in another order)
  const servers = world.nodes.filter((n) => n.kind === 'server');
  if (servers.length) quick.add('server');
  if (world.nodes.some((n) => n.kind === 'database')) quick.add('db');
  const users = world.nodes.find((n) => n.kind === 'users')!;
  if (world.children(users).length) quick.add('users-link');
  if (servers.some((s) => world.children(s, ['database']).length)) quick.add('db-link');
  const cur = QUICKSTART.find((q) => !quick.has(q.id))?.id;
  const html = `<h4>Get started</h4><ul>${QUICKSTART.map((q) => `<li class="${quick.has(q.id) ? 'done' : q.id === cur ? 'cur' : ''}">${q.text}</li>`).join('')}</ul>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ------------------------------------------------------------------ charts

function sparkline(id: string, series: { data: number[]; color: string; fill?: boolean }[], opts: { max?: number; line?: number; fmt: (n: number) => string }) {
  const c = $<HTMLCanvasElement>(id);
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const all = series.flatMap((s) => s.data);
  let max = Math.max(opts.max ?? 0, ...all, opts.line ? opts.line * 1.25 : 0, 1e-6);
  const N = Math.max(60, ...series.map((s) => s.data.length));
  const X = (i: number) => (i / (N - 1)) * r.width;
  const Y = (v: number) => r.height - 2 - (Math.min(v, max) / max) * (r.height - 14);
  if (opts.line) {
    ctx.strokeStyle = 'rgba(244,63,94,.6)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, Y(opts.line)); ctx.lineTo(r.width, Y(opts.line)); ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const s of series) {
    const off = N - s.data.length;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    s.data.forEach((v, i) => (i ? ctx.lineTo(X(i + off), Y(v)) : ctx.moveTo(X(i + off), Y(v))));
    ctx.stroke();
    if (s.fill && s.data.length) {
      ctx.lineTo(X(N - 1), r.height); ctx.lineTo(X(off), r.height); ctx.closePath();
      ctx.fillStyle = s.color + '22';
      ctx.fill();
    }
  }
  ctx.fillStyle = '#8a93a6';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(opts.fmt(max), r.width - 2, 10);
}

function refreshCharts() {
  const h = world.history;
  sparkline('#c-traffic', [{ data: h.map((x) => x.demand), color: '#8a93a6' }, { data: h.map((x) => x.success), color: '#22c55e', fill: true }], { fmt: (n) => fmt(n) + '/s' });
  sparkline('#c-lat', [{ data: h.map((x) => x.p99), color: '#7c9cff', fill: true }], { line: SLA.p99, fmt: ms });
  sparkline('#c-err', [{ data: h.map((x) => x.err * 100), color: '#f43f5e', fill: true }], { line: SLA.errorRate * 100, max: 3, fmt: (n) => n.toFixed(0) + '%' });
}

// ------------------------------------------------------------------ modals

function modal(html: string, actions: { label: string; primary?: boolean; onClick?: () => void }[]) {
  const m = $('#modal');
  const card = m.querySelector('.card')!;
  card.innerHTML = html + `<div class="actions"></div>`;
  mountMiniDiagrams(card);
  const row = card.querySelector('.actions')!;
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.primary ? 'primary' : 'btn';
    b.textContent = a.label;
    b.onclick = () => { m.classList.add('hidden'); a.onClick?.(); };
    row.appendChild(b);
  }
  m.classList.remove('hidden');
  if (speed !== 0 && world.phase === 'run') { const prev = speed; setSpeed(0); const done = () => setSpeed(prev); row.querySelectorAll('button').forEach((b) => b.addEventListener('click', done)); }
}

function lessonHtml(wave: number, l: Lesson) {
  const chips = (l.tools ?? []).map((t) => {
    const label = t === 'upgrade' ? 'Upgrade (vertical scaling)' : t === 'sharding' ? 'Multiple primaries (sharding)' : t === 'autoscale' ? 'Autoscaling groups' : SPECS[t].label;
    const color = t === 'upgrade' ? '#7c9cff' : t === 'sharding' ? SPECS.database.color : t === 'autoscale' ? SPECS.server.color : SPECS[t].color;
    return `<span class="chip"><i style="background:${color}"></i>${label}</span>`;
  }).join('');
  return `<div class="eyebrow">Wave ${wave}${l.tools?.length ? ' · new tools' : ''}</div><h2>${l.title}</h2>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${l.body.map((p) => `<p>${p}</p>`).join('')}
    ${lessonDiagramsHtml(l.tools ?? [])}
    ${l.interview ? `<div class="tip"><b>Interview angle:</b> ${l.interview}</div>` : ''}`;
}

function maybeShowLesson() {
  const l = LESSONS[world.waveNum];
  if (!l || lessonsSeen.has(world.waveNum)) return false;
  lessonsSeen.add(world.waveNum);
  modal(lessonHtml(world.waveNum, l), [{ label: 'Got it', primary: true }]);
  return true;
}

function showLessonIndex() {
  const items = Object.entries(LESSONS).filter(([w]) => Number(w) <= world.waveNum)
    .map(([w, l]) => `<button class="btn" data-w="${w}">Wave ${w}: ${l.title}</button>`).join('');
  modal(`<div class="eyebrow">Field guide</div><h2>Lessons so far</h2>
    <p>Each wave introduces a concept. Revisit any of them here.</p>${fieldGuideButtonHtml()}<div class="lessons">${items}</div>`, [{ label: 'Close', primary: true }]);
  $('#modal .lessons').addEventListener('click', (e) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>('[data-w]')?.dataset.w;
    if (w) modal(lessonHtml(Number(w), LESSONS[Number(w)]), [{ label: 'Back', onClick: showLessonIndex }, { label: 'Close', primary: true }]);
  });
}

function wireWorld() {
  world.onWaveEnd = (r) => {
    const next = world.wave;
    const grade = r.okRate > 0.999 ? 'S' : r.okRate > 0.99 ? 'A' : r.okRate > 0.97 ? 'B' : r.okRate > 0.9 ? 'C' : 'D';
    modal(`<div class="eyebrow">Wave ${r.wave} complete · grade ${grade}</div><h2>${r.okRate > 0.99 ? 'Clean run.' : r.okRate > 0.95 ? 'Survived, barely.' : 'Rough one.'}</h2>
      <div class="report">
        <div><label>Served</label><span>${fmt(r.served)}</span></div>
        <div><label>Success</label><span>${(r.okRate * 100).toFixed(1)}%</span></div>
        <div><label>Worst p99</label><span>${ms(r.worstP99)}</span></div>
        <div><label>Bonus</label><span>+${money(r.bonus)}</span></div>
      </div>
      <div class="next"><div class="eyebrow">Up next · wave ${next.index}</div>
        <p><b>${next.title}</b>: peak <b>${fmt(next.peakRps)} req/s</b> (~${fmt(next.peakRps * USERS_PER_RPS)} users), ${Math.round(next.peakRps / waveRps(r.wave) * 100 - 100)}% more than this wave.
        Mix: ${Math.round(next.mix.s * 100)}% static · ${Math.round(next.mix.r * 100)}% reads · ${Math.round(next.mix.w * 100)}% writes${next.mix.b ? ` · <span class="c-b">+${next.mix.b * 100}% bots</span>` : ''}.</p>
        ${next.event ? `<p class="c-b">⚠ ${next.event.label}</p>` : ''}
        ${next.chaos > 0 ? `<p style="color:var(--muted)">Random instance failures are on (servers and caches).</p>` : ''}</div>`,
      [{ label: 'Build phase →', primary: true, onClick: () => { maybeShowLesson(); } }]);
  };
  world.onGameOver = () => {
    const best = Math.max(Number(localStorage.getItem('best') ?? 0), world.bestWave);
    try { localStorage.setItem('best', String(best)); } catch { /* ignore */ }
    modal(`<div class="eyebrow">Incident postmortem</div><h2>Your users left.</h2>
      <p>You made it through <b>${world.waveNum - 1}</b> wave${world.waveNum === 2 ? '' : 's'} and served <b>${fmt(world.totalServed)}</b> requests at a peak of <b>${fmt(world.wave.peakRps * USERS_PER_RPS)}</b> users.</p>
      <p>Best: wave ${best}. Every outage teaches something. Check the advisor to see what broke.</p>`,
      [{ label: 'Try again', primary: true, onClick: reset }]);
  };
}

function reset() {
  world = new World();
  renderer = new Renderer(canvas, world);
  renderer.resize();
  lessonsSeen.clear();
  quick.clear();
  selectOnly(null);
  wireWorld();
  inspectorHtml = advisorHtml = '';
  maybeShowLesson();
}

// ------------------------------------------------------------------ loop

let last = performance.now();
let acc = 0;
let uiAcc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (world.phase === 'run' && speed > 0) {
    acc += dt * speed;
    let steps = 0;
    while (acc >= TICK && steps < 20) { saveSandbox.beforeStep(); world.step(); acc -= TICK; steps++; }
  }
  renderer.draw(view, dt * speed, world.phase === 'run' && speed > 0);
  uiAcc += dt;
  if (uiAcc > 0.1) {
    uiAcc = 0;
    refreshHud(); refreshPalette(); refreshInspector(); refreshAdvisor(); refreshLog(); refreshQuickstart(); refreshCharts();
    setPlacingHint(view.placing?.kind ?? null);
    saveSandbox.afterUi();
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());
buildPalette();
// component guide (guideview.ts): palette hover cards, "How it works" modal, lesson diagrams
let guidePrevSpeed = 0;
initGuide({
  unlocked: (f) => world.unlocked(f),
  onModal: (open) => { if (open) { guidePrevSpeed = speed; if (world.phase === 'run') setSpeed(0); } else if (world.phase === 'run' && guidePrevSpeed) setSpeed(guidePrevSpeed); },
});
wireWorld();
if (import.meta.env.DEV) Object.assign(window, { game: () => world });
renderer.resize();
maybeShowLesson();
// save/resume + sandbox (persist.ts, sandbox.ts, menu.ts)
const saveSandbox = installSaveAndSandbox({
  getWorld: () => world, getRenderer: () => renderer, reset, lessonsSeen, quick, modal, toast,
  adopt: (w) => { world = w; renderer = new Renderer(canvas, world); renderer.resize(); selectOnly(null); view.placing = view.linking = null; wireWorld(); inspectorHtml = advisorHtml = ''; },
});
requestAnimationFrame(frame);
