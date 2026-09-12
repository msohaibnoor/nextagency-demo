import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { resultsKey, type JobResult, type QueueName } from "@demo/queue";

export const REDIS = "REDIS_CLIENT";
const MAX = 1000;

@Injectable()
export class ResultsStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // Sorted set, not a hash: HKEYS order isn't guaranteed to be insertion
  // order once a hash leaves listpack encoding, so trimming "oldest first"
  // off a hash isn't reliable. A ZSET scored by Date.now() gives a stable
  // recency order, and ZADD + ZREMRANGEBYRANK run together in one MULTI so
  // the record-and-trim is a single atomic round-trip even at concurrency 5.
  async record(queue: QueueName, result: JobResult) {
    const key = resultsKey(queue);
    await this.redis
      .multi()
      .zadd(key, Date.now(), JSON.stringify(result))
      .zremrangebyrank(key, 0, -(MAX + 1))
      .exec();
  }

  count(queue: QueueName) {
    return this.redis.zcard(resultsKey(queue));
  }
}
