import { SPECS } from './config';
import { fmt, type World } from './sim';
import type { SimNode } from './types';

export interface Hint { level: 'bad' | 'warn' | 'tip'; text: string; node?: number }

/** Looks at the running system and explains what's wrong and what to try. */
export function advise(w: World): Hint[] {
  const hints: Hint[] = [];
  const has = (k: SimNode['kind']) => w.nodes.some((n) => n.kind === k);
  const users = w.nodes.find((n) => n.kind === 'users')!;
  const servers = w.nodes.filter((n) => n.kind === 'server');
  const dbs = w.nodes.filter((n) => n.kind === 'database');

  // wiring problems first
  if (!w.children(users).length) hints.push({ level: 'bad', text: 'Users aren\'t connected to anything. Drag from the Users port to a server.', node: users.id });
  for (const n of w.nodes) {
    if (n.kind === 'users') continue;
    if (!w.parents(n).length) hints.push({ level: 'warn', text: `${SPECS[n.kind].label} #${n.id} gets no traffic. Connect something into it.`, node: n.id });
  }
  for (const s of servers) if (!w.children(s, ['database', 'replica', 'cache', 'queue']).length)
    hints.push({ level: 'bad', text: `App Server #${s.id} has no database. Every read and write fails.`, node: s.id });
  for (const r of w.nodes.filter((n) => n.kind === 'replica')) if (!w.parents(r).some((p) => p.kind === 'database'))
    hints.push({ level: 'bad', text: `Replica #${r.id} isn't replicating. Connect Database → Replica.`, node: r.id });
  for (const q of w.nodes.filter((n) => n.kind === 'queue')) if (!w.children(q, ['worker']).length)
    hints.push({ level: 'bad', text: `Queue #${q.id} has no workers, so writes pile up forever.`, node: q.id });
  for (const k of w.nodes.filter((n) => n.kind === 'worker')) if (!w.children(k).length)
    hints.push({ level: 'bad', text: `Worker #${k.id} has no database to write to.`, node: k.id });

  // single points of failure
  const front = w.children(users);
  if (w.unlocked('loadbalancer') && front.filter((n) => n.kind === 'server').length > 1)
    hints.push({ level: 'tip', text: 'Users connect straight to several servers (DNS round-robin): no health checks, so a crash still sends users to a dead box. Put a Load Balancer in front.' });
  if (w.waveNum >= 4 && servers.length === 1)
    hints.push({ level: 'warn', text: 'You have one App Server. That\'s a single point of failure, and servers now crash at random.', node: servers[0].id });

  // bottlenecks: highest utilization first
  const hot = w.nodes.filter((n) => n.kind !== 'users' && (n.stats.util > 0.85 || n.stats.dropRps > 0.5)).sort((a, b) => b.stats.util - a.stats.util);
  for (const n of hot.slice(0, 2)) {
    const u = `${Math.round(n.stats.util * 100)}%`;
    switch (n.kind) {
      case 'server':
        if (!w.unlocked('loadbalancer')) hints.push({ level: 'bad', text: `App Server at ${u}. Upgrade it (vertical scaling).`, node: n.id });
        else hints.push({ level: 'bad', text: `App Server at ${u}. Add more servers behind the Load Balancer (horizontal scaling).`, node: n.id });
        break;
      case 'database': {
        if (n.stats.dropRps < 0.5 && n.stats.note.startsWith('Throttling')) {
          hints.push({ level: 'warn', text: `Database is saturated, but live traffic goes first and workers are being throttled (backpressure). The queue absorbs the rest. If the backlog keeps growing, upgrade or shard the DB.`, node: n.id });
          break;
        }
        const readsHeavy = w.wave.mix.r > w.wave.mix.w * 2;
        const opts: string[] = [];
        if (readsHeavy && w.unlocked('cache') && !has('cache')) opts.push('add a Cache to absorb reads');
        if (readsHeavy && w.unlocked('replica') && !has('replica')) opts.push('add Read Replicas');
        else if (readsHeavy && w.unlocked('replica')) opts.push('add another Read Replica');
        if (!readsHeavy && w.unlocked('queue') && !has('queue')) opts.push('send writes through a Queue + Workers');
        if (!readsHeavy && w.unlocked('sharding')) opts.push('shard across more primaries');
        if (w.upgradeCost(n) !== null && w.unlocked('upgrade')) opts.push('upgrade it');
        hints.push({ level: 'bad', text: `Database at ${u}. Writes cost 3x here. Try: ${opts.join(', ') || 'upgrading it'}.`, node: n.id });
        break;
      }
      case 'replica': hints.push({ level: 'bad', text: `Replica at ${u}. Add another replica or upgrade (remember, it also applies every write).`, node: n.id }); break;
      case 'worker': hints.push({ level: 'warn', text: `Worker at ${u}. Add workers to drain the queue faster.`, node: n.id }); break;
      default: hints.push({ level: 'bad', text: `${SPECS[n.kind].label} at ${u}. Upgrade it or add another.`, node: n.id });
    }
  }

  // queue backlog
  for (const q of w.nodes.filter((n) => n.kind === 'queue' && n.backlog > 500))
    hints.push({ level: 'warn', text: `Queue backlog: ${fmt(q.backlog)} writes. Users got their ack, but the data isn't in the DB yet (eventual consistency).`, node: q.id });

  // unused tools that would help
  const m = w.wave.mix;
  if (w.unlocked('cdn') && !has('cdn') && m.s >= 0.3) hints.push({ level: 'tip', text: `${Math.round(m.s * 100)}% of traffic is static. A CDN would serve it at the edge.` });
  if (w.unlocked('ratelimiter') && !has('ratelimiter') && m.b > 0) hints.push({ level: 'bad', text: `Bots are sending ${fmt(w.metrics.botRps)} req/s. Put a Rate Limiter in front.` });
  if (w.unlocked('cache') && !has('cache') && dbs.length && w.phase === 'build') hints.push({ level: 'tip', text: 'Most traffic is repeat reads. A Cache in front of the DB pays for itself fast.' });

  if (!hints.length) hints.push({ level: 'tip', text: w.phase === 'build' ? 'Looks healthy. Check the next wave\'s peak, then press Start.' : 'All systems nominal.' });
  return hints.slice(0, 4);
}
