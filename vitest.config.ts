import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tests/** covers the RLS isolation suite invoked by the rls-tenancy
    // CI job against a live Supabase (see .github/workflows/ci.yml).
    // Those tests skip themselves when RLS_TEST_* env vars are absent,
    // so they cost nothing locally and add real coverage in CI.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
