import assert from "node:assert/strict";
import test from "node:test";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { matchesJobEvent } from "./jobEvents.js";

const contractId = "C".padEnd(56, "A");

function makeEvent(jobId: bigint) {
  return {
    contract: contractId,
    event_type: "JobSubmitted",
    payload: { value: nativeToScVal([jobId]).toXDR("base64") },
  };
}

test("matches only the requested job's commerce lifecycle events", () => {
  assert.equal(matchesJobEvent(makeEvent(42n), contractId, 42n), true);
  assert.equal(matchesJobEvent(makeEvent(43n), contractId, 42n), false);
  assert.equal(
    matchesJobEvent({ ...makeEvent(42n), event_type: "JobCreated" }, contractId, 42n),
    false,
  );
});

test("decodes the indexed XDR event topic when no event_type name is available", () => {
  const event = {
    contract: contractId,
    payload: {
      topics: [nativeToScVal("JobCompleted", { type: "symbol" }).toXDR("base64")],
      value: nativeToScVal([42n]).toXDR("base64"),
    },
  };
  assert.equal(matchesJobEvent(event, contractId, 42n), true);
});
