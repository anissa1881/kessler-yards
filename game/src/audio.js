// Sound, made rather than loaded: every noise here is synthesised from oscillators and noise
// buffers at the moment it plays. The game ships as static files with no network and no asset
// folder, so a wav per weapon would be weight for nothing, and a short decay is all a gunshot
// needs anyway. The context starts suspended until the player clicks, which browsers require.

const SAMPLE_RATE_HINT = 44100;

/** A short burst of white noise, reused by every call so we do not allocate per shot. */
function noiseBuffer(context, seconds) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 1;
  for (let i = 0; i < length; i += 1) {
    // a plain linear congruential generator keeps the noise identical between runs
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 4294967296) * 2 - 1;
  }
  return buffer;
}

/**
 * Voice recipes, one per sound. Each returns the pieces to play: a filtered noise burst for the
 * body and, optionally, a falling sine for the thump behind it. Distinct enough that a rifle,
 * a shotgun and an smg are told apart by ear in a firefight.
 */
const VOICES = {
  pistol: { noise: { gain: 0.34, decay: 0.10, filter: 1900, q: 0.9 }, thump: { from: 190, to: 60, gain: 0.20, decay: 0.09 } },
  rifle: { noise: { gain: 0.46, decay: 0.13, filter: 2600, q: 0.8 }, thump: { from: 150, to: 46, gain: 0.26, decay: 0.12 } },
  smg: { noise: { gain: 0.30, decay: 0.07, filter: 3100, q: 1.1 }, thump: { from: 210, to: 70, gain: 0.16, decay: 0.06 } },
  shotgun: { noise: { gain: 0.55, decay: 0.20, filter: 1500, q: 0.7 }, thump: { from: 120, to: 38, gain: 0.34, decay: 0.18 } },
  dry: { noise: { gain: 0.16, decay: 0.03, filter: 5200, q: 2.0 } },
  reloadOut: { noise: { gain: 0.14, decay: 0.05, filter: 900, q: 3.0 } },
  reloadIn: { noise: { gain: 0.18, decay: 0.06, filter: 1300, q: 3.0 } },
  step: { noise: { gain: 0.07, decay: 0.045, filter: 380, q: 0.8 } },
  hurt: { thump: { from: 260, to: 80, gain: 0.30, decay: 0.24 } },
  frag: { noise: { gain: 0.60, decay: 0.42, filter: 700, q: 0.6 }, thump: { from: 110, to: 30, gain: 0.40, decay: 0.36 } },
  hit: { thump: { from: 900, to: 700, gain: 0.14, decay: 0.05 } },
  win: { thump: { from: 520, to: 780, gain: 0.22, decay: 0.30 } },
  lose: { thump: { from: 420, to: 190, gain: 0.22, decay: 0.34 } },
};

/** Weapon key from the weapon's name, so the audio layer does not import the catalogue. */
export function voiceForWeapon(name) {
  const lower = String(name).toLowerCase();
  if (lower.includes('shotgun')) return 'shotgun';
  if (lower.includes('rifle')) return 'rifle';
  if (lower.includes('smg')) return 'smg';
  return 'pistol';
}

export function createAudio() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextClass) {
    // No audio hardware or an old browser: every call below becomes a no-op, the game still runs.
    return {
      play() {},
      footstep() {},
      resume() {},
      setMuted() {},
      get muted() {
        return true;
      },
    };
  }

  const context = new AudioContextClass({ sampleRate: SAMPLE_RATE_HINT });
  const master = context.createGain();
  master.gain.value = 0.55;
  master.connect(context.destination);

  // One noise buffer per length we need, built lazily and kept.
  const buffers = new Map();
  const noise = (seconds) => {
    const key = Math.round(seconds * 100);
    if (!buffers.has(key)) buffers.set(key, noiseBuffer(context, seconds));
    return buffers.get(key);
  };

  let muted = false;
  let lastStep = 0;

  /** Play one voice at the given stereo position and pitch. */
  function play(voiceName, { pan = 0, detune = 0, when = 0 } = {}) {
    if (muted) return;
    const recipe = VOICES[voiceName];
    if (!recipe) return;
    const start = context.currentTime + when;

    // Stereo placement: a single panner for the whole voice, so the two layers stay together.
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);

    if (recipe.noise) {
      const { gain, decay, filter, q } = recipe.noise;
      const source = context.createBufferSource();
      source.buffer = noise(decay + 0.02);
      source.playbackRate.value = 1;
      if (detune) source.detune.value = detune;

      const shaped = context.createBiquadFilter();
      shaped.type = 'bandpass';
      shaped.frequency.value = filter;
      shaped.Q.value = q;

      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(gain, start + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + decay);

      source.connect(shaped).connect(envelope).connect(panner);
      source.start(start);
      source.stop(start + decay + 0.02);
    }

    if (recipe.thump) {
      const { from, to, gain, decay } = recipe.thump;
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + decay);

      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(gain, start + 0.005);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + decay);

      oscillator.connect(envelope).connect(panner);
      oscillator.start(start);
      oscillator.stop(start + decay + 0.02);
    }
  }

  return {
    /** Browsers keep the context suspended until a gesture; call this on the first click. */
    resume() {
      if (context.state === 'suspended') context.resume().catch(() => {});
    },
    play,
    /** Footsteps are rate limited so a sprint does not turn into a machine gun. */
    footstep(speed) {
      const now = context.currentTime;
      const gap = speed > 4 ? 0.30 : 0.42;
      if (now - lastStep < gap) return;
      lastStep = now;
      play('step', { pan: 0, detune: Math.round((now % 1) * 90) });
    },
    setMuted(value) {
      muted = Boolean(value);
      master.gain.value = muted ? 0 : 0.55;
    },
    get muted() {
      return muted;
    },
  };
}
