import fs from "node:fs";
import path from "node:path";

export function appendDbaAudit(file: string, event: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function readDbaAudit(file: string, connection: string) {
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.filter(Boolean).flatMap(line => {
      try { const event = JSON.parse(line); return event.connection === connection ? [event] : []; }
      catch { return []; } // interrupted final writes never hide earlier records
    }).slice(-100).reverse();
  } finally { fs.closeSync(fd); }
}
