# ScaleUp: a system design game

Build an architecture on a canvas and watch waves of traffic hit it. Each wave is one month of business and grows ~1.6x, from ~1k concurrent users (100 req/s) to 1M+ (100k+ req/s), bringing a new tool plus an event that breaks the previous design.

```sh
npm install
npm run dev
```

## How it works
- **Traffic** is a fluid simulation (10 ticks/s) over your graph. Every flow is a mix of static / read / write / bot requests, comes from one of three user regions (30 / 75 / 180 ms RTT), and carries the latency it has built up so far, which gives real p50/p99 numbers.
- **Real hardware.** Every node tier is a real instance type (t3.small, c6i.xlarge, db.r6g.2xlarge, cache.r6g.large...) with its vCPU, RAM, network bandwidth / disk IOPS and approximate on-demand $/month. Managed services (ALB, CloudFront, SQS, WAF) bill per request.
- **Each node** has a capacity, a backlog (queueing → latency), and drops requests once its backlog is full. The bottleneck can be CPU, NIC bandwidth (static files) or disk IOPS (databases).
- **Memory.** App-server RAM = runtime + in-flight requests × ~1 MB, where in-flight = req/s × response time (Little's law). A slow database makes servers run out of memory and get OOM-killed, which cascades. Database RAM holds the working set (grows with users); when it doesn't fit, reads go to disk. Cache RAM decides hit rate (Zipf-like popularity). Postgres connections cost ~8 MB each and are capped by max_connections.
- **Caching strategies:** cache-aside (default; Server → Cache and Server → DB), read-through, write-through and write-back (unflushed writes are lost if the cache crashes).
- **Replication:** Database → Replica is async. Replicas replay every write, lag when busy (stale reads), and get promoted ~15s after the primary dies (un-replicated writes are lost).
- **Resizing** an instance mid-wave restarts it (8-15s down). Between waves it is instant.
- **Databases** serve live traffic first. Async work (queue workers, write-back flushes, replication) gets the leftover capacity and is pushed back when there isn't enough (backpressure).
- **SLA:** <1% errors and p99 <800ms. Breaking it drains reputation. Revenue (~$3 per req/s-month) pays the cloud bill.

## Curriculum
| Wave | Peak req/s | Unlock | Event |
|---|---|---|---|
| 1 | 100 | App Server, Database | — |
| 2 | 160 | Vertical scaling | — |
| 3 | 256 | Load Balancer | 2x spike |
| 4 | 410 | Cache | random instance failures from here on |
| 5 | 655 | — | 2.5x spike (working set outgrows a small DB) |
| 6 | 1k | CDN | static-heavy traffic |
| 7 | 1.7k | Read Replica | read storm |
| 8 | 2.7k | Queue + Worker | flash sale (35% writes) |
| 9 | 4.3k | Rate Limiter | bot attack |
| 10 | 6.9k | — | primary DB hardware failure (failover) |
| 11 | 11k | Sharding | hot key |
| 16 | 115k | — | ~1.1M users |

## Code
- `src/sim.ts`: simulation engine (routing, queueing, memory/connections, caching strategies, replication, failover, metrics, waves)
- `src/config.ts`: node specs (real instance types and prices), physics constants, unlocks, wave generator
- `src/render.ts`: canvas renderer (pan/zoom, particles, nodes)
- `src/advisor.ts`: live bottleneck explanations
- `src/tutorial.ts`: lesson cards
- `src/main.ts`: input, HUD, panels, inspector, modals
