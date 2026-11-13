import { SPECS, TICK, TIMEOUT_MS, SLA, START_MONEY, UNLOCKS, makeWave, waveShape } from './config';
import type { Edge, Flow, Metrics, Mix, NodeKind, Phase, SimNode, WaveDef } from './types';

const REVENUE_PER_REQ = 0.05;
const CDN_LATENCY_SAVED = 35;

export const zero = (): Mix => ({ s: 0, r: 0, w: 0, b: 0 });
const add = (a: Mix, b: Mix, k = 1) => { a.s += b.s * k; a.r += b.r * k; a.w += b.w * k; a.b += b.b * k; };
const scale = (m: Mix, k: number): Mix => ({ s: m.s * k, r: m.r * k, w: m.w * k, b: m.b * k });
export const total = (m: Mix) => m.s + m.r + m.w + m.b;
const legit = (m: Mix) => m.s + m.r + m.w;
const pick = (m: Mix, keys: (keyof Mix)[]): Mix => { const o = zero(); for (const k of keys) o[k] = m[k]; return o; };

export interface LogEntry { t: number; text: string; kind: 'info' | 'bad' | 'good' }
export interface Sample { demand: number; success: number; p99: number; err: number }

export class World {
  nodes: SimNode[] = [];
  edges: Edge[] = [];
  private nextId = 1;

  money = START_MONEY;
  reputation = 100;
  waveNum = 1;
  wave: WaveDef = makeWave(1);
  phase: Phase = 'build';
  time = 0; // seconds into current wave
  totalServed = 0;
  bestWave = 0;
  metrics: Metrics = { demand: 0, success: 0, errors: 0, errorRate: 0, p50: 0, p99: 0, botRps: 0, upkeep: 0, revenue: 0 };
  history: Sample[] = [];
  log: LogEntry[] = [];
  /** wave stats for the end-of-wave report */
  waveAgg = { req: 0, ok: 0, earned: 0, worstP99: 0 };
  onWaveEnd?: (report: { wave: number; served: number; okRate: number; earned: number; bonus: number; worstP99: number }) => void;
  onGameOver?: () => void;

  private sampleAcc = 0;
  private asyncRejected = 0;

  constructor() {
    this.addNode('users', 80, 300, true);
  }

  // ---------------------------------------------------------------- building

  unlocked(feature: string) { return this.waveNum >= (UNLOCKS[feature] ?? 1); }

  node(id: number) { return this.nodes.find((n) => n.id === id); }

  addNode(kind: NodeKind, x: number, y: number, free = false): SimNode | string {
    if (!free) {
      if (!this.unlocked(kind)) return `${SPECS[kind].label} unlocks at wave ${UNLOCKS[kind]}`;
      if (kind === 'database' && !this.unlocked('sharding') && this.nodes.some((n) => n.kind === 'database'))
        return `Only one primary database until sharding unlocks (wave ${UNLOCKS.sharding}). Try making it bigger, or use a cache or replicas instead.`;
      const cost = SPECS[kind].tiers[0].cost;
      if (this.money < cost) return `Need $${cost}`;
      this.money -= cost;
    }
    const n: SimNode = {
      id: this.nextId++, kind, x, y, tier: 0, backlog: 0, downFor: 0, warm: 0, retry: 0,
      stats: { inRps: 0, servedRps: 0, dropRps: 0, util: 0, latency: 0, hitRate: 0, note: '' },
    };
    this.nodes.push(n);
    return n;
  }

  upgradeCost(n: SimNode): number | null {
    const tiers = SPECS[n.kind].tiers;
    if (n.tier >= tiers.length - 1) return null;
    return tiers[n.tier + 1].cost - tiers[n.tier].cost;
  }

  upgrade(n: SimNode): string | null {
    if (!this.unlocked('upgrade')) return `Vertical scaling unlocks at wave ${UNLOCKS.upgrade}`;
    const c = this.upgradeCost(n);
    if (c === null) return 'Already at max size. Time to scale horizontally!';
    if (this.money < c) return `Need $${c}`;
    this.money -= c;
    n.tier++;
    if (n.kind === 'cache') n.warm *= 0.5; // resizing loses some keys
    return null;
  }

  sellValue(n: SimNode) { return Math.floor(SPECS[n.kind].tiers[n.tier].cost * 0.5); }

  removeNode(id: number) {
    const n = this.node(id);
    if (!n || n.kind === 'users') return;
    this.money += this.sellValue(n);
    this.nodes = this.nodes.filter((x) => x.id !== id);
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  removeEdge(id: number) { this.edges = this.edges.filter((e) => e.id !== id); }

  canConnect(a: SimNode, b: SimNode): string | null {
    if (a.id === b.id) return 'Cannot connect a node to itself';
    if (!SPECS[a.kind].canConnectTo.includes(b.kind))
      return `${SPECS[a.kind].label} can't send traffic to ${SPECS[b.kind].label}`;
    if (this.edges.some((e) => e.from === a.id && e.to === b.id)) return 'Already connected';
    if (this.reaches(b.id, a.id)) return 'That would create a loop';
    return null;
  }

  connect(a: SimNode, b: SimNode): string | null {
    const err = this.canConnect(a, b);
    if (err) return err;
    this.edges.push({ id: this.nextId++, from: a.id, to: b.id, rps: zero() });
    return null;
  }

  private reaches(from: number, to: number): boolean {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length) {
      const c = stack.pop()!;
      if (c === to) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const e of this.edges) if (e.from === c) stack.push(e.to);
    }
    return false;
  }

  children(n: SimNode, kinds?: NodeKind[]) {
    const out: SimNode[] = [];
    for (const e of this.edges) if (e.from === n.id) {
      const c = this.node(e.to);
      if (c && (!kinds || kinds.includes(c.kind))) out.push(c);
    }
    return out;
  }

  parents(n: SimNode) {
    return this.edges.filter((e) => e.to === n.id).map((e) => this.node(e.from)!).filter(Boolean);
  }

  cap(n: SimNode) { return SPECS[n.kind].tiers[n.tier].cap; }

  isSynced(rep: SimNode) { return this.parents(rep).some((p) => p.kind === 'database' && p.downFor <= 0); }

  // ---------------------------------------------------------------- waves

  startWave() {
    if (this.phase !== 'build') return;
    this.phase = 'run';
    this.time = 0;
    this.waveAgg = { req: 0, ok: 0, earned: 0, worstP99: 0 };
    this.say(`Wave ${this.waveNum}: ${this.wave.title}. Peak ≈ ${this.wave.peakRps.toLocaleString()} req/s`, 'info');
    if (this.wave.event) this.say(`Incoming: ${this.wave.event.label}`, 'bad');
  }

  private endWave() {
    const agg = this.waveAgg;
    const okRate = agg.req > 0 ? agg.ok / agg.req : 1;
    const bonus = Math.round((150 + 60 * this.waveNum) * (okRate > 0.99 ? 1.5 : okRate > 0.95 ? 1 : 0.5));
    this.money += bonus;
    const report = { wave: this.waveNum, served: agg.ok, okRate, earned: agg.earned, bonus, worstP99: agg.worstP99 };
    this.bestWave = Math.max(this.bestWave, this.waveNum);
    this.waveNum++;
    this.wave = makeWave(this.waveNum);
    this.phase = 'build';
    for (const n of this.nodes) { n.backlog = n.kind === 'queue' ? n.backlog : 0; n.downFor = 0; }
    this.say(`Wave ${report.wave} cleared! +$${bonus} bonus`, 'good');
    this.onWaveEnd?.(report);
  }

  say(text: string, kind: LogEntry['kind'] = 'info') {
    this.log.unshift({ t: performance.now(), text, kind });
    if (this.log.length > 40) this.log.pop();
  }

  // ---------------------------------------------------------------- simulation

  step() {
    if (this.phase !== 'run') return;
    const dt = TICK;
    const w = this.wave;
    this.time += dt;

    this.chaos(dt);

    // demand
    const rps = w.peakRps * waveShape(w, this.time);
    const demand: Mix = { s: rps * w.mix.s, r: rps * w.mix.r, w: rps * w.mix.w, b: rps * w.mix.b };

    // reset
    for (const e of this.edges) e.rps = zero();
    for (const n of this.nodes) n.stats = { inRps: 0, servedRps: 0, dropRps: 0, util: 0, latency: 0, hitRate: n.stats.hitRate, note: '' };

    const inbox = new Map<number, Flow[]>();
    const push = (id: number, f: Flow) => {
      if (total(f.mix) <= 1e-9) return;
      let arr = inbox.get(id);
      if (!arr) inbox.set(id, (arr = []));
      // merge flows with similar latency to keep the list small
      const m = arr.find((x) => !!x.async === !!f.async && Math.abs(x.lat - f.lat) < 2);
      if (m) {
        const a = total(m.mix), b = total(f.mix);
        m.lat = (m.lat * a + f.lat * b) / (a + b);
        add(m.mix, f.mix);
      } else arr.push({ mix: { ...f.mix }, lat: f.lat, async: f.async });
    };
    const done: Flow[] = [];
    let legitDropped = 0;

    const send = (from: SimNode, to: SimNode, f: Flow) => {
      const e = this.edges.find((x) => x.from === from.id && x.to === to.id);
      if (e) add(e.rps, f.mix);
      push(to.id, f);
    };
    /** split flows across targets proportional to weights */
    const spread = (from: SimNode, flows: Flow[], targets: SimNode[], weights?: number[]) => {
      if (!targets.length) return false;
      const ws = weights ?? targets.map(() => 1);
      const sum = ws.reduce((a, b) => a + b, 0) || 1;
      targets.forEach((t, i) => { for (const f of flows) send(from, t, { mix: scale(f.mix, ws[i] / sum), lat: f.lat, async: f.async }); });
      return true;
    };
    const drop = (n: SimNode, flows: Flow[], why?: string) => {
      for (const f of flows) {
        if (!f.async) legitDropped += legit(f.mix);
        else if (f.mix.w > 0 && n.kind === 'database') this.asyncRejected += f.mix.w;
        n.stats.dropRps += total(f.mix);
      }
      if (why) n.stats.note = why;
    };

    // users inbox
    const users = this.nodes.find((n) => n.kind === 'users')!;
    push(users.id, { mix: demand, lat: 0 });

    // re-queue rejected async writes
    const queues = this.nodes.filter((n) => n.kind === 'queue');
    if (queues.length && this.asyncRejected > 0) for (const q of queues) q.backlog += (this.asyncRejected * dt) / queues.length;
    this.asyncRejected = 0;

    for (const n of this.topo()) {
      const flows = inbox.get(n.id) ?? [];
      // queues still drain backlog with no input
      if (!flows.length && !(n.kind === 'queue' && n.backlog > 0)) {
        if (n.kind === 'cache') n.warm = Math.max(0, n.warm - dt * 0.02);
        continue;
      }
      this.processNode(n, flows, dt, { send, spread, drop, done });
    }

    // ---- metrics
    let success = 0, timeouts = 0;
    const lat: [number, number][] = [];
    for (const f of done) {
      if (f.async) continue;
      const l = legit(f.mix);
      if (l <= 0) continue;
      if (f.lat > TIMEOUT_MS) timeouts += l;
      else { success += l; lat.push([f.lat, l]); }
    }
    lat.sort((a, b) => a[0] - b[0]);
    const pct = (p: number) => {
      const tot = lat.reduce((a, x) => a + x[1], 0);
      let acc = 0;
      for (const [l, wgt] of lat) { acc += wgt; if (acc >= tot * p) return l; }
      return lat.length ? lat[lat.length - 1][0] : 0;
    };
    const demandLegit = legit(demand);
    const errors = legitDropped + timeouts;
    const errorRate = demandLegit > 0 ? Math.min(1, errors / demandLegit) : 0;
    let upkeep = 0;
    for (const n of this.nodes) upkeep += SPECS[n.kind].tiers[n.tier].upkeep;
    const revenue = success * REVENUE_PER_REQ;
    const m = this.metrics;
    const a = 0.3; // smoothing
    m.demand = demandLegit;
    m.success = m.success * (1 - a) + success * a;
    m.errors = m.errors * (1 - a) + errors * a;
    m.errorRate = m.errorRate * (1 - a) + errorRate * a;
    m.p50 = m.p50 * (1 - a) + pct(0.5) * a;
    m.p99 = m.p99 * (1 - a) + pct(0.99) * a;
    m.botRps = demand.b;
    m.upkeep = upkeep;
    m.revenue = revenue;

    this.money += (revenue - upkeep) * dt;
    this.totalServed += success * dt;
    this.waveAgg.req += demandLegit * dt;
    this.waveAgg.ok += success * dt;
    this.waveAgg.earned += revenue * dt;
    this.waveAgg.worstP99 = Math.max(this.waveAgg.worstP99, m.p99);

    // ---- reputation (SLA)
    let hurt = 0;
    if (m.errorRate > SLA.errorRate) hurt += Math.min(10, m.errorRate * 100) * 0.4;
    if (m.p99 > SLA.p99) hurt += Math.min(2, 1 + (m.p99 - SLA.p99) / 2000);
    if (hurt > 0) this.reputation -= hurt * dt;
    else this.reputation = Math.min(100, this.reputation + 0.4 * dt);

    this.sampleAcc += dt;
    if (this.sampleAcc >= 0.5) {
      this.sampleAcc = 0;
      this.history.push({ demand: demandLegit, success, p99: m.p99, err: m.errorRate });
      if (this.history.length > 240) this.history.shift();
    }

    if (this.reputation <= 0) {
      this.reputation = 0;
      this.phase = 'gameover';
      this.bestWave = Math.max(this.bestWave, this.waveNum - 1);
      this.say('Your users gave up on you. Game over.', 'bad');
      this.onGameOver?.();
      return;
    }
    if (this.time >= w.duration) this.endWave();
  }

  private chaos(dt: number) {
    const w = this.wave;
    if (w.chaos > 0 && Math.random() < w.chaos * dt) {
      const servers = this.nodes.filter((n) => n.kind === 'server' && n.downFor <= 0);
      if (servers.length) {
        const v = servers[Math.floor(Math.random() * servers.length)];
        v.downFor = 8 + Math.random() * 6;
        this.say(`${SPECS.server.label} #${v.id} crashed! (out of memory) Restarting...`, 'bad');
      }
    }
    const e = w.event;
    if (e?.type === 'dbcrash' && this.time - dt < e.at && this.time >= e.at) {
      const dbs = this.nodes.filter((n) => n.kind === 'database');
      if (dbs.length) {
        dbs[0].downFor = 12;
        this.say(`Primary database #${dbs[0].id} disk failure! Writes will fail; reads can keep going from replicas.`, 'bad');
      }
    }
    for (const n of this.nodes) if (n.downFor > 0) {
      n.downFor -= dt;
      if (n.downFor <= 0) {
        n.downFor = 0;
        if (n.kind === 'cache') n.warm = 0;
        this.say(`${SPECS[n.kind].label} #${n.id} is back up`, 'good');
      }
    }
  }

  /** Kahn's algorithm; graph is guaranteed acyclic by connect(). */
  private topo(): SimNode[] {
    const indeg = new Map<number, number>();
    for (const n of this.nodes) indeg.set(n.id, 0);
    for (const e of this.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const q = this.nodes.filter((n) => indeg.get(n.id) === 0);
    const out: SimNode[] = [];
    while (q.length) {
      const n = q.shift()!;
      out.push(n);
      for (const e of this.edges) if (e.from === n.id) {
        const d = indeg.get(e.to)! - 1;
        indeg.set(e.to, d);
        if (d === 0) { const c = this.node(e.to); if (c) q.push(c); }
      }
    }
    return out;
  }

  /** Where reads go from a server/cache: primaries + synced replicas, weighted by capacity. */
  private readTargets(n: SimNode) {
    return this.children(n, ['database', 'replica']).filter((c) => c.downFor <= 0 && (c.kind === 'database' || this.isSynced(c)));
  }

  private writeTargets(n: SimNode) {
    return this.children(n, ['database']).filter((c) => c.downFor <= 0);
  }

  private hotWeights(targets: SimNode[]) {
    if (this.wave.event?.type === 'hotkey' && targets.length > 1)
      return targets.map((_, i) => (i === 0 ? 0.5 * (targets.length - 1) / 0.5 : 1)); // first shard takes ~50%
    return undefined;
  }

  private processNode(
    n: SimNode,
    flows: Flow[],
    dt: number,
    io: {
      send: (a: SimNode, b: SimNode, f: Flow) => void;
      spread: (a: SimNode, f: Flow[], t: SimNode[], w?: number[]) => boolean;
      drop: (n: SimNode, f: Flow[], why?: string) => void;
      done: Flow[];
    },
  ) {
    const spec = SPECS[n.kind];
    const st = n.stats;
    const inMix = zero();
    for (const f of flows) add(inMix, f.mix);
    st.inRps = total(inMix);

    if (n.downFor > 0) {
      io.drop(n, flows, `DOWN (${Math.ceil(n.downFor)}s)`);
      return;
    }

    // ---- special: users (no capacity)
    if (n.kind === 'users') {
      const out = flows.map((f) => ({ ...f, lat: f.lat + spec.latency }));
      const kids = this.children(n);
      st.servedRps = st.inRps;
      if (!kids.length) io.drop(n, out, 'Not connected to anything!');
      else io.spread(n, out, kids); // DNS round-robin: no health checks
      return;
    }

    // ---- special: queue (ingest acks writes, then drains to workers)
    if (n.kind === 'queue') {
      const cap = this.cap(n);
      const ingest = flows.filter((f) => !f.async);
      const inW = ingest.reduce((a, f) => a + total(f.mix), 0);
      const keep = inW > cap ? cap / inW : 1;
      if (keep < 1) io.drop(n, ingest.map((f) => ({ ...f, mix: scale(f.mix, 1 - keep) })), 'Ingest limit hit');
      for (const f of ingest) io.done.push({ mix: scale(f.mix, keep), lat: f.lat + spec.latency });
      n.backlog += inW * keep * dt;
      const workers = this.children(n, ['worker']).filter((x) => x.downFor <= 0);
      const pull = workers.reduce((a, x) => a + this.cap(x), 0);
      const drained = Math.min(n.backlog, pull * dt);
      n.backlog -= drained;
      const maxBacklog = cap * spec.queueSeconds;
      if (n.backlog > maxBacklog) { n.backlog = maxBacklog; st.note = 'Queue full!'; }
      st.util = inW / cap;
      st.servedRps = inW * keep;
      st.latency = spec.latency;
      if (drained > 0) io.spread(n, [{ mix: { s: 0, r: 0, w: drained / dt, b: 0 }, lat: 0, async: true }], workers, workers.map((x) => this.cap(x)));
      if (!workers.length) st.note = 'No workers: backlog grows forever';
      else if (n.backlog > pull * 5) st.note = `Backlog ${Math.round(n.backlog / Math.max(1, pull))}s behind`;
      return;
    }

    // ---- pre-capacity filtering
    let pass = flows;
    if (n.kind === 'ratelimiter') {
      // block 95% of bots before they cost anything downstream
      pass = flows.map((f) => ({ ...f, mix: { ...f.mix, b: f.mix.b * 0.05 } }));
      const blocked = inMix.b * 0.95;
      if (blocked > 1) st.note = `Blocked ${fmt(blocked)} bot req/s`;
    }

    // ---- capacity / queueing model
    // Databases serve live (sync) traffic first; async work (queue workers, replication)
    // only gets leftover capacity and is pushed back instead of dropped (backpressure).
    const prio = n.kind === 'database' || n.kind === 'replica';
    const live = prio ? pass.filter((f) => !f.async) : pass;
    const bg = prio ? pass.filter((f) => f.async) : [];
    const cap = this.cap(n);
    const units = (fs: Flow[]) => fs.reduce((a, f) => a + f.mix.s + f.mix.r + f.mix.b + f.mix.w * spec.writeCost, 0);
    const load = units(live);
    const bgLoad = units(bg);
    const arrivals = load * dt;
    const totalWork = arrivals + n.backlog;
    const served = Math.min(totalWork, cap * dt);
    let remaining = totalWork - served;
    const maxQ = cap * spec.queueSeconds;
    let dropped = 0;
    if (remaining > maxQ) { dropped = remaining - maxQ; remaining = maxQ; }
    n.backlog = remaining;
    const passFrac = arrivals > 0 ? served / arrivals : 0;
    const dropFrac = arrivals > 0 ? Math.min(1, dropped / arrivals) : 0;
    const bgFrac = bgLoad > 0 ? Math.min(1, Math.max(0, cap * dt - served) / (bgLoad * dt)) : 0;
    const u = (load + bgLoad * bgFrac) / cap;
    const demandU = (load + bgLoad) / cap;
    const nodeLat = spec.latency * (1 + 2 * Math.pow(Math.min(u, 1), 3)) + (n.backlog / cap) * 1000;
    st.util = u;
    st.latency = nodeLat;
    st.servedRps = total(inMix) * Math.min(1, passFrac);
    if (dropFrac > 0) io.drop(n, live.map((f) => ({ ...f, mix: scale(f.mix, dropFrac) })), load > cap ? 'Overloaded! Dropping requests' : undefined);
    else if (bgLoad > 0 && bgFrac < 1) {
      const rejected = bg.reduce((a, f) => a + f.mix.w, 0) * (1 - bgFrac);
      if (n.kind === 'database') { this.asyncRejected += rejected; st.note = 'Throttling workers (backpressure)'; }
      else st.note = `Replication lag (${Math.round((1 - bgFrac) * 100)}% behind)`;
    } else if (demandU > 0.9) st.note = 'Running hot';
    const out = [
      ...live.map((f) => ({ mix: scale(f.mix, passFrac), lat: f.lat + nodeLat, async: f.async })),
      ...bg.map((f) => ({ mix: scale(f.mix, bgFrac), lat: f.lat, async: true })),
    ];

    // ---- routing
    switch (n.kind) {
      case 'loadbalancer':
      case 'ratelimiter':
      case 'cdn': {
        let fwd = out;
        if (n.kind === 'cdn') {
          const hit = SPECS.cdn.tiers[n.tier].hit!;
          st.hitRate = hit;
          for (const f of out) io.done.push({ mix: pick(scale(f.mix, hit), ['s']), lat: Math.max(5, f.lat - CDN_LATENCY_SAVED) });
          fwd = out.map((f) => ({ ...f, mix: { ...f.mix, s: f.mix.s * (1 - hit) } }));
        }
        const kids = this.children(n);
        // health checks: skip crashed downstreams
        const up = kids.filter((k) => k.downFor <= 0);
        if (!kids.length) io.drop(n, fwd, 'No downstream connection!');
        else if (!up.length) io.drop(n, fwd, 'All backends down!');
        else io.spread(n, fwd, up, up.map((k) => this.cap(k)));
        break;
      }
      case 'server': {
        const statics = out.map((f) => ({ mix: pick(f.mix, ['s']), lat: f.lat }));
        io.done.push(...statics);
        const reads = out.map((f) => ({ mix: pick(f.mix, ['r', 'b']), lat: f.lat }));
        const writes = out.map((f) => ({ mix: pick(f.mix, ['w']), lat: f.lat }));
        const caches = this.children(n, ['cache']).filter((c) => c.downFor <= 0);
        const rt = this.readTargets(n);
        const anyStore = this.children(n, ['database', 'replica', 'cache', 'queue']).length > 0;
        if (!anyStore) { io.drop(n, [...reads, ...writes], 'No database connected: reads/writes fail'); break; }
        if (caches.length) io.spread(n, reads, caches, caches.map((c) => this.cap(c)));
        else if (rt.length) io.spread(n, reads, rt, rt.map((c) => this.cap(c)));
        else io.drop(n, reads, 'No healthy place to read from');
        const qs = this.children(n, ['queue']).filter((c) => c.downFor <= 0);
        const wt = this.writeTargets(n);
        if (qs.length) io.spread(n, writes, qs);
        else if (wt.length) io.spread(n, writes, wt, this.hotWeights(wt));
        else if (caches.length) io.spread(n, writes, caches); // write-through
        else io.drop(n, writes, 'No primary DB for writes');
        break;
      }
      case 'cache': {
        // warm up as traffic flows; writes invalidate keys
        n.warm = Math.min(1, n.warm + dt * 0.12);
        const base = SPECS.cache.tiers[n.tier].hit!;
        const wr = inMix.w / Math.max(1e-9, total(inMix));
        const hot = this.wave.event?.type === 'hotkey' ? 0.05 : 0;
        const hit = Math.min(0.97, (base + hot) * (0.15 + 0.85 * n.warm) * (1 - wr * 0.6));
        st.hitRate = hit;
        if (n.warm < 0.9) st.note = st.note || `Warming up (${Math.round(n.warm * 100)}%)`;
        for (const f of out) io.done.push({ mix: pick(scale(f.mix, hit), ['r', 'b']), lat: f.lat });
        const misses = out.map((f) => ({ mix: pick(scale(f.mix, 1 - hit), ['r', 'b']), lat: f.lat }));
        const writes = out.map((f) => ({ mix: pick(f.mix, ['w']), lat: f.lat }));
        const rt = this.readTargets(n);
        const wt = this.writeTargets(n);
        if (rt.length) io.spread(n, misses, rt, rt.map((c) => this.cap(c)));
        else io.drop(n, misses, 'Cache misses have nowhere to go (connect a DB)');
        if (wt.length) io.spread(n, writes, wt, this.hotWeights(wt));
        else io.drop(n, writes, st.note || 'Writes need a primary DB');
        break;
      }
      case 'database':
      case 'replica': {
        if (n.kind === 'replica' && !this.isSynced(n)) {
          io.drop(n, out, 'Not replicating! Needs a Database → Replica link');
          break;
        }
        for (const f of out) if (!f.async || n.kind === 'database') io.done.push(f);
        if (n.kind === 'database') {
          // replicate writes to replicas
          const reps = this.children(n, ['replica']);
          const wr = out.reduce((a, f) => a + f.mix.w, 0);
          if (wr > 0) for (const r of reps) io.send(n, r, { mix: { s: 0, r: 0, w: wr, b: 0 }, lat: 0, async: true });
        }
        break;
      }
      case 'worker': {
        const wt = this.writeTargets(n);
        if (wt.length) io.spread(n, out, wt, this.hotWeights(wt));
        else io.drop(n, out, 'No database to write to');
        break;
      }
    }
  }
}

export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1);
}
