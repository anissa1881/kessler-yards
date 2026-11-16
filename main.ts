// The entry program for threejs-fps-01 (Node 22, standard library only).
//
// It hands the game in: copies game/ and screenshots/ from beside this file into the output
// directory the scorer reads, then writes dossier.json with the vendored make.fun library.
//
// The checks below run before anything is copied. A missing game or the wrong number of
// screenshots is worth knowing in one clear sentence, not as a half-written output directory
// that the scorer refuses later for a reason that names the wrong file.
//
// Serve the game locally with `node serve.ts` and open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The scorer's own caps, from the kit's reference/gate.json. The size limits are passed straight
// to buildDossier, which refuses an output the scorer would refuse; the counts below are checked
// here so a mistake is reported as a sentence rather than a thrown library error.
const TEXT_MAX_BYTES = 163840;
const SHOT_MAX = 4;
const SHOT_MIN = 3;
const SHOT_MAX_BYTES = 262144;
const GAME_MAX_FILES = 993;
const GAME_MAX_BYTES = 50331648;

/** Stop with a message that says which file is wrong and what to do about it. */
function refuse(message) {
  console.error(`main.ts: ${message}`);
  process.exit(1);
}

const gameDir = join(here, 'game');
const shotsDir = join(here, 'screenshots');
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

if (!existsSync(gameDir)) refuse('game/ is missing next to main.ts: the entry has nothing to hand in.');
if (!existsSync(join(gameDir, 'index.html'))) {
  refuse('game/index.html is missing: the scorer opens that file to read the game.');
}
if (!existsSync(shotsDir)) {
  refuse(`screenshots/ is missing: threejs-fps-01 needs ${SHOT_MIN} to ${SHOT_MAX} screenshots of the game.`);
}

// Screenshots, counted the way the scaffold opens them: every visible file, named.
const shotNames = readdirSync(shotsDir)
  .filter((name) => !name.startsWith('.'))
  .sort();
if (shotNames.length < SHOT_MIN || shotNames.length > SHOT_MAX) {
  refuse(
    `screenshots/ holds ${shotNames.length} files, but threejs-fps-01 wants ${SHOT_MIN} to ${SHOT_MAX}. ` +
      `It has: ${shotNames.join(', ') || '(nothing)'}.`,
  );
}
for (const name of shotNames) {
  const bytes = statSync(join(shotsDir, name)).size;
  if (bytes > SHOT_MAX_BYTES) {
    refuse(`screenshots/${name} is ${bytes} bytes, over the ${SHOT_MAX_BYTES}-byte cap: shrink it.`);
  }
}

// The game, counted as files and bytes before copying, so a bloated build is caught here.
function weigh(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = weigh(path);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

const game = weigh(gameDir);
if (game.files > GAME_MAX_FILES) {
  refuse(`game/ holds ${game.files} files, over the ${GAME_MAX_FILES}-file cap.`);
}
if (game.bytes > GAME_MAX_BYTES) {
  refuse(`game/ holds ${game.bytes} bytes, over the ${GAME_MAX_BYTES}-byte cap.`);
}

// Everything checks out: copy and write the dossier.
mkdirSync(join(out, 'game'), { recursive: true });
cpSync(gameDir, join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
cpSync(shotsDir, join(out, 'screenshots'), { recursive: true });

const dossier = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: { max: SHOT_MAX, max_bytes: SHOT_MAX_BYTES },
  game_max_files: GAME_MAX_FILES,
  game_max_bytes: GAME_MAX_BYTES,
});
const dossierPath = join(out, 'dossier.json');
writeFileSync(dossierPath, dossier);

console.log(
  `handed in ${game.files} game files (${(game.bytes / 1024).toFixed(0)} KiB) ` +
    `and ${shotNames.length} screenshots (${shotNames.join(', ')}) to ${out}`,
);
console.log(`dossier.json: ${statSync(dossierPath).size} bytes`);
