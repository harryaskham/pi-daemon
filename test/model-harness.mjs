import assert from "node:assert/strict";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * In-memory credential store in the shape `ModelRuntime` accepts.
 *
 * Pi SDK 0.82 removed the exported `AuthStorage`, whose `inMemory` constructor
 * these harnesses used to seed a provider key. The store contract is the
 * supported replacement, so tests implement the four methods directly rather
 * than reaching for an internal class.
 */
export const inMemoryCredentials = (entries = {}) => {
  const store = new Map(Object.entries(entries));
  return {
    async read(providerId) {
      return store.get(providerId);
    },
    async list() {
      return [...store].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, fn) {
      const next = await fn(store.get(providerId));
      if (next === undefined) store.delete(providerId);
      else store.set(providerId, next);
      return next;
    },
    async delete(providerId) {
      store.delete(providerId);
    },
  };
};

/**
 * A model runtime holding one built-in model with a test-only API key.
 *
 * `modelsPath: null` keeps the runtime off any on-disk model catalog, and
 * network refresh stays disabled by default, so the harness is hermetic.
 */
export const modelHarness = async () => {
  const seed = await ModelRuntime.create({
    credentials: inMemoryCredentials(),
    modelsPath: null,
  });
  const model = seed.getModels()[0];
  assert.ok(model, "Pi built-in model registry must not be empty");
  const credentials = inMemoryCredentials({
    [model.provider]: { type: "api_key", key: "test-only-key" },
  });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  return { credentials, modelRuntime, model };
};
