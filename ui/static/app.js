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
  el.textContent = msg || "";
  el.classList.remove("good", "bad");
  if (kind) el.classList.add(kind);
}

let activeRuleRow = null;
let discoveredAnki = null;

const KNOWN_TABS = ["run", "setup", "sources", "getting-started", "logs"];

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
        Add your Toggl token (optional), configure Anki snapshot rules, then click <b>Save config.json</b>.
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
      Add your Toggl token (optional), configure Anki snapshot rules, then click Save to write <code>config.json</code>.
    </div>
    <div class="hint">
      Anki stats can come from the built-in snapshot exporter (enable + add rules), or from the Hashi add-on (advanced).
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
  if (!r.ok) {
    setStatus($("config-status"), r.error || "Failed to load config.", "bad");
    return null;
  }
  const cfg = r.config || {};

  const launch = cfg.launch && typeof cfg.launch === "object" ? cfg.launch : {};
  $("launch-open-on-startup").checked = launch.open_on_startup === true;
  $("launch-start-minimized").checked = launch.start_minimized_to_tray === true;
  $("launch-close-minimizes").checked = launch.close_minimizes_to_tray === true;

  const snap = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  $("anki-enabled").checked = snap.enabled === true;
  $("anki-output-dir").value = typeof snap.output_dir === "string" ? snap.output_dir : "hashi_exports";

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
  return cfg;
}

async function saveConfig(currentCfg) {
  const cfg = currentCfg && typeof currentCfg === "object" ? currentCfg : {};
  cfg.launch = cfg.launch && typeof cfg.launch === "object" ? cfg.launch : {};
  cfg.launch.open_on_startup = $("launch-open-on-startup").checked;
  cfg.launch.start_minimized_to_tray = $("launch-start-minimized").checked;
  cfg.launch.close_minimizes_to_tray = $("launch-close-minimizes").checked;

  cfg.anki_snapshot = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  cfg.anki_snapshot.enabled = $("anki-enabled").checked;
  const od = $("anki-output-dir").value.trim();
  cfg.anki_snapshot.output_dir = od || "hashi_exports";
  cfg.anki_snapshot.rules = readRulesFromTable();

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
  }
  else setStatus($("config-status"), r.error || "Failed.", "bad");
}

async function ankiDiscover() {
  setStatus($("anki-status"), "Discovering...", null);
  const r = await api("POST", "/api/anki/discover", {});
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
    setStatus($("anki-status"), r.stderr || "Export failed.", "bad");
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
  $("run-output").textContent = "";
  const r = await api("POST", "/api/sync", {});
  if (r.ok) setStatus($("sync-status"), "OK", "good");
  else setStatus($("sync-status"), r.stderr || `Failed (code ${r.code})`, "bad");
  $("run-output").textContent = [r.stdout, r.stderr].filter(Boolean).join("\n\n");
  await refreshLatestSync();
  await refreshLatestReportStats();
  await refreshLogs();
}

async function generateReport() {
  setStatus($("report-status"), "Generating...", null);
  $("run-output").textContent = "";
  const mode = $("report-mode").value;
  const syncBeforeReport = $("sync-before-report").checked;
  const r = await api("POST", "/api/generate-report", { mode, sync_before_report: syncBeforeReport });
  if (r.ok) setStatus($("report-status"), `OK (Anki exported_at=${r.anki_exported_at || "?"})`, "good");
  else setStatus($("report-status"), r.stderr || `Failed (code ${r.code})`, "bad");
  $("run-output").textContent = [r.stdout, r.stderr].filter(Boolean).join("\n\n");
  await refreshLatestSync();
  await refreshLatestReportStats();
  await refreshLogs();
}

async function openTarget(target) {
  await api("POST", "/api/open", { target });
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

  try {
    const url = new URL(window.location.href);
    const forced = (url.searchParams.get("tab") || "").trim();
    if (forced && KNOWN_TABS.includes(forced)) return window.__tokeiSelectTab(forced);
  } catch {
    // ignore
  }

  const setupComplete = localStorage.getItem("tokei_setup_complete") === "1";
  const lastTab = (localStorage.getItem("tokei_last_tab") || "").trim();
  if (lastTab && KNOWN_TABS.includes(lastTab)) return window.__tokeiSelectTab(lastTab);
  if (setupComplete) return window.__tokeiSelectTab("run");
}

init();
