const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const { pathToFileURL } = require("url");
const http = require("http");

let uiServer = null;
let uiUrl = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;

const tokeiUserRoot =
  (process.env.TOKEI_USER_ROOT && String(process.env.TOKEI_USER_ROOT).trim()) ||
  path.join(app.getPath("appData"), "Tokei");

process.env.TOKEI_USER_ROOT = tokeiUserRoot;
const devAppRoot = path.resolve(__dirname, "..");
process.env.TOKEI_APP_ROOT = process.env.TOKEI_APP_ROOT || (app.isPackaged ? app.getAppPath() : devAppRoot);

const configPath = path.join(tokeiUserRoot, "config.json");

try {
  const cacheDir = path.join(process.env.TOKEI_APP_ROOT, "puppeteer-cache");
  if (!process.env.PUPPETEER_CACHE_DIR && fs.existsSync(cacheDir)) process.env.PUPPETEER_CACHE_DIR = cacheDir;
} catch {
  // ignore
}

try {
  app.setPath("userData", path.join(tokeiUserRoot, "electron-ui"));
} catch {
  // ignore
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    let t = fs.readFileSync(filePath, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function readLaunchOptions() {
  const cfg = safeReadJson(configPath) || {};
  const launch = cfg && typeof cfg.launch === "object" ? cfg.launch : {};
  return {
    openOnStartup: launch.open_on_startup === true,
    startMinimizedToTray: launch.start_minimized_to_tray === true,
    closeMinimizesToTray: launch.close_minimizes_to_tray === true,
  };
}

function applyStartupSettings() {
  const opts = readLaunchOptions();
  try {
    // Windows/macOS only; safe no-op elsewhere.
    app.setLoginItemSettings({ openAtLogin: opts.openOnStartup });
  } catch {
    // ignore
  }
  return opts;
}

function getTrayIcon() {
  const candidates = [
    path.join(process.env.TOKEI_APP_ROOT, "assets", "tokei.ico"),
    path.join(process.env.TOKEI_APP_ROOT, "assets", "tokei.png"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return nativeImage.createFromPath(p);
    } catch {
      // ignore
    }
  }
  return nativeImage.createEmpty();
}

function uiRequest(method, apiPath, bodyObj) {
  return new Promise((resolve) => {
    try {
      if (!uiUrl) return resolve({ ok: false, error: "ui_not_ready" });
      const u = new URL(apiPath, uiUrl);
      const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), "utf8") : null;
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname + u.search,
          headers: body
            ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length) }
            : {},
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c.toString("utf8")));
          res.on("end", () => {
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve({ ok: false, error: "bad_json", status: res.statusCode, text });
            }
          });
        }
      );
      req.on("error", (e) => resolve({ ok: false, error: String(e?.message || e) }));
      if (body) req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

function showDashboard() {
  if (!mainWindow) return;
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript("window.__tokeiSelectTab && window.__tokeiSelectTab('run')").catch(() => {});
  } catch {
    // ignore
  }
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(getTrayIcon());
  tray.setToolTip("Tokei");

  tray.on("double-click", () => showDashboard());

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: () => showDashboard() },
      {
        label: "Sync Now",
        click: async () => {
          await uiRequest("POST", "/api/sync", {});
        },
      },
      {
        label: "Generate Report",
        click: async () => {
          await uiRequest("POST", "/api/generate-report", { mode: "overwrite", sync_before_report: true });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

  tray.setContextMenu(buildMenu());
  return tray;
}

function ensureAppMenu() {
  const openLogs = async () => {
    try {
      const logsDir = path.join(tokeiUserRoot, "logs");
      try {
        fs.mkdirSync(logsDir, { recursive: true });
      } catch {
        // ignore
      }
      await shell.openPath(logsDir);
    } catch {
      // ignore
    }
  };

  const template = [
    {
      label: "File",
      submenu: [
        { label: "Open Logs", click: () => void openLogs() },
        { type: "separator" },
        {
          label: "Restart",
          click: () => {
            isQuitting = true;
            try {
              app.relaunch();
              app.exit(0);
            } catch {
              app.quit();
            }
          },
        },
        {
          label: "Quit",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
  ];

  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch {
    // ignore
  }
}

function getInitialTab() {
  const cfg = safeReadJson(configPath);
  if (cfg && typeof cfg === "object") return "run";
  return "setup";
}

function createWindow({ show = true } = {}) {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    backgroundColor: "#0b0f14",
    show,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    autoHideMenuBar: false,
  });

  try {
    win.setMenuBarVisibility(true);
    win.autoHideMenuBar = false;
  } catch {
    // ignore
  }
  try {
    const u = new URL(uiUrl);
    u.searchParams.set("tab", getInitialTab());
    win.loadURL(u.toString());
  } catch {
    win.loadURL(uiUrl);
  }

  win.on("close", (e) => {
    if (isQuitting) return;
    const opts = readLaunchOptions();
    if (opts.closeMinimizesToTray) {
      e.preventDefault();
      ensureTray();
      win.hide();
    }
  });

  return win;
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    showDashboard();
  });

  const uiModulePath = path.join(__dirname, "..", "ui", "tokei_ui.mjs");
  const mod = await import(pathToFileURL(uiModulePath).href);
  const started = await mod.startTokeiUiServer({ open: false });
  uiServer = started.server;
  uiUrl = started.url;
  // eslint-disable-next-line no-console
  console.log(`Tokei Desktop UI at ${uiUrl}`);

  await app.whenReady();

  const opts = applyStartupSettings();
  if (opts.startMinimizedToTray || opts.closeMinimizesToTray) ensureTray();
  ensureAppMenu();

  mainWindow = createWindow({ show: !opts.startMinimizedToTray });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow({ show: true });
    else showDashboard();
  });

  // Live-reload launch settings when config.json changes.
  try {
    const cfgDir = path.dirname(configPath);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.watch(cfgDir, { persistent: false }, (evt, filename) => {
      if (!filename || String(filename).toLowerCase() !== "config.json") return;
      const newOpts = applyStartupSettings();
      if (newOpts.startMinimizedToTray || newOpts.closeMinimizesToTray) ensureTray();
    });
  } catch {
    // ignore
  }
}

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  const opts = readLaunchOptions();
  if (opts.closeMinimizesToTray || opts.startMinimizedToTray) return;
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  try {
    if (uiServer) uiServer.close();
  } catch {
    // ignore
  }
});

start().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e && e.stack ? e.stack : String(e));
  app.exit(1);
});
