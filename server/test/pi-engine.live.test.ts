// The delivery gate 2 live check: one real coder turn through the Pi SDK
// against a throwaway git repository, verifying streaming, tool events,
// usage, and the git file observations — the write-tool file announced by
// the engine, the shell-created file caught by the working-tree diff
// around the turn.
//
// Opt-in: it needs a real provider credential and model. Run it with:
//
//   COMPOSER_PI_LIVE=1 COMPOSER_PI_MODEL=provider/model \
//     npx vitest run test/pi-engine.live.test.ts
//
// The model id follows Composer's persisted provider/model spelling —
// e.g. anthropic/claude-sonnet-4-5, or a configured custom provider's
// model such as llama/qwen3.8.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiEngine } from "../src/engine/pi.js";
import type { AgentTurnEvent } from "../src/engine/types.js";

const LIVE = process.env.COMPOSER_PI_LIVE === "1";
const MODEL = process.env.COMPOSER_PI_MODEL;
const TURN_TIMEOUT_MS = 300_000;

const LIVE_PROMPT = [
  "Two small tasks in this directory:",
  "1. Create hello.txt with the write tool, containing exactly: hello from pi",
  '2. Create shell.txt by running a bash command (for example: echo "from the shell" > shell.txt) — do not use the write tool for this file.',
  "Confirm with one short sentence when both files exist.",
].join("\n");

describe.skipIf(!LIVE)("PiEngine live", () => {
  const directory = mkdtempSync(join(tmpdir(), "composer-pi-live-"));

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });

  git(["init", "-q"]);
  git(["config", "user.email", "composer@example.com"]);
  git(["config", "user.name", "Composer"]);
  writeFileSync(join(directory, "README.md"), "the live turn's target\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it(
    "runs one real coder turn and observes its files",
    async () => {
      expect(
        MODEL,
        "set COMPOSER_PI_MODEL=provider/model for the live run",
      ).toBeDefined();

      const engine = new PiEngine();
      const events: AgentTurnEvent[] = [];

      const outcome = await engine.run(
        {
          projectId: "pi-live",
          sessionId: "pi-live-thread",
          projectDirectory: directory,
          prompt: LIVE_PROMPT,
          serverUrl: "http://composer.test",
          agentName: "composer-coder",
          model: MODEL,
          timeoutMs: TURN_TIMEOUT_MS,
        },
        (event) => events.push(event),
      );

      expect(outcome.ok, outcome.error).toBe(true);
      expect(outcome.engineSessionId).toBeDefined();

      // Streaming: at least one delta and a durable completion.
      expect(
        events.some((event) => event.kind === "messageDelta"),
        "expected streamed text deltas",
      ).toBe(true);
      const complete = events.find((event) => event.kind === "messageComplete");
      expect(complete).toBeDefined();

      // Usage: the turn reported its token accounting.
      const usage = events.find((event) => event.kind === "usage");
      expect(usage).toBeDefined();
      expect(usage?.tokens.output ?? 0).toBeGreaterThan(0);

      // Tool activity: the write call announced and settled.
      expect(
        events.some(
          (event) => event.kind === "toolCall" && event.toolName === "write",
        ),
        "expected a write tool call",
      ).toBe(true);

      // File observations: the write-tool file is present, and every
      // working-tree change git sees is in the turn's final observation
      // (the shell-created file rides this channel), with git-computed
      // counts.
      const observed = [...events]
        .reverse()
        .find((event) => event.kind === "files");
      expect(observed).toBeDefined();
      if (observed?.kind !== "files") return;
      const byPath = new Map(observed.files.map((file) => [file.path, file]));

      expect(byPath.has("hello.txt"), `${[...byPath.keys()].join(", ")}`).toBe(
        true,
      );
      const changed = git(["status", "--porcelain", "--untracked-files=all"])
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3));
      expect(changed.length).toBeGreaterThan(0);
      for (const path of changed) {
        const file = byPath.get(path);
        expect(file, `${path} missing from the observation`).toBeDefined();
        expect(
          (file?.additions ?? 0) + (file?.deletions ?? 0),
          `${path} carries no git counts`,
        ).toBeGreaterThan(0);
      }

      // The files really exist on disk.
      expect(readFileSync(join(directory, "hello.txt"), "utf8")).toContain(
        "hello",
      );
      expect(readFileSync(join(directory, "shell.txt"), "utf8")).toContain(
        "shell",
      );

      engine.close();
    },
    TURN_TIMEOUT_MS,
  );
});