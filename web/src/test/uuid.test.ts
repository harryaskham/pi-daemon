import { describe, expect, it, vi } from "vitest";
import { generateUUID } from "../uuid";

describe("generateUUID", () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("produces valid RFC 4122 v4 UUID with crypto.randomUUID", () => {
    const id = generateUUID();
    expect(id).toMatch(UUID_REGEX);
  });

  it("produces valid RFC 4122 v4 UUID when crypto.randomUUID is undefined (getRandomValues fallback)", () => {
    const original = crypto.randomUUID;
    try {
      // @ts-expect-error simulating older/insecure browser environment
      delete crypto.randomUUID;
      const id = generateUUID();
      expect(id).toMatch(UUID_REGEX);
    } finally {
      crypto.randomUUID = original;
    }
  });

  it("produces valid RFC 4122 v4 UUID when crypto is completely absent (Math.random fallback)", () => {
    const originalRandomUUID = crypto.randomUUID;
    const originalGetRandomValues = crypto.getRandomValues;
    try {
      // @ts-expect-error simulating legacy/no-crypto environment
      delete crypto.randomUUID;
      // @ts-expect-error simulating legacy/no-crypto environment
      delete crypto.getRandomValues;
      const id = generateUUID();
      expect(id).toMatch(UUID_REGEX);
    } finally {
      crypto.randomUUID = originalRandomUUID;
      crypto.getRandomValues = originalGetRandomValues;
    }
  });
});
