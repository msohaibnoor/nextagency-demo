import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type RenewalReminderJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";
import { shouldFail, sleep, summarize } from "./reminders.logic";

@Processor(QUEUES.renewalReminders, { concurrency: 5 })
export class RemindersProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<RenewalReminderJob>) {
    await sleep(100 + Math.random() * 400);
    if (shouldFail(job.data.failRate)) throw new Error(`simulated failure for ${job.data.policyId}`);
    const summary = summarize(job.data);
    await this.results.record(QUEUES.renewalReminders, {
      jobId: String(job.id), queue: QUEUES.renewalReminders, finishedAt: new Date().toISOString(), summary,
    });
    return summary;
  }

  @OnWorkerEvent("completed") onCompleted(job: Job) { log("completed", { queue: QUEUES.renewalReminders, jobId: job.id }); }
  @OnWorkerEvent("failed") onFailed(job: Job | undefined, err: Error) {
    log("failed", { queue: QUEUES.renewalReminders, jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  }
}
