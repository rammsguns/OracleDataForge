import { createContext, useContext } from "react";

/** Nested tool pages inherit their workspace tab's activity. Standalone pages are active. */
export const TabActivity = createContext(true);
export const useTabActive = () => useContext(TabActivity);
