import { ASYNC_WRITE_SHARE, BOOT_S, CACHE_STRATEGIES, SLA, CACHE_USABLE, SPECS, maxConnections } from './config';
import { fmt, type World } from './sim';
import type { SimNode } from './types';

export interface Hint { level: 'bad' | 'warn' | 'tip'; text: string; node?: number }

const gb = (x: number) => (x >= 10 ? Math.round(x) : x.toFixed(1)) + ' GB';
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Looks at the running system and explains what's wrong and what to try. */
export function advise(w: World): Hint[] {
  const hints: Hint[] = [];
  const say = (level: Hint['level'], text: string, n?: SimNode) => hints.push({ level, text, node: n?.id });
  const of = (k: SimNode['kind']) => w.nodes.filter((n) => n.kind === k);
  const has = (k: SimNode['kind']) => of(k).length > 0;
  const users = w.nodes.find((n) => n.kind === 'users')!;
  const servers = of('server');
  const dbs = of('database');
  const running = w.phase === 'run';

  // ---- wiring problems first
  if (!w.children(users).length) say('bad', 'Users aren\'t connected to anything. Drag from the Users port to a server.', users);
  for (const n of w.nodes) if (n.kind !== 'users' && !w.parents(n).length) say('warn', `${SPECS[n.kind].label} #${n.id} gets no traffic. Connect something into it.`, n);
  for (const s of servers) if (!w.children(s, ['database', 'replica', 'cache', 'queue']).length)
    say('bad', `App Server #${s.id} has no database. Every read and write fails.`, s);
  for (const r of of('replica')) if (!w.isSynced(r)) say('bad', `Replica #${r.id} isn't replicating. Connect Database → Replica first.`, r);
  for (const q of of('queue')) if (!w.children(q, ['worker']).length) say('bad', `Queue #${q.id} has no workers, so writes pile up until they expire.`, q);
  for (const s of servers) if (w.children(s, ['queue']).length && !w.children(s, ['database', 'cache']).length)
    say('bad', `App Server #${s.id} only writes to a queue. ~${pct(1 - ASYNC_WRITE_SHARE)} of writes (payments, unique checks) and every read still need Server → Database.`, s);
  for (const k of of('worker')) if (!w.children(k).length) say('bad', `Worker #${k.id} has no database to write to.`, k);
  for (const c of of('cdn')) if (!w.children(c).length) say('bad', `CDN #${c.id} has no origin. Connect CDN → Load Balancer (or Server) so misses can be fetched.`, c);
  for (const c of of('cache')) {
    const label = CACHE_STRATEGIES[c.strategy].label;
    const ps = w.parents(c).filter((p) => p.kind === 'server');
    const toDb = w.children(c, ['database', 'replica']);
    const noDbLink = ps.filter((p) => !w.children(p, ['database', 'replica']).length);
    if (c.strategy === 'aside') {
      if (noDbLink.length) say('bad', `Cache-aside: the app reads the DB itself on a miss, but Server #${noDbLink[0].id} has no Server → Database link, so misses and writes fail. Connect it, or switch the cache to read-through.`, noDbLink[0]);
      if (toDb.length) say('tip', `Cache #${c.id} → Database link is unused in cache-aside (the cache never talks to the DB). Remove it, or switch to read-through / write-through.`, c);
    } else {
      if (!toDb.length) say('bad', `${label}: the cache loads misses itself, but Cache #${c.id} isn't connected to a database. Connect Cache → Database (or switch to cache-aside).`, c);
      if (c.strategy !== 'readthrough' && !w.children(c, ['database']).length && toDb.length) say('bad', `${label}: writes go through the cache, so it needs a link to the primary Database (replicas are read-only).`, c);
      if (c.strategy === 'readthrough' && noDbLink.length) say('bad', `Read-through only covers reads: Server #${noDbLink[0].id} still needs a Server → Database link for writes.`, noDbLink[0]);
      if (c.strategy === 'writeback' && c.dirty > 50 && w.wave.chaos > 0) say('warn', `Write-back: ${fmt(c.dirty)} writes are acknowledged but only live in Cache #${c.id}'s RAM. If it crashes, they are gone. Fine for counters/likes, not for orders.`, c);
    }
  }

  // ---- outages
  for (const d of dbs) if (d.downFor > 0) {
    const reps = w.children(d, ['replica']).filter((r) => r.downFor <= 0);
    say('bad', reps.length ? `Primary DB #${d.id} is down: writes fail until replica #${reps[0].id} is promoted (~${Math.max(0, Math.ceil(15 - d.outage))}s). A queue in front of writes would have absorbed this.` : `Primary DB #${d.id} is down and has no replica to fail over to: every write (and every read that misses the cache) fails.`, d);
  }
  if (running && w.log.slice(0, 6).some((l) => l.text.includes('OOM-killed') && performance.now() - l.t < 8000))
    say('bad', 'Servers are being OOM-killed: requests are held in memory while they wait on something slow (in-flight = req/s × response time). Each crash moves its traffic to the survivors, which then run out of memory too (cascading failure). Fix the slow dependency, or add servers with headroom.');
  if (w.metrics.lostWrites >= 1) say('bad', `${fmt(w.metrics.lostWrites)} acknowledged writes were lost this wave (unflushed write-back cache or un-replicated writes at failover). Users were told "saved".`);

  // ---- single points of failure
  const front = w.children(users);
  if (w.unlocked('loadbalancer') && front.filter((n) => n.kind === 'server').length > 1)
    say('tip', 'Users connect straight to several servers (DNS round-robin): no health checks, so a crash still sends users to a dead box. Put a Load Balancer in front.');
  if (w.waveNum >= 4 && servers.length === 1 && w.owned(servers[0]) === 1)
    say('warn', servers[0].auto
      ? 'Your App Server group autoscales from a minimum of 1. If that instance dies, nothing serves until its replacement boots. Set the minimum to 2+ (N+1).'
      : 'You have one App Server. That\'s a single point of failure, and instances now fail at random.', servers[0]);
  for (const lb of of('loadbalancer')) if (w.tierOf(lb).vcpu && of('loadbalancer').length === 1 && w.waveNum >= 4)
    say('tip', `Load Balancer #${lb.id} is a self-managed instance: a single point of failure. The managed ALB is multi-AZ.`, lb);
  if (w.waveNum >= 9 && dbs.length && !has('replica')) say('warn', 'No read replica: if the primary dies, nothing can take over (managed DBs promote a replica in ~15-30s).', dbs[0]);

  // ---- memory, connections, storage
  for (const s of servers) {
    const t = w.tierOf(s);
    if (s.downFor <= 0 && s.stats.ram > t.ram * 0.75)
      say('bad', `App Server #${s.id} RAM ${gb(s.stats.ram)} of ${gb(t.ram)}: ${fmt(s.inflight)} requests in flight because each takes ${Math.round(s.resp)}ms. Close to an OOM kill.`, s);
  }
  for (const d of [...dbs, ...of('replica')]) {
    if (d.downFor > 0) continue;
    const t = w.tierOf(d), maxC = maxConnections(t.ram);
    if (d.conns > maxC * 0.85)
      say('bad', `${SPECS[d.kind].label} #${d.id}: ${fmt(d.conns)} of ${fmt(maxC)} connections (every app process keeps its own pool, and each connection costs ~8 MB). ${d.pooler ? 'Upgrade: max_connections scales with RAM.' : 'Turn on the connection pooler (RDS Proxy), or upgrade (max_connections scales with RAM).'}`, d);
    const b = w.bufferPool(d);
    if (b.ws > b.pool && (d.stats.util > 0.7 || b.hit < 0.8))
      say(d.stats.util > 0.9 ? 'bad' : 'warn', d.kind === 'replica'
        ? `Replica #${d.id}: working set ${gb(b.ws)} doesn't fit in ${gb(b.pool)} of page cache, so ${pct(1 - b.hit)} of page reads hit disk. Every replica holds a full copy, so more small replicas won't fix this: give it more RAM${primarySize(w, d)}.`
        : `${SPECS[d.kind].label} #${d.id}: working set ${gb(b.ws)} doesn't fit in ${gb(b.pool)} of page cache, so ${pct(1 - b.hit)} of page reads hit disk (IOPS-bound, slower queries). Cache more reads, move to an instance with more RAM (r6g = 8 GB per vCPU), or shard.`, d);
    if (d.kind === 'replica' && d.stats.lag > 1)
      say('warn', `Replica #${d.id} is ${d.stats.lag.toFixed(1)}s behind the primary: ${fmt(d.stats.stale)} reads/s may be stale (a user might not see their own post). Upgrade it or add another replica; read-your-writes paths should hit the primary.`, d);
  }
  for (const c of of('cache')) {
    const usable = w.tierOf(c).ram * CACHE_USABLE, hot = w.cacheHotSet(c);
    if (c.downFor <= 0 && c.warm > 0.9 && hot > usable * 1.2 && c.stats.hitRate < 0.85)
      say('tip', `Cache #${c.id} hit rate ${pct(c.stats.hitRate)}: the hot data (${gb(hot)}) is bigger than its ${gb(usable)} of usable memory, so the long tail keeps getting evicted. A bigger node, or a second cache (keys shard across them), raises it.`, c);
    if (c.downFor > 0 && c.strategy === 'aside') say('warn', `Cache #${c.id} is down: cache-aside falls back to the DB, so every read now hits it (watch for a stampede).`, c);
  }

  // ---- bottlenecks: highest utilization first
  const hot = w.nodes.filter((n) => n.kind !== 'users' && n.downFor <= 0 && (n.stats.util > 0.85 || n.stats.dropRps > 0.5)).sort((a, b) => b.stats.util - a.stats.util);
  for (const n of hot.slice(0, 2)) {
    const u = pct(n.stats.util);
    if (n.stats.util <= 0.85) { say('bad', `${SPECS[n.kind].label} #${n.id} is failing ${fmt(n.stats.dropRps)} req/s${n.stats.note ? `: ${n.stats.note}` : ''}.`, n); continue; }
    const nic = n.stats.rows.find((r) => r[0] === 'Network' && r[2]);
    if (nic) { say('bad', `${SPECS[n.kind].label} #${n.id} NIC saturated (${nic[1]}). Static files are bandwidth-heavy: put a CDN in front, or use bigger instances (more Gbps).`, n); continue; }
    switch (n.kind) {
      case 'server':
        if (n.auto && n.count >= n.auto.max) { say('bad', `App Server group #${n.id} at ${u} and already at its autoscaling max (${n.auto.max}). Raise the max.`, n); break; }
        if (n.auto && n.instDown.some((d) => d.boot)) { say('warn', `App Server group #${n.id} at ${u}: autoscaling is launching instances, but they take ~${BOOT_S}s to boot. Load that arrives faster than that needs headroom: a lower load target or a higher minimum.`, n); break; }
        say('bad', w.unlocked('loadbalancer') ? `App Server at ${u}. Add more servers behind the Load Balancer (horizontal scaling): select it and press + to grow it into a group, or ⌘/Ctrl+D to copy it with its links.` : `App Server at ${u}. Upgrade it (vertical scaling).`, n);
        break;
      case 'database': {
        if (n.stats.dropRps < 0.5 && n.stats.note.startsWith('Throttling')) {
          say('warn', 'Database is saturated, but live traffic goes first and async writes are being throttled (backpressure). If the queue backlog keeps growing, upgrade or shard the DB.', n);
          break;
        }
        const prims = dbs.filter((d) => d.downFor <= 0);
        const others = prims.filter((d) => d !== n);
        if (w.wave.event?.type === 'hotkey' && others.length && others.every((d) => d.stats.util < n.stats.util * 0.7)) {
          say('bad', `Database #${n.id} at ${u} owns the hot key, while the other shards idle (${others.map((d) => pct(d.stats.util)).join(', ')}). More shards barely help: the hot key's traffic can only live on one of them. Serve its reads from a Cache, give this shard replicas or a bigger instance, and batch its writes through a Queue.`, n);
          break;
        }
        const readsHeavy = w.wave.mix.r > w.wave.mix.w * 2;
        // sharding divides the load: N shards each get ~1/N, so a primary at 300% needs ~3x the capacity
        const need = Math.ceil(n.stats.util * prims.length / 0.8);
        const shardTip = w.unlocked('sharding') && n.stats.util > 1.1
          ? ` Sharding splits load evenly: at ${u} on ${prims.length} shard${prims.length > 1 ? 's' : ''}, you need ~${need} shards this size to sit near 80% (or bigger instances).`
          : '';
        const opts: string[] = [];
        if (readsHeavy && w.unlocked('cache') && !has('cache')) opts.push('add a Cache (cache-aside) to absorb reads');
        if (readsHeavy && w.unlocked('replica')) opts.push(has('replica') ? 'add another Read Replica' : 'add Read Replicas');
        if (!readsHeavy && w.unlocked('queue') && !has('queue')) opts.push('send writes through a Queue + Workers');
        if (!readsHeavy && w.unlocked('sharding')) opts.push('shard across more primaries');
        if (w.upgradeCost(n) !== null && w.unlocked('upgrade')) opts.push(running ? 'upgrade it between waves (resizing now restarts it)' : 'upgrade it');
        say('bad', `Database at ${u}. A write costs ~5x a read here. Try: ${opts.join(', ') || 'upgrading it'}.${shardTip}`, n);
        break;
      }
      case 'replica': {
        const b = w.bufferPool(n);
        say('bad', b.ws > b.pool
          ? `Replica #${n.id} at ${u}: it's disk-bound because the ${gb(b.ws)} working set doesn't fit in its RAM. Another replica of this size won't help (each one needs the whole working set); upgrade it${primarySize(w, n)}.`
          : `Replica at ${u}. Add another replica (reads split across them) or upgrade it. Every replica also replays every write, so on write-heavy waves upgrading beats adding more.`, n);
        break;
      }
      case 'worker': say('warn', `Worker at ${u}. Add workers to drain the queue faster (but watch the DB).`, n); break;
      default: say('bad', `${SPECS[n.kind].label} at ${u}. Upgrade it or add another.`, n);
    }
  }

  // ---- queue backlog
  for (const q of of('queue').filter((n) => n.backlog > 500))
    say('warn', `Queue backlog: ${fmt(q.backlog)} writes, ${q.stats.lag.toFixed(0)}s behind. Users got their ack, but the data isn't in the DB yet, so their own reads miss it (eventual consistency).`, q);

  // ---- burstable instances billing surplus CPU credits
  for (const n of w.nodes) {
    const t = w.tierOf(n);
    if (!running || t.baseline == null || n.stats.cpu <= t.baseline + 0.2) continue;
    const extra = n.stats.cost - w.fixedCost(n);
    if (extra > t.cost) say('warn', `${SPECS[n.kind].label} #${n.id} is a burstable ${t.name} running at ${pct(n.stats.cpu)} CPU (only ${pct(t.baseline)} included): +$${Math.round(extra)}/mo in surplus credits. A non-burstable size is cheaper at this load.`, n);
  }

  // ---- unused tools that would help
  const m = w.wave.mix;
  if (!running && w.unlocked('autoscale')) {
    const fixed = of('server').find((s) => !s.auto && s.count >= 2);
    if (fixed) say('tip', `App Server group #${fixed.id} is a fixed ${fixed.count} instances, so it bills for peak all month. Turn on autoscaling: it follows the traffic curve and shrinks off-peak.`, fixed);
  }
  if (w.unlocked('cdn') && !has('cdn') && m.s >= 0.3) say('tip', `${pct(m.s)} of traffic is static. A CDN serves it from the edge (~20ms instead of up to 180ms for far users) and takes the bytes off your servers' NICs.`);
  if (w.unlocked('ratelimiter') && !has('ratelimiter') && m.b > 0) say('bad', `Bots are sending ${fmt(w.metrics.botRps || w.wave.peakRps * m.b)} req/s. Put a Rate Limiter in front.`);
  if (w.unlocked('cache') && !has('cache') && dbs.length && !running) say('tip', 'Most traffic is repeat reads of popular data. A Cache (Server → Cache, keep Server → Database) pays for itself fast.');
  if (w.metrics.staleRate > 0.03 && running) say(w.metrics.staleRate > SLA.stale ? 'warn' : 'tip', `${pct(w.metrics.staleRate)} of reads may be stale (replica lag, queue backlog or CDN TTL)${w.metrics.staleRate > SLA.stale ? `. Past ${pct(SLA.stale)} users notice their writes "vanishing" and reputation drops: drain the backlog (more workers / a bigger DB) or catch up the replicas` : '. Fine for feeds, not for "did my payment go through?"'}.`);

  if (!hints.length) hints.push({ level: 'tip', text: running ? 'All systems nominal.' : 'Looks healthy. Check the next wave\'s peak, then press Start.' });
  const rank = { bad: 0, warn: 1, tip: 2 };
  return hints.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 5);
}

/** ", e.g. to db.r6g.xlarge like its primary" when the replica is smaller than the primary it copies */
function primarySize(w: World, r: SimNode) {
  const p = w.parents(r).find((x) => x.kind === 'database');
  return p && p.tier > r.tier ? ` (match its primary: ${w.tierOf(p).name})` : '';
}
