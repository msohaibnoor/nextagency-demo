import { ResultsStore } from "./results.store";
import type { JobResult } from "@demo/queue";

describe("ResultsStore", () => {
  it("records a result via ZADD + ZREMRANGEBYRANK in one multi", async () => {
    const multi = {
      zadd: jest.fn().mockReturnThis(),
      zremrangebyrank: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const redis = { multi: jest.fn().mockReturnValue(multi) };
    const store = new ResultsStore(redis as never);

    const result: JobResult = {
      jobId: "42",
      queue: "renewal-reminders",
      finishedAt: "2026-09-12T00:00:00.000Z",
      summary: "Reminder sent for pol-1 (agency-1) renewing 2026-10-01",
    };
    await store.record("renewal-reminders", result);

    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(multi.zadd).toHaveBeenCalledWith(
      "results:renewal-reminders",
      expect.any(Number),
      JSON.stringify(result),
    );
    expect(multi.zremrangebyrank).toHaveBeenCalledWith("results:renewal-reminders", 0, -1001);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("counts via ZCARD", async () => {
    const redis = { zcard: jest.fn().mockResolvedValue(7) };
    const store = new ResultsStore(redis as never);

    await expect(store.count("renewal-reminders")).resolves.toBe(7);
    expect(redis.zcard).toHaveBeenCalledWith("results:renewal-reminders");
  });
});
