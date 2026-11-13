/**
 * Glue for save/resume + sandbox: start screen, HUD "Menu" button, autosave.
 * main.ts calls installSaveAndSandbox(host) once and the two returned hooks from its loop.
 *
 * Autosave (campaign): at each wave end, ~0.8s after the player changes the build
 * during the build phase, and on page unload. Mid-wave state is never stored as
 * mid-wave: a snapshot always restores into the build phase of the current wave.
 * A game over clears the campaign slot (best wave is kept separately).
 * Sandbox has its own slot and saves on change (throttled) and every 20s.
 */
import './save-sandbox.css';
import type { Phase } from './types';
import type { World } from './sim';
import { Sandbox } from './sandbox';
import {
  applySnapshot, clearSlot, downloadJson, isSnapshot, pickJsonFile, readSlot, recordBest, snapshot, structureSig, writeSlot,
  type Host, type Mode, type Snapshot,
} from './persist';

const BUILD_DEBOUNCE_MS = 800;
const SANDBOX_THROTTLE_MS = 1500;
const SANDBOX_PERIODIC_MS = 20_000;

export function installSaveAndSandbox(host: Host) {
  let mode: Mode = 'campaign';
  /** false until the player picks an option on the start screen, so we never clobber a save with the default world */
  let ready = false;
  let tracked: World | null = null;
  let lastPhase: Phase = 'build';
  let lastSig = '';
  let dirtyAt = 0;
  let lastSave = 0;
  let gameoverHandled = false;

  const sandbox = new Sandbox(host, () => { dirtyAt = dirtyAt || performance.now(); });

  const money = (n: number) => '$' + Math.floor(n).toLocaleString();
  const ago = (t: number) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };

  function save(): boolean {
    if (!ready) return false;
    const w = host.getWorld();
    if (mode === 'campaign' && w.phase === 'gameover') return false;
    const ok = writeSlot(snapshot(host, mode, mode === 'sandbox' ? { ...sandbox.settings } : undefined));
    if (mode === 'campaign') recordBest(w.bestWave);
    lastSave = performance.now();
    dirtyAt = 0;
    return ok;
  }

  /** Re-baseline change tracking after the world was swapped. */
  function track() {
    tracked = host.getWorld();
    lastPhase = tracked.phase;
    lastSig = structureSig(tracked);
    dirtyAt = 0;
    gameoverHandled = false;
  }

  function switchTo(next: Mode, snap: Snapshot | null) {
    if (ready) save();
    if (next === 'sandbox') {
      mode = 'sandbox';
      sandbox.enter(snap);
    } else {
      sandbox.exit();
      mode = 'campaign';
      let loaded = false;
      if (snap) { try { applySnapshot(host, snap); loaded = true; } catch { host.toast('That save could not be loaded. Starting fresh.'); } }
      if (!loaded) host.reset();
    }
    ready = true;
    track();
    save();
    refreshMenu();
  }

  // ------------------------------------------------------------ start screen

  function campaignLabel(s: Snapshot) {
    return `Continue (Wave ${s.world.waveNum}, ${money(Number(s.world.money) || 0)})`;
  }

  function startScreen() {
    const camp = readSlot('campaign');
    const sb = readSlot('sandbox');
    if (!camp && !sb) { ready = true; track(); return; }
    const best = Number(localStorage.getItem('best') ?? 0) || 0;
    host.modal(`<div class="eyebrow">ScaleUp</div><h2>Welcome back</h2>
      ${camp ? `<p>Your run is saved at <b>wave ${camp.world.waveNum}</b> with <b>${money(Number(camp.world.money) || 0)}</b> and ${camp.nodes.length - 1} component${camp.nodes.length === 2 ? '' : 's'} (saved ${ago(camp.savedAt)}).</p>` : '<p>No campaign in progress.</p>'}
      ${best ? `<p style="color:var(--muted)">Best: wave ${best}.</p>` : ''}
      <p style="color:var(--muted)"><b>Sandbox</b> is free play: unlimited budget, every tool, traffic and failures on demand.${sb ? ' Your sandbox build is saved too.' : ''}</p>`,
      [
        { label: sb ? 'Sandbox (resume)' : 'Sandbox', onClick: () => switchTo('sandbox', sb) },
        { label: 'New game', primary: !camp, onClick: () => (camp ? confirmNew(startScreen) : switchTo('campaign', null)) },
        ...(camp ? [{ label: campaignLabel(camp), primary: true, onClick: () => switchTo('campaign', camp) }] : []),
      ]);
  }

  function confirmNew(back?: () => void) {
    const camp = readSlot('campaign');
    host.modal(`<div class="eyebrow">New game</div><h2>Start over?</h2>
      <p>${camp ? `Your saved run (wave ${camp.world.waveNum}) will be overwritten.` : 'You start again from wave 1.'} Your sandbox save is not affected.</p>`,
      [{ label: 'Cancel', onClick: back }, { label: 'Start over', primary: true, onClick: () => { clearSlot('campaign'); switchTo('campaign', null); } }]);
  }

  // ------------------------------------------------------------ HUD menu

  const btn = document.createElement('button');
  btn.id = 'btn-menu';
  btn.className = 'ghost';
  btn.textContent = 'Menu';
  btn.title = 'Save, load, sandbox';
  const help = document.querySelector('#btn-help');
  if (help) help.before(btn); else document.querySelector('#hud .controls')?.appendChild(btn);
  const pop = document.createElement('div');
  pop.id = 'menu-pop';
  pop.className = 'hidden';
  document.body.appendChild(pop);

  function refreshMenu() {
    pop.innerHTML = `
      <div class="mp-head">${mode === 'sandbox' ? 'Sandbox' : `Campaign · wave ${host.getWorld().waveNum}`}</div>
      <button data-m="save">Save now</button>
      <button data-m="export">Export save (.json)</button>
      <button data-m="import">Import save…</button>
      <hr/>
      <button data-m="new">New game</button>
      ${mode === 'sandbox' ? '<button data-m="campaign">Back to campaign</button>' : '<button data-m="sandbox">Sandbox</button>'}`;
  }

  function openMenu(open: boolean) {
    if (open) {
      refreshMenu();
      const r = btn.getBoundingClientRect();
      pop.style.top = `${r.bottom + 8}px`;
      pop.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
    }
    pop.classList.toggle('hidden', !open);
  }
  btn.onclick = (e) => { e.stopPropagation(); openMenu(pop.classList.contains('hidden')); };
  document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target as Node) && e.target !== btn) openMenu(false); });

  pop.addEventListener('click', async (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m;
    if (!m) return;
    openMenu(false);
    const w = host.getWorld();
    if (m === 'save') {
      if (!ready) ready = true;
      if (mode === 'campaign' && w.phase === 'gameover') return host.toast('Game over: nothing to save');
      host.toast(save() ? (mode === 'campaign' && w.phase === 'run' ? 'Saved. Mid-wave saves resume at this wave\'s build phase.' : 'Saved') : 'Could not save (storage full or blocked)', 'info');
    } else if (m === 'export') {
      const s = snapshot(host, mode, mode === 'sandbox' ? { ...sandbox.settings } : undefined);
      downloadJson(mode === 'sandbox' ? 'scaleup-sandbox.json' : `scaleup-wave${w.waveNum}.json`, s);
    } else if (m === 'import') {
      let data: unknown;
      try { data = await pickJsonFile(); } catch { return host.toast('Could not read that file'); }
      if (!isSnapshot(data)) return host.toast('Not a ScaleUp save (or from an incompatible version)');
      const s = data;
      host.modal(`<div class="eyebrow">Import save</div><h2>Load this ${s.mode === 'sandbox' ? 'sandbox' : `run (wave ${s.world.waveNum})`}?</h2>
        <p>It replaces your current ${s.mode} save.</p>`,
        [{ label: 'Cancel' }, { label: 'Load', primary: true, onClick: () => { writeSlot(s); switchTo(s.mode, s); host.toast('Save imported', 'info'); } }]);
    } else if (m === 'new') confirmNew();
    else if (m === 'sandbox') switchTo('sandbox', readSlot('sandbox'));
    else if (m === 'campaign') switchTo('campaign', readSlot('campaign'));
  });

  // ------------------------------------------------------------ autosave

  window.addEventListener('pagehide', () => save());
  window.addEventListener('beforeunload', () => save());

  /** Run ~10x/s after the HUD refresh. */
  function tick() {
    sandbox.afterUi();
    if (!ready) return;
    const w = host.getWorld();
    if (w !== tracked) track(); // world swapped by main.ts (e.g. "Try again" after game over)
    const now = performance.now();
    if (mode === 'campaign') {
      if (w.phase === 'gameover') {
        if (!gameoverHandled) { gameoverHandled = true; recordBest(w.bestWave); clearSlot('campaign'); }
        lastPhase = w.phase;
        return;
      }
      const waveEnded = lastPhase === 'run' && w.phase === 'build';
      lastPhase = w.phase;
      if (w.phase !== 'build') return;
      const sig = structureSig(w);
      if (sig !== lastSig) { lastSig = sig; dirtyAt = now; }
      if (waveEnded || (dirtyAt && now - dirtyAt > BUILD_DEBOUNCE_MS)) save();
    } else {
      const sig = structureSig(w);
      if (sig !== lastSig) { lastSig = sig; dirtyAt = dirtyAt || now; }
      if ((dirtyAt && now - lastSave > SANDBOX_THROTTLE_MS) || now - lastSave > SANDBOX_PERIODIC_MS) save();
    }
  }

  startScreen();

  return {
    /** call before every world.step() */
    beforeStep: () => sandbox.beforeStep(),
    /** call after the HUD/panel refresh */
    afterUi: tick,
  };
}
