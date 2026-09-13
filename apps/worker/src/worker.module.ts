import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ALL_QUEUES, redisConnectionOptions } from "@demo/queue";
import { RedisClient } from "./redis.client";
import { REDIS, ResultsStore } from "./results/results.store";
import { RemindersProcessor } from "./processors/reminders.processor";
import { ReportsProcessor } from "./processors/reports.processor";
import { SweepProcessor } from "./processors/sweep.processor";
import { SyncProcessor } from "./processors/sync.processor";

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(process.env) }),
    // registerQueue (not just forRoot) is required: it's what pulls in
    // @nestjs/bullmq's BullExplorer/DiscoveryModule, which is what actually
    // scans providers for @Processor classes and turns them into running
    // BullMQ Worker instances. forRoot alone only publishes shared connection
    // config — without registerQueue here, @Processor is inert (the app
    // boots and logs cleanly, but no jobs are ever consumed). Registering
    // every queue here (rather than one-off per processor) means each new
    // processor just needs adding to `providers` below.
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  providers: [
    RedisClient,
    { provide: REDIS, useFactory: (r: RedisClient) => r.client, inject: [RedisClient] },
    ResultsStore,
    RemindersProcessor,
    ReportsProcessor,
    SweepProcessor,
    SyncProcessor,
  ],
})
export class WorkerModule {}
