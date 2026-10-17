export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

// Keep this process-local error and its exact cleanup closure; never serialize or replay answers.
export class ContinuationExampleCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], readonly retryCleanup: () => Promise<void>) {
    super(errors, 'The continuation example retains unfinished cleanup.');
    this.name = 'ContinuationExampleCleanupError';
  }
}

// Human waiting has its own policy. This finite bound observes example orchestration and cleanup.
export async function within<Value>(work: PromiseLike<Value>, label: string, milliseconds = 10_000): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms.`)), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}
