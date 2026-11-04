import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const TODAY_FOLDER = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots', TODAY_FOLDER);
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9295;
const PROFILE_DIR = path.join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'brain',
  '4965288b-1305-43e9-aaca-8a123f443bb8',
  'scratch',
  'chrome-shot-profile'
);
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDebuggerUrl(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint');
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Runtime.evaluate error');
    }
    return res.result?.value;
  }

  async savePng(filePath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    console.log(`Saved ${path.relative(ROOT, filePath)}`);
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function main() {
  const chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--window-size=1600,1200',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=metal',
      '--no-first-run',
      '--no-default-browser-check',
      'http://localhost:3456'
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    const wsUrl = await waitForDebuggerUrl(PORT);
    cdp = new CDPClient(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Wait for keyboard & WebGL stage atlas to finish loading
    for (let i = 0; i < 50; i++) {
      const ready = await cdp.evalJs(
        `Boolean(document.querySelectorAll('#pianoKeyboard .key-cell').length === 80)`
      );
      if (ready) break;
      await sleep(150);
    }
    await sleep(600);

    // ------------------------------------------------------------------------
    // Shot 07 (Salvaged pre-WebGL milestone):
    // Pure black stage + 3 active clips + instant-pop note-tinted spectrograms with f0 stripes + enlarged chromatic dots
    // ------------------------------------------------------------------------
    await cdp.evalJs(`(() => {
      const bg = document.getElementById('webglStageBg');
      if (bg) bg.style.visibility = 'hidden';
    })()`);
    await sleep(120);

    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(240);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }))`);
    await sleep(240);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(340);

    await cdp.savePng(path.join(SCREENSHOTS_DIR, '07_pure-chromatic-dots-and-f0-spectrograms.png'));

    // ------------------------------------------------------------------------
    // Shot 08 (Salvaged pre-WebGL milestone):
    // Full-width bottom UX panel expanded via lower-right Material gear (left-aligned sample strip + MIDI transport)
    // ------------------------------------------------------------------------
    await cdp.evalJs(`document.getElementById('sampleDrawerToggleBtn')?.click()`);
    await sleep(380);
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '08_collapsible-bottom-drawer-and-midi-transport.png'));

    // Close bottom drawer and release held keys
    await cdp.evalJs(`document.getElementById('sampleDrawerToggleBtn')?.click()`);
    await cdp.evalJs(`(() => {
      for (const code of ['KeyA', 'KeyD', 'KeyG']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(850);

    // ------------------------------------------------------------------------
    // Shot 09 (Current idle state):
    // Compact, dim monochrome WebGL mosaic of all 439 Tier-1 clips floating above the lowered chromatic dot strip
    // ------------------------------------------------------------------------
    await cdp.evalJs(`(() => {
      const bg = document.getElementById('webglStageBg');
      if (bg) bg.style.visibility = 'visible';
      window.dispatchEvent(new Event('resize'));
    })()`);
    await sleep(400);
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '09_floating-webgl-mosaic-idle.png'));

    // ------------------------------------------------------------------------
    // Shot 10 (Current active state):
    // 1 clip playing in Slot 0 (95% foreground opacity) while Slots 1-2 stay clear,
    // revealing the uncovered WebGL mosaic on the right with the active clip glowing in color
    // ------------------------------------------------------------------------
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true }))`);
    await sleep(360);

    await cdp.savePng(path.join(SCREENSHOTS_DIR, '10_webgl-mosaic-playing-and-overlay.png'));

    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', key: 'f', bubbles: true }))`);
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
