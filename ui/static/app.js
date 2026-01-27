const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json_response", raw: text };
  }
}

function setStatus(el, msg, kind) {
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("good", "bad");
  if (kind) el.classList.add(kind);
}

function setText(el, msg) {
  if (!el) return;
  el.textContent = msg || "";
}

function normalizeText(s) {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

function extractPythonTerminalErrorLine(text) {
  const t = normalizeText(text);
  if (!t) return "";
  const lines = t.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || "").trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*Error:\s+/.test(line)) return line;
  }
  return "";
}

function toFriendlyErrorFromText(text) {
  const t = normalizeText(text);
  if (!t) return null;

  // Common Python traceback terminal line.
  const terminal = extractPythonTerminalErrorLine(t);
  const needle = terminal || t;

  if (needle.includes("anki_snapshot.enabled is false")) {
    return {
      error_code: "TKE-ANKI-EXPORT-DISABLED",
      title: "Anki snapshot export is turned off",
      message: "Tokei can’t export Anki stats until the built-in snapshot exporter is enabled.",
      steps: [
        "Open the Setup tab",
        'Enable “built-in Anki snapshot exporter”',
        "Click “Save config.json”",
        "Try again",
      ],
    };
  }

  if (needle.includes("anki_snapshot.rules is required") || needle.includes("anki_snapshot_rules_missing")) {
    return {
      error_code: "TKE-ANKI-RULES-MISSING",
      title: "Anki snapshot rules are missing",
      message: "The Anki snapshot exporter is enabled, but no rules are configured.",
      steps: [
        "Open the Setup tab",
        "Add at least one Anki snapshot rule (deck + target field)",
        "Click “Save config.json”",
        "Try again",
      ],
    };
  }

  if (needle.includes("Anki collection DB not found:")) {
    return {
      error_code: "TKE-ANKI-COLLECTION-NOT-FOUND",
      title: "Anki profile not found",
      message: "Tokei couldn’t find your Anki collection database for the selected profile.",
      steps: [
        "Make sure Anki is installed on this PC",
        "Open Anki once and confirm the profile exists",
        "In Setup, select the correct Anki profile",
        "Try again",
      ],
    };
  }

  if (needle.includes("APPDATA is not set")) {
    return {
      error_code: "TKE-ENV-APPDATA-MISSING",
      title: "Windows environment issue",
      message: "Tokei couldn’t locate required Windows paths (APPDATA).",
      steps: ["Restart your PC and try again", "If it still fails, open Logs and send runtime.log to support"],
    };
  }

  if (
    needle.includes("python was not found") ||
    needle.includes("Python was not found") ||
    (needle.includes("ENOENT") && needle.toLowerCase().includes("python"))
  ) {
    return {
      error_code: "TKE-PYTHON-NOT-FOUND",
      title: "Python is not available",
      message: "Anki snapshot/export needs Python, but Tokei couldn’t run it.",
      steps: ["In Setup, click “Check Python”", "Install Python if needed", "Try again"],
    };
  }

  return null;
}

function toFriendlyErrorFromApiResult(r) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.title === "string" && r.title.trim()) {
    return {
      error_code: typeof r.error_code === "string" ? r.error_code : null,
      title: r.title.trim(),
      message: typeof r.message === "string" ? r.message.trim() : "",
      steps: Array.isArray(r.steps) ? r.steps.map((s) => String(s)).filter(Boolean) : [],
    };
  }
  const raw = [r.error, r.stderr, r.raw].filter(Boolean).join("\n");
  return toFriendlyErrorFromText(raw);
}

function formatFriendlyErrorText(friendly) {
  if (!friendly) return "";
  const title = friendly.title ? `${friendly.title}` : "Error";
  const msg = friendly.message ? `\n${friendly.message}` : "";
  const steps =
    Array.isArray(friendly.steps) && friendly.steps.length
      ? `\n\nFix:\n- ${friendly.steps.join("\n- ")}`
      : "";
  const code = friendly.error_code ? `\n\nError code: ${friendly.error_code}` : "";
  return `${title}${msg}${steps}${code}`.trim();
}

function parseHmsToHours(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 3) throw new Error("expected HH:MM:SS");
  const [h, m, s] = parts.map((p) => Number(p));
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) throw new Error("non-numeric values not allowed");
  if (h < 0 || m < 0 || s < 0) throw new Error("negative values not allowed");
  if (m >= 60 || s >= 60) throw new Error("minutes/seconds out of range");
  return h + m / 60.0 + s / 3600.0;
}

function formatHmsFromHours(hours) {
  const total = Math.round(Number(hours || 0) * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let activeRuleRow = null;
let discoveredAnki = null;

const KNOWN_TABS = ["run", "setup", "sources", "getting-started", "logs"];

const WIZARD_VERSION = 1;
const WIZARD_SEEN_KEY = `tokei_setup_wizard_seen_v${WIZARD_VERSION}`;

const THEME_OPTIONS = [
  { id: "dark-graphite", label: "Dark Graphite (default)" },
  { id: "bright-daylight", label: "Bright Daylight" },
  { id: "sakura-night", label: "Sakura Night" },
  { id: "midnight", label: "Midnight" },
  { id: "forest-dawn", label: "Forest Dawn" },
  { id: "neutral-balanced", label: "Neutral Balanced" },
  { id: "solar-slate", label: "Solar Slate" },
  { id: "neon-arcade", label: "Neon Arcade" },
  { id: "bright-mint", label: "Bright Mint" },
  { id: "bright-iris", label: "Bright Iris" },
];

let currentEnv = null;
let wizardActiveRuleRow = null;

function setWizardActiveRuleRow(tr) {
  wizardActiveRuleRow = tr;
  const body = $("wiz-rules-body");
  if (!body) return;
  for (const row of body.querySelectorAll("tr")) row.classList.toggle("active-row", row === tr);
}

function ensureWizardActiveRow() {
  if (wizardActiveRuleRow && wizardActiveRuleRow.isConnected) return wizardActiveRuleRow;
  const body = $("wiz-rules-body");
  if (!body) return null;
  const first = body.querySelector("tr");
  if (first) setWizardActiveRuleRow(first);
  return wizardActiveRuleRow;
}

function wizardRuleRow(rule, onRemove) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="input rid" placeholder="rule_id" /></td>
    <td><input class="input decks" placeholder="Deck::Subdeck, Deck2::Subdeck" /></td>
    <td><input class="input field" placeholder="Field name (e.g. Expression)" /></td>
    <td><input class="input notetypes" placeholder="(optional) Note type A, Note type B" /></td>
    <td><label class="check"><input class="subdecks" type="checkbox" /> include</label></td>
    <td><input class="input mature" placeholder="21" /></td>
    <td><button class="btn remove" type="button">Remove</button></td>
  `;
  tr.querySelector(".rid").value = rule?.rule_id || "default";
  tr.querySelector(".decks").value = (rule?.deck_paths || []).join(", ");
  tr.querySelector(".field").value = rule?.target_field || "";
  tr.querySelector(".notetypes").value = (rule?.note_types || []).join(", ");
  tr.querySelector(".subdecks").checked = rule?.include_subdecks !== false;
  tr.querySelector(".mature").value = String(rule?.mature_interval_days ?? 21);
  tr.querySelector(".remove").addEventListener("click", () => onRemove(tr));

  tr.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("button.remove")) return;
    setWizardActiveRuleRow(tr);
  });

  return tr;
}

function populateWizardRulesTable(rules) {
  const body = $("wiz-rules-body");
  if (!body) return;
  body.innerHTML = "";
  const onRemove = (tr) => {
    const wasActive = wizardActiveRuleRow === tr;
    tr.remove();
    if (wasActive) ensureWizardActiveRow();
  };
  const list =
    Array.isArray(rules) && rules.length
      ? rules
      : [{ rule_id: "default", deck_paths: [], include_subdecks: true, note_types: [], target_field: "", mature_interval_days: 21 }];
  for (const r of list) body.appendChild(wizardRuleRow(r, onRemove));
  const first = body.querySelector("tr");
  if (first) setWizardActiveRuleRow(first);
}

function readWizardRulesFromTable() {
  const body = $("wiz-rules-body");
  if (!body) return [];
  const rules = [];
  for (const tr of body.querySelectorAll("tr")) {
    const rid = tr.querySelector(".rid").value.trim() || "default";
    const deckPaths = tr
      .querySelector(".decks")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const targetField = tr.querySelector(".field").value.trim();
    const noteTypes = tr
      .querySelector(".notetypes")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeSubdecks = tr.querySelector(".subdecks").checked;
    const mature = Number(tr.querySelector(".mature").value || "21");
    if (!deckPaths.length || !targetField) continue;
    rules.push({
      rule_id: rid,
      deck_paths: deckPaths,
      include_subdecks: includeSubdecks,
      note_types: noteTypes,
      target_field: targetField,
      mature_interval_days: Number.isFinite(mature) ? Math.max(1, Math.trunc(mature)) : 21,
    });
  }
  return rules;
}

function readWizardRulesDraftFromTable() {
  const body = $("wiz-rules-body");
  if (!body) return [];
  const rules = [];
  for (const tr of body.querySelectorAll("tr")) {
    const rid = tr.querySelector(".rid").value.trim() || "default";
    const deckPaths = tr
      .querySelector(".decks")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const targetField = tr.querySelector(".field").value.trim();
    const noteTypes = tr
      .querySelector(".notetypes")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeSubdecks = tr.querySelector(".subdecks").checked;
    const mature = Number(tr.querySelector(".mature").value || "21");
    rules.push({
      rule_id: rid,
      deck_paths: deckPaths,
      include_subdecks: includeSubdecks,
      note_types: noteTypes,
      target_field: targetField,
      mature_interval_days: Number.isFinite(mature) ? Math.max(1, Math.trunc(mature)) : 21,
    });
  }
  return rules;
}

function getAnkiProfileFromUi() {
  const raw = ($("anki-profile")?.value || "").trim();
  return raw || "User 1";
}

function populateThemeSelect() {
  const sel = $("report-theme");
  if (!sel) return;
  sel.innerHTML = "";
  for (const opt of THEME_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
}

function getDefaultConfig() {
  return {
    anki_profile: "User 1",
    timezone: "local",
    theme: "dark-graphite",
    output_dir: "",
    one_page: true,
    anki_stats: { require_fresh: true },
    toggl: {
      start_date: "auto",
      refresh_days_back: 60,
      refresh_buffer_days: 2,
      chunk_days: 7,
      baseline_hours: 0,
    },
    mokuro: { enabled: false, volume_data_path: "" },
    ttsu: { enabled: false, data_dir: "" },
    gsm: { enabled: false, db_path: "auto" },
    anki_snapshot: { enabled: false, stats_range_days: null, output_dir: "hashi_exports", rules: [] },
    launch: { open_on_startup: false, start_minimized_to_tray: false, close_minimizes_to_tray: false },
  };
}

async function refreshAnkiProfiles() {
  const select = $("anki-profile-select");
  if (!select) return;

  const r = await api("GET", "/api/anki/profiles");
  const profiles = Array.isArray(r.profiles) ? r.profiles : [];
  const current = getAnkiProfileFromUi();

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "(select a profile)" : "(no profiles detected)";
  select.appendChild(placeholder);

  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }

  if (profiles.includes(current)) select.value = current;
}

function selectTab(name) {
  for (const t of KNOWN_TABS) {
    const tabEl = $(`tab-${t}`);
    const panelEl = $(`panel-${t}`);
    if (tabEl) tabEl.classList.toggle("active", t === name);
    if (panelEl) panelEl.classList.toggle("active", t === name);
  }
  if (name === "getting-started") ensureKofiWidgetLoaded();
  try {
    localStorage.setItem("tokei_last_tab", String(name || ""));
  } catch {
    // ignore
  }
}

function renderGettingStartedCard(card) {
  card.innerHTML = `
    <h2>Getting started</h2>
    <div class="subtabs">
      <button id="gs-tab-guide" class="subtab-btn active" type="button">Getting started</button>
      <button id="gs-tab-support" class="subtab-btn" type="button">Support</button>
    </div>

    <div id="gs-pane-guide" class="gs-pane active">
      <div class="hint">
        Most of the time you’ll use <b>Dashboard</b> to <b>Sync</b> and <b>Generate report</b>.
      </div>

      <div class="subhead">Step 1: Setup</div>
      <div class="hint">
        Add your Toggl token (required), configure Anki snapshot rules (optional), then click <b>Save config.json</b>.
      </div>

      <div class="subhead">Step 2: Sources</div>
      <div class="hint">
        Enable/disable sources you use (Mokuro, Ttsu, GSM). Import <code>known.csv</code> if you have one.
      </div>

      <div class="subhead">Step 3: Dashboard</div>
      <div class="hint">
        Click <b>Sync</b> to refresh caches. Click <b>Generate report</b> to produce HTML/PNG output (optionally sync first).
      </div>

      <div class="subhead">Troubleshooting</div>
      <div class="hint">
        If something fails, use <b>File ▸ Open Logs</b> to open the log folder and check <code>runtime.log</code> and any <code>WARNINGS.txt</code> next to your report.
      </div>
    </div>

    <div id="gs-pane-support" class="gs-pane">
      <div class="hint">
        If Tokei has been helpful and you’d like to support development, you can donate via Ko-fi.
      </div>
      <div class="support-row">
        <div id="kofi-widget" class="kofi-host"></div>
        <a class="btn" href="https://ko-fi.com/G2G81MFOAV" target="_blank" rel="noreferrer">Open Ko-fi</a>
      </div>
      <div id="kofi-status" class="status"></div>
    </div>
  `;

  const setPane = (which) => {
    const guideBtn = $("gs-tab-guide");
    const supportBtn = $("gs-tab-support");
    const guidePane = $("gs-pane-guide");
    const supportPane = $("gs-pane-support");
    if (!guideBtn || !supportBtn || !guidePane || !supportPane) return;

    const showSupport = which === "support";
    guideBtn.classList.toggle("active", !showSupport);
    supportBtn.classList.toggle("active", showSupport);
    guidePane.classList.toggle("active", !showSupport);
    supportPane.classList.toggle("active", showSupport);

    if (showSupport) ensureKofiWidgetLoaded();
  };

  const guideBtn = $("gs-tab-guide");
  const supportBtn = $("gs-tab-support");
  if (guideBtn) guideBtn.addEventListener("click", () => setPane("guide"));
  if (supportBtn) supportBtn.addEventListener("click", () => setPane("support"));
}

function renderGettingStartedCardV2(card) {
  card.innerHTML = `
    <h2>How to Use Tokei</h2>

    <div class="hint">
      Most of the time, you'll work from the Dashboard to sync data and generate reports.
    </div>

    <div class="subhead">Step 1: Setup</div>
    <div class="hint">
      Add your Toggl token (required), configure Anki snapshot rules (optional), then click Save to write <code>config.json</code>.
    </div>
    <div class="hint">
      Anki stats come from the built-in snapshot exporter (recommended). Legacy Hashi add-on exports are still supported for existing users.
    </div>

    <div class="subhead">Step 2: Sources</div>
    <div class="hint">
      Enable or disable the sources you use (Mokuro, Ttsu, GSM). If you have a <code>known.csv</code>, you can import it here.
    </div>
    <div class="hint">
      Tip for new users: install Google Drive and sync your reading data. After installing, open your Drive on your PC (often <code>G:\\</code>), find <code>ttu-reader-data</code> (Ttsu) and <code>mokuro-reader</code> (Mokuro), then select those paths in the Sources tab.
    </div>
    <div class="hint">
      Sources are read-only: Tokei never modifies external tools, it only reads them and writes its own caches.
    </div>

    <div class="subhead">Step 3: Dashboard</div>
    <div class="hint">Click <b>Sync</b> to refresh all enabled source caches and update <code>cache/latest_sync.json</code>.</div>
    <div class="hint">Click <b>Generate report</b> to create HTML/PNG output in your configured output folder.</div>
    <div class="hint">You can optionally re-sync before generating via the checkbox.</div>

    <div class="subhead">Troubleshooting</div>
    <div class="hint">
      Use <b>File ▸ Open Logs</b> to open the log folder. Check <code>runtime.log</code> and any <code>WARNINGS.txt</code> next to your report.
    </div>

    <div class="support-block">
      <div class="subhead">Support</div>
      <div class="hint">This project is built and maintained in my free time.</div>
      <div class="hint">If it's useful to you, consider supporting it on Ko-fi.</div>
      <div class="hint">Your support helps keep development active and sustainable.</div>
      <div class="support-row">
        <div id="kofi-widget" class="kofi-host"></div>
        <div id="kofi-status" class="status"></div>
      </div>
    </div>
  `;
}

let kofiScriptLoading = false;
let kofiScriptLoaded = false;

function ensureKofiWidgetLoaded() {
  const host = $("kofi-widget");
  const statusEl = $("kofi-status");
  if (!host) return;

  const renderFromGlobal = () => {
    try {
      if (!window.kofiwidget2 || typeof window.kofiwidget2.init !== "function" || typeof window.kofiwidget2.getHTML !== "function") {
        throw new Error("kofiwidget2 missing");
      }
      window.kofiwidget2.init("Support me on Ko-fi", "#d95e38", "G2G81MFOAV");
      host.innerHTML = window.kofiwidget2.getHTML();
      if (statusEl) setStatus(statusEl, "", null);
    } catch (e) {
      if (statusEl) setStatus(statusEl, `Ko-fi widget failed to load (${String(e?.message || e)}).`, "bad");
    }
  };

  if (kofiScriptLoaded) return renderFromGlobal();
  if (kofiScriptLoading) return;

  kofiScriptLoading = true;
  if (statusEl) setStatus(statusEl, "Loading Ko-fi widget...", null);

  const s = document.createElement("script");
  s.src = "https://storage.ko-fi.com/cdn/widget/Widget_2.js";
  s.async = true;
  s.onload = () => {
    kofiScriptLoading = false;
    kofiScriptLoaded = true;
    renderFromGlobal();
  };
  s.onerror = () => {
    kofiScriptLoading = false;
    if (statusEl) setStatus(statusEl, "Ko-fi widget failed to load (network blocked).", "bad");
  };
  document.head.appendChild(s);
}

function relocateGettingStartedCard() {
  const logsPanel = $("panel-logs");
  const destGrid = $("getting-started-grid");
  if (!logsPanel || !destGrid) return;

  const cards = Array.from(logsPanel.querySelectorAll(".card"));
  const card = cards.find((c) => (c.querySelector("h2")?.textContent || "").trim().toLowerCase() === "getting started");
  if (card) {
    card.classList.add("full");
    destGrid.appendChild(card);
    renderGettingStartedCardV2(card);
  }
}

// Allow Electron main process to request a tab switch (tray double click, menu, etc).
window.__tokeiSelectTab = (name) => {
  try {
    selectTab(name);
    localStorage.setItem("tokei_last_tab", String(name || ""));
  } catch {
    // ignore
  }
};

async function copyText(text) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function ruleRow(rule, onRemove) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="input rid" placeholder="rule_id" /></td>
    <td><input class="input decks" placeholder="Deck::Subdeck, Deck2::Subdeck" /></td>
    <td><input class="input field" placeholder="Field name (e.g. Expression)" /></td>
    <td><input class="input notetypes" placeholder="(optional) Note type A, Note type B" /></td>
    <td><label class="check"><input class="subdecks" type="checkbox" /> include</label></td>
    <td><input class="input mature" placeholder="21" /></td>
    <td><button class="btn remove">Remove</button></td>
  `;
  tr.querySelector(".rid").value = rule?.rule_id || "default";
  tr.querySelector(".decks").value = (rule?.deck_paths || []).join(", ");
  tr.querySelector(".field").value = rule?.target_field || "";
  tr.querySelector(".notetypes").value = (rule?.note_types || []).join(", ");
  tr.querySelector(".subdecks").checked = rule?.include_subdecks !== false;
  tr.querySelector(".mature").value = String(rule?.mature_interval_days ?? 21);
  tr.querySelector(".remove").addEventListener("click", () => onRemove(tr));

  tr.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest("button.remove")) return;
    setActiveRuleRow(tr);
  });

  return tr;
}

function setActiveRuleRow(tr) {
  activeRuleRow = tr;
  for (const row of $("rules-body").querySelectorAll("tr")) row.classList.toggle("active-row", row === tr);
}

function readRulesFromTable() {
  const rules = [];
  for (const tr of $("rules-body").querySelectorAll("tr")) {
    const rid = tr.querySelector(".rid").value.trim() || "default";
    const deckPaths = tr
      .querySelector(".decks")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const targetField = tr.querySelector(".field").value.trim();
    const noteTypes = tr
      .querySelector(".notetypes")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeSubdecks = tr.querySelector(".subdecks").checked;
    const mature = Number(tr.querySelector(".mature").value || "21");
    if (!deckPaths.length || !targetField) continue;
    rules.push({
      rule_id: rid,
      deck_paths: deckPaths,
      include_subdecks: includeSubdecks,
      note_types: noteTypes,
      target_field: targetField,
      mature_interval_days: Number.isFinite(mature) ? Math.max(1, Math.trunc(mature)) : 21,
    });
  }
  return rules;
}

function populateRulesTable(rules) {
  const body = $("rules-body");
  body.innerHTML = "";
  const onRemove = (tr) => tr.remove();
  const list = Array.isArray(rules) && rules.length ? rules : [{ rule_id: "default", deck_paths: [], include_subdecks: true, note_types: [], target_field: "", mature_interval_days: 21 }];
  for (const r of list) body.appendChild(ruleRow(r, onRemove));
  const first = body.querySelector("tr");
  if (first) setActiveRuleRow(first);
}

function setVisible(el, visible) {
  el.hidden = !visible;
}

function toggleVisible(el) {
  el.hidden = !el.hidden;
}

function normalizeList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [];
}

function makeChip(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function parseCommaList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function setCommaListInput(input, values) {
  const unique = [];
  const seen = new Set();
  for (const v of values) {
    const k = v.trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(k);
  }
  input.value = unique.join(", ");
}

function ensureActiveRow() {
  if (activeRuleRow && activeRuleRow.isConnected) return activeRuleRow;
  const first = $("rules-body").querySelector("tr");
  if (first) setActiveRuleRow(first);
  return activeRuleRow;
}

function renderDiscoveredAnki(payload) {
  discoveredAnki = payload && payload.ok ? payload : null;
  const box = $("anki-discovered");
  if (!discoveredAnki) {
    box.hidden = true;
    $("anki-decks").innerHTML = "";
    $("anki-notetypes").innerHTML = "";
    $("anki-fields").innerHTML = "";
    return;
  }

  const decks = normalizeList(discoveredAnki.decks).map((d) => String(d?.name || "")).filter(Boolean);
  const noteTypes = normalizeList(discoveredAnki.note_types).map((nt) => String(nt?.name || "")).filter(Boolean);
  const fields = [];
  for (const nt of normalizeList(discoveredAnki.note_types)) {
    for (const f of normalizeList(nt?.fields)) fields.push(String(f || ""));
  }
  const uniqueFields = [...new Set(fields.map((x) => x.trim()).filter(Boolean).map((x) => x))].sort((a, b) => a.localeCompare(b));

  $("anki-decks").innerHTML = "";
  $("anki-notetypes").innerHTML = "";
  $("anki-fields").innerHTML = "";

  for (const d of decks) {
    $("anki-decks").appendChild(
      makeChip(d, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(d);
          setStatus($("anki-status"), ok ? `Copied deck: ${d}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureActiveRow();
        if (!row) return;
        const input = row.querySelector(".decks");
        const curr = parseCommaList(input.value);
        curr.push(d);
        setCommaListInput(input, curr);
        setStatus($("anki-status"), `Added deck to rule: ${d}`, "good");
      })
    );
  }

  for (const nt of noteTypes) {
    $("anki-notetypes").appendChild(
      makeChip(nt, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(nt);
          setStatus($("anki-status"), ok ? `Copied note type: ${nt}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureActiveRow();
        if (!row) return;
        const input = row.querySelector(".notetypes");
        const curr = parseCommaList(input.value);
        curr.push(nt);
        setCommaListInput(input, curr);
        setStatus($("anki-status"), `Added note type to rule: ${nt}`, "good");
      })
    );
  }

  for (const f of uniqueFields) {
    $("anki-fields").appendChild(
      makeChip(f, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(f);
          setStatus($("anki-status"), ok ? `Copied field: ${f}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureActiveRow();
        if (!row) return;
        row.querySelector(".field").value = f;
        setStatus($("anki-status"), `Set target field: ${f}`, "good");
      })
    );
  }

  box.hidden = false;
}

async function loadEnv() {
  const env = await api("GET", "/api/env");
  if (!env.ok) return;
  currentEnv = env;
  $("env-appRoot").textContent = env.appRoot;
  $("env-userRoot").textContent = env.userRoot;
  $("env-platform").textContent = env.platform;
  $("env-node").textContent = env.node;
}

async function loadToken() {
  const r = await api("GET", "/api/toggl-token");
  if (!r.ok) return;
  $("toggl-token").value = r.token || "";
}

async function saveToken() {
  setStatus($("toggl-status"), "Saving...", null);
  const token = $("toggl-token").value;
  const r = await api("POST", "/api/toggl-token", { token });
  if (r.ok) setStatus($("toggl-status"), "Saved.", "good");
  else setStatus($("toggl-status"), r.error || "Failed.", "bad");
}

function toggleTogglReveal() {
  const input = $("toggl-token");
  const btn = $("toggl-reveal");
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  btn.textContent = reveal ? "Hide" : "Show";
}

function discardConfigChanges() {
  const ok = confirm("Discard unsaved changes and reload config.json from disk?");
  if (!ok) return;
  setStatus($("config-status"), "Reloading...", null);
  loadConfig()
    .then((cfg) => {
      if (cfg) currentConfig = cfg;
      setStatus($("config-status"), "Reloaded.", "good");
    })
    .catch((e) => setStatus($("config-status"), String(e?.message || e), "bad"));
}

async function loadConfig() {
  const r = await api("GET", "/api/config");
  let cfg = null;
  if (!r.ok) {
    if (r.error === "missing") {
      cfg = getDefaultConfig();
      setStatus(
        $("config-status"),
        `config.json not found yet. Use “Open setup wizard” or click “Save config.json” to create it in ${r.path || "your user folder"}.`,
        "bad"
      );
    } else {
      setStatus($("config-status"), r.error || "Failed to load config.", "bad");
      return null;
    }
  } else {
    cfg = r.config || {};
  }

  const launch = cfg.launch && typeof cfg.launch === "object" ? cfg.launch : {};
  $("launch-open-on-startup").checked = launch.open_on_startup === true;
  $("launch-start-minimized").checked = launch.start_minimized_to_tray === true;
  $("launch-close-minimizes").checked = launch.close_minimizes_to_tray === true;

  const rawOut = typeof cfg.output_dir === "string" ? cfg.output_dir : "";
  if ($("report-output-dir")) $("report-output-dir").value = rawOut;
  const tz = typeof cfg.timezone === "string" && cfg.timezone.trim() ? cfg.timezone.trim() : "local";
  if ($("report-timezone")) $("report-timezone").value = tz;

  populateThemeSelect();
  const themeRaw = typeof cfg.theme === "string" && cfg.theme.trim() ? cfg.theme.trim() : "dark-graphite";
  const themeSel = $("report-theme");
  if (themeSel) {
    const has = Array.from(themeSel.options).some((o) => o.value === themeRaw);
    if (!has) {
      const custom = document.createElement("option");
      custom.value = themeRaw;
      custom.textContent = themeRaw;
      themeSel.appendChild(custom);
    }
    themeSel.value = themeRaw;
  }

  const ankiStats = cfg.anki_stats && typeof cfg.anki_stats === "object" ? cfg.anki_stats : {};
  const hashi = cfg.hashi && typeof cfg.hashi === "object" ? cfg.hashi : {};
  const requireFresh =
    typeof ankiStats.require_fresh === "boolean" ? ankiStats.require_fresh : hashi.require_fresh === false ? false : true;
  if ($("anki-nonblocking")) $("anki-nonblocking").checked = !requireFresh;

  const toggl = cfg.toggl && typeof cfg.toggl === "object" ? cfg.toggl : {};
  const baselineHours = Number(toggl.baseline_hours || 0);
  const baselineInput = $("toggl-baseline-hms");
  if (baselineInput) baselineInput.value = formatHmsFromHours(Number.isFinite(baselineHours) ? baselineHours : 0);
  setVisible($("toggl-advanced"), false);

  const snap = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  $("anki-enabled").checked = snap.enabled === true;
  $("anki-output-dir").value = typeof snap.output_dir === "string" ? snap.output_dir : "hashi_exports";

  const ankiProfileInput = $("anki-profile");
  if (ankiProfileInput) {
    const profile = typeof cfg.anki_profile === "string" && cfg.anki_profile.trim() ? cfg.anki_profile.trim() : "User 1";
    ankiProfileInput.value = profile;
  }

  const mokuro = cfg.mokuro && typeof cfg.mokuro === "object" ? cfg.mokuro : {};
  const mokuroPath = typeof mokuro.volume_data_path === "string" ? mokuro.volume_data_path.trim() : "";
  $("mokuro-enabled").checked = typeof mokuro.enabled === "boolean" ? mokuro.enabled : Boolean(mokuroPath);
  const mokuroPathInput = $("mokuro-path");
  if (mokuroPathInput) mokuroPathInput.value = mokuroPath;

  const ttsu = cfg.ttsu && typeof cfg.ttsu === "object" ? cfg.ttsu : {};
  const ttsuPath = typeof ttsu.data_dir === "string" ? ttsu.data_dir.trim() : "";
  $("ttsu-enabled").checked = typeof ttsu.enabled === "boolean" ? ttsu.enabled : Boolean(ttsuPath);
  const ttsuPathInput = $("ttsu-path");
  if (ttsuPathInput) ttsuPathInput.value = ttsuPath;

  const gsm = cfg.gsm && typeof cfg.gsm === "object" ? cfg.gsm : {};
  const gsmDbPath = typeof gsm.db_path === "string" ? gsm.db_path.trim() : "auto";
  const gsmDefaultEnabled = gsmDbPath.toLowerCase() !== "off";
  $("gsm-enabled").checked = typeof gsm.enabled === "boolean" ? gsm.enabled : gsmDefaultEnabled;
  setStatus($("mokuro-status"), $("mokuro-enabled").checked ? "Enabled" : "Disabled", $("mokuro-enabled").checked ? "good" : null);
  setStatus($("ttsu-status"), $("ttsu-enabled").checked ? "Enabled" : "Disabled", $("ttsu-enabled").checked ? "good" : null);

  setVisible($("anki-advanced"), false);
  populateRulesTable(Array.isArray(snap.rules) ? snap.rules : []);
  renderDiscoveredAnki(null);
  await refreshAnkiProfiles();
  return cfg;
}

async function saveConfig(currentCfg) {
  const cfg = currentCfg && typeof currentCfg === "object" ? currentCfg : {};
  cfg.launch = cfg.launch && typeof cfg.launch === "object" ? cfg.launch : {};
  cfg.launch.open_on_startup = $("launch-open-on-startup").checked;
  cfg.launch.start_minimized_to_tray = $("launch-start-minimized").checked;
  cfg.launch.close_minimizes_to_tray = $("launch-close-minimizes").checked;

  cfg.output_dir = ($("report-output-dir")?.value || "").trim();
  cfg.timezone = ($("report-timezone")?.value || "").trim() || "local";
  cfg.theme = ($("report-theme")?.value || "").trim() || "dark-graphite";

  cfg.anki_stats = cfg.anki_stats && typeof cfg.anki_stats === "object" ? cfg.anki_stats : {};
  cfg.anki_stats.require_fresh = $("anki-nonblocking")?.checked ? false : true;
  // Back-compat: keep older configs' `hashi.require_fresh` in sync if present.
  if (cfg.hashi && typeof cfg.hashi === "object") cfg.hashi.require_fresh = cfg.anki_stats.require_fresh;

  cfg.toggl = cfg.toggl && typeof cfg.toggl === "object" ? cfg.toggl : {};
  const baselineText = ($("toggl-baseline-hms")?.value || "").trim();
  try {
    cfg.toggl.baseline_hours = baselineText ? parseHmsToHours(baselineText) : 0;
    setStatus($("toggl-baseline-status"), "", null);
  } catch (e) {
    setStatus($("toggl-baseline-status"), `Invalid baseline time: ${String(e?.message || e)}`, "bad");
    return;
  }

  cfg.anki_snapshot = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  cfg.anki_snapshot.enabled = $("anki-enabled").checked;
  const od = $("anki-output-dir").value.trim();
  cfg.anki_snapshot.output_dir = od || "hashi_exports";
  cfg.anki_snapshot.rules = readRulesFromTable();

  cfg.anki_profile = getAnkiProfileFromUi();

  cfg.mokuro = cfg.mokuro && typeof cfg.mokuro === "object" ? cfg.mokuro : {};
  cfg.mokuro.enabled = $("mokuro-enabled").checked;
  cfg.mokuro.volume_data_path = ($("mokuro-path")?.value || "").trim();
  cfg.ttsu = cfg.ttsu && typeof cfg.ttsu === "object" ? cfg.ttsu : {};
  cfg.ttsu.enabled = $("ttsu-enabled").checked;
  cfg.ttsu.data_dir = ($("ttsu-path")?.value || "").trim();
  cfg.gsm = cfg.gsm && typeof cfg.gsm === "object" ? cfg.gsm : {};
  cfg.gsm.enabled = $("gsm-enabled").checked;

  setStatus($("mokuro-status"), $("mokuro-enabled").checked ? "Enabled" : "Disabled", $("mokuro-enabled").checked ? "good" : null);
  setStatus($("ttsu-status"), $("ttsu-enabled").checked ? "Enabled" : "Disabled", $("ttsu-enabled").checked ? "good" : null);

  setStatus($("config-status"), "Saving...", null);
  const r = await api("POST", "/api/config", cfg);
  if (r.ok) {
    localStorage.setItem("tokei_setup_complete", "1");
    setStatus($("config-status"), "Saved config.json.", "good");
    setStatus($("toggl-baseline-status"), "Saved.", "good");
  }
  else setStatus($("config-status"), r.error || "Failed.", "bad");
}

async function ankiDiscover() {
  setStatus($("anki-status"), "Discovering...", null);
  const r = await api("POST", "/api/anki/discover", { profile: getAnkiProfileFromUi() });
  if (r.ok) {
    const ok = r.payload?.ok === true;
    if (!ok) {
      setStatus($("anki-status"), r.payload?.error || "Discover failed.", "bad");
      renderDiscoveredAnki(null);
      return;
    }
    const nDecks = r.payload?.decks?.length ?? 0;
    const nNts = r.payload?.note_types?.length ?? 0;
    setStatus($("anki-status"), `OK (${nDecks} decks, ${nNts} note types). Click a rule row then click items to add.`, "good");
    renderDiscoveredAnki(r.payload);
  } else {
    setStatus($("anki-status"), r.stderr || "Discover failed.", "bad");
    renderDiscoveredAnki(null);
  }
}

async function ankiTestExport() {
  setStatus($("anki-status"), "Exporting...", null);
  const r = await api("POST", "/api/anki/test-export", {});
  if (r.ok) {
    const msg = `Export OK. exported_at=${r.exported_at || "?"}`;
    setStatus($("anki-status"), msg, "good");
  } else {
    const friendly = toFriendlyErrorFromApiResult(r);
    setStatus($("anki-status"), (friendly && friendly.title) || r.message || r.stderr || r.error || "Export failed.", "bad");
  }
}

async function puppeteerTest() {
  setStatus($("puppeteer-status"), "Running...", null);
  const r = await api("POST", "/api/puppeteer/test", {});
  if (r.ok) {
    setStatus($("puppeteer-status"), `OK: ${r.pngPath}`, "good");
  } else {
    setStatus($("puppeteer-status"), r.error || "Failed.", "bad");
  }
}

async function pythonTest() {
  setStatus($("python-status"), "Checking...", null);
  const r = await api("POST", "/api/python/check", {});
  if (r.ok) setStatus($("python-status"), r.version || "OK", "good");
  else setStatus($("python-status"), r.version || "Python not found.", "bad");
}

async function gsmCopySnippet() {
  setStatus($("gsm-status"), "Loading snippet...", null);
  const r = await api("GET", "/api/gsm/plugin-snippet");
  if (!r.ok) return setStatus($("gsm-status"), r.error || "Could not load snippet.", "bad");
  const snippet = r.snippet || "";

  try {
    await navigator.clipboard.writeText(snippet);
    return setStatus($("gsm-status"), "Copied plugins.py shim to clipboard.", "good");
  } catch {
    // Fallback: textarea copy.
    try {
      const ta = document.createElement("textarea");
      ta.value = snippet;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return setStatus($("gsm-status"), "Copied plugins.py shim to clipboard.", "good");
    } catch (e) {
      return setStatus($("gsm-status"), String(e?.message || e || "Copy failed."), "bad");
    }
  }
}

async function gsmCopyHelper() {
  setStatus($("gsm-status"), "Loading helper...", null);
  const r = await api("GET", "/api/gsm/plugin-snippet");
  if (!r.ok) return setStatus($("gsm-status"), r.error || "Could not load helper.", "bad");
  const snippet = r.helper_snippet || "";
  if (!snippet) return setStatus($("gsm-status"), "Helper snippet missing.", "bad");

  try {
    await navigator.clipboard.writeText(snippet);
    return setStatus($("gsm-status"), "Copied tokei_live_sync.py to clipboard (create this file in your GSM folder).", "good");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = snippet;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return setStatus($("gsm-status"), "Copied tokei_live_sync.py to clipboard (create this file in your GSM folder).", "good");
    } catch (e) {
      return setStatus($("gsm-status"), String(e?.message || e || "Copy failed."), "bad");
    }
  }
}

async function gsmInstallHelper() {
  setStatus($("gsm-status"), "Installing tokei_live_sync.py...", null);
  const r = await api("POST", "/api/gsm/install-helper", {});
  if (!r.ok) return setStatus($("gsm-status"), r.error || "Install failed.", "bad");
  if (r.changed) {
    const msg = r.backupPath ? `Installed. Backup: ${r.backupPath}` : "Installed.";
    return setStatus($("gsm-status"), msg, "good");
  }
  return setStatus($("gsm-status"), "Already installed (no changes).", "good");
}

async function gsmRefreshStatus() {
  const r = await api("GET", "/api/gsm/status");
  if (!r.ok) {
    $("gsm-status-detail").textContent = "";
    return;
  }

  const parts = [];
  parts.push(`Helper: ${r.helperExists ? "installed" : "missing"}`);
  parts.push(`plugins.py: ${r.pluginExists ? (r.shimPresent ? "shim ok" : "needs shim") : "missing"}`);
  parts.push(`gsm_live.sqlite: ${r.dbExists ? `found (${r.dbMtime || "mtime unknown"})` : "missing"}`);
  $("gsm-status-detail").textContent = parts.join(" • ");
}

async function gsmInstall() {
  setStatus($("gsm-status"), "Installing...", null);
  const r = await api("POST", "/api/gsm/install-helper", {});
  if (!r.ok) {
    setStatus($("gsm-status"), r.error || "Install failed.", "bad");
    await gsmRefreshStatus();
    return;
  }
  const msg = r.changed ? "Installed tokei_live_sync.py. Next: add the plugins.py shim (Advanced)." : "Already installed.";
  setStatus($("gsm-status"), msg, "good");
  await gsmRefreshStatus();
}

async function gsmOpenFolder() {
  setStatus($("gsm-status"), "Opening folder...", null);
  const r = await api("POST", "/api/gsm/open-folder", {});
  if (r.ok) setStatus($("gsm-status"), `Opened: ${r.folder}`, "good");
  else setStatus($("gsm-status"), r.error || "Failed.", "bad");
}

async function gsmOpenPlugin() {
  setStatus($("gsm-status"), "Opening plugins.py...", null);
  const r = await api("POST", "/api/gsm/open-plugin-file", {});
  if (!r.ok) return setStatus($("gsm-status"), r.error || "Failed.", "bad");
  const msg = r.exists ? `Opened: ${r.pluginFile}` : `Opened (missing): ${r.pluginFile}`;
  setStatus($("gsm-status"), msg, r.exists ? "good" : "bad");
}

async function gsmOpenHelper() {
  setStatus($("gsm-status"), "Opening tokei_live_sync.py...", null);
  const r = await api("POST", "/api/gsm/open-helper-file", {});
  if (!r.ok) return setStatus($("gsm-status"), r.error || "Failed.", "bad");
  const msg = r.exists ? `Opened: ${r.helperFile}` : `Opened (missing): ${r.helperFile}`;
  setStatus($("gsm-status"), msg, r.exists ? "good" : "bad");
}

async function refreshLogs() {
  const r = await api("GET", "/api/runtime-log?lines=600");
  if (r.ok) $("runtime-log").textContent = (r.lines || []).join("\n");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return "?";
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(2);
}

function fmtInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "?";
  return Math.trunc(x).toLocaleString();
}

function fmtSigned(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x === 0) return "—";
  const sign = x > 0 ? "+" : "";
  const v = digits === 0 ? String(Math.trunc(x)) : x.toFixed(digits);
  return `${sign}${v}`;
}

function deltaClass(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x === 0) return "";
  return x > 0 ? "good" : "bad";
}

function fmtHmsFromSeconds(sec) {
  const x = Number(sec);
  if (!Number.isFinite(x)) return "?";
  const sign = x < 0 ? "-" : "";
  let s = Math.trunc(Math.abs(x));
  const hh = Math.trunc(s / 3600);
  s -= hh * 3600;
  const mm = Math.trunc(s / 60);
  s -= mm * 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${sign}${pad2(hh)}:${pad2(mm)}:${pad2(s)}`;
}

function fmtSignedHmsFromSeconds(sec) {
  const x = Number(sec);
  if (!Number.isFinite(x)) return null;
  if (x === 0) return "—";
  const sign = x > 0 ? "+" : "-";
  return `${sign}${fmtHmsFromSeconds(Math.abs(x))}`;
}

let latestSync = null;
let latestReport = null;

function todayListHtml(entries) {
  const list = Array.isArray(entries) ? entries.filter((x) => x && typeof x === "object") : [];
  if (!list.length) return "";

  const sorted = [...list].sort((a, b) => Number(b.seconds || 0) - Number(a.seconds || 0));
  const top = sorted.slice(0, 8);
  const rest = sorted.length - top.length;

  const rows = top
    .map((e) => {
      const desc = typeof e.desc === "string" ? e.desc : "(no description)";
      const seconds = Number(e.seconds || 0);
      return `<div class="today-row"><div class="today-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</div><div class="today-time">${escapeHtml(
        fmtHmsFromSeconds(seconds)
      )}</div></div>`;
    })
    .join("");

  const more = rest > 0 ? `<div class="hint">…and ${rest} more</div>` : "";
  return `<div class="today-list">${rows}</div>${more}`;
}

function cardHtml({ areaClass, label, value, delta, deltaCls, extraHtml = "" }) {
  const deltaHtml =
    delta != null
      ? `<div class="stat-sub">Δ <span class="delta ${escapeHtml(deltaCls || "")}">${escapeHtml(delta)}</span></div>`
      : `<div class="stat-sub">&nbsp;</div>`;
  return `<div class="stat ${escapeHtml(areaClass)}"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(
    value
  )}</div>${deltaHtml}${extraHtml}</div>`;
}

function renderGlance() {
  const box = $("glance");
  if (!latestSync || typeof latestSync !== "object") {
    if (!latestReport || typeof latestReport !== "object") {
      box.innerHTML = `<div class="hint">No sync snapshot yet. Click <b>Sync</b>.</div>`;
      return;
    }

    const totalReadingChars =
      Number(latestReport.manga_chars_total || 0) + Number(latestReport.ttsu_chars_total || 0) + Number(latestReport.gsm_chars_total || 0);
    const readingDelta =
      Number(latestReport.manga_chars_delta || 0) + Number(latestReport.ttsu_chars_delta || 0) + Number(latestReport.gsm_chars_delta || 0);

    const todaySeconds = Number(latestReport.today_immersion?.total_seconds || 0);
    const avgSeconds = Number(latestReport.avg_immersion_seconds || 0);
    const todayEntries = latestReport.today_immersion?.entries || [];

    const reportNo = latestReport.report_no != null ? `#${latestReport.report_no}` : "?";
    const head = `<div class="glance-top"><div class="stamp">Latest report: ${escapeHtml(reportNo)}</div></div>`;

    const grid =
      `<div class="stats-grid">` +
      [
        cardHtml({
          areaClass: "life",
          label: "Total Lifetime Hours",
          value: fmtHours(latestReport.total_immersion_hours),
          delta: fmtSigned(latestReport.total_immersion_delta_hours, 2),
          deltaCls: deltaClass(latestReport.total_immersion_delta_hours),
        }),
        cardHtml({
          areaClass: "known",
          label: "Known Words",
          value: fmtInt(latestReport.known_words),
          delta: fmtSigned(latestReport.known_words_delta, 0),
          deltaCls: deltaClass(latestReport.known_words_delta),
        }),
        cardHtml({
          areaClass: "today",
          label: "Today's Immersion",
          value: fmtHmsFromSeconds(todaySeconds),
          delta: null,
          deltaCls: "",
          extraHtml: todayListHtml(todayEntries),
        }),
        cardHtml({
          areaClass: "avg",
          label: "7-day Avg Hours",
          value: fmtHmsFromSeconds(avgSeconds),
          delta: fmtSignedHmsFromSeconds(latestReport.avg_immersion_delta_seconds || 0),
          deltaCls: deltaClass(latestReport.avg_immersion_delta_seconds || 0),
        }),
        cardHtml({
          areaClass: "read",
          label: "Total Characters Read",
          value: Number.isFinite(totalReadingChars) ? fmtInt(totalReadingChars) : "?",
          delta: fmtSigned(readingDelta, 0),
          deltaCls: deltaClass(readingDelta),
        }),
        cardHtml({
          areaClass: "ret",
          label: "Anki True Retention",
          value: `${fmtHours(latestReport.retention_rate)}%`,
          delta: fmtSigned(latestReport.retention_delta, 2),
          deltaCls: deltaClass(latestReport.retention_delta),
        }),
        cardHtml({
          areaClass: "reviews",
          label: "Total Anki Reviews",
          value: fmtInt(latestReport.total_reviews),
          delta: fmtSigned(latestReport.total_reviews_delta, 0),
          deltaCls: deltaClass(latestReport.total_reviews_delta),
        }),
      ].join("") +
      `</div>`;

    box.innerHTML = `${head}${grid}<div class="hint">Sync snapshot not generated yet; showing latest report.</div>`;
    return;
  }

  const s = latestSync.summary && typeof latestSync.summary === "object" ? latestSync.summary : {};
  const syncedAt = latestSync.synced_at ? new Date(latestSync.synced_at).toLocaleString() : "?";
  const totalReadingChars =
    Number(s.manga_chars_total || 0) + Number(s.ttsu_chars_total || 0) + Number(s.gsm_chars_total || 0);
  const readingDelta = Number(s.manga_chars_delta || 0) + Number(s.ttsu_chars_delta || 0) + Number(s.gsm_chars_delta || 0);
  const todaySeconds = Number(latestSync.today_immersion?.total_seconds || 0);
  const todayEntries = latestSync.today_immersion?.entries || [];
  const avgSeconds = Number(s.immersion_7d_avg_hours || 0) * 3600.0;

  const lastReport = latestSync.last_report && typeof latestSync.last_report === "object" ? latestSync.last_report : null;
  const reportLine = lastReport && lastReport.report_no != null ? `Latest report: #${lastReport.report_no}` : `Latest report: none yet`;

  const head = `<div class="glance-top"><div class="stamp">Synced: ${escapeHtml(syncedAt)}</div><div class="stamp">${escapeHtml(reportLine)}</div></div>`;
  const grid =
    `<div class="stats-grid">` +
    [
      cardHtml({
        areaClass: "life",
        label: "Total Lifetime Hours",
        value: fmtHours(s.immersion_total_hours),
        delta: fmtSigned(s.immersion_total_delta_hours, 2),
        deltaCls: deltaClass(s.immersion_total_delta_hours),
      }),
      cardHtml({
        areaClass: "known",
        label: "Known Words",
        value: fmtInt(s.tokei_surface_words ?? s.known_words),
        delta: fmtSigned(s.known_words_delta, 0),
        deltaCls: deltaClass(s.known_words_delta),
      }),
      cardHtml({
        areaClass: "today",
        label: "Today's Immersion",
        value: fmtHmsFromSeconds(todaySeconds),
        delta: null,
        deltaCls: "",
        extraHtml: todayListHtml(todayEntries),
      }),
      cardHtml({
        areaClass: "avg",
        label: "7-day Avg Hours",
        value: fmtHmsFromSeconds(avgSeconds),
        delta: fmtSignedHmsFromSeconds(Number(s.immersion_7d_avg_delta_hours || 0) * 3600.0),
        deltaCls: deltaClass(Number(s.immersion_7d_avg_delta_hours || 0) * 3600.0),
      }),
      cardHtml({
        areaClass: "read",
        label: "Total Characters Read",
        value: Number.isFinite(totalReadingChars) ? fmtInt(totalReadingChars) : "?",
        delta: fmtSigned(readingDelta, 0),
        deltaCls: deltaClass(readingDelta),
      }),
      cardHtml({
        areaClass: "ret",
        label: "Anki True Retention",
        value: `${fmtHours(s.anki_true_retention_rate)}%`,
        delta: fmtSigned(s.anki_true_retention_delta, 2),
        deltaCls: deltaClass(s.anki_true_retention_delta),
      }),
      cardHtml({
        areaClass: "reviews",
        label: "Total Anki Reviews",
        value: fmtInt(s.anki_total_reviews),
        delta: fmtSigned(s.anki_total_reviews_delta, 0),
        deltaCls: deltaClass(s.anki_total_reviews_delta),
      }),
    ].join("") +
    `</div>`;

  box.innerHTML = `${head}${grid}`;
}

async function refreshLatestSync() {
  const r = await api("GET", "/api/latest-sync");
  latestSync = r.ok ? r.sync || null : null;
  if (r.ok && r.sync) $("latest-sync-raw").textContent = JSON.stringify(r.sync, null, 2);
  else $("latest-sync-raw").textContent = "";
  renderGlance();
}

async function refreshLatestReportStats() {
  const r = await api("GET", "/api/latest-stats");
  latestReport = r.ok ? r.stats || null : null;
  if (r.ok && r.stats) $("latest-stats").textContent = JSON.stringify(r.stats, null, 2);
  else $("latest-stats").textContent = "";
}

async function syncNow() {
  setStatus($("sync-status"), "Syncing...", null);
  setText($("run-message"), "");
  $("run-output").textContent = "";
  const details = $("run-details");
  if (details) details.open = false;
  setText($("run-details-summary"), "Technical details");
  const r = await api("POST", "/api/sync", {});
  if (r.ok) {
    setStatus($("sync-status"), "OK", "good");
  } else {
    const friendly = toFriendlyErrorFromApiResult(r);
    setStatus($("sync-status"), (friendly && friendly.title) || r.stderr || `Failed (code ${r.code})`, "bad");
    setText($("run-message"), formatFriendlyErrorText(friendly) || "Open the Logs tab for troubleshooting details.");
    if (friendly && friendly.error_code) setText($("run-details-summary"), `Technical details (${friendly.error_code})`);
  }
  $("run-output").textContent = [r.stdout, r.stderr].filter(Boolean).join("\n\n");
  await refreshLatestSync();
  await refreshLatestReportStats();
  await refreshLogs();
}

async function generateReport() {
  setStatus($("report-status"), "Generating...", null);
  setText($("run-message"), "");
  $("run-output").textContent = "";
  const details = $("run-details");
  if (details) details.open = false;
  setText($("run-details-summary"), "Technical details");
  const mode = $("report-mode").value;
  const syncBeforeReport = $("sync-before-report").checked;
  const r = await api("POST", "/api/generate-report", { mode, sync_before_report: syncBeforeReport });
  if (r.ok) {
    setStatus($("report-status"), `OK (Anki exported_at=${r.anki_exported_at || "?"})`, "good");
  } else {
    const friendly = toFriendlyErrorFromApiResult(r);
    setStatus($("report-status"), (friendly && friendly.title) || r.stderr || `Failed (code ${r.code})`, "bad");
    setText($("run-message"), formatFriendlyErrorText(friendly) || "Open the Logs tab for troubleshooting details.");
    if (friendly && friendly.error_code) setText($("run-details-summary"), `Technical details (${friendly.error_code})`);
  }
  $("run-output").textContent = [r.stdout, r.stderr].filter(Boolean).join("\n\n");
  await refreshLatestSync();
  await refreshLatestReportStats();
  await refreshLogs();
}

async function openTarget(target) {
  await api("POST", "/api/open", { target });
}

function showWizardOverlay(show) {
  const overlay = $("wizard-overlay");
  if (!overlay) return;
  overlay.hidden = !show;
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
}

function showWizardExitOverlay(show) {
  const overlay = $("wizard-exit-overlay");
  if (!overlay) return;
  overlay.hidden = !show;
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
  if (!show) setStatus($("wizard-exit-error"), "", null);
}

function wizardSetError(msg) {
  const el = $("wizard-error");
  if (!el) return;
  el.textContent = msg || "";
}

function wizardSetStatus(msg, kind) {
  setStatus($("wizard-status"), msg, kind);
}

const WIZARD_STEP_TITLES = ["Welcome", "Choose sources", "Connect sources", "Finish"];

const wizardState = {
  open: false,
  step: 0,
  forced: false,
  configMissing: false,
  includeAnki: true,
  includeMokuro: false,
  includeTtsu: false,
  includeGsm: false,
  togglToken: "",
  togglBaselineHms: "",
  ankiProfile: "User 1",
  ankiRulesDraft: [],
  ankiRules: [],
  mokuroPath: "",
  ttsuPath: "",
  outputDir: "",
  timezone: "local",
  theme: "dark-graphite",
  discovered: null,
};

async function refreshWizardConfigMissing() {
  const r = await api("GET", "/api/config");
  wizardState.configMissing = !r.ok && r.error === "missing";
  return wizardState.configMissing;
}

function renderWizardSteps() {
  const box = $("wizard-steps");
  if (!box) return;
  box.innerHTML = "";
  for (let i = 0; i < WIZARD_STEP_TITLES.length; i++) {
    const el = document.createElement("div");
    el.className = "wizard-step" + (i === wizardState.step ? " active" : i < wizardState.step ? " done" : "");
    el.textContent = `${i + 1}. ${WIZARD_STEP_TITLES[i]}`;
    box.appendChild(el);
  }
}

function wizardBodySet(html) {
  const body = $("wizard-body");
  if (!body) return;
  body.innerHTML = html;
}

function dedupeLower(list) {
  const out = [];
  const seen = new Set();
  for (const v of list || []) {
    const s = String(v || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function wizardDiscoverAnki() {
  wizardSetError("");
  wizardCaptureConnectFromUi();
  const status = $("wiz-anki-discover-status");
  setStatus(status, "Discovering...", null);
  const profile = ($("wiz-anki-profile")?.value || "").trim() || "User 1";
  const r = await api("POST", "/api/anki/discover", { profile });
  if (!r.ok || !r.payload || r.payload.ok !== true) {
    setStatus(status, (r.payload && r.payload.error) || r.stderr || "Discover failed.", "bad");
    wizardState.discovered = null;
    renderWizard();
    return;
  }
  wizardState.discovered = r.payload;
  setStatus(status, "OK. Click a deck and a word field to fill the rule.", "good");
  renderWizard();
}

async function wizardRefreshAnkiProfiles() {
  const select = $("wiz-anki-profile-select");
  if (!select) return;

  const r = await api("GET", "/api/anki/profiles");
  const profiles = Array.isArray(r.profiles) ? r.profiles : [];
  const current = ($("wiz-anki-profile")?.value || "").trim();

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "(select a profile)" : "(no profiles detected)";
  select.appendChild(placeholder);

  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }

  if (profiles.includes(current)) select.value = current;
}

function renderWizardDiscoveredAnki() {
  const root = $("wiz-anki-discovered");
  if (!root) return;
  const payload = wizardState.discovered;
  if (!payload) {
    root.hidden = true;
    $("wiz-anki-decks").innerHTML = "";
    $("wiz-anki-notetypes").innerHTML = "";
    $("wiz-anki-fields").innerHTML = "";
    return;
  }

  root.hidden = false;
  const decks = normalizeList(payload.decks)
    .map((d) => String((d && typeof d === "object" ? d.name : d) || ""))
    .map((s) => s.trim())
    .filter(Boolean);

  const noteTypes = normalizeList(payload.note_types).map((nt) => String(nt?.name || "")).filter(Boolean);

  const fields = [];
  for (const nt of normalizeList(payload.note_types)) {
    for (const f of normalizeList(nt?.fields)) fields.push(String(f || ""));
  }
  const uniqueFields = [...new Set(fields.map((x) => x.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  $("wiz-anki-decks").innerHTML = "";
  $("wiz-anki-notetypes").innerHTML = "";
  $("wiz-anki-fields").innerHTML = "";

  for (const d of decks) {
    $("wiz-anki-decks").appendChild(
      makeChip(d, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(d);
          setStatus($("wiz-anki-discover-status"), ok ? `Copied deck: ${d}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureWizardActiveRow();
        if (!row) return;
        const input = row.querySelector(".decks");
        const curr = parseCommaList(input.value);
        curr.push(d);
        setCommaListInput(input, curr);
        wizardSetError("");
      })
    );
  }

  for (const nt of noteTypes) {
    $("wiz-anki-notetypes").appendChild(
      makeChip(nt, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(nt);
          setStatus($("wiz-anki-discover-status"), ok ? `Copied note type: ${nt}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureWizardActiveRow();
        if (!row) return;
        const input = row.querySelector(".notetypes");
        const curr = parseCommaList(input.value);
        curr.push(nt);
        setCommaListInput(input, curr);
        wizardSetError("");
      })
    );
  }

  for (const f of uniqueFields) {
    $("wiz-anki-fields").appendChild(
      makeChip(f, async (e) => {
        if (e.shiftKey) {
          const ok = await copyText(f);
          setStatus($("wiz-anki-discover-status"), ok ? `Copied field: ${f}` : "Copy failed.", ok ? "good" : "bad");
          return;
        }
        const row = ensureWizardActiveRow();
        if (!row) return;
        row.querySelector(".field").value = f;
        wizardSetError("");
      })
    );
  }
}

async function createConfigFromWizard() {
  wizardSetError("");
  const status = $("wiz-create-status");
  setStatus(status, "Creating config...", null);
  const cfg = getDefaultConfig();
  const r = await api("POST", "/api/config", cfg);
  if (!r.ok) {
    setStatus(status, r.error || "Failed to create config.", "bad");
    return false;
  }
  setStatus(status, "Created.", "good");
  currentConfig = (await loadConfig()) || currentConfig;
  await refreshWizardConfigMissing();
  await renderWizard();
  return true;
}

function wizardApplyStep2ChoicesToUi() {
  const ankiIncluded = wizardState.includeAnki;
  if ($("anki-enabled")) $("anki-enabled").checked = ankiIncluded;
  if ($("anki-nonblocking")) $("anki-nonblocking").checked = !ankiIncluded;

  if ($("mokuro-enabled")) $("mokuro-enabled").checked = wizardState.includeMokuro;
  if ($("ttsu-enabled")) $("ttsu-enabled").checked = wizardState.includeTtsu;
  if ($("gsm-enabled")) $("gsm-enabled").checked = wizardState.includeGsm;
}

async function wizardSaveToken() {
  const token = (wizardState.togglToken || "").trim();
  if (!token) return { ok: false, error: "Enter your Toggl API token to continue." };
  const r = await api("POST", "/api/toggl-token", { token });
  if (!r.ok) return { ok: false, error: r.error || "Failed to save token." };
  $("toggl-token").value = token;
  setStatus($("toggl-status"), "Saved.", "good");
  return { ok: true };
}

function wizardApplyReportSettingsToUi() {
  if ($("report-output-dir")) $("report-output-dir").value = wizardState.outputDir || "";
  if ($("report-timezone")) $("report-timezone").value = wizardState.timezone || "local";
  populateThemeSelect();
  if ($("report-theme")) $("report-theme").value = wizardState.theme || "dark-graphite";
}

function wizardApplyAnkiToUi() {
  const profile = (wizardState.ankiProfile || "").trim() || "User 1";
  const rules = Array.isArray(wizardState.ankiRules) ? wizardState.ankiRules : [];

  if (!wizardState.includeAnki) {
    if ($("anki-enabled")) $("anki-enabled").checked = false;
    if ($("anki-nonblocking")) $("anki-nonblocking").checked = true;
    return { ok: true };
  }

  if (!profile) return { ok: false, error: "Choose your Anki profile to continue." };
  if (!rules.length) return { ok: false, error: "Add at least one Anki rule (deck + word field) to continue." };

  if ($("anki-enabled")) $("anki-enabled").checked = true;
  if ($("anki-nonblocking")) $("anki-nonblocking").checked = false;
  if ($("anki-profile")) $("anki-profile").value = profile;

  populateRulesTable(rules);

  return { ok: true };
}

function wizardApplyOptionalSourcesToUi() {
  if (wizardState.includeMokuro) {
    const p = (wizardState.mokuroPath || "").trim();
    if ($("mokuro-path")) $("mokuro-path").value = p;
    if ($("mokuro-enabled")) $("mokuro-enabled").checked = true;
  } else if ($("mokuro-enabled")) {
    $("mokuro-enabled").checked = false;
  }

  if (wizardState.includeTtsu) {
    const p = (wizardState.ttsuPath || "").trim();
    if ($("ttsu-path")) $("ttsu-path").value = p;
    if ($("ttsu-enabled")) $("ttsu-enabled").checked = true;
  } else if ($("ttsu-enabled")) {
    $("ttsu-enabled").checked = false;
  }

  if ($("gsm-enabled")) $("gsm-enabled").checked = wizardState.includeGsm;
}

async function wizardFinishAndSave() {
  wizardSetError("");
  wizardApplyStep2ChoicesToUi();
  wizardApplyOptionalSourcesToUi();
  wizardApplyReportSettingsToUi();

  if (wizardState.togglBaselineHms) {
    if ($("toggl-baseline-hms")) $("toggl-baseline-hms").value = wizardState.togglBaselineHms;
  }

  const tokenRes = await wizardSaveToken();
  if (!tokenRes.ok) return tokenRes;

  const ankiRes = wizardApplyAnkiToUi();
  if (!ankiRes.ok) return ankiRes;

  if (wizardState.configMissing) {
    const ok = await createConfigFromWizard();
    if (!ok) return { ok: false, error: "Could not create config.json." };
  }

  try {
    await saveConfig(currentConfig);
    currentConfig = (await loadConfig()) || currentConfig;
    try {
      localStorage.setItem(WIZARD_SEEN_KEY, "1");
    } catch {
      // ignore
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function wizardSavePartialConfigForAnkiTest() {
  wizardCaptureConnectFromUi();

  if (wizardState.configMissing) {
    const ok = await createConfigFromWizard();
    if (!ok) return { ok: false, error: "Could not create config.json." };
  }

  const tokenRes = await wizardSaveToken();
  if (!tokenRes.ok) return tokenRes;

  wizardApplyStep2ChoicesToUi();
  wizardApplyOptionalSourcesToUi();
  wizardApplyReportSettingsToUi();

  if (wizardState.togglBaselineHms) {
    if ($("toggl-baseline-hms")) $("toggl-baseline-hms").value = wizardState.togglBaselineHms;
  }

  const ankiRes = wizardApplyAnkiToUi();
  if (!ankiRes.ok) return ankiRes;

  await saveConfig(currentConfig);
  currentConfig = (await loadConfig()) || currentConfig;
  return { ok: true };
}

function wizardReadStep2FromUi() {
  wizardState.includeAnki = $("wiz-src-anki")?.checked !== false;
  wizardState.includeMokuro = $("wiz-src-mokuro")?.checked === true;
  wizardState.includeTtsu = $("wiz-src-ttsu")?.checked === true;
  wizardState.includeGsm = $("wiz-src-gsm")?.checked === true;
}

function wizardCaptureConnectFromUi() {
  wizardState.togglToken = ($("wiz-toggl-token")?.value || "").trim();
  wizardState.togglBaselineHms = ($("wiz-toggl-baseline")?.value || "").trim();

  if (wizardState.includeAnki) {
    wizardState.ankiProfile = ($("wiz-anki-profile")?.value || "").trim() || "User 1";
    wizardState.ankiRulesDraft = readWizardRulesDraftFromTable();
    wizardState.ankiRules = readWizardRulesFromTable();
  } else {
    wizardState.ankiRulesDraft = [];
    wizardState.ankiRules = [];
  }

  wizardState.mokuroPath = ($("wiz-mokuro-path")?.value || "").trim();
  wizardState.ttsuPath = ($("wiz-ttsu-path")?.value || "").trim();
}

function wizardReadStep4FromUi() {
  wizardState.outputDir = ($("wiz-output")?.value || "").trim();
  wizardState.timezone = ($("wiz-timezone")?.value || "").trim() || "local";
  wizardState.theme = ($("wiz-theme")?.value || "").trim() || "dark-graphite";
}

async function wizardPickInto(inputId, title) {
  const p = await pickPath("folder", title);
  if (!p) return;
  const input = $(inputId);
  if (input) input.value = p;
}

async function renderWizard() {
  await refreshWizardConfigMissing();
  renderWizardSteps();
  wizardSetError("");

  const closeBtn = $("wizard-close");
  if (closeBtn) closeBtn.disabled = wizardState.forced && wizardState.configMissing;

  const backBtn = $("wizard-back");
  const nextBtn = $("wizard-next");
  if (backBtn) backBtn.disabled = wizardState.step === 0;

  if (nextBtn) {
    nextBtn.textContent = wizardState.step === 3 ? "Save and finish" : "Next";
  }

  if (wizardState.step === 0) {
    const cfgPath = currentEnv?.userRoot ? `${currentEnv.userRoot}\\config.json` : "config.json";
    const userRoot = currentEnv?.userRoot || "(unknown)";
    wizardBodySet(`
      <div class="wizard-section">
        <div class="wizard-h1">Welcome to Tokei</div>
        <div class="wizard-p">Tokei needs a setup file before it can build your dashboard.</div>
        <div class="wizard-p">Status: <b>${wizardState.configMissing ? "Not found yet" : "Found"}</b></div>
        <div class="wizard-p">We will save it here:</div>
        <div class="wizard-code"><code>${escapeHtml(cfgPath)}</code></div>
        <div class="wizard-row">
          <button id="wiz-create" class="btn primary" type="button">Create config</button>
          <button id="wiz-open-folder" class="btn" type="button">Open config folder</button>
          <div id="wiz-create-status" class="status"></div>
        </div>
        <div class="wizard-p">If you already have a config file, you can place it in:</div>
        <div class="wizard-code"><code>${escapeHtml(userRoot)}</code></div>
      </div>
    `);

    $("wiz-create")?.addEventListener("click", async () => {
      await createConfigFromWizard();
    });
    $("wiz-open-folder")?.addEventListener("click", async () => {
      if (!currentEnv?.userRoot) return;
      await openTarget(currentEnv.userRoot);
    });
    return;
  }

  if (wizardState.step === 1) {
    wizardBodySet(`
      <div class="wizard-section">
        <div class="wizard-h1">Choose what to include</div>
        <div class="wizard-p">Toggl hours are required. Everything else is optional.</div>

        <div class="wizard-checks">
          <label class="check"><input id="wiz-src-anki" type="checkbox" /> Include Anki stats (reviews + retention)</label>
          <label class="check"><input id="wiz-src-mokuro" type="checkbox" /> Include Mokuro (manga reading)</label>
          <label class="check"><input id="wiz-src-ttsu" type="checkbox" /> Include Ttsu Reader (novel reading)</label>
          <label class="check"><input id="wiz-src-gsm" type="checkbox" /> Include GameSentenceMiner (GSM)</label>
        </div>

        <div class="wizard-note">
          If you turn off Anki stats, Tokei will not block report generation when Anki isn’t set up.
        </div>
      </div>
    `);

    $("wiz-src-anki").checked = wizardState.includeAnki;
    $("wiz-src-mokuro").checked = wizardState.includeMokuro;
    $("wiz-src-ttsu").checked = wizardState.includeTtsu;
    $("wiz-src-gsm").checked = wizardState.includeGsm;
    return;
  }

  if (wizardState.step === 2) {
    const ankiSection = wizardState.includeAnki
      ? `
        <div class="wizard-section">
          <div class="wizard-h1">Anki stats</div>
          <div class="wizard-p">Choose your Anki profile, then add one or more rules.</div>

          <div class="wizard-row">
            <div style="flex: 1; min-width: 220px">
              <div class="subhead">Anki profile</div>
              <input id="wiz-anki-profile" class="input" type="text" placeholder="Example: User 1" />
            </div>
            <div style="flex: 1; min-width: 220px">
              <div class="subhead">Detected profiles</div>
              <select id="wiz-anki-profile-select" class="input">
                <option value="">(detect profiles)</option>
              </select>
            </div>
            <div style="display: flex; align-items: flex-end; gap: 10px">
              <button id="wiz-anki-profiles-refresh" class="btn" type="button">Detect</button>
            </div>
          </div>

          <div class="wizard-row">
            <button id="wiz-anki-discover" class="btn" type="button">Discover decks/fields</button>
            <button id="wiz-anki-test" class="btn" type="button">Test export</button>
            <div id="wiz-anki-discover-status" class="status"></div>
            <div id="wiz-anki-test-status" class="status"></div>
          </div>

          <div class="wizard-p">
            Add one or more rules below. We strongly recommend tracking a <b>word field</b> (Expression / Vocab / Word), not a sentence field.
          </div>

          <div class="rules">
            <table class="rules-table">
              <thead>
                <tr>
                  <th>Rule ID</th>
                  <th>Deck paths (comma-separated)</th>
                  <th>Target field</th>
                  <th>Note types (optional, comma-separated)</th>
                  <th>Subdecks</th>
                  <th>Mature days</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="wiz-rules-body"></tbody>
            </table>
            <div class="wizard-row">
              <button id="wiz-rule-add" class="btn" type="button">Add rule</button>
            </div>
          </div>

          <div class="wizard-p">
            Tip: click a rule row to select it, then click items below to fill it. Shift+click copies to clipboard.
          </div>

          <div id="wiz-anki-discovered" class="discovered" hidden>
            <div class="discover-grid">
              <div>
                <div class="subhead">Decks</div>
                <div id="wiz-anki-decks" class="chips"></div>
              </div>
              <div>
                <div class="subhead">Note types</div>
                <div id="wiz-anki-notetypes" class="chips"></div>
              </div>
              <div>
                <div class="subhead">Fields</div>
                <div id="wiz-anki-fields" class="chips"></div>
              </div>
            </div>
          </div>
        </div>
      `
      : `
        <div class="wizard-section">
          <div class="wizard-h1">Anki stats</div>
          <div class="wizard-p">You turned off Anki stats. Reports will still run, and Anki numbers will show as 0.</div>
        </div>
      `;

    wizardBodySet(`
      <div class="wizard-section">
        <div class="wizard-h1">Toggl</div>
        <div class="wizard-p">Enter your Toggl API token. You can find it in Toggl: Profile → Profile settings → API token.</div>
        <div class="wizard-row">
          <input id="wiz-toggl-token" class="input" type="password" placeholder="Toggl API token" />
          <button id="wiz-toggl-show" class="btn" type="button">Show</button>
          <button id="wiz-toggl-open" class="btn" type="button">Open Toggl Summary</button>
        </div>
        <div class="wizard-p">
          If you’ve used Toggl for more than 60 days, it’s recommended to enter a one-time lifetime baseline (through yesterday).
        </div>
        <div class="wizard-row">
          <input id="wiz-toggl-baseline" class="input" type="text" placeholder="Lifetime baseline HH:MM:SS (optional)" />
        </div>
      </div>

      ${ankiSection}

      <div class="wizard-section">
        <div class="wizard-h1">Reading sources (optional)</div>
        <div class="wizard-p">
          For Mokuro and Ttsu, we strongly recommend syncing their folders with Google Drive so your data stays up to date.
        </div>
        <div class="wizard-p">
          This requires Google Drive for Desktop (so the folders exist as normal folders on your PC). The website alone is not enough.
        </div>
        <div class="wizard-row">
          <button id="wiz-open-drive" class="btn" type="button">Download Google Drive for Desktop</button>
        </div>

        <div class="wizard-sub" ${wizardState.includeMokuro ? "" : "hidden"}>
          <div class="wizard-h2">Mokuro</div>
          <div class="wizard-row">
            <input id="wiz-mokuro-path" class="input" type="text" placeholder="Path to mokuro-reader folder" />
            <button id="wiz-mokuro-browse" class="btn" type="button">Browse…</button>
          </div>
          <div class="wizard-note">Tip: If you use Google Drive for Desktop, your Drive is often <code>G:\\</code>.</div>
        </div>

        <div class="wizard-sub" ${wizardState.includeTtsu ? "" : "hidden"}>
          <div class="wizard-h2">Ttsu Reader</div>
          <div class="wizard-row">
            <input id="wiz-ttsu-path" class="input" type="text" placeholder="Path to ttu-reader-data folder" />
            <button id="wiz-ttsu-browse" class="btn" type="button">Browse…</button>
          </div>
          <div class="wizard-note">Tip: If you use Google Drive for Desktop, your Drive is often <code>G:\\</code>.</div>
        </div>

        <div class="wizard-sub" ${wizardState.includeGsm ? "" : "hidden"}>
          <div class="wizard-h2">GameSentenceMiner (GSM)</div>
          <div class="wizard-p">
            Sometimes GSM’s database doesn’t update the same day. Our “GSM live sessions” helper can keep today’s numbers up to date while you read.
          </div>
          <div class="wizard-row">
            <button id="wiz-gsm-install" class="btn primary" type="button">Install GSM live sessions</button>
            <button id="wiz-gsm-copy-shim" class="btn" type="button">Copy plugins.py shim</button>
            <div id="wiz-gsm-status" class="status"></div>
          </div>
          <div class="wizard-note">
            After installing, paste the shim into GSM’s <code>plugins.py</code> (Setup tab → GSM live sessions → Advanced can help).
          </div>
        </div>
      </div>
    `);

    $("wiz-toggl-token").value = wizardState.togglToken || $("toggl-token")?.value || "";
    $("wiz-toggl-baseline").value = wizardState.togglBaselineHms || $("toggl-baseline-hms")?.value || "";

    $("wiz-toggl-show")?.addEventListener("click", () => {
      const input = $("wiz-toggl-token");
      if (!input) return;
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      $("wiz-toggl-show").textContent = reveal ? "Hide" : "Show";
    });

    $("wiz-toggl-open")?.addEventListener("click", async () => {
      await api("POST", "/api/open", { target: "https://track.toggl.com/reports/summary" });
    });

    $("wiz-open-drive")?.addEventListener("click", async () => {
      await api("POST", "/api/open", { target: "https://workspace.google.com/products/drive/" });
    });

    $("wiz-mokuro-browse")?.addEventListener("click", async () => wizardPickInto("wiz-mokuro-path", "Select Mokuro folder (mokuro-reader)"));
    $("wiz-ttsu-browse")?.addEventListener("click", async () => wizardPickInto("wiz-ttsu-path", "Select Ttsu ttu-reader-data folder"));

    if (wizardState.includeGsm) {
      $("wiz-gsm-install")?.addEventListener("click", async () => {
        const st = $("wiz-gsm-status");
        setStatus(st, "Installing...", null);
        const r = await api("POST", "/api/gsm/install-helper", {});
        if (!r.ok) return setStatus(st, r.error || "Install failed.", "bad");
        const msg = r.changed ? "Installed. Next: paste the shim into plugins.py." : "Already installed.";
        return setStatus(st, msg, "good");
      });
      $("wiz-gsm-copy-shim")?.addEventListener("click", async () => {
        const st = $("wiz-gsm-status");
        setStatus(st, "Copying...", null);
        const r = await api("GET", "/api/gsm/plugin-snippet");
        if (!r.ok) return setStatus(st, r.error || "Failed.", "bad");
        const text = String(r.snippet || "");
        try {
          await copyText(text);
          setStatus(st, "Copied. Paste into plugins.py.", "good");
        } catch (e) {
          setStatus(st, String(e?.message || e), "bad");
        }
      });
    }

    if (wizardState.includeAnki) {
      $("wiz-anki-profile").value = wizardState.ankiProfile || getAnkiProfileFromUi();
      populateWizardRulesTable(wizardState.ankiRulesDraft);

      $("wiz-anki-profiles-refresh")?.addEventListener("click", async () => {
        setStatus($("wiz-anki-discover-status"), "Detecting profiles...", null);
        await wizardRefreshAnkiProfiles();
        const select = $("wiz-anki-profile-select");
        const profiles = select ? Array.from(select.options).map((o) => o.value).filter(Boolean) : [];
        setStatus(
          $("wiz-anki-discover-status"),
          profiles.length ? "Profiles detected. Select one from the dropdown." : "No profiles detected. Type it manually (example: User 1).",
          profiles.length ? "good" : "bad"
        );
      });

      $("wiz-anki-profile-select")?.addEventListener("change", () => {
        const v = ($("wiz-anki-profile-select")?.value || "").trim();
        if (!v) return;
        const input = $("wiz-anki-profile");
        if (input) input.value = v;
      });

      $("wiz-anki-discover")?.addEventListener("click", wizardDiscoverAnki);
      $("wiz-anki-test")?.addEventListener("click", async () => {
        const st = $("wiz-anki-test-status");
        setStatus(st, "Testing...", null);
        const prep = await wizardSavePartialConfigForAnkiTest();
        if (!prep.ok) return setStatus(st, prep.error || "Setup not ready.", "bad");
        const r = await api("POST", "/api/anki/test-export", {});
        if (r.ok) setStatus(st, "OK. Anki export ran successfully.", "good");
        else setStatus(st, r.message || r.error || r.stderr || "Test failed.", "bad");
      });

      $("wiz-rule-add")?.addEventListener("click", () => {
        const body = $("wiz-rules-body");
        if (!body) return;
        const onRemove = (tr) => {
          const wasActive = wizardActiveRuleRow === tr;
          tr.remove();
          if (wasActive) ensureWizardActiveRow();
        };
        body.appendChild(
          wizardRuleRow(
            {
              rule_id: `rule_${body.children.length + 1}`,
              deck_paths: [],
              include_subdecks: true,
              note_types: [],
              target_field: "",
              mature_interval_days: 21,
            },
            onRemove
          )
        );
        const last = body.querySelector("tr:last-child");
        if (last) setWizardActiveRuleRow(last);
      });

      await wizardRefreshAnkiProfiles();
      renderWizardDiscoveredAnki();
    }

    return;
  }

  if (wizardState.step === 3) {
    wizardBodySet(`
      <div class="wizard-section">
        <div class="wizard-h1">Finish setup</div>
        <div class="wizard-p">Choose where reports are saved, then we’ll save your setup.</div>

        <div class="wizard-row">
          <input id="wiz-output" class="input" type="text" placeholder="Output folder (leave blank for default)" />
          <button id="wiz-output-browse" class="btn" type="button">Browse…</button>
        </div>

        <div class="wizard-row">
          <input id="wiz-timezone" class="input" type="text" placeholder="Timezone (local recommended)" />
          <select id="wiz-theme" class="input"></select>
          <button id="wiz-theme-samples" class="btn" type="button">Open theme samples</button>
        </div>

        <div class="wizard-note">
          Summary: Toggl is required. Anki stats are ${wizardState.includeAnki ? "enabled" : "disabled"}. Reading sources: ${[
            wizardState.includeMokuro ? "Mokuro" : null,
            wizardState.includeTtsu ? "Ttsu" : null,
            wizardState.includeGsm ? "GSM" : null,
          ]
            .filter(Boolean)
            .join(", ") || "none"}.
        </div>
      </div>
    `);

    $("wiz-output").value = wizardState.outputDir || $("report-output-dir")?.value || "";
    $("wiz-timezone").value = wizardState.timezone || $("report-timezone")?.value || "local";

    const themeSel = $("wiz-theme");
    if (themeSel) {
      themeSel.innerHTML = "";
      for (const opt of THEME_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.id;
        o.textContent = opt.label;
        themeSel.appendChild(o);
      }
      const current = wizardState.theme || $("report-theme")?.value || "dark-graphite";
      const has = Array.from(themeSel.options).some((o) => o.value === current);
      if (!has) {
        const custom = document.createElement("option");
        custom.value = current;
        custom.textContent = current;
        themeSel.appendChild(custom);
      }
      themeSel.value = current;
    }

    $("wiz-output-browse")?.addEventListener("click", async () => wizardPickInto("wiz-output", "Select output folder"));
    $("wiz-theme-samples")?.addEventListener("click", async () => {
      if (!currentEnv?.appRoot) return;
      await openTarget(`${currentEnv.appRoot}\\samples`);
    });
    return;
  }
}

async function openWizard({ forced = false } = {}) {
  wizardState.forced = forced;
  wizardState.step = 0;
  wizardState.discovered = null;
  await refreshWizardConfigMissing();

  wizardApplyStep2ChoicesToUi();
  wizardState.ankiProfile = getAnkiProfileFromUi();
  wizardState.ankiRulesDraft = readRulesFromTable();
  wizardState.ankiRules = wizardState.ankiRulesDraft.filter((r) => (r?.deck_paths || []).length && String(r?.target_field || "").trim());
  wizardState.outputDir = ($("report-output-dir")?.value || "").trim();
  wizardState.timezone = ($("report-timezone")?.value || "").trim() || "local";
  wizardState.theme = ($("report-theme")?.value || "").trim() || "dark-graphite";
  wizardLoadDraftFromLocalStorage();

  wizardState.open = true;
  await renderWizard();
  showWizardOverlay(true);
}

async function closeWizard() {
  await refreshWizardConfigMissing();
  if (wizardState.forced && wizardState.configMissing) return;
  showWizardExitOverlay(false);
  showWizardOverlay(false);
  wizardState.open = false;
}

function wizardShouldConfirmExit() {
  if (!wizardState.open) return false;
  if (wizardState.forced && wizardState.configMissing) return false;
  return wizardState.step > 0;
}

async function wizardCaptureAllOpenStepInputs() {
  if (wizardState.step === 1) wizardReadStep2FromUi();
  if (wizardState.step === 2) wizardCaptureConnectFromUi();
  if (wizardState.step === 3) wizardReadStep4FromUi();
}

function wizardPersistDraftToLocalStorage() {
  try {
    const draft = {
      includeAnki: wizardState.includeAnki,
      includeMokuro: wizardState.includeMokuro,
      includeTtsu: wizardState.includeTtsu,
      includeGsm: wizardState.includeGsm,
      togglToken: wizardState.togglToken,
      togglBaselineHms: wizardState.togglBaselineHms,
      ankiProfile: wizardState.ankiProfile,
      ankiRulesDraft: wizardState.ankiRulesDraft,
      mokuroPath: wizardState.mokuroPath,
      ttsuPath: wizardState.ttsuPath,
      outputDir: wizardState.outputDir,
      timezone: wizardState.timezone,
      theme: wizardState.theme,
    };
    localStorage.setItem("tokei_wizard_draft_v1", JSON.stringify(draft));
  } catch {
    // ignore
  }
}

function wizardLoadDraftFromLocalStorage() {
  try {
    const raw = localStorage.getItem("tokei_wizard_draft_v1");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    if (typeof parsed.includeAnki === "boolean") wizardState.includeAnki = parsed.includeAnki;
    if (typeof parsed.includeMokuro === "boolean") wizardState.includeMokuro = parsed.includeMokuro;
    if (typeof parsed.includeTtsu === "boolean") wizardState.includeTtsu = parsed.includeTtsu;
    if (typeof parsed.includeGsm === "boolean") wizardState.includeGsm = parsed.includeGsm;
    if (typeof parsed.togglToken === "string") wizardState.togglToken = parsed.togglToken;
    if (typeof parsed.togglBaselineHms === "string") wizardState.togglBaselineHms = parsed.togglBaselineHms;
    if (typeof parsed.ankiProfile === "string") wizardState.ankiProfile = parsed.ankiProfile;
    if (Array.isArray(parsed.ankiRulesDraft)) wizardState.ankiRulesDraft = parsed.ankiRulesDraft;
    if (typeof parsed.mokuroPath === "string") wizardState.mokuroPath = parsed.mokuroPath;
    if (typeof parsed.ttsuPath === "string") wizardState.ttsuPath = parsed.ttsuPath;
    if (typeof parsed.outputDir === "string") wizardState.outputDir = parsed.outputDir;
    if (typeof parsed.timezone === "string") wizardState.timezone = parsed.timezone;
    if (typeof parsed.theme === "string") wizardState.theme = parsed.theme;
  } catch {
    // ignore
  }
}

async function wizardSaveDraftToDisk() {
  await wizardCaptureAllOpenStepInputs();
  wizardPersistDraftToLocalStorage();

  await refreshWizardConfigMissing();
  if (wizardState.configMissing) {
    const ok = await createConfigFromWizard();
    if (!ok) return { ok: false, error: "Could not create config.json." };
  }

  if (wizardState.togglToken) {
    const rTok = await api("POST", "/api/toggl-token", { token: wizardState.togglToken });
    if (!rTok.ok) return { ok: false, error: rTok.error || "Failed to save Toggl token." };
  }

  wizardApplyStep2ChoicesToUi();
  wizardApplyOptionalSourcesToUi();
  wizardApplyReportSettingsToUi();

  if (wizardState.togglBaselineHms) {
    try {
      parseHmsToHours(wizardState.togglBaselineHms);
      if ($("toggl-baseline-hms")) $("toggl-baseline-hms").value = wizardState.togglBaselineHms;
    } catch {
      // ignore invalid baseline in draft saves
    }
  }

  if (wizardState.includeAnki) {
    if ($("anki-profile")) $("anki-profile").value = wizardState.ankiProfile || "User 1";
    populateRulesTable(Array.isArray(wizardState.ankiRulesDraft) ? wizardState.ankiRulesDraft : []);
    const complete = readRulesFromTable();
    if (!complete.length) {
      if ($("anki-enabled")) $("anki-enabled").checked = false;
      if ($("anki-nonblocking")) $("anki-nonblocking").checked = true;
    }
  }

  await saveConfig(currentConfig);
  currentConfig = (await loadConfig()) || currentConfig;
  return { ok: true };
}

async function closeWizardWithOptionalConfirm() {
  await refreshWizardConfigMissing();
  if (wizardState.forced && wizardState.configMissing) return;
  if (!wizardShouldConfirmExit()) return closeWizard();
  showWizardExitOverlay(true);
}

async function wizardBack() {
  wizardSetError("");
  if (wizardState.step <= 0) return;
  wizardState.step -= 1;
  await renderWizard();
}

async function wizardNext() {
  wizardSetError("");

  if (wizardState.step === 0) {
    if (wizardState.configMissing) {
      wizardSetError("Click “Create config” to continue.");
      return;
    }
    wizardState.step = 1;
    await renderWizard();
    return;
  }

  if (wizardState.step === 1) {
    wizardReadStep2FromUi();
    wizardApplyStep2ChoicesToUi();
    wizardState.step = 2;
    await renderWizard();
    return;
  }

  if (wizardState.step === 2) {
    wizardCaptureConnectFromUi();

    if (!wizardState.togglToken) {
      wizardSetError("Enter your Toggl API token to continue.");
      return;
    }

    if (wizardState.togglBaselineHms) {
      try {
        parseHmsToHours(wizardState.togglBaselineHms);
      } catch (e) {
        wizardSetError(`Lifetime baseline time is invalid: ${String(e?.message || e)}`);
        return;
      }
    }

    if (wizardState.includeAnki) {
      if (!wizardState.ankiProfile) {
        wizardSetError("Choose your Anki profile to continue.");
        return;
      }
      if (!wizardState.ankiRules.length) {
        wizardSetError("Add at least one Anki rule (deck + word field) to continue.");
        return;
      }
    }

    wizardState.step = 3;
    await renderWizard();
    return;
  }

  if (wizardState.step === 3) {
    wizardReadStep4FromUi();
    const r = await wizardFinishAndSave();
    if (!r.ok) {
      wizardSetError(r.error || "Failed.");
      return;
    }
    wizardSetStatus("Setup saved.", "good");
    await closeWizard();
    return;
  }
}

function dirnameLite(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(0, i) : s;
}

async function pickPath(kind, title, opts = {}) {
  const endpoint = kind === "file" ? "/api/dialog/open-file" : "/api/dialog/open-folder";
  const r = await api("POST", endpoint, { title, ...opts });
  if (!r.ok) {
    alert(r.error || "Picker not available in this mode. Paste the path manually.");
    return null;
  }
  return typeof r.path === "string" ? r.path : null;
}

let currentConfig = null;

function wireUi() {
  const setupTab = $("tab-setup");
  if (setupTab) setupTab.addEventListener("click", () => selectTab("setup"));
  const sourcesTab = $("tab-sources");
  if (sourcesTab) sourcesTab.addEventListener("click", () => selectTab("sources"));
  const runTab = $("tab-run");
  if (runTab) runTab.addEventListener("click", () => selectTab("run"));
  const gettingStartedTab = $("tab-getting-started");
  if (gettingStartedTab) gettingStartedTab.addEventListener("click", () => selectTab("getting-started"));

  const sourcesSave = $("sources-save");
  if (sourcesSave) {
    sourcesSave.addEventListener("click", async () => {
      setStatus($("sources-status"), "Saving...", null);
      await saveConfig(currentConfig);
      currentConfig = (await loadConfig()) || currentConfig;
      setStatus($("sources-status"), "Saved.", "good");
    });
  }

  $("toggl-reveal").addEventListener("click", toggleTogglReveal);
  $("toggl-save").addEventListener("click", saveToken);
  const togglAdvancedToggle = $("toggl-advanced-toggle");
  if (togglAdvancedToggle) {
    togglAdvancedToggle.addEventListener("click", () => toggleVisible($("toggl-advanced")));
  }
  const togglAdvancedClose = $("toggl-advanced-close");
  if (togglAdvancedClose) {
    togglAdvancedClose.addEventListener("click", () => setVisible($("toggl-advanced"), false));
  }
  const togglOpenSummary = $("toggl-open-summary");
  if (togglOpenSummary) {
    togglOpenSummary.addEventListener("click", async () => {
      await api("POST", "/api/open", { target: "https://track.toggl.com/reports/summary" });
    });
  }
  const togglBaselineSave = $("toggl-baseline-save");
  if (togglBaselineSave) {
    togglBaselineSave.addEventListener("click", async () => {
      await saveConfig(currentConfig);
      currentConfig = (await loadConfig()) || currentConfig;
    });
  }

  const reportOutputBrowse = $("report-output-browse");
  if (reportOutputBrowse) {
    reportOutputBrowse.addEventListener("click", async () => {
      const p = await pickPath("folder", "Select output folder");
      if (!p) return;
      const input = $("report-output-dir");
      if (input) input.value = p;
    });
  }

  const reportOutputOpen = $("report-output-open");
  if (reportOutputOpen) {
    reportOutputOpen.addEventListener("click", async () => {
      const paths = await api("GET", "/api/paths");
      const outRoot = typeof paths?.outRoot === "string" ? paths.outRoot : "";
      if (!outRoot) return;
      await openTarget(outRoot);
    });
  }

  const reportThemeSamples = $("report-theme-samples");
  if (reportThemeSamples) {
    reportThemeSamples.addEventListener("click", async () => {
      if (!currentEnv?.appRoot) return;
      await openTarget(`${currentEnv.appRoot}\\samples`);
    });
  }

  const reportSave = $("report-save-config");
  if (reportSave) {
    reportSave.addEventListener("click", async () => {
      setStatus($("report-save-status"), "Saving...", null);
      await saveConfig(currentConfig);
      currentConfig = (await loadConfig()) || currentConfig;
      setStatus($("report-save-status"), "Saved.", "good");
    });
  }

  const ankiProfilesRefresh = $("anki-profiles-refresh");
  if (ankiProfilesRefresh) ankiProfilesRefresh.addEventListener("click", refreshAnkiProfiles);
  const ankiProfileSelect = $("anki-profile-select");
  if (ankiProfileSelect) {
    ankiProfileSelect.addEventListener("change", () => {
      const v = (ankiProfileSelect.value || "").trim();
      if (!v) return;
      const input = $("anki-profile");
      if (input) input.value = v;
    });
  }

  $("anki-discover").addEventListener("click", ankiDiscover);
  $("anki-test-export").addEventListener("click", ankiTestExport);
  $("anki-advanced-toggle").addEventListener("click", () => toggleVisible($("anki-advanced")));
  $("anki-advanced-close").addEventListener("click", () => setVisible($("anki-advanced"), false));
  $("anki-discovered-close").addEventListener("click", () => setVisible($("anki-discovered"), false));
  $("puppeteer-test").addEventListener("click", puppeteerTest);
  $("python-test").addEventListener("click", pythonTest);
  $("gsm-install").addEventListener("click", gsmInstall);
  $("gsm-open-folder").addEventListener("click", gsmOpenFolder);
  $("gsm-copy").addEventListener("click", gsmCopySnippet);
  $("gsm-copy-helper").addEventListener("click", gsmCopyHelper);
  $("gsm-open-plugin").addEventListener("click", gsmOpenPlugin);
  $("gsm-open-helper").addEventListener("click", gsmOpenHelper);
  $("logs-refresh").addEventListener("click", refreshLogs);
  $("sync-now").addEventListener("click", syncNow);
  $("generate-report").addEventListener("click", generateReport);

  $("rule-add").addEventListener("click", () => {
    $("rules-body").appendChild(
      ruleRow({ rule_id: `rule_${$("rules-body").children.length + 1}`, deck_paths: [], include_subdecks: true, note_types: [], target_field: "", mature_interval_days: 21 }, (tr) => tr.remove())
    );
  });

  $("config-save").addEventListener("click", async () => {
    await saveConfig(currentConfig);
    currentConfig = (await loadConfig()) || currentConfig;
  });

  $("launch-save").addEventListener("click", async () => {
    setStatus($("launch-status"), "Saving...", null);
    await saveConfig(currentConfig);
    currentConfig = (await loadConfig()) || currentConfig;
    setStatus($("launch-status"), "Saved.", "good");
  });

  $("config-discard").addEventListener("click", discardConfigChanges);

  $("open-output").addEventListener("click", async () => {
    await api("POST", "/api/open-output", {});
  });

  $("open-html").addEventListener("click", async () => {
    await api("POST", "/api/open-latest-html", {});
  });

  $("mokuro-open").addEventListener("click", async () => {
    await api("POST", "/api/open", { target: "https://reader.mokuro.app" });
  });
  const mokuroBrowseFolder = $("mokuro-browse-folder");
  if (mokuroBrowseFolder) {
    mokuroBrowseFolder.addEventListener("click", async () => {
      const p = await pickPath("folder", "Select Mokuro folder (mokuro-reader)");
      if (!p) return;
      const input = $("mokuro-path");
      if (input) input.value = p;
      const enabled = $("mokuro-enabled");
      if (enabled) enabled.checked = true;
    });
  }
  const mokuroOpenPath = $("mokuro-open-path");
  if (mokuroOpenPath) {
    mokuroOpenPath.addEventListener("click", async () => {
      const p = ($("mokuro-path")?.value || "").trim();
      if (!p) return;
      await openTarget(dirnameLite(p));
    });
  }

  $("ttsu-open").addEventListener("click", async () => {
    await api("POST", "/api/open", { target: "https://reader.ttsu.app" });
  });
  const ttsuBrowseFolder = $("ttsu-browse-folder");
  if (ttsuBrowseFolder) {
    ttsuBrowseFolder.addEventListener("click", async () => {
      const p = await pickPath("folder", "Select Ttsu ttu-reader-data folder");
      if (!p) return;
      const input = $("ttsu-path");
      if (input) input.value = p;
      const enabled = $("ttsu-enabled");
      if (enabled) enabled.checked = true;
    });
  }
  const ttsuOpenPath = $("ttsu-open-path");
  if (ttsuOpenPath) {
    ttsuOpenPath.addEventListener("click", async () => {
      const p = ($("ttsu-path")?.value || "").trim();
      if (!p) return;
      await openTarget(dirnameLite(p));
    });
  }

  $("gsm-open-folder2").addEventListener("click", async () => {
    await api("POST", "/api/gsm/open-folder", {});
  });
  $("gsm-launch").addEventListener("click", async () => {
    setStatus($("gsm-launch-status"), "Launching...", null);
    const r = await api("POST", "/api/gsm/launch", {});
    if (r.ok) setStatus($("gsm-launch-status"), `Launched: ${r.exePath}`, "good");
    else if (r.error === "gsm_exe_not_found" && r.openedFolder) setStatus($("gsm-launch-status"), `GSM not found; opened: ${r.openedFolder}`, "bad");
    else setStatus($("gsm-launch-status"), r.error || "Launch failed.", "bad");
  });

  $("known-open-folder").addEventListener("click", async () => {
    await api("POST", "/api/known/open-folder", {});
  });
  $("known-open-file").addEventListener("click", async () => {
    await api("POST", "/api/known/open-file", {});
  });
  $("known-import").addEventListener("click", () => $("known-file").click());
  $("known-file").addEventListener("change", async () => {
    const f = $("known-file").files && $("known-file").files[0] ? $("known-file").files[0] : null;
    if (!f) return;
    try {
      const text = await f.text();
      if (text.length > 5_000_000) {
        setStatus($("known-status"), "File too large (>5MB).", "bad");
        return;
      }
      setStatus($("known-status"), "Importing...", null);
      const r = await api("POST", "/api/known/import", { filename: f.name, content: text });
      if (r.ok) setStatus($("known-status"), `Imported: ${r.destPath}`, "good");
      else setStatus($("known-status"), r.error || "Import failed.", "bad");
    } catch (e) {
      setStatus($("known-status"), String(e?.message || e), "bad");
    } finally {
      $("known-file").value = "";
    }
  });

  relocateGettingStartedCard();

  const wizardOpenBtn = $("wizard-open");
  if (wizardOpenBtn) wizardOpenBtn.addEventListener("click", async () => openWizard({ forced: false }));
  const wizardCloseBtn = $("wizard-close");
  if (wizardCloseBtn) wizardCloseBtn.addEventListener("click", closeWizardWithOptionalConfirm);
  const wizardBackBtn = $("wizard-back");
  if (wizardBackBtn) wizardBackBtn.addEventListener("click", wizardBack);
  const wizardNextBtn = $("wizard-next");
  if (wizardNextBtn) wizardNextBtn.addEventListener("click", wizardNext);

  const wizardExitSave = $("wizard-exit-save");
  if (wizardExitSave) {
    wizardExitSave.addEventListener("click", async () => {
      const err = $("wizard-exit-error");
      setStatus(err, "Saving...", null);
      const saveBtn = $("wizard-exit-save");
      const noSaveBtn = $("wizard-exit-nosave");
      const cancelBtn = $("wizard-exit-cancel");
      if (saveBtn) saveBtn.disabled = true;
      if (noSaveBtn) noSaveBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
      try {
        const r = await wizardSaveDraftToDisk();
        if (!r.ok) {
          setStatus(err, r.error || "Save failed.", "bad");
          return;
        }
        showWizardExitOverlay(false);
        await closeWizard();
      } finally {
        if (saveBtn) saveBtn.disabled = false;
        if (noSaveBtn) noSaveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
      }
    });
  }

  const wizardExitNoSave = $("wizard-exit-nosave");
  if (wizardExitNoSave) wizardExitNoSave.addEventListener("click", async () => { showWizardExitOverlay(false); await closeWizard(); });

  const wizardExitCancel = $("wizard-exit-cancel");
  if (wizardExitCancel) wizardExitCancel.addEventListener("click", () => showWizardExitOverlay(false));
}

async function init() {
  wireUi();
  await loadEnv();
  await loadToken();
  currentConfig = await loadConfig();
  await gsmRefreshStatus();
  await refreshLatestReportStats();
  await refreshLatestSync();
  await refreshLogs();

  let forcedTab = "";
  try {
    const url = new URL(window.location.href);
    forcedTab = (url.searchParams.get("tab") || "").trim();
  } catch {
    // ignore
  }

  const setupComplete = localStorage.getItem("tokei_setup_complete") === "1";
  const configMissing = await refreshWizardConfigMissing();
  if (configMissing) {
    window.__tokeiSelectTab("setup");
    await openWizard({ forced: true });
    return;
  }

  const lastTab = (localStorage.getItem("tokei_last_tab") || "").trim();
  if (lastTab && KNOWN_TABS.includes(lastTab)) return window.__tokeiSelectTab(lastTab);
  if (setupComplete) return window.__tokeiSelectTab("run");
  if (forcedTab && KNOWN_TABS.includes(forcedTab)) return window.__tokeiSelectTab(forcedTab);
}

init();
