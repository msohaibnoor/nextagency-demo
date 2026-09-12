import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import Redis from "ioredis";
import { QUEUES, redisConnectionOptions } from "@demo/queue";
import { REDIS, ResultsStore } from "./results/results.store";
import { RemindersProcessor } from "./processors/reminders.processor";

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(process.env) }),
    // registerQueue (not just forRoot) is required: it's what pulls in
    // @nestjs/bullmq's BullExplorer/DiscoveryModule, which is what actually
    // scans providers for @Processor classes and turns them into running
    // BullMQ Worker instances. forRoot alone only publishes shared connection
    // config — without registerQueue here, @Processor is inert (the app
    // boots and logs cleanly, but no jobs are ever consumed).
    BullModule.registerQueue({ name: QUEUES.renewalReminders }),
  ],
  providers: [
    { provide: REDIS, useFactory: () => new Redis(redisConnectionOptions(process.env)) },
    ResultsStore,
    RemindersProcessor,
  ],
})
export class WorkerModule {}
