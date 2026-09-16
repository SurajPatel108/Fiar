import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const broken = [];

for (const file of files) {
  const contents = await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8'));
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim().replace(/^<|>$/g, '');
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = decodeURIComponent(raw.split('#')[0] ?? '');
    if (!path) continue;
    const target = resolve(dirname(file), path);
    if (!existsSync(target) || !statSync(target).isFile()) broken.push(`${file}: ${raw}`);
  }
}

if (broken.length > 0) {
  console.error(`Broken local Markdown links:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log('Markdown link check passed');
