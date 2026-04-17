"use client";

import { useState, useEffect, FormEvent, ChangeEvent, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Identifier-first sign-in.
 *
 * Flow:
 *   1. User enters work email.
 *   2. POST /api/auth/resolve routes to one of:
 *      - 'sso':      show "Continue to {company_name}" branded button.
 *      - 'password': slide in password field; Sign in stays the CTA.
 *      - 'unknown':  show soft inline helper; do not reveal account state.
 *   3. Fallback OAuth buttons below the divider skip the identifier step.
 *
 * Keeps the existing chrome: DoorIllustration, Orbitron header, radial
 * glow, panel/input-field/glow-btn utilities. Only the flow logic changes.
 */

type ResolveKind =
  | { kind: "sso"; provider: "google" | "azure"; company_name: string }
  | { kind: "password" }
  | { kind: "unknown" }
  | { kind: "idle" };

function DoorIllustration({ pulsing = false }: { pulsing?: boolean }) {
  return (
    <svg
      viewBox="0 0 120 160"
      className={`w-16 h-20 sm:w-20 sm:h-24 ${pulsing ? "animate-pulse" : ""}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--blue)" }}
    >
      <rect x="10" y="5" width="100" height="150" rx="2" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" fill="currentColor" fillOpacity="0.02" />
      <rect x="18" y="12" width="84" height="136" rx="1" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1.5" fill="currentColor" fillOpacity="0.04" />
      <rect x="26" y="20" width="68" height="40" rx="1" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" fill="none" />
      <rect x="26" y="72" width="68" height="68" rx="1" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" fill="none" />
      <circle cx="88" cy="82" r="4" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
      <rect x="84" y="70" width="8" height="24" rx="4" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" />
      <rect x="18" y="30" width="4" height="10" rx="1" fill="currentColor" fillOpacity="0.15" />
      <rect x="18" y="110" width="4" height="10" rx="1" fill="currentColor" fillOpacity="0.15" />
      <g opacity="0.2">
        <rect x="40" y="110" width="16" height="16" fill="currentColor" fillOpacity="0.3" rx="1" />
        <rect x="42" y="112" width="4" height="4" fill="currentColor" fillOpacity="0.5" />
        <rect x="48" y="112" width="4" height="4" fill="currentColor" fillOpacity="0.5" />
        <rect x="42" y="118" width="4" height="4" fill="currentColor" fillOpacity="0.5" />
        <rect x="48" y="118" width="4" height="4" fill="currentColor" fillOpacity="0.3" />
      </g>
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.12c-.22-.66-.35-1.36-.35-2.12s.13-1.46.35-2.12V7.04H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.96l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.04l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
    </svg>
  );
}

function MicrosoftGlyph() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [redirecting, setRedirecting] = useState<"sso" | "password" | null>(null);
  const [redirectStage, setRedirectStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [resolved, setResolved] = useState<ResolveKind>({ kind: "idle" });
  const [emailLocked, setEmailLocked] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReqRef = useRef(0);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
    };
  }, []);

  // Staged "Opening the door…" copy while the OAuth hand-off is in flight.
  useEffect(() => {
    if (!redirecting) return;
    const id = setInterval(() => {
      setRedirectStage((s) => (s + 1) % 3);
    }, 600);
    return () => clearInterval(id);
  }, [redirecting]);

  function resetFlow() {
    setResolved({ kind: "idle" });
    setPassword("");
    setEmailLocked(false);
    setError(null);
  }

  async function resolveEmail(value: string) {
    const trimmed = value.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setResolved({ kind: "idle" });
      return;
    }
    const reqId = ++latestReqRef.current;
    setResolving(true);
    try {
      const res = await fetch("/api/auth/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        // 429 or other — surface as unknown so the user can still use
        // the fallback OAuth buttons.
        if (reqId === latestReqRef.current) setResolved({ kind: "unknown" });
        return;
      }
      const data = (await res.json()) as ResolveKind;
      if (reqId === latestReqRef.current) {
        setResolved(data);
      }
    } catch {
      if (reqId === latestReqRef.current) setResolved({ kind: "unknown" });
    } finally {
      if (reqId === latestReqRef.current) setResolving(false);
    }
  }

  function onEmailChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setEmail(value);
    setError(null);
    // Debounce the resolve so we don't hammer the API on every keystroke.
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    if (emailLocked) setEmailLocked(false);
    if (resolved.kind !== "idle") setResolved({ kind: "idle" });
    resolveTimer.current = setTimeout(() => {
      void resolveEmail(value);
    }, 300);
  }

  async function handleContinue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // If we haven't resolved yet (user hit Enter fast), resolve now.
    if (resolved.kind === "idle") {
      await resolveEmail(email);
      return;
    }

    if (resolved.kind === "sso") {
      await startOAuth(resolved.provider);
      return;
    }

    if (resolved.kind === "password") {
      if (!password) {
        // Password slot is already visible but empty — prompt and stop.
        setError("Enter your password to continue.");
        return;
      }
      await doPasswordSignIn();
      return;
    }

    // Unknown kind — Continue shouldn't even be enabled, but guard anyway.
  }

  async function doPasswordSignIn() {
    setLoading(true);
    setRedirecting("password");
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        setRedirecting(null);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("An unexpected error occurred");
      setRedirecting(null);
    } finally {
      setLoading(false);
    }
  }

  async function startOAuth(provider: "google" | "azure") {
    setLoading(true);
    setRedirecting("sso");
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const scopes = provider === "azure" ? "email" : undefined;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${origin}/api/auth/callback`,
          scopes,
        },
      });
      if (oauthError) {
        setError(oauthError.message);
        setRedirecting(null);
        setLoading(false);
      }
      // If signInWithOAuth succeeds it redirects the browser — nothing to do.
    } catch {
      setError("We couldn't sign you in. Try again or contact support.");
      setRedirecting(null);
      setLoading(false);
    }
  }

  async function onForgotPassword() {
    if (!email) {
      setError("Enter your email address first.");
      return;
    }
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== "undefined" ? `${window.location.origin}/` : undefined,
    });
    if (resetError) {
      setError(resetError.message);
    } else {
      setError("If an account exists, a reset link is on the way.");
    }
  }

  const showPasswordField = resolved.kind === "password";
  const showSsoButton = resolved.kind === "sso";
  const showUnknownHelper = resolved.kind === "unknown" && email.length > 0;
  const ctaLabel =
    resolved.kind === "password"
      ? loading ? "Opening the door…" : "Sign in"
      : resolved.kind === "sso"
      ? loading ? "Opening the door…" : `Continue to ${resolved.company_name}`
      : loading ? "Opening the door…" : "Continue";

  const redirectingCopy = ["Setting up your workspace…", "Opening the door…", "Welcome back."][redirectStage];

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-4 py-8 relative overflow-hidden"
      style={{ background: "var(--background)" }}
    >
      <div
        className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--blue) 6%, transparent) 0%, transparent 65%)",
        }}
      />

      {/* Full-bleed scrim during the OAuth / password → dashboard handoff. */}
      {redirecting && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4"
          style={{ background: "color-mix(in srgb, var(--background) 92%, transparent)" }}
        >
          <DoorIllustration pulsing />
          <p className="text-[13px] text-secondary tracking-[0.18em] uppercase">
            {redirectingCopy}
          </p>
        </div>
      )}

      <div
        className={`w-full max-w-[420px] relative z-10 transition-all duration-700 ${
          mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`}
      >
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

        <div
          className={`relative transition-all duration-500 delay-200 ${
            mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <form onSubmit={handleContinue} className="panel p-6 sm:p-8">
            <h2 className="text-[15px] font-semibold text-primary mb-5 text-center">
              Sign in to your workspace
            </h2>

            {error && (
              <div className="mb-5 p-3 bg-danger-dim border border-danger rounded-md text-danger text-[13px] flex items-center gap-2.5 animate-fade-in-up">
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
                  Work Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={onEmailChange}
                  placeholder="you@company.com"
                  required
                  disabled={emailLocked}
                  autoComplete="email"
                  className="input-field"
                />
                {emailLocked && (
                  <button
                    type="button"
                    onClick={resetFlow}
                    className="mt-2 text-[11px] text-accent/70 hover:text-accent underline-offset-2 hover:underline"
                  >
                    Use a different email
                  </button>
                )}
                {showUnknownHelper && (
                  <p className="mt-2 text-[12px] text-tertiary animate-fade-in-up">
                    We couldn&apos;t find a workspace for this email.{" "}
                    <a
                      href="mailto:support@rabbitholesystems.com?subject=Register%20my%20company"
                      className="text-accent hover:text-accent/80 underline-offset-2 hover:underline"
                    >
                      Talk to your admin
                    </a>{" "}
                    or{" "}
                    <a
                      href="/signup"
                      className="text-accent hover:text-accent/80 underline-offset-2 hover:underline"
                    >
                      request access
                    </a>
                    .
                  </p>
                )}
              </div>

              {showPasswordField && (
                <div className="animate-fade-in-up">
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    onFocus={() => setEmailLocked(true)}
                    className="input-field"
                  />
                  <button
                    type="button"
                    onClick={onForgotPassword}
                    className="mt-2 text-[11px] text-accent/70 hover:text-accent underline-offset-2 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || resolving || (resolved.kind === "unknown" && email.length > 0)}
              onClick={() => {
                if (resolved.kind === "sso" || resolved.kind === "password") setEmailLocked(true);
              }}
              className="glow-btn--primary w-full rounded disabled:opacity-40 disabled:cursor-not-allowed py-3 mt-6 text-[14px] font-semibold tracking-wide flex items-center justify-center gap-2.5"
            >
              {resolving ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Checking workspace…
                </>
              ) : showSsoButton ? (
                <>
                  {resolved.provider === "google" ? <GoogleGlyph /> : <MicrosoftGlyph />}
                  {ctaLabel}
                </>
              ) : loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {ctaLabel}
                </>
              ) : (
                ctaLabel
              )}
            </button>

            {/* Passkey placeholder — v1.5. Signals roadmap to enterprise buyers. */}
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                disabled
                title="Passkeys coming soon"
                className="text-[11px] text-tertiary/60 cursor-not-allowed tracking-[0.1em] uppercase"
              >
                Use a passkey · coming soon
              </button>
            </div>

            {/* Divider + fallback OAuth buttons */}
            <div className="mt-6 mb-4 flex items-center gap-3" aria-hidden="true">
              <div className="flex-1 h-px bg-border-dim" />
              <span className="text-[11px] text-tertiary tracking-[0.18em] uppercase">
                or continue with
              </span>
              <div className="flex-1 h-px bg-border-dim" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => startOAuth("google")}
                disabled={loading}
                className="flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-tint border border-border-dim hover:border-accent/40 transition-colors text-[13px] text-primary disabled:opacity-40"
              >
                <GoogleGlyph />
                Google
              </button>
              <button
                type="button"
                onClick={() => startOAuth("azure")}
                disabled={loading}
                className="flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-tint border border-border-dim hover:border-accent/40 transition-colors text-[13px] text-primary disabled:opacity-40"
              >
                <MicrosoftGlyph />
                Microsoft
              </button>
            </div>
          </form>
        </div>

        <div
          className={`mt-6 text-center transition-all duration-500 delay-400 ${
            mounted ? "opacity-100" : "opacity-0"
          }`}
        >
          <p className="text-tertiary text-[13px]">
            Don&apos;t see your workspace?{" "}
            <a href="/signup" className="text-accent hover:text-accent/80 font-medium transition-colors">
              Request access
            </a>
          </p>
        </div>

        {/* Feature hints — only visible on the initial state so the user can
            focus once the flow progresses. */}
        {resolved.kind === "idle" && !emailLocked && (
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
                className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-md bg-tint border border-border-dim"
              >
                <svg className="w-5 h-5 text-accent/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                </svg>
                <span className="text-[10px] text-tertiary tracking-wider uppercase">{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
