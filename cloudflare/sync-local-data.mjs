#!/usr/bin/env node
/**
 * Uploads any existing local `.studio-data/` files (`model-config.json`,
 * `usage.json`, `projects/<id>/project.json`, saved images/videos) into the
 * remote Cloudflare R2 bucket `klipcart-studio-data` using matching keys.
 *
 * Usage (PowerShell / macOS / Linux):
 *   npm run cloudflare:sync-r2
 *   npm run cloudflare:sync-r2 -- --overwrite
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BUCKET_NAME = process.env.R2_BUCKET_NAME || "klipcart-studio-data";
const DATA_DIR = path.resolve(process.cwd(), ".studio-data");
const isWindows = process.platform === "win32";
const npxBin = isWindows ? "npx.cmd" : "npx";

function contentTypeFor(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}

function collectFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, key));
    } else if (entry.isFile()) {
      results.push({ fullPath, key });
    }
  }
  return results;
}

const files = collectFiles(DATA_DIR);

if (files.length === 0) {
  console.log("No local files found in .studio-data/ — nothing to sync.");
  process.exit(0);
}

console.log(
  `Syncing ${files.length} file(s) from .studio-data/ to R2 bucket "${BUCKET_NAME}"...\n`
);

let failed = 0;
for (const { fullPath, key } of files) {
  const objectPath = `${BUCKET_NAME}/${key}`;
  const contentType = contentTypeFor(fullPath);
  console.log(`-> Uploading ${key} (${contentType})`);

  const result = spawnSync(
    npxBin,
    [
      "wrangler",
      "r2",
      "object",
      "put",
      objectPath,
      "--file",
      fullPath,
      "--content-type",
      contentType,
      "--remote",
    ],
    {
      stdio: "inherit",
      shell: isWindows,
    }
  );

  if (result.status !== 0) {
    failed++;
    console.error(`   Failed to upload ${key}`);
  }
}

if (failed > 0) {
  console.error(`\nFinished with ${failed} failed upload(s).`);
  process.exit(1);
}

console.log(`\nSuccessfully synced ${files.length} file(s) to "${BUCKET_NAME}".`);
