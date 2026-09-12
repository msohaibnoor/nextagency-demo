import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import type { QueueName } from "@demo/queue";
import { JobsService } from "./jobs.service";
import type { ReportDto, SeedDto } from "./seed.dto";

@Controller("api/jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post("seed")
  async seed(@Body() body: SeedDto) {
    const ids = await this.jobs.seed({
      count: body.count !== undefined ? Number(body.count) : undefined,
      failRate: body.failRate !== undefined ? Number(body.failRate) : undefined,
      queue: body.queue,
    });
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
