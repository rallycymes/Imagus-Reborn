#!/usr/bin/env node
// LOCAL-ONLY customization for the Firefox build — never commit this file.
// Gives local installs a personal identity (name + gecko ID) and a strictly
// increasing version, so AMO update checks can never overwrite them with the
// official extension, and reinstalling a fresh zip always updates in place.
// Usage: node build_local.js  (runs the standard build.js first)
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILD = path.join(__dirname, 'build');
const FIREFOX_DIR = path.join(BUILD, 'firefox');
const STATE_FILE = path.join(__dirname, '.build_local_state.json');

const LOCAL_ID = '{07296774-75b1-41dd-9f41-7183178cb436}';
const LOCAL_NAME = 'Imagus Reborn - Custom';

function runStandardBuild() {
  console.log('Running standard build (build.js)...');
  execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
}

function nextVersion(manifestVersion, state) {
  const parts = manifestVersion.split('.').map(Number);
  if (parts.length < 1 || parts.length > 4 || parts.some(p => !Number.isInteger(p) || p < 0)) {
    throw new Error(`Unexpected version format: "${manifestVersion}"`);
  }
  const base = parts.slice(0, 3).join('.');
  const seq = parts.length === 4 ? parts[3] + 1 : (state.base === base ? state.seq + 1 : 1);
  return { base, seq, version: `${base}.${seq}` };
}

function zipDir(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function main() {
  runStandardBuild();

  let state = { base: '', seq: 0 };
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }

  const manifestPath = path.join(FIREFOX_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bumped = nextVersion(manifest.version, state);

  manifest.name = LOCAL_NAME;
  manifest.version = bumped.version;
  manifest.browser_specific_settings.gecko.id = LOCAL_ID;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf8');
  fs.writeFileSync(STATE_FILE, JSON.stringify(bumped, null, 2) + '\n', 'utf8');

  const zipPath = path.join(BUILD, `ImagusReborn_Firefox-Custom_v${bumped.version}.zip`);
  console.log(`\nZipping custom Firefox build (v${bumped.version})...`);
  await zipDir(FIREFOX_DIR, zipPath);

  console.log('\nDone! Install via about:addons > Install Add-on From File:');
  console.log(`  ${zipPath}`);
}

main().catch(err => {
  console.error('\nError!', err.message || err);
  process.exit(1);
});
