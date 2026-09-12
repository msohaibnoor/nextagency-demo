// Usage: pnpm --filter scripts seed -- --count 50 --fail-rate 0.2 --queue renewal-reminders
import { Queue } from "bullmq";
import { QUEUES, redisConnectionOptions, type QueueName } from "@demo/queue";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const count = Number(arg("count", "50"));
const failRate = Number(arg("fail-rate", "0.2"));
const queueName = arg("queue", QUEUES.renewalReminders) as QueueName;

async function main() {
  const queue = new Queue(queueName, { connection: redisConnectionOptions(process.env) });
  const opts = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 };
  const jobs = Array.from({ length: count }, (_, i) =>
    queueName === QUEUES.rateLimitedSync
      ? { name: "sync", data: { carrierId: `carrier-${i + 1}` }, opts }
      : { name: "remind", data: { policyId: `pol-${i + 1}`, agencyId: `agency-${(i % 5) + 1}`, renewalDate: "2026-12-01", failRate }, opts },
  );
  const added = await queue.addBulk(jobs);
  console.log(`enqueued ${added.length} jobs on ${queueName}`);
  await queue.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
