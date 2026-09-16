import { lstat, readFile } from 'node:fs/promises';

export interface SecretProvider {
  get(name: string, required?: boolean): Promise<string | null>;
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly prefix = 'FIAR_SECRET_') {}
  async get(name: string, required = true): Promise<string | null> {
    const value = this.env[`${this.prefix}${name.toUpperCase()}`];
    if (!value && required) throw new Error(`Required secret ${name} is unavailable`);
    return value ?? null;
  }
}

export class FileSecretProvider implements SecretProvider {
  constructor(private readonly paths: Readonly<Record<string, string | undefined>>) {}
  async get(name: string, required = true): Promise<string | null> {
    const path = this.paths[name];
    if (!path) {
      if (required) throw new Error(`Required secret ${name} is unavailable`);
      return null;
    }
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o022) !== 0) {
        throw new Error('unsafe');
      }
      if (stat.size === 0 && !required) return null;
      const value = (await readFile(path, 'utf8')).replace(/[\r\n]+$/, '');
      if (!value) {
        if (!required) return null;
        throw new Error('empty');
      }
      return value;
    } catch {
      throw new Error(`Required secret ${name} is unavailable or unsafe`);
    }
  }
}
