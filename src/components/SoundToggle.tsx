"use client";

import { useEffect, useState } from "react";
import { useSounds } from "@/hooks/useSounds";

/**
 * Sound toggle button component
 * Speaker icon button that toggles sounds on/off
 * Uses Borderlands theme with cyan glow when enabled
 * Designed to sit in the Navbar
 */
export default function SoundToggle() {
  const { enabled, toggle, playToggle } = useSounds();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const handleClick = () => {
    playToggle();
    toggle();
  };

  return (
    <button
      onClick={handleClick}
      className={`relative p-2 rounded-md transition-all duration-200 ${
        enabled
          ? "bg-accent-dim border border-accent-dim hover:border-accent"
          : "bg-tint border border-border-dim-strong hover:border-th-border-hover"
      }`}
      title={enabled ? "Sounds enabled" : "Sounds disabled"}
      aria-label="Toggle sound effects"
    >
      {/* Glow effect when enabled */}
      {enabled && (
        <div
          className="absolute inset-0 rounded-md blur-sm opacity-50 pointer-events-none"
          style={{
            background:
              "radial-gradient(circle, var(--cyan-dim) 0%, transparent 70%)",
          }}
        />
      )}

      {/* Speaker icon when enabled */}
      {enabled && (
        <svg
          className="w-4 h-4 text-info relative z-10 transition-all"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
        </svg>
      )}

      {/* Muted speaker icon when disabled */}
      {!enabled && (
        <svg
          className="w-4 h-4 text-tertiary relative z-10 transition-all"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M16.6915026,12.4744748 L21.5908951,17.3738673 C21.8818042,17.6647765 21.8818042,18.1275701 21.5908951,18.4184792 L20.4184792,19.5908951 C20.1275701,19.8818042 19.6647765,19.8818042 19.3738673,19.5908951 L14.4744748,14.6915026 L9.57509225,19.5908951 C9.28418311,19.8818042 8.82138953,19.8818042 8.53048039,19.5908951 L7.3580645,18.4184792 C7.06715536,18.1275701 7.06715536,17.6647765 7.3580645,17.3738673 L12.2574570,12.4744748 L7.3580645,7.57509225 C7.06715536,7.28418311 7.06715536,6.82138953 7.3580645,6.53048039 L8.53048039,5.3580645 C8.82138953,5.06715536 9.28418311,5.06715536 9.57509225,5.3580645 L14.4744748,10.2574570 L19.3738673,5.3580645 C19.6647765,5.06715536 20.1275701,5.06715536 20.4184792,5.3580645 L21.5908951,6.53048039 C21.8818042,6.82138953 21.8818042,7.28418311 21.5908951,7.57509225 L16.6915026,12.4744748 Z" />
        </svg>
      )}
    </button>
  );
}
