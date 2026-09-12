import { Module, OnModuleInit } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ALL_QUEUES } from "@demo/queue";
import { JobsController } from "./jobs.controller";
import { JobsService, REPORT_FLOW } from "./jobs.service";

@Module({
  imports: [
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
    BullModule.registerFlowProducer({ name: REPORT_FLOW }),
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [BullModule],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly jobs: JobsService) {}
  onModuleInit() {
    return this.jobs.ensureSweepScheduler();
  }
}
