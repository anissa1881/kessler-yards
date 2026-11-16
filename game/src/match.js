// The match: rounds that start, end in a win or a loss, and start again.
//
// A round is won three ways: by eliminating the other team, by planting the charge at the site and
// letting its timer run out, or by losing the charge because the other team defused it in time. The
// player plants by holding E at the site; once it is planted the round clock is replaced by the
// charge's own fuse, and the bots come to defuse it. Money is paid out each round and spent in a
// buy menu between rounds, and a losing run pays a little more each round so the economy cannot
// dead-end.
//
// All of the match's state lives here and nowhere else: main.js reads it and calls into it, the HUD
// shows it, and nothing else keeps a copy.
import * as THREE from 'three';

/** The objective: a site the player plants the charge at, and the bots defuse. */
export const SITE = new THREE.Vector3(-11.5, 0, -1.0);

const ROUND_SECONDS = 95;
const FREEZE_SECONDS = 6;
const START_MONEY = 800;
const WIN_REWARD = 3250;
const LOSS_REWARD = 1400;
const LOSS_STREAK_BONUS = 500;
const KILL_REWARD = 300;
const PLANT_REWARD = 300;
// The charge: how long the plant takes, how long its fuse is, and how long a defuse takes.
const PLANT_SECONDS = 3.2;
const FUSE_SECONDS = 40;
const DEFUSE_SECONDS = 7;
// How close to the site the player must stand to plant, and a bot to defuse.
const PLANT_RANGE = 1.7;
const DEFUSE_RANGE = 1.5;
/** Once planted, the round clock is replaced by the fuse: this is what the HUD counts down. */
const BOMB_PHASE = 'planted';

/** The shop, by number key. A weapon's cost is paid once and kept across rounds. */
export const CATALOG = [
  { key: '1', id: 'pistol', name: 'Sidearm', cost: 0, mag: 12, reserve: 48, damage: 24, spread: 0.010, rpm: 320 },
  { key: '2', id: 'rifle', name: 'Rifle', cost: 2700, mag: 30, reserve: 90, damage: 33, spread: 0.006, rpm: 600 },
  { key: '3', id: 'smg', name: 'Compact', cost: 1250, mag: 25, reserve: 100, damage: 21, spread: 0.011, rpm: 780 },
  { key: '4', id: 'shotgun', name: 'Breacher', cost: 1500, mag: 7, reserve: 28, damage: 19, spread: 0.030, rpm: 90, pellets: 6 },
  { key: '5', id: 'grenade', name: 'Frag', cost: 300, grenade: true, kind: 'frag' },
  { key: '6', id: 'smoke', name: 'Smoke', cost: 300, grenade: true, kind: 'smoke' },
  { key: '7', id: 'flash', name: 'Flash', cost: 200, grenade: true, kind: 'flash' },
];

export function createMatch() {
  const state = {
    phase: 'freeze',
    round: 1,
    timer: FREEZE_SECONDS,
    score: { player: 0, bots: 0 },
    money: START_MONEY,
    owned: new Set(['pistol']),
    active: 'pistol',
    // Grenades the player has bought, by kind: a count each, not a set.
    grenades: { frag: 0, smoke: 0, flash: 0 },
    // The charge: planted or not, how long its fuse has left, and how far a defuse has got.
    planted: false,
    fuse: 0,
    defuseProgress: 0,
    // How long the player has held E at the site, so the plant is a hold and not a tap.
    plantProgress: 0,
    // Consecutive losses, which is what makes the payout climb.
    lossStreak: 0,
    lastResult: null,
  };

  function startRound() {
    state.phase = 'freeze';
    state.timer = FREEZE_SECONDS;
    state.planted = false;
    state.fuse = 0;
    state.defuseProgress = 0;
    state.plantProgress = 0;
    state.lastResult = null;
    // a kept weapon stays bought; a lost round still pays something, so the economy never dies
    state.money = Math.max(0, state.money);
  }

  function endRound(wonByPlayer, reason) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.lastResult = { won: wonByPlayer, reason, planted: state.planted };
    if (wonByPlayer) {
      state.score.player += 1;
      state.money += WIN_REWARD;
      state.lossStreak = 0;
    } else {
      state.score.bots += 1;
      // Every loss in a row pays a little more: a side that keeps losing is not starved out.
      state.money += LOSS_REWARD + state.lossStreak * LOSS_STREAK_BONUS;
      state.lossStreak = Math.min(4, state.lossStreak + 1);
    }
  }

  function nextRound() {
    state.round += 1;
    startRound();
  }

  /** Buy a catalog item if it is affordable and not already owned. */
  function buy(id) {
    const item = CATALOG.find((entry) => entry.id === id);
    if (!item) return false;
    if (item.grenade) {
      if (state.money < item.cost) return false;
      state.money -= item.cost;
      state.grenades[item.kind] = (state.grenades[item.kind] ?? 0) + 1;
      return true;
    }
    if (state.owned.has(item.id)) {
      state.active = item.id;
      return true;
    }
    if (state.money < item.cost) return false;
    state.money -= item.cost;
    state.owned.add(item.id);
    state.active = item.id;
    return true;
  }

  /** Take one grenade of a kind out of the bag, answering whether there was one to take. */
  function takeGrenade(kind) {
    if ((state.grenades[kind] ?? 0) <= 0) return false;
    state.grenades[kind] -= 1;
    return true;
  }

  /**
   * The player is holding E at `position`. Build the plant while it is held and the player stands
   * at the site; answer whether the charge went down this step.
   */
  function plantStep(dt, position, holding) {
    if (state.planted || state.phase !== 'live') {
      state.plantProgress = 0;
      return false;
    }
    const atSite = Math.hypot(position.x - SITE.x, position.z - SITE.z) < PLANT_RANGE;
    if (!holding || !atSite) {
      // letting go, or walking out of the ring, drops the plant: it is a hold, not a tap
      state.plantProgress = 0;
      return false;
    }
    state.plantProgress = Math.min(PLANT_SECONDS, state.plantProgress + dt);
    if (state.plantProgress < PLANT_SECONDS) return false;
    state.planted = true;
    state.fuse = FUSE_SECONDS;
    state.plantProgress = 0;
    state.money += PLANT_REWARD;
    return true;
  }

  /**
   * A bot is standing at the planted charge: build the defuse while it stays. `botCount` is how
   * many bots are in range this step; a defuse the player interrupts starts over.
   */
  function defuseStep(dt, botCount) {
    if (!state.planted || state.phase !== 'live') {
      state.defuseProgress = 0;
      return false;
    }
    if (botCount <= 0) {
      state.defuseProgress = Math.max(0, state.defuseProgress - dt * 2);
      return false;
    }
    state.defuseProgress = Math.min(DEFUSE_SECONDS, state.defuseProgress + dt);
    if (state.defuseProgress < DEFUSE_SECONDS) return false;
    endRound(false, 'The charge was defused.');
    return true;
  }

  function step(dt) {
    if (state.phase === 'freeze') {
      state.timer -= dt;
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = ROUND_SECONDS;
      }
      return;
    }
    if (state.phase !== 'live') return;

    if (state.planted) {
      // The charge is down: its fuse is the clock now, and it ending is the round.
      state.fuse = Math.max(0, state.fuse - dt);
      if (state.fuse <= 0) endRound(true, 'The charge went off at the site.');
      return;
    }

    state.timer -= dt;
    if (state.timer <= 0) endRound(false, 'Time ran out with the charge unplanted.');
  }

  /** The weapon the player is holding, from the catalog. */
  function heldWeapon() {
    return CATALOG.find((entry) => entry.id === state.active) ?? CATALOG[0];
  }

  return {
    state,
    step,
    startRound,
    endRound,
    nextRound,
    buy,
    takeGrenade,
    plantStep,
    defuseStep,
    heldWeapon,
    SITE,
    PLANT_REWARD,
    KILL_REWARD,
    PLANT_RANGE,
    DEFUSE_RANGE,
    PLANT_SECONDS,
    FUSE_SECONDS,
    DEFUSE_SECONDS,
    BOMB_PHASE,
  };
}
