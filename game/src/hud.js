// The DOM HUD: the crosshair, the hit marker, health, money, ammunition, the round timer, the
// round score, the objective line and the buy menu. It never touches the simulation: main.js
// pushes numbers in and reads the buy callback out.
const COPY = {
  start: {
    title: 'Kessler Yards',
    copy: 'Two lanes, one pillar gate and a site to arm. Hold the yard against the opposing team.',
    action: 'Click to play',
  },
  paused: {
    title: 'Kessler Yards',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  end: {
    title: 'Round over',
    copy: '',
    action: 'Play again',
  },
};

const PHASE_LABEL = {
  freeze: 'Freeze',
  live: 'Live',
  over: 'Round over',
  planted: 'Charge',
};

/** Turn a number of seconds into m:ss. */
function clock(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function createHud() {
  const overlay = document.getElementById('overlay');
  const title = document.getElementById('overlay-title');
  const copy = document.getElementById('overlay-copy');
  const play = document.getElementById('play');
  const ammo = document.getElementById('ammo');
  const ammoMag = document.getElementById('ammo-mag');
  const ammoReserve = document.getElementById('ammo-reserve');
  const healthValue = document.getElementById('health');
  const moneyValue = document.getElementById('money');
  const scorePlayer = document.getElementById('score-player');
  const scoreBots = document.getElementById('score-bots');
  const hitmarker = document.getElementById('hitmarker');
  const hurt = document.getElementById('hurt');
  const threat = document.getElementById('threat');
  const arm = document.getElementById('arm');
  const armFill = document.getElementById('arm-fill');
  const charge = document.getElementById('charge');
  const chargeFill = document.getElementById('charge-fill');
  const chargeLabel = document.getElementById('charge-label');
  const clockBox = document.getElementById('clock');
  const clockTime = document.getElementById('clock-time');
  const clockPhase = document.getElementById('clock-phase');
  const objective = document.getElementById('objective');
  const buy = document.getElementById('buy');
  const buyList = document.getElementById('buy-list');
  const grenades = document.getElementById('grenades');
  const blind = document.getElementById('blind');
  const feed = document.getElementById('feed');

  let hitTimer = 0;
  let hurtTimer = 0;
  let threatTimer = 0;
  let last = { mag: -1, reserve: -1, health: -1, money: -1, player: -1, bots: -1, time: '', phase: '', grenades: '', feed: '' };

  return {
    setAmmo(mag, reserve) {
      if (mag === last.mag && reserve === last.reserve) return;
      last.mag = mag;
      last.reserve = reserve;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      ammo.classList.toggle('empty', mag === 0);
    },
    setHealth(value) {
      if (value === last.health) return;
      last.health = value;
      healthValue.textContent = String(Math.max(0, Math.round(value)));
      healthValue.classList.toggle('low', value <= 30);
    },
    setMoney(value) {
      if (value === last.money) return;
      last.money = value;
      moneyValue.textContent = `$${value}`;
    },
    setScore(player, bots) {
      if (player !== last.player) {
        last.player = player;
        scorePlayer.textContent = String(player);
      }
      if (bots !== last.bots) {
        last.bots = bots;
        scoreBots.textContent = String(bots);
      }
    },
    setClock(seconds, phase) {
      const text = clock(seconds);
      if (text !== last.time) {
        last.time = text;
        clockTime.textContent = text;
      }
      clockBox.classList.toggle('urgent', seconds <= 15 && phase === 'live');
      if (phase !== last.phase) {
        last.phase = phase;
        clockPhase.textContent = PHASE_LABEL[phase] ?? phase;
      }
    },
    setArmed(on) {
      objective.classList.toggle('on', on);
    },
    /**
     * The charge's bar, shared by the plant and the defuse: `label` says which one is filling, so
     * the two never look alike and a player can tell in a glance whether to keep holding E.
     */
    setCharge(label, fraction) {
      const shown = Math.max(0, Math.min(1, fraction));
      const visible = label !== '' && shown > 0.001 && shown < 1;
      charge.classList.toggle('on', visible);
      charge.classList.toggle('defuse', label === 'Defusing');
      if (visible) {
        chargeLabel.textContent = label;
        chargeFill.style.width = `${(shown * 100).toFixed(1)}%`;
      }
    },
    /** The grenades in the bag, as three counts that hide when empty. */
    setGrenades(counts) {
      const key = `${counts.frag},${counts.smoke},${counts.flash}`;
      if (key === last.grenades) return;
      last.grenades = key;
      const parts = [];
      if (counts.frag > 0) parts.push(`frag ${counts.frag}`);
      if (counts.smoke > 0) parts.push(`smoke ${counts.smoke}`);
      if (counts.flash > 0) parts.push(`flash ${counts.flash}`);
      grenades.textContent = parts.join('  ·  ');
      grenades.classList.toggle('on', parts.length > 0);
    },
    /**
     * Show how far the arming hold has got, 0..1. Below epsilon the bar hides, so letting go of E
     * makes it disappear rather than lingering half full.
     */
    setArmProgress(fraction) {
      const shown = Math.max(0, Math.min(1, fraction));
      const visible = shown > 0.001 && shown < 1;
      arm.classList.toggle('on', visible);
      armFill.style.width = `${(shown * 100).toFixed(1)}%`;
    },
    /**
     * The kill feed: one line per elimination, newest first. Rebuilt only when the set of lines
     * changes, so a steady firefight does not churn the DOM every frame.
     */
    setFeed(rows) {
      const key = rows.map((row) => row.id).join(',');
      if (key === last.feed) return;
      last.feed = key;
      feed.textContent = '';
      for (const row of rows) {
        const line = document.createElement('div');
        line.textContent = row.text;
        if (row.head) line.className = 'head';
        feed.append(line);
      }
      feed.classList.toggle('on', rows.length > 0);
    },
    /**
     * The whiteout of a flash, 0..1: 0 hides it. It is drawn over everything, because a flash is
     * supposed to take the whole screen away, not tint it.
     */
    setBlind(fraction) {
      const shown = Math.max(0, Math.min(1, fraction));
      blind.style.opacity = shown.toFixed(2);
      blind.classList.toggle('on', shown > 0.01);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.style.transform = killed ? 'translate(-50%, -50%) rotate(45deg) scale(1.25)' : '';
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        hitmarker.classList.remove('on');
        hitmarker.style.transform = '';
      }, holdMs);
    },
    flashHurt() {
      hurt.classList.add('on');
      clearTimeout(hurtTimer);
      hurtTimer = setTimeout(() => hurt.classList.remove('on'), 140);
    },
    /**
     * Point a wedge at whoever just hit us. `angle` is the bearing to the shooter relative to
     * where we are looking, in radians, clockwise: 0 ahead, +-PI behind.
     */
    showThreat(angle) {
      threat.style.transform = `rotate(${angle}rad)`;
      threat.classList.add('on');
      clearTimeout(threatTimer);
      threatTimer = setTimeout(() => threat.classList.remove('on'), 1200);
    },
    showBuy(rows) {
      buyList.textContent = '';
      for (const row of rows) {
        const li = document.createElement('li');
        if (row.held) li.className = 'held';
        else if (row.owned) li.className = 'owned';
        const name = document.createElement('span');
        name.textContent = `${row.key}  ${row.name}`;
        const cost = document.createElement('span');
        cost.className = 'cost';
        cost.textContent = row.held ? 'held' : row.owned ? 'owned' : `$${row.cost}`;
        li.append(name, cost);
        buyList.append(li);
      }
      buy.hidden = false;
    },
    hideBuy() {
      buy.hidden = true;
    },
    showOverlay(mode, detail) {
      const text = COPY[mode];
      title.textContent = text.title;
      copy.textContent = mode === 'end' && detail ? detail : text.copy;
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
  };
}
