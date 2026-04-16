'use client';

import {
  createContext,
  useContext,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { createElement } from 'react';

// ── Context ────────────────────────────────────────────────────────────

interface PunchHighlightContextValue {
  registerRef: (key: string, el: HTMLElement | null) => void;
  scrollToRef: (key: string) => void;
}

const PunchHighlightContext = createContext<PunchHighlightContextValue>({
  registerRef: () => {},
  scrollToRef: () => {},
});

export function usePunchHighlight() {
  return useContext(PunchHighlightContext);
}

// ── Provider ───────────────────────────────────────────────────────────

const PULSE_MS = 2000;

const HIGHLIGHT_CSS = `
@keyframes punchPulse {
  0%   { box-shadow: 0 0 0 0   var(--blue-dim); }
  50%  { box-shadow: 0 0 0 6px transparent;     }
  100% { box-shadow: 0 0 0 0   transparent;     }
}
.punch-highlighted {
  animation: punchPulse 1s ease-out 2;
  background-color: var(--blue-dim) !important;
}
`;

interface PunchHighlightProviderProps {
  activeKeys: string[];
  children: ReactNode;
}

export function PunchHighlightProvider({
  activeKeys,
  children,
}: PunchHighlightProviderProps) {
  const refs = useRef(new Map<string, HTMLElement>());
  const timers = useRef<number[]>([]);

  const registerRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) {
      refs.current.set(key, el);
    } else {
      refs.current.delete(key);
    }
  }, []);

  const pulseElement = useCallback((el: HTMLElement) => {
    el.classList.remove('punch-highlighted');
    // Force reflow so animation restarts
    void el.offsetWidth;
    el.classList.add('punch-highlighted');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return window.setTimeout(() => {
      el.classList.remove('punch-highlighted');
    }, PULSE_MS);
  }, []);

  const scrollToRef = useCallback(
    (key: string) => {
      const el = refs.current.get(key);
      if (el) pulseElement(el);
    },
    [pulseElement],
  );

  // Highlight matched elements whenever activeKeys changes
  const keysToken = activeKeys.join('\0');
  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    for (const key of activeKeys) {
      const el = refs.current.get(key);
      if (el) timers.current.push(pulseElement(el));
    }

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysToken, pulseElement]);

  return createElement(
    PunchHighlightContext.Provider,
    { value: { registerRef, scrollToRef } },
    createElement('style', null, HIGHLIGHT_CSS),
    children,
  );
}
