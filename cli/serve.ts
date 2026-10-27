/**
 * `rageshake serve [dir]` — serve the built viewer plus a directory of rageshakes
 * on one origin, so a log line can be reached by URL instead of by dropping a
 * file into the browser.
 *
 *   http://127.0.0.1:7357/#/logs?archive=/<path-under-dir>/rageshake.tar.gz&file=console.2026-07-21-14.log.gz&line=1234
 *
 * `line` counts inside `file`, which is how the CLI prints it; without `file` the
 * whole archive opens merged instead.
 *
 * The viewer fetches the archive itself (see `useArchiveUrl`), which needs it to
 * be same-origin — hence one server for both. Everything is read-only and bound
 * to localhost.
 *
 * Starting it twice is safe: the second run recognises the first through
 * `/health` and prints the same URL. That keeps links stable across concurrent
 * sessions, and valid in a document read weeks later.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, whether running from `cli/` via tsx or from the `dist-cli/` bundle. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO_ROOT, 'dist');

export const DEFAULT_PORT = 7357;
/** Body of `/health`, used to tell our own server from a stranger on the port. */
export const HEALTH_MARKER = 'shakeview-serve';

/* eslint-disable @typescript-eslint/naming-convention -- file extensions and HTTP header names, not identifiers */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.gz': 'application/gzip',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Map a request path to a file on disk: the viewer's own assets first, then the
 * served directory. Returns null when the path escapes both roots.
 *
 * `/../../.ssh/id_rsa` is stopped twice over: the dot-segment rule below rejects
 * it outright, and the roots are compared against the decoded, `..`-collapsed
 * path, never the raw URL.
 *
 * @param urlPath request path, e.g. `/cases/ios-1/shakes/a.tar.gz`
 * @param dataRoot absolute path of the directory being served
 */
export function resolveServePath(urlPath: string, dataRoot: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Reject Windows path separators so dotfile/path-traversal guards can't be bypassed via %5c.
  if (decoded.includes('\\')) return null;
  // No dot segments. Rageshakes never live in one, while the served directory is
  // likely to hold `.git`, `.env` or editor state that has no business being
  // readable — and it makes `..` unreachable however it was encoded.
  if (decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
  const rel = `.${decoded === '/' ? '/index.html' : decoded}`;
  for (const root of [DIST, dataRoot]) {
    const target = resolve(root, rel);
    // Containment via `relative`, not a `root + '/'` prefix: the separator is
    // whatever the platform resolves to, and a different drive root comes back
    // absolute rather than as `..`.
    const inside = relative(root, target);
    if (inside !== '' && (inside.startsWith('..') || isAbsolute(inside))) continue; // escaped this root
    if (existsSync(target) && statSync(target).isFile()) return target;
  }
  return null;
}

/**
 * Is any source newer than the built index? Falls back to "yes" when the probe
 * itself cannot run — no usable `find`, or a path it was given has gone missing.
 * A needless rebuild costs a second; a wrong "fresh" serves the wrong viewer, and
 * refusing to start over a failed probe serves none at all.
 */
function sourcesNewerThan(index: string): boolean {
  try {
    return (
      execFileSync('find', ['src', 'index.html', 'vite.config.ts', '-newer', index, '-print', '-quit'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim() !== ''
    );
  } catch {
    return true;
  }
}

/**
 * Rebuild the viewer when any source is newer than the built index, or when the
 * existing build was made for a different base path.
 * `VITE_BASE=/` because this server has no `/shakeview/` prefix, unlike the
 * GitHub Pages deployment vite defaults to.
 */
function buildViewerIfStale(): void {
  const index = join(DIST, 'index.html');
  if (!existsSync(join(REPO_ROOT, 'src'))) {
    // Installed as a package with no sources: serve what shipped, or say why not.
    if (!existsSync(index)) throw new Error(`no built viewer at ${DIST} and no sources to build it from`);
    return;
  }
  const stale =
    !existsSync(index) ||
    // A plain `npm run build` bakes in vite's `/shakeview/` Pages base, whose asset
    // URLs resolve nowhere under DIST. Mtimes alone would call that dist fresh and
    // serve a blank page, so the base it was built with counts as staleness too.
    readFileSync(index, 'utf8').includes('/shakeview/') ||
    sourcesNewerThan(index);
  if (!stale) return;
  process.stdout.write('building viewer…\n');
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
    env: { ...process.env, VITE_BASE: '/' },
    stdio: 'inherit',
  });
}

/** Is an already-bound port one of ours? */
async function isOurServer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return (await response.text()) === HEALTH_MARKER;
  } catch {
    return false;
  }
}

/** Parse `serve`'s own arguments: `[dir] [--port N]`. */
export function parseServeArgs(args: readonly string[]): { dir: string; port: number } {
  const portFlag = args.indexOf('--port');
  const port = portFlag === -1 ? DEFAULT_PORT : Number(args[portFlag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port needs an integer 1-65535');
  }
  // Guard on portFlag: without it, `portFlag + 1` is 0 and would drop the directory.
  const positional = args.filter((_, i) => portFlag === -1 || (i !== portFlag && i !== portFlag + 1));
  return { dir: resolve(positional[0] ?? '.'), port };
}

/**
 * Run the server. Resolves once it is listening; the open handle is what keeps
 * the process alive, so `serve` owns it until ctrl-c, unlike every other command,
 * which prints and exits.
 */
export async function cmdServe(args: readonly string[]): Promise<void> {
  const { dir, port } = parseServeArgs(args);
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);

  /* eslint-disable @typescript-eslint/naming-convention -- HTTP header names, not identifiers */
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(HEALTH_MARKER);
      return;
    }
    const file = resolveServePath(req.url ?? '/', dir);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
    });
    createReadStream(file).pipe(res);
  });
  /* eslint-enable @typescript-eslint/naming-convention */

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') {
      // EPERM here means something refuses the bind — a sandbox, typically.
      process.stderr.write(`cannot listen on 127.0.0.1:${port}: ${err.code} ${err.message}\n`);
      process.exit(1);
    }
    // Binding is atomic, so it doubles as a lock: whoever lost the race reuses
    // the winner's server instead of rebuilding the viewer a second time.
    void isOurServer(port).then((ours) => {
      if (ours) {
        process.stdout.write(`viewer already served at http://127.0.0.1:${port}/\n`);
        process.exit(0);
      }
      process.stderr.write(`port ${port} is taken by something else; pass --port N\n`);
      process.exit(1);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    // This callback runs outside the CLI's top-level try/catch, so a failed build
    // would surface as an uncaught exception instead of the usual `error:` line.
    try {
      buildViewerIfStale();
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    process.stdout.write(`viewer at http://127.0.0.1:${port}/  ·  serving ${dir}  ·  ctrl-c to stop\n`);
  });
}
