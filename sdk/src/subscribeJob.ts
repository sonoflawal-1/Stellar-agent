export type JobStreamEvent = Record<string, unknown>;
export type JobEventSource = {
  addEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void;
  close(): void;
};

export type SubscribeJobOptions = {
  baseUrl?: string;
  eventSourceFactory?: (url: string) => JobEventSource;
};

export type WatchJobOptions = SubscribeJobOptions & {
  signal?: AbortSignal;
};

/**
 * Subscribe to indexed lifecycle events for a single job through the dashboard SSE endpoint.
 * The returned function closes the stream.
 */
export function subscribeJob(
  jobId: bigint | number | string,
  callback: (event: JobStreamEvent) => void,
  options: SubscribeJobOptions = {},
): () => void {
  const id = String(jobId);
  if (!/^\d+$/.test(id)) {
    throw new TypeError("jobId must be a non-negative integer");
  }

  const factory =
    options.eventSourceFactory ??
    ((url: string): JobEventSource => {
      if (typeof EventSource === "undefined") {
        throw new Error("EventSource is not available in this environment");
      }
      return new EventSource(url);
    });
  const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
  const source = factory(`${baseUrl}/api/jobs/${encodeURIComponent(id)}/events`);
  const onEvent = (message: { data: string }) => {
    let event: JobStreamEvent;
    try {
      event = JSON.parse(message.data) as JobStreamEvent;
    } catch {
      return;
    }
    callback(event);
  };
  for (const eventType of ["JobSubmitted", "JobCompleted", "JobCancelled", "JobDisputed"]) {
    source.addEventListener(eventType, onEvent);
  }
  return () => source.close();
}

/**
 * Iterate indexed lifecycle events for a single job as an async iterator.
 * Built on {@link subscribeJob}; the iterator ends when the provided
 * `AbortSignal` aborts (or when the consumer breaks out of the loop).
 */
export async function* watchJobEvents(
  jobId: bigint | number | string,
  options: WatchJobOptions = {},
): AsyncGenerator<JobStreamEvent, void, unknown> {
  const { signal } = options;
  if (signal?.aborted) {
    return;
  }

  const queue: JobStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  const wake = () => {
    const resolve = notify;
    notify = null;
    resolve?.();
  };

  const close = subscribeJob(
    jobId,
    (event) => {
      queue.push(event);
      wake();
    },
    options,
  );

  const onAbort = () => {
    closed = true;
    close();
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift() as JobStreamEvent;
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    close();
  }
}
