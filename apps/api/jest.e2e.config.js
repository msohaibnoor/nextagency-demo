// forceExit: true — the api's BullModule/ioredis connections (and the worker's
// NestApplicationContext, created directly via NestFactory rather than through
// a testing harness that tears down all handles) keep the event loop alive
// after api.close()/worker.close() resolve; the suite's assertions pass in
// ~3.6s but the process otherwise hangs waiting for those sockets. This does
// not affect the pass/fail outcome, only whether jest exits promptly.
module.exports = {
  preset: "ts-jest", testEnvironment: "node", rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$", testTimeout: 30000, forceExit: true,
};
