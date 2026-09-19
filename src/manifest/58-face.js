// OWNER: face agent.
//
// Eyes, nose/inner-ear/lip detail and whiskers. All three read
// `ctx.fox.anchors` at runtime and parent their geometry to the skeleton, so
// the anatomy agent can move, rescale or remesh the skull underneath them
// without any change here.
//
// They run at order 150 — after the animation agent (100) publishes this
// frame's `fox.blink*` and `fox.gaze*`, and before fur (200).
import { Eyes } from '../fox/Eyes.js';
export const systems = [Eyes];
