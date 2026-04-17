"use client"

import Image from "next/image"
import { useEffect, useState, type ReactNode } from "react"

export type DarrinAvatar = "scanning" | "excited" | "concerned" | "success"

const AVATAR_SRC: Record<DarrinAvatar, string> = {
  scanning: "/darrin/darrin_scanning.png",
  excited: "/darrin/darrin_excited.png",
  concerned: "/darrin/darrin_concerned.png",
  success: "/darrin/darrin_success.png",
}

const AVATAR_ALT: Record<DarrinAvatar, string> = {
  scanning: "Darrin scanning",
  excited: "Darrin excited",
  concerned: "Darrin concerned",
  success: "Darrin success",
}

interface DarrinMessageProps {
  avatar: DarrinAvatar
  message: ReactNode
  children?: ReactNode
}

/**
 * A single chat-style message from Darrin. Avatar on the left, bubble on the
 * right with the message text and optional action buttons / inputs.
 *
 * Animates in with a subtle fade + slide the first time it mounts so the
 * conversation feels progressive rather than dropped in all at once.
 */
export default function DarrinMessage({ avatar, message, children }: DarrinMessageProps) {
  const [mounted, setMounted] = useState(false)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className={`flex items-start gap-3 transition-all duration-300 ease-out ${
        mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <div className="flex-shrink-0 w-12 h-12 rounded-full overflow-hidden bg-slate-800 border border-border-dim flex items-center justify-center">
        {imgError ? (
          <span className="text-xl" role="img" aria-label={AVATAR_ALT[avatar]}>👷</span>
        ) : (
          <Image
            src={AVATAR_SRC[avatar]}
            alt={AVATAR_ALT[avatar]}
            width={48}
            height={48}
            className="w-full h-full object-cover"
            priority={avatar === "scanning"}
            unoptimized
            onError={() => setImgError(true)}
          />
        )}
      </div>
      <div className="flex-1 min-w-0 bg-slate-800 rounded-lg p-4 border border-border-dim/50">
        <div className="text-sm text-primary leading-relaxed">{message}</div>
        {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  )
}

// ─── Action button helpers ─────────────────────────────────────────

interface DarrinActionProps {
  onClick: () => void
  selected?: boolean
  variant?: "primary" | "ghost"
  children: ReactNode
  disabled?: boolean
}

export function DarrinAction({
  onClick,
  selected = false,
  variant = "ghost",
  children,
  disabled = false,
}: DarrinActionProps) {
  const base =
    "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border min-h-9 disabled:opacity-50 disabled:cursor-not-allowed"
  const styles = selected
    ? "bg-accent-dim border-accent/50 text-accent"
    : variant === "primary"
    ? "bg-accent hover:bg-accent/80 border-accent text-white"
    : "bg-tint border-border-dim text-secondary hover:text-primary hover:border-accent/30"

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
    >
      {children}
    </button>
  )
}
