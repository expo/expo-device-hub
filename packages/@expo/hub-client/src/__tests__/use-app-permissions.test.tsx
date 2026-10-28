import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppPermissions } from "../useAppPermissions";
import { type PermissionsBackend } from "../app-permissions";
import { type AppPermission } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
let client: ReturnType<typeof useAppPermissions>;
const rows = (state: AppPermission["state"]): AppPermission[] => [
  { id: "camera", label: "Camera", state },
];
function deferred() {
  let resolve!: (rows: AppPermission[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AppPermission[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Harness({
  backend,
  app = "app",
  host = "http://host-a/sim",
}: {
  backend: PermissionsBackend;
  app?: string;
  host?: string;
}) {
  client = useAppPermissions({
    active: true,
    backend,
    appId: app,
    targetId: JSON.stringify([host, "device"]),
  });
  return null;
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

test("a read started before a write cannot overwrite that write's confirmed state", async () => {
  const poll = deferred();
  const write = deferred();
  let lists = 0;
  const backend: PermissionsBackend = {
    list: () => (++lists === 1 ? Promise.resolve(rows("denied")) : poll.promise),
    write: () => write.promise,
    reset: async () => rows("undetermined"),
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => write.resolve(rows("granted")));
  expect(client.permissions?.[0].state).toBe("granted");
  await act(async () => poll.resolve(rows("denied")));
  expect(client.permissions?.[0].state).toBe("granted");
});

test("overlapping and later successful reads do not erase a failed mutation", async () => {
  const poll = deferred();
  const write = deferred();
  let lists = 0;
  const backend: PermissionsBackend = {
    list: () =>
      ++lists === 1
        ? Promise.resolve(rows("denied"))
        : lists === 2
          ? poll.promise
          : Promise.resolve(rows("granted")),
    write: () => write.promise,
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => write.reject(new Error("native service refused grant")));
  await act(async () => poll.resolve(rows("denied")));
  expect(client.permissionsError).toBe("native service refused grant");
  await act(async () => client.refreshPermissions());
  expect(client.permissions?.[0].state).toBe("granted");
  expect(client.permissionsError).toBe("native service refused grant");
});

test("polls coalesce while pending and an old target cannot block the new one", async () => {
  const old = deferred();
  const next = deferred();
  let lists = 0;
  const backend: PermissionsBackend = {
    list: () => (++lists === 1 ? old.promise : next.promise),
    write: async () => [],
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => {
    client.refreshPermissions();
    client.refreshPermissions();
    client.refreshPermissions();
  });
  expect(lists).toBe(1);
  await act(async () => renderer.update(<Harness backend={backend} app="new-app" />));
  await act(async () => client.refreshPermissions());
  expect(lists).toBe(2);
  await act(async () => old.resolve(rows("denied")));
  expect(client.permissions).toBeNull();
  await act(async () => next.resolve(rows("granted")));
  expect(client.permissions?.[0].state).toBe("granted");
});

test("a failed reset keeps its error while readback reflects partial changes", async () => {
  const reset = deferred();
  let state = rows("granted");
  const backend: PermissionsBackend = {
    list: async () => state,
    write: async () => [],
    reset: () => reset.promise,
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => reset.reject(new Error("one service failed to reset")));
  state = rows("undetermined");
  await act(async () => client.refreshPermissions());
  expect(client.permissions?.[0].state).toBe("undetermined");
  expect(client.permissionsError).toBe("one service failed to reset");
  await act(async () => renderer.update(<Harness backend={backend} app="different-app" />));
  expect(client.permissionsError).toBeNull();
});

test("returning to an app retains its reset lock through readback, even with a new backend", async () => {
  const reset = deferred();
  const calls: string[] = [];
  let current = rows("granted");
  const backend: PermissionsBackend = {
    list: async () => current,
    write: async (app) => {
      calls.push(`write:${app}`);
      return rows("granted");
    },
    reset: (app) => {
      calls.push(`reset:${app}`);
      return reset.promise.then((next) => {
        current = next;
        return next;
      });
    },
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} app="A" />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => renderer.update(<Harness backend={backend} app="B" />));
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  const reconnected = { ...backend };
  await act(async () => renderer.update(<Harness backend={reconnected} app="A" />));
  expect(client.permissionsPending.has("camera")).toBe(true);
  await act(async () => client.setPermission("camera", "grant"));
  expect(calls).toEqual(["reset:A", "write:B"]);
  await act(async () => reset.resolve(rows("undetermined")));
  expect(client.permissionsPending.size).toBe(0);
  expect(client.permissions?.[0].state).toBe("undetermined");
});

test("replacing a backend starts a fresh read and rejects the retired response", async () => {
  const old = deferred();
  const fresh = deferred();
  const backend: PermissionsBackend = {
    list: () => old.promise,
    write: async () => [],
    reset: async () => [],
  };
  let reads = 0;
  const replacement = {
    ...backend,
    list: () => {
      reads++;
      return fresh.promise;
    },
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => renderer.update(<Harness backend={replacement} />));
  await act(async () => client.refreshPermissions());
  expect(reads).toBe(1);
  await act(async () => fresh.resolve(rows("granted")));
  await act(async () => old.resolve(rows("denied")));
  expect(client.permissions?.[0].state).toBe("granted");
});

test("failed recovery keeps ownership until a later successful read", async () => {
  const reset = deferred();
  let reads = 0;
  let writes = 0;
  const backend: PermissionsBackend = {
    list: async () => {
      if (++reads === 2) throw new Error("read disconnected");
      return rows(reads === 1 ? "granted" : "undetermined");
    },
    reset: () => reset.promise,
    write: async () => {
      writes++;
      return [];
    },
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => reset.reject(new Error("write disconnected")));
  expect(client.permissionsPending.has("camera")).toBe(true);
  expect(client.permissionsError).toContain("write disconnected");
  expect(client.permissionsError).toContain("Readback: read disconnected");
  await act(async () => client.setPermission("camera", "grant"));
  expect(writes).toBe(0);
  await act(async () => client.refreshPermissions());
  expect(client.permissionsPending.size).toBe(0);
  expect(client.permissions?.[0].state).toBe("undetermined");
  expect(client.permissionsError).toBe("write disconnected");
});

test("a recovery snapshot cannot overwrite another permission's newer write", async () => {
  const camera = deferred();
  const recovery = deferred();
  const both = (mic: AppPermission["state"]): AppPermission[] => [
    ...rows("granted"),
    { id: "microphone", label: "Microphone", state: mic },
  ];
  let reads = 0;
  const backend: PermissionsBackend = {
    list: () => (++reads === 1 ? Promise.resolve(both("granted")) : recovery.promise),
    reset: async () => [],
    write: (_app, id) => (id === "camera" ? camera.promise : Promise.resolve(both("denied"))),
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => camera.reject(new Error("camera failed")));
  await act(async () => client.setPermission("microphone", "revoke"));
  await act(async () => recovery.resolve(both("granted")));
  expect(client.permissions?.find((p) => p.id === "microphone")?.state).toBe("denied");
});

test("a retired backend's recovery snapshot cannot replace a fresh backend read", async () => {
  const write = deferred();
  const recovery = deferred();
  let reads = 0;
  const backend: PermissionsBackend = {
    list: () => (++reads === 1 ? Promise.resolve(rows("granted")) : recovery.promise),
    write: () => write.promise,
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => write.reject(new Error("socket closed")));
  const fresh = { ...backend, list: async () => rows("denied") };
  await act(async () => renderer.update(<Harness backend={fresh} />));
  await act(async () => client.refreshPermissions());
  await act(async () => recovery.resolve(rows("granted")));
  expect(client.permissions?.[0].state).toBe("denied");
  expect(client.permissionsPending.size).toBe(0);
});

test("backend replacement clears stale rows while retaining an outstanding reset", async () => {
  const reset = deferred();
  const backend: PermissionsBackend = {
    list: async () => rows("granted"),
    write: async () => [],
    reset: () => reset.promise,
  };
  let reads = 0;
  const replacement = {
    ...backend,
    list: async () => {
      if (++reads === 1) throw new Error("replacement unavailable");
      return rows("undetermined");
    },
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => renderer.update(<Harness backend={replacement} />));
  expect(client.permissions).toBeNull();
  expect(client.permissionsPending.has("camera")).toBe(true);
  await act(async () => client.refreshPermissions());
  expect(reads).toBe(0);
  expect(client.permissions).toBeNull();
  expect(client.permissionsError).toBeNull();
  await act(async () => reset.resolve(rows("undetermined")));
  expect(client.permissionsError).toBe("replacement unavailable");
  expect(client.permissionsPending.has("camera")).toBe(true);
  await act(async () => client.refreshPermissions());
  expect(client.permissions?.[0].state).toBe("undetermined");
  expect(client.permissionsPending.size).toBe(0);
});

test("same-UDID hosts have independent controls and returning retains the original reset", async () => {
  const reset = deferred();
  const calls: string[] = [];
  const a: PermissionsBackend = {
    list: async () => rows("granted"),
    write: async () => {
      calls.push("write:A");
      return rows("granted");
    },
    reset: () => {
      calls.push("reset:A");
      return reset.promise;
    },
  };
  const b: PermissionsBackend = {
    list: async () => rows("denied"),
    write: async () => {
      calls.push("write:B");
      return rows("granted");
    },
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={a} host="http://host-a/sim" />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.resetPermissions());
  await act(async () => renderer.update(<Harness backend={b} host="http://host-b/sim" />));
  expect(client.permissionsPending.size).toBe(0);
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  expect(calls).toEqual(["reset:A", "write:B"]);
  await act(async () => renderer.update(<Harness backend={a} host="http://host-a/sim" />));
  expect(client.permissionsPending.has("camera")).toBe(true);
  await act(async () => client.setPermission("camera", "grant"));
  expect(calls).toEqual(["reset:A", "write:B"]);
  await act(async () => reset.resolve(rows("undetermined")));
  expect(client.permissionsPending.size).toBe(0);
});

test("background refresh skips duplicate reads while a write supplies its readback", async () => {
  const write = deferred();
  let lists = 0;
  const backend: PermissionsBackend = {
    list: async () => {
      if (++lists > 1) throw new Error("permission read unavailable");
      return rows("denied");
    },
    write: () => write.promise,
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => {
    client.refreshPermissions();
    client.refreshPermissions();
  });
  expect(lists).toBe(1);
  expect(client.permissionsError).toBeNull();
  expect(client.permissionsPending.has("camera")).toBe(true);
  await act(async () => write.resolve(rows("granted")));
  expect(client.permissions?.[0].state).toBe("granted");
  expect(client.permissionsPending.size).toBe(0);
  await act(async () => client.refreshPermissions());
  expect(lists).toBe(2);
  expect(client.permissionsError).toBe("permission read unavailable");
});

test("a recovery read waits for other active writes and starts when the last one finishes", async () => {
  const camera = deferred();
  const microphone = deferred();
  const both = (
    cameraState: AppPermission["state"],
    micState: AppPermission["state"],
  ): AppPermission[] => [
    ...rows(cameraState),
    { id: "microphone", label: "Microphone", state: micState },
  ];
  let lists = 0;
  const backend: PermissionsBackend = {
    list: async () => (++lists === 1 ? both("denied", "granted") : both("granted", "denied")),
    write: (_app, id) => (id === "camera" ? camera.promise : microphone.promise),
    reset: async () => [],
  };
  await act(async () => {
    renderer = create(<Harness backend={backend} />);
  });
  await act(async () => client.refreshPermissions());
  await act(async () => client.setPermission("camera", "grant"));
  await act(async () => client.setPermission("microphone", "revoke"));
  await act(async () => camera.reject(new Error("camera reply lost")));
  expect(lists).toBe(1);
  expect([...client.permissionsPending]).toEqual(["camera", "microphone"]);
  await act(async () => microphone.resolve(both("granted", "denied")));
  expect(lists).toBe(2);
  expect(client.permissionsPending.size).toBe(0);
  expect(client.permissions?.[0].state).toBe("granted");
  expect(client.permissionsError).toBe("camera reply lost");
});
