// The opposing team: bots that walk routes through the map, watch where they are going, and fight
// when they see the player.
//
// A bot is not a turret. Each one carries a small behaviour of its own, chosen from what it can
// see and hear, so a lane can be held, given up, retaken or flanked:
//
//   patrol  - walk the route, watching ahead;
//   hold    - stop at a post and cover it, turning slowly, so a route is not free to walk;
//   engage  - face the player, strafe a little so it is not a still target, and fire in bursts;
//   reload  - break off to the nearest cover and stop firing while the magazine is out;
//   retreat - a bot that has taken a bad hit backs off along its route before re-engaging;
//   hunt    - walk toward a noise with nobody in sight, then give up.
//
// Every body is a head on a torso, so a shot to the head is worth far more than one to the chest,
// and each bot's state machine is readable in one place: step() below.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const BOT_HEALTH = 100;
const BOT_RADIUS = 0.36;
const BOT_HEIGHT = 1.8;
const HEAD_HEIGHT = 1.62;
const TORSO_HEIGHT = 1.1;
const WALK_SPEED = 2.6;
const ENGAGE_SPEED = 1.5;
const RETREAT_SPEED = 3.4;
const SIGHT_RANGE = 34;
const FIRE_INTERVAL = 0.42;
const BOT_DAMAGE = 11;
const BOT_ACCURACY = 0.55;
const RESPAWN_SECONDS = 3;
// How far gunfire carries, and how long a bot keeps walking toward where it heard it.
const HEAR_LIMIT = 24;
const ALERT_SECONDS = 6;
// A bot with less than this much health gives up its post and backs off for a while.
const HURT_HEALTH = 38;
const RETREAT_SECONDS = 3.2;
// The magazine a bot fires before it has to reload, and how long that takes.
const BOT_MAG = 30;
const BOT_RELOAD = 2.1;
// How far to the side a bot slides while shooting, and how long before it swaps sides.
const STRAFE = 2.4;
const STRAFE_SIDE_SECONDS = 1.1;

/**
 * The routes each bot walks, as waypoints in the map's own coordinates. A waypoint with a third
 * entry is a post: the bot stands there and covers the lane instead of passing through.
 */
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

/** The posts a bot stops at: [x, z, dwell seconds, facing angle]. */
const POSTS = [
  { at: [-10, 2], dwell: 3.4, face: Math.PI * 0.5 },
  { at: [11, 2], dwell: 3.4, face: -Math.PI * 0.5 },
  { at: [-1.6, 5], dwell: 2.6, face: Math.PI },
  { at: [-6, 8], dwell: 2.2, face: 0 },
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
      // Where the last shot came from, and how long it stays worth investigating.
      alertUntil: 0,
      alertPoint: new THREE.Vector3(),
      // The behaviour the bot is in, and the timers that decide when it leaves it.
      mode: 'patrol',
      // A bot at a post stands still for a while before walking on.
      dwell: 0,
      post: POSTS[index % POSTS.length],
      // Ammunition a bot carries: it must reload, and a reload is a gap the player can use.
      mag: BOT_MAG,
      reloadLeft: 0,
      // A hurt bot backs off for a while instead of holding its ground.
      hurtUntil: 0,
      // Which way it is currently sliding while it shoots, and when it swaps.
      strafeSide: index % 2 === 0 ? 1 : -1,
      strafeUntil: 0,
      // Blindness from a flash: it cannot aim until it clears.
      blindUntil: 0,
    };
    torso.userData.bot = bot;
    head.userData.bot = bot;
    torso.userData.part = 'torso';
    head.userData.part = 'head';
    hitMeshes.push(torso, head);
    group.position.copy(bot.position);
    bots.push(bot);
  }

  /** Put a bot back at the head of its route, its state as new. */
  function respawn(bot) {
    bot.health = BOT_HEALTH;
    bot.alive = true;
    bot.seenPlayer = false;
    bot.fireAt = 0;
    bot.alertUntil = 0;
    bot.waypoint = 1;
    bot.mode = 'patrol';
    bot.dwell = 0;
    bot.mag = BOT_MAG;
    bot.reloadLeft = 0;
    bot.hurtUntil = 0;
    bot.strafeSide = bot.index % 2 === 0 ? 1 : -1;
    bot.strafeUntil = 0;
    bot.blindUntil = 0;
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
    // A bot that has taken a bad hit breaks off: it backs along its route for a few seconds.
    if (bot.health <= HURT_HEALTH) bot.hurtUntil = performance.now() / 1000 + RETREAT_SECONDS;
    return false;
  }

  /** Blind a bot for a few seconds: a flash it was looking at has taken its aim away. */
  function blind(bot, seconds) {
    if (!bot.alive) return;
    bot.blindUntil = Math.max(bot.blindUntil, performance.now() / 1000 + seconds);
  }

  /**
   * One simulation step: choose a behaviour from what the bot can see and hear, then act on it.
   * `onHit(amount, from)` is called when a bot's shot lands, with the position it came from so the
   * HUD can point at it. `seesThroughSmoke` is the grenade module's answer about the sight line.
   */
  function step(dt, now, playerEye, onHit, seesThroughSmoke) {
    for (const bot of bots) {
      if (!bot.alive) {
        if (now >= bot.respawnAt) bot.respawnAt += 0;
        continue;
      }

      // A reload is a real pause in the fight: no fire, and the bot keeps its ground.
      if (bot.reloadLeft > 0) {
        bot.reloadLeft = Math.max(0, bot.reloadLeft - dt);
        if (bot.reloadLeft === 0) bot.mag = BOT_MAG;
      }

      const blockedBySmoke = seesThroughSmoke !== undefined && seesThroughSmoke(
        { x: bot.position.x, y: HEAD_HEIGHT, z: bot.position.z },
        playerEye,
      );
      const gap = Math.hypot(playerEye.x - bot.position.x, playerEye.z - bot.position.z);
      const canSee = now >= bot.blindUntil
        && gap < SIGHT_RANGE
        && !blockedBySmoke
        && sees({ x: bot.position.x, y: HEAD_HEIGHT, z: bot.position.z }, playerEye);
      bot.seenPlayer = canSee;

      // Decide the behaviour for this step.
      const hurt = now < bot.hurtUntil;
      const alerted = now < bot.alertUntil;
      if (!alerted && bot.alertPoint.lengthSq() !== 0) bot.alertPoint.set(0, 0, 0);
      if (canSee) bot.mode = hurt ? 'retreat' : bot.reloadLeft > 0 ? 'reload' : 'engage';
      else if (hurt) bot.mode = 'retreat';
      else if (alerted) bot.mode = 'hunt';
      else if (bot.dwell > 0) bot.mode = 'hold';
      else bot.mode = 'patrol';

      // Where the bot wants to be, given its behaviour.
      let target = null;
      let speed = WALK_SPEED;
      if (bot.mode === 'engage' || bot.mode === 'reload') {
        target = null;
        speed = ENGAGE_SPEED;
      } else if (bot.mode === 'hold') {
        target = bot.post.at;
        speed = 0;
      } else if (bot.mode === 'hunt') {
        target = [bot.alertPoint.x, bot.alertPoint.z];
        speed = WALK_SPEED;
      } else if (bot.mode === 'retreat') {
        // Back along the route, away from the player: the waypoint behind, not the one ahead.
        const back = (bot.waypoint - 1 + bot.route.length) % bot.route.length;
        target = bot.route[back];
        speed = RETREAT_SPEED;
      } else {
        target = bot.route[bot.waypoint % bot.route.length];
        speed = WALK_SPEED;
      }

      // Face the player while fighting, otherwise face the way it is walking.
      let heading;
      if (canSee) heading = Math.atan2(playerEye.x - bot.position.x, playerEye.z - bot.position.z);
      else if (target) heading = Math.atan2(target[0] - bot.position.x, target[1] - bot.position.z);
      else heading = bot.group.rotation.y;
      bot.group.rotation.y += (heading - bot.group.rotation.y) * Math.min(1, dt * 6);

      // Slide sideways while firing, so two bots in a lane do not stand in the same line.
      if (bot.mode === 'engage') {
        if (now >= bot.strafeUntil) {
          bot.strafeSide *= -1;
          bot.strafeUntil = now + STRAFE_SIDE_SECONDS;
        }
        const perpX = Math.cos(heading) * bot.strafeSide;
        const perpZ = -Math.sin(heading) * bot.strafeSide;
        const stepX = perpX * speed * dt;
        const stepZ = perpZ * speed * dt;
        if (!blocked(bot.position.x + stepX, bot.position.z + stepZ)) {
          bot.position.x += stepX;
          bot.position.z += stepZ;
        } else {
          bot.strafeSide *= -1;
        }
      } else if (target && speed > 0) {
        const dx = target[0] - bot.position.x;
        const dz = target[1] - bot.position.z;
        const distance = Math.hypot(dx, dz);
        if (bot.mode === 'hunt' && distance < 1.2) {
          // Reached the noise with nobody there: give up sooner than the full alert.
          bot.alertUntil = Math.min(bot.alertUntil, now + 0.4);
        } else if (distance < 0.6) {
          reachWaypoint(bot, now);
        } else {
          const stepX = (dx / distance) * speed * dt;
          const stepZ = (dz / distance) * speed * dt;
          if (!blocked(bot.position.x + stepX, bot.position.z)) bot.position.x += stepX;
          if (!blocked(bot.position.x, bot.position.z + stepZ)) bot.position.z += stepZ;
        }
      } else if (bot.mode === 'hold') {
        // Stand at the post, cover the lane, and count the dwell down.
        bot.dwell = Math.max(0, bot.dwell - dt);
        if (bot.dwell === 0) bot.waypoint = (bot.waypoint + 1) % bot.route.length;
      }

      bot.group.position.set(bot.position.x, 0, bot.position.z);
      bot.legs.position.y = 0.36 + Math.sin(now * 6 + bot.index) * 0.02;

      // Fire when the player is in sight, the magazine is loaded and the interval has passed.
      if (canSee && bot.mode !== 'retreat' && bot.mode !== 'reload' && now >= bot.fireAt && bot.mag > 0) {
        bot.fireAt = now + FIRE_INTERVAL;
        bot.mag -= 1;
        if (bot.mag === 0) bot.reloadLeft = BOT_RELOAD;
        if (Math.random() < BOT_ACCURACY) onHit(BOT_DAMAGE, bot.position);
      }
    }
  }

  /** A bot walked onto a waypoint: maybe stand at a post, maybe keep going. */
  function reachWaypoint(bot, now) {
    const here = bot.route[bot.waypoint % bot.route.length];
    const post = POSTS.find((entry) => Math.hypot(entry.at[0] - here[0], entry.at[1] - here[1]) < 0.9);
    if (post && bot.mode === 'patrol') {
      // Stop at the post and cover it, then walk on when the dwell runs out.
      bot.post = post;
      bot.dwell = post.dwell;
      return;
    }
    bot.waypoint = (bot.waypoint + 1) % bot.route.length;
  }

  /**
   * A shot went off at `point`. Every living bot within `radius` turns toward it and walks that
   * way for ALERT_SECONDS, unless it already has the player in sight and needs no hint.
   */
  function hear(point, radius = HEAR_LIMIT) {
    const reach = Math.min(radius, HEAR_LIMIT);
    for (const bot of bots) {
      if (!bot.alive || bot.seenPlayer) continue;
      const gap = Math.hypot(point.x - bot.position.x, point.z - bot.position.z);
      if (gap > reach) continue;
      bot.alertPoint.set(point.x, 0, point.z);
      // A shot right next to a bot holds its attention longer than one across the yard.
      bot.alertUntil = performance.now() / 1000 + ALERT_SECONDS * (1 - Math.min(1, gap / reach) * 0.5);
    }
  }

  return {
    items: bots,
    hitMeshes,
    damage,
    hear,
    blind,
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
    /** Bots currently walking toward a noise, for the HUD and for debugging. */
    alertedCount(now) {
      let count = 0;
      for (const bot of bots) if (bot.alive && now < bot.alertUntil) count += 1;
      return count;
    },
    /** Bots that are blind right now, for the HUD's kill feed and for tests. */
    blindedCount(now) {
      let count = 0;
      for (const bot of bots) if (bot.alive && now < bot.blindUntil) count += 1;
      return count;
    },
  };
}
