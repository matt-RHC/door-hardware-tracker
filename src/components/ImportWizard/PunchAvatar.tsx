'use client';

import React from 'react';

export type PunchAvatarState = 'idle' | 'thinking' | 'success' | 'warning' | 'error';

interface PunchAvatarProps {
  size?: 'sm' | 'lg';
  state?: PunchAvatarState;
  className?: string;
}

/**
 * Punch avatar — a construction clipboard with an animated checkmark.
 *
 * sm = 32x32 (inline tips), lg = 48x48 (sidebar header).
 * The checkmark morphs based on state:
 *   idle/thinking → neutral dot-dot eyes
 *   success       → checkmark
 *   warning       → exclamation mark
 *   error         → X mark
 */
export default function PunchAvatar({
  size = 'sm',
  state = 'idle',
  className = '',
}: PunchAvatarProps) {
  const px = size === 'lg' ? 48 : 32;

  // Accent colour per state
  const accent =
    state === 'success'
      ? 'var(--green)'
      : state === 'warning'
        ? 'var(--orange)'
        : state === 'error'
          ? 'var(--red)'
          : 'var(--blue)'; // idle / thinking

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Clipboard body */}
      <rect x="8" y="10" width="32" height="34" rx="4" fill="var(--surface-hover)" stroke="var(--border-hover)" strokeWidth="1.5" />

      {/* Clipboard clip */}
      <rect x="16" y="6" width="16" height="8" rx="3" fill="var(--border-hover)" />
      <rect x="20" y="4" width="8" height="4" rx="2" fill="var(--blue)" />

      {/* Lined paper effect */}
      <line x1="14" y1="22" x2="34" y2="22" stroke="var(--border-hover)" strokeWidth="0.75" />
      <line x1="14" y1="28" x2="34" y2="28" stroke="var(--border-hover)" strokeWidth="0.75" />
      <line x1="14" y1="34" x2="34" y2="34" stroke="var(--border-hover)" strokeWidth="0.75" />

      {/* State indicator */}
      <g>
        {state === 'success' && (
          <polyline
            points="18,29 22,33 30,25"
            stroke={accent}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate
              attributeName="stroke-dasharray"
              from="0 20"
              to="20 0"
              dur="0.4s"
              fill="freeze"
            />
          </polyline>
        )}

        {state === 'warning' && (
          <>
            <line
              x1="24" y1="24" x2="24" y2="31"
              stroke={accent}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="24" cy="35" r="1.25" fill={accent} />
          </>
        )}

        {state === 'error' && (
          <>
            <line x1="20" y1="25" x2="28" y2="33" stroke={accent} strokeWidth="2.5" strokeLinecap="round" />
            <line x1="28" y1="25" x2="20" y2="33" stroke={accent} strokeWidth="2.5" strokeLinecap="round" />
          </>
        )}

        {(state === 'idle' || state === 'thinking') && (
          <>
            {/* Friendly dot-dot eyes */}
            <circle cx="20" cy="26" r="1.5" fill="var(--text-secondary)">
              {state === 'thinking' && (
                <animate
                  attributeName="cy"
                  values="26;24;26"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <circle cx="28" cy="26" r="1.5" fill="var(--text-secondary)">
              {state === 'thinking' && (
                <animate
                  attributeName="cy"
                  values="26;24;26"
                  dur="1.2s"
                  repeatCount="indefinite"
                  begin="0.15s"
                />
              )}
            </circle>
            {/* Small smile */}
            <path
              d="M21 31 Q24 34 27 31"
              stroke="var(--text-secondary)"
              strokeWidth="1.25"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}
      </g>
    </svg>
  );
}
