// Tokei.mjs - APL-independent dashboard sync + HTML/PNG report generator.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import puppeteer from "puppeteer";
import readline from "readline";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = process.env.TOKEI_APP_ROOT ? path.resolve(process.env.TOKEI_APP_ROOT) : __dirname;
const userRoot = process.env.TOKEI_USER_ROOT ? path.resolve(process.env.TOKEI_USER_ROOT) : appRoot;

function loadConfig() {
  const configPath = path.join(userRoot, "config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function getConfigPath() {
  return path.join(userRoot, "config.json");
}

function getPythonCommand() {
  const cmd = process.env.TOKEI_PYTHON_EXE;
  return cmd && cmd.trim() ? cmd.trim() : "python";
}

function getPythonArgsPrefix() {
  const raw = process.env.TOKEI_PYTHON_ARGS;
  if (!raw || !raw.trim()) return [];
  return raw.split(" ").filter((v) => v.trim());
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

function promptText(prompt, defaultValue = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (press Enter to keep: ${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix} > `, (answer) => {
      rl.close();
      const trimmed = (answer || "").trim();
      resolve(trimmed === "" ? defaultValue : trimmed);
    });
  });
}

function parseHmsToHours(value) {
  const parts = value.trim().split(":");
  if (parts.length !== 3) {
    throw new Error("expected HH:MM:SS");
  }
  const [h, m, s] = parts.map((p) => Number(p));
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
    throw new Error("non-numeric values not allowed");
  }
  if (h < 0 || m < 0 || s < 0) {
    throw new Error("negative values not allowed");
  }
  if (m >= 60 || s >= 60) {
    throw new Error("minutes/seconds out of range");
  }
  return h + m / 60.0 + s / 3600.0;
}

function formatHmsFromHours(hours) {
  const total = Math.round(Number(hours || 0) * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function loadExampleConfig() {
  const examplePath = path.join(appRoot, "config.example.json");
  try {
    const raw = JSON.parse(fs.readFileSync(examplePath, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function getDefaultOutputDir() {
  const home = os.homedir ? os.homedir() : "";
  if (!home) return "output";
  return path.join(home, "Documents", "Tokei", "output");
}

async function ensureConfigOrSetup() {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) return loadConfig();

  if (process.argv.includes("--no-setup") || !process.stdin.isTTY) {
    throw new Error('config.json not found. Run "Setup-Tokei.bat" first.');
  }

  console.log("");
  console.log("=== Tokei Setup ===");
  console.log("");
  console.log("This will update: config.json");
  console.log("");

  const base = loadExampleConfig() || {
    anki_profile: "User 1",
    timezone: "local",
    theme: "midnight",
    output_dir: getDefaultOutputDir(),
    one_page: true,
    hashi: {
      host: "127.0.0.1",
      port: 8766,
      token: null,
      refresh_timeout_ms: 10000,
      require_fresh: true,
    },
    toggl: {
      start_date: "auto",
      refresh_days_back: 60,
      refresh_buffer_days: 2,
      chunk_days: 7,
      baseline_hours: 0,
    },
    ankimorphs: { known_interval_days: 21 },
    mokuro: { volume_data_path: "" },
    gsm: { db_path: "auto" },
  };
  base.output_dir = getDefaultOutputDir();

  const tokenDefault = "";
  console.log("Step 1: Toggl API token (optional but required for hours)");
  const token = await promptText("Enter Toggl API token (press Enter to skip)", tokenDefault);
  if (!token) {
    const ok = await askYesNo("No token entered. Tokei will NOT track immersion hours. Continue anyway? (y/N) ");
    if (!ok) {
      throw new Error("Setup cancelled.");
    }
  }

  console.log("");
  console.log("How to find your Toggl API token:");
  console.log(" - Toggl > Profile > Profile settings");
  console.log(" - Scroll to the very bottom to reveal your API token");
  console.log("");
  console.log("If you enter it here, it will be saved to: toggl-token.txt (plain text)");
  console.log("You can also set it via the TOGGL_API_TOKEN environment variable instead.");
  console.log("");

  let baselineHms = formatHmsFromHours(base?.toggl?.baseline_hours || 0);
  console.log("");
  console.log("You will be asked for a baseline lifetime time value (HH:MM:SS).");
  console.log("Tokei will add this baseline to the time it can fetch from Toggl (which may be limited).");
  console.log("");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const y = yesterday.getFullYear();
  const m = String(yesterday.getMonth() + 1).padStart(2, "0");
  const d = String(yesterday.getDate()).padStart(2, "0");
  const ymd = `${y}-${m}-${d}`;
  console.log("How to get baseline lifetime time from Toggl (recommended):");
  console.log(" 1) Go to Toggl Track > Reports > Summary:");
  console.log("    https://track.toggl.com/reports/summary");
  console.log(" 2) Set the date range:");
  console.log("    - Start: the earliest day you started tracking immersion");
  console.log(`    - End:   ${ymd}  (yesterday; do NOT include today in the baseline)`);
  console.log(" 3) Select your immersion project(s) (if you track multiple immersion projects, select them all)");
  console.log(" 4) Make sure you are viewing the correct workspace");
  console.log(' 5) Copy the "Total" hours shown at the top and enter it below');
  console.log("");
  console.log("Why end date is yesterday:");
  console.log(" - Tokei will fetch TODAY's time via the Toggl API and add it on top of this baseline.");
  console.log("");
  while (true) {
    const input = await promptText("Enter baseline lifetime time (HH:MM:SS)", baselineHms);
    try {
      base.toggl = base.toggl || {};
      base.toggl.baseline_hours = parseHmsToHours(input);
      break;
    } catch (e) {
      console.log(`Invalid baseline time: ${e.message}`);
    }
  }

  console.log("");
  base.timezone = await promptText("Timezone", base.timezone || "local");

  console.log("");
  const defaultTheme = "dark-graphite";
  console.log("Theme options (quick pick):");
  console.log(`  ${defaultTheme} (default)`);
  console.log("  bright-daylight");
  console.log("  sakura-night");
  console.log("");
  console.log("Press Enter for default, or type 'list' to show all themes.");
  console.log("");
  while (true) {
    const themeInput = await promptText("Theme", base.theme || defaultTheme);
    if (themeInput.toLowerCase() !== "list") {
      base.theme = themeInput;
      break;
    }
    console.log("");
    console.log("All themes:");
    console.log("  midnight");
    console.log("  sakura-night");
    console.log("  forest-dawn");
    console.log("  neutral-balanced");
    console.log("  dark-graphite");
    console.log("  solar-slate");
    console.log("  neon-arcade");
    console.log("  bright-daylight");
    console.log("  bright-mint");
    console.log("  bright-iris");
    console.log("");
    console.log("To preview themes, open the sample PNGs in: samples\\");
    console.log("");
  }

  console.log("");
  base.output_dir = await promptText(
    "Output folder (relative or absolute)",
    base.output_dir || getDefaultOutputDir()
  );

  console.log("");
  base.anki_profile = await promptText("Anki profile name", base.anki_profile || "User 1");

  fs.mkdirSync(userRoot, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2) + "\n", "utf8");

  if (token) {
    const tokenPath = path.join(userRoot, "toggl-token.txt");
    fs.writeFileSync(tokenPath, token + "\n", "utf8");
  }

  console.log("");
  console.log("Setup complete.");
  if (!process.env.TOKEI_PYTHON_EXE) {
    console.log("Next: run run.bat");
  }
  console.log("");
  return base;
}

async function renderHtmlAndPng({ statsJsonPath, htmlOutPath, pngOutPath }) {
  const pyRenderer = path.join(appRoot, "src", "tokei", "render_dashboard_html.py");
  const pyCmd = getPythonCommand();
  const pyArgs = [...getPythonArgsPrefix(), pyRenderer, statsJsonPath, htmlOutPath];
  const r = run(pyCmd, pyArgs, { cwd: appRoot });
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
  const overwriteToday = process.argv.includes("--overwrite-today");
  const cfg = await ensureConfigOrSetup();
  const cacheDir = path.join(userRoot, "cache");
  const outputDirCfg = typeof cfg.output_dir === "string" ? cfg.output_dir.trim() : "";
  const documentsRoot = os.homedir ? path.join(os.homedir(), "Documents") : userRoot;
  const tokeiDocumentsRoot = path.join(documentsRoot, "Tokei");
  const outDir = outputDirCfg
    ? (path.isAbsolute(outputDirCfg) ? outputDirCfg : path.resolve(tokeiDocumentsRoot, outputDirCfg))
    : path.join(tokeiDocumentsRoot, "output");
  ensureDir(cacheDir);
  ensureDir(outDir);

  await refreshHashiExport(cfg);

  const syncScript = path.join(__dirname, "tools", "tokei_sync.py");
  const syncArgs = [syncScript];
  if (overwriteToday) syncArgs.push("--overwrite-today");
  const pyCmd = getPythonCommand();
  const pyArgsPrefix = getPythonArgsPrefix();
  let r = run(pyCmd, [...pyArgsPrefix, ...syncArgs], { cwd: appRoot });
  if (r.error) throw r.error;

  if (r.status === 2 && !overwriteToday) {
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
    r = run(pyCmd, [...pyArgsPrefix, syncScript, "--allow-same-day"], { cwd: appRoot });
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
