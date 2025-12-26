// Tokei.mjs - APL-independent dashboard sync + HTML/PNG report generator.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import puppeteer from "puppeteer";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = __dirname;

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function resolveHashiStatsPath(cfg) {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const profile =
    typeof cfg.anki_profile === "string" && cfg.anki_profile.trim() ? cfg.anki_profile.trim() : "User 1";

  // Default location
  let outputDir = "hashi_exports";

  // If Hashi is installed, prefer its configured output_dir.
  try {
    const rulesPath = path.join(appdata, "Anki2", "addons21", "Hashi", "rules.json");
    const raw = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
    const cfgOut = raw?.settings?.output_dir;
    if (typeof cfgOut === "string" && cfgOut.trim()) outputDir = cfgOut.trim();
  } catch {
    // ignore
  }

  if (path.isAbsolute(outputDir)) return path.join(outputDir, "anki_stats_snapshot.json");
  return path.join(appdata, "Anki2", profile, outputDir, "anki_stats_snapshot.json");
}

async function httpGetJson(url, timeoutMs) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    const msg = payload?.error ? String(payload.error) : text.trim();
    throw new Error(`HTTP ${resp.status} ${msg}`);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshHashiExport(cfg) {
  const hashiCfg = cfg.hashi && typeof cfg.hashi === "object" ? cfg.hashi : {};
  const host = typeof hashiCfg.host === "string" && hashiCfg.host.trim() ? hashiCfg.host.trim() : "127.0.0.1";
  const port = Number.isFinite(Number(hashiCfg.port)) ? Number(hashiCfg.port) : 8766;
  const token = typeof hashiCfg.token === "string" && hashiCfg.token.trim() ? hashiCfg.token.trim() : null;
  const timeoutMs = Number.isFinite(Number(hashiCfg.refresh_timeout_ms)) ? Number(hashiCfg.refresh_timeout_ms) : 10000;
  const requireFresh = hashiCfg.require_fresh === false ? false : true;

  function portUrl(p) {
    return `http://${host}:${p}`;
  }

  let baseUrl = portUrl(port);
  const statsPath = resolveHashiStatsPath(cfg);
  const beforeMtime = statsPath && fs.existsSync(statsPath) ? fs.statSync(statsPath).mtimeMs : 0;

  try {
    const ping = await httpGetJson(`${baseUrl}/ping`, 1500);
    if (!ping || ping.ok !== true || ping.name !== "Hashi") {
      throw new Error("not_hashi");
    }
  } catch {
    // Common case: AnkiConnect is on 8765. Try the next port as a convenience.
    const altPort = port === 8765 ? 8766 : 8766;
    if (altPort !== port) {
      try {
        const altUrl = portUrl(altPort);
        const ping2 = await httpGetJson(`${altUrl}/ping`, 1500);
        if (ping2 && ping2.ok === true && ping2.name === "Hashi") {
          baseUrl = altUrl;
        }
      } catch {
        // ignore
      }
    }

    if (baseUrl === portUrl(port)) {
      // Keep baseUrl as-is and fall through to normal error handling.
    }

    if (!requireFresh) return;
    const hasFile = statsPath && fs.existsSync(statsPath);
    if (hasFile) {
      const ageMs = Date.now() - fs.statSync(statsPath).mtimeMs;
      if (ageMs <= 10 * 60 * 1000) {
        console.warn("Hashi not reachable, using recent existing export:", statsPath);
        return;
      }
    }
    throw new Error(
      `Hashi not detected on ${portUrl(port)}. If you use AnkiConnect, it often occupies port 8765; set Hashi to 8766 in Hashi rules.json and in Tokei config.`
    );
  }

  const exportUrl = token ? `${baseUrl}/export?token=${encodeURIComponent(token)}` : `${baseUrl}/export`;
  const exportResp = await httpGetJson(exportUrl, 5000);
  if (!exportResp || exportResp.ok !== true || exportResp.name !== "Hashi") {
    throw new Error(
      `Unexpected response from ${baseUrl}/export. This port may be occupied by another add-on (common: AnkiConnect on 8765).`
    );
  }

  if (!statsPath) return;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(statsPath)) {
      const mtime = fs.statSync(statsPath).mtimeMs;
      if (mtime > beforeMtime) return;
    }
    await sleep(250);
  }

  if (requireFresh) {
    throw new Error(
      `Hashi export did not update at ${statsPath}. Is Anki running and unlocked, and is Hashi output_dir set to "hashi_exports"?`
    );
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return result;
}

function askYesNo(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const v = (answer || "").trim().toLowerCase();
      resolve(v === "y" || v === "yes");
    });
  });
}

async function renderHtmlAndPng({ statsJsonPath, htmlOutPath, pngOutPath }) {
  const pyRenderer = path.join(appRoot, "src", "tokei", "render_dashboard_html.py");
  const r = run("python", [pyRenderer, statsJsonPath, htmlOutPath], { cwd: appRoot });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    throw new Error(`render_dashboard_html.py failed (code ${r.status})\n${err}`);
  }

  ensureDir(path.dirname(pngOutPath));

  const browser = await puppeteer.launch({ headless: "new" });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1100 });
    await page.goto(`file://${path.resolve(htmlOutPath)}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: pngOutPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const cfg = loadConfig();
  const cacheDir = path.join(__dirname, "cache");
  const outputDirCfg = typeof cfg.output_dir === "string" ? cfg.output_dir.trim() : "";
  const outDir = outputDirCfg
    ? (path.isAbsolute(outputDirCfg) ? outputDirCfg : path.resolve(appRoot, outputDirCfg))
    : path.join(appRoot, "output");
  ensureDir(cacheDir);
  ensureDir(outDir);

  await refreshHashiExport(cfg);

  const syncScript = path.join(__dirname, "tools", "tokei_sync.py");
  let r = run("python", [syncScript], { cwd: appRoot });
  if (r.error) throw r.error;

  if (r.status === 2) {
    let info = null;
    try {
      info = JSON.parse((r.stdout || "").trim());
    } catch {
      info = null;
    }
    const reportNo = info?.report_no ?? "?";
    const generatedAt = info?.generated_at ?? "";
    console.log(`A report has already been generated for today (Report #${reportNo}${generatedAt ? ` at ${generatedAt}` : ""}).`);
    const ok = await askYesNo("Generate a second report for today? (y/N) ");
    if (!ok) return;
    r = run("python", [syncScript, "--allow-same-day"], { cwd: appRoot });
    if (r.error) throw r.error;
  }

  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    throw new Error(`python ${syncScript} failed (code ${r.status})\n${err}`);
  }

  const statsJsonPath = (r.stdout || "").trim();

  const stats = JSON.parse(fs.readFileSync(statsJsonPath, "utf8"));
  const reportNo = stats.report_no ?? "latest";
  const htmlOutPath = path.join(outDir, `Tokei Report ${reportNo}.html`);
  const pngOutPath = path.join(outDir, `Tokei Report ${reportNo}.png`);
  const warnings = Array.isArray(stats.warnings) ? stats.warnings : [];
  const warningsOutPath = path.join(outDir, `Tokei Report ${reportNo} WARNINGS.txt`);

  await renderHtmlAndPng({ statsJsonPath, htmlOutPath, pngOutPath });

  console.log("Wrote:");
  console.log(" ", htmlOutPath);
  console.log(" ", pngOutPath);
  if (warnings.length) {
    fs.writeFileSync(warningsOutPath, warnings.join("\n") + "\n", "utf8");
    console.log();
    console.log("Warnings:");
    for (const w of warnings) console.log(" -", String(w));
    console.log(" ", warningsOutPath);
  }
}

main().catch((e) => {
  console.error("Tokei failed:", e?.stack || e);
  process.exit(1);
});
