export type ShutdownState = 'running' | 'stopping' | 'stopped' | 'failed';

export class ShutdownTimeoutError extends Error {
  constructor() {
    super('Graceful shutdown timed out');
    this.name = 'ShutdownTimeoutError';
  }
}

export interface GracefulShutdownOptions {
  timeoutMs: number;
  close: () => Promise<void>;
  onTimeout?: () => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** A small, idempotent lifecycle primitive shared by both long-running services. */
export class GracefulShutdown {
  private shutdownPromise: Promise<void> | null = null;
  private currentState: ShutdownState = 'running';

  constructor(private readonly options: GracefulShutdownOptions) {}

  get state(): ShutdownState { return this.currentState; }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.currentState = 'stopping';
    const setTimer = this.options.setTimer ?? setTimeout;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
        this.options.onTimeout?.();
        reject(new ShutdownTimeoutError());
      }, this.options.timeoutMs);
      timer.unref?.();
    });
    this.shutdownPromise = Promise.race([this.options.close(), timeout])
      .then(() => { this.currentState = 'stopped'; })
      .catch((error: unknown) => {
        this.currentState = 'failed';
        throw error;
      })
      .finally(() => { if (timer) clearTimer(timer); });
    return this.shutdownPromise;
  }
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function bindShutdownSignals(
  source: SignalSource,
  shutdown: () => Promise<void>,
  onFailure: (error: unknown) => void,
): () => void {
  const listener = () => { void shutdown().catch(onFailure); };
  source.once('SIGINT', listener);
  source.once('SIGTERM', listener);
  return () => {
    source.removeListener('SIGINT', listener);
    source.removeListener('SIGTERM', listener);
  };
}
