export type RuntimeMode = 'development' | 'test' | 'production';

export function parseRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }
  throw new Error('FIAR_RUNTIME_MODE must be set to development, test, or production');
}

export function assertNoProductionDevelopmentCredentials(env: NodeJS.ProcessEnv): void {
  if (parseRuntimeMode(env.FIAR_RUNTIME_MODE) !== 'production') return;
  if (env.FIAR_DEV_CREDENTIALS_JSON || env.FIAR_DEV_CREDENTIALS_FILE) {
    throw new Error('Development credential configuration is forbidden in production');
  }
}
