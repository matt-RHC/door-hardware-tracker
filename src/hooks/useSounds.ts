"use client";

import { useState, useCallback, useEffect } from "react";
import { sounds, type SoundType } from "@/lib/sounds";

export interface UseSoundsReturn {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
  playClick: () => void;
  playSuccess: () => void;
  playError: () => void;
  playHover: () => void;
  playToggle: () => void;
  playComplete: () => void;
  playNotification: () => void;
  play: (soundType: SoundType) => void;
}

/**
 * React hook for managing sound effects
 * Handles enabled state and provides memoized sound functions
 */
export function useSounds(): UseSoundsReturn {
  const [enabled, setEnabledState] = useState<boolean>(true);

  // Sync local state with sound manager on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync with sound manager on mount
    setEnabledState(sounds.isEnabled());
  }, []);

  // Toggle sounds on/off
  const setEnabled = useCallback((newEnabled: boolean) => {
    setEnabledState(newEnabled);
    sounds.setEnabled(newEnabled);
  }, []);

  const toggle = useCallback(() => {
    const newState = !enabled;
    setEnabledState(newState);
    sounds.setEnabled(newState);
  }, [enabled]);

  // Memoized sound functions
  const playClick = useCallback(() => sounds.playClick(), []);
  const playSuccess = useCallback(() => sounds.playSuccess(), []);
  const playError = useCallback(() => sounds.playError(), []);
  const playHover = useCallback(() => sounds.playHover(), []);
  const playToggle = useCallback(() => sounds.playToggle(), []);
  const playComplete = useCallback(() => sounds.playComplete(), []);
  const playNotification = useCallback(() => sounds.playNotification(), []);
  const play = useCallback((soundType: SoundType) => sounds.play(soundType), []);

  return {
    enabled,
    toggle,
    setEnabled,
    playClick,
    playSuccess,
    playError,
    playHover,
    playToggle,
    playComplete,
    playNotification,
    play,
  };
}
