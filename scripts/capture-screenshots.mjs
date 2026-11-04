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
        document.querySelectorAll('#pianoKeyboard .wf-key').length === 36 &&
        document.querySelectorAll('#explorerList .explorer-video-row').length > 100
      )`
    );
    if (ready) break;
    await sleep(150);
  }
  await sleep(600);
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

    // Expand 'winds' so video rows + switches are visible, and trigger 3 polyphonic notes (C4 + E4 + G4)
    // including an accidental (F#4 via KeyT) to check solid color fill with zero glow!
    await cdp.evalJs(`(() => {
      const windsHeader = document.querySelector('#explorerList .explorer-cat-group[data-category="winds"] .explorer-cat-header');
      windsHeader?.click();
    })()`);
    await sleep(220);

    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(140);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't', bubbles: true }))`);
    await sleep(140);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(360);

    const layoutAudit = await cdp.evalJs(`(() => {
      const stripRect = document.getElementById('polyVideoGrid').getBoundingClientRect();
      const vidRect = document.querySelector('.stage-slot-unit[data-slot="0"] .stage-slot-video').getBoundingClientRect();
      const specRect = document.querySelector('.stage-slot-unit[data-slot="0"] .slot-mini-spec').getBoundingClientRect();
      const activeKey = document.querySelector('#pianoKeyboard .wf-key.active-play');
      const c5Key = document.querySelector('#pianoKeyboard .wf-key[data-midi="72"]');
      const b4Key = document.querySelector('#pianoKeyboard .wf-key[data-midi="71"]');
      return {
        fontFamily: getComputedStyle(document.body).fontFamily,
        hasExplorerTitle: Boolean(document.querySelector('.explorer-title')),
        sampleCardSwitches: document.querySelectorAll('#candidatesGrid .candidate-card .ui-switch').length,
        settingsIconsCount: document.querySelectorAll('.explorer-inspect-btn, .cand-inspect-btn').length,
        stripWidth: Math.round(stripRect.width),
        stripBottom: Math.round(stripRect.bottom),
        videoToSpecGapPx: Math.round(specRect.top - vidRect.bottom),
        videoSidePx: Math.round(vidRect.height),
        specHeightPx: Math.round(specRect.height),
        activeKeyBoxShadow: activeKey ? getComputedStyle(activeKey).boxShadow : null,
        b4RightBorder: getComputedStyle(b4Key).borderRightWidth,
        c5LeftBorder: getComputedStyle(c5Key).borderLeftWidth,
        seamGapB4ToC5: Math.round(c5Key.getBoundingClientRect().left - b4Key.getBoundingClientRect().right)
      };
    })()`);
    console.log('Layout & UX Audit:', layoutAudit);

    if (layoutAudit.settingsIconsCount !== 0) {
      throw new Error('Expected zero settings icons');
    }
    if (layoutAudit.videoToSpecGapPx !== 0) {
      throw new Error(`Expected flush 0px gap between video and spectrogram, got ${layoutAudit.videoToSpecGapPx}`);
    }
    if (layoutAudit.activeKeyBoxShadow !== 'none') {
      throw new Error(`Expected zero box-shadow glow on active keys, got ${layoutAudit.activeKeyBoxShadow}`);
    }
    if (layoutAudit.b4RightBorder !== '0px' || layoutAudit.c5LeftBorder !== '1px' || layoutAudit.seamGapB4ToC5 !== 0) {
      throw new Error(`Octave seam border mismatch: b4Right=${layoutAudit.b4RightBorder}, c5Left=${layoutAudit.c5LeftBorder}, gap=${layoutAudit.seamGapB4ToC5}`);
    }

    // ------------------------------------------------------------------------
    // Shot 17: 3-Up Videos + Flush Half-Height Spectrograms ABOVE Wide Full-Width Dot Grid + Unified Switches + No Key Glow
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '17_sans-stacked-stage-flush-specs-and-unified-switches.png'));

    // Release keys cleanly
    await cdp.evalJs(`(() => {
      for (const code of ['KeyA', 'KeyT', 'KeyG']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(340);

    // Verify clicking a video row directly opens Video File Inspector (while clicking its switch mutes/unmutes)
    const videoRowClickCheck = await cdp.evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('#explorerList .explorer-video-row'))
        .find(r => r.querySelector('.explorer-video-label')?.textContent.trim() === 'hand-whistle');
      row?.click();
      return !document.getElementById('videoInspectorModal').classList.contains('hidden');
    })()`);
    console.log('Click Video Row Opens Inspector:', videoRowClickCheck);
    if (!videoRowClickCheck) throw new Error('Clicking video row did not open Video File Inspector');
    await sleep(250);
    await cdp.evalJs(`document.querySelector('[data-close="videoInspectorModal"]')?.click()`);
    await sleep(200);

    // Verify clicking a sample card directly opens Sample Inspector (while clicking its switch toggles ON/OFF)
    const sampleCardClickCheck = await cdp.evalJs(`(() => {
      const card = document.querySelector('#candidatesGrid .candidate-card');
      card?.click();
      return !document.getElementById('trimModal').classList.contains('hidden');
    })()`);
    console.log('Click Sample Card Opens Inspector:', sampleCardClickCheck);
    if (!sampleCardClickCheck) throw new Error('Clicking sample card did not open Sample Inspector');
    await sleep(450);

    // ------------------------------------------------------------------------
    // Shot 18: Clean Google Sans Sample Inspector Opened Directly by Clicking Sample Card
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '18_google-sans-sample-inspector-direct-click.png'));

    await cdp.evalJs(`document.querySelector('[data-close="trimModal"]')?.click()`);
    await sleep(200);

    if (cdp.consoleErrors.length > 0) {
      throw new Error(`Console errors detected: ${JSON.stringify(cdp.consoleErrors)}`);
    } else {
      console.log('Zero uncaught runtime exceptions!');
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
