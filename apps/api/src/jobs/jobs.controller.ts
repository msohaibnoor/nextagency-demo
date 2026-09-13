import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { QUEUES, type QueueName } from "@demo/queue";
import { JobsService } from "./jobs.service";
import type { ReportDto, SeedDto } from "./seed.dto";

// Only these two queues have a producer-side seed shape; `reports` is fed by
// the flow endpoint and `nightly-sweep` by its scheduler.
export const SEEDABLE_QUEUES: readonly QueueName[] = [QUEUES.renewalReminders, QUEUES.rateLimitedSync];
export const MAX_SEED_COUNT = 5000;

@Controller("api/jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post("seed")
  async seed(@Body() body: SeedDto) {
    // Bound untrusted input: NaN/negative → 0, > MAX → MAX, failRate ∈ [0, 1].
    const count = Math.min(Math.max(Math.trunc(Number(body.count ?? 50)) || 0, 0), MAX_SEED_COUNT);
    const failRate = Math.min(Math.max(Number(body.failRate ?? 0.2) || 0, 0), 1);
    const queue = body.queue ?? QUEUES.renewalReminders;
    if (!SEEDABLE_QUEUES.includes(queue)) {
      throw new BadRequestException(`queue must be one of: ${SEEDABLE_QUEUES.join(", ")}`);
    }
    const ids = await this.jobs.seed({ count, failRate, queue });
    return { enqueued: ids.length, ids };
  }

  @Post("report")
  async report(@Body() body: ReportDto) {
    return { parentId: await this.jobs.report(body) };
  }

  @Get("stats")
  stats() {
    return this.jobs.stats();
  }

  @Get(":queue/:id")
  async get(@Param("queue") queue: QueueName, @Param("id") id: string) {
    const job = await this.jobs.get(queue, id);
    if (!job) throw new NotFoundException();
    return job;
  }
}
