import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { ALL_QUEUES, QUEUES } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";

@Processor(QUEUES.nightlySweep, { concurrency: 1 })
export class SweepProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job) {
    const counts = Object.fromEntries(await Promise.all(ALL_QUEUES.map(async (q) => [q, await this.results.count(q)])));
    log("sweep", { jobId: job.id, resultCounts: counts });
    return counts;
  }
}
