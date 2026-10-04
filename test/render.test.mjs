import assert from "node:assert/strict";
import { test } from "node:test";
import { consume, Progress } from "../dist/render.js";

const started = { event: "started", id: "1", data: { execution_id: "execution-1", conversation_id: "conversation-1" } };

test("stream interruption preserves running status and execution identity", async () => {
  const failure = new Error("stream idle");
  async function* events() {
    yield started;
    yield { event: "job", id: "2", data: { status: "running" } };
    throw failure;
  }
  await assert.rejects(consume(events(), new Progress(false)), (error) => {
    assert.equal(error, failure);
    assert.equal(error.partialOutcome.status, "running");
    assert.equal(error.partialOutcome.execution_id, "execution-1");
    assert.equal(error.partialOutcome.last_event_id, "2");
    return true;
  });
});

test("a started execution without a terminal event stays queued, not failed", async () => {
  async function* events() { yield started; }
  const outcome = await consume(events(), new Progress(false));
  assert.equal(outcome.status, "queued");
  assert.equal(outcome.asset, null);
});

test("terminal status remains authoritative after progress", async () => {
  async function* events() {
    yield started;
    yield { event: "job", id: "2", data: { status: "running" } };
    yield { event: "done", id: "3", data: { status: "failed" } };
  }
  assert.equal((await consume(events(), new Progress(false))).status, "failed");
});
