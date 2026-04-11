"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "error" | "warning" | "success" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  showToast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * useToast returns { showToast } from the surrounding ToastProvider.
 * Must be called from within a component or hook mounted under ToastProvider.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return ctx;
}

let nextId = 1;
const AUTO_DISMISS_MS = 5000;

const KIND_STYLES: Record<
  ToastKind,
  { border: string; accent: string; icon: string; label: string }
> = {
  error: {
    border: "border-danger",
    accent: "text-danger",
    icon: "!",
    label: "Error",
  },
  warning: {
    border: "border-warning",
    accent: "text-warning",
    icon: "!",
    label: "Warning",
  },
  success: {
    border: "border-success",
    accent: "text-success",
    icon: "✓",
    label: "Success",
  },
  info: {
    border: "border-accent",
    accent: "text-accent",
    icon: "i",
    label: "Info",
  },
};

/**
 * ToastProvider renders a fixed toast tray at the bottom of the viewport
 * and exposes showToast via context. Toasts auto-dismiss after 5 seconds
 * and can be dismissed early by tapping.
 *
 * Usage:
 *   const { showToast } = useToast();
 *   showToast("error", "Failed to save item. Check your connection.");
 */
export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:left-auto z-50 flex flex-col gap-2 sm:max-w-sm pointer-events-none"
      >
        {toasts.map((t) => {
          const s = KIND_STYLES[t.kind];
          return (
            <button
              type="button"
              key={t.id}
              role="status"
              aria-label={`${s.label}: ${t.message}. Tap to dismiss.`}
              onClick={() => dismiss(t.id)}
              className={`pointer-events-auto w-full text-left cursor-pointer bg-surface-raised border ${s.border} rounded-xl px-4 py-3 text-sm text-primary shadow-2xl flex items-start gap-3 backdrop-blur-sm transition-opacity hover:opacity-90`}
            >
              <span
                className={`${s.accent} font-bold text-base leading-none mt-0.5 shrink-0`}
                aria-hidden="true"
              >
                {s.icon}
              </span>
              <span className="flex-1">{t.message}</span>
            </button>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
