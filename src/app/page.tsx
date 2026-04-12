"use client";

import { useState, useEffect, FormEvent, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/* ─── Floating particles background ─── */
function Particles() {
  const [particles] = useState(() =>
    Array.from({ length: 24 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 2 + Math.random() * 3,
      duration: 15 + Math.random() * 25,
      delay: Math.random() * -20,
      opacity: 0.08 + Math.random() * 0.12,
    }))
  );

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            background: "var(--cyan)",
            opacity: p.opacity,
            animation: `float-particle ${p.duration}s ease-in-out ${p.delay}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes float-particle {
          0%, 100% { transform: translate(0, 0) scale(1); }
          25% { transform: translate(30px, -40px) scale(1.2); }
          50% { transform: translate(-20px, -80px) scale(0.8); }
          75% { transform: translate(40px, -30px) scale(1.1); }
        }
      `}</style>
    </div>
  );
}

/* ─── Door illustration (SVG) ─── */
function DoorIllustration() {
  return (
    <svg
      viewBox="0 0 120 160"
      className="w-16 h-20 sm:w-20 sm:h-24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Door frame */}
      <rect
        x="10" y="5" width="100" height="150"
        rx="2"
        stroke="rgba(90,200,250,0.2)"
        strokeWidth="2"
        fill="rgba(90,200,250,0.02)"
      />
      {/* Door panel */}
      <rect
        x="18" y="12" width="84" height="136"
        rx="1"
        stroke="rgba(90,200,250,0.12)"
        strokeWidth="1.5"
        fill="rgba(90,200,250,0.04)"
      />
      {/* Top panel detail */}
      <rect
        x="26" y="20" width="68" height="40"
        rx="1"
        stroke="rgba(90,200,250,0.08)"
        strokeWidth="1"
        fill="none"
      />
      {/* Bottom panel detail */}
      <rect
        x="26" y="72" width="68" height="68"
        rx="1"
        stroke="rgba(90,200,250,0.08)"
        strokeWidth="1"
        fill="none"
      />
      {/* Door handle */}
      <circle
        cx="88" cy="82"
        r="4"
        fill="rgba(90,200,250,0.25)"
        stroke="rgba(90,200,250,0.4)"
        strokeWidth="1.5"
      />
      {/* Handle plate */}
      <rect
        x="84" y="70" width="8" height="24"
        rx="4"
        fill="none"
        stroke="rgba(90,200,250,0.15)"
        strokeWidth="1"
      />
      {/* Hinges */}
      <rect x="18" y="30" width="4" height="10" rx="1" fill="rgba(90,200,250,0.15)" />
      <rect x="18" y="110" width="4" height="10" rx="1" fill="rgba(90,200,250,0.15)" />
      {/* QR code suggestion */}
      <g opacity="0.2">
        <rect x="40" y="110" width="16" height="16" fill="rgba(90,200,250,0.3)" rx="1" />
        <rect x="42" y="112" width="4" height="4" fill="rgba(90,200,250,0.5)" />
        <rect x="48" y="112" width="4" height="4" fill="rgba(90,200,250,0.5)" />
        <rect x="42" y="118" width="4" height="4" fill="rgba(90,200,250,0.5)" />
        <rect x="48" y="118" width="4" height="4" fill="rgba(90,200,250,0.3)" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-4 py-8 relative overflow-hidden login-scanlines"
      style={{ background: "var(--background)" }}
    >
      {/* Layered background */}
      <Particles />

      {/* Grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(90,200,250,0.4) 1px, transparent 1px),
            linear-gradient(90deg, rgba(90,200,250,0.4) 1px, transparent 1px)
          `,
          backgroundSize: "80px 80px",
        }}
      />

      {/* Top-left radial glow */}
      <div
        className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(90,200,250,0.06) 0%, transparent 65%)",
        }}
      />

      {/* Bottom-right accent glow */}
      <div
        className="absolute -bottom-32 -right-32 w-[400px] h-[400px] rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(48,209,88,0.04) 0%, transparent 70%)",
        }}
      />

      <div
        className={`w-full max-w-[420px] relative z-10 transition-all duration-700 ${
          mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`}
      >
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-5">
            <DoorIllustration />
          </div>
          <h1
            className="text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.06em" }}
          >
            RABBIT HOLE
          </h1>
          <div className="flex items-center justify-center gap-3 mb-1">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-accent/30" />
            <p className="text-[12px] text-accent/70 tracking-[0.2em] uppercase font-medium">
              Door Hardware Systems
            </p>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-accent/30" />
          </div>
        </div>

        {/* Login card */}
        <div
          className={`relative transition-all duration-500 delay-200 ${
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <form
            onSubmit={handleLogin}
            className="panel corner-brackets p-6 sm:p-8"
          >
            <h2 className="text-[15px] font-semibold text-primary mb-5 text-center">
              Sign in to your account
            </h2>

            {error && (
              <div className="mb-5 p-3 bg-danger-dim border border-danger rounded-lg text-danger text-[13px] flex items-center gap-2.5 animate-fade-in-up">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-[11px] text-secondary mb-1.5 uppercase tracking-[0.15em] font-medium"
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setEmail(e.target.value)
                  }
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                  className="input-field"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-[11px] text-secondary mb-1.5 uppercase tracking-[0.15em] font-medium"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                  className="input-field"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="glow-btn--primary w-full rounded-lg disabled:opacity-40 disabled:cursor-not-allowed py-3 mt-6 text-[14px] font-semibold tracking-wide"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2.5">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Authenticating...
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </div>

        {/* Footer links */}
        <div
          className={`mt-6 text-center transition-all duration-500 delay-400 ${
            mounted ? "opacity-100" : "opacity-0"
          }`}
        >
          <p className="text-tertiary text-[13px]">
            Don&apos;t have an account?{" "}
            <a
              href="/signup"
              className="text-accent hover:text-accent/80 font-medium transition-colors"
            >
              Request access
            </a>
          </p>
        </div>

        {/* Feature hints */}
        <div
          className={`mt-10 grid grid-cols-3 gap-3 transition-all duration-700 delay-500 ${
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          {[
            { icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z", label: "PDF Import" },
            { icon: "M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z", label: "QR Codes" },
            { icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4", label: "Checklists" },
          ].map(({ icon, label }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg bg-tint border border-border-dim"
            >
              <svg className="w-5 h-5 text-accent/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
              </svg>
              <span className="text-[10px] text-tertiary tracking-wider uppercase">{label}</span>
            </div>
          ))}
        </div>

        {/* Version tag */}
        <p className="text-center mt-8 text-[10px] text-tertiary/40 tracking-[0.2em] uppercase">
          v0.31 // Rabbit Hole Systems
        </p>
      </div>
    </div>
  );
}
