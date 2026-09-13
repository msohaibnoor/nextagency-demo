import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { redisConnectionOptions } from "@demo/queue";
import { RedisClient } from "./redis.client";
import { HealthController, REDIS } from "./health/health.controller";
import { JobsModule } from "./jobs/jobs.module";
import { AdminModule } from "./admin/admin.module";

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(process.env) }),
    JobsModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    RedisClient,
    { provide: REDIS, useFactory: (r: RedisClient) => r.client, inject: [RedisClient] },
  ],
})
export class AppModule {}
