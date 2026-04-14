import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Pass server-side env vars explicitly (Turbopack doesn't auto-expose .env.local to runtime)
  // NOTE: Do NOT add server-only env vars here (ANTHROPIC_API_KEY,
  // SUPABASE_SERVICE_ROLE_KEY, PYTHON_API_URL, etc.). The `env` block
  // bakes values into the client bundle at build time, and any var that
  // is unset becomes the string "" rather than undefined. That breaks
  // ?? (nullish coalescing) guards in API routes because "" is truthy
  // for ?? — so the fallback chain never runs. Server route handlers
  // read process.env at runtime directly and do not need this block.
  env: {},
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default withSentryConfig(nextConfig, {
  // Suppress source map upload warnings when SENTRY_AUTH_TOKEN is not set
  // (e.g., local development). Source maps still work in Sentry if the
  // token is configured in Vercel.
  silent: !process.env.SENTRY_AUTH_TOKEN,

  // Upload a wider set of client files for better stack traces
  widenClientFileUpload: true,

  // Source map configuration: delete after upload so they aren't served to users
  sourcemaps: {
    filesToDeleteAfterUpload: [".next/static/**/*.map"],
  },

  // Automatically instrument API routes and server components
  autoInstrumentServerFunctions: true,

  // Tree-shake Sentry debug logger in production
  disableLogger: true,
});
