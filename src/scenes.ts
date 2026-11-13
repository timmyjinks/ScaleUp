/** Scripted mini diagrams for the component guide. Coordinates are in a 360x200 scene. */
import { C, Scene } from './minidiagram';

export type SceneId = 'server' | 'database' | 'sharding' | 'loadbalancer' | 'cache' | 'cdn' | 'replica' | 'queue' | 'ratelimiter';

const BUILD: Record<SceneId, () => Scene> = {
  // ---------------------------------------------------------------- App server: request / response
  server() {
    const s = new Scene()
      .node('u', 'users', 50, 92, 'Users')
      .node('app', 'server', 180, 92, 'App Server')
      .node('db', 'database', 310, 92, 'Database')
      .edge('u', 'app').edge('app', 'db');
    let t = 0.3;
    s.cap(0, 'A user asks for their feed. The App Server runs your code to build the response.');
    t = s.send(['u', 'app'], t, C.read, { label: 'GET /feed' });
    s.glow('app', t, t + 0.5, C.read);
    s.cap(t + 0.2, 'Reads and writes need data, so the server asks the Database.');
    t = s.send(['app', 'db'], t + 0.5, C.read);
    s.badge('db', t, 'SELECT', C.read);
    t = s.send(['db', 'app'], t + 0.5, C.ok);
    t = s.send(['app', 'u'], t + 0.15, C.ok, { label: '200 OK' });
    s.cap(t + 0.4, 'Static files (images, JS) it can send by itself. No database trip.');
    t = s.send(['u', 'app'], t + 0.8, C.static, { label: 'logo.png' });
    s.badge('app', t, 'static file', C.static);
    t = s.send(['app', 'u'], t + 0.5, C.ok);
    s.cap(t + 0.4, 'Servers keep no state of their own, so you can run many identical copies.');
    return s.end(t + 2.8);
  },

  // ---------------------------------------------------------------- Database: writes are heavy
  database() {
    const s = new Scene()
      .node('s1', 'server', 60, 50, 'App Server')
      .node('s2', 'server', 60, 148, 'App Server')
      .node('db', 'database', 270, 98, 'Database', { sub: 'the one primary' })
      .edge('s1', 'db').edge('s2', 'db');
    s.cap(0, 'The database is the source of truth. Every read and write ends up here.');
    let t = 0.3;
    for (let i = 0; i < 4; i++) { const a = s.send([i % 2 ? 's2' : 's1', 'db'], t, C.read); if (i === 1) s.badge('db', a, 'read: 1x', C.read, 1); t += 0.45; }
    s.cap(2.4, 'Writes are heavy: disk sync, index updates, row locks. Each costs about 3 reads.');
    t = 2.6;
    for (let i = 0; i < 5; i++) {
      const a = s.send([i % 2 ? 's2' : 's1', 'db'], t, C.write, { heavy: true, label: i === 0 ? 'INSERT' : undefined });
      s.badge('db', a, 'write: 3x', C.write, 0.9);
      t += 0.7;
    }
    s.bar('db', [[0, 0.12], [2.4, 0.3], [4.4, 0.75], [6.2, 1], [7.6, 1], [9.4, 0.25]]);
    s.glow('db', 5.8, 7.8, C.bad);
    s.cap(5.6, 'There is only one primary that takes writes, so it becomes the bottleneck.');
    s.cap(7.8, 'Relief: cache or replicas for reads, a queue for write spikes, sharding for more writes.');
    return s.end(10.6);
  },

  // ---------------------------------------------------------------- Sharding: hash partitioning + hot key
  sharding() {
    const s = new Scene()
      .node('app', 'server', 55, 98, 'App Server', { sub: 'hash(key) % 3' })
      .node('a', 'database', 285, 30, 'Shard A')
      .node('b', 'database', 285, 98, 'Shard B')
      .node('c', 'database', 285, 166, 'Shard C')
      .edge('app', 'a').edge('app', 'b').edge('app', 'c');
    s.cap(0, 'Sharding splits the data across several primaries. The key decides which one gets it.');
    const keys: [string, string][] = [['user:17', 'a'], ['user:42', 'b'], ['user:8', 'c'], ['user:91', 'a'], ['user:23', 'c'], ['user:5', 'b']];
    let t = 0.4;
    for (const [k, sh] of keys) { const a = s.send(['app', sh], t, C.write, { label: k }); s.glow(sh, a, a + 0.4, C.write); t += 0.6; }
    s.cap(3.0, 'Keys spread evenly, so each shard does a third of the writes.');
    s.cap(5.6, 'A celebrity posts. Everyone writes to the same key, which lives on one shard.');
    t = 5.8;
    for (let i = 0; i < 10; i++) { s.send(['app', 'b'], t, C.write, { label: i === 0 ? '@celeb' : undefined }); t += 0.22; }
    s.send(['app', 'a'], 6.4, C.write); s.send(['app', 'c'], 7.3, C.write);
    s.badge('b', 7.2, 'HOT SHARD', C.bad, 2.2, 'left');
    s.glow('b', 6.8, 9.2, C.bad);
    for (const sh of ['a', 'c']) s.bar(sh, [[0, 0.1], [3, 0.35], [5.6, 0.35], [7, 0.4], [9.4, 0.3]]);
    s.bar('b', [[0, 0.1], [3, 0.35], [5.6, 0.35], [7.2, 1], [8.8, 1], [10.2, 0.35]]);
    s.cap(9.2, 'Choose a shard key that spreads load evenly, and split up hot keys.');
    return s.end(11.6);
  },

  // ---------------------------------------------------------------- Load balancer: spread + health checks
  loadbalancer() {
    const s = new Scene()
      .node('u', 'users', 40, 98, 'Users')
      .node('lb', 'loadbalancer', 145, 98, 'Load Balancer')
      .node('s1', 'server', 285, 34, 'Server 1')
      .node('s2', 'server', 285, 98, 'Server 2')
      .node('s3', 'server', 285, 162, 'Server 3')
      .edge('u', 'lb').edge('lb', 's1').edge('lb', 's2').edge('lb', 's3');
    s.cap(0, 'The load balancer spreads requests across identical servers.');
    let t = 0.3;
    for (let i = 0; i < 6; i++) { s.send(['u', 'lb', `s${(i % 3) + 1}`], t, C.read); t += 0.42; }
    s.down('s2', 3.4, 9.6);
    s.badge('s2', 3.4, 'CRASH', C.bad, 1.4);
    s.cap(3.4, 'Server 2 crashes.');
    const ping = s.send(['lb', 's2'], 4.2, C.muted, { r: 2.6, label: 'health?' });
    s.badge('s2', ping, 'no reply', C.bad, 1);
    s.badge('lb', ping + 0.3, 'skip #2', C.warn, 1.6);
    s.cap(4.2, 'Health checks ping every server every few seconds. Server 2 stops answering…');
    s.cap(5.8, '…so the LB routes around it. Users never notice.');
    t = 5.8;
    for (let i = 0; i < 7; i++) { s.send(['u', 'lb', i % 2 ? 's3' : 's1'], t, C.read); t += 0.42; }
    s.cap(9.6, 'Once it recovers and passes its health check, it gets traffic again.');
    const ok = s.send(['lb', 's2'], 9.6, C.ok, { r: 2.6, label: 'health?' });
    s.badge('s2', ok, 'healthy', C.ok, 1);
    t = ok + 0.4;
    for (let i = 0; i < 3; i++) { s.send(['u', 'lb', `s${(i % 3) + 1}`], t, C.read); t += 0.42; }
    return s.end(t + 1.8);
  },

  // ---------------------------------------------------------------- Cache-aside
  cache() {
    const s = new Scene()
      .node('u', 'users', 34, 98, 'Users')
      .node('app', 'server', 140, 98, 'App Server')
      .node('cache', 'cache', 290, 40, 'Cache')
      .node('db', 'database', 290, 150, 'Database')
      .edge('u', 'app').edge('app', 'cache').edge('app', 'db');
    s.cap(0, 'Cache-aside: the server checks the cache first, before the database.');
    let t = 0.3;
    t = s.send(['u', 'app'], t, C.read, { label: 'GET feed:42' });
    t = s.send(['app', 'cache'], t + 0.15, C.read);
    s.badge('cache', t, 'MISS', C.warn, 1.3);
    s.cap(t, 'MISS: the key is not in the cache yet.');
    t = s.send(['cache', 'app'], t + 0.4, C.muted, { r: 2.6 });
    s.cap(t + 0.1, 'So the server reads it from the database (slow, ~10ms)…');
    t = s.send(['app', 'db'], t + 0.2, C.read);
    s.badge('db', t, 'SELECT', C.read);
    t = s.send(['db', 'app'], t + 0.5, C.ok);
    s.cap(t, '…then stores the value in the cache for next time.');
    const set = s.send(['app', 'cache'], t + 0.15, C.copy, { label: 'SET' });
    s.badge('cache', set, 'stored', C.ok);
    s.send(['app', 'u'], t + 0.15, C.ok);
    t = set + 1.4;
    s.cap(t, 'Next read: HIT. Answered from memory in ~1ms, and the database never sees it.');
    for (let i = 0; i < 2; i++) {
      let r = s.send(['u', 'app'], t, C.read);
      r = s.send(['app', 'cache'], r + 0.1, C.read);
      s.badge('cache', r, 'HIT', C.ok, 0.9);
      r = s.send(['cache', 'app'], r + 0.1, C.ok);
      r = s.send(['app', 'u'], r + 0.05, C.ok);
      t = r + 0.3;
    }
    s.cap(t, 'A write goes to the database, then deletes the cached key so nobody reads stale data.');
    t = s.send(['u', 'app'], t + 0.2, C.write, { heavy: true, label: 'POST' });
    const w = s.send(['app', 'db'], t + 0.15, C.write, { heavy: true });
    s.badge('db', w, 'UPDATE', C.write);
    const del = s.send(['app', 'cache'], w + 0.2, C.bad, { label: 'DEL feed:42' });
    s.badge('cache', del, 'invalidated', C.bad);
    s.cap(del + 0.5, 'The next read misses again and refetches the fresh value. Popular keys stay warm.');
    s.live('cache', (x) => (x < set ? 'empty' : x < del ? 'feed:42 ✓' : 'empty'), '#8a93a6');
    return s.end(del + 3.2);
  },

  // ---------------------------------------------------------------- CDN: geography + offloading
  cdn() {
    const s = new Scene()
      .zone(6, 6, 146, 90, 'Tokyo')
      .zone(6, 104, 146, 90, 'São Paulo')
      .zone(238, 6, 116, 188, 'Origin · Virginia')
      .node('ut', 'users', 40, 46, 'Users')
      .node('et', 'cdn', 116, 46, 'CDN edge')
      .node('us', 'users', 40, 144, 'Users')
      .node('es', 'cdn', 116, 144, 'CDN edge')
      .node('o', 'server', 296, 96, 'Origin', { sub: 'LB + servers' })
      .edge('ut', 'et').edge('us', 'es')
      .edge('et', 'o', { label: '~150ms' }).edge('es', 'o', { label: '~120ms' });
    const originTimes: number[] = [];
    const toOrigin = (path: string[], t: number, color: string) => { const a = s.send(path, t, color); originTimes.push(a); return a; };
    s.cap(0, 'Your users are on other continents. Every trip to your data center crosses an ocean.');
    let t = 0.3;
    t = s.send(['ut', 'et'], t, C.static, { label: 'cat.jpg' });
    s.badge('et', t, 'MISS', C.warn);
    s.cap(t, 'First request for an image: the edge does not have it yet, so it fetches it from origin once.');
    t = toOrigin(['et', 'o'], t + 0.3, C.static);
    t = s.send(['o', 'et'], t + 0.3, C.ok);
    s.badge('et', t, 'cached', C.ok);
    const cachedAt = t;
    t = s.send(['et', 'ut'], t + 0.1, C.ok);
    s.cap(t + 0.3, 'After that, everyone nearby gets it straight from the edge. A short hop: ~20ms.');
    t += 0.6;
    for (let i = 0; i < 4; i++) {
      const [u, e] = i % 2 ? ['us', 'es'] : ['ut', 'et'];
      let r = s.send([u, e], t, C.static, { label: i === 0 ? 'app.js' : undefined });
      s.badge(e, r, 'HIT', C.ok, 0.8);
      s.send([e, u], r + 0.05, C.ok);
      t += 0.55;
    }
    t += 0.6;
    s.cap(t, 'API calls (your feed, a checkout) are dynamic, so the edge passes them through to origin.');
    let a = s.send(['us', 'es'], t, C.read, { label: 'GET /api/feed' });
    s.badge('es', a, 'pass through', C.read, 1);
    a = toOrigin(['es', 'o'], a + 0.2, C.read);
    a = s.send(['o', 'es'], a + 0.4, C.ok);
    a = s.send(['es', 'us'], a, C.ok);
    // keep static hits flowing while the API call travels
    for (let k = t + 0.3; k < a; k += 0.7) { const r = s.send(['ut', 'et'], k, C.static); s.send(['et', 'ut'], r + 0.05, C.ok); }
    s.cap(a + 0.2, 'Result: pages load fast worldwide, and most of the bytes never touch your servers.');
    s.live('et', (x) => (x >= cachedAt ? 'cat.jpg ✓' : null), C.ok);
    s.live('o', (x) => `origin hits: ${originTimes.filter((o) => o <= x).length}`, '#8a93a6');
    return s.end(a + 3);
  },

  // ---------------------------------------------------------------- Read replicas: read/write split + lag
  replica() {
    const s = new Scene()
      .node('app', 'server', 46, 108, 'App Server')
      .node('p', 'database', 190, 36, 'Primary', { sub: 'writes' })
      .node('r1', 'replica', 312, 88, 'Replica 1')
      .node('r2', 'replica', 312, 152, 'Replica 2')
      .edge('app', 'p', { label: 'writes', color: '#5b4a2e', labelColor: C.write })
      .edge('app', 'r1', { label: 'reads', color: '#2c3d5e', labelColor: C.read })
      .edge('app', 'r2', { color: '#2c3d5e' })
      .edge('p', 'r1', { dashed: true, color: C.copy })
      .edge('p', 'r2', { dashed: true, color: C.copy });
    s.cap(0, 'Read replicas are read-only copies of the primary. Reads go to the replicas…');
    let t = 0.3;
    for (let i = 0; i < 4; i++) {
      const r = i % 2 ? 'r2' : 'r1';
      const a = s.send(['app', r], t, C.read);
      s.send([r, 'app'], a + 0.15, C.ok);
      t += 0.6;
    }
    s.cap(2.9, '…while writes go only to the primary.');
    const w = s.send(['app', 'p'], 3.0, C.write, { heavy: true, label: 'UPDATE' });
    s.badge('p', w, 'saved', C.write);
    s.cap(w + 0.2, 'The primary copies every change to each replica, a moment later (replication lag).');
    const c1 = s.send(['p', 'r1'], w + 0.3, C.copy, { speed: 50, label: 'copy' });
    const c2 = s.send(['p', 'r2'], w + 0.3, C.copy, { speed: 50, label: 'copy' });
    // read right after the write reaches replica 2 before the copy does
    const stale = s.send(['app', 'r2'], w + 0.5, C.read);
    s.badge('r2', stale, 'old value!', C.warn, 1.3);
    s.send(['r2', 'app'], stale + 0.2, C.warn);
    s.cap(stale, 'A read right after a write can still see the old value. That is the price of replicas.');
    s.badge('r1', c1, 'synced', C.copy, 1);
    s.badge('r2', c2 + 0.1, 'synced', C.copy, 1);
    let t2 = Math.max(c1, c2) + 0.6;
    s.cap(t2, 'Every replica also has to apply every write, so replicas help reads, not writes.');
    for (let i = 0; i < 4; i++) {
      const r = i % 2 ? 'r2' : 'r1';
      const a = s.send(['app', r], t2, C.read);
      s.send([r, 'app'], a + 0.15, C.ok);
      t2 += 0.6;
    }
    s.live('r2', (x) => (x >= w && x < c2 ? `lag ${Math.round((x - w) * 100)}ms` : null), C.copy);
    return s.end(t2 + 2.2);
  },

  // ---------------------------------------------------------------- Queue + worker: absorb a spike
  queue() {
    const s = new Scene()
      .node('u', 'users', 30, 110, 'Users')
      .node('app', 'server', 105, 110, 'Server')
      .node('q', 'queue', 182, 110, 'Queue')
      .node('wk', 'worker', 260, 110, 'Worker')
      .node('db', 'database', 334, 110, 'DB')
      .edge('u', 'app').edge('app', 'q').edge('q', 'wk').edge('wk', 'db');
    const arrivals = [0.3, 1.9, 5.0, 5.25, 5.5, 5.75, 6.0, 6.25, 6.5, 6.75];
    const ins: number[] = [], outs: number[] = [];
    for (const [i, a] of arrivals.entries()) {
      const atApp = s.send(['u', 'app'], a, C.write, { label: i === 0 ? 'order' : undefined });
      const atQ = s.send(['app', 'q'], atApp + 0.05, C.write);
      ins.push(atQ);
      const ackApp = s.send(['q', 'app'], atQ + 0.05, C.ok, { r: 2.6, label: i === 0 ? 'ack' : undefined });
      s.send(['app', 'u'], ackApp, C.ok, { r: 2.6 });
    }
    // one worker, one job every 0.9s
    let free = 0;
    for (const at of ins) {
      const start = Math.max(at + 0.2, free);
      outs.push(start);
      const atW = s.send(['q', 'wk'], start, C.write);
      s.glow('wk', atW, atW + 0.5, C.write);
      const atDb = s.send(['wk', 'db'], atW + 0.25, C.write);
      s.glow('db', atDb, atDb + 0.4, C.write);
      free = start + 0.9;
    }
    s.stack('q', ins, outs);
    s.live('q', (x) => { const n = ins.filter((i) => i <= x).length - outs.filter((o) => o <= x).length; return n > 0 ? `${n} waiting` : 'empty'; });
    s.bar('db', [[0, 0.45], [20, 0.45]]);
    s.cap(0, 'The server drops each order on a queue instead of writing to the DB right away.');
    s.cap(1.2, 'The queue says "got it" instantly, so the user is not kept waiting.');
    s.cap(4.9, 'Flash sale! A burst of orders. Every one is still acknowledged right away.');
    s.cap(7.4, 'The backlog absorbs the spike. The worker drains it at a pace the DB can handle.');
    const last = outs[outs.length - 1] + 1.2;
    s.cap(last, 'All caught up. The database never saw the spike, just a steady stream.');
    return s.end(last + 2.6);
  },

  // ---------------------------------------------------------------- Rate limiter: bounce the bots
  ratelimiter() {
    const s = new Scene()
      .node('real', 'users', 40, 46, 'Users')
      .node('bots', 'users', 40, 150, 'Bots', { color: '#be123c' })
      .node('rl', 'ratelimiter', 175, 98, 'Rate Limiter')
      .node('app', 'server', 310, 98, 'App Server')
      .edge('real', 'rl').edge('bots', 'rl').edge('rl', 'app');
    const blocked: number[] = [];
    let i = 0;
    for (let t = 0.3; t < 9.4; t += 0.2, i++) {
      const a = s.send(['bots', 'rl'], t, C.bot, { r: 3 });
      if (i < 3 || i % 7 === 3) { s.send(['rl', 'app'], a, C.bot, { r: 3 }); continue; }
      blocked.push(a);
      s.send(['rl', 'bots'], a, C.bot, { r: 2.4, speed: 170, lane: 7, label: i % 6 === 0 ? '429' : undefined });
    }
    for (let t = 0.9; t < 9.4; t += 1.1) s.send(['real', 'rl', 'app'], t, C.read);
    s.live('rl', (x) => { const n = blocked.filter((b) => b <= x).length; return n ? `${n} blocked` : null; }, C.bot);
    s.bar('app', [[0, 0.2], [0.6, 0.85], [1.4, 0.5], [2.2, 0.35], [10, 0.35]]);
    s.cap(0, 'A scraper hammers your API with far more requests than any real person would.');
    s.cap(1.6, 'The rate limiter counts requests per client. Over the limit? 429 Too Many Requests.');
    s.cap(4.6, 'Real users stay under their limit and pass straight through.');
    s.cap(7.2, 'Your servers see real traffic plus a small trickle of bots, not the whole flood.');
    return s.end(10.6);
  },
};

const cache = new Map<SceneId, Scene>();
export function getScene(id: SceneId): Scene {
  let s = cache.get(id);
  if (!s) { s = BUILD[id](); cache.set(id, s); }
  return s;
}
