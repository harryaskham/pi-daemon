import {
  DASH_DEFAULT_LIMITS,
  asDashboardCursor,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  DashboardBackend,
  DashboardCursor,
  SessionInventoryPage,
  SessionInventoryQuery,
  TranscriptPage,
  TranscriptQuery,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { createSessionFixtures, createTranscriptFixtures } from "./fixtures";
import type { InventoryId, SessionFixture, TranscriptRecord } from "./model";

export const FIXTURE_INVENTORY_PAGE_LIMIT = DASH_DEFAULT_LIMITS.maxInventoryPageItems;
export const FIXTURE_TRANSCRIPT_PAGE_LIMIT = DASH_DEFAULT_LIMITS.maxTranscriptPageRecords;

export type DashboardFrontendBackend = Pick<DashboardBackend, "listSessions" | "getTranscript"> & {
  getSessionView(inventoryId: InventoryId): Promise<SessionFixture>;
};

function cursorOffset(cursor: DashboardCursor | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^cursor_(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

function cursorFor(offset: number): DashboardCursor {
  return asDashboardCursor(`cursor_${offset}`);
}

export class LocalFixtureBackend implements DashboardFrontendBackend {
  #sessions?: SessionFixture[];
  #transcript?: TranscriptRecord[];
  #byId?: Map<InventoryId, SessionFixture>;

  get sessions(): SessionFixture[] {
    return this.#sessions ??= createSessionFixtures();
  }

  get transcript(): TranscriptRecord[] {
    return this.#transcript ??= createTranscriptFixtures();
  }

  #sessionIndex(): Map<InventoryId, SessionFixture> {
    return this.#byId ??= new Map(this.sessions.map((session) => [session.inventoryId, session]));
  }

  async listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    const normalized = query.search?.trim().toLocaleLowerCase() ?? "";
    const ordered = [...this.sessions].sort((left, right) =>
      (right.activityAt ?? right.modifiedAt).localeCompare(left.activityAt ?? left.modifiedAt) ||
      left.inventoryId.localeCompare(right.inventoryId)
    );
    const matches = normalized.length === 0
      ? ordered
      : ordered.filter((session) =>
          `${session.title}\n${session.cwd}\n${session.project}\n${session.sessionId}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
    const offset = cursorOffset(query.cursor);
    const limit = Math.min(
      Math.max(query.limit ?? FIXTURE_INVENTORY_PAGE_LIMIT, 1),
      FIXTURE_INVENTORY_PAGE_LIMIT,
    );
    const sessions = matches.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    return {
      sessions,
      ...(nextOffset < matches.length ? { nextCursor: cursorFor(nextOffset) } : {}),
      index: {
        formatVersion: 1,
        loadedAt: "2026-07-18T12:00:00.000Z",
        reconciledAt: "2026-07-18T12:00:00.000Z",
        stale: false,
        reconciling: false,
      },
    };
  }

  async getSessionView(inventoryId: InventoryId): Promise<SessionFixture> {
    const session = this.#sessionIndex().get(inventoryId);
    if (!session) throw new Error("fixture session was not found");
    return session;
  }

  async getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage> {
    const session = this.#sessionIndex().get(inventoryId);
    if (!session) throw new Error("fixture session was not found");
    const offset = cursorOffset(query.cursor);
    const limit = Math.min(
      Math.max(query.limit ?? FIXTURE_TRANSCRIPT_PAGE_LIMIT, 1),
      FIXTURE_TRANSCRIPT_PAGE_LIMIT,
    );
    const records = this.transcript.slice(offset, offset + limit);
    const nextOffset = offset + records.length;
    return {
      inventoryId,
      ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
      managedSession: { sessionId: session.sessionId, generation: session.generation },
      ...(session.currentLeafId ? { currentLeafId: session.currentLeafId } : {}),
      records,
      order: "chronological",
      ...(nextOffset < this.transcript.length ? { newerCursor: cursorFor(nextOffset) } : {}),
      projection: {
        formatVersion: 1,
        cached: true,
        truncated: false,
        builtAt: "2026-07-18T12:00:00.000Z",
      },
      hydration: "not-requested",
    };
  }
}

export const fixtureBackend = new LocalFixtureBackend();
