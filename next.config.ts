import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pass server-side env vars explicitly (Turbopack doesn't auto-expose .env.local to runtime)
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    PYTHON_API_URL: process.env.PYTHON_API_URL ?? "",
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
