import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// API tests run the route handlers in-process against CHAIN_MODE=fake and a separate SQLite DB.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      CHAIN_MODE: "fake",
      DATABASE_URL: "file:./test.db",
      FS_API_TOKEN: "test-token",
      PUBLIC_APP_URL: "http://localhost:3000",
    },
    fileParallelism: false,
  },
});
