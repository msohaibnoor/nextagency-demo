import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";

export const REDIS = "REDIS_CLIENT";

@Controller("api/health")
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Get()
  async check() {
    try {
      await this.redis.ping();
      return { ok: true, redis: "up" as const };
    } catch {
      return { ok: false, redis: "down" as const };
    }
  }
}
