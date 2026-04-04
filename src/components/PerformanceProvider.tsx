"use client";

import { createContext, useContext, useEffect } from "react";
import { useDeviceTier, DeviceTier } from "@/hooks/useDeviceTier";

const DeviceTierContext = createContext<DeviceTier>("high");

export function usePerformanceTier() {
  return useContext(DeviceTierContext);
}

export default function PerformanceProvider({ children }: { children: React.ReactNode }) {
  const tier = useDeviceTier();

  useEffect(() => {
    document.documentElement.setAttribute("data-perf", tier);
  }, [tier]);

  return (
    <DeviceTierContext.Provider value={tier}>
      {children}
    </DeviceTierContext.Provider>
  );
}
