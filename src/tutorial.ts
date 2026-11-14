import { INFRA_BUDGET_SHARE } from './config';
import type { NodeKind } from './types';

export interface Lesson {
  title: string;
  /** tools unlocked by this lesson, shown as chips */
  tools?: (NodeKind | 'upgrade' | 'sharding' | 'autoscale')[];
  body: string[];
  interview?: string;
}

/** Lessons shown at the start of the given wave (during its build phase). */
export const LESSONS: Record<number, Lesson> = {
  1: {
    title: 'Welcome, on-call engineer',
    tools: ['server', 'database'],
    body: [
      'Users are about to show up: ~1,000 people online, each sending a request every ~10s, so about <b>100 req/s</b>. Your job: <b>serve them</b> without breaking the SLA (<b>&lt;1% errors</b> and <b>p99 latency &lt;800ms</b>). Break it for too long and your reputation runs out.',
      'Traffic comes in types: <span class="c-s">●</span> static assets, <span class="c-r">●</span> reads, <span class="c-w">●</span> writes, and later <span class="c-b">●</span> bots. An App Server returns static files itself, but reads and writes need a <b>Database</b>.',
      'The numbers are real-world ballparks. A <b>t3.small</b> ($15/mo) handles ~800 API req/s; a small Postgres handles a few thousand indexed reads/s. Each wave is <b>one month</b>: the bill is in $/month and grows with your traffic, and so does revenue. Finance gives you <b>' + Math.round(INFRA_BUDGET_SHARE * 100) + '% of revenue</b> as your cloud budget (a typical SaaS spends 5-15% on hosting; the rest pays salaries and everything else), so a bill bigger than that drains your budget.',
      '<b>Build:</b> pick a tool on the left and click the canvas to place it. Drag from a node\'s <b>right port</b> onto another node to connect them. Drag empty space to pan, scroll to zoom. Click a node to see its CPU, RAM and what to do with it.',
    ],
    interview: 'Start with the simplest thing that works: client → server → DB. Do the back-of-envelope math (users → req/s → servers) and ask "what breaks first as traffic grows?"',
  },
  2: {
    title: 'Vertical scaling',
    tools: ['upgrade'],
    body: [
      'The simplest fix is a <b>bigger machine</b>: select a node and hit <b>Upgrade</b> (<kbd>U</kbd>), or click any size in its table. Cloud list prices are <b>linear per vCPU</b>: c6i.xlarge costs 2x c6i.large and does ~2x the work (the biggest sizes a bit less: apps rarely use every core well). It is the quick fix while you have one server; from next wave on, app servers <b>scale out</b> instead.',
      'The problems are: there\'s a <b>biggest box</b> (a ceiling), one box is a <b>single point of failure</b>, and <b>resizing needs a restart</b>. Between waves it\'s instant here, but mid-wave the node goes down for 8-15s. Fine if siblings cover for it; an outage if it\'s your only server or your primary database.',
      'For databases, bigger also means <b>more RAM</b>, which matters a lot: reads are fast only while the hot data fits in memory.',
    ],
    interview: 'For stateless app servers, scaling out is the default: redundancy, no restart to add capacity, and a fleet that autoscales with traffic is cheaper than one box sized for peak. Vertical scaling is the stopgap there, and the main lever for databases. Name its limits: hardware ceiling, no redundancy, and downtime to resize. (Managed DBs with a standby fail over to resize, ~1 min.)',
  },
  3: {
    title: 'Horizontal scaling & load balancing',
    tools: ['loadbalancer'],
    body: [
      'A news site is about to send you a <b>2x spike</b>, and from next wave on, instances fail at random. Run <b>several servers</b> behind a <b>Load Balancer</b>: <b>Users → LB → App Servers → DB</b>.',
      'The LB weights traffic by each server\'s size and <b>health-checks</b> them so dead ones get skipped. A managed <b>ALB</b> is multi-AZ and bills per traffic; a self-managed <b>HAProxy</b> box is cheaper at scale but is one more instance with a NIC limit.',
      'This works because app servers are <b>stateless</b>: any server can handle any request (keep sessions in a shared store, not in server memory). Plan for <b>N+1</b>: if one server dies, the others must absorb its load.',
    ],
    interview: 'Name the algorithm (round-robin, least-connections, weighted), mention health checks and that the LB itself must be redundant.',
  },
  4: {
    title: 'Caching (and things break)',
    tools: ['cache'],
    body: [
      'Instances now <b>fail at random</b>. One server with no LB means an outage.',
      'Most traffic is <b>reads of popular data</b>. The standard pattern is <b>cache-aside</b>: wire <b>Server → Cache</b> AND keep <b>Server → Database</b>. On a read the app GETs the cache; on a miss it queries the DB itself and SETs the result. On a write it updates the DB, then DELETEs the key.',
      'A Redis node does 50-250k ops/s, so the limit is <b>RAM</b>: popularity is Zipf-like, so a small cache catches a lot, but the long tail needs much more memory. A new cache is <b>cold</b>, and a crashed one comes back empty, sending every read to the DB at once.',
      'Click the cache to try other strategies: <b>read-through</b>, <b>write-through</b> (fresher, slower writes) and <b>write-back</b> (fast writes, but a crash loses unflushed data). Each needs different wiring.',
    ],
    interview: 'Compare cache-aside, read-through, write-through and write-back. Mention TTLs, eviction (LRU), invalidation races, and the thundering herd when a hot key expires or a cache node dies.',
  },
  5: {
    title: 'Autoscaling, memory and cascading failures',
    tools: ['autoscale'],
    body: [
      'A fixed group bills for peak all month. Turn on <b>autoscaling</b> on a server group: it adds instances when the load per instance passes a target and removes them when traffic drops, so you pay for the traffic curve instead of the peak. This, not the price per vCPU, is why a fleet of small servers is cheaper than one big box. But new instances take a few seconds to <b>boot</b>, and a viral post is coming: a spike faster than the boot time arrives before the help does. Keep <b>headroom</b> (a lower target or a higher minimum).',
      'Two things kill naive designs around here. First, the <b>database working set</b> (hot rows + indexes) grows with your users. While it fits in RAM, reads take ~1ms. Once it doesn\'t, queries go to disk and the DB becomes <b>IOPS-bound</b>. Check the DB\'s <b>Page hits</b> and <b>Disk IOPS</b>.',
      'Second, <b>Little\'s law</b>: requests in flight = req/s × response time. When the DB slows down, each app server holds more requests in memory at once. Past its RAM it is <b>OOM-killed</b>, its traffic moves to the survivors, and they die too.',
      'Also watch <b>connections</b>: every app process keeps a pool, every Postgres connection is a process using ~8 MB, and max_connections is capped. Many small servers on a small DB run out. A pooler (RDS Proxy) fixes it.',
    ],
    interview: 'Autoscaling: target tracking on CPU or requests per target, warm-up time, scale-out fast / scale-in slow, and scheduled scaling ahead of known peaks. When asked "what happens when the DB slows down?", walk through queueing → memory → timeouts → retries → cascading failure, and the fixes: timeouts, circuit breakers, load shedding, connection pooling.',
  },
  6: {
    title: 'Content Delivery Network',
    tools: ['cdn'],
    body: [
      'Your app is image-heavy now (40% static), and your users are spread out: 15% of them are ~180ms away from your datacenter. Those bytes also eat your servers\' NIC bandwidth.',
      'A <b>CDN</b> has edge locations near users. Wire <b>Users → CDN → LB</b> (everything through it) or <b>Users → CDN</b> plus <b>Users → LB</b> (only static assets on the CDN domain). Edge hits come back in ~10-20ms and never touch your origin.',
      'It bills per request, so it isn\'t free. Optionally it can also cache <b>public GET responses</b> for a few seconds, which offloads reads but serves slightly stale data.',
    ],
    interview: 'Push vs. pull CDN, cache-control headers and versioned URLs, invalidation on deploy, and the latency/geography argument.',
  },
  7: {
    title: 'Read replicas',
    tools: ['replica'],
    body: [
      'Cache misses still reach the DB, and some reads can\'t be cached. <b>Read Replicas</b> are read-only copies of the primary, fed by <b>async replication</b>.',
      'Wire it: <b>Database → Replica</b>. App Servers already connected to the Database start reading from the replica automatically, Reads now go to the replicas and writes to the primary, so the primary spends its CPU on writes. Every replica holds the full data set and replays every write, so make it as big as the primary.',
      'Every write is <b>replayed on every replica</b>, so writes don\'t scale this way. A busy replica falls behind (<b>replication lag</b>), and reads from it can be <b>stale</b>. Bonus: if the primary dies, a replica can be promoted.',
    ],
    interview: 'Mention replication lag and read-your-own-writes consistency (route a user\'s reads to the primary right after they write), plus failover and promoting a replica.',
  },
  8: {
    title: 'Queues & async processing',
    tools: ['queue', 'worker'],
    body: [
      '<b>Flash sale incoming:</b> about 35% of traffic is writes, and a write costs ~5x a read on the database.',
      'Most writes don\'t have to happen right away. Send them to a <b>Message Queue</b> (<b>Server → Queue → Workers → DB</b>). The queue <b>acknowledges immediately</b>, workers <b>batch</b> the inserts (cheaper per write) and drain at a pace the DB can handle (the DB pushes back on them when it\'s busy).',
      'About <b>30% of writes can\'t wait</b> (payments, unique usernames, stock checks), so keep the <b>Server → Database</b> link for them. And while the queue is behind, users don\'t see their own writes yet.',
      'Watch the <b>backlog</b>. If workers can\'t keep up, it grows. If you add too many workers, you overload the DB anyway.',
    ],
    interview: 'Queues decouple producers from consumers and smooth out spikes. Talk about at-least-once delivery, idempotency, dead-letter queues, and backpressure. SQS vs Kafka: per-message pricing vs a fixed cluster.',
  },
  9: {
    title: 'Rate limiting',
    tools: ['ratelimiter'],
    body: [
      '<b>Bots are coming</b>: <span class="c-b">●</span> scrapers sending 2x your real traffic. They don\'t pay, but they eat capacity.',
      'Put a <b>Rate Limiter</b> at the edge (<b>Users/CDN → Rate Limiter → LB</b>). It returns <code>429 Too Many Requests</code> to abusive clients before they reach your servers. A self-managed Envoy is cheap but every byte still crosses its NIC; AWS WAF scales itself but bills per request.',
    ],
    interview: 'Token bucket vs. leaky bucket vs. sliding window. Where the counters live (Redis), and limiting per user, per IP, or per API key.',
  },
  10: {
    title: 'Failover',
    body: [
      '<b>Your primary database is about to die.</b> Without a replica, every write fails until it comes back (30s).',
      'With a replica, the managed DB <b>promotes it after ~15s</b> and repoints the endpoint. Writes still fail during those seconds, unless a <b>queue</b> is absorbing them. Replication is async, so any writes the replica hadn\'t received yet are <b>lost</b>.',
    ],
    interview: 'RPO vs RTO: async replication means RPO > 0 (you can lose the last few writes); synchronous standby (Multi-AZ) gives RPO ≈ 0 at the cost of write latency.',
  },
  11: {
    title: 'Sharding',
    tools: ['sharding'],
    body: [
      'Writes don\'t scale with replicas, and one box\'s RAM can\'t hold the whole working set forever. The answer is to <b>split the data</b> across several primary databases (<b>shards</b>).',
      'You can now place more than one Database. Connect servers, caches, or workers to several primaries and keys get <b>hash-partitioned</b>: each shard takes a share of the writes <b>and</b> holds a share of the working set.',
      '<b>Watch out:</b> a celebrity is about to post. That is a <b>hot key</b>: ~35% of database traffic is for one key, so the shard that owns it melts while the others idle, and adding shards barely helps that one. Keep the hot reads in a <b>cache</b>, and batch the hot writes through a <b>queue</b> (or a bigger box for that shard).',
    ],
    interview: 'Discuss shard keys, consistent hashing, resharding pain, cross-shard queries/joins, and hot partitions.',
  },
};

/** First-wave guided checklist. */
export const QUICKSTART = [
  { id: 'server', text: 'Place an <b>App Server</b>' },
  { id: 'users-link', text: 'Connect <b>Users → App Server</b>' },
  { id: 'db', text: 'Place a <b>Database</b>' },
  { id: 'db-link', text: 'Connect <b>App Server → Database</b>' },
  { id: 'start', text: 'Press <b>Start wave</b>' },
] as const;
