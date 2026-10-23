import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  spawnText,
  streamLocalFileToSsh,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// Regression coverage for SAK-2143 on every SSH child-stdin write site. A child
// that closes its stdin before the payload is written makes the next write emit
// an asynchronous EPIPE `error` on the `net.Socket`. Without an `error` listener
// on that socket, Node re-emits the event with no listener and the whole server
// exits — the exact `paperclipai.service` restart this issue is about.
//
// `spawnText` covers the direct SSH command write; the three transfer functions
// below cover the `.pipe(child.stdin)` sites the first review missed.
function testSpec(): SshRemoteExecutionSpec {
  return {
    host: "example.invalid",
    port: 22,
    username: "tester",
    remoteCwd: "/tmp/paperclip-remote",
    remoteWorkspacePath: "/tmp/paperclip-remote",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

// Records an unhandled `error` event without letting the process exit, so the
// test can assert that the transfer did not crash the host. Before the fix the
// pipe re-emits the write EPIPE with no listener and this catches it.
function watchUncaughtExceptions() {
  const seen: unknown[] = [];
  const listener = (error: unknown) => {
    seen.push(error);
  };
  process.on("uncaughtException", listener);
  return {
    seen,
    restore: () => process.removeListener("uncaughtException", listener),
  };
}

// Prepends a temp bin dir (holding an `ssh` and/or `tar` stand-in) to PATH so
// the transfer spawns the stand-in instead of reaching a real SSH host. The
// real `tar` stays reachable when only `ssh` is overridden.
async function installFakeBinaries(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-fake-ssh-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    await writeFile(file, body, "utf8");
    await chmod(file, 0o755);
  }
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return {
    restore: async () => {
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Close the read end of stdin immediately, then linger so the parent keeps
// writing into a closed pipe — the ssh-side condition from SAK-2143.
const FAKE_SSH_CLOSES_STDIN = [
  "#!/bin/sh",
  "exec 0<&-",
  "sleep 0.3",
  "exit 0",
  "",
].join("\n");

// Emit more bytes than the pipe buffer holds, then linger, so the parent's
// write into the destination blocks and hits the closed read end.
const FAKE_SSH_EMITS_STDOUT = [
  "#!/bin/sh",
  "trap '' PIPE",
  "dd if=/dev/zero bs=1024 count=256 2>/dev/null",
  "sleep 0.3",
  "exit 0",
  "",
].join("\n");

const FAKE_TAR_CLOSES_STDIN = [
  "#!/bin/sh",
  "exec 0<&-",
  "sleep 0.3",
  "exit 0",
  "",
].join("\n");

describe("ssh child stdin pipe errors (SAK-2143)", () => {
  it.skipIf(process.platform === "win32")(
    "spawnText finishes without an unhandled error when the child closes stdin first",
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

  it.skipIf(process.platform === "win32")(
    "streamLocalFileToSsh survives an ssh that closes stdin (file → SSH pipe)",
    async () => {
      const bin = await installFakeBinaries({ ssh: FAKE_SSH_CLOSES_STDIN });
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-file-"));
      const localFile = path.join(root, "payload.bin");
      await writeFile(localFile, Buffer.alloc(1024 * 1024, 0x61));
      const uncaught = watchUncaughtExceptions();
      try {
        await streamLocalFileToSsh({
          spec: testSpec(),
          localFile,
          remoteScript: "mkdir -p /tmp/paperclip-remote",
        }).catch(() => undefined);
        expect(uncaught.seen).toHaveLength(0);
      } finally {
        uncaught.restore();
        await bin.restore();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "syncDirectoryToSsh survives an ssh that closes stdin (tar → SSH pipe)",
    async () => {
      const bin = await installFakeBinaries({ ssh: FAKE_SSH_CLOSES_STDIN });
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tar-out-"));
      const localDir = path.join(root, "workspace");
      await mkdir(localDir, { recursive: true });
      await writeFile(path.join(localDir, "big.bin"), Buffer.alloc(1024 * 1024, 0x62));
      const uncaught = watchUncaughtExceptions();
      try {
        await syncDirectoryToSsh({
          spec: testSpec(),
          localDir,
          remoteDir: "/tmp/paperclip-remote",
        }).catch(() => undefined);
        expect(uncaught.seen).toHaveLength(0);
      } finally {
        uncaught.restore();
        await bin.restore();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "syncDirectoryFromSsh survives a tar that closes stdin (SSH → tar pipe)",
    async () => {
      const bin = await installFakeBinaries({
        ssh: FAKE_SSH_EMITS_STDOUT,
        tar: FAKE_TAR_CLOSES_STDIN,
      });
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-tar-in-"));
      const localDir = path.join(root, "restore");
      await mkdir(localDir, { recursive: true });
      const uncaught = watchUncaughtExceptions();
      try {
        await syncDirectoryFromSsh({
          spec: testSpec(),
          remoteDir: "/tmp/paperclip-remote",
          localDir,
        }).catch(() => undefined);
        expect(uncaught.seen).toHaveLength(0);
      } finally {
        uncaught.restore();
        await bin.restore();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
