// Thrown grenades: the frag, the smoke and the flash.
//
// A grenade is a small bounded arc, not a physics toy. It leaves the hand with a velocity, falls
// under the same gravity the player feels, bounces off a collider when it lands on one, and then
// settles. What it does when it settles is the whole point of the module:
//
//   frag   - a radial burst, damage falling off with distance, checked against a wall so a grenade
//            behind cover does not reach you;
//   smoke  - a ball of grey that lives for a while and, while it lives, cuts line of sight, so a
//            lane can be taken away from a bot that would otherwise shoot down it;
//   flash   - a burst that blinds whatever was looking at it, bot or player.
//
// The module owns the grenades in flight, the smoke that is still hanging, and the queries the rest
// of the game asks about them (does this segment pass through smoke, is this bot blinded). Nothing
// else keeps grenade state, so a round reset is one call.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const GRAVITY = 20;
const RADIUS = 0.07;
const RESTITUTION = 0.35;
const SETTLE_SPEED = 0.35;

/** Per-kind behaviour: how long it lives after settling, and how far its effect reaches. */
export const KINDS = {
  frag: { fuse: 1.6, radius: 5.2, damage: 118, colour: PALETTE.ink, size: 0.07 },
  smoke: { fuse: 0.9, radius: 4.6, damage: 0, colour: PALETTE.hairline, size: 0.08, life: 14, puff: 3.1 },
  flash: { fuse: 0.85, radius: 6.4, damage: 0, colour: PALETTE.accent, size: 0.06, blind: 2.6 },
};

export function createGrenades(scene, colliders) {
  const live = [];
  const clouds = [];
  const probe = new THREE.Box3();
  const tmp = new THREE.Vector3();

  const bodyGeometry = new THREE.SphereGeometry(1, 12, 10);
  const puffGeometry = new THREE.SphereGeometry(1, 14, 12);

  /** Whether a spot is inside a collider: used to bounce off walls and floors. */
  function solidAt(x, y, z) {
    probe.min.set(x - RADIUS, y - RADIUS, z - RADIUS);
    probe.max.set(x + RADIUS, y + RADIUS, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  /**
   * Does the segment from `a` to `b` pass through a wall? Sampled the same way the bots sample it,
   * so a grenade's damage and a bot's line of sight agree about what cover is.
   */
  function blocked(a, b) {
    const steps = 26;
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      probe.min.set(x - 0.02, y - 0.02, z - 0.02);
      probe.max.set(x + 0.02, y + 0.02, z + 0.02);
      for (const collider of colliders) if (probe.intersectsBox(collider)) return true;
    }
    return false;
  }

  /** Does the segment pass through a smoke cloud that has already bloomed? */
  function smoked(a, b) {
    for (const cloud of clouds) {
      if (cloud.blooming) continue;
      // A cheap reject first: the cloud's bounding sphere against the segment's bounding box.
      if (!segmentNearSphere(a, b, cloud.position, cloud.radius)) continue;
      if (segmentHitsSphere(a, b, cloud.position, cloud.radius)) return true;
    }
    return false;
  }

  function segmentNearSphere(a, b, centre, radius) {
    const minX = Math.min(a.x, b.x) - radius;
    const maxX = Math.max(a.x, b.x) + radius;
    const minY = Math.min(a.y, b.y) - radius;
    const maxY = Math.max(a.y, b.y) + radius;
    const minZ = Math.min(a.z, b.z) - radius;
    const maxZ = Math.max(a.z, b.z) + radius;
    return centre.x >= minX && centre.x <= maxX && centre.y >= minY && centre.y <= maxY && centre.z >= minZ && centre.z <= maxZ;
  }

  /** Distance from the sphere's centre to the segment, compared with its radius. */
  function segmentHitsSphere(a, b, centre, radius) {
    tmp.subVectors(b, a);
    const lengthSq = tmp.lengthSq();
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((centre.x - a.x) * tmp.x + (centre.y - a.y) * tmp.y + (centre.z - a.z) * tmp.z) / lengthSq));
    const x = a.x + tmp.x * t - centre.x;
    const y = a.y + tmp.y * t - centre.y;
    const z = a.z + tmp.z * t - centre.z;
    return x * x + y * y + z * z <= radius * radius;
  }

  /** Throw one grenade: from an eye position, along a direction, at a speed. */
  function throwOne(kind, from, direction, speed = 13) {
    const spec = KINDS[kind] ?? KINDS.frag;
    const mesh = new THREE.Mesh(bodyGeometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(spec.colour), roughness: 0.6, metalness: 0.15 }));
    mesh.scale.setScalar(spec.size);
    mesh.position.copy(from);
    mesh.castShadow = true;
    scene.add(mesh);

    const grenade = {
      kind,
      spec,
      mesh,
      velocity: new THREE.Vector3(direction.x, direction.y, direction.z).normalize().multiplyScalar(speed),
      // The fuse starts once it lands, so a long throw is not punished for the flight.
      fuseLeft: spec.fuse,
      settled: false,
    };
    live.push(grenade);
    return grenade;
  }

  /** One step of flight: gravity, then a bounce or a settle against the world. */
  function fly(grenade, dt) {
    const v = grenade.velocity;
    v.y -= GRAVITY * dt;
    const next = grenade.mesh.position.clone().addScaledVector(v, dt);

    if (solidAt(next.x, next.y, next.z)) {
      // Try each axis alone, so a grenade slides along a wall instead of sticking to it.
      const pos = grenade.mesh.position;
      if (!solidAt(next.x, pos.y, pos.z)) {
        grenade.mesh.position.x = next.x;
        v.z *= RESTITUTION;
        v.x *= RESTITUTION;
      } else if (!solidAt(pos.x, pos.y, next.z)) {
        grenade.mesh.position.z = next.z;
        v.x *= RESTITUTION;
        v.z *= RESTITUTION;
      } else {
        // Neither axis is free: it is on the floor or in a corner, so it lands here.
        v.set(0, 0, 0);
        grenade.settled = true;
        return;
      }
      v.y = Math.abs(v.y) * RESTITUTION;
      if (v.length() < SETTLE_SPEED) {
        v.set(0, 0, 0);
        grenade.settled = true;
      }
      return;
    }

    grenade.mesh.position.copy(next);
    if (grenade.mesh.position.y <= 0) {
      grenade.mesh.position.y = 0;
      v.y = Math.abs(v.y) * RESTITUTION;
      v.x *= 0.7;
      v.z *= 0.7;
      if (v.length() < SETTLE_SPEED) {
        v.set(0, 0, 0);
        grenade.settled = true;
      }
    }
  }

  /**
   * The frag's burst: every living bot inside the radius takes damage that falls off with the
   * distance and is halved behind cover. `onBurst(point, radius, damageFor)` is the caller's
   * chance to hurt the player the same way, since the player's health lives outside this module.
   */
  function burst(grenade, onFrag, onFlash, onSmoke) {
    const at = grenade.mesh.position.clone();
    const spec = grenade.spec;
    if (grenade.kind === 'frag') {
      onFrag(at, spec.radius, (target, cover) => {
        const gap = at.distanceTo(target);
        if (gap > spec.radius) return 0;
        const falloff = 1 - gap / spec.radius;
        return spec.damage * falloff * falloff * (cover ? 0.45 : 1);
      });
    } else if (grenade.kind === 'flash') {
      onFlash(at, spec.radius, spec.blind);
    } else if (grenade.kind === 'smoke') {
      makeCloud(at, spec);
      // The caller gets told, so the smoke can hiss where it landed rather than where it was thrown.
      if (onSmoke) onSmoke(at, spec.radius);
    }
    scene.remove(grenade.mesh);
    grenade.mesh.geometry.dispose?.();
    grenade.mesh.material.dispose?.();
  }

  /** A smoke cloud: a few overlapping puffs that grow in, hold, then fade and go. */
  function makeCloud(at, spec) {
    const group = new THREE.Group();
    group.position.copy(at);
    const puff = spec.puff;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.hairline),
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    // Five puffs, placed so the shape is not a perfect ball: a sphere an opponent can read is a
    // sphere an opponent can shoot around.
    const offsets = [
      [0, 0, 0],
      [puff * 0.55, puff * 0.2, puff * 0.1],
      [-puff * 0.5, puff * 0.35, -puff * 0.2],
      [puff * 0.1, puff * 0.6, -puff * 0.45],
      [-puff * 0.2, puff * 0.15, puff * 0.55],
    ];
    for (const [x, y, z] of offsets) {
      const mesh = new THREE.Mesh(puffGeometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(puff * 0.62);
      group.add(mesh);
    }
    scene.add(group);
    clouds.push({
      position: at.clone(),
      radius: puff * 1.25,
      group,
      material,
      // blooming: not yet thick enough to block sight, so it cannot be a free wall on frame one
      blooming: true,
      age: 0,
      life: spec.life,
    });
  }

  function updateClouds(dt) {
    for (let i = clouds.length - 1; i >= 0; i -= 1) {
      const cloud = clouds[i];
      cloud.age += dt;
      const grow = Math.min(1, cloud.age / 0.5);
      cloud.group.scale.setScalar(0.55 + grow * 0.45);
      cloud.blooming = grow < 1;
      // hold its thickness through the middle of its life, then fade over the last three seconds
      const fading = Math.max(0, (cloud.age - (cloud.life - 3)) / 3);
      cloud.material.opacity = 0.82 * grow * (1 - Math.min(1, fading));
      if (cloud.age >= cloud.life) {
        scene.remove(cloud.group);
        for (const mesh of cloud.group.children) mesh.geometry === puffGeometry || mesh.geometry.dispose?.();
        cloud.material.dispose?.();
        clouds.splice(i, 1);
      }
    }
  }

  /** One simulation step for everything this module owns. */
  function step(dt, onFrag, onFlash, onSmoke) {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const grenade = live[i];
      // In the air it only flies; once it lands the fuse burns, so the throw is not punished.
      if (!grenade.settled) fly(grenade, dt);
      else grenade.fuseLeft -= dt;
      if (grenade.settled && grenade.fuseLeft <= 0) {
        burst(grenade, onFrag, onFlash, onSmoke);
        live.splice(i, 1);
      }
    }
    updateClouds(dt);
  }

  return {
    step,
    throwOne,
    smoked,
    blocked,
    /** The grenades still in the air, for anything that wants to draw or count them. */
    liveCount() {
      return live.length;
    },
    smokeClouds() {
      return clouds;
    },
    /** A round reset: nothing thrown before it should survive into the next one. */
    reset() {
      for (const grenade of live) {
        scene.remove(grenade.mesh);
        grenade.mesh.material.dispose?.();
      }
      live.length = 0;
      for (const cloud of clouds) {
        scene.remove(cloud.group);
        cloud.material.dispose?.();
      }
      clouds.length = 0;
    },
  };
}
