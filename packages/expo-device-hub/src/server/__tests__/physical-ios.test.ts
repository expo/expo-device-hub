import { expect, test } from "bun:test";
import { createPhysicalIosHandler, type PhysicalCapture } from "../physical-ios";

test("identifies an iPad by its hardware model when preview fails", async () => {
  const handler = createPhysicalIosHandler(
    async () => {
      throw new Error("Connect by USB or enable Wi-Fi access in Finder.");
    },
    async () => ({
      value: [
        {
          udid: "tablet",
          name: "My tablet",
          model: "iPad Pro 13-inch (M5)",
          kind: "iPad",
          osVersion: "27.2",
          connected: true,
          transport: "wifi",
        },
      ],
      error: null,
    }),
  );
  try {
    const response = await handler.handle(
      new Request("http://localhost/api/ios-device/open", {
        method: "POST",
        body: JSON.stringify({ device: "tablet" }),
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe(
      "iPad Pro 13-inch (M5): Connect by USB or enable Wi-Fi access in Finder.",
    );
  } finally {
    await handler.dispose();
  }
});

function fixture(staleInput = false) {
  let opened = 0;
  let closed = 0;
  let touches = 0;
  let generation = 1;
  const capture: PhysicalCapture = {
    read: async () => ({
      generation,
      frames: [{ key: true, timestamp: 0, data: Buffer.from([1, 2]) }],
      dropped: 0,
    }),
    touch: async (samples) => {
      if (staleInput) {
        staleInput = false;
        generation++;
        throw new Error("Wait for a fresh physical iOS screen before sending input.");
      }
      expect(samples[0]).toMatchObject({ x: 50, y: 100, width: 100, height: 200 });
      touches++;
    },
    requestKeyframe: () => {
      generation++;
    },
    close: async () => {
      closed++;
    },
  };
  const handler = createPhysicalIosHandler(
    async () => {
      opened++;
      return capture;
    },
    async () => ({
      value: [
        {
          udid: "phone",
          name: "iPhone",
          model: "iPhone",
          kind: "iPhone",
          osVersion: "27",
          connected: true,
          transport: "wired",
        },
      ],
      error: null,
    }),
  );
  const call = (operation: string, body: object, headers = {}) =>
    handler.handle(
      new Request(`http://localhost/api/ios-device/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { handler, call, counts: () => ({ opened, closed, touches }) };
}

test.each([
  "http://attacker.example:3344",
  "http://localhost.attacker.example",
  "http://127.example.com",
  "http://192.168.1.20:3344",
])("rejects a tokenless request whose Host and Origin both name %s", async (origin) => {
  const { handler, counts } = fixture();
  try {
    for (const headers of [{ origin }, { origin, "sec-fetch-site": "same-origin" }, {}]) {
      const response = await handler.handle(
        new Request(`${origin}/api/ios-device/open`, {
          method: "POST",
          headers: { host: new URL(origin).host, "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ device: "phone" }),
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(counts().opened).toBe(0);
  } finally {
    await handler.dispose();
  }
});

test.each(["http://localhost:3344", "http://127.0.0.1:3344", "http://[::1]:3344"])(
  "allows the local physical preview at %s",
  async (origin) => {
    const { handler, counts } = fixture();
    try {
      const response = await handler.handle(
        new Request(`${origin}/api/ios-device/open`, {
          method: "POST",
          headers: { origin, "sec-fetch-site": "same-origin", "Content-Type": "application/json" },
          body: JSON.stringify({ device: "phone" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(counts().opened).toBe(1);
    } finally {
      await handler.dispose();
    }
  },
);

test("a native generation change during input keeps the preview alive for a fresh frame", async () => {
  const { handler, call, counts } = fixture(true);
  try {
    const { session } = await (await call("open", { device: "phone" })).json();
    const batch = await (await call("read", { session })).json();
    const samples = [{ phase: 0, x: 0.5, y: 0.5, width: 100, height: 200 }];
    expect((await call("input", { session, generation: batch.generation, samples })).status).toBe(
      409,
    );
    expect(counts().closed).toBe(0);
    const fresh = await (await call("read", { session })).json();
    expect(fresh.generation).toBeGreaterThan(batch.generation);
    expect((await call("input", { session, generation: fresh.generation, samples })).status).toBe(
      200,
    );
  } finally {
    await handler.dispose();
  }
});

test("requires a displayed generation, validates coordinates, and closes only its session", async () => {
  const { handler, call, counts } = fixture();
  try {
    const { session } = await (await call("open", { device: "phone" })).json();
    const input = {
      session,
      generation: 1,
      samples: [{ phase: 0, x: 0.5, y: 0.5, width: 100, height: 200 }],
    };
    expect((await call("input", input)).status).toBe(409);
    const batch = await (await call("read", { session })).json();
    expect(batch.frames[0].data).toBe("AQI=");
    expect(
      (await call("input", { ...input, samples: [{ ...input.samples[0], x: 2 }] })).status,
    ).toBe(400);
    expect((await call("input", input)).status).toBe(200);
    expect(counts().touches).toBe(1);
    await call("reset", { session });
    expect((await call("input", input)).status).toBe(409);
    await call("close", { session });
    expect(counts().closed).toBe(1);
    expect((await call("read", { session })).status).toBe(410);
  } finally {
    await handler.dispose();
  }
});

test("rejects unconnected devices, foreign origins, oversized bodies, and excess captures", async () => {
  const { handler, call, counts } = fixture();
  try {
    expect((await call("open", { device: "missing" })).status).toBe(409);
    expect(
      (await call("open", { device: "phone" }, { origin: "https://example.com" })).status,
    ).toBe(403);
    expect((await call("open", { device: "x".repeat(40_000) })).status).toBe(413);
    for (let i = 0; i < 4; i++) expect((await call("open", { device: "phone" })).status).toBe(200);
    expect((await call("open", { device: "phone" })).status).toBe(429);
  } finally {
    await handler.dispose();
  }
  expect(counts().closed).toBe(4);
});
