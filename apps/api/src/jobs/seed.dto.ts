import type { QueueName } from "@demo/queue";
export interface SeedDto { count?: number; failRate?: number; queue?: QueueName }
export interface ReportDto { agencyId?: string; month?: string }
