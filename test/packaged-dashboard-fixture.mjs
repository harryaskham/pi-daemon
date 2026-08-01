import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const packagedDashboardIndex = fileURLToPath(
  new URL("../dist/dashboard/index.html", import.meta.url),
);

/**
 * Fail a packaged-SPA acceptance at its real precondition (bd-1a9e5b).
 *
 * `npm run test:unit` deliberately performs no build. A scenario that asks the
 * production DashboardServer to serve its default packaged assets must therefore
 * name the absent build product before `/dash/` turns it into a misleading
 * `404 !== 200`. This remains a hard failure — never a skip — and the optional
 * path exists only so the helper carries direct negative controls without
 * deleting the repository's real dist tree.
 */
export async function assertPackagedDashboardBuilt(
  indexPath = packagedDashboardIndex,
) {
  let info;
  try {
    info = await stat(indexPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw missingPackagedDashboardError();
    }
    throw error;
  }
  if (!info.isFile()) throw missingPackagedDashboardError();
}

function missingPackagedDashboardError() {
  return new Error(
    "packaged Dash SPA missing — run `npm run build` before tests that serve /dash/ from dist/dashboard",
  );
}
