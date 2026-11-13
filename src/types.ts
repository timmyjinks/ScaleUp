export type NodeKind =
  | 'users'
  | 'server'
  | 'database'
  | 'loadbalancer'
  | 'cache'
  | 'cdn'
  | 'replica'
  | 'queue'
  | 'worker'
  | 'ratelimiter';

/** Traffic classes. Every flow is a vector over these. */
export interface Mix {
  /** static assets (images, js, css) */
  s: number;
  /** reads (GET /feed) */
  r: number;
  /** writes (POST /order) */
  w: number;
  /** bot / abusive traffic */
  b: number;
}

/** A chunk of traffic that has accumulated `lat` ms of latency so far. */
export interface Flow {
  mix: Mix;
  lat: number;
  /** async flows (queue -> worker -> db, replication, cache ops) don't count toward user latency/success */
  async?: boolean;
  /** user geography bucket (index into GEO); decides network RTT */
  geo?: number;
  /** node that owns this async work; rejected work is handed back to it (backpressure) */
  src?: number;
}

/** How the app uses a cache. */
export type CacheStrategy = 'aside' | 'readthrough' | 'writethrough' | 'writeback';

export interface SimNode {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  tier: number; // 0-based index into spec tiers
  // --- settings ---
  strategy: CacheStrategy; // caches
  cdnApi: boolean; // CDN also caches public GET responses
  pooler: boolean; // database/replica: connection pooler (RDS Proxy / PgBouncer) in front
  // --- runtime state ---
  backlog: number; // queued work units
  downFor: number; // seconds remaining while crashed / restarting
  outage: number; // seconds since it went down (failover timer)
  warm: number; // cache warmth 0..1
  dirty: number; // write-back cache: writes acked but not yet flushed to the DB
  pending: number; // replica: writes received but not yet applied (replication lag)
  resp: number; // ms from arrival here to response (incl. downstream calls), smoothed
  inflight: number; // concurrent requests held (Little's law), smoothed
  conns: number; // database: open client connections
  stats: NodeStats;
}

export interface NodeStats {
  inRps: number; // work arriving (req/s)
  servedRps: number;
  dropRps: number;
  util: number; // load / capacity on the bottleneck resource
  cpu: number; // CPU utilization
  latency: number; // ms added at this node
  hitRate: number; // caches / cdn / db buffer pool
  ram: number; // GB in use
  note: string; // short status message
  /** extra inspector rows: [label, value, bad?] */
  rows: [string, string, boolean?][];
  /** plain-English explanation of the RAM figure */
  ramWhy: string;
  stale: number; // reads/s served with possibly-stale data
  cost: number; // $/month right now (incl. usage-based pricing)
  lag: number; // replica: replication lag (s)
}

export interface Edge {
  id: number;
  from: number;
  to: number;
  rps: Mix; // traffic over this edge last tick (for visuals)
  sync: number; // user-facing (non-async) req/s over this edge last tick
}

export interface TierSpec {
  /** instance type, e.g. c6i.xlarge */
  name: string;
  vcpu: number;
  /** GB of RAM */
  ram: number;
  /** fixed $ / month (on-demand, us-east-1, approximate); also the price to place it */
  cost: number;
  /** capacity in work units / second (meaning depends on the node kind) */
  cap: number;
  /** sustained network bandwidth, MB/s */
  net?: number;
  /** disk IOPS the instance + volume can sustain (databases) */
  iops?: number;
  /** usage-based price: $ per million requests handled */
  perM?: number;
  /** burstable (t-family) instance */
  burst?: boolean;
  /** short qualifier shown in the tier table */
  tag?: string;
}

export interface NodeSpec {
  kind: NodeKind;
  label: string;
  short: string;
  color: string;
  /** base latency added (ms) */
  latency: number;
  /** relative cost of a write vs a read in work units */
  writeCost: number;
  /** seconds of backlog at full capacity before dropping */
  queueSeconds: number;
  tiers: TierSpec[];
  /** what it is / when to use it */
  blurb: string;
  /** how to wire it */
  wiring: string;
  /** what one capacity unit means, e.g. "API req/s" */
  unit: string;
  canConnectTo: NodeKind[];
}

export type Phase = 'build' | 'run' | 'gameover';

export interface WaveDef {
  index: number; // 1-based
  peakRps: number;
  duration: number; // seconds of sim time (one wave = one month of business)
  mix: Mix; // fractions of legit traffic (s+r+w = 1); b = bots as multiple of legit
  event?: WaveEvent;
  chaos: number; // probability per second of a random instance failure
  /** concurrent users the dataset is sized for; defaults to peakRps * USERS_PER_RPS */
  users?: number;
  title: string;
}

export type WaveEvent =
  | { type: 'spike'; at: number; mult: number; len: number; label: string }
  | { type: 'flashsale'; label: string }
  | { type: 'bots'; label: string }
  | { type: 'hotkey'; label: string }
  | { type: 'dbcrash'; at: number; len: number; label: string };

export interface Metrics {
  demand: number; // legit req/s
  success: number;
  errors: number;
  errorRate: number;
  p50: number;
  p99: number;
  botRps: number;
  upkeep: number; // $/month burn rate right now
  revenue: number; // $/month earn rate right now
  staleRate: number; // fraction of successful reads that may be stale
  lostWrites: number; // acknowledged writes lost this wave (write-back crash, async failover)
}
