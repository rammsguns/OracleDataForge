import assert from "node:assert/strict";
import { test } from "node:test";
import { loadUserStore } from "./userStore.ts";

const account = {
  id: "u1", name: "Admin", email: "Admin@example.com", role: "Administrator",
  status: "Active", mfa: false, salt: Buffer.alloc(16).toString("base64"),
  hash: Buffer.alloc(64).toString("base64"), createdAt: new Date().toISOString(),
};
const load = (value: unknown) => loadUserStore("unused", () => JSON.stringify(value));

test("only a nonexistent account store enables first-run setup", () => {
  assert.equal(loadUserStore("unused", () => { throw Object.assign(new Error(), { code: "ENOENT" }); }).size, 0);
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    assert.throws(() => loadUserStore("unused", () => { throw Object.assign(new Error(), { code }); }), /refusing to start/);
  }
});

test("corrupt, empty, or structurally invalid stores abort startup", () => {
  assert.throws(() => loadUserStore("unused", () => "{truncated"), /refusing to start/);
  for (const value of [null, {}, [], [null], [{}], [account, {}], [{ ...account, role: "Owner" }],
    [{ ...account, hash: "invalid" }], [{ ...account, salt: "invalid" }],
    [{ ...account, status: "Unknown" }], [{ ...account, email: "" }]]) {
    assert.throws(() => load(value), /refusing to start/);
  }
});

test("valid accounts load with normalized lookup keys and intact credentials", () => {
  assert.deepEqual(load([account]).get("admin@example.com"), account);
  assert.equal(load([{ ...account, status: "Suspended" }]).size, 1);
});

test("duplicate emails or IDs cannot silently replace accounts", () => {
  assert.throws(() => load([account, { ...account, id: "u2", email: "admin@example.com" }]), /refusing to start/);
  assert.throws(() => load([account, { ...account, email: "other@example.com" }]), /refusing to start/);
});
