import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { writeAdapterExecutionTargetTextFile } from "./execution-target.js";

const MARKER = "Zażółć-prywatny-prompt";

interface PublishWatch {
  command: string;
  envText: string;
  stderr: string;
  modeDuringWrite: number | null;
  destExistedDuringWrite: boolean;
}

function remoteTarget(runner: CommandManagedRuntimeRunner) {
  return {
    kind: "remote" as const,
    transport: "sandbox" as const,
    remoteCwd: "/tmp",
    shellCommand: "sh" as const,
    runner,
  };
}

function localShellRunner(destPath: string, watch: PublishWatch, interrupt: boolean): CommandManagedRuntimeRunner {
  return {
    async execute(input) {
      const startedAt = new Date().toISOString();
      watch.command = [input.command, ...(input.args ?? [])].join("\n");
      watch.envText = JSON.stringify(input.env ?? {});
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: { PATH: "/usr/bin:/bin", HOME: os.homedir() },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.on("error", () => {});

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
        child.on("error", () => resolve({ code: 1, signal: null }));
      });

      const parent = path.dirname(destPath);
      const shouldSample = interrupt || parent !== "/tmp";
      const tempPath = shouldSample ? await waitForTemp(parent, closed) : null;
      if (tempPath) {
        const stat = await fs.lstat(tempPath);
        watch.modeDuringWrite = stat.mode & 0o777;
        watch.destExistedDuringWrite = await fs.lstat(destPath).then(() => true).catch(() => false);
      }

      const stillRunning = child.exitCode === null && child.signalCode === null && !child.killed;
      if (stillRunning && interrupt && child.pid) {
        child.stdin.write((input.stdin ?? "").slice(0, 128));
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (tempPath) {
          const during = await fs.lstat(tempPath).catch(() => null);
          if (during && !during.isSymbolicLink()) watch.modeDuringWrite = during.mode & 0o777;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else if (stillRunning) {
        const body = input.stdin ?? "";
        if (tempPath && body.length > 64) {
          child.stdin.write(body.slice(0, 64));
          await new Promise((resolve) => setTimeout(resolve, 40));
          const during = await fs.lstat(tempPath).catch(() => null);
          if (during && !during.isSymbolicLink() && during.size > 0) {
            watch.modeDuringWrite = during.mode & 0o777;
          }
          child.stdin.end(body.slice(64));
        } else {
          child.stdin.end(body);
        }
      } else {
        child.stdin.destroy();
      }

      const killer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The process group is already gone.
          }
        }
      }, input.timeoutMs ?? 15_000);
      const close = await closed;
      clearTimeout(killer);
      watch.stderr = stderr;
      return {
        exitCode: close.code,
        signal: close.signal,
        timedOut: false,
        stdout,
        stderr,
        pid: child.pid ?? null,
        startedAt,
      };
    },
  };
}

async function waitForTemp(parent: string, closed: Promise<unknown>): Promise<string | null> {
  let closedDone = false;
  void closed.then(() => {
    closedDone = true;
  });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !closedDone) {
    const names = await fs.readdir(parent).catch(() => [] as string[]);
    const temp = names.find((name) => name.startsWith(".prompt."));
    if (temp) return path.join(parent, temp);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return null;
}

async function looseModes(directory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stat = await fs.lstat(full);
      if (!stat.isSymbolicLink() && (stat.mode & 0o077) !== 0) {
        found.push(`${entry.name}:${(stat.mode & 0o777).toString(8)}`);
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(full);
    }
  };
  await visit(directory);
  return found;
}

describe("remote Grok prompt publish", () => {
  it.runIf(process.platform === "linux")(
    "keeps the file private while the body is still arriving",
    async () => {
      const parent = path.join(os.tmpdir(), `paperclip-grok-prompt-mode-${process.pid}-${Date.now()}`);
      const destPath = path.join(parent, "prompt.txt");
      const body = `${MARKER}${"ą".repeat(80_000)}`;
      expect(Buffer.byteLength(body)).toBeGreaterThan(131072);
      const watch: PublishWatch = {
        command: "",
        envText: "",
        stderr: "",
        modeDuringWrite: null,
        destExistedDuringWrite: false,
      };
      try {
        await writeAdapterExecutionTargetTextFile(
          "run-private",
          remoteTarget(localShellRunner(destPath, watch, false)),
          destPath,
          body,
          { cwd: "/tmp", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutSec: 20 },
        ).catch((error: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\n${watch.stderr}`);
        });
        const stat = await fs.lstat(destPath);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o600);
        expect((await fs.lstat(parent)).mode & 0o777).toBe(0o700);
        expect(await fs.readFile(destPath, "utf8")).toBe(body);
        expect(watch.modeDuringWrite).toBe(0o600);
        expect(watch.destExistedDuringWrite).toBe(false);
        expect(watch.command).not.toContain(MARKER);
        expect(watch.envText).not.toContain(MARKER);
        expect(watch.command).not.toContain(`cat > ${destPath}`);
        expect(await looseModes(parent)).toEqual([]);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not write through a destination symlink or a directory symlink",
    async () => {
      const root = path.join(os.tmpdir(), `paperclip-grok-prompt-link-${process.pid}-${Date.now()}`);
      const parent = path.join(root, "private");
      const destPath = path.join(parent, "prompt.txt");
      const outside = path.join(root, "outside.txt");
      const linkedParent = path.join(root, "linked-parent");
      const realDir = path.join(root, "real-dir");
      await fs.mkdir(parent, { recursive: true });
      await fs.chmod(parent, 0o700);
      await fs.writeFile(outside, "DO-NOT-OVERWRITE");
      await fs.symlink(outside, destPath);
      const watch: PublishWatch = {
        command: "",
        envText: "",
        stderr: "",
        modeDuringWrite: null,
        destExistedDuringWrite: false,
      };
      try {
        await writeAdapterExecutionTargetTextFile(
          "run-symlink",
          remoteTarget(localShellRunner(destPath, watch, false)),
          destPath,
          `${MARKER}-dest`,
          { cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, timeoutSec: 20 },
        );
        const destStat = await fs.lstat(destPath);
        expect(destStat.isSymbolicLink()).toBe(false);
        expect(destStat.mode & 0o777).toBe(0o600);
        expect(await fs.readFile(destPath, "utf8")).toBe(`${MARKER}-dest`);
        expect(await fs.readFile(outside, "utf8")).toBe("DO-NOT-OVERWRITE");

        await fs.mkdir(realDir);
        await fs.writeFile(path.join(realDir, "marker.txt"), "KEEP");
        await fs.symlink(realDir, linkedParent);
        const linkedDest = path.join(linkedParent, "prompt.txt");
        const linkedWatch: PublishWatch = { ...watch, stderr: "", command: "" };
        await expect(writeAdapterExecutionTargetTextFile(
          "run-parent-link",
          remoteTarget(localShellRunner(linkedDest, linkedWatch, false)),
          linkedDest,
          `${MARKER}-parent`,
          { cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, timeoutSec: 20 },
        )).rejects.toThrow(/Failed to publish/);
        expect(await fs.readFile(path.join(realDir, "marker.txt"), "utf8")).toBe("KEEP");
        expect(await fs.readdir(realDir)).toEqual(["marker.txt"]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "leaves no world-readable file when the publish is killed or the directory is shared",
    async () => {
      const parent = path.join(os.tmpdir(), `paperclip-grok-prompt-kill-${process.pid}-${Date.now()}`);
      const destPath = path.join(parent, "prompt.txt");
      const watch: PublishWatch = {
        command: "",
        envText: "",
        stderr: "",
        modeDuringWrite: null,
        destExistedDuringWrite: false,
      };
      try {
        await expect(writeAdapterExecutionTargetTextFile(
          "run-kill",
          remoteTarget(localShellRunner(destPath, watch, true)),
          destPath,
          `${MARKER}${"x".repeat(190_000)}`,
          { cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, timeoutSec: 20 },
        )).rejects.toThrow(/Failed to publish/);
        expect(watch.modeDuringWrite).toBe(0o600);
        await expect(fs.lstat(destPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await looseModes(parent)).toEqual([]);

        const flatPath = path.join("/tmp", `paperclip-grok-prompt-flat-${process.pid}-${Date.now()}.txt`);
        const flatWatch: PublishWatch = { ...watch, modeDuringWrite: null };
        await expect(writeAdapterExecutionTargetTextFile(
          "run-flat",
          remoteTarget(localShellRunner(flatPath, flatWatch, false)),
          flatPath,
          `${MARKER}-flat`,
          { cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, timeoutSec: 20 },
        )).rejects.toThrow(/Failed to publish/);
        await expect(fs.lstat(flatPath)).rejects.toMatchObject({ code: "ENOENT" });

        const openParent = path.join(os.tmpdir(), `paperclip-grok-prompt-open-${process.pid}-${Date.now()}`);
        await fs.mkdir(openParent);
        await fs.chmod(openParent, 0o755);
        const openDest = path.join(openParent, "prompt.txt");
        await expect(writeAdapterExecutionTargetTextFile(
          "run-open",
          remoteTarget(localShellRunner(openDest, flatWatch, false)),
          openDest,
          `${MARKER}-open`,
          { cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, timeoutSec: 20 },
        )).rejects.toThrow(/Failed to publish/);
        await expect(fs.lstat(openDest)).rejects.toMatchObject({ code: "ENOENT" });
        await fs.rm(openParent, { recursive: true, force: true });
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );
});
