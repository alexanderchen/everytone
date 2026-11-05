import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const TODAY_FOLDER = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots', TODAY_FOLDER);
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9297;
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

async function waitForDebuggerUrl(port, timeoutMs = 4500) {
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
    this.consoleErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      }
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

async function waitForAppReady(cdp) {
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.evalJs(
      `Boolean(
        document.querySelectorAll('#pianoKeyboard .wf-key').length >= 36 &&
        document.querySelectorAll('#explorerList .explorer-video-row').length >= 40
      )`
    );
    if (ready) break;
    await sleep(150);
  }
  await sleep(650);
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

    await waitForAppReady(cdp);
    await cdp.evalJs(`window.localStorage.removeItem('everytone_prefs_v2')`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForAppReady(cdp);

    // 1. Audit all 4 grid modes (3x1, 2x2, 3x2, 3x3) for flush width & zero overlap
    for (const mode of ['3x1', '2x2', '3x2', '3x3']) {
      const modeAudit = await cdp.evalJs(`(() => {
        document.querySelector('.stage-grid-pill[data-grid-mode="${mode}"]')?.click();
        const stripRect = document.getElementById('polyVideoGrid').getBoundingClientRect();
        const visibleSlots = Array.from(document.querySelectorAll('#polyVideoGrid .stage-slot-unit:not(.hidden)')).length;
        const tileSize = parseFloat(getComputedStyle(document.getElementById('videoStage')).getPropertyValue('--tile-size'));
        const stripWidthVar = parseFloat(getComputedStyle(document.getElementById('videoStage')).getPropertyValue('--strip-width'));
        return {
          mode: '${mode}',
          visibleSlots,
          tileSize,
          stripWidthPx: Math.round(stripRect.width),
          stripWidthVar: Math.round(stripWidthVar),
          stripHeightPx: Math.round(stripRect.height)
        };
      })()`);
      console.log('Grid Mode Audit:', modeAudit);
    }

    // 2. Test MIDI Octave Transpose (+1 oct) & Fade Slider (0.6s) & 3x2 Grid + Percussion Grayish Trigger
    await cdp.evalJs(`(() => {
      document.querySelector('.stage-grid-pill[data-grid-mode="3x2"]')?.click();
      const fadeSlider = document.getElementById('stageFadeSlider');
      fadeSlider.value = '0.6';
      fadeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      fadeSlider.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('midiOctUpBtn')?.click();
      // Shift keyboard down 1 octave to C1–B6 so we can trigger C1 (percussion!) + 5 tonal notes!
      document.getElementById('octDownBtn')?.click();
    })()`);
    await sleep(200);

    // Trigger 6 notes simultaneously: C1 (MIDI 24 percussion!) + C4, E4, G4, A4, C5
    for (const midi of [24, 60, 64, 67, 69, 72]) {
      await cdp.evalJs(`(() => {
        const keyEl = document.querySelector('#pianoKeyboard .wf-key[data-midi="${midi}"]');
        const r = keyEl.getBoundingClientRect();
        keyEl.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: r.left + 4, clientY: r.bottom - 6, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      })()`);
      await sleep(75);
    }
    // Hold 6 keys via QWERTY + percussion mousedown so all 6 slots stay bright for screenshot
    await cdp.evalJs(`(() => {
      // Shift back to C2–B7 for clean tonal range, then hold 5 QWERTY keys + click C1 after shifting or hold via keyboard
    })()`);
    for (const code of ['KeyA', 'KeyD', 'KeyG', 'KeyH', 'KeyK']) {
      await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: 'a', bubbles: true }))`);
      await sleep(70);
    }
    // Also hold C1 percussion key (MIDI 24 is visible because we shifted down to C1–B6!)
    await cdp.evalJs(`(() => {
      const percKey = document.querySelector('#pianoKeyboard .wf-key[data-midi="24"]');
      if (percKey) {
        const r = percKey.getBoundingClientRect();
        percKey.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: r.left + 5, clientY: r.bottom - 6, bubbles: true }));
      }
    })()`);
    await sleep(380);

    const shot1Audit = await cdp.evalJs(`(() => ({
      midiOctText: document.getElementById('midiOctReadout')?.textContent?.trim(),
      fadeText: document.getElementById('stageFadeReadout')?.textContent?.trim(),
      occupiedSlots: document.querySelectorAll('#polyVideoGrid .stage-slot-unit.is-occupied').length,
      octRange: document.getElementById('octaveRangeLabel')?.textContent?.trim()
    }))()`);
    console.log('Shot 1 Audit (3x2 + Perc Gray + MIDI +1 oct + Fade 0.6s):', shot1Audit);

    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '01_stage-config-3x2-grid-midi-transpose-and-perc-gray.png')
    );

    // Release held voices
    await cdp.evalJs(`(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      for (const code of ['KeyA', 'KeyD', 'KeyG', 'KeyH', 'KeyK']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(700);

    // 3. Test 2x2 Grid + Clicking a Micro-Thumbnail Tile + 4-Way Arrow Key Cursor Navigation!
    await cdp.evalJs(`(() => {
      document.getElementById('octUpBtn')?.click(); // Back to C2–B7
      document.querySelector('.stage-grid-pill[data-grid-mode="2x2"]')?.click();
    })()`);
    await sleep(250);

    // Click inside the micro-thumbnail strip to select a tile, then press ArrowRight, ArrowRight, ArrowDown!
    const tileNavAudit = await cdp.evalJs(`(() => {
      const canvas = document.getElementById('threeStageCanvas');
      const stageRect = canvas.getBoundingClientRect();
      const polyRect = document.getElementById('polyVideoGrid').getBoundingClientRect();
      // Click ~24px below the bottom of #polyVideoGrid near horizontal center-left to hit a tile
      const clickX = Math.round(polyRect.left + 40);
      const clickY = Math.round(polyRect.bottom + 24);
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: clickX, clientY: clickY, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: clickX, clientY: clickY, bubbles: true }));
      const selectedKeysAfterTileClick = document.querySelectorAll('#pianoKeyboard .wf-key.selected-key').length;
      const noteBeforeArrows = document.getElementById('selectedNoteLabel')?.textContent?.trim();
      return { clickX, clickY, selectedKeysAfterTileClick, noteBeforeArrows };
    })()`);
    console.log('Tile Click Focus Audit:', tileNavAudit);
    if (tileNavAudit.selectedKeysAfterTileClick !== 0) {
      throw new Error('Expected keyboard .selected-key to clear when a video tile is selected');
    }

    await sleep(120);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))`);
    await sleep(120);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }))`);
    await sleep(120);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))`);
    await sleep(260);

    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '02_stage-2x2-and-tile-cursor-selection.png')
    );

    // Verify clicking a piano key switches select state cleanly back to 'keyboard'
    const backToKbCheck = await cdp.evalJs(`(() => {
      const c4 = document.querySelector('#pianoKeyboard .wf-key[data-midi="60"]');
      const r = c4.getBoundingClientRect();
      c4.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: r.left + 5, clientY: r.bottom - 8, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      return document.querySelectorAll('#pianoKeyboard .wf-key.selected-key').length;
    })()`);
    console.log('Keyboard Focus Restored Check:', backToKbCheck);
    if (backToKbCheck !== 1) {
      throw new Error('Expected 1 .selected-key on keyboard after clicking C4');
    }
    await sleep(300);

    // 4. Test 3x3 Grid + 1.0s Maximum Fade-Out with 9 Populated Slots!
    await cdp.evalJs(`(() => {
      document.querySelector('.stage-grid-pill[data-grid-mode="3x3"]')?.click();
      const fadeSlider = document.getElementById('stageFadeSlider');
      fadeSlider.value = '1.0';
      fadeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      fadeSlider.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(220);

    for (const code of ['KeyA', 'KeyW', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK']) {
      await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: 'a', bubbles: true }))`);
      await sleep(55);
    }
    await sleep(350);

    const shot3Audit = await cdp.evalJs(`(() => ({
      occupiedSlots: document.querySelectorAll('#polyVideoGrid .stage-slot-unit.is-occupied').length,
      fadeText: document.getElementById('stageFadeReadout')?.textContent?.trim()
    }))()`);
    console.log('Shot 3 Audit (3x3 Nine Slots + 1.0s Fade):', shot3Audit);

    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '03_stage-3x3-nine-tiles-with-long-fade.png')
    );

    if (cdp.consoleErrors.length > 0) {
      throw new Error(`Console exceptions thrown: ${cdp.consoleErrors.join('; ')}`);
    }
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
