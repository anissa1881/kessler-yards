// What the round looks like when it is not your turn to shoot.
//
// Two jobs live here, because both are about telling the player what just happened:
//
//   the kill feed  - a line per elimination, naming who killed whom and with what, newest at the
//                    top and each line retiring on its own after a few seconds;
//   the round card - the short summary shown between rounds: who won, why, and the running score.
//
// Neither one touches the simulation. main.js calls `add` when a body drops and `card` when a round
// ends, and this module decides only how those facts are worded and how long they stay on screen.
// Keeping the wording here means the feed and the card agree with each other, which they would not
// if each caller wrote its own sentence.

/** How long a kill-feed line stays, and how many lines are kept before the oldest is dropped. */
const FEED_SECONDS = 4.5;
const FEED_MAX = 5;

/** The weapon names as a feed should read them: short, lower case, no marketing. */
const WEAPON_WORDS = {
  pistol: 'sidearm',
  rifle: 'rifle',
  smg: 'compact',
  shotgun: 'breacher',
  frag: 'frag',
  smoke: 'smoke',
  flash: 'flash',
};

/** A head shot is worth saying out loud: the feed marks it and the card counts it. */
const HEAD_MARK = '\u25cf';

export function createFeed() {
  const lines = [];
  let nextId = 1;

  /** The word a weapon reads as in the feed, falling back to its own name. */
  function weaponWord(weapon) {
    if (!weapon) return 'gunfire';
    const key = String(weapon).toLowerCase();
    return WEAPON_WORDS[key] ?? key;
  }

  /**
   * Add a line: `killer` and `victim` are display names ("you", "bot 2"), `weapon` is the catalog
   * id, and `head` says whether the shot that ended it was a head shot. Returns the line so a
   * caller can name it in a test.
   */
  function add(killer, victim, weapon, head = false) {
    const line = {
      id: nextId,
      killer: killer || 'nobody',
      victim: victim || 'nobody',
      weapon: weaponWord(weapon),
      head: Boolean(head),
      // The wall clock at the moment it happened, so aging is not tied to any frame budget.
      at: performance.now() / 1000,
    };
    nextId += 1;
    lines.unshift(line);
    if (lines.length > FEED_MAX) lines.length = FEED_MAX;
    return line;
  }

  /** Drop the lines that have aged out, and answer what is left, newest first. */
  function live(now = performance.now() / 1000) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (now - lines[i].at > FEED_SECONDS) lines.splice(i, 1);
    }
    return lines;
  }

  /** The sentence a feed line reads as, which the HUD prints as one string. */
  function textOf(line) {
    const mark = line.head ? ` ${HEAD_MARK}` : '';
    return `${line.killer}  ${line.weapon}${mark}  ${line.victim}`;
  }

  /**
   * The card between rounds. `result` is the match's own lastResult, `score` the running score, and
   * `round` the round that just finished, so the card can say "Round 3". A round nobody won (time
   * ran out on an unplanted site) reads differently from a win, which is why the reason is kept.
   */
  function card(result, score, round) {
    if (!result) return { title: 'Round over', detail: '', score: '' };
    const verdict = result.won ? 'Round won' : 'Round lost';
    // A planted charge changes what the round meant, so the card says so plainly.
    const how = result.planted
      ? result.won
        ? 'the charge went off'
        : 'the charge was defused'
      : result.reason || 'the round ended';
    return {
      title: `${verdict} \u00b7 round ${round}`,
      detail: how,
      score: `Rounds ${score.player} to ${score.bots}`,
    };
  }

  return {
    add,
    live,
    textOf,
    card,
    /** A round reset keeps no line from the last one. */
    clear() {
      lines.length = 0;
    },
    /** The kinds a feed line can name, for anything that wants to validate a weapon id. */
    weaponWords() {
      return { ...WEAPON_WORDS };
    },
  };
}
