import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { log } from "./log";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // SIGTERM -> @nestjs/bullmq closes workers gracefully
  log("worker started", { pid: process.pid });
}
bootstrap();
