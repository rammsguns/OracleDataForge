import { useRef, type ReactNode } from "react";
import { StudioSnapshot, useStudio } from "../state/store";
import { TabActivity } from "../state/tabActivity";

/** Hidden tabs retain DOM, local state and their last visible store context. Closing
 * the workspace tab unmounts this boundary and releases its contents. */
export default function RetainedTool({ active, connectionScoped = true, children }: { active: boolean; connectionScoped?: boolean; children: ReactNode }) {
  const studio = useStudio();
  const snapshot = useRef(studio);
  const visited = useRef(false);
  if (active) { snapshot.current = studio; visited.current = true; }
  const conn = snapshot.current.connections.find(connection => connection.id === snapshot.current.activeConnId);
  const connectionKey = JSON.stringify([snapshot.current.activeConnId, conn?.engine, conn?.host, conn?.port, conn?.user, conn?.database, conn?.authMode, conn?.walletId, conn?.role, conn?.readOnly]);
  return <div className="h-full min-h-0" hidden={!active} inert={!active}>
    {visited.current && <TabActivity.Provider value={active}>
      <StudioSnapshot key={connectionScoped ? connectionKey : "workspace"} value={snapshot.current}>{children}</StudioSnapshot>
    </TabActivity.Provider>}
  </div>;
}
