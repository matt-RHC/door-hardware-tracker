"use client";

import { useEffect, useMemo } from "react";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/**
 * Post-OAuth dead end for users whose email domain isn't registered to
 * any company. This is NOT the pre-auth "unknown" path — that renders
 * inline on /. This page is only reachable from /api/auth/callback after
 * a successful OAuth exchange that can't be resolved to a company.
 *
 * The primary CTA is a pre-filled mailto: so the dead end converts into
 * a qualified lead for admin-side onboarding.
 */
export default function NoCompanyPage() {
  const searchParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const domain = searchParams?.get("d") ?? "";

  // Rescue attempt: if an admin registered the user's domain after the
  // initial OAuth exchange, try_domain_auto_join will insert the
  // company_members row + stamp app_metadata.company_id. We then refresh
  // the session so the new claim is on the JWT before /dashboard loads,
  // and bounce. Idempotent and short-circuits when membership already
  // exists. Runs in its own effect so a Sentry failure doesn't suppress
  // the rescue and vice versa.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = createClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: companyId } = await (sb as any).rpc("try_domain_auto_join");
        if (cancelled || !companyId) return;
        // Best-effort JWT refresh. If it fails, redirect anyway — the
        // middleware DB-fallback path will catch the membership at the
        // cost of one extra round-trip, never a lockout.
        try {
          await sb.auth.refreshSession();
        } catch {
          // swallow
        }
        window.location.replace("/dashboard");
      } catch {
        // Silent — fall through to the dead-end UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Log domain only — never email or user_id. Correlation ID goes
    // into the mailto so support can link the lead to the Sentry event.
    try {
      Sentry.captureMessage("auth.no_company", {
        level: "info",
        tags: { domain: domain || "unknown" },
      });
    } catch {
      // Sentry optional — never block the UI.
    }
  }, [domain]);

  const mailto = useMemo(() => {
    const subject = encodeURIComponent(
      `Register ${domain || "my company"} with Rabbit Hole Systems`,
    );
    const body = encodeURIComponent(
      [
        "Hi Rabbit Hole Systems team,",
        "",
        `I just tried to sign in with an email on the ${domain || "(unknown)"} domain,`,
        "but it isn't registered to a workspace yet. Please set up access for our company.",
        "",
        "Context for your records:",
        `- Domain: ${domain || "(unknown)"}`,
        `- Timestamp: ${new Date().toISOString()}`,
        "",
        "Thanks!",
      ].join("\n"),
    );
    return `mailto:support@rabbitholesystems.com?subject=${subject}&body=${body}`;
  }, [domain]);

  async function onSignOut() {
    try {
      await createClient().auth.signOut();
    } catch {
      // Ignore — we'll redirect either way.
    }
    window.location.href = "/";
  }

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
            We don&apos;t recognize your workspace yet.
          </h2>
          <p className="text-secondary text-[14px] leading-relaxed mb-6">
            Your email address is on the{" "}
            <code className="px-1.5 py-0.5 rounded bg-tint border border-border-dim text-primary text-[13px]">
              {domain || "(unknown)"}
            </code>{" "}
            domain, which hasn&apos;t been registered with Rabbit Hole Systems. Your admin
            can add this domain, or you can request access below.
          </p>

          <a href={mailto} className="glow-btn--primary w-full rounded py-3 text-[14px] font-semibold tracking-wide block text-center">
            Request access for {domain || "this domain"}
          </a>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={onSignOut}
              className="text-[12px] text-tertiary hover:text-secondary underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-tertiary text-[12px]">
          Need the main login page instead?{" "}
          <Link href="/" className="text-accent hover:text-accent/80">
            Go back
          </Link>
        </p>
      </div>
    </div>
  );
}
