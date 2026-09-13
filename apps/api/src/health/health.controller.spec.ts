import { HealthController, PING_TIMEOUT_MS } from "./health.controller";

describe("HealthController", () => {
  it("reports redis up when ping succeeds", async () => {
    const redis = { ping: jest.fn().mockResolvedValue("PONG") };
    const c = new HealthController(redis as never);
    await expect(c.check()).resolves.toEqual({ ok: true, redis: "up" });
  });

  it("reports redis down when ping throws", async () => {
    const redis = { ping: jest.fn().mockRejectedValue(new Error("nope")) };
    const c = new HealthController(redis as never);
    await expect(c.check()).resolves.toEqual({ ok: false, redis: "down" });
  });

  it("reports redis down when ping never resolves (times out)", async () => {
    jest.useFakeTimers();
    try {
      const redis = { ping: jest.fn(() => new Promise(() => {})) }; // hangs forever
      const c = new HealthController(redis as never);
      const result = c.check();
      await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
      await expect(result).resolves.toEqual({ ok: false, redis: "down" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("times out within ~1s on a real clock", async () => {
    const redis = { ping: jest.fn(() => new Promise(() => {})) };
    const c = new HealthController(redis as never);
    const started = Date.now();
    await expect(c.check()).resolves.toEqual({ ok: false, redis: "down" });
    expect(Date.now() - started).toBeLessThan(1500);
  }, 1500);
});
