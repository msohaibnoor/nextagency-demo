import type { ReportStep } from "@demo/queue";
export function composeStep(step: ReportStep, childValues: unknown[]): string {
  const prev = childValues.map(String).join(", ");
  switch (step) {
    case "gather": return "gathered 12 policies";
    case "render": return `rendered PDF from [${prev}]`;
    case "email": return `emailed [${prev}]`;
  }
}
