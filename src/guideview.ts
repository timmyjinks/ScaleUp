/**
 * Component guide UI:
 *  - a flyout card next to the palette when hovering a tool (locked tools included)
 *  - a "How it works" modal / field guide listing every component with its mini diagram
 *  - mini diagrams embedded in lesson modals
 *  - a placement hint ("Users → CDN → Load Balancer") while placing a tool
 *
 * main.ts only needs a handful of hooks (see the exports below).
 */
import './guide.css';
import { SPECS, UNLOCKS } from './config';
import { GUIDE, GUIDE_ORDER, type GuideEntry, type GuideKey, type WireStep } from './guide';
import { MiniDiagram } from './minidiagram';
import { drawIcon } from './render';
import { getScene } from './scenes';
import type { NodeKind } from './types';

interface GuideHost {
  /** is this feature (UNLOCKS key) available yet? */
  unlocked: (feature: string) => boolean;
  /** called when the guide modal opens / closes (e.g. to pause the sim) */
  onModal?: (open: boolean) => void;
}

let host: GuideHost = { unlocked: () => true };

// ------------------------------------------------------------------ small helpers

function icon(kind: NodeKind, size: number) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const ctx = c.getContext('2d')!;
  ctx.scale((dpr * size) / 34, (dpr * size) / 34);
  drawIcon(ctx, kind, 17, 17);
  return c;
}

function fillIcons(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-gicon]').forEach((el) => {
    if (el.firstChild) return;
    el.appendChild(icon(el.dataset.gicon as NodeKind, Number(el.dataset.size ?? 18)));
  });
}

const colorOf = (e: GuideEntry) => (e.key === 'sharding' ? SPECS.database.color : SPECS[e.icon].color);
const iconTile = (e: GuideEntry, size: number, tile: number) =>
  `<span class="g-ico" style="background:${colorOf(e)};width:${tile}px;height:${tile}px" data-gicon="${e.icon}" data-size="${size}"></span>`;

function status(e: GuideEntry) {
  const w = UNLOCKS[e.unlock] ?? 1;
  return host.unlocked(e.unlock) ? { locked: false, text: e.key === 'users' ? 'Always on the board' : 'Available' } : { locked: true, text: `🔒 Unlocks at wave ${w}` };
}

function stepHtml(s: WireStep) {
  if (typeof s === 'object') return `<span class="g-step">${s.text}</span>`;
  const e = GUIDE[s];
  const label = s === 'sharding' ? 'Databases' : SPECS[s].label;
  return `<span class="g-step"><span class="g-ico" style="background:${colorOf(e)}" data-gicon="${e.icon}" data-size="12"></span>${label}</span>`;
}

function wireHtml(e: GuideEntry) {
  return e.wire.map((w) => `<div class="g-wire">${w.path.map(stepHtml).join('<span class="g-arr">→</span>')}${w.note ? `<small>${w.note}</small>` : ''}</div>`).join('');
}

function bodyHtml(e: GuideEntry, full: boolean) {
  return `
    <div class="g-sec"><h4>Why use it</h4><p>${e.why}</p></div>
    <div class="g-sec"><h4>How to wire it</h4>${wireHtml(e)}</div>
    <div class="g-sec"><h4>Common mistakes</h4><ul>${e.mistakes.map((m) => `<li>${m}</li>`).join('')}</ul></div>
    <div class="g-sec"><h4>In the real world</h4><p>${e.examples}</p></div>
    ${full ? `<div class="g-sec g-interview"><h4>Interview angle</h4><p>${e.interview}</p></div>` : ''}
    ${full && e.related?.length ? `<div class="g-sec"><h4>Related</h4><div class="g-related">${e.related.map((k) => `<button class="g-chip" data-guide="${k}">${iconTile(GUIDE[k], 12, 18)}${GUIDE[k].title}</button>`).join('')}</div></div>` : ''}`;
}

// ------------------------------------------------------------------ flyout next to the palette

let fly: HTMLElement;
let flyMini: MiniDiagram | null = null;
let flyKey: GuideKey | null = null;
let showTimer = 0, hideTimer = 0;

function renderFly(key: GuideKey) {
  const e = GUIDE[key];
  const st = status(e);
  flyKey = key;
  fly.classList.toggle('locked', st.locked);
  fly.innerHTML = `
    <div class="g-head">${iconTile(e, 20, 30)}<div><b>${e.title}</b><small class="${st.locked ? 'lock' : ''}">${st.text}</small></div></div>
    <p class="g-what">${e.what}</p>
    <div class="g-dia"></div>
    ${bodyHtml(e, false)}
    <button class="g-more" data-guide="${key}">Full guide & interview notes ⤢</button>`;
  fillIcons(fly);
  const scene = getScene(e.scene);
  if (!flyMini) flyMini = new MiniDiagram(scene);
  else flyMini.setScene(scene);
  fly.querySelector('.g-dia')!.appendChild(flyMini.el);
}

function placeFly(anchor: HTMLElement) {
  const pal = document.getElementById('palette')!.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  fly.style.left = `${pal.right + 8}px`;
  const h = fly.offsetHeight;
  const top = Math.max(80, Math.min(a.top - 60, window.innerHeight - h - 12));
  fly.style.top = `${top}px`;
}

function showFly(key: GuideKey, anchor: HTMLElement) {
  clearTimeout(hideTimer);
  if (flyKey !== key || fly.classList.contains('hidden')) renderFly(key);
  fly.classList.remove('hidden');
  placeFly(anchor);
}

function hideFly() {
  clearTimeout(showTimer);
  fly.classList.add('hidden');
  flyKey = null;
}

function wirePalette() {
  const pal = document.getElementById('palette')!;
  pal.addEventListener('pointerover', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('.tool[data-kind]');
    if (!b) return;
    const key = b.dataset.kind as GuideKey;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    if (!fly.classList.contains('hidden')) showFly(key, b);
    else showTimer = window.setTimeout(() => showFly(key, b), 220);
  });
  // clicking a tool keeps the card open while the pointer stays on the palette
  pal.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('.tool[data-kind]');
    if (b) showFly(b.dataset.kind as GuideKey, b);
  });
  const leave = () => { clearTimeout(showTimer); clearTimeout(hideTimer); hideTimer = window.setTimeout(hideFly, 260); };
  pal.addEventListener('pointerleave', leave);
  fly.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  fly.addEventListener('pointerleave', leave);
  document.getElementById('board')?.addEventListener('pointerdown', hideFly);
}

// ------------------------------------------------------------------ modal / field guide

let modal: HTMLElement;
let modalMini: MiniDiagram | null = null;
let modalKey: GuideKey = 'server';

function renderModal() {
  const e = GUIDE[modalKey];
  const st = status(e);
  const nav = GUIDE_ORDER.map((k) => {
    const g = GUIDE[k];
    const locked = status(g).locked;
    return `<button class="g-nav ${k === modalKey ? 'on' : ''} ${locked ? 'locked' : ''}" data-guide="${k}">${iconTile(g, 14, 22)}<span>${g.title}</span>${locked ? `<small>w${UNLOCKS[g.unlock]}</small>` : ''}</button>`;
  }).join('');
  modal.querySelector('.g-card')!.innerHTML = `
    <nav><div class="g-eyebrow">Field guide</div>${nav}</nav>
    <article>
      <div class="g-head">${iconTile(e, 22, 36)}<div><b>${e.title}</b><small class="${st.locked ? 'lock' : ''}">${st.text}</small></div>
        <button class="g-close" title="Close (Esc)">✕</button></div>
      <p class="g-what">${e.what}</p>
      <div class="g-dia"></div>
      <div class="g-cols">${bodyHtml(e, true)}</div>
    </article>`;
  fillIcons(modal);
  const scene = getScene(e.scene);
  if (!modalMini) modalMini = new MiniDiagram(scene);
  else modalMini.setScene(scene);
  modal.querySelector('.g-dia')!.appendChild(modalMini.el);
  modal.querySelector('article')!.scrollTop = 0;
}

/** Open the guide modal on a component (or the field guide on its first entry). */
export function openGuide(key: GuideKey = 'server') {
  hideFly();
  modalKey = key;
  const wasOpen = !modal.classList.contains('hidden');
  renderModal();
  modal.classList.remove('hidden');
  if (!wasOpen) host.onModal?.(true);
}

function closeGuide() {
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  host.onModal?.(false);
}

// ------------------------------------------------------------------ placement hint

let hint: HTMLElement;
let hintKind: NodeKind | null = null;

/** Call every UI tick with the kind currently being placed (or null). */
export function setPlacingHint(kind: NodeKind | null) {
  if (kind === hintKind) return;
  hintKind = kind;
  if (!kind) { hint.classList.add('hidden'); return; }
  const e = GUIDE[kind];
  hint.innerHTML = `<span class="g-hint-l">Place it like this</span>${wireHtml({ ...e, wire: e.wire.slice(0, 1) })}<span class="g-hint-k"><kbd>Esc</kbd> cancel</span>`;
  fillIcons(hint);
  hint.classList.remove('hidden');
}

// ------------------------------------------------------------------ lesson modals + inspector

/** HTML for the inspector: a button that opens the guide for this node kind. */
export function guideButtonHtml(kind: NodeKind) {
  return `<button class="btn g-btn" data-guide="${kind}">▶ How it works</button>`;
}

/** Field guide entry point for the lesson index modal. */
export function fieldGuideButtonHtml() {
  return `<button class="btn g-btn g-index" data-guide="server">📖 Component field guide: every tool, animated</button>`;
}

/** Placeholder for the mini diagram(s) of the tools a lesson unlocks. Mounted by mountMiniDiagrams. */
export function lessonDiagramsHtml(tools: string[]) {
  const keys: GuideKey[] = [];
  const scenes = new Set<string>();
  for (const t of tools) {
    const g = GUIDE[t as GuideKey];
    if (!g || scenes.has(g.scene)) continue;
    scenes.add(g.scene);
    keys.push(g.key);
  }
  return keys.length ? `<div class="g-lesson" data-mini-keys="${keys.join(',')}"></div>` : '';
}

/** Turn any lesson placeholders inside `root` into live mini diagrams. */
export function mountMiniDiagrams(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-mini-keys]:not([data-mounted])').forEach((el) => {
    el.dataset.mounted = '1';
    const keys = el.dataset.miniKeys!.split(',') as GuideKey[];
    const mini = new MiniDiagram(getScene(GUIDE[keys[0]].scene));
    const tabs = keys.length > 1
      ? `<div class="g-tabs"><span class="g-tabs-l">Watch it work:</span>${keys.map((k, i) => `<button class="g-chip ${i ? '' : 'on'}" data-tab="${k}">${iconTile(GUIDE[k], 12, 18)}${GUIDE[k].title}</button>`).join('')}</div>` : '';
    el.innerHTML = `${tabs || '<div class="g-tabs"><span class="g-tabs-l">Watch it work</span></div>'}<div class="g-dia"></div><button class="g-more" data-guide="${keys[0]}">How ${GUIDE[keys[0]].title} works, in detail ⤢</button>`;
    el.querySelector('.g-dia')!.appendChild(mini.el);
    fillIcons(el);
    el.addEventListener('click', (ev) => {
      const k = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as GuideKey | undefined;
      if (!k) return;
      mini.setScene(getScene(GUIDE[k].scene));
      el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === k));
      const more = el.querySelector<HTMLElement>('.g-more')!;
      more.dataset.guide = k;
      more.textContent = `How ${GUIDE[k].title} works, in detail ⤢`;
    });
  });
}

// ------------------------------------------------------------------ init

export function initGuide(h: GuideHost) {
  host = h;
  fly = document.createElement('div');
  fly.id = 'guide-fly';
  fly.className = 'hidden';
  document.body.appendChild(fly);

  modal = document.createElement('div');
  modal.id = 'guide-modal';
  modal.className = 'hidden';
  modal.innerHTML = '<div class="g-card"></div>';
  document.body.appendChild(modal);
  modal.addEventListener('pointerdown', (ev) => { if (ev.target === modal) closeGuide(); });
  modal.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('.g-close')) closeGuide(); });

  hint = document.createElement('div');
  hint.id = 'guide-hint';
  hint.className = 'hidden';
  document.body.appendChild(hint);

  wirePalette();

  // any [data-guide] element anywhere opens that entry
  document.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-guide]');
    if (el) { ev.preventDefault(); openGuide(el.dataset.guide as GuideKey); }
  });

  // while the guide modal is open it owns the keyboard (so Delete doesn't sell a node, etc.)
  window.addEventListener('keydown', (ev) => {
    if (modal.classList.contains('hidden')) { if (ev.key === 'Escape') hideFly(); return; }
    ev.stopImmediatePropagation();
    if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); closeGuide(); }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const i = GUIDE_ORDER.indexOf(modalKey) + (ev.key === 'ArrowDown' ? 1 : -1);
      openGuide(GUIDE_ORDER[(i + GUIDE_ORDER.length) % GUIDE_ORDER.length]);
    }
  }, true);
}
