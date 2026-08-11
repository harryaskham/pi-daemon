import { describe, expect, it } from "vitest";
import { prettyJsonToolOutput } from "../tool-output-format";

describe("bash tool output presentation", () => {
  it("pretty-prints complete JSON objects and arrays", () => {
    expect(prettyJsonToolOutput('{"status":"ok","items":[1,2]}')).toBe(
      '{\n  "status": "ok",\n  "items": [\n    1,\n    2\n  ]\n}',
    );
    expect(prettyJsonToolOutput('[{"id":1}]')).toBe('[\n  {\n    "id": 1\n  }\n]');
  });

  it("leaves mixed shell output, primitives, and malformed JSON untouched", () => {
    expect(prettyJsonToolOutput('$ command\n{"status":"ok"}')).toBeUndefined();
    expect(prettyJsonToolOutput('"plain string"')).toBeUndefined();
    expect(prettyJsonToolOutput('{not-json}')).toBeUndefined();
  });

  it("bounds expanded JSON previews", () => {
    const formatted = prettyJsonToolOutput(JSON.stringify({ value: "x".repeat(30_000) }));
    expect(formatted?.length).toBeLessThanOrEqual(20_000);
    expect(formatted).toMatch(/… bounded JSON preview$/);
  });
});
