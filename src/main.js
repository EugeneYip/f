import { App } from './core/App.js';
import { Debug } from './core/Debug.js';
import { Environment } from './core/Environment.js';
import { Terrain } from './world/Terrain.js';
import { Fox } from './fox/Fox.js';
import { CameraRig } from './camera/CameraRig.js';

window.__FOX_ERRORS = [];
const note = (where, e) => {
  window.__FOX_ERRORS.push(`${where}: ${e?.message ?? e}`);
  console.error(`[${where}]`, e);
};
window.addEventListener('error', (e) => note('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => note('promise', e.reason));

const canvas = document.getElementById('stage');
const app = new App(canvas);

// --- system manifest -----------------------------------------------------
// Order is resolved from each system's `order` field, not this list.
for (const S of [Environment, Terrain, Fox, CameraRig, Debug]) {
  try { app.register(new S()); } catch (e) { note(`register ${S.name}`, e); }
}

await app.init((p, name) => {
  if (import.meta.env?.DEV) console.debug(`[init ${(p * 100) | 0}%] ${name}`);
});

app.start();

if (import.meta.env?.DEV) {
  window.__app = app;
  console.info('[fox] ready —', app.ctx.systemsByName.size, 'systems');
}
