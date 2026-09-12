module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  // TS2571/TS2493/TS18048: the brief's verbatim jobs.service.spec.ts mocks
  // (untyped jest.fn() arg/return shapes) trip these under strict mode even
  // though the runtime behavior is correct; narrowly ignored here rather
  // than disabling diagnostics for all spec files.
  transform: { "^.+\\.ts$": ["ts-jest", { diagnostics: { ignoreCodes: [2571, 2493, 18048] } }] },
};
