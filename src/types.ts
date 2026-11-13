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
  /** async flows (queue -> worker -> db) don't count toward user latency/success */
  async?: boolean;
}

export interface SimNode {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  tier: number; // 0-based index into spec tiers
  // --- runtime state ---
  backlog: number; // queued work units
  downFor: number; // seconds remaining while crashed
  warm: number; // cache warmth 0..1
  retry: number; // async writes rejected downstream, to be re-queued (queue nodes)
  stats: NodeStats;
}

export interface NodeStats {
  inRps: number; // work arriving (req/s)
  servedRps: number;
  dropRps: number;
  util: number; // load / capacity
  latency: number; // ms added at this node
  hitRate: number; // caches / cdn
  note: string; // short status message
}

export interface Edge {
  id: number;
  from: number;
  to: number;
  rps: Mix; // traffic over this edge last tick (for visuals)
}

export interface TierSpec {
  name: string;
  /** capacity in work-units / second */
  cap: number;
  /** build cost ($) */
  cost: number;
  /** upkeep $ per second */
  upkeep: number;
  /** cache/cdn hit rate */
  hit?: number;
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
  blurb: string;
  canConnectTo: NodeKind[];
}

export type Phase = 'build' | 'run' | 'gameover';

export interface WaveDef {
  index: number; // 1-based
  peakRps: number;
  duration: number; // seconds of sim time
  mix: Mix; // fractions of legit traffic (s+r+w = 1); b = bots as multiple of legit
  event?: WaveEvent;
  chaos: number; // probability per second of a random server crash
  title: string;
}

export type WaveEvent =
  | { type: 'spike'; at: number; mult: number; len: number; label: string }
  | { type: 'flashsale'; label: string }
  | { type: 'bots'; label: string }
  | { type: 'hotkey'; label: string }
  | { type: 'dbcrash'; at: number; label: string };

export interface Metrics {
  demand: number; // legit req/s
  success: number;
  errors: number;
  errorRate: number;
  p50: number;
  p99: number;
  botRps: number;
  upkeep: number; // $/s
  revenue: number; // $/s
}
