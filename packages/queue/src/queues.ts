export const QUEUES = {
  renewalReminders: "renewal-reminders",
  reports: "reports",
  nightlySweep: "nightly-sweep",
  rateLimitedSync: "rate-limited-sync",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
export const resultsKey = (queue: QueueName) => `results:${queue}`;
