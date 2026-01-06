// Minimal local UI server for Tokei: setup + validation + run.
// Runs on localhost only and is intended for personal/desktop use.
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appRoot = process.env.TOKEI_APP_ROOT ? path.resolve(process.env.TOKEI_APP_ROOT) : path.resolve(__dirname, "..");
const userRoot = process.env.TOKEI_USER_ROOT ? path.resolve(process.env.TOKEI_USER_ROOT) : appRoot;

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function text(res, code, body, contentType = "text/plain; charset=utf-8") {
  const buf = Buffer.from(String(body || ""), "utf8");
  res.writeHead(code, { "Content-Type": contentType, "Content-Length": String(buf.length), "Cache-Control": "no-store" });
  res.end(buf);
}

function notFound(res) {
  text(res, 404, "not_found\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: "missing", value: null };
    let t = fs.readFileSync(filePath, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return { ok: true, error: null, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), value: null };
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
  fs.renameSync(tmp, filePath);
}

function getConfigPath() {
  return path.join(userRoot, "config.json");
}

function getTokenPath() {
  return path.join(userRoot, "toggl-token.txt");
}

function getRuntimeLogPath() {
  return path.join(userRoot, "logs", "runtime.log");
}

function getLatestStatsPath() {
  return path.join(userRoot, "cache", "latest_stats.json");
}

function getLatestSyncPath() {
  return path.join(userRoot, "cache", "latest_sync.json");
}

function getGsmPluginFolder() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  return path.join(appdata, "GameSentenceMiner");
}

function getDefaultGsmExePath() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  return path.join(local, "Programs", "gamesentenceminer", "GameSentenceMiner.exe");
}

function getKnownCsvPath() {
  return path.join(userRoot, "data", "known.csv");
}

function launchExe(exePath) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", exePath], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    return;
  }
  spawn(exePath, [], { stdio: "ignore", detached: true, windowsHide: true }).unref();
}

function getGsmPluginFile() {
  const folder = getGsmPluginFolder();
  return folder ? path.join(folder, "plugins.py") : null;
}

function getBundledGsmPluginSnippetPath() {
  return path.join(appRoot, "extras", "gsm-plugin", "plugins.py");
}

function getBundledGsmHelperPath() {
  return path.join(appRoot, "extras", "gsm-plugin", "tokei_live_sync.py");
}

function getGsmHelperFile() {
  const folder = getGsmPluginFolder();
  return folder ? path.join(folder, "tokei_live_sync.py") : null;
}

function readTextFileOrNull(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
  } catch {
    return null;
  }
}

function getDefaultTokeiRootForExternalTools() {
  const tokeiRoot = (process.env.TOKEI_USER_ROOT || "").trim();
  if (tokeiRoot) return tokeiRoot;
  const appdata = (process.env.APPDATA || "").trim();
  return appdata ? path.join(appdata, "Tokei") : null;
}

function getGsmLiveDbPath() {
  const root = getDefaultTokeiRootForExternalTools();
  return root ? path.join(root, "cache", "gsm_live.sqlite") : null;
}

function openExternal(target) {
  const plat = process.platform;
  if (plat === "win32") {
    spawn("cmd", ["/c", "start", "", target], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (plat === "darwin") {
    spawn("open", [target], { stdio: "ignore", detached: true }).unref();
    return;
  }
  spawn("xdg-open", [target], { stdio: "ignore", detached: true }).unref();
}

async function getElectronAppOrNull() {
  try {
    if (!process.versions || !process.versions.electron) return null;
    const mod = await import("electron");
    return mod && mod.app ? mod.app : null;
  } catch {
    return null;
  }
}

async function getElectronDialogOrNull() {
  try {
    if (!process.versions || !process.versions.electron) return null;
    const mod = await import("electron");
    return mod && mod.dialog ? mod.dialog : null;
  } catch {
    return null;
  }
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

function getNodeRunnerEnv() {
  const env = { ...process.env };
  if (process.versions && process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  try {
    const cacheDir = path.join(appRoot, "puppeteer-cache");
    if (!env.PUPPETEER_CACHE_DIR && fs.existsSync(cacheDir)) env.PUPPETEER_CACHE_DIR = cacheDir;
  } catch {
    // ignore
  }
  return env;
}

function resolveHashiStatsPath(cfg) {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const profile = typeof cfg?.anki_profile === "string" && cfg.anki_profile.trim() ? cfg.anki_profile.trim() : "User 1";

  let outputDir = "hashi_exports";
  let usingInternalProducer = false;
  try {
    const ankiSnap = cfg?.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : null;
    if (ankiSnap && ankiSnap.enabled === true) {
      const od = ankiSnap.output_dir;
      if (typeof od === "string" && od.trim()) outputDir = od.trim();
      usingInternalProducer = true;
    }
  } catch {
    // ignore
  }

  if (!usingInternalProducer) {
    try {
      const rulesPath = path.join(appdata, "Anki2", "addons21", "Hashi", "rules.json");
      const raw = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
      const cfgOut = raw?.settings?.output_dir;
      if (typeof cfgOut === "string" && cfgOut.trim()) outputDir = cfgOut.trim();
    } catch {
      // ignore
    }
  }

  if (path.isAbsolute(outputDir)) return path.join(outputDir, "anki_stats_snapshot.json");
  return path.join(appdata, "Anki2", profile, outputDir, "anki_stats_snapshot.json");
}

function getDefaultOutputDir() {
  const home = os.homedir ? os.homedir() : "";
  if (!home) return path.join(userRoot, "output");
  return path.join(home, "Pictures", "Tokei");
}

function getLegacyDefaultOutputDir() {
  const home = os.homedir ? os.homedir() : "";
  if (!home) return null;
  return path.join(home, "Documents", "Tokei", "output");
}

function resolveOutputRoot(cfg) {
  const raw = typeof cfg?.output_dir === "string" ? cfg.output_dir.trim() : "";
  const legacy = getLegacyDefaultOutputDir();
  const outputDirCfg = legacy && raw && path.resolve(raw) === path.resolve(legacy) ? "" : raw;
  const defaultOutRoot = getDefaultOutputDir();
  if (!outputDirCfg) return defaultOutRoot;
  if (path.isAbsolute(outputDirCfg)) return outputDirCfg;
  return path.resolve(defaultOutRoot, outputDirCfg);
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/env") {
    return json(res, 200, { ok: true, appRoot, userRoot, platform: process.platform, node: process.version });
  }

  if (req.method === "POST" && p === "/api/dialog/open-folder") {
    const dialog = await getElectronDialogOrNull();
    if (!dialog) return json(res, 200, { ok: false, error: "not_electron" });
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    const title = typeof parsed?.title === "string" ? parsed.title : "Select folder";
    try {
      const r = await dialog.showOpenDialog({ title, properties: ["openDirectory"] });
      const filePaths = Array.isArray(r?.filePaths) ? r.filePaths : [];
      const first = filePaths.length ? String(filePaths[0]) : "";
      return json(res, 200, { ok: !r.canceled && !!first, canceled: !!r.canceled, path: first });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && p === "/api/dialog/open-file") {
    const dialog = await getElectronDialogOrNull();
    if (!dialog) return json(res, 200, { ok: false, error: "not_electron" });
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    const title = typeof parsed?.title === "string" ? parsed.title : "Select file";
    const filters = Array.isArray(parsed?.filters) ? parsed.filters : undefined;
    try {
      const r = await dialog.showOpenDialog({ title, filters, properties: ["openFile"] });
      const filePaths = Array.isArray(r?.filePaths) ? r.filePaths : [];
      const first = filePaths.length ? String(filePaths[0]) : "";
      return json(res, 200, { ok: !r.canceled && !!first, canceled: !!r.canceled, path: first });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && p === "/api/app/quit") {
    const app = await getElectronAppOrNull();
    if (!app) return json(res, 200, { ok: false, error: "not_electron" });
    json(res, 200, { ok: true });
    setTimeout(() => {
      try {
        app.quit();
      } catch {
        // ignore
      }
    }, 50);
    return;
  }

  if (req.method === "POST" && p === "/api/app/restart") {
    const app = await getElectronAppOrNull();
    if (!app) return json(res, 200, { ok: false, error: "not_electron" });
    json(res, 200, { ok: true });
    setTimeout(() => {
      try {
        app.relaunch();
        app.exit(0);
      } catch {
        // ignore
      }
    }, 50);
    return;
  }

  if (req.method === "GET" && p === "/api/config") {
    const cfgPath = getConfigPath();
    const r = safeReadJson(cfgPath);
    return json(res, 200, { ok: r.ok, path: cfgPath, error: r.error, config: r.value || {} });
  }

  if (req.method === "GET" && p === "/api/paths") {
    const cfg = safeReadJson(getConfigPath()).value || {};
    const outRoot = resolveOutputRoot(cfg);
    const htmlDir = path.join(outRoot, "HTML");
    const latest = safeReadJson(getLatestStatsPath()).value || null;
    const reportNo = latest?.report_no ?? null;
    const htmlPath = reportNo != null ? path.join(htmlDir, `Tokei Report ${reportNo}.html`) : null;
    const statsPath = resolveHashiStatsPath(cfg);
    return json(res, 200, {
      ok: true,
      configPath: getConfigPath(),
      tokenPath: getTokenPath(),
      runtimeLogPath: getRuntimeLogPath(),
      latestStatsPath: getLatestStatsPath(),
      latestSyncPath: getLatestSyncPath(),
      outRoot,
      htmlDir,
      latestHtmlPath: htmlPath,
      ankiStatsPath: statsPath,
    });
  }

  if (req.method === "POST" && p === "/api/config") {
    const cfgPath = getConfigPath();
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return json(res, 400, { ok: false, error: `invalid_json: ${String(e?.message || e)}` });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(res, 400, { ok: false, error: "config must be a JSON object" });
    }
    try {
      writeJsonAtomic(cfgPath, parsed);
      return json(res, 200, { ok: true, path: cfgPath });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "GET" && p === "/api/toggl-token") {
    const tokenPath = getTokenPath();
    if (!fs.existsSync(tokenPath)) return json(res, 200, { ok: true, path: tokenPath, present: false, token: "" });
    try {
      const t = fs.readFileSync(tokenPath, "utf8").replace(/^\ufeff/, "").trim();
      return json(res, 200, { ok: true, path: tokenPath, present: true, token: t });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && p === "/api/toggl-token") {
    const tokenPath = getTokenPath();
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      return json(res, 400, { ok: false, error: `invalid_json: ${String(e?.message || e)}` });
    }
    const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, token ? token + "\n" : "", "utf8");
      return json(res, 200, { ok: true, path: tokenPath, present: Boolean(token) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "GET" && p === "/api/runtime-log") {
    const logPath = getRuntimeLogPath();
    const n = Math.max(50, Math.min(2000, Number(url.searchParams.get("lines") || "400")));
    if (!fs.existsSync(logPath)) return json(res, 200, { ok: true, path: logPath, lines: [] });
    try {
      const t = fs.readFileSync(logPath, "utf8");
      const lines = t.split(/\r?\n/).filter((x) => x !== "");
      return json(res, 200, { ok: true, path: logPath, lines: lines.slice(-n) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "GET" && p === "/api/latest-stats") {
    const statsPath = getLatestStatsPath();
    const r = safeReadJson(statsPath);
    return json(res, 200, { ok: r.ok, path: statsPath, error: r.error, stats: r.value });
  }

  if (req.method === "GET" && p === "/api/latest-sync") {
    const syncPath = getLatestSyncPath();
    const r = safeReadJson(syncPath);
    return json(res, 200, { ok: r.ok, path: syncPath, error: r.error, sync: r.value });
  }

  if (req.method === "POST" && p === "/api/anki/discover") {
    const cfg = safeReadJson(getConfigPath()).value || {};
    const profile = typeof cfg?.anki_profile === "string" && cfg.anki_profile.trim() ? cfg.anki_profile.trim() : "User 1";
    const py = getPythonCommand();
    const pyArgs = [...getPythonArgsPrefix(), path.join(appRoot, "tools", "tokei_anki_export.py"), "--discover", "--profile", profile];
    const r = await runProcess(py, pyArgs, { cwd: appRoot, env: process.env });
    let payload = null;
    try {
      payload = JSON.parse((r.stdout || "").trim());
    } catch {
      payload = null;
    }
    return json(res, 200, { ok: r.code === 0, code: r.code, payload, stderr: (r.stderr || "").trim() });
  }

  if (req.method === "POST" && p === "/api/anki/test-export") {
    const cfg = safeReadJson(getConfigPath()).value || {};
    const statsPath = resolveHashiStatsPath(cfg);
    const beforeMtime = statsPath && fs.existsSync(statsPath) ? fs.statSync(statsPath).mtimeMs : 0;
    const py = getPythonCommand();
    const pyArgs = [...getPythonArgsPrefix(), path.join(appRoot, "tools", "tokei_anki_export.py"), "--trigger", "ui_test"];
    const r = await runProcess(py, pyArgs, { cwd: appRoot, env: process.env });
    const afterMtime = statsPath && fs.existsSync(statsPath) ? fs.statSync(statsPath).mtimeMs : 0;
    const stats = statsPath ? safeReadJson(statsPath).value : null;
    const exportedAt = stats?.meta?.exported_at || null;
    return json(res, 200, {
      ok: r.code === 0,
      code: r.code,
      statsPath,
      mtimeAdvanced: afterMtime > beforeMtime,
      exported_at: exportedAt,
      stderr: (r.stderr || "").trim(),
    });
  }

  if (req.method === "POST" && p === "/api/puppeteer/test") {
    const puppeteerPath = path.join(appRoot, "node_modules", "puppeteer", "package.json");
    if (!fs.existsSync(puppeteerPath)) {
      return json(res, 200, { ok: false, error: "puppeteer_not_installed", expected: puppeteerPath });
    }
    try {
      const cacheDir = path.join(appRoot, "puppeteer-cache");
      if (!process.env.PUPPETEER_CACHE_DIR && fs.existsSync(cacheDir)) process.env.PUPPETEER_CACHE_DIR = cacheDir;
    } catch {
      // ignore
    }
    const cacheDir = path.join(userRoot, "cache");
    const outDir = path.join(userRoot, "output");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(cacheDir, "ui_puppeteer_test.html");
    const pngPath = path.join(outDir, "Tokei UI Puppeteer Test.png");
    fs.writeFileSync(
      htmlPath,
      "<!doctype html><meta charset=utf-8><title>Tokei Test</title><style>body{font-family:system-ui;padding:24px}h1{margin:0}</style><h1>Tokei UI Test</h1><p>If you can see this, Puppeteer can render HTML.</p>",
      "utf8"
    );
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.default.launch({ headless: "new" });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 800, height: 600 });
        await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: "networkidle0" });
        await page.screenshot({ path: pngPath, fullPage: true });
      } finally {
        await browser.close();
      }
      return json(res, 200, { ok: true, htmlPath, pngPath });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.stack || e) });
    }
  }

  if (req.method === "POST" && p === "/api/python/check") {
    const py = getPythonCommand();
    const r = await runProcess(py, ["--version"], { cwd: appRoot, env: process.env });
    const ok = r.code === 0;
    const v = (r.stdout || r.stderr || "").trim();
    return json(res, 200, { ok, python: py, version: v, code: r.code });
  }

  if (req.method === "GET" && p === "/api/gsm/plugin-snippet") {
    const snippetPath = getBundledGsmPluginSnippetPath();
    const helperPath = getBundledGsmHelperPath();
    const pluginFolder = getGsmPluginFolder();
    const pluginFile = getGsmPluginFile();
    const pluginFileExists = pluginFile ? fs.existsSync(pluginFile) : false;
    const helperFile = getGsmHelperFile();
    const helperFileExists = helperFile ? fs.existsSync(helperFile) : false;
    try {
      if (!fs.existsSync(snippetPath)) {
        return json(res, 200, {
          ok: false,
          error: "snippet_missing",
          snippetPath,
          helperPath,
          pluginFolder,
          pluginFile,
          pluginFileExists,
          helperFile,
          helperFileExists,
        });
      }
      if (!fs.existsSync(helperPath)) {
        return json(res, 200, {
          ok: false,
          error: "helper_missing",
          snippetPath,
          helperPath,
          pluginFolder,
          pluginFile,
          pluginFileExists,
          helperFile,
          helperFileExists,
        });
      }
      const snippet = fs.readFileSync(snippetPath, "utf8").replace(/^\ufeff/, "");
      const helper = fs.readFileSync(helperPath, "utf8").replace(/^\ufeff/, "");
      return json(res, 200, {
        ok: true,
        snippetPath,
        helperPath,
        pluginFolder,
        pluginFile,
        pluginFileExists,
        helperFile,
        helperFileExists,
        snippet,
        helper_filename: "tokei_live_sync.py",
        helper_snippet: helper,
      });
    } catch (e) {
      return json(res, 500, {
        ok: false,
        error: String(e?.message || e),
        snippetPath,
        helperPath,
        pluginFolder,
        pluginFile,
        pluginFileExists,
        helperFile,
        helperFileExists,
      });
    }
  }

  if (req.method === "POST" && p === "/api/gsm/open-folder") {
    const folder = getGsmPluginFolder();
    if (!folder) return json(res, 200, { ok: false, error: "APPDATA_missing" });
    try {
      openExternal(folder);
      return json(res, 200, { ok: true, folder });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), folder });
    }
  }

  if (req.method === "POST" && p === "/api/gsm/launch") {
    const exePath = getDefaultGsmExePath();
    if (!exePath) return json(res, 200, { ok: false, error: "LOCALAPPDATA_missing" });
    if (!fs.existsSync(exePath)) {
      const folder = path.dirname(exePath);
      try {
        openExternal(folder);
      } catch {
        // ignore
      }
      return json(res, 200, { ok: false, error: "gsm_exe_not_found", exePath, openedFolder: folder });
    }
    try {
      launchExe(exePath);
      return json(res, 200, { ok: true, exePath });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), exePath });
    }
  }

  if (req.method === "POST" && p === "/api/known/open-folder") {
    const filePath = getKnownCsvPath();
    const folder = path.dirname(filePath);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      // ignore
    }
    try {
      openExternal(folder);
      return json(res, 200, { ok: true, folder });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), folder });
    }
  }

  if (req.method === "POST" && p === "/api/known/open-file") {
    const filePath = getKnownCsvPath();
    try {
      openExternal(filePath);
      return json(res, 200, { ok: true, filePath, exists: fs.existsSync(filePath) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), filePath });
    }
  }

  if (req.method === "POST" && p === "/api/known/import") {
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    const filename = typeof parsed?.filename === "string" ? parsed.filename.trim() : "known.csv";
    const content = typeof parsed?.content === "string" ? parsed.content : "";
    if (!content) return json(res, 400, { ok: false, error: "missing content" });
    if (content.length > 5_000_000) return json(res, 400, { ok: false, error: "content too large" });

    const destPath = getKnownCsvPath();
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), destPath });
    }

    let backupPath = null;
    try {
      if (fs.existsSync(destPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        backupPath = `${destPath}.bak-${stamp}`;
        fs.copyFileSync(destPath, backupPath);
      }
    } catch (e) {
      return json(res, 500, { ok: false, error: `failed_to_backup: ${String(e?.message || e)}`, destPath, backupPath });
    }

    try {
      const normalized = content.endsWith("\n") ? content : content + "\n";
      fs.writeFileSync(destPath, normalized, "utf8");
      return json(res, 200, { ok: true, destPath, backupPath, filename });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), destPath, backupPath, filename });
    }
  }

  if (req.method === "POST" && p === "/api/gsm/open-plugin-file") {
    const pluginFile = getGsmPluginFile();
    if (!pluginFile) return json(res, 200, { ok: false, error: "APPDATA_missing" });
    try {
      openExternal(pluginFile);
      return json(res, 200, { ok: true, pluginFile, exists: fs.existsSync(pluginFile) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), pluginFile });
    }
  }

  if (req.method === "POST" && p === "/api/gsm/open-helper-file") {
    const helperFile = getGsmHelperFile();
    if (!helperFile) return json(res, 200, { ok: false, error: "APPDATA_missing" });
    try {
      openExternal(helperFile);
      return json(res, 200, { ok: true, helperFile, exists: fs.existsSync(helperFile) });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), helperFile });
    }
  }

  if (req.method === "GET" && p === "/api/gsm/status") {
    const pluginFolder = getGsmPluginFolder();
    const pluginFile = getGsmPluginFile();
    const helperFile = getGsmHelperFile();
    const dbPath = getGsmLiveDbPath();

    const pluginText = pluginFile ? readTextFileOrNull(pluginFile) : null;
    const helperExists = Boolean(helperFile && fs.existsSync(helperFile));
    const pluginExists = Boolean(pluginFile && fs.existsSync(pluginFile));
    const dbExists = Boolean(dbPath && fs.existsSync(dbPath));

    const shimPresent =
      typeof pluginText === "string" &&
      pluginText.includes("import tokei_live_sync") &&
      (pluginText.includes("tokei_live_sync.main") || pluginText.includes("tokei_live_sync.main()"));

    let dbMtime = null;
    try {
      if (dbExists && dbPath) dbMtime = new Date(fs.statSync(dbPath).mtimeMs).toISOString();
    } catch {
      dbMtime = null;
    }

    return json(res, 200, {
      ok: true,
      pluginFolder,
      pluginFile,
      pluginExists,
      helperFile,
      helperExists,
      shimPresent,
      dbPath,
      dbExists,
      dbMtime,
      tokeiUserRoot: process.env.TOKEI_USER_ROOT || null,
    });
  }

  if (req.method === "POST" && p === "/api/gsm/install-helper") {
    const helperFile = getGsmHelperFile();
    const helperPath = getBundledGsmHelperPath();
    if (!helperFile) return json(res, 200, { ok: false, error: "APPDATA_missing" });
    if (!fs.existsSync(helperPath)) return json(res, 200, { ok: false, error: "helper_missing", helperPath });

    try {
      fs.mkdirSync(path.dirname(helperFile), { recursive: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), helperFile });
    }

    const desired = readTextFileOrNull(helperPath);
    if (desired == null) return json(res, 500, { ok: false, error: "failed_to_read_bundled_helper", helperPath });

    const existing = readTextFileOrNull(helperFile);
    if (existing != null && existing === desired) {
      return json(res, 200, { ok: true, helperFile, changed: false, backupPath: null });
    }

    let backupPath = null;
    if (existing != null && existing !== desired) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${helperFile}.bak-${stamp}`;
      try {
        fs.writeFileSync(backupPath, existing, "utf8");
      } catch (e) {
        return json(res, 500, { ok: false, error: `failed_to_write_backup: ${String(e?.message || e)}`, helperFile, backupPath });
      }
    }

    try {
      fs.writeFileSync(helperFile, desired.endsWith("\n") ? desired : desired + "\n", "utf8");
      return json(res, 200, { ok: true, helperFile, changed: true, backupPath });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), helperFile, backupPath });
    }
  }

  if (req.method === "POST" && p === "/api/sync") {
    const args = ["Tokei.mjs", "--no-setup", "--no-pause", "--sync-only"];

    const script = path.join(appRoot, "Tokei.mjs");
    const nodeArgs = [script, ...args.slice(1)];
    const env = { ...getNodeRunnerEnv(), TOKEI_APP_ROOT: appRoot, TOKEI_USER_ROOT: userRoot };
    const r = await runProcess(process.execPath, nodeArgs, { cwd: appRoot, env });

    const latestSync = safeReadJson(getLatestSyncPath()).value;

    return json(res, 200, {
      ok: r.code === 0,
      code: r.code,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
      latest_sync: latestSync,
    });
  }

  if (req.method === "POST" && p === "/api/generate-report") {
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }

    const mode = String(parsed?.mode || "overwrite");
    const syncBefore = parsed?.sync_before_report === false ? false : true;

    const script = path.join(appRoot, "Tokei.mjs");
    const env = { ...getNodeRunnerEnv(), TOKEI_APP_ROOT: appRoot, TOKEI_USER_ROOT: userRoot };

    let stdoutCombined = "";
    let stderrCombined = "";

    if (syncBefore) {
      const syncArgs = ["Tokei.mjs", "--no-setup", "--no-pause", "--sync-only"];
      const syncNodeArgs = [script, ...syncArgs.slice(1)];
      const rSync = await runProcess(process.execPath, syncNodeArgs, { cwd: appRoot, env });
      stdoutCombined += (rSync.stdout || "").trim();
      stderrCombined += (rSync.stderr || "").trim();
      if (rSync.code !== 0) {
        const latest = safeReadJson(getLatestStatsPath()).value;
        const latestSync = safeReadJson(getLatestSyncPath()).value;
        const cfg = safeReadJson(getConfigPath()).value || {};
        const statsPath = resolveHashiStatsPath(cfg);
        const ankiStats = statsPath ? safeReadJson(statsPath).value : null;
        const exportedAt = ankiStats?.meta?.exported_at || null;
        return json(res, 200, {
          ok: false,
          code: rSync.code,
          stdout: stdoutCombined,
          stderr: stderrCombined,
          latest_stats: latest,
          latest_sync: latestSync,
          anki_exported_at: exportedAt,
        });
      }
    }

    const reportArgs = ["Tokei.mjs", "--no-setup", "--no-pause"];
    // If we just synced, render from that snapshot to avoid duplicate source reads.
    if (syncBefore) reportArgs.push("--no-sync");
    else reportArgs.push("--no-sync");
    if (mode === "new") reportArgs.push("--allow-same-day");
    if (mode === "overwrite") reportArgs.push("--overwrite-today");

    const reportNodeArgs = [script, ...reportArgs.slice(1)];
    const r = await runProcess(process.execPath, reportNodeArgs, { cwd: appRoot, env });

    if (stdoutCombined) stdoutCombined += "\n\n";
    if (stderrCombined) stderrCombined += "\n\n";
    stdoutCombined += (r.stdout || "").trim();
    stderrCombined += (r.stderr || "").trim();

    const latest = safeReadJson(getLatestStatsPath()).value;
    const latestSync = safeReadJson(getLatestSyncPath()).value;
    const cfg = safeReadJson(getConfigPath()).value || {};
    const statsPath = resolveHashiStatsPath(cfg);
    const ankiStats = statsPath ? safeReadJson(statsPath).value : null;
    const exportedAt = ankiStats?.meta?.exported_at || null;

    return json(res, 200, {
      ok: r.code === 0,
      code: r.code,
      stdout: stdoutCombined,
      stderr: stderrCombined,
      latest_stats: latest,
      latest_sync: latestSync,
      anki_exported_at: exportedAt,
    });
  }

  if (req.method === "POST" && p === "/api/run") {
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    const mode = String(parsed?.mode || "overwrite");
    const args = ["Tokei.mjs", "--no-setup", "--no-pause"];
    if (mode === "new") args.push("--allow-same-day");
    if (mode === "overwrite") args.push("--overwrite-today");

    const script = path.join(appRoot, "Tokei.mjs");
    const nodeArgs = [script, ...args.slice(1)];
    const env = { ...getNodeRunnerEnv(), TOKEI_APP_ROOT: appRoot, TOKEI_USER_ROOT: userRoot };
    const r = await runProcess(process.execPath, nodeArgs, { cwd: appRoot, env });

    const latest = safeReadJson(getLatestStatsPath()).value;
    const cfg = safeReadJson(getConfigPath()).value || {};
    const statsPath = resolveHashiStatsPath(cfg);
    const ankiStats = statsPath ? safeReadJson(statsPath).value : null;
    const exportedAt = ankiStats?.meta?.exported_at || null;

    return json(res, 200, {
      ok: r.code === 0,
      code: r.code,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
      latest_stats: latest,
      latest_sync: safeReadJson(getLatestSyncPath()).value,
      anki_exported_at: exportedAt,
    });
  }

  if (req.method === "POST" && p === "/api/open-output") {
    const cfg = safeReadJson(getConfigPath()).value || {};
    const outRoot = resolveOutputRoot(cfg);
    try {
      openExternal(outRoot);
      return json(res, 200, { ok: true, outRoot });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && p === "/api/open-latest-html") {
    const cfg = safeReadJson(getConfigPath()).value || {};
    const outRoot = resolveOutputRoot(cfg);
    const htmlDir = path.join(outRoot, "HTML");
    const latest = safeReadJson(getLatestStatsPath()).value || null;
    const reportNo = latest?.report_no ?? null;
    if (reportNo == null) return json(res, 200, { ok: false, error: "no_latest_report" });
    const htmlPath = path.join(htmlDir, `Tokei Report ${reportNo}.html`);
    try {
      openExternal(htmlPath);
      return json(res, 200, { ok: true, htmlPath });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && p === "/api/open") {
    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    const target = typeof parsed?.target === "string" ? parsed.target.trim() : "";
    if (!target) return json(res, 400, { ok: false, error: "missing target" });
    try {
      openExternal(target);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  return notFound(res);
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let p = url.pathname;
  if (p === "/") p = "/index.html";
  const root = path.join(__dirname, "static");
  const safePath = path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, "");
  const filePath = path.join(root, safePath);
  if (!filePath.startsWith(root)) return notFound(res);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return notFound(res);

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(buf.length), "Cache-Control": "no-store" });
  res.end(buf);
}

export function startTokeiUiServer({ host = "127.0.0.1", port = 0, open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/")) return await handleApi(req, res);
      return serveStatic(req, res);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.stack || e) });
    }
  });

  return new Promise((resolve, reject) => {
    try {
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : 0;
        const url = `http://${host}:${actualPort}/`;
        if (open) openExternal(url);
        resolve({ server, url, host, port: actualPort, appRoot, userRoot });
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function main() {
  const noOpen = process.argv.includes("--no-open");
  const started = await startTokeiUiServer({ open: !noOpen });
  console.log(`Tokei UI running at ${started.url}`);
  console.log(`App root:  ${started.appRoot}`);
  console.log(`User root: ${started.userRoot}`);
}

if (import.meta.url === `file://${__filename.replace(/\\/g, "/")}`) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
