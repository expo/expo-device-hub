// Everything the main entry exports, as a bundler without tree shaking loads it.
import * as hubClient from "../../index";

(globalThis as Record<string, unknown>).__hubClientApp = hubClient;
