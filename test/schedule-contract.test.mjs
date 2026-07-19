import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  scheduleCapabilities,
  validateCronExpression,
  validateIanaTimezone,
  validateScheduleResource,
} from "../dist/schedule-contract.js";

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("published schedule fixtures satisfy schema and TypeScript validation", async () => {
  const schema = await json("../schedule.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const resource = await json("../fixtures/schedules/schedule.resource.json");
  const capabilities = await json("../fixtures/schedules/capabilities.json");
  const nativeCapabilities = await json("../fixtures/schedules/capabilities-native.json");
  assert.equal(validate(resource), true, JSON.stringify(validate.errors));
  assert.equal(validate(capabilities), true, JSON.stringify(validate.errors));
  assert.equal(validate(nativeCapabilities), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateScheduleResource(resource), resource);
  assert.deepEqual(scheduleCapabilities(), capabilities);
  assert.deepEqual(scheduleCapabilities({}, true), nativeCapabilities);
});

test("cron and timezone validation is strict and bounded", () => {
  assert.equal(validateCronExpression("*/15 0,12 1-10/2 * 0,7"), "*/15 0,12 1-10/2 * 0,7");
  assert.equal(validateIanaTimezone("Europe/London"), "Europe/London");
  for (const expression of ["@daily", "0 0 * *", "60 * * * *", "0 0 31 13 *", "0 0 * * MON", "*/0 * * * *", "5-2 * * * *"]) {
    assert.throws(() => validateCronExpression(expression), /cron/);
  }
  assert.throws(() => validateIanaTimezone("+01:00"), /IANA/);
  assert.throws(() => validateIanaTimezone("Mars/Olympus_Mons"), /IANA/);
});

test("schedule validation excludes unsafe ticket content and enforces prompt bytes", async () => {
  const resource = await json("../fixtures/schedules/schedule.resource.json");
  assert.throws(() => validateScheduleResource({
    ...resource,
    lastTrigger: {
      ...resource.lastTrigger,
      terminalTicket: { ...resource.lastTrigger.terminalTicket, output: "secret model output" },
    },
  }), /unknown field/);
  assert.throws(() => validateScheduleResource({ ...resource, prompt: "🔒".repeat(20) }, { maxPromptBytes: 64 }), /prompt exceeds/);
  assert.throws(() => validateScheduleResource({ ...resource, missedWakePolicy: { mode: "bounded-catch-up", maxRuns: 25 } }), /maxRuns/);
});
