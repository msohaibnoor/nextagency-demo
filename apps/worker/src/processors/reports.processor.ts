import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type ReportJob, type ReportStepJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";
import { composeStep } from "./reports.logic";
import { sleep } from "./reminders.logic";

@Processor(QUEUES.reports, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<ReportJob | ReportStepJob>) {
    await sleep(300);
    const childValues = Object.values(await job.getChildrenValues());
    const summary = job.name === "report"
      ? `report for ${job.data.agencyId}/${job.data.month} done: ${childValues.join(" | ")}`
      : composeStep((job.data as ReportStepJob).step, childValues);
    await this.results.record(QUEUES.reports, {
      jobId: String(job.id), queue: QUEUES.reports, finishedAt: new Date().toISOString(), summary,
    });
    return summary;
  }

  @OnWorkerEvent("completed") onCompleted(job: Job) { log("completed", { queue: QUEUES.reports, jobId: job.id, name: job.name }); }
  @OnWorkerEvent("failed") onFailed(job: Job | undefined, err: Error) { log("failed", { queue: QUEUES.reports, jobId: job?.id, error: err.message }); }
}
