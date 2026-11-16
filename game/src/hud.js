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
  const clockBox = document.getElementById('clock');
  const clockTime = document.getElementById('clock-time');
  const clockPhase = document.getElementById('clock-phase');
  const objective = document.getElementById('objective');
  const buy = document.getElementById('buy');
  const buyList = document.getElementById('buy-list');

  let hitTimer = 0;
  let hurtTimer = 0;
  let last = { mag: -1, reserve: -1, health: -1, money: -1, player: -1, bots: -1, time: '', phase: '' };

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
