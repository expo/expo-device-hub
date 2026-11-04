import type { DeviceClient } from "./types";
import type { runHostAction } from "./exec-ws";

type Backend = NonNullable<DeviceClient["appInstall"]>;
type Module = {
  createAppDropClient: (
    transport: (
      action: string,
      params?: Parameters<typeof runHostAction>[3],
    ) => ReturnType<typeof runHostAction>,
    udid: string,
    worker: { url: string; headers: Record<string, string> },
  ) => Backend;
};

export function createAppInstallBackend(
  execWsUrl: string,
  token: string,
  udid: string,
  transport: Parameters<Module["createAppDropClient"]>[0],
): Backend {
  let pending: Promise<Backend> | undefined;
  const load = () =>
    (pending ??= (async () => {
      const endpoint = new URL(execWsUrl);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = endpoint.pathname.replace(/\/exec-ws$/, "/app-drop-client.js");
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch(endpoint, { headers });
      if (!response.ok) throw new Error("App drops need an updated Simulator server.");
      const url = URL.createObjectURL(await response.blob());
      try {
        const module = (await import(/* @vite-ignore */ url)) as Module;
        endpoint.pathname = endpoint.pathname.replace(/app-drop-client\.js$/, "app-drop-worker.js");
        return module.createAppDropClient(transport, udid, { url: endpoint.href, headers });
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((error) => {
      pending = undefined;
      throw error;
    }));
  return {
    installFile: async (file, progress) => (await load()).installFile(file, progress),
    installFolder: async (entry, progress) => (await load()).installFolder(entry, progress),
  };
}
