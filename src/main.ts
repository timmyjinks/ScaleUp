import './style.css';
import { CACHE_STRATEGIES, GEO, PALETTE_ORDER, RESIZE_S, SLA, SPECS, TICK, UNLOCKS, USERS_PER_RPS, waveRps } from './config';
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
const view: ViewState = { selectedNode: null, selectedEdge: null, hoverNode: null, hoverEdge: null, linking: null, placing: null };
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
  view.placing = { kind, x: -9999, y: -9999, ok: world.money >= SPECS[kind].tiers[0].cost };
}

// ------------------------------------------------------------------ input

let drag: { kind: 'pan' | 'node'; sx: number; sy: number; cx: number; cy: number; id?: number; ox?: number; oy?: number; moved?: boolean } | null = null;

function local(e: PointerEvent | WheelEvent) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  const { sx, sy } = local(e);
  const p = renderer.toWorld(sx, sy);
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2) { drag = { kind: 'pan', sx, sy, cx: renderer.cam.x, cy: renderer.cam.y }; return; }

  if (view.placing) {
    const kind = view.placing.kind;
    const r = world.addNode(kind, Math.round((p.x - NODE_W / 2) / 12) * 12, Math.round((p.y - NODE_H / 2) / 12) * 12);
    if (typeof r === 'string') toast(r);
    else {
      view.selectedNode = r.id; view.selectedEdge = null;
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
    view.selectedNode = n.id; view.selectedEdge = null;
    // bring to front
    world.nodes = [...world.nodes.filter((x) => x !== n), n];
    drag = { kind: 'node', sx, sy, cx: 0, cy: 0, id: n.id, ox: p.x - n.x, oy: p.y - n.y };
    return;
  }
  const ed = renderer.edgeAt(p.x, p.y);
  if (ed) { view.selectedEdge = ed.id; view.selectedNode = null; return; }
  view.selectedNode = null; view.selectedEdge = null;
  drag = { kind: 'pan', sx, sy, cx: renderer.cam.x, cy: renderer.cam.y };
});

canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = local(e);
  const p = renderer.toWorld(sx, sy);
  if (view.placing) {
    view.placing.x = p.x; view.placing.y = p.y;
    view.placing.ok = world.money >= SPECS[view.placing.kind].tiers[0].cost;
  }
  if (view.linking) {
    view.linking.x = p.x; view.linking.y = p.y;
    const t = renderer.nodeAt(p.x, p.y);
    const a = world.node(view.linking.from);
    view.linking.valid = t && a ? world.canConnect(a, t) === null : null;
  }
  if (drag?.kind === 'pan') {
    renderer.cam.x = drag.cx - (sx - drag.sx) / renderer.cam.z;
    renderer.cam.y = drag.cy - (sy - drag.sy) / renderer.cam.z;
  } else if (drag?.kind === 'node') {
    const n = world.node(drag.id!);
    if (n) { n.x = Math.round((p.x - drag.ox!) / 12) * 12; n.y = Math.round((p.y - drag.oy!) / 12) * 12; }
  }
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
    if (a && t && t.id !== a.id) {
      const err = world.connect(a, t);
      if (err) toast(err);
      else {
        if (a.kind === 'users' && (t.kind === 'server' || t.kind === 'loadbalancer')) quick.add('users-link');
        if (a.kind === 'server' && t.kind === 'database') quick.add('db-link');
      }
    }
    view.linking = null;
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
  const sel = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  if (e.key === 'Escape') { view.placing = null; view.linking = null; view.selectedNode = null; view.selectedEdge = null; }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (sel && sel.kind !== 'users') { world.removeNode(sel.id); view.selectedNode = null; }
    else if (view.selectedEdge != null) { world.removeEdge(view.selectedEdge); view.selectedEdge = null; }
  } else if (e.key === 'u' || e.key === 'U') { if (sel) doUpgrade(sel); }
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
    !running ? '' : m.errorRate > SLA.errorRate ? 'bad' : m.errorRate > SLA.errorRate / 3 ? 'warn' : 'good');
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
  if (n.kind === 'database' || n.kind === 'replica') return `<div class="settings"><label>Connection pooler (RDS Proxy / PgBouncer)</label>
      <div class="seg">${opt('pooler', '0', 'Off', !n.pooler)}${opt('pooler', '1', `On · ${money(11 * Math.max(2, SPECS[n.kind].tiers[n.tier].vcpu))}/mo`, n.pooler)}</div>
      <p>Each app process keeps its own pool of DB connections, and every Postgres connection is a process using ~8 MB. A pooler multiplexes thousands of client connections onto a few hundred real ones.</p></div>`;
  return '';
}

let inspectorHtml = '';
function refreshInspector() {
  const el = $('#inspector');
  let html = '';
  const n = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  const e = view.selectedEdge != null ? world.edges.find((x) => x.id === view.selectedEdge) : undefined;
  if (n) {
    const spec = SPECS[n.kind];
    const st = n.stats;
    const tier = spec.tiers[n.tier];
    const up = world.upgradeCost(n);
    const isUsers = n.kind === 'users';
    const running = world.phase === 'run';
    const restart = running && RESIZE_S[n.kind] > 0 ? ` (restarts ~${RESIZE_S[n.kind]}s)` : '';
    const cell = (k: string, v: string, bad?: boolean) => `<div><label>${k}</label><span style="color:${bad ? 'var(--bad)' : 'inherit'}">${v}</span></div>`;
    const cost = world.phase === 'run' ? st.cost : tier.cost + world.poolerCost(n);
    html = `
      <div class="head"><span class="ico" style="background:${spec.color}" data-icon="${n.kind}"></span>
        <div><b>${spec.label} <span style="color:var(--muted);font-weight:400">#${n.id}</span></b><small>${isUsers ? `${GEO.map((g) => `${Math.round(g.share * 100)}% at ${g.rtt}ms`).join(' · ')}` : `${tier.name} · ${specLine(tier) || 'managed'} · ${money(cost)}/mo`}</small></div></div>
      ${st.note ? `<div class="note">⚠ ${st.note}</div>` : ''}
      <div class="grid">
        ${cell('In', `${fmt(st.inRps)}/s`)}
        ${isUsers ? cell('Online', fmt(world.metrics.demand * USERS_PER_RPS)) : `${cell('Capacity', `${fmt(tier.cap)} ${spec.unit}`)}
        ${cell('Load', `${Math.round(st.util * 100)}%`, st.util > 1)}
        ${cell('Latency', ms(st.latency))}
        ${cell('Dropped', `${fmt(st.dropRps)}/s`, st.dropRps > 0.5)}
        ${st.rows.map(([k, v, bad]) => cell(k, v, bad)).join('')}`}
      </div>
      ${st.ramWhy ? `<p class="why"><b>RAM:</b> ${st.ramWhy}</p>` : ''}
      ${settingsHtml(n)}
      <p>${spec.blurb}</p>
      <div class="connects"><b>How to wire:</b> ${spec.wiring}</div>
      ${guideButtonHtml(n.kind)}
      ${isUsers ? '' : `
      <table class="tiers">${spec.tiers.map((t, i) => `<tr class="${i === n.tier ? 'cur' : ''}" ${i === n.tier ? '' : `data-act="tier" data-v="${i}" title="Resize to ${t.name}${restart}"`}><td>${i === n.tier ? '▸' : ' '}</td><td>${t.name}</td><td>${t.vcpu ? `${t.vcpu}c/${t.ram}G` : ''}</td><td>${fmt(t.cap)}</td><td>${money(t.cost)}${t.perM ? '+' : ''}</td></tr>`).join('')}</table>
      <div class="row">
        <button class="btn" data-act="upgrade" ${up === null || !world.unlocked('upgrade') ? 'disabled' : ''}>${up === null ? 'Max size' : !world.unlocked('upgrade') ? `Upgrade 🔒 w${UNLOCKS.upgrade}` : `Upgrade · ${money(up)}${restart}`}</button>
        <button class="btn danger" data-act="sell">Sell · ${money(world.sellValue(n))}</button>
      </div>`}`;
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
$('#inspector').addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  const act = t?.dataset.act, v = t?.dataset.v ?? '';
  const n = view.selectedNode != null ? world.node(view.selectedNode) : undefined;
  if (act === 'upgrade' && n) doUpgrade(n);
  if (act === 'tier' && n) { const err = world.resize(n, Number(v)); if (err) toast(err); }
  if (act === 'strategy' && n) world.setStrategy(n, v as CacheStrategy);
  if (act === 'cdnapi' && n) world.setCdnApi(n, v === '1');
  if (act === 'pooler' && n) world.setPooler(n, v === '1');
  if (act === 'sell' && n) { world.removeNode(n.id); view.selectedNode = null; }
  if (act === 'unlink' && view.selectedEdge != null) { world.removeEdge(view.selectedEdge); view.selectedEdge = null; }
  inspectorHtml = '';
});

// ------------------------------------------------------------------ advisor / log / quickstart

let advisorHtml = '';
function refreshAdvisor() {
  const html = advise(world).map((h) => `<li class="${h.level}" ${h.node ? `data-node="${h.node}"` : ''}>${h.text}</li>`).join('');
  if (html !== advisorHtml) { advisorHtml = html; $('#advisor ul').innerHTML = html; }
}
$('#advisor').addEventListener('click', (ev) => {
  const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-node]')?.dataset.node;
  if (id) { view.selectedNode = Number(id); view.selectedEdge = null; }
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
    const label = t === 'upgrade' ? 'Upgrade (vertical scaling)' : t === 'sharding' ? 'Multiple primaries (sharding)' : SPECS[t].label;
    const color = t === 'upgrade' ? '#7c9cff' : t === 'sharding' ? SPECS.database.color : SPECS[t].color;
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
  view.selectedNode = view.selectedEdge = null;
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
  adopt: (w) => { world = w; renderer = new Renderer(canvas, world); renderer.resize(); view.selectedNode = view.selectedEdge = null; view.placing = view.linking = null; wireWorld(); inspectorHtml = advisorHtml = ''; },
});
requestAnimationFrame(frame);
