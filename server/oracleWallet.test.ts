/**
 * Tests for Oracle Cloud wallet handling — reading the zip, and reading the services out of
 * the tnsnames.ora inside it. Run with `npm test`.
 *
 * Both halves parse a file a user uploaded, so what is covered is what a bad or unexpected
 * file does: that a real wallet comes out intact, that the parser finds every alias and is
 * not fooled by the `host=`/`port=` pairs inside a descriptor, and that a zip which is
 * damaged, hostile, or simply the wrong kind of wallet is refused with a message rather
 * than half-read.
 */
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  extractWallet,
  parseTnsNames,
  walletNeedsPassword,
  WALLET_FILE_MAX_BYTES,
} from "./oracleWallet.ts";

/** A tnsnames.ora shaped exactly like the one in an Autonomous Database wallet. */
const TNSNAMES = `dataforge_high = (description= (retry_count=20)(retry_delay=3)(address=(protocol=tcps)(port=1522)(host=adb.eu-frankfurt-1.oraclecloud.com))(connect_data=(service_name=g1b2c3_dataforge_high.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))

dataforge_medium = (description= (retry_count=20)(retry_delay=3)(address=(protocol=tcps)(port=1522)(host=adb.eu-frankfurt-1.oraclecloud.com))(connect_data=(service_name=g1b2c3_dataforge_medium.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))

# a comment line
dataforge_low = (description=
    (retry_count=20)(retry_delay=3)
    (address=(protocol=tcps)(port=1522)(host=adb.eu-frankfurt-1.oraclecloud.com))
    (connect_data=(service_name=g1b2c3_dataforge_low.adb.oraclecloud.com))
    (security=(ssl_server_dn_match=yes)))
`;

const PEM = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkq\n-----END ENCRYPTED PRIVATE KEY-----\n";
const PLAIN_PEM = "-----BEGIN PRIVATE KEY-----\nMIIFHDBOBgkq\n-----END PRIVATE KEY-----\n";

/** Builds a zip in the shape the reader expects: local headers, then a central directory. */
function makeZip(files: Record<string, string>, opts: { store?: boolean; encrypted?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = opts.store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const flags = opts.encrypted ? 0x1 : 0;
    const method = opts.store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);

    locals.push(local, data);
    central.push(dir);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const WALLET = { "tnsnames.ora": TNSNAMES, "ewallet.pem": PEM };

describe("parseTnsNames", () => {
  it("reads every alias with its host, port and service", () => {
    const services = parseTnsNames(TNSNAMES);
    assert.deepEqual(
      services.map((s) => s.alias),
      ["dataforge_high", "dataforge_medium", "dataforge_low"]
    );
    assert.deepEqual(services[0], {
      alias: "dataforge_high",
      host: "adb.eu-frankfurt-1.oraclecloud.com",
      port: 1522,
      serviceName: "g1b2c3_dataforge_high.adb.oraclecloud.com",
    });
  });

  it("reads an alias whose descriptor is wrapped over several lines", () => {
    const low = parseTnsNames(TNSNAMES).find((s) => s.alias === "dataforge_low");
    assert.equal(low?.port, 1522);
    assert.equal(low?.serviceName, "g1b2c3_dataforge_low.adb.oraclecloud.com");
  });

  it("does not mistake the pairs inside a descriptor for aliases", () => {
    for (const s of parseTnsNames(TNSNAMES)) {
      assert.ok(!["protocol", "port", "host", "service_name", "description", "address"].includes(s.alias));
    }
  });

  it("ignores commented-out entries", () => {
    const services = parseTnsNames(`# ghost = (description=(address=(port=1522)(host=h))(connect_data=(service_name=s)))\n${TNSNAMES}`);
    assert.ok(!services.some((s) => s.alias === "ghost"));
  });

  it("keeps the first of two entries with the same alias", () => {
    const services = parseTnsNames(
      `dup = (description=(address=(port=1)(host=first))(connect_data=(service_name=a)))\n` +
        `dup = (description=(address=(port=2)(host=second))(connect_data=(service_name=b)))\n`
    );
    assert.equal(services.length, 1);
    assert.equal(services[0].host, "first");
  });

  it("returns nothing for a file that is not tnsnames.ora", () => {
    assert.deepEqual(parseTnsNames("WALLET_LOCATION = (SOURCE = (METHOD = file))\nSSL_SERVER_DN_MATCH=yes\n"), []);
  });

  it("stops at an unbalanced descriptor instead of looping", () => {
    assert.deepEqual(parseTnsNames("broken = (description=(address=(port=1522)(host=h)"), []);
  });
});

describe("extractWallet", () => {
  it("takes the PEM and tnsnames out of a deflated wallet zip", () => {
    const files = extractWallet(makeZip(WALLET));
    assert.deepEqual(Object.keys(files).sort(), ["ewallet.pem", "tnsnames.ora"]);
    assert.equal(files["tnsnames.ora"], TNSNAMES);
    assert.equal(files["ewallet.pem"], PEM);
  });

  it("reads stored (uncompressed) entries too", () => {
    assert.equal(extractWallet(makeZip(WALLET, { store: true }))["tnsnames.ora"], TNSNAMES);
  });

  it("keeps only the two files it needs, whatever else the wallet carries", () => {
    const files = extractWallet(
      makeZip({ ...WALLET, "cwallet.sso": "sso", "ewallet.p12": "p12", "keystore.jks": "jks", "sqlnet.ora": "x", README: "hi" })
    );
    assert.deepEqual(Object.keys(files).sort(), ["ewallet.pem", "tnsnames.ora"]);
  });

  it("ignores the directory prefix a wallet zip may carry, without treating it as a path", () => {
    const files = extractWallet(makeZip({ "Wallet_DATAFORGE/tnsnames.ora": TNSNAMES, "Wallet_DATAFORGE/ewallet.pem": PEM }));
    assert.deepEqual(Object.keys(files).sort(), ["ewallet.pem", "tnsnames.ora"]);
  });

  it("cannot be talked into a path by a traversing entry name", () => {
    // The name is matched on its basename and never used as one, so this is just "the PEM".
    const files = extractWallet(makeZip({ "tnsnames.ora": TNSNAMES, "../../../../etc/ewallet.pem": PEM }));
    assert.deepEqual(Object.keys(files).sort(), ["ewallet.pem", "tnsnames.ora"]);
  });

  it("refuses a file that is not a zip", () => {
    assert.throws(() => extractWallet(Buffer.from("PK not really a zip, just some bytes".repeat(4))), /not a zip archive/);
  });

  it("refuses an auto-login wallet, which has no PEM for Thin mode", () => {
    assert.throws(() => extractWallet(makeZip({ "tnsnames.ora": TNSNAMES, "cwallet.sso": "sso" })), /no ewallet\.pem/);
  });

  it("refuses a zip with no tnsnames.ora", () => {
    assert.throws(() => extractWallet(makeZip({ "ewallet.pem": PEM })), /no tnsnames\.ora/);
  });

  it("refuses a PEM with no private key in it", () => {
    assert.throws(
      () => extractWallet(makeZip({ "tnsnames.ora": TNSNAMES, "ewallet.pem": "-----BEGIN CERTIFICATE-----\nMIIB\n" })),
      /does not contain a private key/
    );
  });

  it("refuses a wallet whose tnsnames lists no services", () => {
    assert.throws(() => extractWallet(makeZip({ "tnsnames.ora": "SSL_SERVER_DN_MATCH=yes\n", "ewallet.pem": PEM })), /no database services/);
  });

  it("refuses an encrypted zip rather than writing out its ciphertext", () => {
    assert.throws(() => extractWallet(makeZip(WALLET, { encrypted: true })), /password-protected/);
  });

  it("refuses a truncated zip", () => {
    const zip = makeZip(WALLET);
    // Cut the entry data out from under the directory, leaving the trailer intact.
    const damaged = Buffer.concat([zip.subarray(0, 40), zip.subarray(zip.length - 120)]);
    assert.throws(() => extractWallet(damaged), /wallet zip/);
  });

  it("refuses a decompression bomb instead of holding it in memory", () => {
    const bomb = makeZip({ "tnsnames.ora": "A".repeat(WALLET_FILE_MAX_BYTES + 1024), "ewallet.pem": PEM });
    assert.throws(() => extractWallet(bomb), /could not be read|too large/);
  });
});

describe("walletNeedsPassword", () => {
  it("is true for the encrypted PEM Oracle Cloud produces", () => {
    assert.equal(walletNeedsPassword(PEM), true);
  });

  it("is false for an unencrypted key", () => {
    assert.equal(walletNeedsPassword(PLAIN_PEM), false);
  });
});
