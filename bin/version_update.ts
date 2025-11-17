import { execSync } from "node:child_process";
import fs from "node:fs";
const NAMESPACE = process.env.NAMESPACE

if (!NAMESPACE) {
    throw new Error('NAMESPACE is required')
}

// 1. Ambil versi remote dari npm
const remoteVersion = execSync(`npm view n8n-nodes-${NAMESPACE} version`)
  .toString()
  .trim();

console.log("🔍 Remote version:", remoteVersion);

// 2. Pecah versi → major.minor.patch
const [major, minor, patch] = remoteVersion.split(".").map(Number);

// 3. Generate versi baru: remote + 1 patch
const newLocalVersion = `${major}.${minor}.${patch + 1}`;

const pkgPath = "src/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

pkg.version = newLocalVersion;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
