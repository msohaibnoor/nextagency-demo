// ALB target-group health check for the web service. Deliberately does not
// call the api: a web task must not be condemned because api is mid-rollout.
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ ok: true });
}
