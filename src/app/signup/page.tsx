"use client";

import Link from "next/link";

/**
 * Post-SSO-rollout signup page.
 *
 * Self-serve email/password signup is retired: new users must be invited
 * via a company's registered SSO domain, or the Rabbit Hole admin has to
 * register a new company. Sending casual visitors to a mailto: is the
 * simplest path that keeps the support queue clean.
 */
export default function SignupPage() {
  const mailto =
    "mailto:support@rabbitholesystems.com?subject=Request%20access%20to%20Door%20Hardware%20Tracker" +
    "&body=Hi%2C%20I%27d%20like%20to%20request%20access%20for%20my%20company.%20%0A%0ACompany%20name%3A%20%0ACorporate%20email%20domain%3A%20%0A";

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

      <div className="w-full max-w-[460px] relative z-10">
        <div className="text-center mb-6">
          <h1
            className="text-2xl sm:text-3xl font-bold text-primary mb-2 tracking-tight"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.06em" }}
          >
            RABBIT HOLE
          </h1>
        </div>

        <div className="panel corner-brackets p-6 sm:p-8">
          <h2 className="text-[18px] font-semibold text-primary mb-3">
            Your company must be registered.
          </h2>
          <p className="text-secondary text-[14px] leading-relaxed mb-6">
            Door Hardware Tracker is provisioned per company. Ask your internal admin to
            invite you, or drop us a line and we&apos;ll onboard your company.
          </p>

          <a
            href={mailto}
            className="glow-btn--primary w-full rounded py-3 text-[14px] font-semibold tracking-wide block text-center"
          >
            Request access
          </a>
        </div>

        <p className="mt-6 text-center text-tertiary text-[13px]">
          Already have an account?{" "}
          <Link href="/" className="text-accent hover:text-accent/80 font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
