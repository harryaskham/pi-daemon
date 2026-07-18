import type { Writable } from "node:stream";

const guardedStreams = new WeakSet<Writable>();

/**
 * Installs the process-boundary policy shared by both CLI executables.
 *
 * A downstream consumer closing stdout or stderr is a normal Unix pipeline
 * condition, so EPIPE terminates quietly and successfully. Every other stream
 * error remains an uncaught failure rather than being hidden by this guard.
 */
export function installProcessStdioErrorHandlers(): void {
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);
}

function installBrokenPipeHandler(stream: Writable): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on("error", (error: Error) => {
    if (isNodeError(error) && error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
