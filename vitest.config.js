import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // readD1Migrations reads every file in migrations/ (schema + seed + members),
      // so tests run against the real schema with seed data present.
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only env. Real secrets are never needed here.
            SIGNING_SECRET: "test-signing-secret-0123456789",
            STRIPE_SECRET_KEY: "sk_test_dummy",
            STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
            STRIPE_API_BASE: "https://stripe.test.invalid", // outbound Stripe calls are mocked in tests
            PUBLIC_ORIGIN: "https://cleantech.test",
            MEMBER_TOKEN_TTL_DAYS: "365",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"],
  },
});
