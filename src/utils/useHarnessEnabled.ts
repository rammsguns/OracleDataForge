import { useEffect, useState } from "react";

/** Disabled integrations expose no assistance controls. */
export function useHarnessEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai/capabilities", { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(capabilities => setEnabled(capabilities?.enabled === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return enabled;
}
