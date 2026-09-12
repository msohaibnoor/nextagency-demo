import { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { Queue } from "bullmq";
import { QUEUES, redisConnectionOptions } from "@demo/queue";
import { AppModule } from "../src/app.module";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkerModule } = require("../../worker/src/worker.module");

describe("jobs e2e", () => {
  let api: INestApplication;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const q = new Queue(QUEUES.renewalReminders, { connection: redisConnectionOptions(process.env) });
    await q.obliterate({ force: true });
    await q.close();
    api = await NestFactory.create(AppModule, { logger: false });
    await api.init();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  });
  afterAll(async () => { await worker.close(); await api.close(); });

  it("seeded jobs reach completed", async () => {
    const res = await request(api.getHttpServer()).post("/api/jobs/seed").send({ count: 5, failRate: 0 });
    expect(res.body.enqueued).toBe(5);
    const deadline = Date.now() + 20_000;
    let completed = 0;
    while (Date.now() < deadline && completed < 5) {
      await new Promise((r) => setTimeout(r, 500));
      const stats = await request(api.getHttpServer()).get("/api/jobs/stats");
      completed = stats.body[QUEUES.renewalReminders].completed;
    }
    expect(completed).toBe(5);
  });
});
