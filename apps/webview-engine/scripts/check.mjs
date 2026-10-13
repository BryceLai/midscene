import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
for (const file of await readdir('src'))
  if (file.endsWith('.mjs'))
    execFileSync(process.execPath, ['--check', `src/${file}`], {
      stdio: 'inherit',
    });
console.log('Source syntax checks passed');
