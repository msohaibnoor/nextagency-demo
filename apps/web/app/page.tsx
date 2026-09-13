import { getStats } from "@/lib/api";
import { Actions } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const stats = await getStats();
  const cols = ["waiting", "active", "completed", "failed", "delayed"] as const;
  return (
    <main>
      <h1>NextAgency Demo — queue dashboard (v2)</h1>
      <Actions />
      <table>
        <thead><tr><th>queue</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {Object.entries(stats).map(([name, c]) => (
            <tr key={name}><td>{name}</td>{cols.map((k) => <td key={k}>{c[k]}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <p><a href="/api/admin/queues">Open Bull Board →</a></p>
    </main>
  );
}
