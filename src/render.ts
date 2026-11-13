import { SPECS, USERS_PER_RPS } from './config';
import { fmt, total, type World } from './sim';
import type { Edge, Mix, NodeKind, SimNode } from './types';

export const NODE_W = 150;
export const NODE_H = 64;
export const PORT_R = 7;

export const CLASS_COLORS: Record<keyof Mix, string> = { s: '#94a3b8', r: '#60a5fa', w: '#fb923c', b: '#f43f5e' };

export interface Camera { x: number; y: number; z: number }

interface Particle { edge: number; t: number; speed: number; color: string }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }

export interface ViewState {
  selectedNode: number | null;
  selectedEdge: number | null;
  hoverNode: number | null;
  hoverEdge: number | null;
  /** in-progress connection drag */
  linking: { from: number; x: number; y: number; valid: boolean | null } | null;
  /** ghost of a node being placed */
  placing: { kind: NodeKind; x: number; y: number; ok: boolean } | null;
}

export class Renderer {
  cam: Camera = { x: -300, y: -60, z: 1 };
  private particles: Particle[] = [];
  private sparks: Spark[] = [];
  private spawnAcc = new Map<number, number>();
  private sparkAcc = new Map<number, number>();
  private dpr = 1;
  private time = 0;

  constructor(private canvas: HTMLCanvasElement, private world: World) {}

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  toWorld(sx: number, sy: number) { return { x: sx / this.cam.z + this.cam.x, y: sy / this.cam.z + this.cam.y }; }
  toScreen(wx: number, wy: number) { return { x: (wx - this.cam.x) * this.cam.z, y: (wy - this.cam.y) * this.cam.z }; }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.cam.z = Math.min(2.5, Math.max(0.25, this.cam.z * factor));
    const after = this.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  /** Fit all nodes in view. */
  fit() {
    const ns = this.world.nodes;
    if (!ns.length) return;
    const full = this.canvas.getBoundingClientRect();
    // leave room for the HUD, palette, side panel and charts
    const inset = { l: 230, r: 330, t: 90, b: 150 };
    const r = { width: full.width - inset.l - inset.r, height: full.height - inset.t - inset.b };
    const minX = Math.min(...ns.map((n) => n.x)) - 80, maxX = Math.max(...ns.map((n) => n.x + NODE_W)) + 80;
    const minY = Math.min(...ns.map((n) => n.y)) - 80, maxY = Math.max(...ns.map((n) => n.y + NODE_H)) + 80;
    this.cam.z = Math.min(1.4, Math.max(0.25, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    this.cam.x = (minX + maxX) / 2 - (inset.l + r.width / 2) / this.cam.z;
    this.cam.y = (minY + maxY) / 2 - (inset.t + r.height / 2) / this.cam.z;
  }

  // --------------------------------------------------------------- hit tests

  nodeAt(wx: number, wy: number): SimNode | null {
    for (let i = this.world.nodes.length - 1; i >= 0; i--) {
      const n = this.world.nodes[i];
      if (wx >= n.x && wx <= n.x + NODE_W && wy >= n.y && wy <= n.y + NODE_H) return n;
    }
    return null;
  }

  portAt(wx: number, wy: number): SimNode | null {
    for (const n of this.world.nodes) {
      if (!SPECS[n.kind].canConnectTo.length) continue;
      const p = outPort(n);
      if (Math.hypot(wx - p.x, wy - p.y) <= PORT_R + 6 / this.cam.z) return n;
    }
    return null;
  }

  edgeAt(wx: number, wy: number): Edge | null {
    const tol = 7 / this.cam.z;
    for (const e of this.world.edges) {
      const c = this.curve(e);
      if (!c) continue;
      for (let i = 0; i <= 24; i++) {
        const p = bez(c, i / 24);
        if (Math.hypot(p.x - wx, p.y - wy) < tol) return e;
      }
    }
    return null;
  }

  private curve(e: Edge) {
    const a = this.world.node(e.from), b = this.world.node(e.to);
    if (!a || !b) return null;
    return link(outPort(a), inPort(b));
  }

  // --------------------------------------------------------------- frame

  draw(view: ViewState, dt: number, running: boolean) {
    this.time += dt;
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = col('--canvas');
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(this.dpr * this.cam.z, 0, 0, this.dpr * this.cam.z, -this.cam.x * this.cam.z * this.dpr, -this.cam.y * this.cam.z * this.dpr);

    this.drawGrid(ctx, W, H, col('--grid'));
    if (running) this.updateParticles(dt);

    // edges
    for (const e of this.world.edges) this.drawEdge(ctx, e, view, col);
    // particles
    for (const p of this.particles) {
      const e = this.world.edges.find((x) => x.id === p.edge);
      const c = e && this.curve(e);
      if (!c) continue;
      const pt = bez(c, p.t);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // linking preview
    if (view.linking) {
      const a = this.world.node(view.linking.from);
      if (a) {
        const c = link(outPort(a), { x: view.linking.x, y: view.linking.y });
        ctx.strokeStyle = view.linking.valid === false ? '#f43f5e' : view.linking.valid ? '#22c55e' : col('--muted');
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2;
        strokeCurve(ctx, c);
        ctx.setLineDash([]);
      }
    }
    // nodes
    for (const n of this.world.nodes) this.drawNode(ctx, n, view, col);
    // sparks (dropped requests)
    for (const s of this.sparks) {
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    // placement ghost
    if (view.placing) {
      const { kind, x, y, ok } = view.placing;
      ctx.globalAlpha = 0.55;
      this.drawCard(ctx, kind, x - NODE_W / 2, y - NODE_H / 2, SPECS[kind].label, SPECS[kind].tiers[0].name, col, ok ? SPECS[kind].color : '#f43f5e');
      ctx.globalAlpha = 1;
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, color: string) {
    const step = 24;
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(W / this.dpr, H / this.dpr);
    if (this.cam.z < 0.4) return;
    ctx.fillStyle = color;
    const r = 1.1 / this.cam.z;
    for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step)
      for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  }

  private drawEdge(ctx: CanvasRenderingContext2D, e: Edge, view: ViewState, col: (v: string) => string) {
    const c = this.curve(e);
    if (!c) return;
    const rps = total(e.rps);
    const sel = view.selectedEdge === e.id, hov = view.hoverEdge === e.id;
    ctx.strokeStyle = sel ? col('--accent') : hov ? col('--text') : col('--edge');
    ctx.lineWidth = 1.5 + Math.min(6, Math.log10(1 + rps) * 1.3) + (sel ? 1 : 0);
    strokeCurve(ctx, c);
    // arrow head
    const p = bez(c, 1), q = bez(c, 0.97);
    const ang = Math.atan2(p.y - q.y, p.x - q.x);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - 10 * Math.cos(ang - 0.4), p.y - 10 * Math.sin(ang - 0.4));
    ctx.lineTo(p.x - 10 * Math.cos(ang + 0.4), p.y - 10 * Math.sin(ang + 0.4));
    ctx.fill();
    if (rps > 0.5 && (sel || hov || this.world.edges.length <= 12)) {
      const m = bez(c, 0.5);
      const label = `${fmt(rps)}/s`;
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = col('--canvas');
      roundRect(ctx, m.x - w / 2, m.y - 9, w, 18, 9);
      ctx.fill();
      ctx.fillStyle = col('--muted');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, m.x, m.y + 0.5);
    }
  }

  private drawCard(ctx: CanvasRenderingContext2D, kind: NodeKind, x: number, y: number, title: string, sub: string, col: (v: string) => string, border: string) {
    const spec = SPECS[kind];
    ctx.fillStyle = col('--node');
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, NODE_W, NODE_H, 10);
    ctx.fill();
    ctx.stroke();
    // icon tile
    ctx.fillStyle = spec.color;
    roundRect(ctx, x + 8, y + 8, 34, 34, 8);
    ctx.fill();
    drawIcon(ctx, kind, x + 25, y + 25);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = col('--text');
    ctx.font = '600 13px Inter, system-ui, sans-serif';
    ctx.fillText(title, x + 50, y + 23);
    ctx.fillStyle = col('--muted');
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillText(sub, x + 50, y + 39);
  }

  private drawNode(ctx: CanvasRenderingContext2D, n: SimNode, view: ViewState, col: (v: string) => string) {
    const spec = SPECS[n.kind];
    const st = n.stats;
    const down = n.downFor > 0;
    const hot = st.util > 1 || st.dropRps > 0.5;
    const sel = view.selectedNode === n.id;

    if (hot && !down) {
      ctx.shadowColor = '#f43f5e';
      ctx.shadowBlur = 12 + 8 * Math.sin(this.time * 8);
    }
    const sub = n.kind === 'users' ? `${fmt(this.world.metrics.demand * USERS_PER_RPS)} online` : n.kind === 'cache' && n.strategy !== 'aside' ? `${spec.tiers[n.tier].name} · ${n.strategy}` : spec.tiers.length > 4 || spec.tiers[n.tier].name.length > 14 ? spec.tiers[n.tier].name : `${spec.tiers[n.tier].name} · ${tierPips(n.tier, spec.tiers.length)}`;
    const title = n.kind === 'users' ? 'Users' : `${spec.label}`;
    this.drawCard(ctx, n.kind, n.x, n.y, title, sub, col, sel ? col('--accent') : view.hoverNode === n.id ? col('--text') : col('--node-border'));
    ctx.shadowBlur = 0;

    // utilization bar
    if (n.kind !== 'users') {
      const u = Math.min(1, st.util);
      const bx = n.x + 8, by = n.y + NODE_H - 13, bw = NODE_W - 16;
      ctx.fillStyle = col('--bar-bg');
      roundRect(ctx, bx, by, bw, 5, 2.5);
      ctx.fill();
      ctx.fillStyle = st.util > 1 ? '#f43f5e' : st.util > 0.8 ? '#f59e0b' : '#22c55e';
      if (u > 0) { roundRect(ctx, bx, by, Math.max(5, bw * u), 5, 2.5); ctx.fill(); }
      // backlog indicator
      if (n.kind === 'queue' && n.backlog > 1) {
        ctx.fillStyle = col('--muted');
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${fmt(n.backlog)} queued`, n.x + NODE_W - 8, n.y + 14);
      } else if (st.inRps > 0.5) {
        ctx.fillStyle = col('--muted');
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(st.util * 100)}%`, n.x + NODE_W - 8, n.y + 14);
      }
    }

    if (down) {
      ctx.fillStyle = 'rgba(15,17,23,0.72)';
      roundRect(ctx, n.x, n.y, NODE_W, NODE_H, 10);
      ctx.fill();
      ctx.fillStyle = '#f43f5e';
      ctx.font = '700 14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`DOWN · ${Math.ceil(n.downFor)}s`, n.x + NODE_W / 2, n.y + NODE_H / 2);
    }

    // note
    if (st.note && !down) {
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = st.dropRps > 0.5 ? '#f87171' : '#fbbf24';
      ctx.fillText(st.note, n.x + NODE_W / 2, n.y + NODE_H + 6);
    }

    // ports
    if (spec.canConnectTo.length) {
      const p = outPort(n);
      const active = view.hoverNode === n.id || sel || view.linking?.from === n.id;
      ctx.fillStyle = active ? col('--accent') : col('--node');
      ctx.strokeStyle = active ? col('--accent') : col('--node-border');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? PORT_R : PORT_R - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private updateParticles(dt: number) {
    const MAX = 2500;
    for (const e of this.world.edges) {
      const rps = total(e.rps);
      if (rps < 0.05) continue;
      const rate = Math.min(30, 1 + Math.log2(1 + rps) * 2.2); // dots/sec ~ log(traffic)
      const acc = (this.spawnAcc.get(e.id) ?? Math.random()) + rate * dt;
      let k = Math.floor(acc);
      this.spawnAcc.set(e.id, acc - k);
      const c = this.curve(e);
      if (!c) continue;
      const len = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) + 40;
      while (k-- > 0 && this.particles.length < MAX)
        this.particles.push({ edge: e.id, t: 0, speed: 260 / len, color: pickColor(e.rps) });
    }
    for (const p of this.particles) p.t += p.speed * dt;
    this.particles = this.particles.filter((p) => p.t < 1 && this.world.edges.some((e) => e.id === p.edge));

    // dropped traffic sparks
    for (const n of this.world.nodes) {
      const d = n.stats.dropRps;
      if (d < 0.2) continue;
      const rate = Math.min(40, 2 + Math.log2(1 + d) * 3);
      const acc = (this.sparkAcc.get(n.id) ?? 0) + rate * dt;
      let k = Math.floor(acc);
      this.sparkAcc.set(n.id, acc - k);
      while (k-- > 0 && this.sparks.length < 600)
        this.sparks.push({ x: n.x + Math.random() * NODE_W, y: n.y + NODE_H, vx: (Math.random() - 0.5) * 60, vy: 20 + Math.random() * 40, life: 1 });
    }
    for (const s of this.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 260 * dt; s.life -= dt * 1.2; }
    this.sparks = this.sparks.filter((s) => s.life > 0);
  }
}

// --------------------------------------------------------------- geometry helpers

type P = { x: number; y: number };
export const outPort = (n: SimNode): P => ({ x: n.x + NODE_W, y: n.y + NODE_H / 2 });
export const inPort = (n: SimNode): P => ({ x: n.x, y: n.y + NODE_H / 2 });

function link(a: P, b: P): [P, P, P, P] {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

function bez(c: [P, P, P, P], t: number): P {
  const u = 1 - t;
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  };
}

function strokeCurve(ctx: CanvasRenderingContext2D, c: [P, P, P, P]) {
  ctx.beginPath();
  ctx.moveTo(c[0].x, c[0].y);
  ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pickColor(m: Mix): string {
  const t = total(m);
  let r = Math.random() * t;
  for (const k of ['s', 'r', 'w', 'b'] as const) { r -= m[k]; if (r <= 0) return CLASS_COLORS[k]; }
  return CLASS_COLORS.r;
}

function tierPips(tier: number, of: number) {
  return '●'.repeat(tier + 1) + '○'.repeat(of - tier - 1);
}

/** Tiny vector icons drawn in white inside the colored tile. */
export function drawIcon(ctx: CanvasRenderingContext2D, kind: NodeKind, cx: number, cy: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const line = (pts: number[]) => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.stroke(); };
  switch (kind) {
    case 'users':
      ctx.beginPath(); ctx.arc(-4, -4, 3.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(5, -3, 3, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(-4, 8, 7, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(5, 8, 6, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      break;
    case 'server':
      for (const y of [-8, -1, 6]) { ctx.strokeRect(-8, y, 16, 5); ctx.fillRect(4, y + 2, 2, 1.5); }
      break;
    case 'database':
    case 'replica':
      ctx.beginPath(); ctx.ellipse(0, -7, 8, 3, 0, 0, Math.PI * 2); ctx.stroke();
      line([-8, -7, -8, 7]); line([8, -7, 8, 7]);
      ctx.beginPath(); ctx.ellipse(0, 7, 8, 3, 0, 0, Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 3, 0, 0, Math.PI); ctx.stroke();
      if (kind === 'replica') { ctx.font = '700 8px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('R', 0, 3); }
      break;
    case 'loadbalancer':
      line([-9, 0, -2, 0]); line([-2, 0, 8, -7]); line([-2, 0, 8, 0]); line([-2, 0, 8, 7]);
      ctx.beginPath(); ctx.arc(-2, 0, 2, 0, Math.PI * 2); ctx.fill();
      break;
    case 'cache':
      ctx.beginPath(); ctx.moveTo(2, -10); ctx.lineTo(-6, 2); ctx.lineTo(0, 2); ctx.lineTo(-2, 10); ctx.lineTo(6, -2); ctx.lineTo(0, -2); ctx.closePath(); ctx.fill();
      break;
    case 'cdn':
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, 4, 9, 0, 0, Math.PI * 2); ctx.stroke();
      line([-9, 0, 9, 0]);
      break;
    case 'queue':
      for (const x of [-8, -3, 2]) ctx.fillRect(x, -5, 3.5, 10);
      line([6, -4, 10, 0, 6, 4]);
      break;
    case 'worker':
      ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; line([Math.cos(a) * 6, Math.sin(a) * 6, Math.cos(a) * 9, Math.sin(a) * 9]); }
      break;
    case 'ratelimiter':
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(8, -6); ctx.lineTo(7, 3); ctx.lineTo(0, 10); ctx.lineTo(-7, 3); ctx.lineTo(-8, -6); ctx.closePath(); ctx.stroke();
      line([-3, 0, -0.5, 3, 4, -3]);
      break;
  }
  ctx.restore();
}
