import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9294;
const PROFILE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'f2b71b43-15a7-43c7-9e5e-0c2f8e2a9377', 'scratch', 'chrome-shot-profile');
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
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--name');
  const singleShotName = nameIdx >= 0 ? args[nameIdx + 1] : null;

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

    // Wait for catalog & piano keyboard to finish rendering
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evalJs(
        `Boolean(document.querySelectorAll('#pianoKeyboard .key-cell').length >= 60)`
      );
      if (ready) break;
      await sleep(150);
    }
    await sleep(300);

    if (singleShotName) {
      // Trigger 3 active notes so the stage is populated, then capture
      await cdp.evalJs(`(() => {
        const codes = ['KeyS', 'KeyT', 'KeyH'];
        for (const code of codes) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code, key: 'a', bubbles: true }));
        }
      })()`);
      await sleep(550);
      const outFile = singleShotName.endsWith('.png') ? singleShotName : `${singleShotName}.png`;
      await cdp.savePng(path.join(SCREENSHOTS_DIR, outFile));
      return;
    }

    // Baseline Capture 1: 3-Slot Stage + Taller Mini Spectrograms + Right-Side Inspector
    await cdp.evalJs(`(() => {
      const codes = ['KeyS', 'KeyT', 'KeyH']; // D4, F#4, A4 triad
      for (const code of codes) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(600);
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '01_three-slot-stage-and-spectrograms.png'));

    // Release held notes
    await cdp.evalJs(`(() => {
      const codes = ['KeyS', 'KeyT', 'KeyH'];
      for (const code of codes) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(250);

    // Baseline Capture 2: Focused Visual "Trim Clip In / Out" Handle Modal
    await cdp.evalJs(`(() => {
      document.getElementById('inspectActiveSliceBtn')?.click();
    })()`);
    await sleep(800);
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '02_trim-clip-in-out-modal.png'));
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
