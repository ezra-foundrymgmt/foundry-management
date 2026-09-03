"use client";

import { createContext, useContext } from "react";

/**
 * Whether the UI may render demo fixtures.
 *
 * This is resolved on the server from the environment contract and passed down,
 * rather than read in the browser from NEXT_PUBLIC_CREATOROS_DEMO_MODE. That
 * variable was outside the zod contract and defaulted to demo when unset, so a
 * live deployment that forgot to set it showed fabricated creators and revenue
 * as though they were real Foundry data.
 *
 * The default here is `false` — live. A missing provider must never be the
 * reason fixtures appear.
 */
const DemoModeContext = createContext(false);

export function DemoModeProvider({ demo, children }: { demo: boolean; children: React.ReactNode }) {
  return <DemoModeContext.Provider value={demo}>{children}</DemoModeContext.Provider>;
}

export function useDemoMode(): boolean {
  return useContext(DemoModeContext);
}
