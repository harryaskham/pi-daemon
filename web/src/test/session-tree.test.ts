import { describe, expect, it } from "vitest";
import {
  type SessionTreeModel,
  SessionTreeValidationError,
  adjacentSessionTreeEntry,
  compareSessionTreeEntries,
  filterSessionTree,
  parseSessionTree,
} from "../session-tree";
import { reportPerformanceBudget } from "./performance-budget";

function message(id: string, parentId: string | null, text: string, role = "user") {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-04-18T12:00:00.000Z",
    message: { role, content: text },
  };
}

function fixture() {
  return {
    leafId: "right-leaf",
    tree: [
      {
        entry: message("root", null, "start session"),
        label: "base",
        children: [
          {
            entry: message("left", "root", "abandoned branch"),
            label: "experiment",
            children: [
              {
                entry: {
                  id: "left-summary",
                  parentId: "left",
                  type: "branch_summary",
                  timestamp: "2026-04-18T12:05:00.000Z",
                  summary: "explored alternative",
                },
                children: [],
              },
            ],
          },
          {
            entry: message("right", "root", "continue session"),
            children: [
              {
                entry: {
                  id: "right-leaf",
                  parentId: "right",
                  type: "model_change",
                  timestamp: "2026-04-18T12:06:00.000Z",
                  provider: "github-copilot",
                  modelId: "gpt-5.6",
                },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("session tree model", () => {
  it("preserves branches and marks only the authoritative active-leaf path", () => {
    const model = parseSessionTree(fixture());
    expect(model.entries.map((entry) => entry.id)).toEqual(["root", "left", "left-summary", "right", "right-leaf"]);
    expect(model.activePathIds).toEqual(["root", "right", "right-leaf"]);
    expect(model.byId.get("root")).toMatchObject({ branchPoint: true, onActivePath: true });
    expect(model.byId.get("left")).toMatchObject({ label: "experiment", onActivePath: false, userText: "abandoned branch" });
    expect(model.byId.get("right-leaf")).toMatchObject({ activeLeaf: true, summary: "github-copilot/gpt-5.6" });
    expect(model.branchCount).toBe(1);
  });

  it("filters matches with their ancestry and compares divergent branch paths", () => {
    const model = parseSessionTree(fixture());
    expect(filterSessionTree(model, { query: "experiment" }).map((entry) => entry.id)).toEqual(["root", "left"]);
    expect(filterSessionTree(model, { branchPointsOnly: true }).map((entry) => entry.id)).toEqual(["root"]);
    expect(filterSessionTree(model, { types: ["branch_summary"] }).map((entry) => entry.id)).toEqual(["root", "left", "left-summary"]);
    const comparison = compareSessionTreeEntries(model, "left-summary", "right-leaf");
    expect(comparison.commonAncestorId).toBe("root");
    expect(comparison.leftPath.map((entry) => entry.id)).toEqual(["left", "left-summary"]);
    expect(comparison.rightPath.map((entry) => entry.id)).toEqual(["right", "right-leaf"]);
    expect(adjacentSessionTreeEntry(model.entries, "left", "next")?.id).toBe("left-summary");
    expect(adjacentSessionTreeEntry(model.entries, "left", "previous")?.id).toBe("root");
  });

  it("fails closed on structural ambiguity and capacity overflow", () => {
    const duplicate = fixture();
    duplicate.tree[0]!.children[1]!.entry.id = "left";
    expect(() => parseSessionTree(duplicate)).toThrow(SessionTreeValidationError);
    expect(() => parseSessionTree(fixture(), { maxNodes: 4 })).toThrow(/node count exceeds/);
    const missingLeaf = fixture();
    missingLeaf.leafId = "missing";
    expect(() => parseSessionTree(missingLeaf)).toThrow(/active leaf is not present/);
  });

  it("accepts RPC response envelopes with extra fields like type and id (bd-cfa914)", () => {
    const rpcPayload = {
      id: "tree-load-1",
      type: "response",
      command: "get_tree",
      success: true,
      ...fixture(),
    };
    const model = parseSessionTree(rpcPayload);
    expect(model.entries).toHaveLength(5);
    expect(model.activePathIds).toEqual(["root", "right", "right-leaf"]);
  });

  it("projects a 10k-wide tree within a bounded virtual-list preparation budget", () => {
    const tree = [{
      entry: message("root", null, "root"),
      children: Array.from({ length: 9_999 }, (_, index) => ({
        entry: message(`entry-${index}`, "root", `branch ${index}`),
        children: [],
      })),
    }];
    const started = performance.now();
    const model = parseSessionTree({ tree, leafId: "entry-9998" });
    const elapsed = performance.now() - started;
    expect(model.entries).toHaveLength(10_000);
    reportPerformanceBudget("session tree 10k virtual-list preparation", elapsed, 250);
  });
});
