import { startTestBrowser } from "../browser-e2e";

const browser = await startTestBrowser();
await browser.close();
console.log("BROWSER_READY");
