import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_PATH = resolve(ROOT_DIR, "CHANGELOG.md");
const RELEASE_PACK_DIR = resolve(ROOT_DIR, ".optimus-release", "pack");
const NPM_REGISTRY_CHECK_TIMEOUT_MS = 15000;
const NPM_PUBLISH_TIMEOUT_MS = 120000;
const EMPTY_UNRELEASED_SECTION = [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "### Changed",
  "",
  "### Fixed",
  ""
].join("\n");

function normalizeRegistry(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "https://registry.npmjs.org/";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function buildRegistryAuthMessage(registry, reason) {
  const normalizedRegistry = normalizeRegistry(registry);
  const isOfficialRegistry = normalizedRegistry === "https://registry.npmjs.org/";
  const loginCommand = isOfficialRegistry
    ? "npm login --registry=https://registry.npmjs.org/"
    : `npm adduser --registry=${normalizedRegistry}`;
  const switchCommand = "npm config set registry https://registry.npmjs.org/";

  return [
    `npm publish auth check failed for ${normalizedRegistry}`,
    `reason: ${reason}`,
    `fix: ${loginCommand}`,
    ...(isOfficialRegistry ? [] : [`optional: switch to the official npm registry first via \`${switchCommand}\``])
  ].join("\n");
}

function extractProcessOutput(error) {
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr ?? "").trim() : "";
  const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout ?? "").trim() : "";
  return {
    stderr,
    stdout,
    combined: [stderr, stdout].filter(Boolean).join("\n")
  };
}

function buildNpmPublishPolicyMessage(registry, reason) {
  const normalizedRegistry = normalizeRegistry(registry);
  return [
    `npm publish failed for ${normalizedRegistry}`,
    "reason: publish requires either npm 2FA confirmation or a granular access token with bypass 2FA enabled",
    `details: ${reason}`,
    "fix: use `npm publish --otp=<code>` after `npm login --registry=https://registry.npmjs.org/`, or configure a granular publish token with bypass 2FA enabled",
    "check: confirm the account or token has publish permission for this package scope"
  ].join("\n");
}

function classifyNpmPublishError(registry, error) {
  const { stderr, stdout, combined } = extractProcessOutput(error);
  const reason = combined || (error instanceof Error ? error.message : String(error));
  const normalized = reason.toLowerCase();

  if (
    normalized.includes("code e403")
    && (normalized.includes("two-factor authentication") || normalized.includes("bypass 2fa"))
  ) {
    return {
      category: "publish_policy_2fa",
      message: buildNpmPublishPolicyMessage(registry, reason)
    };
  }

  return {
    category: "publish_failed",
    message: reason || stderr || stdout || "npm publish failed."
  };
}

function isValidReleaseVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function parseReleaseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) {
    return undefined;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? undefined
  };
}

function formatSnapshotDate(releaseDate) {
  const normalized = String(releaseDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`Snapshot release date must be in YYYY-MM-DD format, received: ${releaseDate}`);
  }
  return normalized.replace(/-/g, "");
}

function resolveNextSnapshotVersion(currentVersion, releaseDate) {
  const parsed = parseReleaseVersion(currentVersion);
  if (!parsed) {
    throw new Error(`Unsupported current version: ${currentVersion}`);
  }

  const snapshotDate = formatSnapshotDate(releaseDate);
  const snapshotMatch = /^snapshot\.(\d{8})\.(\d+)$/.exec(parsed.prerelease ?? "");
  if (snapshotMatch) {
    const currentDate = snapshotMatch[1];
    const currentSequence = Number.parseInt(snapshotMatch[2], 10);
    const nextSequence = currentDate === snapshotDate ? currentSequence + 1 : 1;
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-snapshot.${snapshotDate}.${nextSequence}`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-snapshot.${snapshotDate}.1`;
}

function resolveNextVersion(currentVersion, spec, releaseDate = new Date().toISOString().slice(0, 10)) {
  if (isValidReleaseVersion(spec)) {
    return spec;
  }
  if (spec === "snapshot") {
    return resolveNextSnapshotVersion(currentVersion, releaseDate);
  }

  const parsed = parseReleaseVersion(currentVersion);
  if (!parsed || parsed.prerelease) {
    throw new Error(`Unsupported current version: ${currentVersion}`);
  }

  if (spec === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (spec === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (spec === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  throw new Error(`Unsupported release spec: ${spec}. Use patch, minor, major, snapshot, or an explicit version.`);
}

function readReleasedVersions(changelogText) {
  return [...changelogText.matchAll(/^## \[(?!Unreleased\])([^\]]+)\]/gm)].map((match) => match[1]);
}

function isMeaningfulUnreleasedBody(unreleasedBody) {
  const normalized = unreleasedBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("### "));
  return normalized.length > 0;
}

function updateChangelogForRelease(changelogText, version, releaseDate) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (readReleasedVersions(changelogText).includes(version)) {
    throw new Error(`CHANGELOG already contains version ${version}.`);
  }

  const unreleasedHeading = "## [Unreleased]";
  const unreleasedIndex = changelogText.indexOf(unreleasedHeading);
  if (unreleasedIndex < 0) {
    throw new Error("CHANGELOG is missing the [Unreleased] section.");
  }

  const afterUnreleasedIndex = changelogText.indexOf("\n## [", unreleasedIndex + unreleasedHeading.length);
  const unreleasedBody = changelogText.slice(
    unreleasedIndex + unreleasedHeading.length,
    afterUnreleasedIndex >= 0 ? afterUnreleasedIndex : changelogText.length
  ).trim();

  if (!unreleasedBody || !isMeaningfulUnreleasedBody(unreleasedBody)) {
    throw new Error("CHANGELOG [Unreleased] section is empty.");
  }

  const releaseSection = `## [${version}] - ${releaseDate}\n\n${unreleasedBody}\n`;
  const prefix = changelogText.slice(0, unreleasedIndex).trimEnd();
  const suffix = afterUnreleasedIndex >= 0 ? changelogText.slice(afterUnreleasedIndex).trimStart() : "";

  return [
    prefix,
    "",
    EMPTY_UNRELEASED_SECTION,
    "",
    releaseSection,
    suffix
  ].filter((part) => part.length > 0).join("\n");
}

async function prepareRelease(rootDir, spec, releaseDate = new Date().toISOString().slice(0, 10)) {
  const packageJsonPath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const currentVersion = String(packageJson.version ?? "").trim();
  if (!currentVersion) {
    throw new Error("package.json is missing version.");
  }

  const nextVersion = resolveNextVersion(currentVersion, spec, releaseDate);
  if (nextVersion === currentVersion) {
    throw new Error(`Release version ${nextVersion} matches the current version.`);
  }

  packageJson.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  if (spec !== "snapshot") {
    const changelogText = await readFile(CHANGELOG_PATH, "utf8");
    const nextChangelog = updateChangelogForRelease(changelogText, nextVersion, releaseDate);
    await writeFile(CHANGELOG_PATH, `${nextChangelog.trimEnd()}\n`, "utf8");
  }

  return {
    previousVersion: currentVersion,
    version: nextVersion,
    releaseDate,
    channel: spec === "snapshot" ? "snapshot" : "latest"
  };
}

async function readReleaseStatus(rootDir) {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const changelogText = await readFile(resolve(rootDir, "CHANGELOG.md"), "utf8");
  const latestReleasedVersion = readReleasedVersions(changelogText)[0] ?? null;
  return {
    packageVersion: String(packageJson.version ?? ""),
    latestReleasedVersion
  };
}

async function createReleaseTag(rootDir, version) {
  const { latestReleasedVersion } = await readReleaseStatus(rootDir);
  if (latestReleasedVersion !== version) {
    throw new Error(`CHANGELOG latest released version ${latestReleasedVersion ?? "none"} does not match package version ${version}.`);
  }

  const tagName = `v${version}`;
  const { stdout } = await execFile("git", ["tag", "--list", tagName], { cwd: rootDir, encoding: "utf8" });
  if (stdout.trim() === tagName) {
    throw new Error(`Git tag ${tagName} already exists.`);
  }
  await execFile("git", ["tag", "-a", tagName, "-m", tagName], { cwd: rootDir, encoding: "utf8" });
  return tagName;
}

async function runCommand(command, args, cwd = ROOT_DIR, timeout = NPM_REGISTRY_CHECK_TIMEOUT_MS) {
  return execFile(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024
  });
}

async function createReleasePack(rootDir = ROOT_DIR, outputDir = RELEASE_PACK_DIR) {
  await mkdir(outputDir, { recursive: true });
  const cacheDir = resolve(rootDir, ".optimus-release", "npm-cache");
  await mkdir(cacheDir, { recursive: true });
  const result = await execFile("npm", ["pack", "--pack-destination", outputDir], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: NPM_PUBLISH_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: cacheDir
    }
  });
  const tarballName = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!tarballName) {
    throw new Error("npm pack did not return a tarball name.");
  }

  return {
    outputDir,
    tarballName,
    tarballPath: join(outputDir, tarballName)
  };
}

async function readNpmRegistry(rootDir = ROOT_DIR) {
  const { stdout } = await runCommand("npm", ["config", "get", "registry"], rootDir);
  return normalizeRegistry(stdout);
}

async function checkNpmPublishAuth(rootDir = ROOT_DIR) {
  const registry = await readNpmRegistry(rootDir);
  try {
    const { stdout } = await runCommand("npm", ["whoami", `--registry=${registry}`], rootDir);
    return {
      ok: true,
      registry,
      username: stdout.trim() || null
    };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    const stdout = error instanceof Error && "stdout" in error ? String(error.stdout ?? "").trim() : "";
    const timedOut = typeof error === "object" && error !== null && "killed" in error && "signal" in error
      ? Boolean(error.killed) && String(error.signal ?? "") === "SIGTERM"
      : false;
    const reason = timedOut
      ? `npm whoami timed out after ${NPM_REGISTRY_CHECK_TIMEOUT_MS}ms`
      : stderr || stdout || (error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      registry,
      reason,
      message: buildRegistryAuthMessage(registry, reason)
    };
  }
}

async function ensureNpmPublishAuth(rootDir = ROOT_DIR) {
  const auth = await checkNpmPublishAuth(rootDir);
  if (!auth.ok) {
    throw new Error(auth.message);
  }
  return auth;
}

function resolvePublishArgs(options = {}) {
  const args = [];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.tag?.trim()) {
    args.push("--tag", options.tag.trim());
  }
  if (options.otp?.trim()) {
    args.push("--otp", options.otp.trim());
  }
  return args;
}

function parseReleaseCliOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--tag") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --tag.");
      }
      options.tag = value;
      index += 1;
      continue;
    }
    if (token === "--otp") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --otp.");
      }
      options.otp = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

async function runNpmPublish(args, rootDir = ROOT_DIR) {
  const auth = await ensureNpmPublishAuth(rootDir);
  try {
    await runCommand("npm", ["run", "verify"], rootDir, NPM_PUBLISH_TIMEOUT_MS);
    const result = await runCommand("npm", ["publish", ...args], rootDir, NPM_PUBLISH_TIMEOUT_MS);
    return { auth, result };
  } catch (error) {
    const classified = classifyNpmPublishError(auth.registry, error);
    throw new Error(classified.message);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "status") {
    const status = await readReleaseStatus(ROOT_DIR);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === "prepare") {
    const spec = args[0];
    if (!spec) {
      throw new Error("Missing release version. Use patch, minor, major, snapshot, or an explicit version.");
    }
    const result = await prepareRelease(ROOT_DIR, spec);
    console.log(JSON.stringify({
      ok: true,
      action: "prepared",
      ...result,
      next: [
        "npm run release:preflight",
        "npm run release:check",
        ...(spec === "snapshot" ? ["npm run release:check:snapshot"] : []),
        "npm run release:pack",
        ...(spec === "snapshot" ? ["npm run release:publish:snapshot -- --otp <code>"] : ["npm run release:publish -- --otp <code>"]),
        "npm run release:tag"
      ]
    }, null, 2));
    return;
  }

  if (command === "preflight") {
    const auth = await ensureNpmPublishAuth(ROOT_DIR);
    console.log(JSON.stringify({
      ok: true,
      action: "preflight",
      registry: auth.registry,
      username: auth.username
    }, null, 2));
    return;
  }

  if (command === "check") {
    const options = parseReleaseCliOptions(args);
    await runCommand("npm", ["run", "verify"], ROOT_DIR, NPM_PUBLISH_TIMEOUT_MS);
    const auth = await ensureNpmPublishAuth(ROOT_DIR);
    const result = await runCommand("npm", ["publish", ...resolvePublishArgs({ ...options, dryRun: true })], ROOT_DIR, NPM_PUBLISH_TIMEOUT_MS);
    process.stdout.write(result.stdout ?? "");
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (auth.username) {
      console.log(`\n[npm] authenticated as ${auth.username} via ${auth.registry}`);
    }
    return;
  }

  if (command === "pack") {
    await runCommand("npm", ["run", "verify"], ROOT_DIR, NPM_PUBLISH_TIMEOUT_MS);
    const result = await createReleasePack(ROOT_DIR, RELEASE_PACK_DIR);
    console.log(JSON.stringify({
      ok: true,
      action: "packed",
      ...result
    }, null, 2));
    return;
  }

  if (command === "publish") {
    const options = parseReleaseCliOptions(args);
    const { result } = await runNpmPublish(resolvePublishArgs(options), ROOT_DIR);
    process.stdout.write(result.stdout ?? "");
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return;
  }

  if (command === "tag") {
    const { packageVersion } = await readReleaseStatus(ROOT_DIR);
    const tagName = await createReleaseTag(ROOT_DIR, packageVersion);
    console.log(JSON.stringify({
      ok: true,
      action: "tagged",
      version: packageVersion,
      tag: tagName
    }, null, 2));
    return;
  }

  throw new Error("Unknown command. Use status, prepare, preflight, check, pack, publish, or tag.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
