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

await app.init((p, name) => {
  window.__FOX_PROGRESS = { p, name };
  if (import.meta.env?.DEV) console.debug(`[init ${(p * 100) | 0}%] ${name}`);
});

app.start();
console.info('[fox] ready —', app.ctx.systemsByName.size, 'systems:',
  [...app.ctx.systemsByName.keys()].join(', '));
