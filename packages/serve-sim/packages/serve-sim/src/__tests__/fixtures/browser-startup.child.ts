import { startTestBrowser } from "../browser-e2e";

const browser = await startTestBrowser(
  Number(process.env.SERVE_SIM_BROWSER_STARTUP_TEST_MS ?? 15000),
);
await browser.close();
console.log("BROWSER_READY");
