export type StorageRow = Record<string, string | number | null>;
const number = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
export function tablespaceCapacity(row?: StorageRow) {
  const used = number(row?.["Used MiB"]);
  const capacity = number(row?.["Capacity MiB"]);
  if (used === null || capacity === null || used < 0 || capacity <= 0) return { used, capacity, remaining: null, percent: null, health: "Unknown" as const };
  const percent = used / capacity * 100;
  return { used, capacity, remaining: Math.max(0, capacity - used), percent, health: percent >= 95 ? "Critical" as const : percent >= 85 ? "Warning" as const : "Healthy" as const };
}
export function formatStorage(mib: number | null) {
  if (mib === null) return "—";
  return mib >= 1048576 ? `${(mib / 1048576).toFixed(2)} TiB` : mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}
