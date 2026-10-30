// Renders the real shell served by the running backend in the installed Microsoft Edge (no browser download)
// and saves screenshots + a JSON report (console errors, CSP violations, key text). Usage:
//   npm start && node tests/ui/capture-shell.mjs [outDir] [baseUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const outDir = path.resolve(process.argv[2] ?? "documentation/spec/evidence/task-003/screenshots");
const base = process.argv[3] ?? "http://127.0.0.1:4318";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const report = { base, browserVersion: browser.version(), shots: [] };

async function shot(name, { viewport, colorScheme, failApi = false }) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const external = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith("data:")) external.push(r.url());
  });
  if (failApi) await page.route("**/api/v1/**", (route) => route.abort());
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForSelector(failApi ? "[role=alert]" : "#status-h");
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const text = await page.innerText("main");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  report.shots.push({ name, file: path.basename(file), viewport, colorScheme, failApi, consoleErrors, externalRequests: external, horizontalOverflow: overflow, text });
  await ctx.close();
}

await shot("desktop-light", { viewport: { width: 1280, height: 800 }, colorScheme: "light" });
await shot("desktop-dark", { viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
await shot("mobile-390", { viewport: { width: 390, height: 844 }, colorScheme: "light" });
await shot("server-unreachable", { viewport: { width: 1280, height: 600 }, colorScheme: "light", failApi: true });
await browser.close();

writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const bad = report.shots.filter((s) => s.externalRequests.length > 0 || s.horizontalOverflow || (!s.failApi && s.consoleErrors.length > 0));
console.log(JSON.stringify({ shots: report.shots.map((s) => s.name), problems: bad.map((s) => s.name) }));
process.exit(bad.length > 0 ? 1 : 0);
