import type { NodeKind, NodeSpec, WaveDef, WaveEvent } from './types';

export const TICK = 0.1; // sim seconds per tick
export const TIMEOUT_MS = 3000; // requests slower than this count as errors
export const USERS_PER_RPS = 10; // ~1 request every 10s per active user
export const SLA = { errorRate: 0.01, p99: 800 };
export const START_MONEY = 400;

const t = (name: string, cap: number, cost: number, upkeep: number, hit?: number) => ({ name, cap, cost, upkeep, hit });

export const SPECS: Record<NodeKind, NodeSpec> = {
  users: {
    kind: 'users', label: 'Users', short: 'USR', color: '#8b5cf6', latency: 40, writeCost: 1, queueSeconds: 0,
    tiers: [t('Internet', Infinity, 0, 0)],
    blurb: 'Where traffic comes from. The 40ms is the network round trip from a user to your data center.',
    canConnectTo: ['server', 'loadbalancer', 'cdn', 'ratelimiter'],
  },
  server: {
    kind: 'server', label: 'App Server', short: 'APP', color: '#3b82f6', latency: 15, writeCost: 1, queueSeconds: 1,
    tiers: [t('t3.small', 100, 100, 0.4), t('t3.large', 300, 300, 1.2), t('c5.2xlarge', 800, 900, 3.6), t('c5.9xlarge', 2000, 2500, 10)],
    blurb: 'Runs your application code. Serves static files itself, but reads & writes need a database behind it. Stateless, so you can run many of them.',
    canConnectTo: ['database', 'replica', 'cache', 'queue'],
  },
  database: {
    kind: 'database', label: 'Database', short: 'DB', color: '#f59e0b', latency: 8, writeCost: 3, queueSeconds: 1.5,
    tiers: [t('db.small', 150, 150, 0.6), t('db.large', 400, 450, 1.8), t('db.xlarge', 1000, 1300, 5.2), t('db.metal', 2500, 3500, 14)],
    blurb: 'The source of truth (primary). Handles reads and writes. Writes cost 3x a read (disk sync, indexes, locks). Hard to scale horizontally.',
    canConnectTo: ['replica'],
  },
  loadbalancer: {
    kind: 'loadbalancer', label: 'Load Balancer', short: 'LB', color: '#10b981', latency: 1, writeCost: 1, queueSeconds: 0.2,
    tiers: [t('L7 small', 20000, 200, 0.3), t('L7 large', 100000, 600, 1), t('Anycast', 600000, 2000, 3)],
    blurb: 'Spreads requests across servers, weighted by capacity. Health checks skip crashed servers, so one dead box doesn\'t take you down.',
    canConnectTo: ['server', 'loadbalancer'],
  },
  cache: {
    kind: 'cache', label: 'Cache', short: '$', color: '#ef4444', latency: 1, writeCost: 1, queueSeconds: 0.2,
    tiers: [t('1 GB', 20000, 200, 0.3, 0.7), t('16 GB', 60000, 500, 0.8, 0.82), t('128 GB', 200000, 1500, 2.2, 0.9)],
    blurb: 'In-memory key-value store (Redis). Answers reads in ~1ms. Misses and writes go on to the database. Starts cold and warms up over time.',
    canConnectTo: ['database', 'replica'],
  },
  cdn: {
    kind: 'cdn', label: 'CDN', short: 'CDN', color: '#06b6d4', latency: 0, writeCost: 1, queueSeconds: 0.1,
    tiers: [t('Regional', 1_000_000, 300, 0.5, 0.95), t('Global', 10_000_000, 1200, 2, 0.98)],
    blurb: 'Edge servers close to users. Serves static assets right at the edge, which cuts out ~35ms of network trip. Everything else passes through to your origin.',
    canConnectTo: ['loadbalancer', 'server', 'ratelimiter'],
  },
  replica: {
    kind: 'replica', label: 'Read Replica', short: 'RR', color: '#d97706', latency: 8, writeCost: 1, queueSeconds: 1.5,
    tiers: [t('db.small', 150, 120, 0.5), t('db.large', 400, 360, 1.5), t('db.xlarge', 1000, 1000, 4.4), t('db.metal', 2500, 2800, 12)],
    blurb: 'A read-only copy of the primary. Must be fed by a Database → Replica link. Only takes reads. Every write on the primary gets copied to it, which uses some of its capacity, and it falls behind (replication lag) when it is busy.',
    canConnectTo: [],
  },
  queue: {
    kind: 'queue', label: 'Message Queue', short: 'MQ', color: '#ec4899', latency: 3, writeCost: 1, queueSeconds: 600,
    tiers: [t('SQS-ish', 50000, 250, 0.4), t('Kafka 3x', 300000, 900, 1.5)],
    blurb: 'Takes writes and acknowledges them right away (async). Workers drain the backlog at a pace the database can keep up with. Absorbs spikes.',
    canConnectTo: ['worker'],
  },
  worker: {
    kind: 'worker', label: 'Worker', short: 'WRK', color: '#a855f7', latency: 20, writeCost: 1, queueSeconds: 0.5,
    tiers: [t('small', 200, 80, 0.3), t('large', 600, 240, 0.9), t('xlarge', 1600, 700, 2.6)],
    blurb: 'Pulls jobs off a queue and writes them to the database. Add more workers to drain faster, or fewer to protect the database.',
    canConnectTo: ['database'],
  },
  ratelimiter: {
    kind: 'ratelimiter', label: 'Rate Limiter', short: 'RL', color: '#64748b', latency: 1, writeCost: 1, queueSeconds: 0.1,
    tiers: [t('Token bucket', 50000, 300, 0.4), t('Distributed', 500000, 1200, 1.6)],
    blurb: 'Rejects clients that send too many requests (429 Too Many Requests). Blocks about 95% of bot/abusive traffic before it reaches your servers.',
    canConnectTo: ['loadbalancer', 'server'],
  },
};

export const PALETTE_ORDER: NodeKind[] = ['server', 'database', 'loadbalancer', 'cache', 'cdn', 'replica', 'queue', 'worker', 'ratelimiter'];

/** Wave at which each tool becomes available. */
export const UNLOCKS: Record<string, number> = {
  server: 1, database: 1, upgrade: 2, loadbalancer: 3, cache: 4, cdn: 6, replica: 7, queue: 8, worker: 8, ratelimiter: 9, sharding: 11,
};

export function waveRps(n: number) {
  return Math.round(30 * Math.pow(1.65, n - 1));
}

export function makeWave(n: number): WaveDef {
  const peak = waveRps(n);
  let mix = { s: 0.25, r: 0.65, w: 0.1, b: 0 };
  let event: WaveEvent | undefined;
  let title = 'Steady growth';
  const scripted: Record<number, () => void> = {
    1: () => (title = 'Launch day'),
    2: () => (title = 'Word of mouth'),
    3: () => { title = 'Front page!'; event = { type: 'spike', at: 15, mult: 2, len: 8, label: 'Front page of a news site: 2x traffic spike' }; },
    4: () => (title = 'Things break'),
    5: () => { title = 'Viral post'; event = { type: 'spike', at: 18, mult: 2.5, len: 10, label: 'Viral post: 2.5x spike' }; },
    6: () => { title = 'Media heavy'; mix = { s: 0.4, r: 0.52, w: 0.08, b: 0 }; },
    7: () => (title = 'Read storm'),
    8: () => { title = 'Flash sale'; event = { type: 'flashsale', label: 'Flash sale: tons of writes (orders)' }; },
    9: () => { title = 'Under attack'; event = { type: 'bots', label: 'Bot attack: scrapers flooding you' }; },
    10: () => { title = 'Disk failure'; event = { type: 'dbcrash', at: 15, label: 'Primary DB crashes for 12s' }; },
    11: () => { title = 'Celebrity joins'; event = { type: 'hotkey', label: 'Celebrity posts: writes way up, one hot shard' }; },
  };
  if (scripted[n]) scripted[n]();
  else if (n > 11) {
    const pool: (() => void)[] = [
      () => { title = 'Viral spike'; event = { type: 'spike', at: 15 + (n % 3) * 5, mult: 2.2, len: 10, label: 'Viral spike: 2.2x' }; },
      () => { title = 'Flash sale'; event = { type: 'flashsale', label: 'Flash sale: write-heavy' }; },
      () => { title = 'Botnet'; event = { type: 'bots', label: 'Botnet: scrapers are back' }; },
      () => { title = 'Hot key'; event = { type: 'hotkey', label: 'Hot key: one shard melts' }; },
      () => { title = 'Disk failure'; event = { type: 'dbcrash', at: 20, label: 'A primary DB crashes for 12s' }; },
      () => (title = 'Steady growth'),
    ];
    pool[n % pool.length]();
  }
  if (event?.type === 'flashsale' || event?.type === 'hotkey') mix = { s: 0.2, r: 0.45, w: 0.35, b: 0 };
  if (event?.type === 'bots') mix = { ...mix, b: 2 };
  return { index: n, peakRps: peak, duration: n <= 2 ? 30 : 40, mix, event, chaos: n >= 4 ? 0.02 + Math.min(0.04, n * 0.002) : 0, title };
}

/** Traffic multiplier over the course of a wave (0..duration). */
export function waveShape(w: WaveDef, time: number): number {
  const p = time / w.duration;
  let m = p < 0.4 ? 0.3 + (0.7 * p) / 0.4 : 1;
  m *= 1 + 0.05 * Math.sin(time * 1.7) + 0.03 * Math.sin(time * 4.3);
  const e = w.event;
  if (e?.type === 'spike' && time >= e.at && time < e.at + e.len) {
    const q = (time - e.at) / e.len;
    m *= 1 + (e.mult - 1) * Math.sin(q * Math.PI);
  }
  return m;
}
