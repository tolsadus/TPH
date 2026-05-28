// Driver for the "Tesla Price History" Chrome extension (MV3, content-script only).
//
// chromium-cli can't load unpacked extensions, so this uses Playwright (a local
// devDependency — see package.json). It loads the REAL extension into a persistent
// Chromium context and navigates to a REAL matched tesla.com URL — so the real
// content.js injects exactly as in production — but intercepts the three network
// calls the script makes and serves deterministic fixtures:
//
//   1. Tesla inventory API  (GET  /inventory/api/v4/inventory-results)  -> fake VIN list
//   2. lookup-vins function (POST .../functions/v1/lookup-vins)         -> fake price history
//   3. the page document    (GET  /<locale>/inventory/used/<model>)     -> minimal card DOM
//
// This is offline and reliable: hitting live tesla.com is bot-gated, region-gated,
// and only shows badges for VINs already in our DB. The layer PRs actually touch
// is content.js + overlay.css — that is exactly what runs here.
//
// Usage (from the repo root, after `npm install && npx playwright install chromium`):
//   node .claude/skills/run-chrome-extension/driver.mjs        # grid + popover screenshots
//   node .claude/skills/run-chrome-extension/driver.mjs headed # show the window
//
// Screenshots land in /tmp/tph-ext-shots/. Exits non-zero if no badge is injected.

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "../../../"); // repo root (has manifest.json)
const SHOTS = "/tmp/tph-ext-shots";
const headed = process.argv[2] === "headed";
mkdirSync(SHOTS, { recursive: true });

// --- fixtures ---------------------------------------------------------------
// VINs must match /[A-HJ-NPR-Z0-9]{17}/ (no I/O/Q) and appear in BOTH the card
// data-id and the lookup-vins response, or content.js won't place a badge.
// Each car lists its full price-history (oldest -> newest). The backend only
// records a row on a real price change, so distinct entries == real movement.
const CARS = [
  { vin: "LRW3E7FS4PC100004", model: "Model Y Grande Autonomie", prices: [30800, 30700, 31400, 30900, 30800, 31100, 30800] }, // fluctuated, net 0 -> grey ↕ €0 / "back to start"
  { vin: "LRW3E7FS9PC100001", model: "Model Y Grande Autonomie", prices: [52990, 49990, 46990] },                             // drop -> red ▼
  { vin: "LRW3E7EB7PC100003", model: "Model Y Performance",       prices: [55990, 56990, 57990] },                             // up   -> green ▲
  { vin: "LRW3E7FS2PC100002", model: "Model Y Propulsion",        prices: [41990] },                                          // single record -> grey TPH
];
const now = (c) => c.prices[c.prices.length - 1];
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

const pageHtml = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Tesla Inventory (fixture)</title>
<style>body{font-family:system-ui;background:#f4f4f4;margin:0;padding:24px}
.result-gallery{display:flex;gap:16px;flex-wrap:wrap}
article{background:#fff;border-radius:8px;width:300px;box-shadow:0 1px 4px rgba(0,0,0,.12);overflow:hidden}
.card-info-details{padding:16px}.title{font-weight:600;margin-bottom:8px}
.result-pricing{font-size:20px;font-weight:700}.banner{height:140px;background:#16181d}</style>
</head><body>
<h1 style="font-size:18px">Used Inventory — Model Y (test fixture)</h1>
<section class="result-gallery">
${CARS.map(c => `
  <article data-id="${c.vin}-search-result-container">
    <div class="banner"></div>
    <section class="card-info-details">
      <div class="title">Tesla ${c.model}</div>
      <div class="result-pricing">${now(c).toLocaleString("fr-FR")} €</div>
    </section>
  </article>`).join("")}
</section></body></html>`;

const inventoryJson = JSON.stringify({
  results: CARS.map(c => ({ VIN: c.vin })),
  total_matches_found: CARS.length,
});

const lookupJson = JSON.stringify(Object.fromEntries(CARS.map((c, i) => {
  const n = c.prices.length;
  const history = c.prices.map((price, j) => ({ at: daysAgo((n - 1 - j) * 2), price }));
  return [c.vin, {
    id: 1000 + i,
    current_price: now(c),
    first_seen_at: history[0].at,
    history,
  }];
})));

// --- launch -----------------------------------------------------------------
// headless:false keeps Playwright from injecting the OLD headless flag (under
// which extension content scripts never load). Real headlessness comes from
// --headless=new, which DOES run content scripts. headed=window for debugging.
const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: [
    ...(headed ? [] : ["--headless=new"]),
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-sandbox",
  ],
});

const page = context.pages()[0] || (await context.newPage());
const logs = [];
page.on("console", (m) => { if (m.text().includes("[TPH]")) logs.push(m.text()); });

// Register the catch-all FIRST: Playwright runs the most-recently-added route
// first, so the specific fulfillers below take precedence and this only blocks
// stray requests that none of them matched (keeps the run offline + hang-proof).
await context.route("**/*", (r) => r.abort());
await context.route("**/functions/v1/lookup-vins", (r) =>
  r.fulfill({ contentType: "application/json", body: lookupJson }));
await context.route("**/inventory/api/v4/inventory-results**", (r) =>
  r.fulfill({ contentType: "application/json", body: inventoryJson }));
await context.route("**/inventory/used/**", (r) =>
  r.fulfill({ contentType: "text/html", body: pageHtml }));

const URL_UNDER_TEST = "https://www.tesla.com/fr_FR/inventory/used/my";

try {
  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tph-badge", { timeout: 15000 });
  const n = await page.locator(".tph-badge").count();
  console.log(`✓ ${n} badge(s) injected`);
  const badgeTexts = await page.locator(".tph-badge").allInnerTexts();
  console.log("  badges:", JSON.stringify(badgeTexts));
  await page.screenshot({ path: `${SHOTS}/01-grid.png`, fullPage: true });
  console.log("📸", `${SHOTS}/01-grid.png`);

  // Hover the first badge (the back-to-start car) to render the popover.
  await page.locator(".tph-badge").first().hover();
  await page.waitForSelector(".tph-popover", { timeout: 5000 });
  const rows = await page.locator(".tph-popover .tph-row").count();
  const subtitle = await page.locator(".tph-popover .tph-sub").innerText();
  console.log(`✓ popover open with ${rows} history row(s)`);
  console.log("  subtitle:", JSON.stringify(subtitle));
  await page.screenshot({ path: `${SHOTS}/02-popover.png` });
  console.log("📸", `${SHOTS}/02-popover.png`);

  console.log("\n[TPH] logs:\n  " + logs.join("\n  "));
  if (n === 0) process.exitCode = 1;
} catch (e) {
  console.error("✗ driver failed:", e.message);
  await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => {});
  console.error("[TPH] logs:\n  " + logs.join("\n  "));
  process.exitCode = 1;
} finally {
  await context.close();
}
