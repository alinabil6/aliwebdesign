import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ignore = new Set(['node_modules', '.git', 'library']);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignore.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (full.endsWith('.js') || full.endsWith('.mjs')) {
      files.push(full);
    }
  }
}

walk(ROOT);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, stderr: result.stderr.trim() });
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`Syntax error in ${failure.file}\n${failure.stderr}\n`);
  }
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} files.`);
