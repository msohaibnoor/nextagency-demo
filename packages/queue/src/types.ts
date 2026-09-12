export interface RenewalReminderJob { policyId: string; agencyId: string; renewalDate: string; failRate?: number }
export interface ReportJob { agencyId: string; month: string }
export type ReportStep = "gather" | "render" | "email";
export interface ReportStepJob extends ReportJob { step: ReportStep }
export interface RateLimitedSyncJob { carrierId: string }
export type SweepJob = Record<string, never>;
export interface JobResult { jobId: string; queue: string; finishedAt: string; summary: string }
