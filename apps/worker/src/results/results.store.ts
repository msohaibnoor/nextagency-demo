import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { resultsKey, type JobResult, type QueueName } from "@demo/queue";

export const REDIS = "REDIS_CLIENT";
const MAX = 1000;

@Injectable()
export class ResultsStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async record(queue: QueueName, result: JobResult) {
    const key = resultsKey(queue);
    await this.redis.hset(key, result.jobId, JSON.stringify(result));
    const n = await this.redis.hlen(key);
    if (n > MAX) {
      const fields = await this.redis.hkeys(key);
      await this.redis.hdel(key, ...fields.slice(0, n - MAX));
    }
  }

  count(queue: QueueName) {
    return this.redis.hlen(resultsKey(queue));
  }
}
