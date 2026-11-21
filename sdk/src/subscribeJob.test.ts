import assert from "node:assert/strict";
import test from "node:test";
import { subscribeJob, watchJob, type JobEventSource } from "./subscribeJob.js";

test("subscribeJob dispatches parsed events and closes its EventSource", () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  let closed = false;
  let requestedUrl = "";
  const source: JobEventSource = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {
      closed = true;
    },
  };
  const events: Record<string, unknown>[] = [];

  const unsubscribe = subscribeJob(42n, (event) => events.push(event), {
    baseUrl: "https://dashboard.example/",
    eventSourceFactory(url) {
      requestedUrl = url;
      return source;
    },
  });
  listeners.get("JobCompleted")?.({ data: '{"event_type":"JobCompleted"}' });
  unsubscribe();

  assert.equal(requestedUrl, "https://dashboard.example/api/jobs/42/events");
  assert.deepEqual(events, [{ event_type: "JobCompleted" }]);
  assert.equal(closed, true);
});

test("watchJob yields parsed events in order", async () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  let closed = false;
  let requestedUrl = "";
  const source: JobEventSource = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {
      closed = true;
    },
  };

  const iterator = watchJob(7n, {
    baseUrl: "https://dashboard.example/",
    eventSourceFactory(url) {
      requestedUrl = url;
      return source;
    },
  });

  const first = iterator.next();
  listeners.get("JobStarted")?.({ data: '{"event_type":"JobStarted"}' });
  const second = iterator.next();
  listeners.get("JobCompleted")?.({ data: '{"event_type":"JobCompleted"}' });

  assert.deepEqual(await first, {
    done: false,
    value: { event_type: "JobStarted" },
  });
  assert.deepEqual(await second, {
    done: false,
    value: { event_type: "JobCompleted" },
  });
  assert.equal(requestedUrl, "https://dashboard.example/api/jobs/7/events");

  await iterator.return?.(undefined);
  assert.equal(closed, true);
});

test("watchJob ends the iterator and closes the source on abort", async () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  let closed = false;
  const source: JobEventSource = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {
      closed = true;
    },
  };
  const controller = new AbortController();

  const iterator = watchJob(9n, {
    baseUrl: "https://dashboard.example/",
    signal: controller.signal,
    eventSourceFactory() {
      return source;
    },
  });

  const pending = iterator.next();
  controller.abort();

  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(closed, true);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});