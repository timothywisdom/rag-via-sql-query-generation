import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerText } from "../../apps/web/src/app/answer";
import { looksLikeMarkdown } from "../../apps/web/src/app/markdown";

describe("markdown answers", () => {
  it("leaves plain payroll sentences as text", () => {
    const text = "Bob Langley works in the Chicago office and has been employed for 7 years, 7 months.";
    expect(looksLikeMarkdown(text)).toBe(false);
    expect(looksLikeMarkdown("Current salary is salary_2025, about $92,000.")).toBe(false);
    expect(renderToStaticMarkup(createElement(AnswerText, { text }))).toBe(text);
  });

  it("renders headings, emphasis, lists, and tables", () => {
    const text = [
      "## Bob Langley",
      "",
      "He works in **Chicago**.",
      "",
      "- Tenure: 7 years, 7 months",
      "",
      "| Year | Payroll |",
      "| --- | --- |",
      "| 2024 | $1 |",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(AnswerText, { text }));
    expect(html).toContain("<h2>Bob Langley</h2>");
    expect(html).toContain("<strong>Chicago</strong>");
    expect(html).toContain("<li>Tenure: 7 years, 7 months</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>2024</td>");
  });

  it("does not turn unsafe links into anchors", () => {
    const html = renderToStaticMarkup(
      createElement(AnswerText, { text: "See [notes](javascript:alert(1)) and [site](https://example.com)." }),
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
