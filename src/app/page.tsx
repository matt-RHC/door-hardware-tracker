"use client";

import { useState, FormEvent, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

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
      className="min-h-screen w-full flex items-center justify-center px-4 py-12 relative overflow-hidden"
      style={{ background: "var(--background)" }}
    >
      {/* Background grid effect */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(90,200,250,0.3) 1px, transparent 1px),
            linear-gradient(90deg, rgba(90,200,250,0.3) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />

      {/* Radial glow behind form */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(90,200,250,0.04) 0%, transparent 70%)",
        }}
      />

      <div className="w-full max-w-md relative z-10">
        {/* Brand header */}
        <div className="text-center mb-8">
          {/* Logo mark */}
          <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-[rgba(90,200,250,0.06)] border border-[rgba(90,200,250,0.15)] flex items-center justify-center">
            <svg
              className="w-7 h-7 text-[#5ac8fa]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
          </div>
          <h1
            className="text-2xl sm:text-3xl font-bold text-[#e8e8ed] mb-1"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.04em" }}
          >
            RABBIT HOLE
          </h1>
          <p className="text-[13px] text-[#636366] tracking-wider uppercase">
            Door Hardware Systems
          </p>
        </div>

        {/* Login form */}
        <form
          onSubmit={handleLogin}
          className="panel corner-brackets p-6 sm:p-7 animate-fade-in-up"
        >
          {error && (
            <div className="mb-4 p-3 bg-[rgba(255,69,58,0.08)] border border-[rgba(255,69,58,0.15)] rounded-lg text-[#ff453a] text-[13px] flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              {error}
            </div>
          )}

          <div className="mb-4">
            <label
              htmlFor="email"
              className="block text-[12px] text-[#8e8e93] mb-1.5 uppercase tracking-wider"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setEmail(e.target.value)
              }
              placeholder="you@example.com"
              required
              className="input-field"
            />
          </div>

          <div className="mb-6">
            <label
              htmlFor="password"
              className="block text-[12px] text-[#8e8e93] mb-1.5 uppercase tracking-wider"
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
              placeholder="••••••••"
              required
              className="input-field"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="glow-btn--primary w-full rounded-lg disabled:opacity-40 disabled:cursor-not-allowed py-2.5"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Authenticating...
              </span>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <div className="mt-5 text-center">
          <p className="text-[#636366] text-[13px]">
            Don&apos;t have an account?{" "}
            <a
              href="/signup"
              className="text-[#5ac8fa] hover:text-[#5ac8fa]/80 font-medium transition-colors"
            >
              Sign up
            </a>
          </p>
        </div>

        {/* Version tag */}
        <p className="text-center mt-8 text-[10px] text-[#636366]/50 tracking-widest uppercase">
          v0.29 // Rabbit Hole Systems
        </p>
      </div>
    </div>
  );
}
