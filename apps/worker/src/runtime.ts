import type { ProcessOneResult } from './worker';
import type { ReconciliationResult } from './reconciliation';

export interface WorkerRuntimeOptions {
  processOne: () => Promise<ProcessOneResult>;
  reconcileOne: () => Promise<ReconciliationResult>;
  wait: (shouldStop: () => boolean) => Promise<void>;
  closeHealth: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  onExecution?: (result: ProcessOneResult) => void;
  onReconciliation?: (result: ReconciliationResult) => void;
}

/** Coordinates the claim loop so shutdown never begins another claim. */
export class WorkerRuntime {
  private stopping = false;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: WorkerRuntimeOptions) {}

  run(): Promise<void> {
    this.runPromise ??= this.loop();
    return this.runPromise;
  }

  requestStop(): Promise<void> {
    this.stopping = true;
    return this.runPromise ?? this.closeResources();
  }

  get isStopping(): boolean { return this.stopping; }

  private async loop(): Promise<void> {
    try {
      while (!this.stopping) {
        const execution = await this.options.processOne();
        this.options.onExecution?.(execution);
        if (this.stopping) break;
        const reconciliation = await this.options.reconcileOne();
        this.options.onReconciliation?.(reconciliation);
        if (this.stopping) break;
        if (execution.kind === 'none' && reconciliation.kind === 'none') await this.options.wait(() => this.stopping);
      }
    } finally {
      await this.closeResources();
    }
  }

  private closeResources(): Promise<void> {
    this.closePromise ??= (async () => {
      const failures: unknown[] = [];
      try { await this.options.closeHealth(); } catch (error) { failures.push(error); }
      try { await this.options.closeDatabase(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Worker resource shutdown failed');
    })();
    return this.closePromise;
  }
}
