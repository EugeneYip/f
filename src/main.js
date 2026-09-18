import { App } from './core/App.js';

window.__FOX_ERRORS = [];
const note = (where, e) => {
  window.__FOX_ERRORS.push(`${where}: ${e?.message ?? e}`);
  console.error(`[${where}]`, e);
};
window.addEventListener('error', (e) => note('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => note('promise', e.reason));

const canvas = document.getElementById('stage');
const app = new App(canvas);
window.__app = app;

/**
 * Systems are discovered from src/manifest/*.js, loaded in filename order.
 * Each manifest module exports `systems`: an array of classes or instances.
 * One file per feature area means parallel contributors never collide.
 */
const mods = import.meta.glob('./manifest/*.js', { eager: true });
for (const key of Object.keys(mods).sort()) {
  const list = mods[key].systems ?? [];
  for (const S of list) {
    try {
      app.register(typeof S === 'function' ? new S() : S);
    } catch (e) {
      note(`register ${key}:${S?.name ?? '?'}`, e);
    }
  }
}

window.__FOX_READY = false;

let initErrors = [];
try {
  initErrors = await app.init((p, name) => {
    window.__FOX_PROGRESS = { p, name };
    if (import.meta.env?.DEV) console.debug(`[init ${(p * 100) | 0}%] ${name}`);
  });
} catch (e) {
  note('app.init', e);
}

app.start();

// Raise the flag last, and raise it even on partial failure: the review harness
// and the loading screen both wait on it, and a hard hang is worse than a
// screenshot of a broken scene plus a loud error list.
window.__FOX_READY = true;
window.__FOX_PROGRESS = { p: 1, name: 'ready' };

console.info('[fox] ready —', app.ctx.systemsByName.size, 'systems:',
  [...app.ctx.systemsByName.keys()].join(', '));
if (initErrors.length) {
  console.error(`[fox] ${initErrors.length} system(s) failed to init:`,
    initErrors.map((e) => e.system).join(', '));
}
