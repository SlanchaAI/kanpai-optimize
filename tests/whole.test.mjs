import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { once } from 'node:events';
import { loadavg } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'coverage');
mkdirSync(output, { recursive: true });
const inventory = JSON.parse(readFileSync(resolve(root, 'tests/inventory.json')));
const pages = Object.keys(inventory).filter(p => inventory[p].kind === 'application');
const coverage = new Map();

function audit(files) {
  assert.deepEqual([...files].sort(), Object.keys(inventory).sort(), 'Every file needs an inventory classification');
  for (const [file, item] of Object.entries(inventory)) {
    assert.ok(item.reason, `Missing test mapping or exclusion reason: ${file}`);
    assert.ok(['application', 'test', 'configuration', 'documentation', 'vendor', 'cache'].includes(item.kind));
  }
}

// One fresh profile and browser per scenario. No requests leave loopback.
async function browser() {
  while (loadavg()[0] >= 16) {
    console.log(`Waiting for load <16 (current ${loadavg()[0]})`);
    await new Promise(r => setTimeout(r, 10000));
  }
  const profile = mkdtempSync(resolve(process.env.TMPDIR, 'c-'));
  const child = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
    '--disable-background-networking', '--disable-component-update', '--no-first-run',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', data => { log += data; });
  let ws;
  try {
    const deadline = Date.now() + 20000;
    let port;
    while (!port) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited: ${log}`);
      try { port = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
      if (Date.now() > deadline) throw new Error(`Chrome startup timeout: ${log}`);
      if (!port) await new Promise(r => setTimeout(r, 100));
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const task = pending.get(message.id);
        if (task) {
          pending.delete(message.id);
          clearTimeout(task.timer);
          if (message.error) task.reject(new Error(JSON.stringify(message.error)));
          else task.resolve(message.result);
        }
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    };
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(key, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: key, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['https://*'] });
    await send('Profiler.enable');
    await send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    return { send, evaluate, errors, async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await send('Browser.close'); } catch {}
        await exited;
        clearTimeout(killTimer);
      }
      ws.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
  } catch (error) {
    ws?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

// Test-only observation before actual draw calls; no rendering logic is replaced.
function instrument(html) {
  assert.ok(html.includes('renderer.render(scene, camera);'), 'Rendering observer anchor missing');
  return html.replace('<script type="module">', '<script type="module">\nwindow.observed = { renders: 0 };')
    .replaceAll('renderer.render(scene, camera);',
      '(Object.assign(window.observed, { scene, camera, renderer }), window.observed.renders++, renderer.render(scene, camera));');
}

async function waitFor(b, expression) {
  const deadline = Date.now() + 10000;
  while (!(await b.evaluate(expression))) {
    assert.deepEqual(b.errors, [], "Browser exception while waiting");
    assert.ok(Date.now() < deadline, `Timed out: ${expression}`);
    await new Promise(r => setTimeout(r, 40));
  }
}

async function collect(b, page, source) {
  const report = await b.send('Profiler.takePreciseCoverage');
  for (const script of report.result) {
    if (!script.url.endsWith(`/${page}`)) continue;
    const { scriptSource } = await b.send('Debugger.getScriptSource', { scriptId: script.scriptId });
    if (scriptSource !== source) continue;
    const previous = coverage.get(page) || new Map();
    for (const fn of script.functions) {
      const key = `${fn.ranges[0].startOffset}:${fn.ranges[0].endOffset}`;
      const old = previous.get(key);
      const ranges = new Map((old?.ranges || []).map(r => [`${r.startOffset}:${r.endOffset}`, { ...r }]));
      for (const range of fn.ranges) {
        const offset = `${range.startOffset}:${range.endOffset}`;
        ranges.set(offset, { ...range, count: range.count + (ranges.get(offset)?.count || 0) });
      }
      previous.set(key, { name: fn.functionName || '(module/anonymous)', count: (old?.count || 0) + fn.ranges[0].count,
        ranges: [...ranges.values()] });
    }
    coverage.set(page, previous);
  }
}

test('whole repository: inventory, offline browser behavior, failure paths and coverage', { timeout: 3600000 }, async t => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  audit(files);
  assert.throws(() => audit([...files, 'unimported-module.js']), /inventory classification/);
  assert.throws(() => audit(files.filter(p => p !== 'index.html')), /inventory classification/);
  writeFileSync(resolve(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
  console.log(`Inventory: ${files.length} files, ${pages.length} application modules, zero unexplained files`);
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const page = path === '/' ? 'index.html' : path.slice(1);
    if (![...pages, 'vendor/three-slim.module.js'].includes(page)) {
      response.writeHead(404).end('Not found'); return;
    }
    response.setHeader('Content-Type', extname(page) === '.html' ? 'text/html' : 'text/javascript');
    let content = readFileSync(resolve(root, page), 'utf8');
    if (pages.includes(page) && !request.url.includes('?original')) content = instrument(content);
    response.end(content);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
    for (const page of pages) {
      await t.test(`${page}: unmodified release smoke`, async () => {
        const b = await browser();
        try {
          await b.send('Page.navigate', { url: `${origin}/${page}?original` });
          await waitFor(b, 'document.readyState === "complete" && !!document.querySelector("#stage canvas")');
          assert.equal(await b.evaluate('document.querySelector("#stage canvas").width > 0'), true);
          assert.deepEqual(b.errors, []);
        } finally { await b.close(); }
      });
      for (const mode of ['animated', 'reduced', 'coarse', 'no-webgl']) {
        await t.test(`${page}: ${mode}`, async () => {
          const b = await browser();
          try {
            await assert.rejects(b.send('NotARealDomain.method'), /wasn't found/);
            await assert.rejects(b.evaluate('throw new Error("synthetic failure")'), /synthetic failure/);
            await b.send('Debugger.enable');
            // Parse HTML structurally; all executable script blocks must be tested.
            const html = instrument(readFileSync(resolve(root, page), 'utf8'));
            const scripts = await b.evaluate(`Array.from(new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html').scripts).map(s => ({type:s.type,src:s.getAttribute('src'),text:s.textContent}))`);
            assert.equal(scripts.length, 1, 'New script blocks need an explicit test mapping');
            assert.equal(scripts[0].type, 'module');
            assert.equal(scripts[0].src, null);
            const source = scripts[0].text;
            await b.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 3, mobile: false });
            await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: mode === 'reduced' ? 'reduce' : 'no-preference' }] });
            if (mode === 'coarse') await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
            if (mode === 'no-webgl') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `HTMLCanvasElement.prototype.getContext = function() { return null; };` });
            await b.send('Page.navigate', { url: `${origin}/${page}` });
            await waitFor(b, 'document.readyState === "complete" && !!window.observed');
            assert.equal(await b.evaluate(`window.matchMedia('(pointer: fine)').matches`), mode !== 'coarse');
            assert.equal(await b.evaluate('!!document.querySelector("h1") && !!document.querySelector("#contact a[href] ")'), true);
            assert.equal(await b.evaluate(`Array.from(document.querySelectorAll('a[href^="#"]')).every(a => document.getElementById(a.hash.slice(1)))`), true);
            if (mode === 'no-webgl') {
              assert.equal(await b.evaluate('document.querySelectorAll("#stage canvas").length'), 0);
              assert.equal(await b.evaluate('getComputedStyle(document.querySelector("h1")).visibility'), 'visible');
              assert.equal(await b.evaluate(`document.querySelector('a[href^="mailto:"]').href.includes('subject=')`), true);
            } else {
              await waitFor(b, 'observed.renders > 0');
              assert.equal(await b.evaluate('document.querySelectorAll("#stage canvas").length'), 1);
              assert.equal(await b.evaluate('observed.renderer.getPixelRatio()'), mode === 'coarse' ? 1.5 : 2);
              const count = await b.evaluate('observed.renders');
              await new Promise(r => setTimeout(r, 120));
              assert.equal(await b.evaluate(`observed.renders ${mode === 'reduced' ? '===' : '>'} ${count}`), true);
              assert.equal(await b.evaluate('observed.scene.children[0].children.length > 0'), true);
              if (page.startsWith('non-llm')) {
                assert.equal(await b.evaluate('observed.scene.children[0].children.slice(0,26).every(o => o.geometry.attributes.position.count === 140 && Array.from(o.geometry.attributes.position.array).every(Number.isFinite) && o.geometry.attributes.position.array.some((v,i) => i%3===1 && v!==0))'), true);
              } else {
                assert.deepEqual(await b.evaluate('observed.scene.children[0].children.slice(0,3).map(g => g.children[0].geometry.attributes.position.count)'), [160, 140, 120]);
              }
              await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 700 });
              await b.evaluate('window.scrollTo(0, 400)');
              await waitFor(b, 'Math.abs(Number(document.getElementById("stage").style.opacity) - 0.75) < 0.01');
              if (mode !== 'reduced') await waitFor(b, 'Math.abs(observed.camera.position.z - 6.9) < 0.02');
              await b.evaluate('window.scrollTo(0, 1600)');
              await waitFor(b, 'document.getElementById("stage").style.opacity === "0"');
              await new Promise(r => setTimeout(r, 80));
              const stopped = await b.evaluate('observed.renders');
              await new Promise(r => setTimeout(r, 100));
              assert.equal(await b.evaluate('observed.renders'), stopped, 'Scrolled-off animation stops');
              await b.evaluate('window.scrollTo(0,0)');
              if (mode !== 'reduced') await waitFor(b, `observed.renders > ${stopped}`);
              await b.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange"))');
              const hidden = await b.evaluate('observed.renders');
              await new Promise(r => setTimeout(r, 100));
              assert.equal(await b.evaluate('observed.renders'), hidden);
              await b.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false}); document.dispatchEvent(new Event("visibilitychange"))');
              if (mode !== 'reduced') await waitFor(b, `observed.renders > ${hidden}`);
              await b.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 700, deviceScaleFactor: 1, mobile: false });
              await waitFor(b, 'observed.camera.aspect === 600/700');
              assert.equal(await b.evaluate('observed.scene.children[0].position.x'), 0);
              assert.equal(await b.evaluate('observed.scene.children[0].scale.x'), 0.78);
              assert.equal(await b.evaluate('observed.renderer.domElement.width'), 600 * (mode === 'coarse' ? 1.5 : 2));
              const beforeRestore = await b.evaluate('observed.renders');
              assert.equal(await b.evaluate('window.lose = observed.renderer.getContext().getExtension("WEBGL_lose_context"); !!window.lose'), true);
              await b.evaluate('lose.loseContext()');
              await waitFor(b, 'observed.renderer.getContext().isContextLost()');
              await new Promise(r => setTimeout(r, 100));
              await b.evaluate('lose.restoreContext()');
              await waitFor(b, `!observed.renderer.getContext().isContextLost() && observed.renders > ${beforeRestore}`);
            }
            assert.deepEqual(b.errors, [], 'No uncaught browser exceptions');
            await collect(b, page, source);
          } finally { await b.close(); }
        });
      }
    }
    const report = {};
    for (const page of pages) {
      const functions = [...(coverage.get(page)?.values() || [])];
      report[page] = functions;
      assert.ok(functions.length > 10, `${page}: missing coverage (including unimported modules)`);
      assert.deepEqual(functions.filter(fn => fn.count === 0).map(fn => fn.name), [], `${page}: unexercised functions`);
      console.log(`${page}: ${functions.length}/${functions.length} functions exercised`);
    }
    writeFileSync(resolve(output, 'browser-coverage.json'), JSON.stringify(report, null, 2));
    writeFileSync(resolve(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
  } finally { await new Promise(r => server.close(r)); }
});
