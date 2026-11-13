/**
 * Component guide: what each building block is, why you'd use it, and how to wire it.
 * Pure data. The UI lives in guideview.ts and the animated diagrams in scenes.ts.
 */
import type { SceneId } from './scenes';
import type { NodeKind } from './types';

export type GuideKey = NodeKind | 'sharding';

/** One step in a canonical wiring path: a component, or a free-text label (e.g. "Bots"). */
export type WireStep = GuideKey | { text: string };

export interface GuideEntry {
  key: GuideKey;
  title: string;
  /** icon / color source */
  icon: NodeKind;
  /** one line: what it is */
  what: string;
  /** why you'd reach for it (the problem it solves) */
  why: string;
  /** canonical placements */
  wire: { path: WireStep[]; note?: string }[];
  mistakes: string[];
  /** real-world equivalents */
  examples: string;
  interview: string;
  scene: SceneId;
  /** feature key in UNLOCKS */
  unlock: string;
  related?: GuideKey[];
}

export const GUIDE: Record<GuideKey, GuideEntry> = {
  users: {
    key: 'users', title: 'Users', icon: 'users', scene: 'server', unlock: 'server',
    what: 'Where every request comes from: people on phones and laptops, somewhere on the internet.',
    why: 'You don\'t build this one. It\'s already on the board. Every request starts here and pays a network round trip just to reach you.',
    wire: [
      { path: ['users', 'server'], note: 'day one' },
      { path: ['users', 'cdn', 'loadbalancer'], note: 'once you scale out' },
    ],
    mistakes: ['Leaving Users unconnected. Nothing gets served.'],
    examples: 'Browsers, mobile apps, other companies calling your API.',
    interview: 'Start by estimating the load: daily users → requests/sec, read/write ratio, peak vs. average.',
    related: ['server', 'cdn'],
  },
  server: {
    key: 'server', title: 'App Server', icon: 'server', scene: 'server', unlock: 'server',
    what: 'Runs your application code: takes a request, does the work, sends a response.',
    why: 'Every system needs something to run the business logic. Servers are stateless, so when one isn\'t enough you add more of them behind a load balancer.',
    wire: [
      { path: ['users', 'server', 'database'], note: 'the simplest thing that works' },
      { path: ['loadbalancer', 'server'], note: 'many servers behind an LB' },
    ],
    mistakes: [
      'Running a single server: it is a single point of failure, and they crash.',
      'Upgrading one box forever. Bigger sizes cost ~3x for ~2.5x capacity.',
    ],
    examples: 'EC2 / GCE VMs, containers on Kubernetes or ECS, a Node / Go / Java service.',
    interview: 'Keep app servers stateless (sessions in Redis or a DB) so any server can handle any request and you can scale horizontally.',
    related: ['loadbalancer', 'database'],
  },
  database: {
    key: 'database', title: 'Database', icon: 'database', scene: 'database', unlock: 'database',
    what: 'The primary: the source of truth that stores your data and handles reads and writes.',
    why: 'Data has to live somewhere durable. But writes are expensive (disk sync, indexes, locks; ~3x a read), and you only get one primary, so it\'s usually the first thing to melt.',
    wire: [
      { path: ['server', 'database'] },
      { path: ['database', 'replica'], note: 'replication link (later)' },
    ],
    mistakes: [
      'Sending every read to it once traffic grows. Add a cache or replicas.',
      'Expecting replicas to help with writes. They don\'t; every replica re-applies every write.',
    ],
    examples: 'PostgreSQL, MySQL, Amazon Aurora, Cloud SQL.',
    interview: 'Say where the bottleneck is: "reads → cache + replicas, writes → queue to smooth spikes, then shard."',
    related: ['cache', 'replica', 'sharding'],
  },
  sharding: {
    key: 'sharding', title: 'Sharding', icon: 'database', scene: 'sharding', unlock: 'sharding',
    what: 'Splitting your data across several primary databases, each owning a slice of the keys.',
    why: 'Replicas scale reads, but every write still lands on one primary. Sharding is how you scale writes: N primaries, each taking about 1/N of them.',
    wire: [
      { path: ['server', 'database'], note: 'connect to two or more Databases' },
      { path: ['worker', 'database'], note: 'workers can fan out too' },
    ],
    mistakes: [
      'A bad shard key. One celebrity / one big customer can put half the load on one shard (a hot key).',
      'Forgetting the cost: cross-shard queries and joins get hard, and resharding is painful.',
    ],
    examples: 'Vitess (YouTube), Citus for Postgres, DynamoDB / Cassandra partitions, MongoDB sharding.',
    interview: 'Talk about choosing the shard key, consistent hashing, hot partitions, and how you would reshard.',
    related: ['database', 'replica'],
  },
  loadbalancer: {
    key: 'loadbalancer', title: 'Load Balancer', icon: 'loadbalancer', scene: 'loadbalancer', unlock: 'loadbalancer',
    what: 'One front door that spreads requests across many identical servers.',
    why: 'Lets you scale out with several cheap servers instead of one giant one. Its health checks skip crashed servers, so one dead box doesn\'t cause an outage.',
    wire: [
      { path: ['users', 'loadbalancer', 'server'], note: 'fan out to 2+ servers' },
      { path: ['cdn', 'loadbalancer'], note: 'behind the CDN / rate limiter' },
    ],
    mistakes: [
      'An LB with only one server behind it. No redundancy, just an extra hop.',
      'Putting it after the servers. It goes in front.',
    ],
    examples: 'AWS ALB / NLB, NGINX, HAProxy, Envoy, Google Cloud Load Balancing.',
    interview: 'Name an algorithm (round-robin, least-connections, weighted), mention health checks, and note the LB itself needs redundancy.',
    related: ['server'],
  },
  cache: {
    key: 'cache', title: 'Cache', icon: 'cache', scene: 'cache', unlock: 'cache',
    what: 'An in-memory key-value store that answers repeated reads in ~1ms.',
    why: 'Most reads ask for the same popular data. Keep it in memory and the database never sees those reads. That\'s cheaper and much faster than adding database capacity.',
    wire: [
      { path: ['server', 'cache'], note: 'reads check here first' },
      { path: ['server', 'database'], note: 'misses and writes go here' },
    ],
    mistakes: [
      'Expecting it to be fast right away. A new cache starts cold (empty) and warms up.',
      'Write-heavy traffic keeps invalidating keys, so the hit rate drops.',
      'Placing it in front of users. Static files belong on a CDN; the cache sits beside your servers.',
    ],
    examples: 'Redis, Memcached, Amazon ElastiCache.',
    interview: 'Cache-aside (shown here) vs. read-through vs. write-through / write-back. Also TTLs, LRU eviction, and the thundering herd when a hot key expires.',
    related: ['database', 'cdn'],
  },
  cdn: {
    key: 'cdn', title: 'CDN', icon: 'cdn', scene: 'cdn', unlock: 'cdn',
    what: 'A global network of edge servers, close to your users, that keep copies of your static files.',
    why: 'Distance is latency: a trip across the ocean to your data center is 100+ms. The edge answers images, JS and video from nearby, so pages load faster and those bytes never reach your servers. Dynamic API calls pass through to your origin.',
    wire: [
      { path: ['users', 'cdn', 'loadbalancer'], note: 'first hop after users' },
      { path: ['users', 'cdn', 'ratelimiter', 'loadbalancer'], note: 'with a rate limiter' },
    ],
    mistakes: [
      'Putting it behind the load balancer. It must be the first thing users hit.',
      'Expecting it to fix slow reads or writes. It only caches static assets; API traffic still reaches your servers.',
    ],
    examples: 'Cloudflare, Amazon CloudFront, Fastly, Akamai.',
    interview: 'Pull vs. push CDN, Cache-Control headers and TTLs, invalidating on deploy (versioned file names), and the latency-by-geography argument.',
    related: ['cache', 'loadbalancer'],
  },
  replica: {
    key: 'replica', title: 'Read Replica', icon: 'replica', scene: 'replica', unlock: 'replica',
    what: 'A read-only copy of the primary database that stays in sync by replaying its writes.',
    why: 'When reads (cache misses included) overload the primary, add replicas and send reads to them. Writes still go to the primary only. If the primary dies, replicas keep serving reads.',
    wire: [
      { path: ['database', 'replica'], note: 'replication link: drag from the Database' },
      { path: ['server', 'replica'], note: 'send reads to it' },
    ],
    mistakes: [
      'Forgetting the Database → Replica link. Without it the replica has no data.',
      'Adding replicas to fix a write problem. Each one re-applies every write, so it actually costs capacity.',
      'Reading your own write from a lagging replica and seeing the old value.',
    ],
    examples: 'Postgres streaming replicas, MySQL read replicas, Aurora replicas.',
    interview: 'Mention replication lag, read-your-own-writes (read from the primary right after writing), and failover by promoting a replica.',
    related: ['database', 'cache', 'sharding'],
  },
  queue: {
    key: 'queue', title: 'Message Queue', icon: 'queue', scene: 'queue', unlock: 'queue',
    what: 'A buffer that takes writes now and hands them to workers later.',
    why: 'Write spikes (a flash sale) would crush the database. The queue acknowledges each write instantly and workers drain the backlog at a pace the DB can handle. You trade a little delay for not falling over.',
    wire: [
      { path: ['server', 'queue', 'worker', 'database'] },
    ],
    mistakes: [
      'A queue with no workers. The backlog just grows forever.',
      'Too many workers. They drain fast, but then they overload the database anyway.',
    ],
    examples: 'Amazon SQS, Kafka, RabbitMQ, Google Pub/Sub.',
    interview: 'Queues decouple producers and consumers and smooth spikes. Discuss at-least-once delivery, idempotent consumers, dead-letter queues and backpressure.',
    related: ['worker', 'database'],
  },
  worker: {
    key: 'worker', title: 'Worker', icon: 'worker', scene: 'queue', unlock: 'worker',
    what: 'A background process that pulls jobs off a queue and does the slow work (here: writing to the DB).',
    why: 'Workers control how fast queued work hits the database. Add workers to drain faster, or use fewer to protect a struggling DB.',
    wire: [
      { path: ['queue', 'worker', 'database'] },
    ],
    mistakes: ['Pointing users or servers straight at a worker. Workers only read from a queue.'],
    examples: 'Celery, Sidekiq, AWS Lambda consumers, Kafka consumer groups.',
    interview: 'Make jobs idempotent (they can run twice), and scale workers on queue depth / age of the oldest message.',
    related: ['queue'],
  },
  ratelimiter: {
    key: 'ratelimiter', title: 'Rate Limiter', icon: 'ratelimiter', scene: 'ratelimiter', unlock: 'ratelimiter',
    what: 'A gate at the edge that rejects clients sending too many requests (429 Too Many Requests).',
    why: 'Bots and scrapers can send more traffic than all your real users combined. Rejecting them at the door is far cheaper than serving them.',
    wire: [
      { path: ['users', 'ratelimiter', 'loadbalancer'] },
      { path: ['cdn', 'ratelimiter', 'loadbalancer'], note: 'behind the CDN' },
    ],
    mistakes: ['Putting it behind the servers. By then the bots have already used the capacity you were trying to protect.'],
    examples: 'Cloudflare rate limiting, AWS WAF, NGINX limit_req, API gateways (Kong, Apigee), Redis-backed counters.',
    interview: 'Token bucket vs. leaky bucket vs. sliding window, where counters live (Redis), and limiting per user / IP / API key.',
    related: ['cdn', 'loadbalancer'],
  },
};

/** Order of entries in the field guide. */
export const GUIDE_ORDER: GuideKey[] = ['users', 'server', 'database', 'loadbalancer', 'cache', 'cdn', 'replica', 'queue', 'worker', 'ratelimiter', 'sharding'];
