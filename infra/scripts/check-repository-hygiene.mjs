import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const forbidden = files.filter((file) =>
  file === '.DS_Store' || file.includes('/.DS_Store') ||
  file === 'node_modules' || file.startsWith('node_modules/') || file.includes('/node_modules/') ||
  file === 'apps/dashboard/dist' || file.startsWith('apps/dashboard/dist/') ||
  file === '.env' || file.endsWith('/.env') || (file.endsWith('.env') && !file.endsWith('.env.example')) ||
  file.startsWith('dist/') || file.includes('/dist/')
);
if (forbidden.length > 0) {
  console.error(`Forbidden tracked files:\n${forbidden.join('\n')}`);
  process.exit(1);
}
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];
const suspicious = files.filter((file) => {
  try { return secretPatterns.some((pattern) => pattern.test(readFileSync(file, 'utf8'))); }
  catch { return false; }
});
if (suspicious.length > 0) {
  console.error(`Potential secrets in tracked files:\n${suspicious.join('\n')}`);
  process.exit(1);
}
console.log('Repository hygiene check passed');
