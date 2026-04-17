"use client";

import { useState, FormEvent, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { playClick, playSuccess } from "@/lib/sounds";

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
    playClick();

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

      playSuccess();
      setSuccess(true);
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-tint border border-border-dim rounded-md shadow-xl p-6 md:p-8 text-center">
            <div className="mb-4 text-success text-4xl">✓</div>
            <h2 className="text-2xl font-bold text-primary mb-2">
              Check your email
            </h2>
            <p className="text-secondary mb-6">
              We&apos;ve sent a confirmation link to {email}. Please check your email
              to verify your account.
            </p>
            <Link
              href="/"
              className="text-accent hover:text-accent/80 font-medium"
            >
              Back to login
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1
            className="text-3xl md:text-4xl font-bold text-primary mb-2"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.04em" }}
          >
            CREATE ACCOUNT
          </h1>
          <p className="text-secondary">
            Join Door Hardware Tracker
          </p>
        </div>

        <form
          onSubmit={handleSignup}
          className="panel corner-brackets p-6 md:p-8"
        >
          {error && (
            <div className="mb-4 p-3 bg-danger-dim border border-danger rounded-lg text-danger text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label
              htmlFor="fullName"
              className="block text-sm font-medium text-primary mb-2"
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
              className="input-field"
            />
          </div>

          <div className="mb-4">
            <label
              htmlFor="email"
              className="block text-sm font-medium text-primary mb-2"
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
              className="block text-sm font-medium text-primary mb-2"
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
            className="w-full glow-btn--primary"
          >
            {loading ? "Creating account..." : "Sign Up"}
          </button>
        </form>

        <div className="mt-6 text-center space-y-2">
          <p className="text-secondary text-sm">
            Already have an account?{" "}
            <Link
              href="/"
              className="text-accent hover:text-accent/80 font-medium"
            >
              Sign in
            </Link>
          </p>
          <p className="text-muted-foreground text-xs">
            By signing up, you agree to our{" "}
            <Link href="/terms" className="underline hover:text-foreground/80">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline hover:text-foreground/80">
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
