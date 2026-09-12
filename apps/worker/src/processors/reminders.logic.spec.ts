import { shouldFail, summarize } from "./reminders.logic";

describe("reminders logic", () => {
  it("never fails when failRate is undefined or 0", () => {
    expect(shouldFail(undefined, () => 0.01)).toBe(false);
    expect(shouldFail(0, () => 0.0)).toBe(false);
  });
  it("fails when the random draw is below failRate", () => {
    expect(shouldFail(0.2, () => 0.1)).toBe(true);
    expect(shouldFail(0.2, () => 0.3)).toBe(false);
  });
  it("summarizes a reminder", () => {
    expect(summarize({ policyId: "pol-1", agencyId: "agency-2", renewalDate: "2026-10-01" }))
      .toBe("Reminder sent for pol-1 (agency-2) renewing 2026-10-01");
  });
});
