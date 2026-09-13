import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type RateLimitedSyncJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";

// 5 jobs per 10 seconds, across all worker instances (limiter is enforced in Redis)
@Processor(QUEUES.rateLimitedSync, { concurrency: 5, limiter: { max: 5, duration: 10_000 } })
export class SyncProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<RateLimitedSyncJob>) {
    const summary = `synced ${job.data.carrierId}`;
    await this.results.record(QUEUES.rateLimitedSync, {
      jobId: String(job.id), queue: QUEUES.rateLimitedSync, finishedAt: new Date().toISOString(), summary,
    });
    return summary;
  }

  @OnWorkerEvent("completed") onCompleted(job: Job) { log("completed", { queue: QUEUES.rateLimitedSync, jobId: job.id }); }
  @OnWorkerEvent("failed") onFailed(job: Job | undefined, err: Error) {
    log("failed", { queue: QUEUES.rateLimitedSync, jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  }
}
