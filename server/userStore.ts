import fs from "node:fs";

export type Role = "Administrator" | "Developer" | "Analyst" | "Viewer";

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "Active" | "Suspended";
  mfa: boolean;
  salt: string;
  hash: string;
  createdAt: string;
}

/** Only a missing store enables first-run setup. Validate everything before admitting anyone. */
export function loadUserStore(
  filename: string,
  read: (filename: string) => string = (file) => fs.readFileSync(file, "utf8"),
): Map<string, StoredUser> {
  let text: string;
  try {
    text = read(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
    throw new Error("Cannot read the account store; refusing to start without authentication.", { cause: error });
  }

  try {
    const records: unknown = JSON.parse(text);
    if (!Array.isArray(records) || records.length === 0) throw new Error("Expected a nonempty account list.");
    const result = new Map<string, StoredUser>();
    const ids = new Set<string>();
    for (const record of records) {
      if (!record || typeof record !== "object") throw new Error("Invalid account.");
      const u = record as StoredUser;
      if (![u.id, u.name, u.email, u.createdAt].every((v) => typeof v === "string" && v.trim().length > 0) ||
          !["Administrator", "Developer", "Analyst", "Viewer"].includes(u.role) ||
          !["Active", "Suspended"].includes(u.status) || typeof u.mfa !== "boolean" ||
          typeof u.salt !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(u.salt) ||
          typeof u.hash !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(u.hash)) {
        throw new Error("Invalid account fields.");
      }
      const email = u.email.toLowerCase();
      if (result.has(email) || ids.has(u.id)) throw new Error("Duplicate account.");
      ids.add(u.id);
      result.set(email, u);
    }
    return result;
  } catch (error) {
    throw new Error("Invalid account store; refusing to start without authentication.", { cause: error });
  }
}
