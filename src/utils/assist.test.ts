import test from "node:test";
import assert from "node:assert/strict";
import { sseParser, answerEvent, emptyAnswer } from "./assist.ts";

test("SSE frames survive every possible transport split and CRLF", () => {
  const wire = 'event: delta\r\ndata: {"text":"é"}\r\n\r\nevent: done\ndata: {"outcome":"succeeded"}\n\n';
  for (let split = 0; split <= wire.length; split++) {
    const events: unknown[] = [];
    const feed = sseParser(e => events.push(e));
    feed(wire.slice(0, split)); feed(wire.slice(split));
    assert.deepEqual(events, [{event: "delta", data: {text: "é"}}, {event: "done", data: {outcome: "succeeded"}}]);
  }
});
test("cancelled answers cannot receive late deltas or proposals", () => {
  const state = { ...emptyAnswer(), status: "cancelled" };
  assert.equal(answerEvent(state, {event: "delta", data: {text: "late"}}), state);
  assert.equal(answerEvent(state, {event: "proposal", data: {proposedText: "late"}}), state);
});
test("typed errors survive a terminal done event", () => {
  const failed = answerEvent({...emptyAnswer(), status: "streaming"}, {event: "error", data: {code: "provider_failure", message: "Unavailable"}});
  assert.equal(answerEvent(failed, {event: "done", data: {outcome: "failed"}}).status, "provider_failure: Unavailable");
});
