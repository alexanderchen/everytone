import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const TODAY_FOLDER = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots', TODAY_FOLDER);
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9296;
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

    // Check default boot state BEFORE interacting
    const bootAudit = await cdp.evalJs(`(() => {
      const drawer = document.getElementById('noteSamplesDrawer');
      const keys = document.querySelectorAll('#pianoKeyboard .wf-key');
      const octLabel = document.getElementById('octaveRangeLabel')?.textContent?.trim();
      const selNote = document.getElementById('selectedNoteLabel')?.textContent?.trim();
      const c4Key = document.querySelector('#pianoKeyboard .wf-key[data-midi="60"]');
      return {
        drawerCollapsedByDefault: drawer?.classList.contains('collapsed'),
        totalKeysVisible: keys.length,
        visibleOctaves: keys.length / 12,
        octLabel,
        selNote,
        c4IsSelected: c4Key?.classList.contains('selected-key'),
        explorerGroupRows: document.querySelectorAll('#explorerList .explorer-video-row').length
      };
    })()`);
    console.log('Default Boot Audit:', bootAudit);

    if (!bootAudit.drawerCollapsedByDefault) {
      throw new Error('Expected note sample drawer to be collapsed by default on page load');
    }
    if (bootAudit.visibleOctaves < 5) {
      throw new Error(`Expected responsive 5-6 octaves on 1600px desktop, got ${bootAudit.visibleOctaves}`);
    }

    // Expand 'winds' to reveal grouped readable names ("purple bottle", "blue bottle", etc.)
    await cdp.evalJs(`(() => {
      const windsHeader = document.querySelector('#explorerList .explorer-cat-group[data-category="winds"] .explorer-cat-header');
      windsHeader?.click();
    })()`);
    await sleep(220);

    // Play G4, E4, then C4 last so C4 is the active selected note ("C4" on left button + 2px white keyline)
    // and 3 tiles in the compact B&W grid show crisp 2px chromatic outer stroke borders!
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true }))`);
    await sleep(130);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }))`);
    await sleep(130);
    await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))`);
    await sleep(380);

    const activeAudit = await cdp.evalJs(`(() => {
      const stageRect = document.getElementById('videoStage').getBoundingClientRect();
      const polyRect = document.getElementById('polyVideoGrid').getBoundingClientRect();
      const vidRect = document.querySelector('.stage-slot-unit[data-slot="0"] .stage-slot-video').getBoundingClientRect();
      const specRect = document.querySelector('.stage-slot-unit[data-slot="0"] .slot-mini-spec').getBoundingClientRect();
      const windsLabels = Array.from(
        document.querySelectorAll('#explorerList .explorer-cat-group[data-category="winds"] .explorer-video-label')
      ).map(el => el.textContent.trim());
      const dockRect = document.getElementById('transportDock').getBoundingClientRect();
      const octRailRect = document.getElementById('octaveRailZone').getBoundingClientRect();
      const selZoneRect = document.getElementById('selectedNoteZone').getBoundingClientRect();
      return {
        stageHeight: Math.round(stageRect.height),
        polyTopInStage: Math.round(polyRect.top - stageRect.top),
        polyBottomInStage: Math.round(polyRect.bottom - stageRect.top),
        videoSidePx: Math.round(vidRect.height),
        specHeightPx: Math.round(specRect.height),
        videoToSpecGapPx: Math.round(specRect.top - vidRect.bottom),
        dockHeightCollapsed: Math.round(dockRect.height),
        selectedNoteLeftPx: Math.round(selZoneRect.left),
        octaveRailRightPx: Math.round(octRailRect.right),
        windsLabels
      };
    })()`);
    console.log('Active Stage & Grouped Winds Audit:', activeAudit);

    if (!activeAudit.windsLabels.includes('purple bottle')) {
      throw new Error(`Expected 'purple bottle' in grouped winds list, got: ${activeAudit.windsLabels.join(', ')}`);
    }

    // ------------------------------------------------------------------------
    // Shot 19: Grouped File Explorer + Centered Large 3-Up Stage + Compact 1px B&W Tiles w/ Outer Note Stroke + Collapsed Sample Drawer + 6-Octave Keyboard
    // ------------------------------------------------------------------------
    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '19_grouped-sidebar-centered-stage-and-6octave-dock.png')
    );

    // Release keys cleanly
    await cdp.evalJs(`(() => {
      for (const code of ['KeyG', 'KeyD', 'KeyA']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: 'a', bubbles: true }));
      }
    })()`);
    await sleep(340);

    // Click the [C4 ✎] pencil button on the left of the keyboard to expand the per-note sample drawer
    const drawerExpandCheck = await cdp.evalJs(`(() => {
      document.getElementById('noteSamplesToggleBtn')?.click();
      const drawer = document.getElementById('noteSamplesDrawer');
      return {
        expanded: !drawer.classList.contains('collapsed'),
        cardCount: document.querySelectorAll('#candidatesGrid .candidate-card').length,
        cardTitles: Array.from(document.querySelectorAll('#candidatesGrid .cand-slug-title')).map(el => el.textContent.trim())
      };
    })()`);
    console.log('Expanded Per-Note Drawer Check:', drawerExpandCheck);
    if (!drawerExpandCheck.expanded || drawerExpandCheck.cardCount === 0) {
      throw new Error('Clicking #noteSamplesToggleBtn did not expand per-note sample drawer');
    }
    await sleep(260);

    // ------------------------------------------------------------------------
    // Shot 20: Expanded Per-Note Sample Drawer Above 6-Octave Keyboard via [C4 ✎] Toggle
    // ------------------------------------------------------------------------
    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '20_expanded-note-sample-drawer-above-6octave-keyboard.png')
    );

    // Collapse the per-note sample drawer again via the Hide button, then click "purple bottle" in the sidebar!
    await cdp.evalJs(`document.getElementById('collapseNoteSamplesBtn')?.click()`);
    await sleep(200);

    const groupInspectorCheck = await cdp.evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('#explorerList .explorer-video-row'))
        .find(r => r.querySelector('.explorer-video-label')?.textContent.trim() === 'purple bottle');
      row?.click();
      const modalOpen = !document.getElementById('videoInspectorModal').classList.contains('hidden');
      const groupInputVal = document.getElementById('videoInspGroupInput')?.value;
      const badge = document.getElementById('videoInspBadge')?.textContent?.trim();
      const metaPill = document.getElementById('videoInspMetaPill')?.textContent?.trim();
      const videoSlugs = Array.from(
        document.querySelectorAll('#videoInspVideosScroll .group-video-card .inspector-slug-input')
      ).map(inp => inp.value);
      return { modalOpen, badge, groupInputVal, metaPill, cardCount: videoSlugs.length, videoSlugs };
    })()`);
    console.log('Purple Bottle Group Inspector Check:', groupInspectorCheck);

    if (!groupInspectorCheck.modalOpen || groupInspectorCheck.cardCount !== 4) {
      throw new Error(
        `Expected 4 video cards in 'purple bottle' group inspector, got ${groupInspectorCheck.cardCount}`
      );
    }
    await sleep(420);

    // ------------------------------------------------------------------------
    // Shot 21: Single Scrolling Multi-Video Group Inspector for "purple bottle" (All 4 Videos + Editable Group Name)
    // ------------------------------------------------------------------------
    await cdp.savePng(
      path.join(SCREENSHOTS_DIR, '21_purple-bottle-multi-video-scrolling-group-inspector.png')
    );

    // Test responsive octave scaling on a narrower viewport (e.g. 1120px -> 4 or 5 octaves) and restore!
    await cdp.evalJs(`document.querySelector('[data-close="videoInspectorModal"]')?.click()`);
    await sleep(150);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1120,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(300);
    const narrowCheck = await cdp.evalJs(`(() => {
      const keys = document.querySelectorAll('#pianoKeyboard .wf-key').length;
      return { keys, octaves: keys / 12, range: document.getElementById('octaveRangeLabel')?.textContent?.trim() };
    })()`);
    console.log('Responsive Narrow Viewport Check (1120px):', narrowCheck);

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
