import { Module } from "@nestjs/common";
import Redis, { type RedisOptions } from "ioredis";
import { redisConnectionOptions } from "@demo/queue";
import { HealthController, REDIS } from "./health/health.controller";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(redisConnectionOptions(process.env) as RedisOptions),
    },
  ],
})
export class AppModule {}
