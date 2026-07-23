import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  validateDashboardSessionDraftCancelRequest,
  validateDashboardSessionDraftCreateRequest,
  validateDashboardSessionDraftResource,
  validateDashboardSessionDraftSendRequest,
  validateDashboardSessionDraftSendTicket,
} from "../dist/dashboard-session-drafts.js";

const json = async (relative) =>
  JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));

const fixtures = [
  ["../fixtures/dashboard-api/session-draft.create.request.json", validateDashboardSessionDraftCreateRequest],
  ["../fixtures/dashboard-api/session-draft.resource.json", validateDashboardSessionDraftResource],
  ["../fixtures/dashboard-api/session-draft.cancel.request.json", validateDashboardSessionDraftCancelRequest],
  ["../fixtures/dashboard-api/session-draft.send.request.json", validateDashboardSessionDraftSendRequest],
  ["../fixtures/dashboard-api/session-draft.send-ticket.json", validateDashboardSessionDraftSendTicket],
];

test("lazy session draft fixtures satisfy strict schema and TypeScript validation", async () => {
  const schema = await json("../dashboard-session-draft.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  for (const [path, parser] of fixtures) {
    const value = await json(path);
    assert.equal(validate(value), true, `${path}: ${ajv.errorsText(validate.errors)}`);
    assert.deepEqual(parser(value), value);
  }
});

test("draft contract excludes raw ambient authority and keeps private first message out of resources", async () => {
  const request = await json("../fixtures/dashboard-api/session-draft.create.request.json");
  for (const mutate of [
    (value) => { value.spec.env = { TOKEN: "secret" }; },
    (value) => { value.spec.settings = { unsafe: true }; },
    (value) => { value.spec.resources.extensions = ["project-extension"]; },
  ]) {
    const invalid = structuredClone(request);
    mutate(invalid);
    assert.throws(() => validateDashboardSessionDraftCreateRequest(invalid));
  }
  for (const [path] of fixtures) {
    const serialized = JSON.stringify(await json(path));
    if (!path.includes("send.request")) {
      assert.equal(serialized.includes("Start this session exactly once"), false);
    }
    assert.doesNotMatch(serialized, /bearer|authorization|api[_-]?key|TOKEN/i);
  }
});

test("draft send ticket binds immutable session generation and admitted draft revision", async () => {
  const ticket = await json("../fixtures/dashboard-api/session-draft.send-ticket.json");
  assert.equal(ticket.draftRevision, 1);
  assert.deepEqual(ticket.session, { sessionId: "session-fixture-01", generation: 1 });
  for (const field of ["draftRevision", "session"]) {
    const invalid = structuredClone(ticket);
    delete invalid[field];
    assert.throws(() => validateDashboardSessionDraftSendTicket(invalid));
  }
});
