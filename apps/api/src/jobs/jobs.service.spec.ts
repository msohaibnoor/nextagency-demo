import { JobsService } from "./jobs.service";

const mkQueue = () => ({
  addBulk: jest.fn(async (jobs: unknown[]) => jobs.map((_, i) => ({ id: String(i + 1) }))),
  getJobCounts: jest.fn(async () => ({ waiting: 1, active: 0, completed: 2, failed: 0, delayed: 0 })),
  getJob: jest.fn(),
  upsertJobScheduler: jest.fn(),
  name: "q",
});

describe("JobsService", () => {
  const reminders = mkQueue(), reports = mkQueue(), sweep = mkQueue(), sync = mkQueue();
  const flow = { add: jest.fn(async () => ({ job: { id: "parent-1" } })) };
  const svc = new JobsService(reminders as never, reports as never, sweep as never, sync as never, flow as never);

  it("seeds N reminder jobs with retry options", async () => {
    const ids = await svc.seed({ count: 3, failRate: 0.5 });
    expect(ids).toEqual(["1", "2", "3"]);
    const [jobs] = reminders.addBulk.mock.calls[0];
    expect(jobs).toHaveLength(3);
    // @ts-expect-error TS2571: brief's addBulk mock types its arg as unknown[], so jobs[0] is `unknown` here.
    expect(jobs[0].opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    // @ts-expect-error TS2571: brief's addBulk mock types its arg as unknown[], so jobs[0] is `unknown` here.
    expect(jobs[0].data.failRate).toBe(0.5);
  });

  it("seeds the rate-limited queue when asked", async () => {
    await svc.seed({ count: 2, queue: "rate-limited-sync" });
    expect(sync.addBulk).toHaveBeenCalled();
  });

  it("builds a nested report flow gather -> render -> email -> parent", async () => {
    const id = await svc.report({ agencyId: "a1", month: "2026-09" });
    expect(id).toBe("parent-1");
    // @ts-expect-error TS2493: brief's flow.add mock has a zero-arg signature, so mock.calls[0] is typed `[]`.
    const tree = flow.add.mock.calls[0][0];
    // @ts-expect-error TS18048: `tree`'s inferred type includes undefined per the mock signature above.
    expect(tree.name).toBe("report");
    // @ts-expect-error TS18048: `tree`'s inferred type includes undefined per the mock signature above.
    expect(tree.children[0].name).toBe("email");
    // @ts-expect-error TS18048: `tree`'s inferred type includes undefined per the mock signature above.
    expect(tree.children[0].children[0].name).toBe("render");
    // @ts-expect-error TS18048: `tree`'s inferred type includes undefined per the mock signature above.
    expect(tree.children[0].children[0].children[0].name).toBe("gather");
  });

  it("bounds retention on every node of the report flow", async () => {
    await svc.report({ agencyId: "a1", month: "2026-09" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = (flow.add.mock.calls as any[][])[0][0];
    const email = tree.children[0], render = email.children[0], gather = render.children[0];
    for (const node of [tree, email, render, gather]) expect(node.opts).toEqual({ removeOnComplete: 20 });
  });

  it("registers the sweep scheduler with a bounded-retention template", async () => {
    await svc.ensureSweepScheduler();
    expect(sweep.upsertJobScheduler).toHaveBeenCalledWith(
      "nightly-sweep", { pattern: "*/5 * * * *" }, { name: "sweep", data: {}, opts: { removeOnComplete: 20 } },
    );
  });

  it("returns stats keyed by queue name", async () => {
    const s = await svc.stats();
    expect(Object.keys(s).sort()).toEqual(["nightly-sweep", "rate-limited-sync", "renewal-reminders", "reports"]);
  });

  describe("get", () => {
    it("resolves null for an unknown queue name", async () => {
      expect(await svc.get("bogus-queue" as never, "1")).toBeNull();
    });

    it("resolves null when the job is not found", async () => {
      reminders.getJob.mockResolvedValueOnce(undefined);
      expect(await svc.get("renewal-reminders", "999")).toBeNull();
    });

    it("resolves the job summary when found", async () => {
      reminders.getJob.mockResolvedValueOnce({
        id: "7", name: "remind", attemptsMade: 1, returnvalue: "ok", failedReason: undefined,
        data: { policyId: "p" }, getState: async () => "completed",
      });
      expect(await svc.get("renewal-reminders", "7")).toEqual({
        id: "7", name: "remind", state: "completed", attemptsMade: 1,
        returnvalue: "ok", failedReason: undefined, data: { policyId: "p" },
      });
    });
  });
});
