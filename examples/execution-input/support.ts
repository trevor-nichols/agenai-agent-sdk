export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

// A deadline detects stalled example orchestration; it never proves native completion.
export async function within<Value>(work: PromiseLike<Value>, label: string): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} exceeded the example's 5 second deadline.`)), 5_000);
    })]);
  } finally { clearTimeout(timeout); }
}

// Retain this process-local owner on failure; never serialize its closure or replay the input.
export class ExecutionInputExampleCleanupError extends Error {
  constructor(cause: unknown, readonly retryCleanup: () => Promise<void>) {
    super('Execution-input example cleanup is incomplete; retain and retry this cleanup owner.', { cause });
    this.name = 'ExecutionInputExampleCleanupError';
  }
}
