// The view model and the gun's numbers: a magazine, a reserve, a reload, the spread that punishes
// firing while moving, and the recoil that climbs. It owns the numbers; main.js owns the ray, the
// damage and the choice of weapon. Switching weapon rebuilds the model's proportions from the
// catalog entry, so every gun the player can buy is the same code at a different size.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const RELOAD_TIME = 1.9;
const SPREAD_MOVING = 0.028;
const MOVE_REFERENCE = 5.2;
const MUZZLE_TIME = 0.06;

/** Per-weapon recoil: how far a shot pushes the aim up, and how fast it settles. */
const RECOIL = {
  pistol: { climb: 0.006, side: 0.003 },
  rifle: { climb: 0.010, side: 0.004 },
  smg: { climb: 0.007, side: 0.005 },
  shotgun: { climb: 0.016, side: 0.006 },
};

export function createWeapon(camera) {
  const gripMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });

  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), bodyMaterial);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.4), gripMaterial);
  barrel.position.set(0, 0.025, -0.38);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), gripMaterial);
  stock.position.set(0, -0.02, 0.3);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), gripMaterial);
  magazine.position.set(0, -0.12, -0.06);
  model.add(receiver, barrel, stock, magazine);
  model.position.set(0.24, -0.2, -0.42);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  // The held weapon, copied from its catalog entry so a later catalog edit cannot change it mid-round.
  let spec = { id: 'pistol', mag: 12, reserve: 48, damage: 24, spread: 0.010, rpm: 320 };
  const state = { mag: spec.mag, reserve: spec.reserve, cooldown: 0, reloadLeft: 0, flash: 0, kick: 0 };

  /** Shells fired per trigger pull: a shotgun fires several, everything else one. */
  const pellets = () => spec.pellets ?? 1;

  function equip(entry) {
    if (!entry || spec.id === entry.id) return;
    spec = { ...entry };
    state.mag = spec.mag;
    state.reserve = spec.reserve;
    state.cooldown = 0;
    state.reloadLeft = 0;
    // a longer gun reads as a longer gun: the barrel scales with the magazine
    const length = 0.28 + Math.min(0.3, spec.mag * 0.005);
    barrel.scale.z = length / 0.4;
    barrel.position.z = -0.18 - length * 0.5;
    magazine.scale.y = Math.min(1.6, 0.7 + spec.mag * 0.012);
  }

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    model.position.z = -0.42 + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (RELOAD_TIME - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = spec.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    step,
    equip,
    spec() {
      return spec;
    },
    pellets,
    /** The gap between shots, from the weapon's rounds per minute. */
    gapSeconds() {
      return 60 / Math.max(30, spec.rpm);
    },
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = 60 / Math.max(30, spec.rpm);
      state.flash = MUZZLE_TIME;
      state.kick = 0.055;
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag >= spec.mag || state.reserve === 0) return;
      state.reloadLeft = RELOAD_TIME;
    },
    /** The aim spread, and the recoil the shot adds: both grow while the body is moving. */
    spread(speed) {
      return spec.spread + Math.min(1, speed / MOVE_REFERENCE) * SPREAD_MOVING;
    },
    recoilFor() {
      return RECOIL[spec.id] ?? RECOIL.pistol;
    },
    refill() {
      state.mag = spec.mag;
      state.reserve = spec.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
    },
    /** A round ends with a full magazine, so a new round never starts on an empty gun. */
    refillForRound() {
      state.mag = spec.mag;
      const spare = spec.reserve - state.reserve;
      state.reserve = spec.reserve;
      state.reloadLeft = 0;
      state.cooldown = 0;
      if (spare > 0) state.reserve = spec.reserve;
    },
  };
}
