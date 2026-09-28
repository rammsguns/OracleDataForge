import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthConcurrency } from "./authConcurrency.ts";

test("a same-address burst cannot queue more than four password checks", async () => {
  const limiter = new AuthConcurrency();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const attempts = Array.from({ length: 100 }, () => limiter.run("client", () => { calls++; return pending; }));
  assert.equal(attempts.filter(Boolean).length, 4);
  await Promise.resolve();
  assert.equal(calls, 4);
  finish();
  await Promise.all(attempts);
  assert.equal(await limiter.run("client", async () => true), true);
});

test("different addresses share a global ceiling and regain capacity after completion", async () => {
  const limiter = new AuthConcurrency();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const attempts = Array.from({ length: 100 }, (_, i) => limiter.run(`client-${i}`, () => pending));
  assert.equal(attempts.filter(Boolean).length, 8);
  finish();
  await Promise.all(attempts);
  assert.equal(await limiter.run("new-client", async () => true), true);
});

test("failed, rejected, and synchronously throwing checks release capacity", async () => {
  const limiter = new AuthConcurrency(1, 1);
  assert.equal(await limiter.run("client", async () => false), false);
  await assert.rejects(limiter.run("client", async () => { throw new Error("scrypt failed"); })!, /scrypt failed/);
  await assert.rejects(limiter.run("client", () => { throw new Error("sync failure"); })!, /sync failure/);
  assert.equal(await limiter.run("client", async () => true), true);
});
