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

function selectTab(name) {
  for (const t of ["setup", "run", "logs"]) {
    $(`tab-${t}`).classList.toggle("active", t === name);
    $(`panel-${t}`).classList.toggle("active", t === name);
  }
}

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
  const snap = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  $("anki-enabled").checked = snap.enabled === true;
  $("anki-output-dir").value = typeof snap.output_dir === "string" ? snap.output_dir : "hashi_exports";
  setVisible($("anki-advanced"), false);
  populateRulesTable(Array.isArray(snap.rules) ? snap.rules : []);
  renderDiscoveredAnki(null);
  return cfg;
}

async function saveConfig(currentCfg) {
  const cfg = currentCfg && typeof currentCfg === "object" ? currentCfg : {};
  cfg.anki_snapshot = cfg.anki_snapshot && typeof cfg.anki_snapshot === "object" ? cfg.anki_snapshot : {};
  cfg.anki_snapshot.enabled = $("anki-enabled").checked;
  const od = $("anki-output-dir").value.trim();
  cfg.anki_snapshot.output_dir = od || "hashi_exports";
  cfg.anki_snapshot.rules = readRulesFromTable();

  setStatus($("config-status"), "Saving...", null);
  const r = await api("POST", "/api/config", cfg);
  if (r.ok) setStatus($("config-status"), "Saved config.json.", "good");
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

let currentConfig = null;

function wireUi() {
  $("tab-setup").addEventListener("click", () => selectTab("setup"));
  $("tab-run").addEventListener("click", () => selectTab("run"));
  $("tab-logs").addEventListener("click", () => selectTab("logs"));

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

  $("config-discard").addEventListener("click", discardConfigChanges);

  $("open-output").addEventListener("click", async () => {
    await api("POST", "/api/open-output", {});
  });

  $("open-html").addEventListener("click", async () => {
    await api("POST", "/api/open-latest-html", {});
  });
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
}

init();
