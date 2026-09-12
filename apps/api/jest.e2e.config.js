// forceExit: true — the api's BullModule/ioredis connections (and the worker's
// NestApplicationContext, created directly via NestFactory rather than through
// a testing harness that tears down all handles) keep the event loop alive
// after api.close()/worker.close() resolve; the suite's assertions pass in
// ~3.6s but the process otherwise hangs waiting for those sockets. This does
// not affect the pass/fail outcome, only whether jest exits promptly.
module.exports = {
  preset: "ts-jest", testEnvironment: "node", rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$", testTimeout: 30000, forceExit: true,
  // No dotenv loading happens for jest runs (only main.ts imports
  // "dotenv/config"), and @demo/queue's redisConnectionOptions(process.env)
  // runs at module-import time inside the spec file — so REDIS_URL must be
  // set before that module graph is required, which is exactly what a
  // setupFiles script guarantees (it runs before the test file is loaded).
  setupFiles: ["<rootDir>/test/setup-env.js"],
};
