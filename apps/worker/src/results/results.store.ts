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
    const replies = await this.redis
      .multi()
      .zadd(key, Date.now(), JSON.stringify(result))
      .zremrangebyrank(key, 0, -(MAX + 1))
      .exec();
    // ioredis resolves exec() with a [err, result][] tuple per command and
    // does NOT reject the promise on a per-command error (e.g. WRONGTYPE) —
    // only a queueing/syntax failure aborts the whole MULTI (replies: null).
    // Surface both cases, otherwise a failed ZADD leaves the job "completed"
    // with nothing actually persisted.
    if (!replies) throw new Error(`results store: MULTI aborted for ${key}`);
    for (const [err] of replies) if (err) throw err;
  }

  count(queue: QueueName) {
    return this.redis.zcard(resultsKey(queue));
  }
}
