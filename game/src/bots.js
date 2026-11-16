// The opposing team: bots that walk fixed routes through the map, watch where they are going,
// and shoot when they see the player. Each bot is a body with a head and a torso, so a shot that
// lands on the head does far more damage than one on the torso, and each carries a small state
// machine (route, engage, dead) so behaviour is readable in one place.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const BOT_HEALTH = 100;
const BOT_RADIUS = 0.36;
const BOT_HEIGHT = 1.8;
const HEAD_HEIGHT = 1.62;
const TORSO_HEIGHT = 1.1;
const WALK_SPEED = 2.6;
const ENGAGE_SPEED = 1.5;
const SIGHT_RANGE = 34;
const FIRE_INTERVAL = 0.42;
const BOT_DAMAGE = 11;
const BOT_ACCURACY = 0.55;
const RESPAWN_SECONDS = 3;

/** The routes each bot walks, as waypoints in the map's own coordinates. */
const ROUTES = [
  [
    [-6, -11], [-10, -6], [-10, 2], [-6, 8], [-10, 12],
  ],
  [
    [7, -11], [11, -6], [11, 2], [7, 7], [3, 11],
  ],
  [
    [0, -12], [-1.6, -5], [-6, 0], [-1.6, 5], [1.6, 11],
  ],
];

export function createBots(scene, colliders) {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.62, metalness: 0.06 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.45, metalness: 0.12 });
  const legMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.86 });

  const torsoGeometry = new THREE.BoxGeometry(0.56, 0.82, 0.32);
  const headGeometry = new THREE.SphereGeometry(0.16, 16, 12);
  const legGeometry = new THREE.BoxGeometry(0.46, 0.72, 0.3);

  const bots = [];
  const hitMeshes = [];
  const probe = new THREE.Box3();

  /** Whether a bot at this spot would be inside a wall. */
  function blocked(x, z) {
    probe.min.set(x - BOT_RADIUS, 0.1, z - BOT_RADIUS);
    probe.max.set(x + BOT_RADIUS, BOT_HEIGHT, z + BOT_RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return true;
    return false;
  }

  /** Line of sight: sample the segment, and stop at the first solid box it passes through. */
  function sees(from, to) {
    const steps = 24;
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const z = from.z + (to.z - from.z) * t;
      probe.min.set(x - 0.02, y - 0.02, z - 0.02);
      probe.max.set(x + 0.02, y + 0.02, z + 0.02);
      for (const collider of colliders) if (probe.intersectsBox(collider)) return false;
    }
    return true;
  }

  for (let index = 0; index < ROUTES.length; index += 1) {
    const route = ROUTES[index];
    const group = new THREE.Group();
    const legs = new THREE.Mesh(legGeometry, legMaterial);
    legs.position.y = 0.36;
    const torso = new THREE.Mesh(torsoGeometry, bodyMaterial);
    torso.position.y = TORSO_HEIGHT;
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = HEAD_HEIGHT;
    group.add(legs, torso, head);
    group.traverse((mesh) => {
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    scene.add(group);

    const bot = {
      index,
      group,
      torso,
      head,
      legs,
      route,
      waypoint: 1,
      health: BOT_HEALTH,
      alive: true,
      respawnAt: 0,
      fireAt: 0,
      position: new THREE.Vector3(route[0][0], 0, route[0][1]),
      seenPlayer: false,
    };
    torso.userData.bot = bot;
    head.userData.bot = bot;
    torso.userData.part = 'torso';
    head.userData.part = 'head';
    hitMeshes.push(torso, head);
    group.position.copy(bot.position);
    bots.push(bot);
  }

  /** Put a bot back at the head of its route. */
  function respawn(bot) {
    bot.health = BOT_HEALTH;
    bot.alive = true;
    bot.seenPlayer = false;
    bot.fireAt = 0;
    bot.waypoint = 1;
    bot.position.set(bot.route[0][0], 0, bot.route[0][1]);
    bot.group.position.copy(bot.position);
    bot.group.visible = true;
    bot.group.rotation.set(0, 0, 0);
    bot.torso.scale.setScalar(1);
    bot.head.scale.setScalar(1);
  }

  /** Apply damage to a bot, answering whether that hit killed it. */
  function damage(bot, amount) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.respawnAt = 0;
      bot.group.rotation.z = Math.PI * 0.5;
      bot.torso.scale.setScalar(0.96);
      return true;
    }
    return false;
  }

  /**
   * One simulation step: walk the route, turn to face the player when it is in sight, and fire on
   * an interval. `onHit(amount)` is called when a bot's shot lands.
   */
  function step(dt, now, playerEye, onHit) {
    for (const bot of bots) {
      if (!bot.alive) {
        if (now >= bot.respawnAt) bot.respawnAt += 0;
        continue;
      }
      const target = bot.route[bot.waypoint % bot.route.length];
      const dx = target[0] - bot.position.x;
      const dz = target[1] - bot.position.z;
      const distance = Math.hypot(dx, dz);

      // Face the player when it is in sight, otherwise face the way it is walking.
      const canSee = now >= 0 && sees(
        { x: bot.position.x, y: HEAD_HEIGHT, z: bot.position.z },
        playerEye,
      ) && Math.hypot(playerEye.x - bot.position.x, playerEye.z - bot.position.z) < SIGHT_RANGE;
      bot.seenPlayer = canSee;

      let heading;
      if (canSee) {
        heading = Math.atan2(playerEye.x - bot.position.x, playerEye.z - bot.position.z);
      } else {
        heading = Math.atan2(dx, dz);
      }
      bot.group.rotation.y += (heading - bot.group.rotation.y) * Math.min(1, dt * 6);

      const speed = canSee ? ENGAGE_SPEED : WALK_SPEED;
      if (distance < 0.6 && !canSee) {
        bot.waypoint = (bot.waypoint + 1) % bot.route.length;
      } else if (!canSee && distance > 0.001) {
        const stepX = (dx / distance) * speed * dt;
        const stepZ = (dz / distance) * speed * dt;
        if (!blocked(bot.position.x + stepX, bot.position.z)) bot.position.x += stepX;
        if (!blocked(bot.position.x, bot.position.z + stepZ)) bot.position.z += stepZ;
      }
      bot.group.position.set(bot.position.x, 0, bot.position.z);
      bot.legs.position.y = 0.36 + Math.sin(now * 6 + bot.index) * 0.02;

      // Fire when the player is in sight and the interval has passed.
      if (canSee && now >= bot.fireAt) {
        bot.fireAt = now + FIRE_INTERVAL;
        if (Math.random() < BOT_ACCURACY) onHit(BOT_DAMAGE);
      }
    }
  }

  return {
    items: bots,
    hitMeshes,
    damage,
    step,
    respawn,
    aliveCount() {
      let count = 0;
      for (const bot of bots) if (bot.alive) count += 1;
      return count;
    },
    reset() {
      for (const bot of bots) respawn(bot);
    },
  };
}
