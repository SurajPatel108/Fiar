const ALLOWED = new Set(['event', 'service', 'runtimeMode', 'host', 'port', 'workerId', 'reason']);
export function operationalLog(level: 'info' | 'error', fields: Record<string, string | number | boolean>): void {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) if (ALLOWED.has(key)) safe[key] = value;
  const output = JSON.stringify({ level, ...safe });
  if (level === 'error') console.error(output); else console.info(output);
}
