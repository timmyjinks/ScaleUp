import type { NodeKind } from './types';

export interface Lesson {
  title: string;
  /** tools unlocked by this lesson, shown as chips */
  tools?: (NodeKind | 'upgrade' | 'sharding')[];
  body: string[];
  interview?: string;
}

/** Lessons shown at the start of the given wave (during its build phase). */
export const LESSONS: Record<number, Lesson> = {
  1: {
    title: 'Welcome, on-call engineer',
    tools: ['server', 'database'],
    body: [
      'Users are about to show up. Your job: <b>serve their requests</b> without breaking the SLA (<b>&lt;1% errors</b> and <b>p99 latency &lt;800ms</b>). Break it for too long and your reputation runs out.',
      'Traffic comes in different types: <span class="c-s">●</span> static assets, <span class="c-r">●</span> reads, <span class="c-w">●</span> writes, and later <span class="c-b">●</span> bots. An App Server can return static files itself, but reads and writes need a <b>Database</b>.',
      '<b>Build:</b> pick a tool on the left and click the canvas to place it. Drag from a node\'s <b>right port</b> onto another node to connect them. Drag empty space to pan, scroll to zoom. <kbd>Del</kbd> sells the selected node.',
    ],
    interview: 'Always start with the simplest thing that works: client → server → DB. Then ask "what breaks first as traffic grows?"',
  },
  2: {
    title: 'Vertical scaling',
    tools: ['upgrade'],
    body: [
      'Traffic is growing. The simplest fix is a <b>bigger machine</b>: select a node and hit <b>Upgrade</b> (<kbd>U</kbd>).',
      'Check the prices, though. Each size step costs <b>~3x</b> for roughly 2.5x the capacity, and there\'s a <b>biggest box</b> you can buy. A single server is also a <b>single point of failure</b>.',
    ],
    interview: 'Vertical scaling is fine early on. Point out its limits: the hardware ceiling, cost that grows faster than capacity, and no redundancy.',
  },
  3: {
    title: 'Horizontal scaling & load balancing',
    tools: ['loadbalancer'],
    body: [
      'A news site is about to send you a <b>2x spike</b>. Instead of one huge server, run <b>several small ones</b> behind a <b>Load Balancer</b>.',
      'Wire it up: <b>Users → LB → many App Servers → DB</b>. The LB weights traffic by each server\'s capacity and uses <b>health checks</b> to skip dead servers.',
      'This works because app servers are <b>stateless</b>: any server can handle any request. (Keep sessions in a shared store, not in server memory.)',
    ],
    interview: 'Name the algorithm (round-robin, least-connections, weighted) and mention health checks. Also: "The LB itself must be redundant (active/passive or anycast)."',
  },
  4: {
    title: 'Caching (and things break)',
    tools: ['cache'],
    body: [
      'From now on <b>servers crash at random</b>. If you have only one server with no LB in front, that means an outage.',
      'Your database is the next bottleneck. Most traffic is <b>reads</b>, and most reads ask for the same popular data. Put a <b>Cache</b> between servers and the DB: <b>Server → Cache → DB</b>.',
      'Cache hits come back in about 1ms and never reach the DB. A new cache starts <b>cold</b> (empty) and warms up over time. Writes <b>invalidate</b> keys, so write-heavy traffic hurts the hit rate.',
    ],
    interview: 'Know cache-aside vs. read-through vs. write-through, TTLs, eviction (LRU), and the "thundering herd" when a hot key expires.',
  },
  6: {
    title: 'Content Delivery Network',
    tools: ['cdn'],
    body: [
      'Your app is image- and video-heavy now (40% static). Those bytes don\'t need your servers at all.',
      'Put a <b>CDN</b> in front: <b>Users → CDN → LB</b>. It serves static assets from edge locations near users, which <b>cuts ~35ms of network latency</b> and takes that load off your origin.',
    ],
    interview: 'Push vs. pull CDN, cache-control headers, invalidation on deploy, and the latency/geography argument.',
  },
  7: {
    title: 'Read replicas',
    tools: ['replica'],
    body: [
      'Even with a cache, misses still reach the DB. <b>Read Replicas</b> are read-only copies of the primary.',
      'Wire it up: <b>Database → Replica</b> (replication link), then <b>Server/Cache → Replica</b> to send reads to it. Writes still go <b>only to the primary</b>, and every write gets <b>copied to every replica</b>, which uses capacity.',
      'Bonus: if the primary dies, reads keep working from the replicas.',
    ],
    interview: 'Mention replication lag and read-your-own-writes consistency, plus failover and promoting a replica.',
  },
  8: {
    title: 'Queues & async processing',
    tools: ['queue', 'worker'],
    body: [
      '<b>Flash sale incoming:</b> about 35% of traffic is writes, and writes cost 3x on a database.',
      'You don\'t have to write right away. Send writes to a <b>Message Queue</b> (<b>Server → Queue → Workers → DB</b>). The queue <b>acknowledges immediately</b> and workers drain it at a pace the DB can handle.',
      'Watch the <b>backlog</b>. If workers can\'t keep up, it grows. If you add too many workers, you overload the DB anyway.',
    ],
    interview: 'Queues decouple producers from consumers and smooth out spikes. Talk about at-least-once delivery, idempotency, dead-letter queues, and backpressure.',
  },
  9: {
    title: 'Rate limiting',
    tools: ['ratelimiter'],
    body: [
      '<b>Bots are coming</b>: <span class="c-b">●</span> scrapers sending 2x your real traffic. They don\'t pay, but they eat capacity.',
      'Put a <b>Rate Limiter</b> at the edge (<b>Users/CDN → Rate Limiter → LB</b>). It returns <code>429 Too Many Requests</code> to abusive clients before they ever reach your servers.',
    ],
    interview: 'Token bucket vs. leaky bucket vs. sliding window. Where the counters live (Redis), and limiting per user, per IP, or per API key.',
  },
  11: {
    title: 'Sharding',
    tools: ['sharding'],
    body: [
      'Writes don\'t scale with replicas: every replica still has to apply every write. The answer is to <b>split the data</b> across several primary databases (<b>shards</b>).',
      'You can now place more than one Database. Connect servers, caches, or workers to several primaries and writes get <b>hash-partitioned</b> across them.',
      '<b>Watch out:</b> a celebrity is about to post. With a <b>hot key</b>, one shard gets ~50% of writes. Good shard keys spread load evenly.',
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
