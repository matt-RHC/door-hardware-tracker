import type { NextConfig } from "next";

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

export default nextConfig;
