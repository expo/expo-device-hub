/**
 * Browser regression against the exported dashboard, with an empty device host.
 * Run build:web first, then `bun run test:sidebar` (install Chromium once with
 * `bunx playwright install chromium`). Set SIDEBAR_VIDEO_DIR to record the run.
 */
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';

const root = resolve(import.meta.dir, '../dist/client');
assert(await Bun.file(resolve(root, 'index.html')).exists(), 'Run build:web first');
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
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
    const context = await browser.newContext({
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
  }
} finally {
  for (const heartbeat of heartbeats) clearInterval(heartbeat);
  await browser?.close();
  server.stop(true);
}
