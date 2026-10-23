// A child process that exits before or while its stdin is written closes the
// read end of the pipe. The next write to `child.stdin` (a `net.Socket`)
// asynchronously emits `error` with code `EPIPE`. An unhandled `error` event on
// a Socket is fatal to the whole Node process, so one short-lived child could
// restart the Paperclip server and interrupt every in-flight run (SAK-2143).
// Treat the closed pipe as a normal end of input: swallow EPIPE (and the
// already-destroyed variant), and route any other stdin error to `onError` so
// it stays observable without being fatal.
//
// This module deliberately has no imports so both `server-utils.ts` and
// `ssh.ts` can share it without creating an import cycle between them.
export function attachChildStdinErrorHandler(
  stdin: NodeJS.WritableStream | null | undefined,
  onError?: (err: unknown) => void,
): void {
  if (!stdin || typeof stdin.on !== "function") return;
  stdin.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
    onError?.(err);
  });
}
