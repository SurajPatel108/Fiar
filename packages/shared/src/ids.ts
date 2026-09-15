import { randomUUID } from 'node:crypto';

const ID_PATTERN = /^[a-z][a-z0-9-]*_[0-9a-f-]{36}$/i;

export function createId(prefix = 'af'): string {
  return `${prefix}_${randomUUID()}`;
}

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}
