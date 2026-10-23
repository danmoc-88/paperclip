import { describe, expect, it } from "vitest";
import { spawnText } from "./ssh.js";

// Regression coverage for SAK-2143 on the SSH stdin write site. `spawnText` is
// the shared spawn helper behind `runSshCommand`, which passes command input
// through `options.stdin`. When the remote process closes its stdin before the
// payload is written, the write emits an asynchronous EPIPE `error` event on
// the child stdin socket. Without a listener, Node rethrows that event and the
// whole server exits — the exact `paperclipai.service` restart this issue is
// about.
describe("ssh spawnText stdin pipe errors (SAK-2143)", () => {
  it.skipIf(process.platform === "win32")(
    "finishes without an unhandled error when the child closes stdin first",
    async () => {
      const payload = "x".repeat(256 * 1024);
      let uncaught: unknown = null;
      const onUncaught = (error: unknown) => {
        uncaught = error;
      };
      process.once("uncaughtException", onUncaught);
      try {
        const result = await spawnText("sh", ["-c", "exec 0<&-; sleep 0.5"], {
          stdin: payload,
          timeout: 10_000,
        });

        expect(uncaught).toBeNull();
        expect(result.stdout).toBe("");
      } finally {
        process.removeListener("uncaughtException", onUncaught);
      }
    },
    15_000,
  );
});
