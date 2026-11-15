import { defineConfig } from "vitest/config";

// Database tests start a local PostgreSQL, so they run separately: npm run test:db
export default defineConfig({
  test: {
    include: ["supabase/tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
