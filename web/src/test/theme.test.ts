import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const literalColor = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|oklch)\s*\(/i;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

describe("semantic Nord Midnight theme", () => {
  it("keeps literal presentation colors out of components and layout CSS", async () => {
    const componentDirectory = new URL("../components/", import.meta.url);
    const componentFiles = (await readdir(componentDirectory)).filter((file) => file.endsWith(".tsx"));
    const sources = await Promise.all([
      readFile(new URL("../app.css", import.meta.url), "utf8"),
      readFile(new URL("../app.tsx", import.meta.url), "utf8"),
      ...componentFiles.map((file) => readFile(new URL(file, componentDirectory), "utf8")),
    ]);
    expect(sources.filter((source) => literalColor.test(source))).toEqual([]);
  });

  it("keeps markdown declarative and image resolution on authorized routes", async () => {
    const renderer = await readFile(new URL("../components/RichTranscriptRecord.tsx", import.meta.url), "utf8");
    expect(renderer).not.toContain("dangerouslySetInnerHTML");
    expect(renderer).not.toMatch(/\beval\s*\(|\bnew Function\s*\(/);
    expect(renderer).toContain('source.startsWith("blob:")');
    expect(renderer).toContain('source.startsWith("/dash/v1/")');
    expect(renderer).not.toContain('source.startsWith("data:")');
  });

  it("retains readable primary, muted, and accent contrasts", () => {
    expect(contrast("#edf3f8", "#0b101a")).toBeGreaterThan(12);
    expect(contrast("#a9b7c9", "#111827")).toBeGreaterThan(7);
    expect(contrast("#8fceda", "#0b101a")).toBeGreaterThan(8);
    expect(contrast("#edf3f8", "#0c1320")).toBeGreaterThan(12);
    expect(contrast("#9bd8e7", "#0c1320")).toBeGreaterThan(8);
  });
});
