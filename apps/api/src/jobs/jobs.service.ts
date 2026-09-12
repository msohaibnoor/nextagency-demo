import { Injectable } from "@nestjs/common";
import { InjectFlowProducer, InjectQueue } from "@nestjs/bullmq";
import { FlowProducer, Queue } from "bullmq";
import {
  ALL_QUEUES, QUEUES, type QueueName, type RateLimitedSyncJob, type RenewalReminderJob, type ReportJob,
} from "@demo/queue";
import type { ReportDto, SeedDto } from "./seed.dto";

export const REPORT_FLOW = "report-flow";

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue(QUEUES.renewalReminders) private readonly reminders: Queue<RenewalReminderJob>,
    @InjectQueue(QUEUES.reports) private readonly reports: Queue,
    @InjectQueue(QUEUES.nightlySweep) private readonly sweep: Queue,
    @InjectQueue(QUEUES.rateLimitedSync) private readonly sync: Queue<RateLimitedSyncJob>,
    @InjectFlowProducer(REPORT_FLOW) private readonly flow: FlowProducer,
  ) {}

  private byName(): Record<QueueName, Queue> {
    return {
      [QUEUES.renewalReminders]: this.reminders as Queue,
      [QUEUES.reports]: this.reports,
      [QUEUES.nightlySweep]: this.sweep,
      [QUEUES.rateLimitedSync]: this.sync as Queue,
    };
  }

  async seed({ count = 50, failRate = 0.2, queue = QUEUES.renewalReminders }: SeedDto): Promise<string[]> {
    const opts = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 };
    if (queue === QUEUES.rateLimitedSync) {
      const jobs = Array.from({ length: count }, (_, i) => ({
        name: "sync", data: { carrierId: `carrier-${i + 1}` }, opts,
      }));
      return (await this.sync.addBulk(jobs)).map((j) => String(j.id));
    }
    const jobs = Array.from({ length: count }, (_, i) => ({
      name: "remind",
      data: {
        policyId: `pol-${i + 1}`, agencyId: `agency-${(i % 5) + 1}`,
        renewalDate: new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10), failRate,
      },
      opts,
    }));
    return (await this.reminders.addBulk(jobs)).map((j) => String(j.id));
  }

  async report({ agencyId = "agency-1", month = new Date().toISOString().slice(0, 7) }: ReportDto): Promise<string> {
    const base: ReportJob = { agencyId, month };
    const q = QUEUES.reports;
    const tree = await this.flow.add({
      name: "report", queueName: q, data: base,
      children: [{
        name: "email", queueName: q, data: { ...base, step: "email" },
        children: [{
          name: "render", queueName: q, data: { ...base, step: "render" },
          children: [{ name: "gather", queueName: q, data: { ...base, step: "gather" } }],
        }],
      }],
    });
    return String(tree.job.id);
  }

  async stats() {
    const entries = await Promise.all(
      ALL_QUEUES.map(async (name) => [name, await this.byName()[name].getJobCounts()] as const),
    );
    return Object.fromEntries(entries) as Record<QueueName, Awaited<ReturnType<Queue["getJobCounts"]>>>;
  }

  async get(queue: QueueName, id: string) {
    const q = this.byName()[queue];
    if (!q) return null;
    const job = await q.getJob(id);
    if (!job) return null;
    return {
      id: job.id, name: job.name, state: await job.getState(), attemptsMade: job.attemptsMade,
      returnvalue: job.returnvalue, failedReason: job.failedReason, data: job.data,
    };
  }

  async ensureSweepScheduler() {
    await this.sweep.upsertJobScheduler("nightly-sweep", { pattern: "*/5 * * * *" }, { name: "sweep", data: {} });
  }
}
