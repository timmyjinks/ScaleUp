/**
 * Sandbox: free play for studying. Unlimited money, every tool unlocked, no game
 * over, continuous traffic you control from a floating panel.
 *
 * Works entirely from outside the sim (no sim.ts changes):
 *  - Unlocks: World.unlocked() compares waveNum to UNLOCKS, so waveNum = 99.
 *  - Traffic: the World is kept in the 'run' phase and its WaveDef is rewritten
 *    before every step (see beforeStep) with a huge duration so it never ends.
 *  - Events: crashes set node.downFor directly; hot key sets wave.event; spikes
 *    are applied to the target rps here so they can overlap a hot key.
 *  - No game over: reputation is floored before each step (it can still move, so
 *    you see SLA breaches hurt, but it never reaches 0).
 */
import { SPECS, TICK, USERS_PER_RPS, waveShape } from './config';
import { applySnapshot, type Host, type Snapshot } from './persist';
import { World, fmt } from './sim';
import type { WaveDef } from './types';

export const SANDBOX_WAVE = 99;
const MONEY = 1e9;
const REP_FLOOR = 5;
const MIN_USERS = 100, MAX_USERS = 10_000_000;
const SLIDER_MAX = 1000;

export interface SandboxSettings {
  users: number;
  /** raw weights; normalized when applied */
  mix: { s: number; r: number; w: number };
  /** bots as % of legit traffic */
  bots: number;
  chaos: boolean;
  spikeMult: number;
  spikeLen: number;
  collapsed: boolean;
}

const DEFAULTS: SandboxSettings = { users: 10_000, mix: { s: 25, r: 65, w: 10 }, bots: 0, chaos: false, spikeMult: 3, spikeLen: 10, collapsed: false };

const usersToSlider = (u: number) => Math.round((Math.log10(u / MIN_USERS) / Math.log10(MAX_USERS / MIN_USERS)) * SLIDER_MAX);
const sliderToUsers = (v: number) => {
  const raw = MIN_USERS * Math.pow(MAX_USERS / MIN_USERS, v / SLIDER_MAX);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1); // round to 2 significant digits
  return Math.round(raw / mag) * mag;
};

export class Sandbox {
  active = false;
  settings: SandboxSettings = structuredClone(DEFAULTS);
  /** in world.time seconds */
  private spike: { start: number; len: number; mult: number } | null = null;
  private hotUntil = 0;
  private panel: HTMLElement;
  private badge: HTMLElement;

  constructor(private host: Host, private onChange: () => void) {
    this.badge = document.createElement('span');
    this.badge.className = 'sb-badge hidden';
    this.badge.textContent = 'SANDBOX';
    this.badge.title = 'Free play: unlimited budget, every tool unlocked, no game over';
    document.querySelector('#hud .brand')?.after(this.badge);
    this.panel = document.createElement('aside');
    this.panel.id = 'sandbox';
    this.panel.className = 'hidden';
    document.body.appendChild(this.panel);
    this.buildPanel();
  }

  private get world(): World { return this.host.getWorld(); }

  // ------------------------------------------------------------ lifecycle

  /** Enter sandbox mode, from a saved sandbox snapshot or a blank canvas. */
  enter(snap: Snapshot | null) {
    this.settings = { ...structuredClone(DEFAULTS), ...(snap?.sandbox as Partial<SandboxSettings> | undefined) };
    if (snap) {
      try { applySnapshot(this.host, snap); } catch { snap = null; }
    }
    if (!snap) {
      this.host.adopt(new World());
      this.host.getRenderer().fit();
    }
    const w = this.world;
    w.waveNum = SANDBOX_WAVE;
    w.wave = this.makeWave();
    w.money = MONEY;
    w.reputation = 100;
    w.phase = 'run';
    w.time = 0;
    this.spike = null;
    this.hotUntil = 0;
    w.say('Sandbox: steady traffic, unlimited budget, every tool unlocked. Use the panel to change load and break things.', 'info');
    this.active = true;
    this.badge.classList.remove('hidden');
    this.panel.classList.remove('hidden');
    this.syncPanel();
  }

  exit() {
    this.active = false;
    this.badge.classList.add('hidden');
    this.panel.classList.add('hidden');
  }

  // ------------------------------------------------------------ per-tick

  private makeWave(): WaveDef {
    // duration is effectively infinite so World.step() never calls endWave()
    return { index: SANDBOX_WAVE, peakRps: 0, duration: 1e9, mix: { s: 0.25, r: 0.65, w: 0.1, b: 0 }, chaos: 0, title: 'Sandbox' };
  }

  targetRps() { return this.settings.users / USERS_PER_RPS; }

  private spikeMult(t: number) {
    const sp = this.spike;
    if (!sp || t < sp.start || t >= sp.start + sp.len) return 1;
    return 1 + (sp.mult - 1) * Math.sin(((t - sp.start) / sp.len) * Math.PI);
  }

  /** Call right before every world.step(). */
  beforeStep() {
    if (!this.active) return;
    const w = this.world;
    if (w.phase !== 'run') w.phase = 'run'; // sandbox never sits in build / gameover
    const wave = w.wave;
    wave.duration = 1e9;
    const m = this.settings.mix;
    const sum = m.s + m.r + m.w || 1;
    wave.mix = { s: m.s / sum, r: m.r / sum, w: m.w / sum, b: this.settings.bots / 100 };
    wave.chaos = this.settings.chaos ? 0.04 : 0;
    const t = w.time + TICK; // step() advances time before it reads waveShape
    wave.event = t < this.hotUntil ? { type: 'hotkey', label: 'Hot key' } : undefined;
    if (this.spike && t >= this.spike.start + this.spike.len) { this.spike = null; w.say('Traffic spike is over', 'good'); }
    // waveShape() ramps the first 40% of a wave (and adds a small wobble). Rather than
    // depend on its internals, divide by whatever it returns for an event-free copy of
    // this wave, so peakRps * waveShape(...) == target exactly: steady, flat traffic.
    const shape = waveShape({ ...wave, event: undefined }, t) || 1;
    wave.peakRps = (this.targetRps() * this.spikeMult(t)) / shape;
    wave.users = this.targetRps() * USERS_PER_RPS; // size the dataset for the slider, not the inflated peak (spikes don't grow data)
    w.money = MONEY;
    if (w.reputation < REP_FLOOR) w.reputation = REP_FLOOR;
  }

  /** Call after main.ts refreshes the HUD (10x/s): pin money, relabel HUD, live panel readouts. */
  afterUi() {
    if (!this.active) return;
    const w = this.world;
    w.money = MONEY;
    const set = (sel: string, txt: string) => { const el = document.querySelector(sel); if (el && el.textContent !== txt) el.textContent = txt; };
    set('#s-wave b', '∞');
    set('#s-wave small', 'sandbox · steady traffic');
    set('#s-money b', '∞');
    const btn = document.querySelector<HTMLButtonElement>('#btn-start');
    if (btn) { btn.disabled = true; btn.classList.remove('pulse'); set('#btn-start', 'Sandbox live'); }
    const t = w.time;
    const live = this.panel.querySelector<HTMLElement>('[data-live]');
    if (live) {
      const parts = [`${fmt(this.targetRps() * this.spikeMult(t))} req/s target`];
      if (this.spike) parts.push(`<span class="c-b">spike ${Math.max(0, Math.ceil(this.spike.start + this.spike.len - t))}s</span>`);
      if (t < this.hotUntil) parts.push(`<span class="c-w">hot key ${Math.ceil(this.hotUntil - t)}s</span>`);
      const down = w.nodes.filter((n) => n.downFor > 0).length;
      if (down) parts.push(`<span class="c-b">${down} down</span>`);
      const html = parts.join(' · ');
      if (live.innerHTML !== html) live.innerHTML = html;
    }
  }

  // ------------------------------------------------------------ events

  triggerSpike() {
    const s = this.settings;
    this.spike = { start: this.world.time, len: s.spikeLen, mult: s.spikeMult };
    this.world.say(`Traffic spike: ${s.spikeMult}x for ${s.spikeLen}s`, 'bad');
  }

  crashServer() {
    const servers = this.world.nodes.filter((n) => n.kind === 'server' && n.downFor <= 0);
    if (!servers.length) return this.host.toast('No healthy app server to crash');
    const v = servers[Math.floor(Math.random() * servers.length)];
    v.downFor = 8 + Math.random() * 6;
    this.world.say(`${SPECS.server.label} #${v.id} crashed! (out of memory) Restarting...`, 'bad');
  }

  crashDb() {
    const db = this.world.nodes.find((n) => n.kind === 'database' && n.downFor <= 0);
    if (!db) return this.host.toast('No healthy primary database to crash');
    db.downFor = 12;
    this.world.say(`Primary database #${db.id} disk failure! Writes will fail; reads can keep going from replicas.`, 'bad');
  }

  hotKey() {
    this.hotUntil = this.world.time + 20;
    this.world.say('Hot key: one shard takes ~50% of writes for 20s', 'bad');
  }

  healAll() {
    // 0.01 instead of 0 so World.chaos() brings them back next tick (log line + cache reset)
    for (const n of this.world.nodes) if (n.downFor > 0) n.downFor = 0.01;
    this.spike = null;
    this.hotUntil = 0;
  }

  // ------------------------------------------------------------ panel

  private buildPanel() {
    const p = this.panel;
    p.innerHTML = `
      <header><b>Sandbox</b><button class="sb-toggle" data-act="collapse" title="Collapse">▾</button></header>
      <div class="live" data-live></div>
      <div class="sb-body">
        <div class="sb-row">
          <label>Concurrent users <output data-out="users"></output></label>
          <input type="range" min="0" max="${SLIDER_MAX}" step="1" data-in="users" />
          <div class="sb-scale"><span style="left:0">100</span><span style="left:40%">10k</span><span style="left:80%">1M</span><span style="left:100%">10M</span></div>
        </div>
        <div class="sb-row">
          <label>Traffic mix</label>
          ${(['s', 'r', 'w'] as const).map((k) => `
          <div class="sb-mix"><span class="c-${k}">${{ s: 'static', r: 'read', w: 'write' }[k]}</span>
            <input type="range" min="0" max="100" step="1" data-in="mix-${k}" /><output data-out="mix-${k}"></output></div>`).join('')}
        </div>
        <div class="sb-row">
          <div class="sb-mix"><span class="c-b">bots</span><input type="range" min="0" max="300" step="5" data-in="bots" /><output data-out="bots"></output></div>
          <label class="sb-check"><input type="checkbox" data-in="chaos" /> Random server crashes</label>
        </div>
        <div class="sb-row">
          <label>Events</label>
          <div class="sb-spike">
            <select data-in="spikeMult">${[2, 3, 4, 5].map((m) => `<option value="${m}">${m}x</option>`).join('')}</select>
            <select data-in="spikeLen">${[5, 10, 20, 30].map((s) => `<option value="${s}">${s}s</option>`).join('')}</select>
            <button class="btn" data-act="spike">Traffic spike</button>
          </div>
          <div class="sb-grid">
            <button class="btn" data-act="crash-server">Crash a server</button>
            <button class="btn" data-act="crash-db">Crash primary DB</button>
            <button class="btn" data-act="hotkey">Hot key (20s)</button>
            <button class="btn" data-act="heal">Heal all</button>
          </div>
        </div>
        <div class="sb-row sb-foot"><button class="btn danger" data-act="clear">Clear canvas</button></div>
      </div>`;
    p.addEventListener('input', (e) => this.onInput(e.target as HTMLInputElement));
    p.addEventListener('change', (e) => this.onInput(e.target as HTMLInputElement));
    // keep digits / space typed into the panel's controls away from main.ts's shortcuts
    p.addEventListener('keydown', (e) => { if ((e.target as HTMLElement).matches('input, select')) e.stopPropagation(); });
    p.addEventListener('click', (e) => {
      (e.target as HTMLElement).closest('button')?.blur(); // so Space keeps meaning pause, not "click again"
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'collapse') { this.settings.collapsed = !this.settings.collapsed; this.syncPanel(); this.onChange(); }
      else if (act === 'spike') this.triggerSpike();
      else if (act === 'crash-server') this.crashServer();
      else if (act === 'crash-db') this.crashDb();
      else if (act === 'hotkey') this.hotKey();
      else if (act === 'heal') this.healAll();
      else if (act === 'clear') this.host.modal('<div class="eyebrow">Sandbox</div><h2>Clear the canvas?</h2><p>Removes every component. Your traffic settings stay.</p>',
        [{ label: 'Cancel' }, { label: 'Clear', primary: true, onClick: () => { const s = this.settings; this.enter(null); this.settings = s; this.syncPanel(); this.onChange(); } }]);
    });
  }

  private onInput(el: HTMLInputElement) {
    const key = el.dataset.in;
    if (!key) return;
    const s = this.settings;
    if (key === 'users') s.users = sliderToUsers(Number(el.value));
    else if (key.startsWith('mix-')) s.mix[key.slice(4) as 's' | 'r' | 'w'] = Number(el.value);
    else if (key === 'bots') s.bots = Number(el.value);
    else if (key === 'chaos') s.chaos = el.checked;
    else if (key === 'spikeMult') s.spikeMult = Number(el.value);
    else if (key === 'spikeLen') s.spikeLen = Number(el.value);
    this.syncPanel(key);
    this.onChange();
  }

  /** Push settings into the controls. Skips the control being dragged so it doesn't fight the user. */
  private syncPanel(skip?: string) {
    const p = this.panel, s = this.settings;
    p.classList.toggle('collapsed', s.collapsed);
    const toggle = p.querySelector<HTMLElement>('.sb-toggle');
    if (toggle) { toggle.textContent = s.collapsed ? '▸' : '▾'; toggle.title = s.collapsed ? 'Expand' : 'Collapse'; }
    const input = (k: string) => p.querySelector<HTMLInputElement>(`[data-in="${k}"]`)!;
    const out = (k: string, v: string) => { p.querySelector<HTMLElement>(`[data-out="${k}"]`)!.textContent = v; };
    if (skip !== 'users') input('users').value = String(usersToSlider(s.users));
    out('users', `${fmt(s.users)} · ${fmt(s.users / USERS_PER_RPS)} req/s`);
    const sum = s.mix.s + s.mix.r + s.mix.w || 1;
    for (const k of ['s', 'r', 'w'] as const) {
      if (skip !== `mix-${k}`) input(`mix-${k}`).value = String(s.mix[k]);
      out(`mix-${k}`, `${Math.round((s.mix[k] / sum) * 100)}%`);
    }
    if (skip !== 'bots') input('bots').value = String(s.bots);
    out('bots', `+${s.bots}%`);
    input('chaos').checked = s.chaos;
    input('spikeMult').value = String(s.spikeMult);
    input('spikeLen').value = String(s.spikeLen);
  }
}
