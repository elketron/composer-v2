import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  piCustomTools,
  piPlannerTools,
} from "../src/engine/pi-tools.js";
import type { AgentTurnSpec } from "../src/engine/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const specOf = (overrides: Partial<AgentTurnSpec> = {}): AgentTurnSpec => ({
  sessionId: "session-1",
  prompt: "unused",
  serverUrl: "http://composer.test",
  agentName: "composer-planner",
  mcpTools: "none",
  timeoutMs: 1_000,
  ...overrides,
});

describe("pi custom tools", () => {
  it("exposes the per-mode tool sets", () => {
    const planner = piCustomTools({ ...specOf(), mcpTools: "planner" });
    expect(planner.map((tool) => tool.name)).toEqual([
      "edit_plan",
      "create_tickets",
    ]);

    const worker = piCustomTools({
      ...specOf({ agentName: "composer-coder", projectId: "P-1", mcpTools: "worker" }),
    });
    expect(worker.map((tool) => tool.name)).toEqual([
      "report_outcome",
      "workflow_start_recording",
      "workflow_add_step",
      "workflow_stop_recording",
      "workflow_search",
      "workflow_read",
    ]);

    const assistant = piCustomTools({
      ...specOf({ agentName: "composer-assistant", mcpTools: "assistant" }),
    });
    expect(assistant.map((tool) => tool.name)).toEqual([
      "composer_overview",
      "composer_card",
      "composer_plan",
      "knowledge_search",
      "list_files",
      "read_file",
      "git_status",
      "git_log",
      "git_diff",
      "web_fetch",
      "propose_cards",
      "knowledge_save",
    ]);

    expect(piCustomTools(specOf())).toEqual([]);
  });

  it("applies the planner's edits to the fixed plan document only", async () => {
    const directory = mkdtempSync(`${tmpdir()}/pi-tools-`);
    const planPath = `${directory}/plan.md`;
    writeFileSync(planPath, "# Plan\n\n- [ ] first task\n- [ ] second task\n");
    const tools = piPlannerTools({ ...specOf(), mcpTools: "planner", planDocumentPath: planPath });
    const editPlan = tools[0];

    const outcome = await editPlan.execute(
      "call-1",
      { edits: [{ oldText: "first task", newText: "the first, finished task" }] },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse(outcome.content[0]?.text ?? "{}")).toEqual({ ok: true, updated: true });
    expect(readFileSync(planPath, "utf8")).toBe(
      "# Plan\n\n- [ ] the first, finished task\n- [ ] second task\n",
    );

    // A missing oldText rejects instead of writing.
    await expect(
      editPlan.execute(
        "call-2",
        { edits: [{ oldText: "absent", newText: "x" }] },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/oldText not found/);
    expect(readFileSync(planPath, "utf8")).toContain("the first, finished task");

    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects plan edits without a plan document and empty edit lists", async () => {
    const [editPlan] = piPlannerTools({ ...specOf(), mcpTools: "planner" });
    await expect(
      editPlan.execute("call-1", { edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/no plan document/);

    const [withPath] = piPlannerTools({
      ...specOf(),
      mcpTools: "planner",
      planDocumentPath: "/tmp/composer-tests/nonexistent-plan.md",
    });
    await expect(
      withPath.execute("call-1", { edits: [] }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/non-empty list/);
    await expect(
      withPath.execute("call-2", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow(/pass edits or the complete document/);
  });

  it("seeds an empty plan document in whole-document mode", async () => {
    const directory = mkdtempSync(`${tmpdir()}/pi-tools-`);
    const planPath = `${directory}/plan.md`;
    writeFileSync(planPath, "");
    const [editPlan] = piPlannerTools({ ...specOf(), mcpTools: "planner", planDocumentPath: planPath });

    const document = "# Plan\n\n#[Set up the repo]\n\n---\ncardType: coding\n---\n\nBootstrap the repository.\n";
    await editPlan.execute("call-1", { document }, undefined, undefined, undefined as never);
    expect(readFileSync(planPath, "utf8")).toBe(document);

    await expect(
      editPlan.execute(
        "call-2",
        { document: "# Plan", edits: [{ oldText: "a", newText: "b" }] },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/not both/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("routes worker and assistant calls to their composer routes verbatim", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        calls.push({ url: String(url), body });
        return new Response(JSON.stringify({ ok: true, echoed: true }), { status: 200 });
      }),
    );

    const worker = piCustomTools({
      ...specOf({ agentName: "composer-coder", projectId: "P-1", mcpTools: "worker" }),
    });
    const report = worker.find((tool) => tool.name === "report_outcome");
    expect(report).toBeDefined();
    const outcome = await report?.execute(
      "call-1",
      { outcome: "approved", note: "ships" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse(outcome?.content[0]?.text ?? "{}")).toEqual({ ok: true, echoed: true });
    expect(calls[0]).toEqual({
      url: "http://composer.test/mcp/worker",
      body: { projectId: "P-1", sessionId: "session-1", tool: "report_outcome", args: { outcome: "approved", note: "ships" } },
    });

    const assistant = piCustomTools({ ...specOf({ agentName: "composer-assistant", mcpTools: "assistant" }) });
    const overview = assistant.find((tool) => tool.name === "composer_overview");
    await overview?.execute("call-2", { projectId: "P-1" }, undefined, undefined, undefined as never);
    expect(calls[1]).toEqual({
      url: "http://composer.test/mcp/read",
      body: { threadId: "session-1", tool: "composer_overview", args: { projectId: "P-1" } },
    });
  });

  it("throws routed rejections and transport failures as tool errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "Unknown project P-404" }), { status: 200 })),
    );
    const [editPlan, createTickets] = piPlannerTools({
      ...specOf({ mcpTools: "planner", projectId: "P-1" }),
      planDocumentPath: writeTempPlan(),
    });
    await expect(
      createTickets.execute("call-1", { pipelineId: "PL-1" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("Unknown project P-404");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(
      createTickets.execute("call-2", { pipelineId: "PL-1" }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/unreachable|composer returned/);

    // The plan editor never touches the network — the transport failure
    // above rode create_tickets.
    expect(editPlan.name).toBe("edit_plan");
  });
});

function writeTempPlan(): string {
  const planPath = `${mkdtempSync(`${tmpdir()}/pi-tools-`)}/plan.md`;
  writeFileSync(planPath, "# Plan\n");
  return planPath;
}