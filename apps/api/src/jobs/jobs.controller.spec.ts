import { BadRequestException } from "@nestjs/common";
import { JobsController, MAX_SEED_COUNT } from "./jobs.controller";

describe("JobsController.seed input bounds", () => {
  const seed = jest.fn(async ({ count }: { count: number }) => Array.from({ length: count }, (_, i) => String(i + 1)));
  const c = new JobsController({ seed } as never);
  beforeEach(() => seed.mockClear());

  it("clamps count above 5000 down to 5000", async () => {
    await c.seed({ count: 999_999 });
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({ count: MAX_SEED_COUNT }));
  });

  it("clamps a negative count to 0", async () => {
    const res = await c.seed({ count: -7 });
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({ count: 0 }));
    expect(res.enqueued).toBe(0);
  });

  it("treats NaN / non-numeric count as 0 and truncates fractions", async () => {
    await c.seed({ count: "abc" as never });
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({ count: 0 }));
    await c.seed({ count: 2.9 });
    expect(seed).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2 }));
  });

  it("applies defaults when fields are omitted", async () => {
    await c.seed({});
    expect(seed).toHaveBeenCalledWith({ count: 50, failRate: 0.2, queue: "renewal-reminders" });
  });

  it("clamps failRate into [0, 1] and maps NaN to 0", async () => {
    await c.seed({ failRate: 7 });
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({ failRate: 1 }));
    await c.seed({ failRate: -1 });
    expect(seed).toHaveBeenLastCalledWith(expect.objectContaining({ failRate: 0 }));
    await c.seed({ failRate: "x" as never });
    expect(seed).toHaveBeenLastCalledWith(expect.objectContaining({ failRate: 0 }));
  });

  it("rejects an unknown queue with 400", async () => {
    await expect(c.seed({ queue: "bogus" as never })).rejects.toBeInstanceOf(BadRequestException);
    expect(seed).not.toHaveBeenCalled();
  });

  it("rejects a real but non-seedable queue with 400", async () => {
    await expect(c.seed({ queue: "reports" })).rejects.toBeInstanceOf(BadRequestException);
    expect(seed).not.toHaveBeenCalled();
  });

  it("accepts the rate-limited queue", async () => {
    await c.seed({ count: 1, queue: "rate-limited-sync" });
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({ queue: "rate-limited-sync" }));
  });
});
