// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// ?shot=start|play|end with &seed=N sets up a deterministic frame for a capture, renders it
// twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeapon } from './weapon.js';
import { createBots } from './bots.js';
import { createHud } from './hud.js';
import { createMatch, CATALOG, SITE } from './match.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 22, 58);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const bots = createBots(scene, world.colliders);
const weapon = createWeapon(camera);
const hud = createHud();
const player = createPlayer(world.colliders);
const input = createInput(renderer.domElement, onLockChange);
const match = createMatch();
const raycaster = new THREE.Raycaster();
raycaster.far = 90;
const shootables = world.shootables.concat(bots.hitMeshes);
const direction = new THREE.Vector3();
const aimPoint = new THREE.Vector3();

// The site: a marked plate the player arms by holding E inside it.
const siteRing = new THREE.Mesh(
  new THREE.RingGeometry(0.9, 1.15, 28),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
);
siteRing.rotation.x = -Math.PI / 2;
siteRing.position.copy(SITE).setY(0.03);
scene.add(siteRing);

const body = player.state;
const markerHoldMs = shot ? 4000 : 90;
let playerHealth = 100;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let buyOpen = false;

weapon.equip(match.heldWeapon());
hud.setAmmo(weapon.state.mag, weapon.state.reserve);
hud.setHealth(playerHealth);
hud.setMoney(match.state.money);
hud.setScore(0, 0);
hud.setClock(match.state.timer, match.state.phase);

hud.onPlay(() => {
  if (shot) return;
  input.requestLock();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
  } else if (match.state.phase !== 'over') {
    hud.showOverlay(started ? 'paused' : 'start');
  }
}

function syncCamera() {
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

/** Open or close the buy menu, which only works during the freeze. */
function toggleBuy(force) {
  const wanted = force ?? !buyOpen;
  if (wanted && match.state.phase !== 'freeze') return;
  buyOpen = wanted;
  if (buyOpen) {
    hud.showBuy(CATALOG.map((entry) => ({
      key: entry.key,
      name: entry.name,
      cost: entry.cost,
      owned: !entry.grenade && match.state.owned.has(entry.id),
      held: !entry.grenade && match.state.active === entry.id,
    })));
  } else {
    hud.hideBuy();
  }
}

/** Buy from the catalog by index; the menu refreshes so money and ownership stay true. */
function buyByKey(key) {
  const entry = CATALOG.find((item) => item.key === key);
  if (!entry) return;
  if (!match.buy(entry.id)) return;
  if (!entry.grenade) {
    weapon.equip(match.heldWeapon());
    hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  }
  hud.setMoney(match.state.money);
  toggleBuy(true);
}

/** One trigger pull: a ray per pellet, head shots worth far more than torso hits. */
function shoot(spread) {
  if (!weapon.takeRound()) return false;
  const killedNow = [];
  for (let pellet = 0; pellet < weapon.pellets(); pellet += 1) {
    camera.getWorldDirection(direction);
    direction.x += (random() * 2 - 1) * spread;
    direction.y += (random() * 2 - 1) * spread;
    direction.z += (random() * 2 - 1) * spread;
    direction.normalize();
    scene.updateMatrixWorld(true);
    raycaster.set(camera.position, direction);
    const hit = raycaster.intersectObjects(shootables, false)[0];
    if (!hit || !hit.object.userData.bot) continue;
    const target = hit.object.userData.bot;
    const head = hit.object.userData.part === 'head';
    const amount = weapon.spec().damage * (head ? 3.6 : 1);
    if (bots.damage(target, amount)) {
      match.state.money += match.KILL_REWARD;
      killedNow.push(target);
    }
    hud.hitMarker(head);
  }
  const recoil = weapon.recoilFor();
  player.recoil(recoil.climb + random() * recoil.side, (random() * 2 - 1) * recoil.side);
  weapon.pullTrigger();
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(match.state.money);

  if (killedNow.length && bots.aliveCount() === 0) match.endRound(true, 'The opposing team is down.');
  return true;
}

/** Throw a frag from the eye toward the aim, and hurt anything close when it lands. */
function throwFrag() {
  if (match.state.grenades <= 0) return;
  match.state.grenades -= 1;
  camera.getWorldDirection(direction);
  const landing = new THREE.Vector3(
    camera.position.x + direction.x * 12,
    camera.position.y + direction.y * 12,
    camera.position.z + direction.z * 12,
  );
  const distance = Math.min(landing.y, 0);
  landing.y = Math.max(0, distance);
  for (const bot of bots.items) {
    if (!bot.alive) continue;
    const gap = Math.hypot(bot.position.x - landing.x, bot.position.z - landing.z);
    if (gap < 4.2) bots.damage(bot, 110 * (1 - gap / 4.2));
  }
  if (bots.aliveCount() === 0) match.endRound(true, 'The fragment cleared the yard.');
}

function step(dt) {
  const now = performance.now() / 1000;
  match.step(dt);

  if (match.state.phase === 'live') {
    player.step(dt, input.state.keys);
    weapon.step(dt);
    camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
    aimPoint.set(camera.position.x, camera.position.y, camera.position.z);
    bots.step(dt, now, aimPoint, (amount) => {
      playerHealth -= amount;
      hud.setHealth(playerHealth);
      hud.flashHurt();
      if (playerHealth <= 0) match.endRound(false, 'You were eliminated.');
    });

    // arming the site: hold E inside the ring
    const inSite = Math.hypot(body.position.x - SITE.x, body.position.z - SITE.z) < 1.6;
    if (input.state.keys.has('KeyE') && inSite && !match.state.siteArmed) {
      match.state.siteArmed = true;
      match.state.money += match.PLANT_REWARD;
      hud.setMoney(match.state.money);
    }
    hud.setArmed(match.state.siteArmed);
  } else {
    weapon.step(dt);
  }

  hud.setClock(match.state.timer, match.state.phase);
  hud.setScore(match.state.score.player, match.state.score.bots);

  if (match.state.phase === 'over') {
    const result = match.state.lastResult;
    match.nextRound();
    playerHealth = 100;
    bots.reset();
    weapon.refillForRound();
    hud.setHealth(playerHealth);
    hud.setMoney(match.state.money);
    hud.setAmmo(weapon.state.mag, weapon.state.reserve);
    hud.setArmed(false);
    if (result) hud.showOverlay('end', `${result.reason} Rounds ${match.state.score.player} to ${match.state.score.bots}.`);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    if (input.state.keys.has('KeyB')) toggleBuy();
    if (buyOpen) {
      for (const key of ['1', '2', '3', '4', '5']) if (input.state.keys.has(`Digit${key}`)) buyByKey(key);
      input.state.keys.clear();
    }
    if (input.state.firing && weapon.ready() && !buyOpen) shoot(shot ? 0 : weapon.spread(player.groundSpeed()));
    if (input.state.keys.has('KeyR')) weapon.reload();
    if (input.state.keys.has('KeyG')) {
      throwFrag();
      input.state.keys.delete('KeyG');
    }
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

function runShot(name) {
  hud.hideOverlay();
  body.pitch = 0;
  body.yaw = 0;
  if (name === 'play' || name === 'end') {
    body.position.set(-4.6, 0, 11.0);
    match.state.phase = 'live';
    match.state.timer = 62;
    settle(20);
    const count = name === 'play' ? 1 : bots.items.length;
    for (let index = 0; index < count; index += 1) {
      const bot = bots.items[index];
      for (let round = 0; round < 3; round += 1) {
        aimAt(new THREE.Vector3(bot.position.x, 1.3, bot.position.z));
        shoot(0);
        if (round < 2) settle(8);
      }
    }
    if (name === 'end') {
      match.state.score.player = 2;
      match.state.score.bots = 1;
      match.state.money = 3150;
      playerHealth = 64;
      match.state.siteArmed = true;
      settle(20);
      aimAt(new THREE.Vector3(SITE.x, 0.6, SITE.z));
      hud.showOverlay('end', 'The site went off. Rounds 2 to 1.');
    } else {
      settle(12);
      aimAt(new THREE.Vector3(bots.items[1].position.x, 1.5, bots.items[1].position.z));
      shoot(0);
      settle(1);
    }
  } else {
    body.position.set(-6.4, 0, 12.2);
    settle(20);
    aimAt(new THREE.Vector3(2, 1.3, -6));
    hud.showOverlay('start');
  }
  hud.setHealth(playerHealth);
  hud.setMoney(match.state.money);
  hud.setScore(match.state.score.player, match.state.score.bots);
  hud.setClock(match.state.timer, match.state.phase);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
