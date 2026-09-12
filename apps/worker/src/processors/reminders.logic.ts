import type { RenewalReminderJob } from "@demo/queue";
export const shouldFail = (failRate: number | undefined, random: () => number = Math.random) =>
  !!failRate && random() < failRate;
export const summarize = (j: RenewalReminderJob) =>
  `Reminder sent for ${j.policyId} (${j.agencyId}) renewing ${j.renewalDate}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
