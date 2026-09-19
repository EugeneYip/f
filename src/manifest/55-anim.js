// OWNER: animation agent.
// Gait engine, two-bone IK with terrain adaptation, secondary dynamics,
// idle life, look-at and the behaviour state machine. One system: the whole
// pipeline has to run in a fixed order within a single fixed(h) step, and
// registering the stages separately would hand that ordering to the app.
import { FoxBrain } from '../anim/FoxBrain.js';
export const systems = [FoxBrain];
