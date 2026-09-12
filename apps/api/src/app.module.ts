import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import Redis from "ioredis";
import { redisConnectionOptions } from "@demo/queue";
import { HealthController, REDIS } from "./health/health.controller";
import { JobsModule } from "./jobs/jobs.module";

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(process.env) }),
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: REDIS, useFactory: () => new Redis(redisConnectionOptions(process.env)) }],
})
export class AppModule {}
