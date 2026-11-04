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

async function waitForDebuggerUrl(port, timeoutMs = 3500) {
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
        document.querySelectorAll('#pianoKeyboard .wf-key').length === 36 &&
        document.querySelectorAll('#explorerList .explorer-video-row').length > 100
      )`
    );
    if (ready) break;
    await sleep(150);
  }
  await sleep(500);
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

    // Ensure clean starting state (all videos enabled, C4–B6 octave)
    await cdp.evalJs(`(() => {
      document.getElementById('explorerAllBtn')?.click();
    })()`);
    await sleep(350);

    const initialCheck = await cdp.evalJs(`({
      explorerCount: document.getElementById('explorerActiveCount')?.textContent,
      wfKeys: document.querySelectorAll('#pianoKeyboard .wf-key').length,
      midiPlayDisabled: document.getElementById('midiPlayPauseBtn')?.disabled,
      octLabel: document.getElementById('octaveRangeLabel')?.textContent,
      c4Candidates: document.querySelectorAll('#candidatesGrid .candidate-card').length
    })`);
    console.log('Initial UI Check:', initialCheck);

    // ------------------------------------------------------------------------
    // Shot 11: Idle Music-Software UX Overhaul
    // Left Video File Explorer + Three.js 3D Stage + 3-Zone Bottom Transport & Keyline Keyboard
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '11_music-software-layout-idle.png'));

    // Test muting first two rows in Explorer + reload persistence!
    const mutedSlugs = await cdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#explorerList .explorer-video-row')).slice(0, 3);
      const names = rows.map(r => r.querySelector('.explorer-video-label')?.textContent);
      rows.forEach(r => r.click());
      return names;
    })()`);
    await sleep(300);

    // Reload page and confirm muted switches persist across page load
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitForAppReady(cdp);

    const persistedCheck = await cdp.evalJs(`({
      explorerCountAfterReload: document.getElementById('explorerActiveCount')?.textContent,
      mutedRowCountAfterReload: document.querySelectorAll('#explorerList .explorer-video-row.is-muted').length
    })`);
    console.log('Reload Persistence Check (muted 3 videos):', mutedSlugs, persistedCheck);
    if (persistedCheck.mutedRowCountAfterReload !== 3) {
      throw new Error(`Expected 3 muted videos after reload, got ${persistedCheck.mutedRowCountAfterReload}`);
    }

    // ------------------------------------------------------------------------
    // Shot 12: Active Polyphonic Performance + Muted Explorer Switches + Chromatic Keyline Hits
    // Play C4 (KeyA) + D#4 (KeyE) + G4 (KeyG) so 3 foreground 100%-opacity video+spectrogram slots
    // pop on and both natural + accidental wireframe keys light up in their chromatic colors
    // ------------------------------------------------------------------------
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(180);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }))`);
    await sleep(180);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(340);

    await cdp.savePng(path.join(SCREENSHOTS_DIR, '12_explorer-mute-and-keyline-polyphony.png'));

    // Release keys and restore all 129/129 videos enabled so localhost catalog.json stays clean
    await cdp.evalJs(`(() => {
      for (const code of ['KeyA', 'KeyE', 'KeyG']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
      document.getElementById('explorerAllBtn')?.click();
    })()`);
    await sleep(400);

    if (cdp.consoleErrors.length > 0) {
      console.warn('Console errors detected:', cdp.consoleErrors);
    } else {
      console.log('Zero uncaught runtime exceptions.');
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
