import path from "node:path";
import { defineConfig } from "prisma/config";

// CLI-only config. The runtime driver adapter lives in lib/prisma.ts.
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: { path: path.join("prisma", "migrations") },
  datasource: { url: process.env.DATABASE_URL ?? "file:./prisma/dev.db" },
});
