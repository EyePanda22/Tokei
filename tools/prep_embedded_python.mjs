import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");

const PY_VERSION = (process.env.TOKEI_PYTHON_EMBED_VERSION || "3.12.7").trim();
const PY_ARCH = (process.env.TOKEI_PYTHON_EMBED_ARCH || "amd64").trim();
const FORCE = (process.env.TOKEI_PYTHON_EMBED_FORCE || "").trim() === "1";

const outDir = path.join(repoRoot, "python");
const buildCacheDir = path.join(repoRoot, "build", "python-embed");
const embedZipName = `python-${PY_VERSION}-embed-${PY_ARCH}.zip`;
const embedZipPath = path.join(buildCacheDir, embedZipName);
const embedZipUrl = `https://www.python.org/ftp/python/${PY_VERSION}/${embedZipName}`;

const runtimePkgs = [
  { name: "Jinja2", version: "3.1.4", wheelRegex: /-py3-none-any\.whl$/i },
  { name: "MarkupSafe", version: "2.1.5" },
  { name: "tzdata", version: "2025.2", wheelRegex: /-py2\.py3-none-any\.whl$/i },
];

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJsonOrNull(p) {
  try {
    if (!exists(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function psQuoteLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPwsh(command, { cwd } = {}) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: cwd || repoRoot, stdio: "inherit" }
  );
  if (r.error) throw r.error;
  if (typeof r.status === "number" && r.status !== 0) process.exit(r.status);
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(zipPath).toLowerCase();
  let tmpZip = null;
  let archivePath = zipPath;
  if (ext !== ".zip") {
    tmpZip = `${zipPath}.zip`;
    fs.copyFileSync(zipPath, tmpZip);
    archivePath = tmpZip;
  }
  try {
    const cmd = `Expand-Archive -LiteralPath ${psQuoteLiteral(archivePath)} -DestinationPath ${psQuoteLiteral(destDir)} -Force`;
    runPwsh(cmd, { cwd: repoRoot });
  } finally {
    try {
      if (tmpZip && exists(tmpZip)) fs.rmSync(tmpZip, { force: true });
    } catch {
      // ignore
    }
  }
}

async function downloadToFile(url, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (exists(outPath) && !FORCE) return;

  console.log(`Downloading ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status} ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function findPthFile(pythonDir) {
  const entries = fs.readdirSync(pythonDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.toLowerCase().endsWith("._pth") && ent.name.toLowerCase().startsWith("python")) {
      return path.join(pythonDir, ent.name);
    }
  }
  return null;
}

function parsePythonMinor(pythonVersion) {
  const m = String(pythonVersion).match(/^(\d+)\.(\d+)\./);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function pythonStdlibZipName(pythonVersion) {
  const py = parsePythonMinor(pythonVersion);
  if (!py) return null;
  return `python${py.major}${py.minor}.zip`;
}

function archToPypiPlatform(pyArch) {
  const a = String(pyArch || "").toLowerCase();
  if (a === "amd64" || a === "x64") return "win_amd64";
  if (a === "arm64" || a === "aarch64") return "win_arm64";
  return "win_amd64";
}

async function fetchPypiJson(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch PyPI metadata: HTTP ${resp.status} ${url}`);
  return resp.json();
}

function selectWheelFile({ pkgName, pkgVersion, pypiJson, pythonVersion }) {
  const files = Array.isArray(pypiJson?.urls) && pypiJson.urls.length ? pypiJson.urls : Array.isArray(pypiJson?.releases?.[pkgVersion]) ? pypiJson.releases[pkgVersion] : [];
  const wheels = files.filter((f) => f && f.packagetype === "bdist_wheel" && typeof f.filename === "string" && f.url);
  if (!wheels.length) throw new Error(`No wheels found for ${pkgName}==${pkgVersion}`);

  const py = parsePythonMinor(pythonVersion);
  const cp = py ? `cp${py.major}${py.minor}` : null;
  const plat = archToPypiPlatform(PY_ARCH);

  if (pkgName.toLowerCase() === "markupsafe") {
    const want = cp ? new RegExp(`-${cp}-${cp}-${plat}\\.whl$`, "i") : null;
    const best = want ? wheels.find((w) => want.test(w.filename)) : null;
    if (best) return best;
    const any = wheels.find((w) => /-py3-none-any\.whl$/i.test(w.filename));
    if (any) return any;
    throw new Error(`No compatible MarkupSafe wheel found for ${cp || "unknown"} / ${plat}`);
  }

  const spec = runtimePkgs.find((p) => p.name === pkgName && p.version === pkgVersion);
  if (spec?.wheelRegex) {
    const w = wheels.find((x) => spec.wheelRegex.test(x.filename));
    if (w) return w;
  }

  const any = wheels.find((w) => /-none-any\.whl$/i.test(w.filename));
  if (any) return any;
  return wheels[0];
}

async function prepareRuntimeWheels({ pythonDir }) {
  const sitePackages = path.join(pythonDir, "Lib", "site-packages");
  fs.mkdirSync(sitePackages, { recursive: true });

  const wheelCacheDir = path.join(buildCacheDir, "wheels");
  fs.mkdirSync(wheelCacheDir, { recursive: true });

  const installed = [];
  for (const pkg of runtimePkgs) {
    const meta = await fetchPypiJson(pkg.name, pkg.version);
    const wheel = selectWheelFile({ pkgName: pkg.name, pkgVersion: pkg.version, pypiJson: meta, pythonVersion: PY_VERSION });
    const wheelPath = path.join(wheelCacheDir, wheel.filename);
    await downloadToFile(wheel.url, wheelPath);
    unzip(wheelPath, sitePackages);
    installed.push({ name: pkg.name, version: pkg.version, wheel: wheel.filename });
  }

  return installed;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("prep_embedded_python.mjs: Windows-only (Electron installer is Windows-only).");
    return;
  }

  const markerPath = path.join(outDir, "tokei-python-runtime.json");
  if (!FORCE) {
    const marker = readJsonOrNull(markerPath);
    if (marker?.python?.version === PY_VERSION && marker?.python?.arch === PY_ARCH && exists(path.join(outDir, "python.exe"))) {
      console.log(`Embedded Python already prepared at ${outDir}`);
      return;
    }
  }

  fs.mkdirSync(buildCacheDir, { recursive: true });
  await downloadToFile(embedZipUrl, embedZipPath);

  try {
    if (exists(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Extracting ${embedZipName} to ${outDir}`);
  unzip(embedZipPath, outDir);

  const pthPath = findPthFile(outDir);
  if (!pthPath) throw new Error(`Could not find python ._pth file in ${outDir}`);
  const stdlibZip = pythonStdlibZipName(PY_VERSION) || "python312.zip";
  const pthText = [stdlibZip, ".", "Lib\\site-packages", "import site"].join("\r\n") + "\r\n";
  fs.writeFileSync(pthPath, pthText, "utf8");

  const installed = await prepareRuntimeWheels({ pythonDir: outDir });
  writeJson(markerPath, {
    python: { version: PY_VERSION, arch: PY_ARCH, embedZipUrl },
    packages: installed,
  });

  console.log(`Embedded Python ready: ${path.join(outDir, "python.exe")}`);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
