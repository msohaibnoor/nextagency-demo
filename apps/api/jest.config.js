module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { diagnostics: { warnOnly: false, exclude: ["**/*.spec.ts"] } }] },
};
