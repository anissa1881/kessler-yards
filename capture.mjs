// Capture the game's three screenshots, then check them against the competition's rules.
//
//   node capture.mjs            # uses a Chrome already installed on this machine
//   node capture.mjs --install  # first run: let Playwright fetch its own Chromium
//
// It serves game/ on a free port, opens ?shot=start, ?shot=play and ?shot=end, waits for the
// game to report the frame is painted (window.__shotReady), and writes screenshots/1-start.jpg,
// 2-play.jpg and 3-end.jpg. Then it checks every rule the gate applies to a screenshot: a whole
// JPEG, at most 256 KiB, long side at most 1280, short side at least 480.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(join(here, 'game'));
const OUT = resolve(join(here, 'screenshots'));

const WIDTH = 1280;
const HEIGHT = 720;

const FRAMES = [
  { name: '1-start.jpg', shot: 'start' },
  { name: '2-play.jpg', shot: 'play' },
  { name: '3-end.jpg', shot: 'end' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Serve game/ only, refusing any path that escapes it. */
function serve() {
  const server = createServer((req, res) => {
    let path = new URL(req.url ?? '/', 'http://entry').pathname;
    if (path === '/') path = '/index.html';
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready(server));
  });
}

/** Load playwright, or install it on the first run when --install is given. */
async function loadPlaywright(wantInstall) {
  try {
    return await import('playwright');
  } catch {
    if (!wantInstall) {
      console.error('playwright is not installed. Run:  npm i playwright  (then: node capture.mjs --install)');
      process.exit(1);
    }
  }
  // On Windows npm and npx are .cmd shims, which spawn only finds through a shell.
  const run = (command, args) =>
    new Promise((done, fail) => {
      const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}`))));
    });
  console.log('installing playwright...');
  await run('npm', ['i', '--no-audit', '--no-fund', 'playwright']);
  console.log('fetching a chromium build...');
  await run('npx', ['playwright', 'install', 'chromium']);
  return import('playwright');
}

/** Read a JPEG's frame size from its start-of-frame marker. */
function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame size
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

const { chromium } = await loadPlaywright(process.argv.includes('--install'));
mkdirSync(OUT, { recursive: true });

const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

// A page error means the game is broken, and a screenshot of a broken game is worthless.
const problems = [];
page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console error: ${msg.text().slice(0, 200)}`);
});

for (const frame of FRAMES) {
  await page.goto(`${base}/?shot=${frame.shot}&seed=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__shotReady === true', { timeout: 30_000 });
  // one more painted frame, so the buffer holds the frozen scene rather than a part-drawn one
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // A real render of the scene is never one flat colour: sample the canvas and count how many
  // distinct shades it holds. A blank WebGL surface (or a page that never drew) fails here,
  // which is far cheaper to notice now than at the judge.
  const spread = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return { error: 'no canvas' };
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl' };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height) return { error: 'empty drawing buffer' };
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const shades = new Set();
    const step = Math.max(4, Math.floor((width * height) / 4000)) * 4;
    for (let i = 0; i < pixels.length; i += step) {
      shades.add((pixels[i] >> 3) << 10 | (pixels[i + 1] >> 3) << 5 | pixels[i + 2] >> 3);
      if (shades.size > 40) break;
    }
    return { shades: shades.size };
  });
  if (spread.error || spread.shades < 8) {
    console.error(`\n${frame.name}: the 3D canvas is blank (${spread.error ?? spread.shades + ' shades'}).`);
    console.error('The HUD draws but WebGL is not rasterising. Use a machine with a real GPU driver,');
    console.error('or run Chrome directly with "node serve.ts" and take the shots by hand.');
    await browser.close();
    server.close();
    process.exit(3);
  }
  await page.screenshot({ path: join(OUT, frame.name), type: 'jpeg', quality: 90 });
  console.log(`captured ${frame.name}  (${spread.shades} shades)`);
}

await browser.close();
server.close();

if (problems.length) {
  console.error('\nThe game reported problems while capturing:');
  for (const line of problems.slice(0, 8)) console.error(`  ${line}`);
  console.error('Fix those first: a screenshot of a page that threw is not a render of the game.');
  process.exit(2);
}

// Verify every screenshot against the rules the gate applies.
let failed = 0;
for (const frame of FRAMES) {
  const path = join(OUT, frame.name);
  const bytes = statSync(path).size;
  const size = jpegSize(readFileSync(path));
  const checks = [];
  if (!size) checks.push('not a whole JPEG');
  if (bytes > 262_144) checks.push(`${bytes} bytes, over 256 KiB`);
  if (size) {
    const long = Math.max(size.width, size.height);
    const short = Math.min(size.width, size.height);
    if (long > 1280) checks.push(`long side ${long}, over 1280`);
    if (short < 480) checks.push(`short side ${short}, under 480`);
  }
  if (checks.length) {
    failed += 1;
    console.log(`FAIL ${frame.name}: ${checks.join('; ')}`);
  } else {
    console.log(`ok   ${frame.name}  ${size.width}x${size.height}  ${(bytes / 1024).toFixed(0)} KiB`);
  }
}

writeFileSync(join(OUT, '.done'), `${new Date().toISOString()}\n`);
console.log(failed ? `\n${failed} screenshot(s) need fixing.` : '\nAll three screenshots pass the gate\'s rules.');
process.exit(failed ? 1 : 0);
