import type { ConnectionOptions } from "bullmq";

export function redisConnectionOptions(env: NodeJS.ProcessEnv): ConnectionOptions {
  const raw = env.REDIS_URL;
  if (!raw) throw new Error("REDIS_URL is required");
  const url = new URL(raw);
  const opts: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
  if (url.password) opts.password = decodeURIComponent(url.password);
  if (url.protocol === "rediss:") opts.tls = {};
  return opts;
}
