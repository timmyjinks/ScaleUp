# ScaleUp: a system design game

Build an architecture on a canvas and watch waves of traffic hit it. Each wave grows (~1.65x) on the way to 1M+ users and brings a new tool plus an event that breaks the previous design.

```sh
npm install
npm run dev
```

## How it works
- **Traffic** is a fluid simulation (10 ticks/s) over your graph. Every flow is a mix of static / read / write / bot requests and carries the latency it has built up so far, which gives real p50/p99 numbers.
- **Each node** has a capacity, a backlog (queueing → latency), and drops requests once its backlog is full. Writes cost 3x on databases.
- **Databases** serve live traffic first. Async work (queue workers, replication) gets the leftover capacity and is pushed back when there isn't enough (backpressure).
- **SLA:** <1% errors and p99 <800ms. Breaking it drains reputation. Upkeep and build costs keep you from over-provisioning.

## Curriculum
| Wave | Unlock | Event |
|---|---|---|
| 1 | App Server, Database | — |
| 2 | Vertical scaling | — |
| 3 | Load Balancer | 2x spike |
| 4 | Cache | random server crashes from here on |
| 6 | CDN | static-heavy traffic |
| 7 | Read Replica | read storm |
| 8 | Queue + Worker | flash sale (35% writes) |
| 9 | Rate Limiter | bot attack |
| 10 | — | primary DB crash |
| 11 | Sharding | hot key |

## Code
- `src/sim.ts`: simulation engine (routing, queueing, metrics, waves)
- `src/config.ts`: node specs, tiers, unlocks, wave generator
- `src/render.ts`: canvas renderer (pan/zoom, particles, nodes)
- `src/advisor.ts`: live bottleneck explanations
- `src/tutorial.ts`: lesson cards
- `src/main.ts`: input, HUD, panels, modals
>>>>>>> 457ff2a (ScaleUp: system design tower-defense-style game prototype)
