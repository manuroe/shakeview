/**
 * Captures screenshots of the app using the demo log.
 * Requires a build with VITE_BASE=/ (handled automatically by this script).
 * Output: public/demo/screenshot-*.png
 *
 * Usage: npm run screenshots
 */
import { chromium, type Page } from '@playwright/test';
import { spawnSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { parseLogFile } from '../src/utils/logParser.ts';
import { summarizeLogResult } from '../extension/src/summarize.ts';
import { parseListingHtml } from '../extension/src/listing.ts';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);
const ROOT = resolve(currentDirPath, '..');
const OUT_DIR = resolve(ROOT, 'public', 'demo');
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;
const VITE_BIN = resolve(ROOT, 'node_modules', '.bin', 'vite');
const EXTENSION_LISTING_SCREENSHOT_CLIP = {
  x: 0,
  y: 0,
  width: 1280,
  height: 320,
} as const;

/**
 * Clip for the viewer's /listing route — taller to show the enriched table header
 * and several data rows.
 */
const EXTENSION_VIEWER_SCREENSHOT_CLIP = {
  x: 0,
  y: 0,
  width: 1280,
  height: 480,
} as const;

// Build the app with VITE_BASE=/ so assets resolve correctly on localhost
console.warn('Building app...');
const buildResult = spawnSync(VITE_BIN, ['build'], {
  cwd: ROOT,
  stdio: 'inherit',
  // eslint-disable-next-line @typescript-eslint/naming-convention
  env: { ...process.env, VITE_BASE: '/' },
});
if (buildResult.status !== 0) {
  console.error('Build failed.');
  process.exit(1);
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Any HTTP response means the server is up
      if (res.status) return;
    } catch {
      // Not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}

const server = spawn(VITE_BIN, ['preview', '--port', String(PORT), '--base', '/'], {
  cwd: ROOT,
  stdio: 'inherit',
});

async function main(): Promise<void> {
  await waitForServer(BASE_URL);
  console.warn('Preview server ready.');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  async function setTheme(theme: 'light' | 'dark'): Promise<void> {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    // Let CSS transitions settle
    await page.waitForTimeout(300);
  }

  function arePngsVisuallyEqual(existingPng: Buffer, nextPng: Buffer): boolean {
    const existingImage = PNG.sync.read(existingPng);
    const nextImage = PNG.sync.read(nextPng);

    if (
      existingImage.width !== nextImage.width ||
      existingImage.height !== nextImage.height
    ) {
      return false;
    }

    const differentPixels = pixelmatch(
      existingImage.data,
      nextImage.data,
      undefined,
      existingImage.width,
      existingImage.height,
      { threshold: 0 },
    );

    return differentPixels === 0;
  }

  async function shot(
    name: string,
    options?: {
      readonly clip?: { x: number; y: number; width: number; height: number };
      /** Override the default page for this screenshot. Defaults to the main `page`. */
      readonly targetPage?: Page;
    },
  ): Promise<void> {
    const activePage = options?.targetPage ?? page;
    const outputPath = resolve(OUT_DIR, `screenshot-${name}.png`);
    const nextPng = await activePage.screenshot({ type: 'png', clip: options?.clip });

    try {
      const existingPng = await readFile(outputPath);
      const hasVisualChanges = !arePngsVisuallyEqual(existingPng, nextPng);
      if (!hasVisualChanges) {
        console.warn(`↺ screenshot-${name}.png unchanged (no visual diff)`);
        return;
      }
    } catch (error: unknown) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        throw error;
      }
    }

    await writeFile(outputPath, nextPng);
    console.warn(`✓ screenshot-${name}.png updated`);
  }

  // Landing page
  await page.goto(`${BASE_URL}/#/`, { waitUntil: 'networkidle' });
  // Extra wait for React to complete its initial render
  await page.waitForTimeout(800);
  await setTheme('light');
  await shot('landing-light');
  await setTheme('dark');
  await shot('landing-dark');

  // Load demo data.
  await setTheme('light');
  const demoTrigger = page.getByRole('button', { name: 'Try with mobile demo logs' });
  await demoTrigger.waitFor({ state: 'visible', timeout: 15_000 });
  await demoTrigger.click();
  await page.waitForURL(/\/#\/summary/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  // Extra wait for charts to finish rendering after navigation
  await page.waitForTimeout(600);

  // Summary
  await shot('summary-light');
  await setTheme('dark');
  await shot('summary-dark');

  // Logs
  await page.goto(`${BASE_URL}/#/logs`);
  await page.waitForTimeout(600);
  await setTheme('light');
  await shot('logs-light');
  await setTheme('dark');
  await shot('logs-dark');

  // Spans (logs grouped by tracing span). Include INFO/DEBUG since most SDK
  // spans are on DEBUG lines, then expand the branch nodes so the hierarchy is
  // visible (leaves stay closed to avoid occurrence spam). Children mount lazily
  // on the toggle event, so run several passes.
  await page.goto(`${BASE_URL}/#/spans`);
  await page.waitForTimeout(600);
  for (const level of ['INFO', 'DEBUG']) {
    await page.getByRole('checkbox', { name: level }).check();
  }
  await page.waitForTimeout(300);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      document.querySelectorAll('details[class*="node"]:not([open])').forEach((d) => {
        const details = d as HTMLDetailsElement;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });
    });
    await page.waitForTimeout(150);
  }
  await setTheme('light');
  await shot('spans-light');
  await setTheme('dark');
  await shot('spans-dark');

  // HTTP requests
  await page.goto(`${BASE_URL}/#/http_requests`);
  await page.waitForTimeout(600);
  await setTheme('light');
  await shot('http-light');
  await setTheme('dark');
  await shot('http-dark');

  // Sync waterfall
  await page.goto(`${BASE_URL}/#/http_requests/sync`);
  await page.waitForTimeout(600);
  await setTheme('light');
  await shot('sync-light');
  await setTheme('dark');
  await shot('sync-dark');

  // Extension listing page — navigate to the demo rageshake-style HTML and capture
  // the native view before the extension takes over.
  const demoLogText = await readFile(resolve(ROOT, 'public', 'demo', 'demo.log'), 'utf-8');
  const demoSummary = summarizeLogResult(parseLogFile(demoLogText));

  await page.goto(`${BASE_URL}/demo/api/listing/demo/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);

  // Before extension enhancement
  await page.evaluate(() => { document.documentElement.removeAttribute('data-rs-theme'); });
  await shot('extension-before-light', { clip: EXTENSION_LISTING_SCREENSHOT_CLIP });
  await page.evaluate(() => { document.documentElement.setAttribute('data-rs-theme', 'dark'); });
  await page.waitForTimeout(300);
  await shot('extension-before-dark', { clip: EXTENSION_LISTING_SCREENSHOT_CLIP });

  // Extension listing view (after) — the content script now redirects the native listing
  // page to the viewer's /listing route. Capture that viewer route directly by loading it
  // in a fresh page with a chrome shim injected via addInitScript (before React's first
  // render) so that sendMessage returns mock entries and per-file summaries without
  // needing a real extension context.
  const demoListingHtml = await readFile(
    resolve(ROOT, 'public', 'demo', 'api', 'listing', 'demo', 'index.html'),
    'utf-8',
  );
  // Parse the demo listing page using the same function the extension uses.
  const { entries: demoListingEntries, detailsUrl: demoDetailsUrl } = parseListingHtml(
    demoListingHtml,
    'https://rageshakes.example.com/api/listing/2026-03-04/DEMO0001/',
  );

  const extensionPage = await context.newPage();
  // Inject the chrome shim before the page loads so it is available during React's init.
  // Serialised as a string (not a function reference) to avoid esbuild name mangling.
  await extensionPage.addInitScript(`
    window.chrome = {
      runtime: {
        sendMessage: function(msg) {
          var entries = ${JSON.stringify(demoListingEntries)};
          var detailsUrl = ${JSON.stringify(demoDetailsUrl)};
          var summary = ${JSON.stringify(demoSummary)};
          if (msg && msg.type === 'fetchListing') {
            return Promise.resolve({ ok: true, entries: entries, detailsUrl: detailsUrl });
          }
          if (msg && msg.type === 'fetchDetails') {
            return Promise.resolve({ ok: true, text: '{"data":{}}' });
          }
          if (msg && msg.type === 'fetchAndSummarize') {
            return Promise.resolve({ ok: true, summary: summary });
          }
          return Promise.resolve({ ok: false });
        }
      }
    };
  `);
  // Use the canonical rageshake-style listing URL as the listingUrl param (not a localhost
  // URL) so the page header label matches the real extension flow. Because fetchListing is
  // fully mocked, this URL is never actually fetched.
  const canonicalListingUrl = 'https://rageshakes.example.com/api/listing/2026-03-04/DEMO0001/';
  const encodedListingUrl = encodeURIComponent(canonicalListingUrl);
  await extensionPage.goto(
    `${BASE_URL}/#/listing?listingUrl=${encodedListingUrl}`,
    { waitUntil: 'networkidle' },
  );
  // Wait for the table to appear, then allow time for all per-file summaries to populate.
  await extensionPage.waitForSelector('table tbody tr', { timeout: 15_000 });
  await extensionPage.waitForTimeout(1500);

  await extensionPage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await extensionPage.waitForTimeout(300);
  await shot('extension-light', { clip: EXTENSION_VIEWER_SCREENSHOT_CLIP, targetPage: extensionPage });
  await extensionPage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await extensionPage.waitForTimeout(300);
  await shot('extension-dark', { clip: EXTENSION_VIEWER_SCREENSHOT_CLIP, targetPage: extensionPage });

  await extensionPage.close();

  await browser.close();
  console.warn('All screenshots captured.');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
  });
