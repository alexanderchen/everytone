import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9294;
const PROFILE_DIR = path.join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'brain',
  'f2b71b43-15a7-43c7-9e5e-0c2f8e2a9377',
  'scratch',
  'chrome-shot-profile'
);
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDebuggerUrl(port, timeoutMs = 8000) {
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

    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evalJs(
        `Boolean(document.querySelectorAll('#pianoKeyboard .key-cell').length === 80)`
      );
      if (ready) break;
      await sleep(150);
    }
    await sleep(300);

    // Screenshot 05: Stagger 3 tonal notes (D4, F#4, G4) on the larger 3-slot stage,
    // temporarily toggle a 2nd candidate ON on G4 (MIDI 67) to illustrate multi-candidate ON/OFF randomization,
    // capture, and then restore G4 back to single ON!
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', bubbles: true }))`);
    await sleep(300);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true }))`);
    await sleep(260);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(200);

    const toggledOffBtnExists = await cdp.evalJs(`(() => {
      const offBtn = document.querySelector('#candidatesGrid .toggle-on-btn.is-off');
      if (offBtn) { offBtn.click(); return true; }
      return false;
    })()`);
    await sleep(320);

    await cdp.savePng(path.join(SCREENSHOTS_DIR, '05_minimal-note-bars-and-on-off-candidates.png'));

    // Restore that second candidate back to OFF so saved state remains pristine
    if (toggledOffBtnExists) {
      await cdp.evalJs(`(() => {
        const onBtns = document.querySelectorAll('#candidatesGrid .toggle-on-btn.is-on');
        if (onBtns.length >= 2) onBtns[1].click();
      })()`);
      await sleep(250);
    }

    await cdp.evalJs(`(() => {
      for (const code of ['KeyS', 'KeyT', 'KeyG']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(750);

    // Screenshot 06: Shift QWERTY down 3 octaves to C1 (MIDI 24) Percussion Octave,
    // trigger F1 (Warm Wood Log -> KeyF), C#1 (Puffball 2 -> KeyW), and C1 (Puffball 1 -> KeyA) last so C1 is selected!
    for (let k = 0; k < 3; k++) {
      await cdp.evalJs(`document.getElementById('octDownBtn')?.click()`);
      await sleep(60);
    }
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true }))`);
    await sleep(220);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }))`);
    await sleep(220);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(280);

    await cdp.savePng(path.join(SCREENSHOTS_DIR, '06_low-percussion-octave-puffball-kicks.png'));

    await cdp.evalJs(`(() => {
      for (const code of ['KeyF', 'KeyW', 'KeyA']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
