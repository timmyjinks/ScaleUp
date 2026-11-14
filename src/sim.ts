import {
  API_KB, ASYNC_WRITE_SHARE, AUTOSCALE_IN_COOLDOWN_S, AUTOSCALE_SMOOTH_S, BOOT_S, BATCH_WRITE_COST, BATCH_WRITE_IOPS, CACHE_HOT_MB_PER_USER, ENQUEUE_CPU, FRESH_READ_SHARE, HOT_KEY_SHARE, HOURS_PER_MONTH, INFRA_BUDGET_SHARE, GROUPABLE, MAX_GROUP, CACHE_STRATEGIES, CACHE_USABLE, DB_HOT_MB_PER_USER, DISK_MS, FAILOVER_S, GEO, OOM_RESTART_S, PAGES_PER_READ,
  PG_CONN_MB, REPLICA_APPLY_COST, REQ_MB, RESIZE_S, REVENUE_PER_RPS_MONTH, SECONDS_PER_MONTH, SLA, SPECS, START_MONEY, STATIC_KB, TICK,
  TIMEOUT_MS, UNLOCKS, USERS_PER_RPS, WRITEBACK_COALESCE, makeWave, maxConnections, waveShape, zipfHit,
} from './config';
import type { Autoscale, CacheStrategy, Edge, Flow, Metrics, Mix, NodeKind, NodeStats, Phase, SimNode, TierSpec, WaveDef } from './types';

const CDN_API_CACHEABLE = 0.4; // share of GETs that are public (not personalized) and can be edge-cached
const CDN_TTL_S = 10;
const DB_WRITE_MS = 4; // commit: WAL fsync + index updates
const SERVER_STATIC_CPU = 0.2; // a static file costs ~1/5 of an API call
const SERVER_STATIC_MS = 2;

export const zero = (): Mix => ({ s: 0, r: 0, w: 0, b: 0 });
const add = (a: Mix, b: Mix, k = 1) => { a.s += b.s * k; a.r += b.r * k; a.w += b.w * k; a.b += b.b * k; };
const scale = (m: Mix, k: number): Mix => ({ s: m.s * k, r: m.r * k, w: m.w * k, b: m.b * k });
export const total = (m: Mix) => m.s + m.r + m.w + m.b;
const legit = (m: Mix) => m.s + m.r + m.w;
const pick = (m: Mix, keys: (keyof Mix)[]): Mix => { const o = zero(); for (const k of keys) o[k] = m[k]; return o; };
const sum = (fs: Flow[], f: (m: Mix) => number) => fs.reduce((a, x) => a + f(x.mix), 0);
/** copy of a flow with a subset of its traffic (scaled) and extra latency */
const part = (f: Flow, keys: (keyof Mix)[] | null, k = 1, lat = 0): Flow => ({ ...f, mix: scale(keys ? pick(f.mix, keys) : f.mix, k), lat: f.lat + lat });
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const gb = (x: number) => (x >= 100 ? Math.round(x).toString() : x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)) + ' GB';
const pct = (x: number) => `${Math.round(x * 100)}%`;
const ms = (x: number) => (x >= 1000 ? (x / 1000).toFixed(1) + 's' : x >= 10 ? Math.round(x) + 'ms' : x.toFixed(1) + 'ms');

export interface LogEntry { t: number; text: string; kind: 'info' | 'bad' | 'good' }
export interface Sample { demand: number; success: number; p99: number; err: number }
export interface WaveReport { wave: number; served: number; okRate: number; earned: number; bonus: number; worstP99: number; cost: number; lostWrites: number }

interface IO {
  send: (a: SimNode, b: SimNode, f: Flow) => void;
  spread: (a: SimNode, f: Flow[], t: SimNode[], w?: number[]) => boolean;
  drop: (n: SimNode, f: Flow[], why?: string) => void;
  done: Flow[];
}

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
  metrics: Metrics = { demand: 0, success: 0, errors: 0, errorRate: 0, p50: 0, p99: 0, botRps: 0, upkeep: 0, revenue: 0, staleRate: 0, lostWrites: 0 };
  history: Sample[] = [];
  log: LogEntry[] = [];
  /** wave stats for the end-of-wave report */
  waveAgg = { req: 0, ok: 0, earned: 0, worstP99: 0, cost: 0 };
  onWaveEnd?: (report: WaveReport) => void;
  onGameOver?: () => void;

  private sampleAcc = 0;
  /** async work rejected downstream this tick, handed back to its source next tick (req/s by source id) */
  private rejected = new Map<number, number>();
  /** queue id → how fast its workers may pull (jobs/s), and what they pulled last tick; paced to what the DB accepts */
  private pace = new Map<number, { rate: number; pulled: number; back: number }>();
  /** reads/s already routed to each replica this tick (several servers / caches share its room) */
  private readsTo = new Map<number, number>();
  /** legit reads/s each app server answered this tick (a lagging queue makes some of them stale) */
  private serverReads = new Map<number, number>();
  /** autoscaling groups: the CPU average the policy sees, and the scale-in cooldown */
  /** groups already warned about an OOM cascade this wave (one log line, not one per instance) */
  private oomSaid = new Set<number>();
  private scaler = new Map<number, { work: number; cool: number; fresh?: boolean }>();

  constructor() {
    this.addNode('users', 80, 300, true);
  }

  // ---------------------------------------------------------------- building

  unlocked(feature: string) { return this.waveNum >= (UNLOCKS[feature] ?? 1); }

  node(id: number) { return this.nodes.find((n) => n.id === id); }

  tierOf(n: SimNode): TierSpec { return SPECS[n.kind].tiers[n.tier]; }

  addNode(kind: NodeKind, x: number, y: number, free = false): SimNode | string {
    if (!free) {
      if (!this.unlocked(kind)) return `${SPECS[kind].label} unlocks at wave ${UNLOCKS[kind]}`;
      if (kind === 'database' && !this.unlocked('sharding') && this.nodes.some((n) => n.kind === 'database'))
        return `Only one primary database until sharding unlocks (wave ${UNLOCKS.sharding}). Make it bigger, or add a cache or read replicas.`;
      const cost = SPECS[kind].tiers[0].cost;
      if (this.money < cost) return `Need $${cost} (first month)`;
      this.money -= cost;
    }
    const n: SimNode = {
      id: this.nextId++, kind, x, y, tier: 0, strategy: 'aside', cdnApi: false, pooler: false, count: 1, auto: null, instDown: [],
      backlog: 0, downFor: 0, outage: 0, warm: 0, dirty: 0, pending: 0, resp: 0, inflight: 0, conns: 0, room: -1,
      stats: blankStats(),
    };
    n.stats.cost = SPECS[kind].tiers[0].cost;
    this.nodes.push(n);
    return n;
  }

  resizeCost(n: SimNode, tier: number) { const ts = SPECS[n.kind].tiers; return Math.max(0, ts[tier].cost - ts[n.tier].cost) * this.owned(n); }

  /**
   * Instances you bought (paid the first month up front, half back when sold). For an autoscaling group that's
   * its minimum: instances it adds on its own are billed per second while they run, and nothing is paid or refunded for them.
   */
  owned(n: SimNode) { return n.auto ? n.auto.min : n.count; }

  upgradeCost(n: SimNode): number | null {
    return n.tier >= SPECS[n.kind].tiers.length - 1 ? null : this.resizeCost(n, n.tier + 1);
  }

  upgrade(n: SimNode): string | null {
    if (n.tier >= SPECS[n.kind].tiers.length - 1)
      return GROUPABLE.includes(n.kind) ? 'Already the biggest size. Add instances instead (scale out).'
        : n.kind === 'database' ? 'Already the biggest size. Move reads to caches and replicas, or shard.'
        : 'Already the biggest size. Add another one instead.';
    return this.resize(n, n.tier + 1);
  }

  /** Change instance type. Instant in the build phase; mid-wave the instance restarts. */
  resize(n: SimNode, tier: number): string | null {
    const ts = SPECS[n.kind].tiers;
    if (!this.unlocked('upgrade')) return `Resizing unlocks at wave ${UNLOCKS.upgrade}`;
    if (tier < 0 || tier >= ts.length || tier === n.tier) return 'Nothing to change';
    const c = this.resizeCost(n, tier);
    if (this.money < c) return `Need $${c}`;
    this.money -= c;
    const from = ts[n.tier].name;
    n.tier = tier;
    if (this.phase === 'run' && this.isGroup(n)) {
      // a group resizes as a rolling replacement: launch new-size instances, then terminate old ones, so it never stops serving
      this.say(`${SPECS[n.kind].label} #${n.id}: rolling replacement ${from} → ${ts[tier].name} (new instances launch before old ones stop, no downtime)`, 'info');
    } else if (this.phase === 'run' && RESIZE_S[n.kind] > 0 && n.downFor <= 0) {
      n.downFor = RESIZE_S[n.kind]; n.outage = 0; n.backlog = 0; n.inflight = 0;
      if (n.kind === 'cache') { n.warm = 0; n.dirty = 0; } // restart = empty cache (dirty keys flushed on graceful shutdown)
      this.say(`${SPECS[n.kind].label} #${n.id} restarting to resize ${from} → ${ts[tier].name} (~${RESIZE_S[n.kind]}s down)`, 'bad');
    }
    return null;
  }

  setStrategy(n: SimNode, s: CacheStrategy) { if (n.kind === 'cache') n.strategy = s; }
  setCdnApi(n: SimNode, on: boolean) { if (n.kind === 'cdn') n.cdnApi = on; }
  setPooler(n: SimNode, on: boolean) { if (n.kind === 'database' || n.kind === 'replica') n.pooler = on; }

  /** RDS Proxy bills per vCPU of the database it fronts (~$11/vCPU-month) */
  poolerCost(n: SimNode) { return n.pooler ? Math.round(11 * Math.max(2, this.tierOf(n).vcpu)) : 0; }

  sellValue(n: SimNode) { return Math.floor(this.tierOf(n).cost * 0.5) * this.owned(n); }

  /** fixed $/month for every instance in the node */
  fixedCost(n: SimNode) { return this.tierOf(n).cost * n.count + this.poolerCost(n); }

  /**
   * `k` instances of a group fail. A fixed group restarts them in place (`secs`). An autoscaling group terminates
   * them and launches replacements right away, so the failed slots come back after the boot time and never linger.
   */
  private failInstances(n: SimNode, k: number, secs: number) {
    for (let i = 0; i < k; i++) n.instDown.push(n.auto ? { t: BOOT_S, boot: true } : { t: secs });
  }

  /** several instances behind one node (or an autoscaling group): failures and resizes hit instances, not the node */
  isGroup(n: SimNode) { return GROUPABLE.includes(n.kind) && (n.count > 1 || !!n.auto); }

  /** instances currently serving traffic */
  active(n: SimNode) { return n.downFor > 0 ? 0 : Math.max(0, n.count - n.instDown.length); }

  /**
   * Scale a group to `count` instances. Adding pays the first month for each new instance; mid-wave they
   * boot for a few seconds before taking traffic. Removing refunds half, like selling.
   */
  setCount(n: SimNode, count: number): string | null {
    if (!GROUPABLE.includes(n.kind)) return `${SPECS[n.kind].label} can't run as a group`;
    count = Math.round(count);
    if (count < 1) return 'A group needs at least one instance. Sell it instead.';
    if (count > MAX_GROUP) return `Max ${MAX_GROUP} instances per group`;
    const d = count - this.owned(n);
    if (!d) return null;
    const unit = this.tierOf(n).cost;
    if (d > 0) {
      if (this.money < unit * d) return `Need $${unit * d}`;
      this.money -= unit * d;
    } else this.money += Math.floor(unit * 0.5) * -d;
    const a = n.auto;
    if (a) {
      // autoscaling: this sets the minimum; mid-wave the policy scales in to it on its own
      a.min = count;
      a.max = Math.max(a.max, count);
      if (this.phase === 'build') n.count = count;
      else if (count > n.count) this.launch(n, count - n.count);
      return null;
    }
    if (d > 0) { if (this.phase === 'run') this.launch(n, d); else n.count = count; }
    else {
      n.instDown = n.instDown.slice(0, Math.max(0, count - 1)); // keep at least one serving
      n.count = count;
    }
    return null;
  }

  /** Add instances to a group. Mid-wave they boot before taking traffic. */
  private launch(n: SimNode, k: number) {
    if (this.phase === 'run') for (let i = 0; i < k; i++) n.instDown.push({ t: BOOT_S, boot: true });
    n.count += k;
  }

  /**
   * Turn target tracking on or off. On: the current size becomes the minimum. Off: the group goes back to its
   * minimum (the instances the policy added are terminated, not kept for free).
   */
  setAutoscale(n: SimNode, on: boolean): string | null {
    if (!GROUPABLE.includes(n.kind)) return `${SPECS[n.kind].label} can't autoscale`;
    if (on && !this.unlocked('autoscale')) return `Autoscaling unlocks at wave ${UNLOCKS.autoscale}`;
    if (on === !!n.auto) return null;
    if (on) n.auto = { min: n.count, max: Math.min(MAX_GROUP, Math.max(n.count * 3, n.count + 3)), target: 0.6 };
    else {
      const min = n.auto!.min;
      n.auto = null;
      this.scaleIn(n, n.count - min);
    }
    return null;
  }

  setAutoscaleLimits(n: SimNode, o: Partial<Pick<Autoscale, 'max' | 'target'>>) {
    const a = n.auto;
    if (!a) return;
    if (o.max != null) a.max = clamp(Math.round(o.max), a.min, MAX_GROUP);
    if (o.target != null) a.target = clamp(o.target, 0.2, 0.95);
  }

  /** Terminate `k` instances: crashed and still-booting ones go first, and at least one keeps serving. */
  private scaleIn(n: SimNode, k: number) {
    for (; k > 0 && n.count > 1; k--) {
      const i = n.instDown.findIndex((d) => !d.boot);
      const j = i >= 0 ? i : n.instDown.length - 1;
      if (j >= 0) n.instDown.splice(j, 1);
      else if (n.count - n.instDown.length <= 1) break;
      n.count--;
    }
  }

  /** Same-kind, same-size nodes collapse into one group; every link either of them had is kept. */
  canMerge(ns: SimNode[]) {
    return ns.length > 1 && GROUPABLE.includes(ns[0].kind) && ns.every((n) => n.kind === ns[0].kind && n.tier === ns[0].tier)
      && ns.reduce((a, n) => a + n.count, 0) <= MAX_GROUP;
  }

  merge(ns: SimNode[]): SimNode | string {
    if (!this.canMerge(ns)) return `Only ${GROUPABLE.map((k) => SPECS[k].label).join(' / ')} nodes of the same size can be grouped (max ${MAX_GROUP})`;
    const [keep, ...rest] = ns;
    for (const o of rest) {
      for (const e of this.edges.filter((x) => x.to === o.id)) { const p = this.node(e.from); if (p && !rest.includes(p)) this.connect(p, keep); }
      for (const e of this.edges.filter((x) => x.from === o.id)) { const c = this.node(e.to); if (c && !rest.includes(c)) this.connect(keep, c); }
      // the merged group autoscales if either did; what each one owned becomes its minimum
      if (o.auto && !keep.auto) keep.auto = { ...o.auto, min: keep.count };
      if (keep.auto) { keep.auto.min += this.owned(o); keep.auto.max = Math.min(MAX_GROUP, Math.max(keep.auto.max, keep.auto.min)); }
      keep.count += o.count;
      keep.instDown.push(...o.instDown);
      this.nodes = this.nodes.filter((x) => x !== o);
      this.edges = this.edges.filter((e) => e.from !== o.id && e.to !== o.id);
    }
    return keep;
  }

  /** Give `to` the same incoming and outgoing links as `from` (where the wiring rules allow). Returns links made. */
  copyWiring(from: SimNode, to: SimNode) {
    let made = 0;
    for (const e of this.edges.filter((x) => x.to === from.id)) { const p = this.node(e.from); if (p && !this.connect(p, to)) made++; }
    for (const e of this.edges.filter((x) => x.from === from.id)) { const c = this.node(e.to); if (c && !this.connect(to, c)) made++; }
    return made;
  }

  /** price of duplicating these nodes (same size, same group count) */
  duplicateCost(ns: SimNode[]) { return ns.filter((n) => n.kind !== 'users').reduce((a, n) => a + this.tierOf(n).cost * this.owned(n), 0); }

  /**
   * Copy nodes (size, settings, group count) offset by dx/dy. Links to nodes outside the set are copied too,
   * so a new server joins the same LB, cache and DB; links inside the set are rebuilt between the copies.
   */
  duplicate(ns: SimNode[], dx: number, dy: number): SimNode[] | string {
    ns = ns.filter((n) => n.kind !== 'users');
    if (!ns.length) return 'Nothing to duplicate';
    for (const n of ns) if (!this.unlocked(n.kind)) return `${SPECS[n.kind].label} unlocks at wave ${UNLOCKS[n.kind]}`;
    if (ns.some((n) => n.kind === 'database') && !this.unlocked('sharding'))
      return `Only one primary database until sharding unlocks (wave ${UNLOCKS.sharding}). Add a read replica instead.`;
    const cost = this.duplicateCost(ns);
    if (this.money < cost) return `Need $${cost} to duplicate`;
    this.money -= cost;
    const map = new Map<number, SimNode>();
    for (const n of ns) {
      const c = this.addNode(n.kind, n.x + dx, n.y + dy, true) as SimNode;
      Object.assign(c, { tier: n.tier, strategy: n.strategy, cdnApi: n.cdnApi, pooler: n.pooler, count: this.owned(n), auto: n.auto && { ...n.auto }, warm: 0 });
      if (this.phase === 'run' && RESIZE_S[n.kind] > 0) c.downFor = RESIZE_S[n.kind]; // new instances boot before taking traffic
      map.set(n.id, c);
    }
    for (const e of [...this.edges]) {
      const a = map.get(e.from), b = map.get(e.to);
      if (!a && !b) continue;
      const from = a ?? this.node(e.from), to = b ?? this.node(e.to);
      if (from && to) this.connect(from, to); // rules (e.g. one primary per replica) may refuse some: skip them
    }
    return [...map.values()];
  }

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
    if (!SPECS[a.kind].canConnectTo.includes(b.kind)) {
      if (b.kind === 'replica' && a.kind !== 'database') return `Only a ${SPECS.server.label} or Cache reads from replicas, and a Database feeds them`;
      return `${SPECS[a.kind].label} can't send traffic to ${SPECS[b.kind].label}`;
    }
    if (this.edges.some((e) => e.from === a.id && e.to === b.id)) return 'Already connected';
    if (b.kind === 'replica' && a.kind === 'database' && this.parents(b).some((p) => p.kind === 'database'))
      return 'That replica already replicates from a primary';
    if (this.reaches(b.id, a.id)) return 'That would create a loop';
    return null;
  }

  connect(a: SimNode, b: SimNode): string | null {
    const err = this.canConnect(a, b);
    if (err) return err;
    this.edges.push({ id: this.nextId++, from: a.id, to: b.id, rps: zero(), sync: 0 });
    this.linkReaders();
    return null;
  }

  /**
   * Whoever reads from a primary also reads from its replicas (an app pointed at the cluster's reader
   * endpoint), so Server → Database + Database → Replica is all the wiring a read/write split needs.
   */
  linkReaders() {
    for (const d of this.nodes) {
      if (d.kind !== 'database') continue;
      const readers = this.parents(d).filter((p) => p.kind === 'server' || p.kind === 'cache');
      for (const r of this.children(d, ['replica']))
        for (const p of readers)
          if (!this.canConnect(p, r)) this.edges.push({ id: this.nextId++, from: p.id, to: r.id, rps: zero(), sync: 0 });
    }
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

  edge(a: SimNode, b: SimNode) { return this.edges.find((e) => e.from === a.id && e.to === b.id); }

  /** capacity of the whole node: per-instance capacity × instances in service */
  cap(n: SimNode) { const c = this.tierOf(n).cap; return n.count > 1 || n.instDown.length ? c * this.active(n) : c; }

  /** replicas need a Database → Replica link */
  isSynced(rep: SimNode) { return this.parents(rep).some((p) => p.kind === 'database'); }

  /** $/month for the whole system right now (usage-based nodes priced at current traffic) */
  burn() { return this.nodes.reduce((a, n) => a + (this.phase === 'run' ? n.stats.cost : this.fixedCost(n)), 0); }

  /** concurrent users the dataset has to serve this wave (data only grows) */
  peakUsers() { return this.wave.users ?? this.wave.peakRps * USERS_PER_RPS; }

  /** DB working set (GB) a given primary/replica has to hold: hot rows + indexes for its shard */
  workingSet() {
    const primaries = Math.max(1, this.nodes.filter((x) => x.kind === 'database').length);
    return (this.peakUsers() * DB_HOT_MB_PER_USER) / 1024 / primaries;
  }

  /** Hot objects a cache has to hold; caches shard keys between them (weighted by memory). */
  cacheHotSet(n: SimNode) {
    const caches = this.nodes.filter((x) => x.kind === 'cache' && x.downFor <= 0);
    const all = caches.reduce((a, c) => a + this.tierOf(c).ram, 0) || 1;
    const share = n.downFor > 0 ? 1 : this.tierOf(n).ram / all;
    return ((this.peakUsers() * CACHE_HOT_MB_PER_USER) / 1024) * share;
  }

  /** Steady-state cache hit rate for this cache given memory, warmth and strategy. */
  cacheHit(n: SimNode, writeRatio: number) {
    const hot = this.cacheHotSet(n);
    const usable = this.tierOf(n).ram * CACHE_USABLE;
    const filled = n.warm * Math.min(usable, hot);
    let h = zipfHit(filled / Math.max(1e-9, hot)) * 0.97;
    if (n.strategy === 'aside' || n.strategy === 'readthrough') h *= 1 - Math.min(0.5, 0.5 * writeRatio); // invalidated keys miss next time
    else h = Math.min(0.98, h * 1.02); // written keys are already cached
    if (this.wave.event?.type === 'hotkey') h = Math.min(0.98, h + 0.03);
    return h;
  }

  /** Buffer-pool / page-cache hit rate for a DB node. */
  bufferPool(n: SimNode) {
    const t = this.tierOf(n);
    const connGB = (n.conns * PG_CONN_MB) / 1024;
    const pool = Math.max(t.ram * 0.1, t.ram * 0.75 - connGB);
    const ws = this.workingSet();
    return { pool, ws, connGB, hit: ws <= pool ? 0.995 : zipfHit(pool / ws) * 0.995 };
  }

  // ---------------------------------------------------------------- waves

  startWave() {
    if (this.phase !== 'build') return;
    this.phase = 'run';
    this.time = 0;
    this.waveAgg = { req: 0, ok: 0, earned: 0, worstP99: 0, cost: 0 };
    this.metrics.lostWrites = 0;
    this.say(`Wave ${this.waveNum}: ${this.wave.title}. Peak ≈ ${this.wave.peakRps.toLocaleString()} req/s (${fmt(this.peakUsers())} users)`, 'info');
    if (this.wave.event) this.say(`Incoming: ${this.wave.event.label}`, 'bad');
  }

  private endWave() {
    // the rest of the month is off-peak: queues with a working consumer drain; without one, messages expire
    for (const q of this.nodes) {
      if (q.kind !== 'queue' || q.backlog < 1) continue;
      const drains = this.children(q, ['worker']).some((k) => this.children(k, ['database']).length);
      if (!drains) {
        this.loseWrites(q.backlog);
        this.say(`Queue #${q.id}: ${fmt(q.backlog)} messages nobody consumed expired (retention ran out). Those acknowledged writes are LOST.`, 'bad');
      }
      q.backlog = 0;
    }
    const agg = this.waveAgg;
    const okRate = agg.req > 0 ? agg.ok / agg.req : 1;
    // a clean month earns a budget top-up on top of the usual share of revenue
    const bonus = Math.round(agg.earned * INFRA_BUDGET_SHARE * (okRate > 0.99 ? 0.25 : okRate > 0.95 ? 0.1 : 0));
    this.money += bonus;
    const report: WaveReport = { wave: this.waveNum, served: agg.ok, okRate, earned: agg.earned, bonus, worstP99: agg.worstP99, cost: agg.cost, lostWrites: this.metrics.lostWrites };
    this.bestWave = Math.max(this.bestWave, this.waveNum);
    this.waveNum++;
    this.wave = makeWave(this.waveNum);
    this.phase = 'build';
    for (const n of this.nodes) {
      n.backlog = 0;
      n.downFor = 0; n.outage = 0; n.inflight = 0; n.pending = 0; n.dirty = 0; n.instDown = [];
      if (n.auto) n.count = n.auto.min; // off-peak, autoscaling groups shrink back to their minimum
    }
    this.pace.clear();
    this.scaler.clear();
    this.oomSaid.clear();
    this.say(`Month ${report.wave} books: revenue $${Math.round(agg.earned).toLocaleString()}, your ${Math.round(INFRA_BUDGET_SHARE * 100)}% budget $${Math.round(agg.earned * INFRA_BUDGET_SHARE).toLocaleString()}, cloud bill $${Math.round(agg.cost).toLocaleString()} (${agg.earned > 0 ? Math.round((agg.cost / agg.earned) * 100) : 0}% of revenue)${report.lostWrites >= 1 ? `, ${fmt(report.lostWrites)} acknowledged writes lost` : ''}`, report.lostWrites >= 1 ? 'bad' : 'info');
    this.say(`Wave ${report.wave} cleared! +$${bonus.toLocaleString()} bonus`, 'good');
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
    this.autoscale(dt);

    // demand
    const rps = w.peakRps * waveShape(w, this.time);
    const demand: Mix = { s: rps * w.mix.s, r: rps * w.mix.r, w: rps * w.mix.w, b: rps * w.mix.b };

    // reset
    for (const e of this.edges) { e.rps = zero(); e.sync = 0; }
    this.serverReads.clear();
    this.readsTo.clear();
    for (const n of this.nodes) { const h = n.stats.hitRate; n.stats = blankStats(); n.stats.hitRate = h; n.stats.cost = this.fixedCost(n); }

    const inbox = new Map<number, Flow[]>();
    const push = (id: number, f: Flow) => {
      if (total(f.mix) <= 1e-9) return;
      let arr = inbox.get(id);
      if (!arr) inbox.set(id, (arr = []));
      // merge flows with similar latency to keep the list small
      const m = arr.find((x) => !!x.async === !!f.async && x.geo === f.geo && x.src === f.src && Math.abs(x.lat - f.lat) < 2);
      if (m) {
        const a = total(m.mix), b = total(f.mix);
        m.lat = (m.lat * a + f.lat * b) / (a + b);
        add(m.mix, f.mix);
      } else arr.push({ ...f, mix: { ...f.mix } });
    };
    const done: Flow[] = [];
    let legitDropped = 0;

    const send = (from: SimNode, to: SimNode, f: Flow) => {
      const e = this.edge(from, to);
      if (e) { add(e.rps, f.mix); if (!f.async) e.sync += total(f.mix); }
      push(to.id, f);
    };
    /** split flows across targets proportional to weights */
    const spread = (from: SimNode, flows: Flow[], targets: SimNode[], weights?: number[]) => {
      if (!targets.length) return false;
      const ws = weights ?? targets.map(() => 1);
      const s = ws.reduce((a, b) => a + b, 0) || 1;
      targets.forEach((t, i) => { for (const f of flows) send(from, t, part(f, null, ws[i] / s)); });
      return true;
    };
    const drop = (n: SimNode, flows: Flow[], why?: string) => {
      let d = 0;
      for (const f of flows) {
        if (!f.async) legitDropped += legit(f.mix);
        else if (f.src != null && f.mix.w > 0) this.reject(f.src, f.mix.w);
        d += total(f.mix);
      }
      n.stats.dropRps += d;
      if (why && d > 1e-6) n.stats.note = why;
    };
    const io: IO = { send, spread, drop, done };

    // users inbox, split by geography
    const users = this.nodes.find((n) => n.kind === 'users')!;
    GEO.forEach((g, i) => push(users.id, { mix: scale(demand, g.share), lat: 0, geo: i }));

    // backpressure: hand rejected async work back to whoever owns it
    for (const [src, amt] of this.rejected) {
      const s = this.node(src);
      if (s?.kind === 'queue') { s.backlog += amt * dt; const p = this.pace.get(src); if (p) p.back = amt; }
      else if (s?.kind === 'cache') s.dirty += (amt * dt) / WRITEBACK_COALESCE;
    }
    this.rejected.clear();

    const order = this.topo();
    for (const n of order) this.processNode(n, inbox.get(n.id) ?? [], dt, io);
    this.afterTick(order);

    // ---- metrics
    let success = 0, timeouts = 0, readsOk = 0, stale = 0;
    const lat: [number, number][] = [];
    for (const f of done) {
      if (f.async) continue;
      const l = legit(f.mix);
      if (l <= 0) continue;
      if (f.lat > TIMEOUT_MS) timeouts += l;
      else { success += l; readsOk += f.mix.r; lat.push([f.lat, l]); }
    }
    for (const n of this.nodes) stale += n.stats.stale;
    lat.sort((a, b) => a[0] - b[0]);
    const tot = lat.reduce((a, x) => a + x[1], 0);
    const pctl = (p: number) => {
      let acc = 0;
      for (const [l, wgt] of lat) { acc += wgt; if (acc >= tot * p) return l; }
      return lat.length ? lat[lat.length - 1][0] : 0;
    };
    const demandLegit = legit(demand);
    const errors = legitDropped + timeouts;
    const errorRate = demandLegit > 0 ? Math.min(1, errors / demandLegit) : 0;
    const upkeep = this.burn();
    const revenue = success * REVENUE_PER_RPS_MONTH;
    const m = this.metrics;
    const a = 0.3; // smoothing
    m.demand = m.demand * (1 - a) + demandLegit * a;
    m.success = m.success * (1 - a) + success * a;
    m.errors = m.errors * (1 - a) + errors * a;
    m.errorRate = m.errorRate * (1 - a) + errorRate * a;
    m.p50 = m.p50 * (1 - a) + pctl(0.5) * a;
    m.p99 = m.p99 * (1 - a) + pctl(0.99) * a;
    m.staleRate = m.staleRate * (1 - a) + (readsOk > 0 ? Math.min(1, stale / readsOk) : 0) * a;
    m.botRps = demand.b;
    m.upkeep = upkeep;
    m.revenue = revenue;

    // one wave = one month: $/month rates are paid out over the wave's duration. You get your share of revenue, not all of it
    const k = dt / w.duration;
    this.money += (revenue * INFRA_BUDGET_SHARE - upkeep) * k;
    this.totalServed += success * dt;
    this.waveAgg.req += demandLegit * dt;
    this.waveAgg.ok += success * dt;
    this.waveAgg.earned += revenue * k;
    this.waveAgg.cost += upkeep * k;
    this.waveAgg.worstP99 = Math.max(this.waveAgg.worstP99, m.p99);

    // ---- reputation (SLA)
    let hurt = 0;
    if (m.errorRate > SLA.errorRate) hurt += Math.min(10, m.errorRate * 100) * 0.4;
    if (m.p99 > SLA.p99) hurt += Math.min(2, 1 + (m.p99 - SLA.p99) / 2000);
    if (m.staleRate > SLA.stale) hurt += Math.min(1, (m.staleRate - SLA.stale) * 4); // "I posted it and it's gone": milder than errors
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

  /** Acknowledged writes that never reached the DB. Users were told it worked: costs ~1 reputation per second of write traffic lost. */
  private loseWrites(n: number) {
    if (n <= 0) return;
    this.metrics.lostWrites += n;
    const wps = Math.max(1, this.wave.peakRps * this.wave.mix.w);
    this.reputation = Math.max(1, this.reputation - Math.min(15, n / wps));
  }

  private reject(src: number, wps: number) { this.rejected.set(src, (this.rejected.get(src) ?? 0) + wps); }

  /** Instance goes down. Caches lose their contents (and any unflushed write-back data). */
  private crash(n: SimNode, secs: number, why: string) {
    if (n.auto) {
      // an autoscaling group never goes down as a node: its serving instances fail health checks, and the policy
      // launches replacements for them right away (instances still booting weren't serving, so they survive)
      this.failInstances(n, this.active(n), secs);
      n.backlog = 0; n.inflight = 0;
      this.say(`${SPECS[n.kind].label} #${n.id} ${why.replace(/\s*Restarting\.\.\.$/, '')} The group replaces it (~${BOOT_S}s to boot).`, 'bad');
      return;
    }
    n.downFor = secs; n.outage = 0; n.backlog = 0; n.inflight = 0; n.instDown = [];
    let extra = '';
    if (n.kind === 'cache') {
      n.warm = 0;
      if (n.dirty > 0.5) {
        this.loseWrites(n.dirty);
        extra = ` ${fmt(n.dirty)} acknowledged writes were still unflushed in write-back mode: LOST.`;
      }
      n.dirty = 0;
    }
    this.say(`${SPECS[n.kind].label} #${n.id} ${why}${extra}`, 'bad');
  }

  /**
   * Target tracking (AWS ASG style): desired = ceil(serving × load per instance / target), clamped to [min, max]. Scale-out
   * launches instances right away, but they boot before taking traffic; instances still booting count toward desired,
   * so it doesn't launch twice for the same load. Scale-in is slower: half the excess per step, after a cooldown.
   * It only sees a smoothed metric, so a spike faster than the boot time is over before help arrives.
   */
  /**
   * The policy's metric: work arriving per serving instance, as a share of what one can handle (like ALB
   * RequestCountPerTarget). Unlike CPU it keeps rising past 100% when overloaded, so one step scales to the right size.
   */
  private loadPerInstance(n: SimNode) {
    const st = n.stats;
    return st.cpu * (st.servedRps > 0 ? Math.max(1, st.inRps / st.servedRps) : 1);
  }

  private autoscale(dt: number) {
    for (const n of this.nodes) {
      const a = n.auto;
      if (!a) continue;
      const s = this.scaler.get(n.id) ?? { work: 0, cool: AUTOSCALE_IN_COOLDOWN_S, fresh: true };
      this.scaler.set(n.id, s);
      s.cool = Math.max(0, s.cool - dt);
      const serving = this.active(n);
      if (s.fresh) {
        // first datapoint of the month: the group tracked the off-peak traffic before this, so it is already
        // the size that load needs (those instances were running, not booting)
        const st = n.stats;
        if (!serving || st.inRps <= 0) continue;
        s.fresh = false;
        s.work = serving * this.loadPerInstance(n);
        const start = clamp(Math.ceil(s.work / a.target - 1e-6), a.min, a.max);
        if (start > n.count) n.count = start;
        continue;
      }
      // while every instance is down there's no new datapoint: the policy acts on the last one it saw
      // smooth the total work (in instances' worth of capacity), not the per-instance load: total demand doesn't jump
      // when booted instances come online, so the policy doesn't count the same overload twice
      if (serving) s.work += (serving * this.loadPerInstance(n) - s.work) * Math.min(1, dt / AUTOSCALE_SMOOTH_S);
      const work = s.work;
      const want = clamp(Math.ceil(work / a.target - 1e-6), a.min, a.max);
      // scale in only to a size that would still sit below ~90% of the target, so it doesn't flap back out
      const keep = clamp(Math.ceil(work / (a.target * 0.9) - 1e-6), a.min, a.max);
      // crashed instances are unhealthy: they don't count toward capacity, so the group replaces them now
      // (once they recover, the extra instances get scaled back in, crashed ones first)
      const failed = n.instDown.filter((d) => !d.boot).length;
      const healthy = n.count - failed;
      if (want > healthy) {
        const k = want - healthy;
        // at max size, replacements take the failed instances' slots (terminate them first)
        for (let over = n.count + k - a.max; over > 0; over--) {
          const i = n.instDown.findIndex((d) => !d.boot);
          if (i < 0) break;
          n.instDown.splice(i, 1);
          n.count--;
        }
        this.launch(n, k);
        s.cool = AUTOSCALE_IN_COOLDOWN_S;
        this.say(`${SPECS[n.kind].label} #${n.id}: load ${pct(work / Math.max(1, serving))} per instance (target ${pct(a.target)}), autoscaling launched ${k} instance${k > 1 ? 's' : ''} (${n.count} total, booting ~${BOOT_S}s)`, 'info');
      } else if (keep < n.count && serving && s.cool <= 0 && !n.instDown.some((d) => d.boot)) {
        this.scaleIn(n, Math.ceil((n.count - keep) / 2)); // close half the gap per step: cautious, but not stuck oversized
        s.cool = AUTOSCALE_IN_COOLDOWN_S;
      }
    }
  }

  private chaos(dt: number) {
    const w = this.wave;
    if (w.chaos > 0 && Math.random() < w.chaos * dt) {
      // random instance failure: mostly app servers, sometimes a cache node
      // independent failures are weeks apart and a replacement takes minutes, so two rarely overlap in one group:
      // skip groups still replacing a crashed instance (a lone server has no such luck)
      const pool = this.nodes.filter((n) => n.downFor <= 0 && !n.instDown.some((d) => !d.boot) && (n.kind === 'server' || (n.kind === 'cache' && Math.random() < 0.35)));
      if (pool.length) {
        const v = pool[Math.floor(Math.random() * pool.length)];
        if (v.count > 1 && this.active(v) > 1) {
          // one instance of a group dies; the LB's health checks route around it
          this.failInstances(v, 1, 8 + Math.random() * 6);
          this.say(`${SPECS[v.kind].label} #${v.id}: 1 of ${v.count} instances crashed. The rest absorb its traffic while ${v.auto ? `a replacement boots (~${BOOT_S}s)` : 'it restarts'}.`, 'bad');
        } else this.crash(v, 8 + Math.random() * 6, v.kind === 'cache' ? 'crashed (node failure). It comes back empty: every read is a miss.' : 'crashed (instance failure). Restarting...');
      }
    }
    const e = w.event;
    if (e?.type === 'dbcrash' && this.time - dt < e.at && this.time >= e.at) {
      const db = this.nodes.find((n) => n.kind === 'database' && n.downFor <= 0);
      if (db) {
        db.downFor = e.len; db.outage = 0; db.backlog = 0;
        const reps = this.children(db, ['replica']);
        this.say(`Primary database #${db.id} hardware failure! Writes fail${reps.length ? `; replica #${reps[0].id} gets promoted in ~${FAILOVER_S}s` : ` for ${e.len}s (no replica to fail over to)`}.`, 'bad');
      }
    }
    for (const n of this.nodes) if (n.instDown.length) {
      for (const d of n.instDown) d.t -= dt;
      const back = n.instDown.filter((d) => d.t <= 0 && !d.boot).length;
      n.instDown = n.instDown.filter((d) => d.t > 0);
      if (!n.instDown.length) this.oomSaid.delete(n.id); // recovered: a new cascade gets logged again
      if (back) this.say(`${SPECS[n.kind].label} #${n.id}: instance back up (${this.active(n)}/${n.count} serving)`, 'good');
    }
    for (const n of this.nodes) if (n.downFor > 0) {
      n.downFor -= dt;
      n.outage += dt;
      if (n.downFor <= 0) {
        n.downFor = 0; n.outage = 0;
        if (n.kind === 'cache') n.warm = 0;
        this.say(`${SPECS[n.kind].label} #${n.id} is back up${n.kind === 'cache' ? ' (cold)' : n.kind === 'replica' && n.pending > 1 ? ', catching up on replication' : ''}`, 'good');
      }
    }
    // managed failover: promote the biggest healthy replica of a primary that's been down too long
    for (const db of this.nodes) {
      if (db.kind !== 'database' || db.downFor <= 1 || db.outage < FAILOVER_S) continue;
      const rep = this.children(db, ['replica']).filter((r) => r.downFor <= 0).sort((a, b) => b.tier - a.tier)[0];
      if (!rep) continue;
      const lost = rep.pending;
      [db.tier, rep.tier] = [rep.tier, db.tier];
      rep.downFor = db.downFor; rep.outage = 0; rep.pending = 0; rep.backlog = 0;
      db.downFor = 0; db.outage = 0; db.backlog = 0;
      this.loseWrites(lost);
      this.say(`Failover: replica #${rep.id} promoted to primary (the DB endpoint now points at it). ${lost >= 1 ? `${fmt(lost)} writes it hadn't replicated yet were lost.` : 'It was caught up, so nothing was lost.'} The failed box is rebuilt as the replica.`, lost >= 1 ? 'bad' : 'good');
    }
  }

  /** Kahn's algorithm. Cache-aside caches must run before the DBs their servers send misses to. */
  private topo(): SimNode[] {
    const adj = new Map<number, number[]>();
    for (const n of this.nodes) adj.set(n.id, []);
    for (const e of this.edges) adj.get(e.from)?.push(e.to);
    for (const c of this.nodes) if (c.kind === 'cache')
      for (const p of this.parents(c)) for (const d of this.children(p, ['database', 'replica'])) adj.get(c.id)!.push(d.id);
    const indeg = new Map<number, number>();
    for (const n of this.nodes) indeg.set(n.id, 0);
    for (const [, to] of adj) for (const t of to) indeg.set(t, (indeg.get(t) ?? 0) + 1);
    const q = this.nodes.filter((n) => indeg.get(n.id) === 0);
    const out: SimNode[] = [];
    while (q.length) {
      const n = q.shift()!;
      out.push(n);
      for (const t of adj.get(n.id)!) {
        const d = indeg.get(t)! - 1;
        indeg.set(t, d);
        if (d === 0) { const c = this.node(t); if (c) q.push(c); }
      }
    }
    for (const n of this.nodes) if (!out.includes(n)) out.push(n);
    return out;
  }

  /** Where reads go from a server/cache: primaries + replicas that have a replication link, weighted by capacity. */
  readTargets(n: SimNode) {
    return this.children(n, ['database', 'replica']).filter((c) => c.downFor <= 0 && (c.kind === 'database' || this.isSynced(c)));
  }

  writeTargets(n: SimNode) {
    return this.children(n, ['database']).filter((c) => c.downFor <= 0);
  }

  /**
   * Writes go to the shard that owns the key. A shard whose primary is down fails its share (async work is
   * handed back to its source) instead of spilling onto the other shards, which don't hold those rows.
   */
  private spreadWrites(io: IO, from: SimNode, flows: Flow[]) {
    const shards = this.children(from, ['database']);
    const ws = this.hotWeights(shards) ?? shards.map(() => 1);
    const s = ws.reduce((a, b) => a + b, 0) || 1;
    shards.forEach((d, i) => {
      const fs = flows.map((f) => part(f, null, ws[i] / s));
      if (d.downFor > 0) io.drop(from, fs, from.kind === 'worker' ? `Shard #${d.id} primary down: its jobs go back to the queue` : `Shard #${d.id} primary down: writes for its keys fail`);
      else for (const f of fs) io.send(from, d, f);
    });
  }

  /** The shard that owns the celebrity's key during a hot-key event: the first primary. */
  private hotShard() { return this.nodes.find((n) => n.kind === 'database'); }

  /**
   * Hot key: a fixed share of the traffic is for ONE key, so its shard takes that share plus its even cut of
   * the rest. More shards shrink the even cut but never the hot share (1 shard: 100%, 2: 68%, 4: 51%, 8: 43%).
   * `shards` are primaries; undefined weights mean an even split.
   */
  private hotWeights(shards: SimNode[]) {
    const hot = this.hotShard();
    if (this.wave.event?.type !== 'hotkey' || shards.length < 2 || !hot || !shards.includes(hot)) return undefined;
    const even = (1 - HOT_KEY_SHARE) / shards.length;
    return shards.map((d) => (d === hot ? HOT_KEY_SHARE + even : even));
  }

  /**
   * Reads go to the shard that owns the key (an even split, skewed by a hot key unless a cache in front
   * absorbs the hot key's reads), then across that shard's live primary + replicas by capacity. A replica
   * only holds its own shard's rows, so it can't take reads for another shard.
   */
  private spreadReads(io: IO, from: SimNode, flows: Flow[], hotKey: boolean) {
    const shards = new Map<SimNode, SimNode[]>();
    for (const c of this.children(from, ['database', 'replica'])) {
      const primary = c.kind === 'database' ? c : this.parents(c).find((p) => p.kind === 'database');
      if (!primary) continue; // not replicating: holds no data
      if (!shards.has(primary)) shards.set(primary, []);
      if (c.downFor <= 0) shards.get(primary)!.push(c);
    }
    if (!shards.size) return false;
    const keys = [...shards.keys()];
    const ws = (hotKey && this.hotWeights(keys)) || keys.map(() => 1 / keys.length);
    keys.forEach((d, i) => {
      const fs = flows.map((f) => part(f, null, ws[i]));
      const live = shards.get(d)!;
      const reps = live.filter((c) => c.kind === 'replica'), primary = live.find((c) => c.kind === 'database');
      if (!live.length) io.drop(from, fs, `Shard #${d.id} is down with no replica: reads for its keys fail`);
      else if (!reps.length || !primary) io.spread(from, fs, live, live.map((c) => this.cap(c))); // nothing to split
      else {
        // read/write split: replicas take the reads (up to what replaying writes leaves them), so the
        // primary's capacity goes to writes; only overflow from undersized replicas reaches the primary
        const want = sum(fs, total);
        const room = reps.map((r) => Math.max(0, (r.room < 0 ? this.cap(r) * 0.85 : r.room) - (this.readsTo.get(r.id) ?? 0)));
        const free = room.reduce((a, b) => a + b, 0);
        const toReps = Math.min(want, free);
        if (toReps > 0) reps.forEach((r, j) => {
          const k = (toReps * room[j]) / free / want;
          this.readsTo.set(r.id, (this.readsTo.get(r.id) ?? 0) + want * k);
          for (const f of fs) io.send(from, r, part(f, null, k));
        });
        if (want > toReps) for (const f of fs) io.send(from, primary, part(f, null, 1 - toReps / want));
      }
    });
    return true;
  }

  private weight(n: SimNode) { const c = this.cap(n); return isFinite(c) ? c : 1e6; }

  private processNode(n: SimNode, flows: Flow[], dt: number, io: IO) {
    const spec = SPECS[n.kind];
    const tier = this.tierOf(n);
    const st = n.stats;
    const inMix = zero();
    for (const f of flows) add(inMix, f.mix);
    st.inRps = total(inMix);
    const usage = (reqPerSec: number) => { if (tier.perM) st.cost += (tier.perM * reqPerSec * SECONDS_PER_MONTH) / 1e6; };

    if (n.downFor > 0 || ((n.count > 1 || n.instDown.length) && !this.active(n))) {
      if (n.kind === 'replica') n.pending += sum(flows.filter((f) => f.async), (m) => m.w) * dt; // catches up from WAL after restart
      io.drop(n, n.kind === 'replica' ? flows.filter((f) => !f.async) : flows, n.downFor > 0 ? `DOWN (${Math.ceil(n.downFor)}s)` : 'Every instance is down');
      this.describe(n);
      return;
    }

    // ---- users: no capacity, just the network
    if (n.kind === 'users') {
      st.servedRps = st.inRps;
      const kids = this.children(n);
      const cdns = kids.filter((k) => k.kind === 'cdn'), origin = kids.filter((k) => k.kind !== 'cdn');
      if (!kids.length) { io.drop(n, flows, 'Not connected to anything!'); return; }
      const viaCdn: (keyof Mix)[] = !origin.length ? ['s', 'r', 'w', 'b'] : cdns.some((c) => c.cdnApi) ? ['s', 'r', 'b'] : ['s'];
      const direct = (['s', 'r', 'w', 'b'] as (keyof Mix)[]).filter((k) => !viaCdn.includes(k));
      for (const f of flows) {
        const g = GEO[f.geo ?? 0];
        if (cdns.length) io.spread(n, [part(f, viaCdn, 1, g.edge)], cdns);
        if (origin.length) io.spread(n, [part(f, cdns.length ? direct : null, 1, g.rtt)], origin); // DNS round-robin: no health checks
      }
      return;
    }

    // ---- queue: ingest acks writes, then drains to workers
    if (n.kind === 'queue') {
      const cap = this.cap(n);
      const lat = tier.lat ?? spec.latency;
      const workers = this.children(n, ['worker']).filter((x) => x.downFor <= 0);
      const workerCap = workers.reduce((a, x) => a + this.cap(x), 0);
      // Workers block on the DB: when it pushed jobs back last tick, they only get through what it accepted.
      // Otherwise they ramp back up toward full speed.
      const p = this.pace.get(n.id) ?? { rate: workerCap, pulled: 0, back: 0 };
      p.rate = p.back > 0 ? Math.max(workerCap * 0.02, (p.pulled - p.back) * 1.05) : Math.min(workerCap, p.rate * 1.3 + workerCap * 0.02);
      p.back = 0;
      const pull = Math.min(workerCap, p.rate);
      // a full queue refuses new messages (the producer gets an error), it never silently drops acknowledged ones
      const maxBacklog = cap * spec.queueSeconds;
      const room = Math.max(0, maxBacklog - n.backlog) / dt + pull;
      const ingest = flows.filter((f) => !f.async);
      const inW = sum(ingest, total);
      const limit = Math.min(cap, room);
      const keep = inW > limit ? limit / inW : 1;
      if (keep < 1) io.drop(n, ingest.map((f) => part(f, null, 1 - keep)), limit < cap ? 'Queue full: refusing writes' : 'Ingest limit hit');
      for (const f of ingest) io.done.push(part(f, null, keep, lat));
      n.backlog += inW * keep * dt;
      const drained = Math.min(n.backlog, pull * dt);
      p.pulled = drained / dt;
      this.pace.set(n.id, p);
      n.backlog -= drained;
      st.util = st.cpu = inW / cap;
      st.servedRps = inW * keep;
      st.latency = lat;
      usage(inW);
      if (drained > 0) io.spread(n, [{ mix: { s: 0, r: 0, w: drained / dt, b: 0 }, lat: 0, async: true, src: n.id }], workers, workers.map((x) => this.cap(x)));
      const eta = pull < workerCap * 0.1 ? workerCap : pull; // while the DB is down, assume it drains at full speed once it's back
      // until a queued write lands, reads don't see it (and cache-aside re-caches the old row after the server's DEL)
      const lag = (st.lag = n.backlog / Math.max(1, workers.length ? pull : inW) + 0.05); // with no consumer: age of the oldest message
      for (const s of this.parents(n)) {
        const qs = this.children(s, ['queue']).filter((q) => q.downFor <= 0).length || 1;
        st.stale += ((this.serverReads.get(s.id) ?? 0) / qs) * FRESH_READ_SHARE * ASYNC_WRITE_SHARE * (1 - Math.exp(-lag * 0.15));
      }
      if (!this.children(n, ['worker']).length) st.note = 'No workers: messages pile up until they expire';
      else if (n.backlog > eta * 5) st.note = `Backlog ${Math.round(n.backlog / Math.max(1, eta))}s behind${pull < workerCap * 0.9 ? ' (DB is the limit)' : ''}`;
      this.describe(n, { pull: eta });
      return;
    }

    // ---- pre-capacity filtering
    let pass = flows;
    if (n.kind === 'ratelimiter') {
      pass = flows.map((f) => ({ ...f, mix: { ...f.mix, b: f.mix.b * 0.05 } })); // 429 for ~95% of bots
      const blocked = inMix.b * 0.95;
      if (blocked > 1) st.note = `Blocked ${fmt(blocked)} bot req/s`;
    }
    const isDb = n.kind === 'database' || n.kind === 'replica';
    if (isDb) {
      // Postgres refuses connections past max_connections
      const maxC = maxConnections(tier.ram);
      if (n.conns > maxC) {
        const keepC = maxC / n.conns;
        const live = pass.filter((f) => !f.async);
        io.drop(n, live.map((f) => part(f, null, 1 - keepC)), `Too many connections (${fmt(n.conns)}/${fmt(maxC)})`);
        pass = [...live.map((f) => part(f, null, keepC)), ...pass.filter((f) => f.async)];
      }
    }

    // ---- capacity / queueing model
    // Databases serve live (sync) traffic first; async work (queue workers, write-back flushes, replication)
    // only gets leftover capacity and is pushed back instead of dropped (backpressure).
    const live = isDb || n.kind === 'cache' ? pass.filter((f) => !f.async) : pass;
    const bg = n.kind === 'database' ? pass.filter((f) => f.async) : [];
    const ops = n.kind === 'cache' ? pass.filter((f) => f.async) : []; // cache DEL ops (invalidations)
    const repl = n.kind === 'replica' ? pass.filter((f) => f.async) : [];
    const cap = this.cap(n);
    const rd = (m: Mix) => m.r + m.b;

    // per-kind work units and secondary resources (NIC bandwidth, disk IOPS)
    let units: (fs: Flow[]) => number = (fs) => sum(fs, total);
    let dim = 0, dimCap = 0, dimName = '';
    let base = spec.latency;
    let hit = 0;
    const buf = isDb ? this.bufferPool(n) : null;
    const liveR = sum(live, rd), liveW = sum(live, (m) => m.w);
    if (n.kind === 'server') {
      const queued = this.children(n, ['queue']).some((q) => q.downFor <= 0);
      const wCpu = queued ? ASYNC_WRITE_SHARE * ENQUEUE_CPU + (1 - ASYNC_WRITE_SHARE) : 1; // queued writes: validate + enqueue only
      units = (fs) => sum(fs, (m) => m.s * SERVER_STATIC_CPU + m.r + m.b + m.w * wCpu);
    }
    const batched = (f: Flow) => !!f.async && f.src != null && this.node(f.src)?.kind === 'queue';
    if (n.kind === 'database') units = (fs) => fs.reduce((a, f) => a + rd(f.mix) + f.mix.w * (batched(f) ? BATCH_WRITE_COST : spec.writeCost), 0);
    if (n.kind === 'cache') {
      const reads = liveR;
      const wr = reads > 0 ? (liveW + sum(ops, total)) / reads : 0;
      hit = this.cacheHit(n, wr);
      st.hitRate = hit;
      units = (fs) => sum(fs, (m) => rd(m) * (2 - hit) + m.w); // GET, SET on miss, SET/DEL on write
    }
    if (tier.net && (n.kind === 'server' || n.kind === 'loadbalancer' || n.kind === 'ratelimiter')) {
      dim = sum(pass, (m) => m.s * STATIC_KB + (m.r + m.w + m.b) * API_KB) / 1000;
      dimCap = tier.net * Math.max(1, this.active(n)); dimName = 'NIC';
    }
    if (n.kind === 'loadbalancer' || n.kind === 'ratelimiter') base = tier.vcpu ? 0.5 : spec.latency;
    let applyNeed = 0;
    if (buf) {
      const miss = 1 - buf.hit;
      base += miss * PAGES_PER_READ * DISK_MS;
      const bgB = bg.filter(batched).reduce((a, f) => a + f.mix.w, 0), bgW = sum(bg, (m) => m.w) - bgB;
      n.pending += sum(repl, (m) => m.w) * dt;
      applyNeed = n.pending * REPLICA_APPLY_COST; // work units to catch up fully
      dim = liveR * miss * PAGES_PER_READ + (liveW + bgW) * 1.5 + bgB * BATCH_WRITE_IOPS + Math.min(applyNeed / dt, cap) / REPLICA_APPLY_COST;
      dimCap = tier.iops!; dimName = 'disk';
      st.hitRate = buf.hit;
    }
    const load = units(live) + sum(ops, total);
    const bgLoad = units(bg);
    const uCpu = (load + bgLoad + (applyNeed > 0 ? Math.min(applyNeed / dt, cap) : 0)) / cap;
    const uDim = dimCap ? dim / dimCap : 0;
    const effCap = uDim > uCpu && uDim > 0 ? (cap * uCpu) / uDim : cap; // a saturated NIC / disk caps throughput

    const reserve = n.kind === 'replica' ? Math.min(applyNeed, 0.25 * effCap * dt) : 0; // WAL replay isn't starved
    const arrivals = load * dt;
    const totalWork = arrivals + n.backlog;
    const served = Math.min(totalWork, effCap * dt - reserve);
    let remaining = totalWork - served;
    const maxQ = effCap * spec.queueSeconds;
    let dropped = 0;
    if (remaining > maxQ) { dropped = remaining - maxQ; remaining = maxQ; }
    n.backlog = remaining;
    const passFrac = arrivals > 0 ? Math.min(1, served / arrivals) : 0;
    const dropFrac = arrivals > 0 ? Math.min(1, dropped / arrivals) : 0;
    const spare = Math.max(0, effCap * dt - reserve - served);
    const bgFrac = bgLoad > 0 ? Math.min(1, spare / (bgLoad * dt)) : 0;
    let applied = 0;
    if (n.kind === 'replica') {
      applied = Math.min(applyNeed, reserve + spare); n.pending = Math.max(0, n.pending - applied / REPLICA_APPLY_COST);
      const room = Math.max(0, effCap * 0.85 - sum(repl, (m) => m.w) * REPLICA_APPLY_COST); // a saturated disk shrinks effCap too
      n.room = n.room < 0 ? room : n.room * 0.7 + room * 0.3;
    }
    const used = served / dt + bgLoad * bgFrac + applied / dt;
    // what the work is spent on, for the inspector (live reads vs writes vs replaying the primary's writes)
    const work = isDb ? { r: liveR * passFrac, w: (load - liveR) * passFrac + bgLoad * bgFrac, wps: liveW * passFrac + sum(bg, (m) => m.w) * bgFrac, repl: applied / dt } : undefined;
    const u = isFinite(cap) ? Math.max(used / effCap, uDim) : 0;
    st.util = u;
    st.cpu = isFinite(cap) ? Math.min(used, cap) / cap : 0;
    const wait = isFinite(effCap) ? (n.backlog / effCap) * 1000 : 0;
    const svc = base * (1 + 2 * Math.pow(Math.min(u, 1), 3));
    const nodeLat = svc + wait;
    st.latency = nodeLat;
    st.servedRps = st.inRps * passFrac;
    if (dropFrac > 0) io.drop(n, live.map((f) => part(f, null, dropFrac)), load > effCap ? (uDim > uCpu ? `${dimName === 'NIC' ? 'NIC saturated' : 'Disk-bound (IOPS maxed)'}! Dropping requests` : 'Overloaded! Dropping requests') : undefined);
    else if (bgLoad > 0 && bgFrac < 1) {
      for (const f of bg) if (f.src != null) this.reject(f.src, f.mix.w * (1 - bgFrac));
      st.note = 'Throttling async writes (backpressure)';
    } else if (u > 0.9) st.note = uDim > uCpu ? (dimName === 'NIC' ? 'NIC almost saturated' : 'Disk-bound: working set > RAM') : 'Running hot';
    const out = live.map((f) => part(f, null, passFrac, nodeLat));
    let surcharge = 0;
    if (tier.baseline != null && tier.surplus) {
      surcharge = Math.max(0, st.cpu - tier.baseline) * tier.vcpu * Math.max(1, this.active(n)) * HOURS_PER_MONTH * tier.surplus;
      st.cost += surcharge;
    }

    // ---- routing
    switch (n.kind) {
      case 'loadbalancer':
      case 'ratelimiter':
      case 'cdn': {
        let fwd = out;
        usage(st.inRps);
        if (n.kind === 'cdn') {
          n.warm = Math.min(1, n.warm + dt * 0.4); // edges warm up in seconds
          const hs = 0.95 * (0.3 + 0.7 * n.warm);
          const hr = n.cdnApi ? CDN_API_CACHEABLE * 0.85 * (0.3 + 0.7 * n.warm) : 0;
          st.hitRate = st.inRps > 0 ? (inMix.s * hs + rd(inMix) * hr) / st.inRps : hs;
          for (const f of out) {
            io.done.push({ ...f, mix: { s: f.mix.s * hs, r: f.mix.r * hr, w: 0, b: f.mix.b * hr } });
            st.stale += f.mix.r * hr * 0.1; // ~10% of TTL-cached responses are older than the latest write
          }
          // misses ride the provider's backbone to your origin
          fwd = out.map((f) => ({ ...f, mix: { s: f.mix.s * (1 - hs), r: f.mix.r * (1 - hr), w: f.mix.w, b: f.mix.b * (1 - hr) }, lat: f.lat + GEO[f.geo ?? 0].rtt * 0.85 }));
        }
        const kids = this.children(n);
        const up = kids.filter((k) => this.active(k) > 0); // health checks: skip crashed backends
        if (!kids.length) io.drop(n, fwd, n.kind === 'cdn' ? 'No origin: misses fail' : 'No downstream connection!');
        else if (!up.length) {
          const boot = Math.min(...kids.flatMap((k) => k.instDown.filter((d) => d.boot).map((d) => d.t)));
          io.drop(n, fwd, isFinite(boot) ? `All backends down: replacements still booting (~${Math.ceil(boot)}s). Run 2+ instances so one failure isn't an outage` : 'All backends down!');
        }
        else io.spread(n, fwd, up, up.map((k) => this.weight(k)));
        break;
      }
      case 'server': {
        io.done.push(...out.map((f) => ({ ...part(f, ['s']), lat: f.lat - nodeLat + wait + SERVER_STATIC_MS })));
        const reads = out.map((f) => part(f, ['r', 'b']));
        const writes = out.map((f) => part(f, ['w']));
        const cacheKids = this.children(n, ['cache']);
        const caches = cacheKids.filter((c) => c.downFor <= 0);
        const rt = this.readTargets(n);
        const ramW = (cs: SimNode[]) => cs.map((c) => this.tierOf(c).ram);
        if (!this.children(n, ['database', 'replica', 'cache', 'queue']).length) { io.drop(n, [...reads, ...writes], 'No database connected: reads/writes fail'); break; }
        // reads: cache first (keys sharded across caches by memory); if every cache is down, straight to the DB
        if (caches.length) io.spread(n, reads, caches, ramW(caches));
        else if (rt.length) { this.spreadReads(io, n, reads, true); if (cacheKids.length) st.note = 'Cache down: every read hits the DB'; }
        else io.drop(n, reads, cacheKids.length ? 'Cache down and no DB link to fall back to' : 'No healthy place to read from');
        // writes
        const qs = this.children(n, ['queue']).filter((c) => c.downFor <= 0);
        const wt = this.writeTargets(n);
        const thru = caches.filter((c) => c.strategy === 'writethrough' || c.strategy === 'writeback');
        const inval = caches.filter((c) => c.strategy === 'aside' || c.strategy === 'readthrough');
        // only some writes can wait (posts, likes, order intake); payments and unique/stock checks stay synchronous
        const syncW = qs.length ? writes.map((f) => part(f, null, 1 - ASYNC_WRITE_SHARE)) : writes;
        if (qs.length) io.spread(n, writes.map((f) => part(f, null, ASYNC_WRITE_SHARE)), qs);
        if (thru.length) io.spread(n, syncW, thru, ramW(thru));
        else if (wt.length) this.spreadWrites(io, n, syncW);
        else if (cacheKids.some((c) => c.strategy === 'writethrough' || c.strategy === 'writeback')) io.drop(n, syncW, 'Write cache is down: writes fail');
        else if (qs.length && !this.children(n, ['database']).length) io.drop(n, syncW, `~${pct(1 - ASYNC_WRITE_SHARE)} of writes can't wait (payments, unique checks): connect Server → Database`);
        else io.drop(n, syncW, this.children(n, ['database']).length ? 'Primary DB down: writes fail' : inval.length ? `${CACHE_STRATEGIES[inval[0].strategy].label}: writes need a Server → Database link` : 'No primary DB for writes');
        this.serverReads.set(n.id, sum(out, (m) => m.r));
        // cache-aside / read-through: invalidate the key after writing (DEL op)
        const wps = sum(writes, (m) => m.w);
        if (inval.length && wps > 0 && !thru.length) io.spread(n, [{ mix: { s: 0, r: 0, w: wps, b: 0 }, lat: 0, async: true }], inval, ramW(inval));
        break;
      }
      case 'cache': {
        n.warm = st.inRps > 0 ? Math.min(1, n.warm + dt * 0.1) : Math.max(0, n.warm - dt * 0.01);
        if (n.warm < 0.9) st.note = st.note || `Warming up (${pct(n.warm)})`;
        for (const f of out) io.done.push(part(f, ['r', 'b'], hit));
        const misses = out.map((f) => part(f, ['r', 'b'], 1 - hit));
        if (n.strategy === 'aside') {
          // the app got a miss: it queries the DB itself (over its own Server → DB link), then SETs the key
          const ps = this.parents(n).filter((p) => p.kind === 'server');
          const shares = ps.map((p) => this.edge(p, n)?.sync ?? 0);
          const tot = shares.reduce((a, b) => a + b, 0) || 1;
          ps.forEach((p, i) => {
            const fs = misses.map((f) => part(f, null, shares[i] / tot));
            const rt = this.readTargets(p);
            if (rt.length) this.spreadReads(io, p, fs, false); // the hot key itself stays cached: misses are the long tail
            else io.drop(n, fs, 'Cache-aside miss: Server has no DB link');
          });
        } else {
          const rt = this.readTargets(n);
          if (rt.length) this.spreadReads(io, n, misses, false);
          else io.drop(n, misses, `${CACHE_STRATEGIES[n.strategy].label}: connect Cache → Database`);
        }
        const writes = out.map((f) => part(f, ['w']));
        const wt = this.writeTargets(n);
        if (n.strategy === 'writethrough') {
          if (wt.length) this.spreadWrites(io, n, writes);
          else io.drop(n, writes, 'Write-through: connect Cache → Database (primary)');
        } else if (n.strategy === 'writeback') {
          for (const f of writes) io.done.push(f);
          n.dirty += sum(writes, (m) => m.w) * dt;
        }
        // write-back: flush dirty keys asynchronously (~every second), merging repeated writes
        if (n.dirty > 0) {
          if (wt.length) {
            const flush = Math.min(n.dirty, n.dirty * dt + 1);
            n.dirty -= flush;
            this.spreadWrites(io, n, [{ mix: { s: 0, r: 0, w: (flush / dt) * WRITEBACK_COALESCE, b: 0 }, lat: 0, async: true, src: n.id }]);
          } else st.note = 'Write-back has no DB to flush to!';
        }
        break;
      }
      case 'database':
      case 'replica': {
        if (n.kind === 'replica' && !this.isSynced(n)) { io.drop(n, out, 'Not replicating! Needs a Database → Replica link'); break; }
        for (const f of out) {
          io.done.push(part(f, ['r', 'b']));
          if (f.mix.w > 0) io.done.push(part(f, ['w'], 1, DB_WRITE_MS - spec.latency));
        }
        if (n.kind === 'replica') {
          const lag = (st.lag = this.lag(n, sum(repl, (m) => m.w)));
          st.stale += sum(out, (m) => m.r) * FRESH_READ_SHARE * (1 - Math.exp(-lag * 0.15));
        } else {
          // async replication: ship every committed write to each replica
          const reps = this.children(n, ['replica']);
          const wr = sum(out, (m) => m.w) + sum(bg, (m) => m.w) * bgFrac;
          if (wr > 0) for (const r of reps) io.send(n, r, { mix: { s: 0, r: 0, w: wr, b: 0 }, lat: 0, async: true });
        }
        break;
      }
      case 'worker': {
        const wt = this.writeTargets(n);
        if (wt.length) this.spreadWrites(io, n, out);
        else io.drop(n, out, this.children(n).length ? 'Primary DB down: jobs go back to the queue' : 'No database to write to');
        break;
      }
    }
    this.describe(n, { hit, buf, dim, dimCap, dimName, uCpu, uDim, surcharge, work });
  }

  /** replication lag in seconds: un-applied writes / incoming write rate (plus ~20ms of shipping) */
  private lag(n: SimNode, inRate: number) { return 0.02 + n.pending / Math.max(1, inRate); }

  /** response times (Little's law), memory, OOM kills and DB connection pools, after all traffic moved */
  private afterTick(order: SimNode[]) {
    for (const n of [...order].reverse()) {
      const st = n.stats;
      let down = 0;
      if (st.inRps > 0) for (const e of this.edges) if (e.from === n.id && n.kind !== 'users') down += (e.sync / st.inRps) * (this.node(e.to)?.resp ?? 0);
      const r = Math.min(TIMEOUT_MS, st.latency + down);
      n.resp = n.downFor > 0 ? 0 : n.resp ? n.resp * 0.8 + r * 0.2 : r;
    }
    for (const n of this.nodes) {
      if (n.kind !== 'server' && n.kind !== 'worker') continue;
      const t = this.tierOf(n);
      const now = n.downFor > 0 ? 0 : n.stats.servedRps * (n.resp / 1000) + n.backlog;
      n.inflight = n.inflight * 0.7 + now * 0.3;
      const baseGB = 0.4 + 0.1 * t.ram;
      const inst = Math.max(1, this.active(n)), each = n.inflight / inst; // a group shares the load evenly
      const per = n.count > 1 ? ' per instance' : '';
      n.stats.ram = n.downFor > 0 ? 0 : baseGB + (each * REQ_MB) / 1024;
      n.stats.ramWhy = `${gb(baseGB)} OS + runtime, plus ${fmt(each)} in-flight requests × ${REQ_MB} MB${per}. In-flight = ${fmt(n.stats.servedRps)} req/s × ${ms(n.resp)} response time (Little's law)${n.count > 1 ? `, split over ${inst} instances` : ''}, so a slow DB fills RAM.`;
      n.stats.rows.splice(n.stats.rows[0]?.[0] === 'CPU' ? 1 : 0, 0, [`RAM${per}`, `${gb(n.stats.ram)} / ${gb(t.ram)}`, n.stats.ram > t.ram * 0.85], ['In-flight', fmt(n.inflight)]);
      if (n.count > 1) n.stats.rows.unshift(['Instances', `${this.active(n)} / ${n.count} serving`, this.active(n) < n.count]);
      if (n.kind !== 'server' || n.downFor > 0 || n.stats.ram <= t.ram) continue;
      const why = `OOM-killed: ${fmt(each)} requests in flight per instance (${ms(n.resp)} each) needed ${gb(n.stats.ram)} of ${gb(t.ram)} RAM.`;
      if (this.isGroup(n) && this.active(n) > 1) {
        // instances never fill up in the same instant: the most loaded one dies first, its in-flight requests fail,
        // and the LB moves its traffic to the rest, which pushes them closer to the limit (a cascade over a few seconds)
        this.failInstances(n, 1, OOM_RESTART_S);
        n.inflight = Math.max(0, n.inflight - each);
        const left = this.active(n);
        if (!this.oomSaid.has(n.id)) this.say(`${SPECS[n.kind].label} #${n.id}: an instance was ${why} Its traffic moves to the other ${left}, which are just as full: they will follow unless load drops or capacity arrives.`, 'bad');
        this.oomSaid.add(n.id);
      } else this.crash(n, OOM_RESTART_S, `${why} Restarting...`);
    }
    for (const d of this.nodes) {
      if (d.kind !== 'database' && d.kind !== 'replica') continue;
      let conns = 0, needed = 0;
      for (const e of this.edges) {
        if (e.to !== d.id) continue;
        const p = this.node(e.from);
        if (!p || p.downFor > 0) continue;
        if (p.kind === 'database') { conns += 1; continue; } // replication stream
        const need = total(e.rps) * (d.resp / 1000);
        const vc = Math.max(2, this.tierOf(p).vcpu);
        const procs = Math.max(1, p.count - p.instDown.length);
        conns += clamp(Math.ceil(need * 1.5), 10 * vc * procs, 40 * vc * procs); // one pool per process, ~10 conns per vCPU minimum
        needed += need;
      }
      if (d.pooler) conns = Math.min(conns, Math.ceil(needed * 1.2) + 20);
      d.conns = d.downFor > 0 ? 0 : conns;
    }
  }

  /** Inspector rows + RAM explanation for a node. */
  private describe(n: SimNode, x: { hit?: number; buf?: ReturnType<World['bufferPool']> | null; dim?: number; dimCap?: number; dimName?: string; uCpu?: number; uDim?: number; pull?: number; surcharge?: number; work?: { r: number; w: number; wps: number; repl: number } } = {}) {
    const st = n.stats, t = this.tierOf(n), rows = st.rows;
    const R = (k: string, v: string, bad?: boolean) => rows.push([k, v, bad]);
    if (x.dimCap) R(x.dimName === 'NIC' ? 'Network' : 'Disk IOPS', x.dimName === 'NIC' ? `${fmt(x.dim!)} / ${fmt(x.dimCap)} MB/s` : `${fmt(x.dim!)} / ${fmt(x.dimCap)}`, x.dim! > x.dimCap * 0.9);
    switch (n.kind) {
      case 'database':
      case 'replica': {
        const b = x.buf ?? this.bufferPool(n);
        const maxC = maxConnections(t.ram);
        st.ram = Math.min(t.ram, t.ram * 0.1 + b.connGB + Math.min(b.pool, b.ws));
        st.ramWhy = `Page cache ${gb(b.pool)} vs working set ${gb(b.ws)} (hot rows + indexes for ${fmt(this.peakUsers())} users${this.nodes.filter((q) => q.kind === 'database').length > 1 ? ', this shard' : ''}). ${b.ws > b.pool ? `It doesn't fit: ${pct(1 - b.hit)} of page reads go to disk.` : 'It fits: reads come from memory.'} Connections: ${fmt(n.conns)} × ${PG_CONN_MB} MB = ${gb(b.connGB)}.`;
        rows.unshift(['RAM', `${gb(st.ram)} / ${gb(t.ram)}`, b.ws > b.pool], ['Page hits', pct(b.hit), b.hit < 0.9]);
        R('Connections', `${fmt(n.conns)} / ${fmt(maxC)}`, n.conns > maxC * 0.85);
        const wk = x.work, c = this.cap(n);
        if (wk && c > 0) {
          R('CPU on reads', `${pct(wk.r / c)} · ${fmt(wk.r)}/s`);
          if (n.kind === 'database') R('CPU on writes', `${pct(wk.w / c)} · ${fmt(wk.wps)}/s (a write ≈ ${SPECS.database.writeCost}× a read)`, wk.w > c * 0.6);
          else R('CPU replaying', `${pct(wk.repl / c)} · ${fmt(wk.repl / REPLICA_APPLY_COST)} writes/s from the primary`, wk.repl > c * 0.5);
        }
        if (n.pooler) R('Pooler', 'RDS Proxy');
        if (n.kind === 'replica') {
          const lag = st.lag;
          R('Replication lag', lag >= 1 ? `${lag.toFixed(1)}s` : `${Math.round(lag * 1000)}ms`, lag > 1);
          if (st.stale > 0.5) R('Stale reads', `${fmt(st.stale)}/s`, true);
        }
        break;
      }
      case 'cache': {
        const usable = t.ram * CACHE_USABLE, hot = this.cacheHotSet(n);
        const filled = n.warm * Math.min(usable, hot);
        st.ram = filled + 0.05;
        st.ramWhy = `${gb(usable)} usable of ${gb(t.ram)} (ElastiCache reserves ~25%). Hot data for ${fmt(this.peakUsers())} users is ${gb(hot)}${this.nodes.filter((c) => c.kind === 'cache').length > 1 ? ' (this node\'s key share)' : ''}. ${hot > usable ? `Only ${pct(usable / hot)} of it fits: the long tail misses and gets evicted (LRU).` : 'It all fits.'}${n.warm < 0.95 ? ` Warming up: ${pct(n.warm)} loaded.` : ''}`;
        rows.unshift(['RAM', `${gb(st.ram)} / ${gb(t.ram)}`, hot > usable], ['Hit rate', pct(st.hitRate), st.hitRate < 0.7]);
        R('Strategy', CACHE_STRATEGIES[n.strategy].label);
        if (hot > usable && n.warm > 0.9) R('Evictions', `${fmt(st.inRps * (1 - st.hitRate))}/s`);
        if (n.strategy === 'writeback') R('Unflushed', `${fmt(n.dirty)} writes`, n.dirty > 500);
        break;
      }
      case 'queue': {
        R('Backlog', `${fmt(n.backlog)} msgs`, n.backlog > 1000);
        R('Write lag', st.lag >= 1 ? `${st.lag.toFixed(1)}s` : `${Math.round(st.lag * 1000)}ms`, st.lag > 1);
        if (st.stale > 0.5) R('Stale reads', `${fmt(st.stale)}/s`, true);
        if (x.pull) R('Oldest msg', `${ms((n.backlog / x.pull) * 1000)}`, n.backlog / x.pull > 5);
        break;
      }
      case 'cdn': R('Hit rate', pct(st.hitRate)); if (n.cdnApi) R('TTL', `${CDN_TTL_S}s (stale ≤ ${CDN_TTL_S}s)`); break;
      default:
        if (n.kind !== 'users' && n.kind !== 'server' && n.kind !== 'worker' && t.ram) { st.ram = 0.3 + (t.ram * 0.05); st.ramWhy = 'Proxies hold little state: connection buffers only.'; rows.unshift(['RAM', `${gb(st.ram)} / ${gb(t.ram)}`]); }
    }
    if (n.kind !== 'users' && isFinite(t.cap)) rows.unshift(['CPU', pct(Math.min(1, st.cpu)), st.cpu > 0.85]);
    if (t.perM) R('Bill', `$${Math.round(st.cost).toLocaleString()}/mo`);
    if (t.baseline != null) R('CPU credits', x.surcharge! >= 1 ? `+$${Math.round(x.surcharge!).toLocaleString()}/mo above ${pct(t.baseline)} baseline` : `within ${pct(t.baseline)} baseline`, x.surcharge! > t.cost);
  }
}

function blankStats(): NodeStats {
  return { inRps: 0, servedRps: 0, dropRps: 0, util: 0, cpu: 0, latency: 0, hitRate: 0, ram: 0, note: '', rows: [], ramWhy: '', stale: 0, cost: 0, lag: 0 };
}

export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1);
}
