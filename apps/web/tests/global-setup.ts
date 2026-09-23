import { execSync } from "node:child_process";

export default function setup() {
  execSync("pnpm exec prisma migrate reset --force --skip-generate --skip-seed", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "file:./test.db", PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
  });
}
