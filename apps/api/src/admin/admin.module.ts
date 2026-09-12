import { Module } from "@nestjs/common";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ALL_QUEUES } from "@demo/queue";
import { JobsModule } from "../jobs/jobs.module";

@Module({
  imports: [
    JobsModule,
    BullBoardModule.forRoot({ route: "/api/admin/queues", adapter: ExpressAdapter }),
    ...ALL_QUEUES.map((name) => BullBoardModule.forFeature({ name, adapter: BullMQAdapter })),
  ],
})
export class AdminModule {}
