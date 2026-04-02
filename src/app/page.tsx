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
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-black flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-[#f5f5f7] mb-2">
            Door Hardware Tracker
          </h1>
          <p className="text-[#a1a1a6]">
            Track door hardware installations in real-time
          </p>
        </div>

        <form
          onSubmit={handleLogin}
          className="bg-white/[0.04] border border-white/[0.08] rounded-xl shadow-xl p-6 md:p-8"
        >
          {error && (
            <div className="mb-4 p-3 bg-[#ff453a]/20 border border-[#ff453a]/40 rounded-lg text-[#ff453a] text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label
              htmlFor="email"
              className="block text-sm font-medium text-[#f5f5f7] mb-2"
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
              className="w-full px-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:outline-none focus:border-[rgba(10,132,255,0.3)]"
            />
          </div>

          <div className="mb-6">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-[#f5f5f7] mb-2"
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
              className="w-full px-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:outline-none focus:border-[rgba(10,132,255,0.3)]"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/90 disabled:bg-white/[0.08] disabled:text-[#6e6e73] text-[#f5f5f7] font-medium rounded-lg transition-colors"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-[#a1a1a6] text-sm">
            Don't have an account?{" "}
            <a
              href="/signup"
              className="text-[#0a84ff] hover:text-[#0a84ff]/80 font-medium"
            >
              Sign up
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
