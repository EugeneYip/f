import * as THREE from 'three';

/** BASELINE STUB — owned by the terrain agent, will be replaced wholesale. */
export class Terrain {
  name = 'terrain';
  order = -50;

  init(ctx) {
    const r = ctx.quality.get('terrainRadius');
    const s = ctx.quality.get('terrainSegments');
    const geo = new THREE.PlaneGeometry(r * 2, r * 2, s, s).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xeaf1f9, roughness: 0.82, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    ctx.scene.add(this.mesh);
    ctx.terrain = this;
  }

  /** Contract used by IK + particles + footprints: world height at (x,z). */
  heightAt() { return 0; }
  normalAt(x, z, out = new THREE.Vector3()) { return out.set(0, 1, 0); }
}
