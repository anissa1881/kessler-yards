// Report what this machine's browser can actually do with WebGL, so a blank capture can be
// diagnosed instead of guessed at.
//
//   node cek-webgl.mjs
//
// It prints the renderer name, whether shaders compile, whether anything rasterises, and
// then tries again with the software renderer enabled.
import { chromium } from 'playwright';

const PROBE = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return { webgl: false };

  const info = {
    webgl: true,
    version: gl.getParameter(gl.VERSION),
    renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR),
  };

  // draw one full-screen triangle of a known colour
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, 'precision highp float; void main(){ gl_FragColor = vec4(0.94,0.65,0.19,1.0); }');
  gl.compileShader(fs);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  info.compiled = gl.getShaderParameter(fs, gl.COMPILE_STATUS) && gl.getProgramParameter(program, gl.LINK_STATUS);

  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const pixel = new Uint8Array(4);
  gl.readPixels(160, 100, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  info.pixel = [...pixel];
  info.drew = pixel[0] > 200;
  info.size = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  return info;
};

async function probe(label, options) {
  let browser;
  try {
    browser = await chromium.launch(options);
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    const result = await page.evaluate(PROBE);
    console.log(`\n${label}`);
    if (!result.webgl) {
      console.log('  WebGL tidak tersedia sama sekali.');
    } else {
      console.log(`  renderer : ${result.renderer}`);
      console.log(`  vendor   : ${result.vendor}`);
      console.log(`  version  : ${result.version}`);
      console.log(`  buffer   : ${result.size ? result.size.join('x') : 'kosong'}`);
      console.log(`  shader   : ${result.compiled ? 'compiled' : 'GAGAL'}`);
      console.log(`  pixel    : ${JSON.stringify(result.pixel)}`);
      console.log(`  hasil    : ${result.drew ? 'MENGGAMBAR (baik)' : 'KOSONG (tidak menggambar)'}`);
    }
    return result;
  } catch (error) {
    console.log(`\n${label}`);
    console.log(`  gagal jalan: ${error.message.slice(0, 120)}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

console.log('Memeriksa kemampuan WebGL browser di mesin ini.');
console.log('Node:', process.version, '| platform:', process.platform);

const plain = await probe('1. Headless biasa', {});
const soft = await probe('2. Headless + software renderer', {
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const headed = await probe('3. Jendela terlihat (headed)', { headless: false });

console.log('\n--- kesimpulan ---');
if (headed?.drew) {
  console.log('Capture perlu dijalankan dengan jendela terlihat: node capture.mjs --headed');
} else if (soft?.drew) {
  console.log('Capture perlu software renderer: node capture.mjs --software');
} else if (plain?.drew) {
  console.log('Headless biasa menggambar. Kalau capture tetap kosong, masalahnya di halaman game.');
} else {
  console.log('Tidak ada mode yang menggambar. Ini lingkungan tanpa akselerasi GPU.');
  console.log('Coba di PC lain, atau instal driver GPU terbaru untuk kartu grafis mesin ini.');
}
