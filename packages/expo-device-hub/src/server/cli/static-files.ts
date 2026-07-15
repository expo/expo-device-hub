import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import sirv from 'sirv';

/** Serve files under `rootUrl`; resolves false (not 404) so callers keep their own fallback. */
export function staticFileHandler(
  rootUrl: URL,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const root = fileURLToPath(rootUrl);
  // sirv scans the root at startup; skip it entirely when the export is absent.
  if (!existsSync(root)) return async () => false;

  const middleware = sirv(root, {
    etag: true,
    // Exported asset filenames are content-hashed; HTML never reaches this branch.
    maxAge: 3600,
    // No extensionless `.html` fallbacks — HTML routes belong to the Hub handler.
    extensions: [],
  });

  return (req, res) =>
    new Promise((resolve) => {
      const onServed = () => resolve(true);
      res.once('finish', onServed);
      middleware(req, res, () => {
        res.removeListener('finish', onServed);
        resolve(false);
      });
    });
}
