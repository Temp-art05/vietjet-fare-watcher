/** @type {import('next').NextConfig} */
const config = {
  // Playwright and the SQLite driver are native/CJS packages that must not be
  // bundled into the server build.
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
  ],
};

export default config;
