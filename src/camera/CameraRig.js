import * as THREE from 'three';

/** BASELINE STUB — owned by the camera agent, will be replaced wholesale. */
export class CameraRig {
  name = 'cameraRig';
  order = 900;

  init(ctx) {
    this.ctx = ctx;
    this.target = new THREE.Vector3(0, 0.26, 0);
    ctx.cameraRig = this;
    this.applyPose({ pos: [1.42, 0.30, 1.72], target: [0.02, 0.26, 0.04], fov: 40 }, ctx);
  }

  applyPose(pose, ctx) {
    ctx.camera.position.fromArray(pose.pos);
    this.target.fromArray(pose.target);
    ctx.camera.lookAt(this.target);
    if (pose.fov) { ctx.camera.fov = pose.fov; ctx.camera.updateProjectionMatrix(); }
  }
}
