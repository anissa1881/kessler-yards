// The match: rounds that start, end in a win or a loss, and start again. A round is won by
// eliminating the other team or by holding the objective; money is paid out each round and spent
// in a buy menu between rounds. All of the match's state lives here and nowhere else.
import * as THREE from 'three';

/** The objective: a site the player arms and the bots try to stop. */
export const SITE = new THREE.Vector3(-11.5, 0, -1.0);

const ROUND_SECONDS = 95;
const FREEZE_SECONDS = 6;
const START_MONEY = 800;
const WIN_REWARD = 3250;
const LOSS_REWARD = 1400;
const KILL_REWARD = 300;
const PLANT_REWARD = 300;

/** The shop, by number key. A weapon's cost is paid once and kept across rounds. */
export const CATALOG = [
  { key: '1', id: 'pistol', name: 'Sidearm', cost: 0, mag: 12, reserve: 48, damage: 24, spread: 0.010, rpm: 320 },
  { key: '2', id: 'rifle', name: 'Rifle', cost: 2700, mag: 30, reserve: 90, damage: 33, spread: 0.006, rpm: 600 },
  { key: '3', id: 'smg', name: 'Compact', cost: 1250, mag: 25, reserve: 100, damage: 21, spread: 0.011, rpm: 780 },
  { key: '4', id: 'shotgun', name: 'Breacher', cost: 1500, mag: 7, reserve: 28, damage: 19, spread: 0.030, rpm: 90, pellets: 6 },
  { key: '5', id: 'grenade', name: 'Frag', cost: 300, grenade: true },
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
    grenades: 0,
    siteArmed: false,
    armProgress: 0,
    lastResult: null,
  };

  function startRound() {
    state.phase = 'freeze';
    state.timer = FREEZE_SECONDS;
    state.siteArmed = false;
    state.armProgress = 0;
    state.lastResult = null;
    // a kept weapon stays bought; a lost round still pays something, so the economy never dies
    state.money = Math.max(0, state.money);
  }

  function endRound(wonByPlayer, reason) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.lastResult = { won: wonByPlayer, reason };
    if (wonByPlayer) {
      state.score.player += 1;
      state.money += WIN_REWARD;
    } else {
      state.score.bots += 1;
      state.money += LOSS_REWARD;
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
      state.grenades += 1;
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

  function step(dt) {
    if (state.phase === 'freeze') {
      state.timer -= dt;
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = ROUND_SECONDS;
      }
      return;
    }
    if (state.phase === 'live') {
      state.timer -= dt;
      if (state.siteArmed) {
        state.armProgress += dt;
        if (state.armProgress >= 35) {
          endRound(true, 'The site went off.');
        }
      }
      if (state.timer <= 0) endRound(false, 'Time ran out on the site.');
    }
  }

  /** The weapon the player is holding, from the catalog. */
  function heldWeapon() {
    return CATALOG.find((entry) => entry.id === state.active) ?? CATALOG[0];
  }

  return { state, step, startRound, endRound, nextRound, buy, heldWeapon, SITE, PLANT_REWARD, KILL_REWARD };
}
