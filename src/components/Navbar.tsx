"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import SoundToggle from "./SoundToggle";
import ThemeToggle from "./ThemeToggle";
import { playClick } from "@/lib/sounds";

export default function Navbar() {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    getUser();
  }, []);

  const getUser = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setEmail(user?.email || null);
    } catch (err) {
      console.error("Error getting user:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    playClick();
    await supabase.auth.signOut();
    router.push("/");
  };

  const handleDashboardClick = () => {
    playClick();
    router.push("/dashboard");
  };

  return (
    <nav className="relative bg-[var(--background)]/95 backdrop-blur-xl border-b border-[var(--border)]">
      {/* Subtle bottom glow line */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[1px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(10,132,255,0.2) 30%, rgba(10,132,255,0.3) 50%, rgba(10,132,255,0.2) 70%, transparent)",
        }}
      />

      <div className="max-w-7xl mx-auto px-4 py-3.5 flex justify-between items-center">
        {/* Brand */}
        <button
          onClick={handleDashboardClick}
          className="flex items-center gap-2.5 group"
        >
          {/* Logo mark */}
          <div className="relative w-8 h-8 rounded-md bg-[rgba(10,132,255,0.08)] border border-[rgba(10,132,255,0.2)] flex items-center justify-center group-hover:border-[rgba(10,132,255,0.4)] transition-all">
            <svg
              className="w-4 h-4 text-[var(--blue)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
          </div>
          <div className="flex flex-col">
            <span
              className="font-display text-[13px] font-semibold tracking-wider text-[var(--text-primary)] group-hover:text-[var(--blue)] transition-colors"
              style={{ fontFamily: "var(--font-display)" }}
            >
              RABBIT HOLE
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)] tracking-widest uppercase">
              Door Hardware
            </span>
          </div>
        </button>

        {/* User section */}
        <div className="flex items-center gap-3">
          <SoundToggle />
          <ThemeToggle />
          {!loading && email && (
            <>
              <span className="hidden sm:inline text-[12px] text-[var(--text-tertiary)] tabular-nums">
                {email}
              </span>
              <button
                onClick={handleSignOut}
                className="glow-btn--ghost px-3 py-1.5 text-[12px] rounded-md border border-[var(--border)] hover:border-[var(--border-hover)] transition-all"
              >
                Sign Out
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
