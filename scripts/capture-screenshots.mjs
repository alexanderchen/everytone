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
        document.querySelectorAll('#explorerList .explorer-video-row').length > 100 &&
        document.fonts && document.fonts.status === 'loaded'
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

    // Clear saved storage & reload once to verify pristine fresh-load state
    await cdp.evalJs(`window.localStorage.removeItem('everytone_prefs_v2')`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForAppReady(cdp);

    const freshAudit = await cdp.evalJs(`(() => {
      const catGroups = Array.from(document.querySelectorAll('#explorerList .explorer-cat-group'));
      const collapsedGroups = catGroups.filter(g => g.classList.contains('is-collapsed'));
      return {
        fontFamily: getComputedStyle(document.body).fontFamily,
        explorerBg: getComputedStyle(document.getElementById('fileExplorer')).backgroundColor,
        dockBg: getComputedStyle(document.getElementById('transportDock')).backgroundColor,
        keyBg: getComputedStyle(document.querySelector('#pianoKeyboard .wf-key')).backgroundColor,
        totalCategories: catGroups.length,
        collapsedCategories: collapsedGroups.length,
        hasOldAllNoneBtns: Boolean(document.getElementById('explorerAllBtn') || document.getElementById('explorerNoneBtn')),
        hasNoteLabelInSamples: Boolean(document.getElementById('selectedKeyNoteLabel')),
        keyInnerTextLength: Array.from(document.querySelectorAll('#pianoKeyboard .wf-key')).map(k => k.textContent.trim()).join('').length,
        specBlendMode: getComputedStyle(document.querySelector('.slot-mini-spec')).mixBlendMode
      };
    })()`);
    console.log('Fresh Load Audit:', freshAudit);

    if (freshAudit.collapsedCategories !== freshAudit.totalCategories) {
      throw new Error('Expected ALL categories to start collapsed on page load');
    }
    if (freshAudit.explorerBg !== 'rgb(0, 0, 0)' || freshAudit.dockBg !== 'rgb(0, 0, 0)') {
      throw new Error(`Expected pure black backgrounds, got explorer=${freshAudit.explorerBg}, dock=${freshAudit.dockBg}`);
    }

    // ------------------------------------------------------------------------
    // Shot 13: Space Mono + Pure Black Keyline Layout + All Categories Collapsed + Grid Note Dots
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '13_space-mono-solid-black-and-grid-note-dots.png'));

    // Expand 'winds' category so hand-whistle (-2dB) is clearly visible in explorer,
    // and trigger 3 polyphonic notes (C4 + E4 + G4) to show 100% grayscale screen-blended spectrograms + chromatic f0 bar
    await cdp.evalJs(`(() => {
      const windsGroup = document.querySelector('#explorerList .explorer-cat-group[data-category="winds"] .explorer-cat-header');
      windsGroup?.click();
    })()`);
    await sleep(220);

    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(140);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }))`);
    await sleep(140);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(360);

    // ------------------------------------------------------------------------
    // Shot 14: Floating 100% Gray Screen-Blended Spectrograms + Chromatic f0 Bar + Winds Expanded (hand-whistle)
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '14_floating-gray-screen-spectrograms-and-winds.png'));

    // Release KeyG and verify 0.20s smooth visual fade-out activates immediately
    const fadeOutCheck = await cdp.evalJs(`(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG', key: 'g', bubbles: true }));
      const fadingCount = document.querySelectorAll('.stage-slot-unit.is-fading-out').length;
      return { fadingCount };
    })()`);
    console.log('0.20s Stage Fade-Out Check:', fadeOutCheck);

    // Release remaining keys and wait for 200ms fade-out to finish cleanly
    await cdp.evalJs(`(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }));
    })()`);
    await sleep(320);

    // Verify unified top-left hamburger button collapses & expands BOTH sidebar and bottom transport
    const hamburgerCheck = await cdp.evalJs(`(() => {
      const btn = document.getElementById('chromeToggleBtn');
      btn.click();
      const bothCollapsed =
        document.getElementById('fileExplorer').classList.contains('collapsed') &&
        document.getElementById('transportDock').classList.contains('collapsed');
      btn.click();
      const bothExpanded =
        !document.getElementById('fileExplorer').classList.contains('collapsed') &&
        !document.getElementById('transportDock').classList.contains('collapsed');
      return { bothCollapsed, bothExpanded };
    })()`);
    console.log('Unified Hamburger Toggle Check:', hamburgerCheck);
    if (!hamburgerCheck.bothCollapsed || !hamburgerCheck.bothExpanded) {
      throw new Error('Unified hamburger toggle failed to collapse/expand both panels');
    }
    await sleep(260);

    // Open Video File Inspector on 'hand-whistle' (in winds)
    await cdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#explorerList .explorer-video-row'));
      const hw = rows.find(r => r.querySelector('.explorer-video-label')?.textContent.trim() === 'hand-whistle');
      hw?.querySelector('.explorer-inspect-btn')?.click();
    })()`);
    await sleep(550);

    const videoInspCheck = await cdp.evalJs(`({
      open: !document.getElementById('videoInspectorModal').classList.contains('hidden'),
      slug: document.getElementById('videoInspSlugInput')?.value,
      gainReadout: document.getElementById('videoGainReadout')?.textContent,
      sliceRows: document.querySelectorAll('#videoInspSlicesList .video-slice-row').length
    })`);
    console.log('Video File Inspector Check:', videoInspCheck);

    // ------------------------------------------------------------------------
    // Shot 15: Video File Inspector (Holistic Volume dB + Extracted Samples List on hand-whistle)
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '15_video-file-inspector-holistic-volume.png'));

    // Drill down from Video File Inspector -> Sample #1 Inspector and verify cookie-crumb + ±100c clamp
    await cdp.evalJs(`(() => {
      document.querySelector('#videoInspSlicesList .video-slice-open-btn')?.click();
    })()`);
    await sleep(600);

    const sampleInspCheck = await cdp.evalJs(`({
      open: !document.getElementById('trimModal').classList.contains('hidden'),
      parentCrumb: document.getElementById('sampleInspParentBtn')?.textContent?.trim(),
      sliceCrumb: document.getElementById('sampleInspSliceLabel')?.textContent?.trim(),
      tuneMin: document.getElementById('inspectorTuneSlider')?.min,
      tuneMax: document.getElementById('inspectorTuneSlider')?.max
    })`);
    console.log('Sample Inspector Breadcrumb & ±1 Semitone Clamp Check:', sampleInspCheck);
    if (sampleInspCheck.tuneMin !== '-100' || sampleInspCheck.tuneMax !== '100') {
      throw new Error(`Expected ±100 cents slider limits, got ${sampleInspCheck.tuneMin}..${sampleInspCheck.tuneMax}`);
    }

    // ------------------------------------------------------------------------
    // Shot 16: Individual Sample Inspector (Cookie-Crumb Header + ±1 Semitone Max Slider + Cropped/Mel Spectrogram)
    // ------------------------------------------------------------------------
    await cdp.savePng(path.join(SCREENSHOTS_DIR, '16_sample-inspector-breadcrumb-and-1st-clamp.png'));

    // Close modal cleanly
    await cdp.evalJs(`document.querySelector('[data-close="trimModal"]')?.click()`);
    await sleep(200);

    if (cdp.consoleErrors.length > 0) {
      throw new Error(`Console errors detected: ${JSON.stringify(cdp.consoleErrors)}`);
    } else {
      console.log('Zero uncaught runtime exceptions across all interactions!');
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
