/**
 * The encrypted connection-export envelope: making one, and opening one.
 *
 * This is the only part of the backend that is not in `index.ts`, and the reason is that it
 * is the only part worth testing without a server around it. Everything here is pure — a
 * passphrase and some JSON in, an envelope out, and back again — with no express, no
 * registry and no filesystem, so `connectionExport.test.ts` can exercise the round trip and
 * every rejection path directly. See docs/credentials.md for the format and the threat model.
 *
 * The entries are `unknown[]` on purpose: this module knows about envelopes, not about what a
 * connection looks like. `index.ts` decides that, and runs every decrypted entry through the
 * same `pickConfig`/`validate` path a hand-typed connection takes.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

export const EXPORT_FORMAT = "oracle-dataforge-connections";

/**
 * Passphrase floor for a new export. Higher than the 8 characters a workspace account needs,
 * because the two are attacked differently: an account password is guessed online, against a
 * server that rate-limits and logs, while an export file is guessed offline, as fast as the
 * attacker's hardware allows, for as long as they care to keep trying.
 */
export const EXPORT_MIN_PASSPHRASE = 12;

/** N=2^15, r=8 → ~32 MB and roughly 100 ms per guess, so offline guessing has to pay. */
export const EXPORT_KDF = { name: "scrypt", N: 32768, r: 8, p: 1, keylen: 32 } as const;

/** No file may carry more than this many connections. */
export const IMPORT_MAX_ENTRIES = 500;

/**
 * scrypt cost bounds accepted *from a file*: wide enough that an export written with re-tuned
 * parameters still opens, narrow enough that no file can dictate a multi-gigabyte allocation
 * in this process. Checked before a key is derived, never after.
 */
export const IMPORT_KDF_LIMITS = { minN: 1 << 12, maxN: 1 << 20, maxR: 16, maxP: 4 } as const;

export interface ConnectionExportFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  /** how many connections are inside `data` — metadata, so a file can be identified unopened */
  count: number;
  cipher: "aes-256-gcm";
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number; keylen: number };
  iv: string;
  tag: string;
  data: string;
}

/** promisify(scrypt) keeping the options argument — the plain alias is fixed at Node's defaults. */
const scryptWithParams = promisify(scrypt) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** Node's default maxmem (32 MB) sits just under what these parameters need, and scrypt throws
 *  rather than quietly running something weaker — so it is always passed explicitly. */
const maxmemFor = (N: number, r: number) => 128 * N * r * 2;

/** base64 field of a bounded size, or null. Every one of these comes from an uploaded file. */
const boundedB64 = (v: unknown, maxBytes: number): Buffer | null => {
  if (typeof v !== "string" || !v || v.length > maxBytes * 2) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length && buf.length <= maxBytes ? buf : null;
};

/** Encrypt entries under a passphrase. The caller enforces `EXPORT_MIN_PASSPHRASE`. */
export async function encryptExport(entries: unknown[], passphrase: string): Promise<ConnectionExportFile> {
  const salt = randomBytes(16);
  const key = await scryptWithParams(passphrase, salt, EXPORT_KDF.keylen, {
    N: EXPORT_KDF.N, r: EXPORT_KDF.r, p: EXPORT_KDF.p, maxmem: maxmemFor(EXPORT_KDF.N, EXPORT_KDF.r),
  });
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      cipher: "aes-256-gcm",
      kdf: {
        name: "scrypt",
        salt: salt.toString("base64"),
        N: EXPORT_KDF.N,
        r: EXPORT_KDF.r,
        p: EXPORT_KDF.p,
        keylen: EXPORT_KDF.keylen,
      },
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  } finally {
    key.fill(0); // the derived key has no reason to linger in the heap afterwards
  }
}

/**
 * Open an uploaded envelope, or throw a message meant for the person who uploaded it.
 *
 * Every field here is caller-supplied, so nothing is trusted before it is checked — least of
 * all the KDF parameters, which are read from the file (an export made with different ones
 * still has to open) but range-checked first.
 */
export async function decryptExport(raw: unknown, passphrase: string): Promise<unknown[]> {
  const file = raw as Partial<ConnectionExportFile> | null;
  if (!file || typeof file !== "object" || file.format !== EXPORT_FORMAT) {
    throw new Error("That file is not an Oracle DataForge connection export.");
  }
  if (file.version !== 1) throw new Error(`This export is version ${String(file.version)}, which this build cannot read.`);
  if (file.cipher !== "aes-256-gcm") throw new Error(`Unsupported cipher "${String(file.cipher)}" in the export file.`);

  const kdf = file.kdf;
  if (!kdf || kdf.name !== "scrypt") throw new Error("Unsupported key derivation in the export file.");
  const { N, r, p, keylen } = kdf;
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  const sane =
    powerOfTwo && N >= IMPORT_KDF_LIMITS.minN && N <= IMPORT_KDF_LIMITS.maxN &&
    Number.isInteger(r) && r >= 1 && r <= IMPORT_KDF_LIMITS.maxR &&
    Number.isInteger(p) && p >= 1 && p <= IMPORT_KDF_LIMITS.maxP &&
    keylen === 32;
  if (!sane) throw new Error("The export file asks for key-derivation parameters outside the supported range.");

  const salt = boundedB64(kdf.salt, 64);
  const iv = boundedB64(file.iv, 16);
  const tag = boundedB64(file.tag, 16);
  const data = boundedB64(file.data, 8 * 1024 * 1024);
  if (!salt || !iv || !tag || !data) throw new Error("The export file is missing or has a malformed salt, IV, tag or payload.");

  const key = await scryptWithParams(passphrase, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  let plain: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // GCM cannot tell the two apart, and saying so is more honest than guessing: a wrong
    // passphrase and an edited file both fail the same authentication tag.
    throw new Error("Wrong passphrase, or the file has been altered since it was exported.");
  } finally {
    key.fill(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error("The export decrypted, but its contents are not readable.");
  }
  if (!Array.isArray(parsed)) throw new Error("The export decrypted, but its contents are not a list of connections.");
  if (parsed.length > IMPORT_MAX_ENTRIES) {
    throw new Error(`That export holds ${parsed.length} connections, more than the ${IMPORT_MAX_ENTRIES} this import accepts.`);
  }
  return parsed;
}
