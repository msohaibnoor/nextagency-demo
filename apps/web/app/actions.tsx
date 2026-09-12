"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function Actions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (label: string, path: string, body: unknown) => {
    setBusy(label);
    await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    router.refresh();
  };
  return (
    <p>
      <button disabled={!!busy} onClick={() => call("seed", "/api/jobs/seed", { count: 50, failRate: 0.2 })}>Seed 50 reminders (20% fail)</button>
      <button disabled={!!busy} onClick={() => call("report", "/api/jobs/report", {})}>Run report flow</button>
      <button disabled={!!busy} onClick={() => router.refresh()}>Refresh</button>
      {busy && <span>working…</span>}
    </p>
  );
}
