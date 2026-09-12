export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export type Counts = { waiting: number; active: number; completed: number; failed: number; delayed: number };
export async function getStats(): Promise<Record<string, Counts>> {
  const res = await fetch(`${API_URL}/api/jobs/stats`, { cache: "no-store" });
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json();
}
