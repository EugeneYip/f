// OWNER: shadow agent.
//
// The animal's cast shadow. `foxBody` is the scene's only caster, and it is
// the bare SKIN -- 0.171 m across against a coat that is up to 52.9 mm deep on
// top of it -- so the shadow was a stick figure of a fluffy animal. CoatShadow
// gives that one mesh a customDepthMaterial that extrudes it by the fur
// system's own per-vertex coat depth field, leaving the beauty pass untouched.
//
// Runs at order 260: after the fox (0) publishes its skinned mesh and after
// fur (200) publishes the coat depth uniforms it reads by reference.
import { CoatShadow } from '../light/CoatShadow.js';
export const systems = [CoatShadow];
