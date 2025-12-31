import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseSemver(version) {
  const m = String(version || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bumpSemver(v, kind) {
  if (kind === "patch") return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  throw new Error(`Unknown bump kind: ${kind}`);
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function writeText(p, text, dryRun) {
  if (dryRun) return;
  fs.writeFileSync(p, text, "utf8");
}

function updateFileOrDie(filePath, updater, dryRun) {
  const before = readText(filePath);
  const after = updater(before);
  if (after === before) die(`No changes made to ${filePath} (pattern not found?)`);
  writeText(filePath, after, dryRun);
}

function getRepoRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) die(`Failed to locate git repo root: ${(r.stderr || "").trim()}`);
  return (r.stdout || "").trim();
}

function main(argv) {
  const usage = [
    "Usage:",
    "  node tools/bump_version.mjs <patch|minor|major>",
    "  node tools/bump_version.mjs <x.y.z>",
    "Options:",
    "  --dry-run   Print changes without writing files",
  ].join("\n");

  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filtered = args.filter((a) => a !== "--dry-run");
  const target = filtered[0];
  if (!target) die(usage);

  const repoRoot = getRepoRoot();
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(readText(packageJsonPath));
  const currentRaw = packageJson?.version;
  const current = parseSemver(currentRaw);
  if (!current) die(`package.json version must be x.y.z, got: ${JSON.stringify(currentRaw)}`);

  let next;
  if (target === "patch" || target === "minor" || target === "major") {
    next = bumpSemver(current, target);
  } else {
    const explicit = parseSemver(target);
    if (!explicit) die(`Expected patch|minor|major or x.y.z, got: ${target}`);
    next = explicit;
  }
  const nextStr = formatSemver(next);

  const fileChanges = [];

  // package.json
  packageJson.version = nextStr;
  fileChanges.push({
    path: packageJsonPath,
    apply() {
      writeText(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n", dryRun);
    },
  });

  // installer/Tokei.iss
  const issPath = path.join(repoRoot, "installer", "Tokei.iss");
  fileChanges.push({
    path: issPath,
    apply() {
      updateFileOrDie(
        issPath,
        (s) =>
          s.replace(
            /^#define\s+MyAppVersion\s+"[^"]+"\s*$/m,
            `#define MyAppVersion "${nextStr}"`
          ),
        dryRun
      );
    },
  });

  // Tokei.mjs (keep any suffix, e.g. " (alpha)")
  const mjsPath = path.join(repoRoot, "Tokei.mjs");
  fileChanges.push({
    path: mjsPath,
    apply() {
      updateFileOrDie(
        mjsPath,
        (s) =>
          s.replace(
            /^(const\s+APP_VERSION\s*=\s*")(\d+\.\d+\.\d+)([^"]*)(";\s*)$/m,
            `$1${nextStr}$3$4`
          ),
        dryRun
      );
    },
  });

  // PyInstaller Windows version resource
  const versionInfoPath = path.join(repoRoot, "tools", "windows_version_info.txt");
  const fileVersTuple = `${next.major},${next.minor},${next.patch},0`;
  fileChanges.push({
    path: versionInfoPath,
    apply() {
      updateFileOrDie(
        versionInfoPath,
        (s) => {
          let out = s;
          out = out.replace(/filevers=\(\d+,\d+,\d+,\d+\)/g, `filevers=(${fileVersTuple})`);
          out = out.replace(/prodvers=\(\d+,\d+,\d+,\d+\)/g, `prodvers=(${fileVersTuple})`);
          out = out.replace(/StringStruct\('FileVersion',\s*'[^']*'\)/g, `StringStruct('FileVersion', '${nextStr}')`);
          out = out.replace(
            /StringStruct\('ProductVersion',\s*'[^']*'\)/g,
            `StringStruct('ProductVersion', '${nextStr}')`
          );
          return out;
        },
        dryRun
      );
    },
  });

  if (dryRun) {
    process.stdout.write(`Would bump: ${formatSemver(current)} -> ${nextStr}\n`);
    for (const c of fileChanges) process.stdout.write(`- ${path.relative(repoRoot, c.path)}\n`);
    return 0;
  }

  for (const c of fileChanges) c.apply();
  process.stdout.write(`Bumped version: ${formatSemver(current)} -> ${nextStr}\n`);
  return 0;
}

process.exit(main(process.argv));

