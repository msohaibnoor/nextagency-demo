import { HealthController } from "./health.controller";

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
});
