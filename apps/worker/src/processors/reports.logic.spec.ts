import { composeStep } from "./reports.logic";

describe("composeStep", () => {
  it("gather has no children", () => {
    expect(composeStep("gather", [])).toBe("gathered 12 policies");
  });
  it("render embeds gather's output", () => {
    expect(composeStep("render", ["gathered 12 policies"])).toBe("rendered PDF from [gathered 12 policies]");
  });
  it("email embeds render's output", () => {
    expect(composeStep("email", ["rendered PDF from [x]"])).toBe("emailed [rendered PDF from [x]]");
  });
});
