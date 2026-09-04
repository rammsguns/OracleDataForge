/**
 * Oracle Cloud wallet handling: opening the zip Autonomous Database hands you, and reading
 * the services out of the `tnsnames.ora` inside it.
 *
 * Like `connectionExport.ts`, this is here rather than in `index.ts` because it is pure —
 * bytes in, entries out — and because every byte of its input is a file a user uploaded, so
 * it is worth testing directly. `oracleWallet.test.ts` covers the zip reader's refusals and
 * the tnsnames parser; `index.ts` owns where the extracted files land on disk.
 *
 * The zip reader is deliberately small: a wallet zip is a handful of files a few kilobytes
 * each, written by Oracle, so there is no need for zip64, encryption, data descriptors or
 * anything else beyond stored and deflated entries — and every one of those unsupported
 * cases is refused rather than guessed at.
 */
import { inflateRawSync } from "node:zlib";

/** Largest wallet zip accepted. An Autonomous Database wallet is ~10 KB. */
export const WALLET_ZIP_MAX_BYTES = 2 * 1024 * 1024;
/** Largest single file taken out of one. `tnsnames.ora` is the big one, at a few KB. */
export const WALLET_FILE_MAX_BYTES = 512 * 1024;

/**
 * The only two files kept out of the zip.
 *
 * node-oracledb's Thin mode — the mode this app runs in — reads the PEM wallet and
 * `tnsnames.ora`, and ignores `sqlnet.ora`, `cwallet.sso`, `ewallet.p12` and the Java
 * keystores entirely. Those extra files are copies of the same private key in formats
 * nothing here can use, so they are dropped instead of written to disk: an unused secret
 * is still a secret to lose.
 */
export const WALLET_KEPT_FILES = ["ewallet.pem", "tnsnames.ora"] as const;

/** The files of one wallet, keyed by name — what gets written to `data/wallets/<id>/`. */
export type WalletFiles = Record<string, string>; // lowercase name -> UTF-8 contents

/** One service from `tnsnames.ora`: the alias to connect with, and where it points. */
export interface WalletService {
  alias: string;
  host: string;
  port: number;
  serviceName: string;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads the entries of a zip, keeping only the ones `keep` accepts.
 *
 * Names are matched on their basename alone and never used as paths, which is what makes
 * `../../etc/passwd` as an entry name a non-event here: the caller writes each result under
 * a name from its own whitelist, so nothing an uploaded archive says can steer a write.
 */
function readZip(buf: Buffer, keep: (basename: string) => boolean): ZipEntry[] {
  if (buf.length > WALLET_ZIP_MAX_BYTES) {
    throw new Error(`That file is larger than the ${WALLET_ZIP_MAX_BYTES / 1024 / 1024} MB a wallet zip may be.`);
  }
  if (buf.length < 22) throw new Error("That file is not a wallet zip.");

  // The end-of-central-directory record sits at the end, after a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("That file is not a zip archive — download the wallet from Oracle Cloud and upload the zip unchanged.");
  }

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error("Zip64 archives are not supported — a wallet zip is never this large.");

  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) throw new Error("The wallet zip's directory is damaged.");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    const basename = name.split(/[\\/]/).pop() ?? "";
    if (!keep(basename)) continue;
    if (flags & 0x1) throw new Error("The wallet zip is password-protected. Upload the zip exactly as Oracle Cloud produced it.");
    if (method !== 0 && method !== 8) throw new Error(`The wallet zip uses an unsupported compression method (${method}).`);
    if (compSize > WALLET_ZIP_MAX_BYTES) throw new Error(`"${basename}" in the wallet zip is too large.`);

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error("The wallet zip is damaged.");
    // Local headers carry their own name/extra lengths, which need not match the directory's.
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (dataStart + compSize > buf.length) throw new Error("The wallet zip is truncated.");
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: WALLET_FILE_MAX_BYTES });
    } catch {
      throw new Error(`"${basename}" in the wallet zip could not be read — it may be damaged or too large.`);
    }
    if (data.length > WALLET_FILE_MAX_BYTES) throw new Error(`"${basename}" in the wallet zip is too large.`);
    out.push({ name: basename.toLowerCase(), data });
  }
  return out;
}

/**
 * Opens an Oracle Cloud wallet zip and returns the files this app keeps.
 *
 * Throws with a message meant for the person who uploaded it — including the one case that
 * looks like a valid wallet but is not usable here: an auto-login-only wallet, which carries
 * `cwallet.sso` instead of the PEM that Thin mode reads.
 */
export function extractWallet(zip: Buffer): WalletFiles {
  const kept = new Set<string>(WALLET_KEPT_FILES);
  const entries = readZip(zip, (basename) => kept.has(basename.toLowerCase()));
  const files: WalletFiles = {};
  for (const e of entries) files[e.name] = e.data.toString("utf8");

  if (!files["tnsnames.ora"]) {
    throw new Error("That zip has no tnsnames.ora — it does not look like an Oracle Cloud wallet.");
  }
  if (!files["ewallet.pem"]) {
    throw new Error(
      "That wallet has no ewallet.pem. This app connects without Oracle Instant Client, which needs the PEM wallet — " +
        "download the wallet from Oracle Cloud again and give it a wallet password instead of choosing auto-login."
    );
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(files["ewallet.pem"])) {
    throw new Error("The wallet's ewallet.pem does not contain a private key.");
  }
  if (!parseTnsNames(files["tnsnames.ora"]).length) {
    throw new Error("The wallet's tnsnames.ora lists no database services.");
  }
  return files;
}

/** True when the PEM is encrypted, i.e. connecting with it needs the wallet password. */
export function walletNeedsPassword(pem: string): boolean {
  return /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem);
}

/**
 * Reads the service aliases out of a `tnsnames.ora`.
 *
 * Entries are `alias = (description=…)`, one per logical line but wrapped across many real
 * ones, so the scan finds each `name =` that is followed by a parenthesised descriptor and
 * then skips over that whole descriptor — which is also what keeps the `protocol=`, `port=`
 * and `host=` inside it from being read as aliases of their own.
 */
export function parseTnsNames(text: string): WalletService[] {
  // Comments run to end of line. A '#' cannot appear inside a descriptor Oracle writes.
  const src = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
  const out: WalletService[] = [];
  const seen = new Set<string>();
  const head = /([A-Za-z0-9_.$-]+)\s*=\s*(?=\()/g;

  for (let m = head.exec(src); m; m = head.exec(src)) {
    const start = src.indexOf("(", m.index);
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) break; // unbalanced tail — nothing further is trustworthy
    const descriptor = src.slice(start, end);
    head.lastIndex = end;

    const alias = m[1];
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    const host = /\(\s*host\s*=\s*([^)\s]+)/i.exec(descriptor)?.[1] ?? "";
    const port = Number(/\(\s*port\s*=\s*([0-9]+)/i.exec(descriptor)?.[1] ?? 0);
    const serviceName = /\(\s*service_name\s*=\s*([^)\s]+)/i.exec(descriptor)?.[1] ?? "";
    if (!host || !serviceName) continue; // not a net service descriptor
    seen.add(key);
    out.push({ alias, host, port, serviceName });
  }
  return out;
}
