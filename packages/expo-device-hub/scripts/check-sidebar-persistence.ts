/**
 * Browser regressions for the exported dashboard and populated inspector panes.
 * Run build:web first, then `bun run test:sidebar` (install Chromium once with
 * `bunx playwright install chromium`). Set SIDEBAR_VIDEO_DIR to record the run.
 */
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';

const root = resolve(import.meta.dir, '../dist/client');
assert(await Bun.file(resolve(root, 'index.html')).exists(), 'Run build:web first');
const fixture = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'fixtures/sidebar-logs.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
assert(fixture.success, String(fixture.logs));
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === '/sidebar-logs.js') return new Response(fixture.outputs[0]);
    if (pathname === '/sidebar-logs') {
      return new Response('<html><body style="margin:0"><div id="root"></div><script type="module" src="/sidebar-logs.js"></script></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(root + sep)) return new Response(null, { status: 403 });
    const file = Bun.file(path);
    if (path.endsWith('/index.html')) {
      return new Response((await file.text()).replaceAll('{{mount}}', ''), {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});
const heartbeats: ReturnType<typeof setInterval>[] = [];
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 440 },
      reducedMotion,
      recordVideo: process.env.SIDEBAR_VIDEO_DIR
        ? { dir: process.env.SIDEBAR_VIDEO_DIR, size: { width: 1280, height: 440 } }
        : undefined,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => { window.__EXPO_DEVICE_HUB_BASE_PATH__ = ''; });
    await page.route('**/api/new-device-options', (route) => route.fulfill({
      json: { ios: { runtimes: [] }, android: { runtimes: [] } },
    }));
    await page.routeWebSocket('**/api/argent-interactions/ws', () => {});
    await page.routeWebSocket('**/api/devices/ws', (socket) => {
      socket.send(JSON.stringify({ type: 'device-list', devices: { simulators: [], emulators: [] } }));
      const heartbeat = setInterval(() => socket.send('{"type":"heartbeat"}'), 1000);
      heartbeats.push(heartbeat);
      socket.onClose(() => clearInterval(heartbeat));
    });
    await page.goto(server.url.toString());
    const panel = page.locator('[data-sidebar-docked="right"], [data-sidebar-overlay="right"]');
    const toggle = panel.getByRole('button', { name: 'Toggle sidebar' });
    const logs = panel.getByRole('button', { name: 'Logs', exact: true });
    const currentApp = panel.getByRole('button', { name: 'Current app', exact: true });
    const scroller = panel.locator('aside > div').last();
    const settle = () => page.waitForTimeout(process.env.SIDEBAR_VIDEO_DIR ? 1200 : 300);
    const state = () => panel.locator('button[aria-expanded]').evaluateAll((buttons) =>
      buttons.map((button) => [button.textContent, button.getAttribute('aria-expanded')]));
    const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
    const cycle = async () => {
      const before = await state();
      const offset = await scrollTop();
      await toggle.click();
      await settle(); // Wait past the exit animation, where the original reset occurs.
      assert.equal(await page.getByRole('button', { name: 'Logs', exact: true }).count(), 0,
        'Closed sidebar must be inaccessible');
      await page.locator('[data-floating-sidebar-toggle="right"] button').click();
      await settle();
      assert.deepEqual(await state(), before, 'Expanded sections must survive closing and reopening');
      assert.equal(await scrollTop(), offset, 'Sidebar scroll position must survive closing and reopening');
    };
    await logs.click();
    await currentApp.click();
    await settle();
    await cycle(); // Both opened and collapsed choices must persist.
    await currentApp.click();
    await settle();
    await scroller.evaluate((el) => { el.scrollTop = 100; });
    assert((await scrollTop()) > 0, 'Fixture must have scrollable content');
    await settle();
    await cycle();
    const expanded = await state();
    const offset = await scrollTop();
    await page.setViewportSize({ width: 640, height: 440 });
    await settle();
    // Auto-docked sidebars close when they no longer fit. Reopen as an overlay.
    await page.locator('[data-floating-sidebar-toggle="right"] button').click();
    await settle();
    assert.deepEqual(await state(), expanded, 'Docked → overlay must preserve expansion');
    assert.equal(await scrollTop(), offset, 'Docked → overlay must preserve scroll');
    await cycle();
    await page.setViewportSize({ width: 1280, height: 440 });
    await settle();
    assert.deepEqual(await state(), expanded, 'Overlay → docked must preserve expansion');
    assert.equal(await scrollTop(), offset, 'Overlay → docked must preserve scroll');
    await page.setViewportSize({ width: 640, height: 440 });
    await settle();
    await page.locator('[data-sidebar-backdrop="right"]').click({ position: { x: 10, y: 200 } });
    await settle();
    await page.setViewportSize({ width: 1280, height: 440 });
    await page.locator('[data-floating-sidebar-toggle="right"] button').click();
    await settle();
    assert.deepEqual(await state(), expanded, 'Resize while closed must preserve expansion');
    assert.equal(await scrollTop(), offset, 'Resize while closed must preserve scroll');
    assert.deepEqual(errors, [], 'Dashboard must not throw browser errors');
    const video = page.video();
    await context.close();
    if (video) console.log(`Video: ${await video.path()}`);
    console.log(`PASS: sidebar persistence (${reducedMotion})`);

    // Actual inspector sections with static populated buffers: Activity must not
    // mistake effect reactivation for new data and jump their panes to the tail.
    const populated = await browser.newPage({ reducedMotion, viewport: { width: 1200, height: 800 } });
    await populated.goto(new URL('/sidebar-logs', server.url).toString());
    await populated.getByRole('button', { name: 'Events', exact: true }).click();
    await populated.getByRole('button', { name: 'Logs', exact: true }).click();
    await populated.waitForTimeout(300);
    const panes = populated.locator('.hub-log-scroll');
    assert.equal(await panes.count(), 2);
    await panes.evaluateAll((elements) => elements.forEach((el) => { el.scrollTop = 100; }));
    assert.deepEqual(await panes.evaluateAll((elements) => elements.map((el) => el.scrollTop)), [100, 100]);
    await populated.getByRole('button', { name: 'Toggle inspector' }).click();
    await populated.waitForTimeout(300);
    await populated.getByRole('button', { name: 'Toggle inspector' }).click();
    await populated.waitForTimeout(300);
    assert.deepEqual(await panes.evaluateAll((elements) => elements.map((el) => el.scrollTop)), [100, 100],
      'Populated Events and Logs must preserve their own scroll positions');
    await populated.getByRole('button', { name: 'Append log' }).click();
    await populated.waitForTimeout(100);
    assert(await panes.last().evaluate((el) => el.scrollTop === el.scrollHeight - el.clientHeight),
      'New log entries should still scroll to the tail');
    await populated.close();
    console.log(`PASS: populated inspector persistence (${reducedMotion})`);
  }
} finally {
  for (const heartbeat of heartbeats) clearInterval(heartbeat);
  await browser?.close();
  server.stop(true);
}
