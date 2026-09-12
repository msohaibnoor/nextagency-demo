"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main>
      <h1>NextAgency Demo — API unreachable</h1>
      <p>{error.message}</p>
      <button onClick={() => reset()}>Retry</button>
      <p>Is <code>apps/api</code> running on the URL in <code>API_URL</code>?</p>
    </main>
  );
}
