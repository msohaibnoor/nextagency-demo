import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";

export const REDIS = "REDIS_CLIENT";
export const PING_TIMEOUT_MS = 1000;

@Controller("api/health")
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Get()
  async check() {
    // ioredis queues commands while (re)connecting, so a plain `ping()` can
    // hang for as long as the client keeps retrying. Race it against a timer
    // so the ALB always gets an answer. HTTP stays 200 either way: a Redis
    // outage is reported in the body, not used to condemn the api task.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis ping timed out after ${PING_TIMEOUT_MS}ms`)), PING_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.redis.ping(), timeout]);
      return { ok: true, redis: "up" as const };
    } catch {
      return { ok: false, redis: "down" as const };
    } finally {
      clearTimeout(timer);
    }
  }
}
