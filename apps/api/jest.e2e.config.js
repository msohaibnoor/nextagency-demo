// No forceExit: every Redis connection the suite opens is closed by a Nest
// shutdown hook (RedisClient.onApplicationShutdown for the plain ioredis
// clients, @nestjs/bullmq for its queues/workers), so api.close() and
// worker.close() leave nothing holding the event loop open.
module.exports = {
  preset: "ts-jest", testEnvironment: "node", rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$", testTimeout: 30000,
  // No dotenv loading happens for jest runs (only main.ts imports
  // "dotenv/config"), and AppModule/WorkerModule call
  // BullModule.forRoot({ connection: redisConnectionOptions(process.env) })
  // as a decorator argument — evaluated at import time, when the module
  // class itself is defined, not when it's instantiated. The spec file
  // imports both modules, so REDIS_URL must already be set before those
  // imports run, which is exactly what a setupFiles script guarantees (it
  // runs before the test file is loaded).
  setupFiles: ["<rootDir>/test/setup-env.js"],
};
