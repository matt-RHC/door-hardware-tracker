"use client";

import { useState, FormEvent, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSignup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
          },
        },
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen w-full bg-black flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl shadow-xl p-6 md:p-8 text-center">
            <div className="mb-4 text-[#30d158] text-4xl">✓</div>
            <h2 className="text-2xl font-bold text-[#f5f5f7] mb-2">
              Check your email
            </h2>
            <p className="text-[#a1a1a6] mb-6">
              We've sent a confirmation link to {email}. Please check your email
              to verify your account.
            </p>
            <a
              href="/"
              className="text-[#0a84ff] hover:text-[#0a84ff]/80 font-medium"
            >
              Back to login
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-black flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-[#f5f5f7] mb-2">
            Create Account
          </h1>
          <p className="text-[#a1a1a6]">
            Join Door Hardware Tracker
          </p>
        </div>

        <form
          onSubmit={handleSignup}
          className="bg-white/[0.04] border border-white/[0.08] rounded-xl shadow-xl p-6 md:p-8"
        >
          {error && (
            <div className="mb-4 p-3 bg-[#ff453a]/20 border border-[#ff453a]/40 rounded-lg text-[#ff453a] text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label
              htmlFor="fullName"
              className="block text-sm font-medium text-[#f5f5f7] mb-2"
            >
              Full Name
            </label>
            <input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setFullName(e.target.value)
              }
              placeholder="John Doe"
              required
              className="w-full px-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:outline-none focus:border-[rgba(10,132,255,0.3)]"
            />
          </div>

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
            {loading ? "Creating account..." : "Sign Up"}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-[#a1a1a6] text-sm">
            Already have an account?{" "}
            <a
              href="/"
              className="text-[#0a84ff] hover:text-[#0a84ff]/80 font-medium"
            >
              Sign in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
