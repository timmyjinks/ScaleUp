import type { CacheStrategy, NodeKind, NodeSpec, TierSpec, WaveDef, WaveEvent } from './types';

export const TICK = 0.1; // sim seconds per tick
export const TIMEOUT_MS = 3000; // requests slower than this count as errors
export const USERS_PER_RPS = 10; // ~1 request every 10s per active user
export const SLA = { errorRate: 0.01, p99: 800 };
export const START_MONEY = 120;

// ---- economy: one wave is one month of business, compressed into `duration` seconds
export const SECONDS_PER_MONTH = 2_628_000;
/** $ earned per month by 1 req/s of successfully served traffic (≈ $1.1 per million requests) */
export const REVENUE_PER_RPS_MONTH = 3;

// ---- physics (real-world ballparks)
/** where users are: share of traffic, RTT to your datacenter, RTT to the nearest CDN edge (ms) */
export const GEO = [
  { share: 0.5, rtt: 30, edge: 8 }, // same region
  { share: 0.35, rtt: 75, edge: 12 }, // same continent
  { share: 0.15, rtt: 180, edge: 20 }, // other continents
];
export const STATIC_KB = 60; // avg static object (images, js, css)
export const API_KB = 4; // avg JSON response
export const DB_HOT_MB_PER_USER = 0.5; // DB working set (hot rows + indexes) per concurrent user
export const CACHE_HOT_MB_PER_USER = 0.15; // hot cached objects per concurrent user
export const PAGES_PER_READ = 8; // 8KB pages a typical query touches when cold (index leaf + heap rows)
export const DISK_MS = 0.5; // EBS gp3 random read
export const REQ_MB = 1; // app-server memory held per in-flight request (buffers, parsed JSON, ORM objects)
export const PG_CONN_MB = 8; // Postgres backend process per connection
export const CACHE_USABLE = 0.75; // ElastiCache reserves ~25% for overhead/fork
export const FAILOVER_S = 15; // managed DB promotes a replica after this long
export const OOM_RESTART_S = 10; // process restart + health checks
export const REPLICA_APPLY_COST = 2; // work units for a replica to replay one write
export const WRITEBACK_COALESCE = 0.6; // write-back merges repeated writes to the same key
/** downtime when resizing an instance mid-wave (stop, change type, start, warm up) */
export const RESIZE_S: Record<NodeKind, number> = {
  users: 0, server: 8, worker: 8, loadbalancer: 8, ratelimiter: 8, cache: 10, database: 15, replica: 15, queue: 0, cdn: 0,
};

const t = (name: string, vcpu: number, ram: number, cost: number, cap: number, o: Partial<TierSpec> = {}): TierSpec => ({ name, vcpu, ram, cost, cap, ...o });

const ec2 = (cap: (i: number) => number): TierSpec[] => [
  t('t3.small', 2, 2, 15, cap(0), { net: 16, burst: true, tag: 'burstable' }),
  t('c6i.large', 2, 4, 62, cap(1), { net: 98 }),
  t('c6i.xlarge', 4, 8, 124, cap(2), { net: 195 }),
  t('c6i.2xlarge', 8, 16, 248, cap(3), { net: 390 }),
  t('c6i.4xlarge', 16, 32, 496, cap(4), { net: 780 }),
  t('c6i.8xlarge', 32, 64, 992, cap(5), { net: 1560 }),
];

const rds: TierSpec[] = [
  t('db.t4g.micro', 2, 1, 12, 1000, { iops: 1000, burst: true, tag: 'burstable' }),
  t('db.t4g.medium', 2, 4, 47, 2500, { iops: 2000, burst: true, tag: 'burstable' }),
  t('db.r6g.large', 2, 16, 164, 4500, { iops: 3600 }),
  t('db.r6g.xlarge', 4, 32, 329, 9000, { iops: 6000 }),
  t('db.r6g.2xlarge', 8, 64, 657, 17000, { iops: 12000 }),
  t('db.r6g.4xlarge', 16, 128, 1314, 32000, { iops: 20000 }),
  t('db.r6g.8xlarge', 32, 256, 2628, 55000, { iops: 30000 }),
  t('db.r6g.16xlarge', 64, 512, 5256, 90000, { iops: 40000 }),
];

/** Postgres max_connections on RDS ≈ RAM / 9.5MB, capped at 5000 */
export const maxConnections = (ramGB: number) => Math.min(5000, Math.round(ramGB * 112));

export const SPECS: Record<NodeKind, NodeSpec> = {
  users: {
    kind: 'users', label: 'Users', short: 'USR', color: '#8b5cf6', latency: 60, writeCost: 1, queueSeconds: 0, unit: 'req/s',
    tiers: [t('Internet', 0, 0, 0, Infinity)],
    blurb: 'Where traffic comes from. Every request pays a network round trip to your datacenter: ~30ms for users in your region, ~75ms on the same continent, ~180ms from the other side of the world. That spread is what your p99 is made of.',
    wiring: 'Users → App Server (to start), → Load Balancer, → CDN, or → Rate Limiter. Users → CDN plus Users → LB puts static assets on the CDN domain and sends API calls straight to your origin.',
    canConnectTo: ['server', 'loadbalancer', 'cdn', 'ratelimiter'],
  },
  server: {
    kind: 'server', label: 'App Server', short: 'APP', color: '#3b82f6', latency: 10, writeCost: 1, queueSeconds: 1, unit: 'API req/s',
    tiers: ec2((i) => [800, 2000, 4000, 7500, 14000, 25000][i]),
    blurb: 'Runs your API (Node/Go/Java). A JSON request burns ~10ms of CPU; waiting on the DB costs no CPU but holds memory. A static file costs ~5x less CPU than an API call but uses NIC bandwidth (a t3.small sustains only ~16 MB/s). RAM = runtime + in-flight requests × ~1 MB, and in-flight = req/s × response time: a slow database makes requests pile up until the process is OOM-killed. Stateless, so run many behind a load balancer.',
    wiring: 'Users/LB → App Server → Database (reads + writes). Add → Cache for cache-aside (keep the Server → Database link: misses and writes use it), → Read Replica for read/write splitting, → Queue for async writes.',
    canConnectTo: ['database', 'replica', 'cache', 'queue'],
  },
  database: {
    kind: 'database', label: 'Database', short: 'DB', color: '#f59e0b', latency: 1.5, writeCost: 5, queueSeconds: 1.5, unit: 'reads/s',
    tiers: rds,
    blurb: 'Postgres/MySQL primary on RDS: the source of truth. An indexed read is ~1-2ms; a write costs ~5x a read (WAL fsync, index updates, locks). Reads are fast only while the working set (hot rows + indexes, which grows with your users) fits in RAM; past that, queries go to disk and become IOPS-bound. Every client server holds a connection pool, and each Postgres connection is a process using ~8 MB, capped by max_connections.',
    wiring: 'App Server / Worker / Cache (read-through) → Database. Database → Read Replica sets up async replication. Only one primary until sharding (wave 11); then connect clients to several primaries and keys get hash-partitioned.',
    canConnectTo: ['replica'],
  },
  loadbalancer: {
    kind: 'loadbalancer', label: 'Load Balancer', short: 'LB', color: '#10b981', latency: 2, writeCost: 1, queueSeconds: 0.2, unit: 'req/s',
    tiers: [
      t('ALB (managed)', 0, 0, 16, Infinity, { perM: 0.015, tag: '$16 + ~$0.015/M req (LCUs)' }),
      t('HAProxy c6i.large', 2, 4, 62, 40000, { net: 98, tag: 'self-managed' }),
      t('HAProxy c6i.2xlarge', 8, 16, 248, 150000, { net: 390, tag: 'self-managed' }),
    ],
    blurb: 'Spreads requests across servers (weighted by size) and health-checks them so dead boxes get skipped. A managed ALB is multi-AZ, scales itself, and bills per traffic (LCUs). A self-managed HAProxy/nginx box is far cheaper at high volume and handles tens of thousands of req/s, but it is one more instance: its NIC caps throughput, and it is a single point of failure unless you run two.',
    wiring: 'Users/CDN/Rate Limiter → Load Balancer → several App Servers. LBs can feed other LBs.',
    canConnectTo: ['server', 'loadbalancer'],
  },
  cache: {
    kind: 'cache', label: 'Cache', short: '$', color: '#ef4444', latency: 0.5, writeCost: 1, queueSeconds: 0.2, unit: 'ops/s',
    tiers: [
      t('cache.t4g.small', 2, 1.37, 23, 50000, { burst: true, tag: 'burstable' }),
      t('cache.r6g.large', 2, 13.07, 150, 100000),
      t('cache.r6g.xlarge', 4, 26.32, 300, 150000),
      t('cache.r6g.2xlarge', 8, 52.82, 600, 200000),
      t('cache.r6g.4xlarge', 16, 105.81, 1197, 250000),
    ],
    blurb: 'Redis/Memcached (ElastiCache): ~0.5ms GET/SET, 50-250k ops/s per node, so throughput is rarely the limit. RAM is: hit rate depends on how much of the hot data fits (popularity is Zipf-like, so a small cache catches a lot, and the long tail needs a lot more memory). A new or restarted cache is cold. Several caches shard keys between them, so their RAM adds up.',
    wiring: 'Pick a strategy below. Cache-aside (default): Server → Cache AND Server → Database. Read-through / write-through / write-back: Server → Cache → Database.',
    canConnectTo: ['database', 'replica'],
  },
  cdn: {
    kind: 'cdn', label: 'CDN', short: 'CDN', color: '#06b6d4', latency: 1, writeCost: 1, queueSeconds: 0.1, unit: 'req/s',
    tiers: [t('CloudFront', 0, 0, 0, Infinity, { perM: 0.75, tag: '$0.0075 per 10k requests' })],
    blurb: 'Hundreds of edge locations (PoPs) close to your users. Static assets are cached at the edge (~95% hit rate with versioned URLs): a far-away user gets them in ~20ms instead of ~180ms, and those bytes never touch your servers. Misses travel to your origin over the provider\'s backbone. Optionally it can cache public GET responses for a few seconds (TTL), which offloads reads but serves slightly stale data. Billed per request (bandwidth isn\'t billed in this game; in real life CDN $/GB is usually cheaper than origin egress).',
    wiring: 'Users → CDN → Load Balancer (everything via the CDN), or Users → CDN plus Users → LB (only static assets go via the CDN; API calls go direct). The CDN needs an origin link for misses.',
    canConnectTo: ['loadbalancer', 'server', 'ratelimiter'],
  },
  replica: {
    kind: 'replica', label: 'Read Replica', short: 'RR', color: '#d97706', latency: 1.5, writeCost: 1, queueSeconds: 1.5, unit: 'reads/s',
    tiers: rds,
    blurb: 'A read-only copy of the primary, kept up to date by async replication: it replays every write (~40% of what the write cost the primary), so writes do not scale with replicas. Replication lag is normally tens of ms, but grows when the replica is busy, and reads from a lagging replica can be stale (a user may not see their own write). If the primary dies, the managed DB promotes a replica after ~15s; writes it hadn\'t received yet are lost.',
    wiring: 'Database → Replica (replication link), then App Server → Replica (and keep App Server → Database for writes): reads are split across the primary and replicas by size. A read-through cache can also read from replicas (Cache → Replica).',
    canConnectTo: [],
  },
  queue: {
    kind: 'queue', label: 'Message Queue', short: 'MQ', color: '#ec4899', latency: 15, writeCost: 1, queueSeconds: 600, unit: 'msgs/s',
    tiers: [
      t('SQS standard', 0, 0, 0, 300000, { perM: 0.12, tag: '$0.40/M API calls, batched' }),
      t('MSK 3× kafka.m5.large', 6, 24, 460, 60000, { tag: '~5ms, ~10k msgs/s per partition' }),
      t('MSK 3× kafka.m5.2xlarge', 24, 96, 1840, 250000),
    ],
    blurb: 'Accepts writes and acknowledges them right away (async). Workers drain the backlog at a pace the database can take, which absorbs spikes and outages. SQS is effectively unlimited and bills per message (great until volume gets huge); Kafka is a fixed-price cluster with lower latency. Users get "accepted" immediately, but the data shows up in the DB later (eventual consistency).',
    wiring: 'App Server → Queue → Workers → Database. Servers with a queue send all writes through it.',
    canConnectTo: ['worker'],
  },
  worker: {
    kind: 'worker', label: 'Worker', short: 'WRK', color: '#a855f7', latency: 20, writeCost: 1, queueSeconds: 0.5, unit: 'jobs/s',
    tiers: ec2((i) => [400, 1000, 2000, 3800, 7000, 12000][i]),
    blurb: 'Pulls jobs off a queue, runs them (validate, enrich, write to the DB) and acks them. Sized like app servers. When the DB pushes back, unfinished jobs stay in the queue (backpressure). More workers drain faster but put more write load on the DB.',
    wiring: 'Queue → Worker → Database.',
    canConnectTo: ['database'],
  },
  ratelimiter: {
    kind: 'ratelimiter', label: 'Rate Limiter', short: 'RL', color: '#64748b', latency: 1, writeCost: 1, queueSeconds: 0.1, unit: 'req/s',
    tiers: [
      t('Envoy c6i.large', 2, 4, 62, 30000, { net: 98, tag: 'token bucket' }),
      t('Envoy c6i.2xlarge', 8, 16, 248, 120000, { net: 390 }),
      t('AWS WAF (managed)', 0, 0, 6, Infinity, { perM: 0.6, tag: '$6 + $0.60/M req' }),
    ],
    blurb: 'Counts requests per client (IP / API key) and answers 429 Too Many Requests once a client exceeds its budget. Blocks ~95% of bot/scraper traffic before it costs you anything downstream. Self-managed Envoy is cheap but is an instance with a NIC limit; AWS WAF scales itself and bills per request.',
    wiring: 'Users/CDN → Rate Limiter → Load Balancer (or → App Server).',
    canConnectTo: ['loadbalancer', 'server'],
  },
};

export const CACHE_STRATEGIES: Record<CacheStrategy, { label: string; how: string; wiring: string }> = {
  aside: {
    label: 'Cache-aside',
    how: 'The app does the work: GET from cache; on a miss it queries the DB itself and SETs the result. Writes go to the DB, then DELETE the key. Most common pattern, and a cache outage just means more DB load.',
    wiring: 'Server → Cache and Server → Database.',
  },
  readthrough: {
    label: 'Read-through',
    how: 'The cache loads misses from the DB itself (e.g. DAX, a caching library). App code is simpler. Writes still go Server → DB and invalidate the key.',
    wiring: 'Server → Cache → Database, plus Server → Database for writes.',
  },
  writethrough: {
    label: 'Write-through',
    how: 'Writes go through the cache, which writes the DB synchronously before acking. Higher write latency, but the cache is always fresh (no invalidation misses, better hit rate). Reads are read-through.',
    wiring: 'Server → Cache → Database.',
  },
  writeback: {
    label: 'Write-back',
    how: 'The cache acks writes immediately and flushes them to the DB asynchronously, merging repeated writes to the same key. Very fast writes and less DB write load, but if the cache crashes, unflushed writes are LOST.',
    wiring: 'Server → Cache → Database.',
  },
};

export const PALETTE_ORDER: NodeKind[] = ['server', 'database', 'loadbalancer', 'cache', 'cdn', 'replica', 'queue', 'worker', 'ratelimiter'];

/** Wave at which each tool becomes available. */
export const UNLOCKS: Record<string, number> = {
  server: 1, database: 1, upgrade: 2, loadbalancer: 3, cache: 4, cdn: 6, replica: 7, queue: 8, worker: 8, ratelimiter: 9, sharding: 11,
};

export function waveRps(n: number) {
  return Math.round(100 * Math.pow(1.6, n - 1));
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
    10: () => { title = 'Disk failure'; event = { type: 'dbcrash', at: 10, len: 30, label: 'Primary DB hardware failure: it\'s gone for 30s unless a replica can take over' }; },
    11: () => { title = 'Celebrity joins'; event = { type: 'hotkey', label: 'Celebrity posts: writes way up, one hot shard' }; },
  };
  if (scripted[n]) scripted[n]();
  else if (n > 11) {
    const pool: (() => void)[] = [
      () => { title = 'Viral spike'; event = { type: 'spike', at: 15 + (n % 3) * 5, mult: 2.2, len: 10, label: 'Viral spike: 2.2x' }; },
      () => { title = 'Flash sale'; event = { type: 'flashsale', label: 'Flash sale: write-heavy' }; },
      () => { title = 'Botnet'; event = { type: 'bots', label: 'Botnet: scrapers are back' }; },
      () => { title = 'Hot key'; event = { type: 'hotkey', label: 'Hot key: one shard melts' }; },
      () => { title = 'Disk failure'; event = { type: 'dbcrash', at: 12, len: 25, label: 'A primary DB dies for 25s' }; },
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

/** Zipf-ish hit curve: share of accesses served when `x` = (memory / hot working set). */
export const zipfHit = (x: number) => (x <= 0 ? 0 : Math.min(1, Math.log(1 + 50 * x) / Math.log(51)));
