/**
 * Save / resume. Serializes the World's persistent state to a versioned JSON
 * snapshot and restores it into a fresh World.
 *
 * Serialization is deliberately generic so new fields added to SimNode / Edge /
 * World later survive without touching this file:
 *  - nodes: every own field except the runtime `stats` object
 *  - edges: every own field except the runtime `rps` mix
 *  - world: every own scalar (number/string/boolean) field except a small
 *    denylist of per-wave runtime values (phase, time, ...)
 * On load, each node is first created through `world.addNode(kind, x, y, true)`
 * so it gets current defaults (incl. fields old saves don't know about), then the
 * saved fields are copied over it.
 */
import { GROUPABLE, MAX_GROUP, SPECS, makeWave } from './config';
import type { Renderer } from './render';
import { World, zero } from './sim';
import type { Edge, NodeKind, SimNode } from './types';

export const SAVE_VERSION = 1;
export type Mode = 'campaign' | 'sandbox';
export const SLOT_KEY: Record<Mode, string> = { campaign: 'scaleup:save:campaign', sandbox: 'scaleup:save:sandbox' };
/** Best wave across runs; the key main.ts already uses for the game-over screen. */
export const BEST_KEY = 'best';

/** Things main.ts owns that the save/sandbox modules need. */
export interface Host {
  getWorld(): World;
  getRenderer(): Renderer;
  /** Swap in a world: new renderer, re-wire callbacks, clear selection. */
  adopt(w: World): void;
  /** main.ts reset(): fresh campaign + lesson 1. */
  reset(): void;
  lessonsSeen: Set<number>;
  quick: Set<string>;
  modal(html: string, actions: { label: string; primary?: boolean; onClick?: () => void }[]): void;
  toast(text: string, kind?: 'bad' | 'info'): void;
  /** tutorial tips preference (main.ts) */
  tips: { on(): boolean; set(on: boolean): void };
}

export interface Snapshot {
  v: number;
  mode: Mode;
  savedAt: number;
  world: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  nextId: number;
  history?: unknown[];
  log?: { text: string; kind: string }[];
  lessonsSeen: number[];
  quick: string[];
  cam?: { x: number; y: number; z: number };
  /** sandbox panel settings (sandbox slot only) */
  sandbox?: Record<string, unknown>;
}

/** World scalars that only make sense mid-wave (or are private accumulators). */
const WORLD_SKIP = new Set(['phase', 'time', 'sampleAcc', 'asyncRejected', 'nextId']);
const NODE_SKIP = new Set(['stats']);
const EDGE_SKIP = new Set(['rps']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function strip(o: object, skip: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!skip.has(k) && typeof v !== 'function') out[k] = v;
  return clone(out);
}

/** nextId is private in World; read it through the object, fall back to max id + 1. */
function readNextId(w: World) {
  const raw = (w as unknown as { nextId?: unknown }).nextId;
  const maxId = Math.max(0, ...w.nodes.map((n) => n.id), ...w.edges.map((e) => e.id));
  return Math.max(typeof raw === 'number' ? raw : 0, maxId + 1);
}

export function snapshot(host: Host, mode: Mode, extra?: Record<string, unknown>): Snapshot {
  const w = host.getWorld();
  const scalars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(w)) {
    if (WORLD_SKIP.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') scalars[k] = v;
  }
  const cam = host.getRenderer().cam;
  return {
    v: SAVE_VERSION,
    mode,
    savedAt: Date.now(),
    world: scalars,
    nodes: w.nodes.map((n) => strip(n, NODE_SKIP)),
    edges: w.edges.map((e) => strip(e, EDGE_SKIP)),
    nextId: readNextId(w),
    history: clone(w.history),
    log: w.log.slice(0, 20).map((l) => ({ text: l.text, kind: l.kind })),
    lessonsSeen: [...host.lessonsSeen],
    quick: [...host.quick],
    cam: { x: cam.x, y: cam.y, z: cam.z },
    sandbox: extra,
  };
}

export function isSnapshot(s: unknown): s is Snapshot {
  if (!s || typeof s !== 'object') return false;
  const o = s as Partial<Snapshot>;
  return o.v === SAVE_VERSION && (o.mode === 'campaign' || o.mode === 'sandbox') && Array.isArray(o.nodes) && Array.isArray(o.edges)
    && !!o.world && typeof o.world === 'object' && typeof o.world.waveNum === 'number';
}

/** Build a World from a snapshot. Always lands in the build phase of the saved wave. Throws on bad data. */
export function restoreWorld(s: Snapshot): World {
  const w = new World();
  const fresh = w as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(s.world)) {
    if (WORLD_SKIP.has(k)) continue;
    if (k in fresh && typeof fresh[k] === typeof v) fresh[k] = v;
  }
  w.nodes = [];
  for (const raw of s.nodes) {
    if (typeof raw.kind !== 'string' || !(raw.kind in SPECS) || typeof raw.id !== 'number') continue;
    const n = w.addNode(raw.kind as NodeKind, Number(raw.x) || 0, Number(raw.y) || 0, true);
    if (typeof n === 'string') continue;
    const stats = n.stats;
    Object.assign(n, clone(raw));
    n.stats = stats;
    // resume at the start of a build phase: mirror what World.endWave() resets
    if (n.kind !== 'queue') n.backlog = 0;
    n.downFor = 0;
    n.count = Math.max(1, Math.round(Number(n.count) || 1));
    n.instDown = [];
    // a save made mid-wave holds the live size; resume an autoscaling group at its minimum, like endWave does
    const a = n.auto as Partial<NonNullable<SimNode['auto']>> | null | undefined;
    if (a && typeof a === 'object' && GROUPABLE.includes(n.kind)) {
      const min = Math.min(n.count, Math.max(1, Math.round(Number(a.min)) || n.count));
      n.auto = { min, max: Math.min(MAX_GROUP, Math.max(min, Math.round(Number(a.max)) || min)), target: Math.min(0.95, Math.max(0.2, Number(a.target) || 0.6)) };
      n.count = min;
    } else n.auto = null; // older saves have no policy
  }
  if (!w.nodes.some((n) => n.kind === 'users')) w.addNode('users', 80, 300, true);
  const ids = new Set(w.nodes.map((n) => n.id));
  w.edges = s.edges
    .filter((e) => typeof e.id === 'number' && ids.has(e.from as number) && ids.has(e.to as number))
    .map((e) => ({ ...clone(e), rps: zero() }) as unknown as Edge);
  (w as unknown as { nextId: number }).nextId = Math.max(Number(s.nextId) || 0, readNextId(w));
  w.linkReaders(); // older saves: servers on a primary read from its replicas too
  w.wave = makeWave(w.waveNum);
  w.phase = 'build';
  w.time = 0;
  if (Array.isArray(s.history)) w.history = s.history as World['history'];
  if (Array.isArray(s.log)) w.log = s.log.map((l) => ({ t: 0, text: String(l.text), kind: (l.kind as 'info') ?? 'info' }));
  return w;
}

/** Adopt a snapshot into the running app (world, camera, lessons, quickstart). */
export function applySnapshot(host: Host, s: Snapshot) {
  const w = restoreWorld(s);
  host.adopt(w);
  const r = host.getRenderer();
  if (s.cam && [s.cam.x, s.cam.y, s.cam.z].every((v) => typeof v === 'number' && isFinite(v))) r.cam = { ...s.cam };
  else r.fit();
  host.lessonsSeen.clear();
  for (const l of s.lessonsSeen ?? []) host.lessonsSeen.add(l);
  host.quick.clear();
  for (const q of s.quick ?? []) host.quick.add(q);
}

// ------------------------------------------------------------------ storage

export function readSlot(mode: Mode): Snapshot | null {
  try {
    const raw = localStorage.getItem(SLOT_KEY[mode]);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return isSnapshot(s) && s.mode === mode ? s : null;
  } catch { return null; }
}

export function writeSlot(s: Snapshot) {
  try { localStorage.setItem(SLOT_KEY[s.mode], JSON.stringify(s)); return true; } catch { return false; }
}

export function clearSlot(mode: Mode) {
  try { localStorage.removeItem(SLOT_KEY[mode]); } catch { /* ignore */ }
}

export function recordBest(wave: number) {
  try {
    const best = Math.max(Number(localStorage.getItem(BEST_KEY) ?? 0) || 0, wave);
    localStorage.setItem(BEST_KEY, String(best));
  } catch { /* ignore */ }
}

/** Structural signature of the world: changes when the player builds, not when traffic flows. */
const RUNTIME_NODE = new Set(['stats', 'backlog', 'downFor', 'warm', 'retry']);
export function structureSig(w: World) {
  return JSON.stringify([w.waveNum, Math.round(w.money), w.nodes.map((n: SimNode) => strip(n, RUNTIME_NODE)), w.edges.map((e) => [e.id, e.from, e.to])]);
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJsonFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('No file'));
      f.text().then((t) => resolve(JSON.parse(t))).catch(reject);
    };
    input.click();
  });
}
