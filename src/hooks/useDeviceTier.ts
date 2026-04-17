"use client";

import { useState, useEffect } from "react";

export type DeviceTier = "low" | "mid" | "high";

export function useDeviceTier(): DeviceTier {
  const [tier, setTier] = useState<DeviceTier>("high");

  useEffect(() => {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = (navigator as any).deviceMemory || 8;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || (cores <= 4 && memory <= 4)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- detect device capabilities on mount
      setTier("low");
    } else if (cores <= 6 || memory <= 6) {
      setTier("mid");
    } else {
      setTier("high");
    }
  }, []);

  return tier;
}
