import * as THREE from 'three';

/** BASELINE STUB — owned by the anatomy agent, will be replaced wholesale. */
export class Fox {
  name = 'fox';
  order = 0;

  init(ctx) {
    this.root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf6f8fb, roughness: 0.62 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.28, 16, 32), mat);
    body.rotation.x = Math.PI / 2;
    body.position.set(0, 0.245, -0.02);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 32, 24), mat);
    head.position.set(0, 0.31, 0.235);
    for (const m of [body, head]) { m.castShadow = true; m.receiveShadow = true; this.root.add(m); }
    ctx.scene.add(this.root);
    ctx.fox = this;
    ctx.subjectPosition = new THREE.Vector3(0, 0.26, 0);
  }
}
