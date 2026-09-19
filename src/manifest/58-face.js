// OWNER: face agent.
//
// Eyes, nose/inner-ear/lip detail and whiskers. All three read
// `ctx.fox.anchors` at runtime and fit themselves to `ctx.fox.field` (the
// anatomy agent's SDF), so the skull can move, rescale or be remeshed
// underneath them without any change here.
//
// They run at order 150+ — after the animation agent (100) publishes this
// frame's `fox.blink*` and `fox.gaze*`, and before fur (200).
import { Eyes } from '../fox/Eyes.js';
import { FaceDetail } from '../fox/FaceDetail.js';
import { Whiskers } from '../fox/Whiskers.js';
export const systems = [Eyes, FaceDetail, Whiskers];
