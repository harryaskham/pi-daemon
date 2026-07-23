import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authorization administration presentation", () => {
  it("keeps every destructive action labelled and exposes controller ordering", async () => {
    const [component, app, css] = await Promise.all([
      readFile(new URL("../components/AuthorizationPanel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app.css", import.meta.url), "utf8"),
    ]);
    expect(component).toContain("Access &amp; controller");
    expect(component).toContain("Set grant");
    expect(component).toContain("Revoke");
    expect(component).toContain("Transfer owner");
    expect(component).toContain("The old controller is released before the target is granted");
    expect(component).toContain('aria-live="polite"');
    expect(component).not.toMatch(/credential|bearer|canonicalPath/iu);
    expect(app).toContain("Identity credential");
    expect(app).toContain("stores neither the credential nor identity authority in browser state");
    expect(app).toContain('aria-describedby="dash-login-help"');
    expect(app).toContain("Signed in as");
    expect(css).toContain(".access-dialog");
    expect(css).toContain("@media (max-width: 720px)");
  });
});
