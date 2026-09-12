import { redisConnectionOptions } from "./connection";

describe("redisConnectionOptions", () => {
  it("parses a plain redis:// url", () => {
    expect(redisConnectionOptions({ REDIS_URL: "redis://localhost:6379" })).toEqual({
      host: "localhost", port: 6379, maxRetriesPerRequest: null,
    });
  });
  it("adds tls and password for rediss://", () => {
    expect(redisConnectionOptions({ REDIS_URL: "rediss://:s3cret@cache.example.com:6379" })).toEqual({
      host: "cache.example.com", port: 6379, password: "s3cret", tls: {}, maxRetriesPerRequest: null,
    });
  });
  it("throws when REDIS_URL is missing", () => {
    expect(() => redisConnectionOptions({})).toThrow("REDIS_URL is required");
  });
});
