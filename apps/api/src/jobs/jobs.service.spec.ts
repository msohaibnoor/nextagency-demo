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
    expect(jobs[0].opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    expect(jobs[0].data.failRate).toBe(0.5);
  });

  it("seeds the rate-limited queue when asked", async () => {
    await svc.seed({ count: 2, queue: "rate-limited-sync" });
    expect(sync.addBulk).toHaveBeenCalled();
  });

  it("builds a nested report flow gather -> render -> email -> parent", async () => {
    const id = await svc.report({ agencyId: "a1", month: "2026-09" });
    expect(id).toBe("parent-1");
    const tree = flow.add.mock.calls[0][0];
    expect(tree.name).toBe("report");
    expect(tree.children[0].name).toBe("email");
    expect(tree.children[0].children[0].name).toBe("render");
    expect(tree.children[0].children[0].children[0].name).toBe("gather");
  });

  it("returns stats keyed by queue name", async () => {
    const s = await svc.stats();
    expect(Object.keys(s).sort()).toEqual(["nightly-sweep", "rate-limited-sync", "renewal-reminders", "reports"]);
  });
});
