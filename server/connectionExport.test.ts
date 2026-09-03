/**
 * Tests for the connection-export envelope — the round trip, and every way a file can be
 * refused. Run with `npm test`.
 *
 * These are the crypto's only automated cover, so they are written against behaviour a
 * change could plausibly break in silence: that what comes out is what went in, that a wrong
 * passphrase or an edited byte fails instead of returning something plausible, that no
 * plaintext survives in the envelope, and that a hostile file cannot talk this process into
 * deriving a key with parameters of its choosing.
 */
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  decryptExport,
  encryptExport,
  EXPORT_FORMAT,
  EXPORT_KDF,
  EXPORT_MIN_PASSPHRASE,
  IMPORT_KDF_LIMITS,
  IMPORT_MAX_ENTRIES,
  type ConnectionExportFile,
} from "./connectionExport.ts";

const PASS = "correct-horse-battery-staple";

/** Two connections shaped exactly as the registry stores them. */
const CONNECTIONS = [
  {
    name: "Sales STAGING",
    engine: "oracle",
    host: "db1.example.test",
    port: 1521,
    user: "APP_RO",
    password: "s3cret-one",
    database: "FREEPDB1",
    readOnly: true,
  },
  {
    name: "Warehouse",
    engine: "oracle",
    host: "db2.example.test",
    port: 1522,
    user: "ETL",
    password: "pässwörd wíth ünicode · 🔐",
    database: "WHPDB",
    readOnly: false,
  },
];

/** A valid envelope, minus whatever the caller wants to break. */
const fileWith = (base: ConnectionExportFile, patch: Record<string, unknown>) =>
  ({ ...base, ...patch }) as unknown;

const rejects = (raw: unknown, passphrase: string, match: RegExp) =>
  assert.rejects(() => decryptExport(raw, passphrase), match);

describe("encryptExport", () => {
  it("round-trips the entries it was given, unicode and all", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    assert.deepEqual(await decryptExport(file, PASS), CONNECTIONS);
  });

  it("writes an envelope of the documented shape", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    assert.equal(file.format, EXPORT_FORMAT);
    assert.equal(file.version, 1);
    assert.equal(file.cipher, "aes-256-gcm");
    assert.equal(file.count, CONNECTIONS.length);
    assert.equal(file.kdf.name, "scrypt");
    assert.deepEqual(
      { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, keylen: file.kdf.keylen },
      { N: EXPORT_KDF.N, r: EXPORT_KDF.r, p: EXPORT_KDF.p, keylen: EXPORT_KDF.keylen }
    );
    // AES-GCM: 96-bit IV, 128-bit tag, and a 128-bit salt for the derivation
    assert.equal(Buffer.from(file.iv, "base64").length, 12);
    assert.equal(Buffer.from(file.tag, "base64").length, 16);
    assert.equal(Buffer.from(file.kdf.salt, "base64").length, 16);
    assert.ok(!Number.isNaN(Date.parse(file.exportedAt)));
  });

  it("leaves no plaintext anywhere in the file", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    const serialized = JSON.stringify(file);
    const ciphertext = Buffer.from(file.data, "base64").toString("latin1");
    for (const needle of ["s3cret-one", "APP_RO", "db1.example.test", "Sales STAGING", PASS]) {
      assert.ok(!serialized.includes(needle), `envelope leaked ${needle}`);
      assert.ok(!ciphertext.includes(needle), `ciphertext leaked ${needle}`);
    }
  });

  it("never repeats a salt or an IV, so the same data encrypts differently every time", async () => {
    const a = await encryptExport(CONNECTIONS, PASS);
    const b = await encryptExport(CONNECTIONS, PASS);
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.data, b.data);
    // …and both still open
    assert.deepEqual(await decryptExport(a, PASS), CONNECTIONS);
    assert.deepEqual(await decryptExport(b, PASS), CONNECTIONS);
  });

  it("round-trips an empty selection and a passphrase of exactly the minimum length", async () => {
    const shortest = "x".repeat(EXPORT_MIN_PASSPHRASE);
    const file = await encryptExport([], shortest);
    assert.equal(file.count, 0);
    assert.deepEqual(await decryptExport(file, shortest), []);
  });
});

describe("decryptExport: a file that should not open", () => {
  it("refuses the wrong passphrase", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(file, PASS + "x", /Wrong passphrase, or the file has been altered/);
  });

  it("refuses a passphrase that differs only in case", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(file, PASS.toUpperCase(), /Wrong passphrase/);
  });

  it("refuses ciphertext with a single flipped bit", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    const data = Buffer.from(file.data, "base64");
    data[0] ^= 0x01;
    await rejects(fileWith(file, { data: data.toString("base64") }), PASS, /altered since it was exported/);
  });

  it("refuses a swapped authentication tag, IV or salt", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    const other = await encryptExport(CONNECTIONS, PASS);
    await rejects(fileWith(file, { tag: other.tag }), PASS, /Wrong passphrase/);
    await rejects(fileWith(file, { iv: other.iv }), PASS, /Wrong passphrase/);
    await rejects(fileWith(file, { kdf: { ...file.kdf, salt: other.kdf.salt } }), PASS, /Wrong passphrase/);
  });
});

describe("decryptExport: a file that is not one of ours", () => {
  it("refuses anything that is not an envelope", async () => {
    for (const raw of [null, undefined, 42, "a string", [], {}, { format: "something-else" }]) {
      await rejects(raw, PASS, /not an Oracle DataForge connection export/);
    }
  });

  it("refuses a version or cipher this build does not know", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(fileWith(file, { version: 2 }), PASS, /version 2, which this build cannot read/);
    await rejects(fileWith(file, { cipher: "aes-128-cbc" }), PASS, /Unsupported cipher/);
  });

  it("refuses a key derivation it does not know", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(fileWith(file, { kdf: { ...file.kdf, name: "pbkdf2" } }), PASS, /Unsupported key derivation/);
    await rejects(fileWith(file, { kdf: undefined }), PASS, /Unsupported key derivation/);
  });

  it("refuses malformed salt, IV, tag or payload", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    const malformed = /missing or has a malformed salt, IV, tag or payload/;
    await rejects(fileWith(file, { iv: "" }), PASS, malformed);
    await rejects(fileWith(file, { tag: 12345 }), PASS, malformed);
    await rejects(fileWith(file, { data: null }), PASS, malformed);
    await rejects(fileWith(file, { kdf: { ...file.kdf, salt: "" } }), PASS, malformed);
    // an IV of the right encoding but the wrong size is still malformed, not a decrypt failure
    await rejects(fileWith(file, { iv: randomBytes(64).toString("base64") }), PASS, malformed);
  });
});

describe("decryptExport: the KDF parameters are checked before any key is derived", () => {
  const out = /key-derivation parameters outside the supported range/;

  it("refuses a cost factor above the ceiling", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    // the point of the ceiling: without it, this file decides how much memory this process
    // allocates. 2^30 with r=8 would ask for a quarter of a terabyte.
    await rejects(fileWith(file, { kdf: { ...file.kdf, N: 1 << 30 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, N: IMPORT_KDF_LIMITS.maxN * 2 } }), PASS, out);
  });

  it("refuses a cost factor below the floor, or one that is not a power of two", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(fileWith(file, { kdf: { ...file.kdf, N: 2 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, N: 32769 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, N: "32768" } }), PASS, out);
  });

  it("refuses r, p or keylen outside their bounds", async () => {
    const file = await encryptExport(CONNECTIONS, PASS);
    await rejects(fileWith(file, { kdf: { ...file.kdf, r: IMPORT_KDF_LIMITS.maxR + 1 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, r: 0 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, p: IMPORT_KDF_LIMITS.maxP + 1 } }), PASS, out);
    await rejects(fileWith(file, { kdf: { ...file.kdf, keylen: 16 } }), PASS, out);
  });

  it("still opens a file written with different but supported parameters", async () => {
    // an export re-tuned later, or by another install, has to keep opening — this is why the
    // parameters are read from the file at all rather than hard-coded on the way in
    const kdf = { name: "scrypt" as const, N: 1 << 14, r: 4, p: 1, keylen: 32 };
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(PASS, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(CONNECTIONS), "utf8"), cipher.final()]);
    const file = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      count: CONNECTIONS.length,
      cipher: "aes-256-gcm",
      kdf: { ...kdf, salt: salt.toString("base64") },
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    assert.deepEqual(await decryptExport(file, PASS), CONNECTIONS);
  });
});

describe("decryptExport: contents that decrypt but are not a connection list", () => {
  /** Encrypt arbitrary plaintext under PASS, the way a legitimate export would be built. */
  const envelopeOf = async (plaintext: string) => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(PASS, salt, EXPORT_KDF.keylen, {
      N: EXPORT_KDF.N, r: EXPORT_KDF.r, p: EXPORT_KDF.p, maxmem: 128 * EXPORT_KDF.N * EXPORT_KDF.r * 2,
    });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      count: 0,
      cipher: "aes-256-gcm",
      kdf: { ...EXPORT_KDF, salt: salt.toString("base64") },
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  };

  it("refuses a payload that is not JSON", async () => {
    await rejects(await envelopeOf("not json at all"), PASS, /decrypted, but its contents are not readable/);
  });

  it("refuses a payload that is JSON but not a list", async () => {
    await rejects(await envelopeOf('{"connections":[]}'), PASS, /contents are not a list of connections/);
  });

  it("refuses a list longer than the cap", async () => {
    const many = JSON.stringify(new Array(IMPORT_MAX_ENTRIES + 1).fill(CONNECTIONS[0]));
    await rejects(await envelopeOf(many), PASS, new RegExp(`more than the ${IMPORT_MAX_ENTRIES} this import accepts`));
  });

  it("accepts a list of exactly the cap", async () => {
    const atCap = new Array(IMPORT_MAX_ENTRIES).fill(CONNECTIONS[0]);
    const entries = await decryptExport(await envelopeOf(JSON.stringify(atCap)), PASS);
    assert.equal(entries.length, IMPORT_MAX_ENTRIES);
  });
});
