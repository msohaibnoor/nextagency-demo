import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import { redisConnectionOptions } from "@demo/queue";

// Owns the app's plain ioredis connection (the one outside BullMQ) and closes
// it when Nest shuts down, so SIGTERM / app.close() leave no socket behind.
// Consumers keep injecting the ioredis instance under the REDIS token; this
// class is only the lifecycle owner.
@Injectable()
export class RedisClient implements OnApplicationShutdown {
  readonly client = new Redis(redisConnectionOptions(process.env));

  onApplicationShutdown() {
    return this.client.quit();
  }
}
