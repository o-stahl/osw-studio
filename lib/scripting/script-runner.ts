import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { beginCompilation, pushCompileError, commitCompilation } from '@/lib/preview/compile-errors';
import { ScriptSandbox } from '@/lib/sandbox/script-sandbox';
import type { ScriptRuntime, ScriptWorkerResponse } from './types';

type OutputListener = (msg: ScriptWorkerResponse) => void;

const EXECUTION_TIMEOUT_MS = 60_000;

class ScriptRunner {
  private worker: ScriptSandbox | null = null;
  private running = false;
  private listeners = new Set<OutputListener>();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Whether the current run's output files go to the listeners, which save them into the project. */
  private keepOutputFiles = true;

  /**
   * Execute a script project.
   * Gathers text files from VFS and sends them to the worker.
   * If already running, aborts the previous execution first.
   */
  async execute(
    projectId: string,
    runtime: ScriptRuntime,
    entryPoint: string,
    inlineSource?: string,
    /** `keepOutputFiles: false` drops what the script writes to /output/, for a run that may not write. */
    options: { keepOutputFiles?: boolean } = {},
  ): Promise<void> {
    // Abort any running execution
    if (this.running) {
      this.abort();
    }
    this.keepOutputFiles = options.keepOutputFiles ?? true;

    // Gather VFS files
    await vfs.init();
    const allFiles = await vfs.listFiles(projectId);
    const files: Record<string, string> = {};

    for (const file of allFiles) {
      if (typeof file.content === 'string') {
        files[file.path] = file.content;
      }
    }

    // Inline execution (python -c '<code>' or `python - << 'EOF'`): inject the source
    // under a synthetic entry point so the worker (which resolves via files[entryPoint])
    // runs it. No VFS mutation — the file exists only in this payload. Project modules
    // remain importable because all VFS files are still gathered above.
    if (typeof inlineSource === 'string') {
      files[entryPoint] = inlineSource;
    }

    // Ensure worker is created. Project code runs in it, so it runs in a sandboxed frame
    // (lib/sandbox/script-sandbox.ts), never on the app's origin. Made after the awaits above, so a
    // frame that fails to start does so while this run counts as running.
    if (!this.worker) {
      try {
        this.worker = new ScriptSandbox({
          onMessage: (msg) => this.handleWorkerMessage(msg),
          onError: (message) => {
            // Also the frame failing to start the worker. The next run starts afresh, and anyone
            // waiting on this one is told it ended. A sandbox kept between runs that fails belongs
            // to no run: the next one's listener may already be subscribed.
            const wasRunning = this.running;
            this.abort();
            if (!wasRunning) return;
            this.emit({ type: 'error', data: 'Worker error: ' + (message || 'Unknown error') });
            commitCompilation();
            this.emit({ type: 'complete', exitCode: 1 });
          },
        });
      } catch (err) {
        this.emit({ type: 'error', data: 'Failed to create worker: ' + String(err) });
        return;
      }
    }

    // Begin error tracking
    beginCompilation();

    this.running = true;
    this.emit({ type: 'status', data: `Running ${runtime === 'python' ? 'Python' : 'Lua'} script...` });

    // Set execution timeout
    this.timeoutId = setTimeout(() => {
      if (this.running) {
        this.emit({ type: 'error', data: `Script execution timed out after ${EXECUTION_TIMEOUT_MS / 1000} seconds` });
        pushCompileError(entryPoint, `Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s — possible infinite loop`);
        commitCompilation();
        // Emit complete so tool-registry listeners resolve instead of hanging
        this.emit({ type: 'complete', exitCode: 1 });
        this.abort();
      }
    }, EXECUTION_TIMEOUT_MS);

    // Send execution request
    const payload = { runtime, entryPoint, files };
    this.worker.postMessage({ type: 'execute', payload });
  }

  /**
   * Abort the current execution by terminating the worker (and the frame it runs in).
   */
  abort(): void {
    this.clearTimeout();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.running = false;
  }

  /**
   * Subscribe to output messages from the worker.
   * Returns an unsubscribe function.
   */
  onOutput(listener: OutputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Clean up worker and all listeners.
   */
  dispose(): void {
    this.abort();
    this.listeners.clear();
  }

  private handleWorkerMessage(msg: ScriptWorkerResponse): void {
    if (msg.type === 'output-file' && !this.keepOutputFiles) return;

    if (msg.type === 'complete') {
      this.running = false;
      this.clearTimeout();
      commitCompilation();
    }

    if (msg.type === 'error' || msg.type === 'stderr') {
      // Push to compile error pipeline so the orchestrator picks it up
      const errorData = msg.data;
      if (errorData && errorData.trim()) {
        pushCompileError('script', errorData);
      }
    }

    this.emit(msg);
  }

  private emit(msg: ScriptWorkerResponse): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        logger.error('Script output listener error:', err);
      }
    }
  }

  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}

export const scriptRunner = new ScriptRunner();
