import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sourceFingerprint(root) {
  const files = [];
  function visit(relative) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) visit(path.join(relative, entry));
    } else files.push(relative);
  }
  for (const directory of ['app', 'components', 'lib', 'public']) visit(directory);
  for (const file of ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'scripts/console-build.mjs']) visit(file);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file.replaceAll('\\', '/') + '\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

export function checkBuild(root, directory) {
  try {
    const proof = JSON.parse(fs.readFileSync(path.join(root, directory, 'console-build.json'), 'utf8'));
    const buildId = fs.readFileSync(path.join(root, directory, 'BUILD_ID'), 'utf8').trim();
    return proof.version === 1 && proof.build_id === buildId && proof.source_fingerprint === sourceFingerprint(root);
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = process.env.STOCK_QA_DIST_DIR || process.env.CATALOG_QA_DIST_DIR || '.next';
  if (!/^\.next(?:-[a-z0-9-]+)?$/.test(directory)) throw new Error('Use a dedicated .next or .next-* build directory inside the frontend.');
  if (process.argv.includes('--check')) {
    const current = checkBuild(root, directory);
    console.log(current ? 'Console build matches current source.' : 'Console build is missing, outdated or has no source proof.');
    process.exitCode = current ? 0 : 1;
  } else {
    // Remove the old proof first: a failed build must never qualify as current.
    const proofPath = path.join(root, directory, 'console-build.json');
    fs.rmSync(proofPath, { force: true });
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build'], { cwd: root, stdio: 'inherit', env: process.env });
    if (result.status !== 0) process.exitCode = result.status || 1;
    else {
      const proof = { version: 1, build_id: fs.readFileSync(path.join(root, directory, 'BUILD_ID'), 'utf8').trim(), source_fingerprint: sourceFingerprint(root), built_at: new Date().toISOString() };
      fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
      console.log(`Current console build recorded in ${directory}.`);
    }
  }
}
