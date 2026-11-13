/**
 * Tiny scripted scene engine for the component guide ("tip-and-trick" style mini diagrams).
 *
 * A Scene is a static topology (nodes, edges, zones) plus a timeline: dots travelling along
 * node paths, badges flashing over nodes ("HIT", "429"...), nodes going down, bars and
 * stacks that change over time, and captions. Everything is a pure function of the scene
 * clock `t`, so a scene loops by just wrapping `t` back to 0.
 *
 * MiniDiagram mounts a scene into a small canvas + caption and animates it with one shared
 * requestAnimationFrame loop that only runs while some diagram is actually on screen.
 */
import { SPECS } from './config';
import { CLASS_COLORS, drawIcon } from './render';
import type { NodeKind } from './types';

/** Logical scene size. Diagrams are scaled to fit their container width. */
export const SCENE_W = 360;
export const SCENE_H = 200;

export const C = {
  static: CLASS_COLORS.s,
  read: CLASS_COLORS.r,
  write: CLASS_COLORS.w,
  bot: CLASS_COLORS.b,
  ok: '#22c55e',
  copy: '#c084fc',
  warn: '#f59e0b',
  bad: '#f43f5e',
  muted: '#8a93a6',
};

const TILE = 28;
const SPEED = 130; // px per second

interface SNode { id: string; icon: NodeKind; x: number; y: number; label: string; color: string; sub?: string }
interface SEdge { a: string; b: string; dashed?: boolean; color?: string; label?: string; labelColor?: string; arrow?: boolean }
interface SDot { path: string[]; t0: number; dur: number; color: string; r: number; label?: string; lane: number }
interface SBadge { node: string; t0: number; t1: number; text: string; color: string; side: 'top' | 'left' }
interface SSpan { node: string; t0: number; t1: number; color: string }
interface SLive { node: string; fn: (t: number) => string | null; color: string }
interface SBar { node: string; keys: [number, number][] }
interface SStack { node: string; ins: number[]; outs: number[]; color: string }
interface SZone { x: number; y: number; w: number; h: number; label: string; color: string }
interface SCap { t: number; text: string }

export interface DotOpts { speed?: number; r?: number; label?: string; heavy?: boolean; /** sideways offset in px, to separate return traffic */ lane?: number }

export class Scene {
  nodes = new Map<string, SNode>();
  edges: SEdge[] = [];
  dots: SDot[] = [];
  badges: SBadge[] = [];
  downs: SSpan[] = [];
  glows: SSpan[] = [];
  lives: SLive[] = [];
  bars: SBar[] = [];
  stacks: SStack[] = [];
  zones: SZone[] = [];
  caps: SCap[] = [];
  length = 6;

  node(id: string, icon: NodeKind, x: number, y: number, label: string, opts: { color?: string; sub?: string } = {}) {
    this.nodes.set(id, { id, icon, x, y, label, color: opts.color ?? SPECS[icon].color, sub: opts.sub });
    return this;
  }
  edge(a: string, b: string, opts: Omit<SEdge, 'a' | 'b'> = {}) { this.edges.push({ a, b, arrow: true, ...opts }); return this; }
  zone(x: number, y: number, w: number, h: number, label: string, color = '#3b4357') { this.zones.push({ x, y, w, h, label, color }); return this; }

  /** A request dot travelling along `path` (node ids) starting at t0. Returns its arrival time. */
  send(path: string[], t0: number, color: string, opts: DotOpts = {}): number {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const a = this.nodes.get(path[i - 1])!, b = this.nodes.get(path[i])!;
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const speed = opts.speed ?? (opts.heavy ? SPEED * 0.55 : SPEED);
    const dur = len / speed;
    this.dots.push({ path, t0, dur, color, r: opts.r ?? (opts.heavy ? 5.5 : 3.6), label: opts.label, lane: opts.lane ?? 0 });
    return t0 + dur;
  }
  badge(node: string, t: number, text: string, color: string, dur = 1.2, side: 'top' | 'left' = 'top') { this.badges.push({ node, t0: t, t1: t + dur, text, color, side }); return this; }
  down(node: string, t0: number, t1: number) { this.downs.push({ node, t0, t1, color: C.bad }); return this; }
  glow(node: string, t0: number, t1: number, color = '#ffffff') { this.glows.push({ node, t0, t1, color }); return this; }
  /** A small dynamic text line under a node's label. Return null to hide it. */
  live(node: string, fn: (t: number) => string | null, color = C.muted) { this.lives.push({ node, fn, color }); return this; }
  /** Utilization bar under a node, piecewise linear over [t, value 0..1] keyframes. */
  bar(node: string, keys: [number, number][]) { this.bars.push({ node, keys }); return this; }
  /** A visual backlog of items next to a node (count = arrivals - departures so far). */
  stack(node: string, ins: number[], outs: number[], color = C.write) { this.stacks.push({ node, ins, outs, color }); return this; }
  cap(t: number, text: string) { this.caps.push({ t, text }); this.caps.sort((a, b) => a.t - b.t); return this; }
  end(t: number) { this.length = t; return this; }

  caption(t: number): { index: number; text: string } {
    let index = 0;
    for (let i = 0; i < this.caps.length; i++) if (this.caps[i].t <= t) index = i;
    return { index, text: this.caps[index]?.text ?? '' };
  }

  isDown(id: string, t: number) { return this.downs.some((d) => d.node === id && t >= d.t0 && t < d.t1); }
}

// ------------------------------------------------------------------ drawing

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => v * v * (3 - 2 * v);

function interp(keys: [number, number][], t: number) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return v0 + (v1 - v0) * ease((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

/** Point where the segment a→b leaves a's tile (so arrows don't overlap the icons). */
function trim(ax: number, ay: number, bx: number, by: number, pad: number) {
  const d = Math.hypot(bx - ax, by - ay) || 1;
  return { x: ax + ((bx - ax) / d) * pad, y: ay + ((by - ay) / d) * pad };
}

function pill(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string, fg: string, bg: string, font = '600 9.5px Inter, system-ui, sans-serif') {
  ctx.font = font;
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - 7.5, w, 15, 7.5);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.5);
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene, t: number) {
  ctx.clearRect(0, 0, SCENE_W, SCENE_H);
  // background grid
  ctx.fillStyle = '#1d2230';
  for (let x = 12; x < SCENE_W; x += 16) for (let y = 12; y < SCENE_H; y += 16) ctx.fillRect(x - 0.5, y - 0.5, 1, 1);

  // zones (regions / data centers)
  for (const z of s.zones) {
    ctx.strokeStyle = z.color;
    ctx.fillStyle = 'rgba(124,156,255,0.035)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(z.x, z.y, z.w, z.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8a93a6';
    ctx.font = '600 8.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(z.label.toUpperCase(), z.x + 6, z.y + 5);
  }

  // edges
  for (const e of s.edges) {
    const a = s.nodes.get(e.a)!, b = s.nodes.get(e.b)!;
    const dead = s.isDown(e.a, t) || s.isDown(e.b, t);
    const p = trim(a.x, a.y, b.x, b.y, TILE / 2 + 4), q = trim(b.x, b.y, a.x, a.y, TILE / 2 + 5);
    ctx.strokeStyle = dead ? 'rgba(244,63,94,0.35)' : e.color ?? '#3b4357';
    ctx.lineWidth = 1.6;
    if (e.dashed || dead) { ctx.setLineDash([4, 4]); ctx.lineDashOffset = e.dashed && !dead ? -t * 14 : 0; }
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    ctx.setLineDash([]);
    if (e.arrow) {
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - 7 * Math.cos(ang - 0.45), q.y - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(q.x - 7 * Math.cos(ang + 0.45), q.y - 7 * Math.sin(ang + 0.45));
      ctx.fill();
    }
    if (e.label) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      pill(ctx, mx, my, e.label, e.labelColor ?? e.color ?? '#8a93a6', '#0f1117', '500 8.5px JetBrains Mono, monospace');
    }
  }

  // dots (drawn under nodes, so they disappear "into" a component)
  const dotLabels: { x: number; y: number; text: string; color: string }[] = [];
  for (const d of s.dots) {
    if (t < d.t0 || t > d.t0 + d.dur) continue;
    const pos = pointOnPath(s, d.path, (t - d.t0) / d.dur, d.lane);
    ctx.shadowColor = d.color;
    ctx.shadowBlur = 8;
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, d.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (d.label) dotLabels.push({ x: pos.x, y: pos.y - d.r - 7, text: d.label, color: d.color });
  }

  // nodes
  for (const n of s.nodes.values()) {
    const down = s.isDown(n.id, t);
    const glow = s.glows.find((g) => g.node === n.id && t >= g.t0 && t < g.t1);
    const x = n.x - TILE / 2, y = n.y - TILE / 2;
    if (glow) {
      const k = Math.sin(clamp01((t - glow.t0) / (glow.t1 - glow.t0)) * Math.PI);
      ctx.shadowColor = glow.color;
      ctx.shadowBlur = 14 * k;
    }
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.roundRect(x, y, TILE, TILE, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.scale(TILE / 34, TILE / 34);
    drawIcon(ctx, n.icon, 0, 0);
    ctx.restore();
    if (down) {
      ctx.fillStyle = 'rgba(15,17,23,0.7)';
      ctx.beginPath(); ctx.roundRect(x, y, TILE, TILE, 7); ctx.fill();
      ctx.strokeStyle = C.bad;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(n.x - 8, n.y - 8); ctx.lineTo(n.x + 8, n.y + 8);
      ctx.moveTo(n.x + 8, n.y - 8); ctx.lineTo(n.x - 8, n.y + 8);
      ctx.stroke();
    }
    ctx.fillStyle = down ? '#f87171' : '#e6e9f0';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(n.label, n.x, y + TILE + 4);
    let ly = y + TILE + 16;
    if (n.sub) {
      ctx.fillStyle = '#8a93a6';
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillText(n.sub, n.x, ly);
      ly += 11;
    }
    for (const l of s.lives) {
      if (l.node !== n.id) continue;
      const txt = l.fn(t);
      if (!txt) continue;
      ctx.fillStyle = l.color;
      ctx.font = '500 8.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(txt, n.x, ly);
      ly += 11;
    }
  }

  // utilization bars (drawn on the top edge of the tile)
  for (const b of s.bars) {
    const n = s.nodes.get(b.node)!;
    const v = clamp01(interp(b.keys, t));
    const bx = n.x - TILE / 2 - 4, by = n.y - TILE / 2 - 8, bw = TILE + 8;
    ctx.fillStyle = '#2a3040';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, 4, 2); ctx.fill();
    ctx.fillStyle = v > 0.9 ? C.bad : v > 0.7 ? C.warn : C.ok;
    if (v > 0.02) { ctx.beginPath(); ctx.roundRect(bx, by, Math.max(4, bw * v), 4, 2); ctx.fill(); }
  }

  // backlog stacks (little boxes piling up above a node)
  for (const st of s.stacks) {
    const n = s.nodes.get(st.node)!;
    const count = st.ins.filter((x) => x <= t).length - st.outs.filter((x) => x <= t).length;
    for (let i = 0; i < count; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      ctx.fillStyle = st.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.roundRect(n.x - 9 + col * 10, n.y - TILE / 2 - 12 - row * 8, 8, 6, 1.5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const l of dotLabels) pill(ctx, l.x, l.y, l.text, l.color, 'rgba(15,17,23,0.85)', '500 8.5px JetBrains Mono, monospace');

  // badges pop above nodes
  for (const b of s.badges) {
    if (t < b.t0 || t > b.t1) continue;
    const n = s.nodes.get(b.node)!;
    const k = (t - b.t0) / (b.t1 - b.t0);
    const pop = k < 0.15 ? ease(k / 0.15) : 1;
    ctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
    ctx.font = '700 9.5px Inter, system-ui, sans-serif';
    const left = b.side === 'left';
    const cx = left ? n.x - TILE / 2 - 8 - ctx.measureText(b.text).width / 2 - 5 - 4 * pop : n.x;
    const cy = left ? n.y : n.y - TILE / 2 - 12 - 6 * pop;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(0.7 + 0.3 * pop, 0.7 + 0.3 * pop);
    pill(ctx, 0, 0, b.text, '#0b0e16', b.color, '700 9.5px Inter, system-ui, sans-serif');
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

function pointOnPath(s: Scene, path: string[], k: number, lane = 0) {
  const pts = path.map((id) => s.nodes.get(id)!);
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segs.push(l); total += l; }
  let d = clamp01(k) * total;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i] || i === segs.length - 1) {
      const u = segs[i] ? d / segs[i] : 0;
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, l = segs[i] || 1;
      return { x: pts[i].x + dx * u - (dy / l) * lane, y: pts[i].y + dy * u + (dx / l) * lane };
    }
    d -= segs[i];
  }
  return { x: pts[0].x, y: pts[0].y };
}

// ------------------------------------------------------------------ DOM component + shared loop

const live = new Set<MiniDiagram>();
let raf = 0;
let lastNow = 0;

const io = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        const d = (en.target as HTMLElement & { _mini?: MiniDiagram })._mini;
        if (d) d.visible = en.isIntersecting;
      }
      kick();
    })
  : null;

function kick() {
  if (!raf && [...live].some((d) => d.visible)) { lastNow = performance.now(); raf = requestAnimationFrame(loop); }
}

function loop(now: number) {
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  let any = false;
  for (const d of live) {
    if (!d.el.isConnected) { d.destroy(); continue; }
    if (!d.visible || document.hidden) continue;
    any = true;
    d.tick(dt);
  }
  raf = any ? requestAnimationFrame(loop) : 0;
}
document.addEventListener('visibilitychange', kick);

export class MiniDiagram {
  el: HTMLElement;
  visible = false;
  private canvas: HTMLCanvasElement;
  private capEl: HTMLElement;
  private stepsEl: HTMLElement;
  private progEl: HTMLElement;
  private scene: Scene;
  private t = 0;
  private lastCap = -1;

  constructor(scene: Scene) {
    this.scene = scene;
    this.el = document.createElement('div');
    this.el.className = 'mini';
    this.el.innerHTML = `<div class="mini-stage"><canvas></canvas><i class="mini-prog"></i></div><div class="mini-cap"><span class="mini-steps"></span><span class="mini-text"></span></div>`;
    this.canvas = this.el.querySelector('canvas')!;
    this.capEl = this.el.querySelector('.mini-text')!;
    this.stepsEl = this.el.querySelector('.mini-steps')!;
    this.progEl = this.el.querySelector('.mini-prog')!;
    (this.el as HTMLElement & { _mini?: MiniDiagram })._mini = this;
    // click to restart from the top
    this.el.addEventListener('click', () => { this.t = 0; });
    this.el.title = 'Click to replay';
    live.add(this);
    if (io) io.observe(this.el); else this.visible = true;
    requestAnimationFrame(() => { this.draw(); kick(); });
  }

  setScene(scene: Scene) { this.scene = scene; this.t = 0; this.lastCap = -1; this.draw(); }

  tick(dt: number) {
    this.t += dt;
    if (this.t > this.scene.length) this.t = 0;
    this.draw();
  }

  draw() {
    const cw = this.canvas.clientWidth;
    if (!cw) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cw * dpr), ph = Math.round(cw * (SCENE_H / SCENE_W) * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(pw / SCENE_W, 0, 0, ph / SCENE_H, 0, 0);
    drawScene(ctx, this.scene, this.t);
    const cap = this.scene.caption(this.t);
    if (cap.index !== this.lastCap) {
      this.lastCap = cap.index;
      this.capEl.textContent = cap.text;
      this.capEl.classList.remove('in'); void this.capEl.offsetWidth; this.capEl.classList.add('in');
      this.stepsEl.textContent = `${cap.index + 1}/${this.scene.caps.length}`;
    }
    this.progEl.style.width = `${(this.t / this.scene.length) * 100}%`;
  }

  destroy() {
    live.delete(this);
    io?.unobserve(this.el);
  }
}
