// Composer v2 server: one process, many projects. Boot order: open the
// store → rehydrate every registered project's log into the fold → serve.
// The chosen address: $COMPOSER_HTTP_ADDR, else 127.0.0.1:5214 (the v1
// default). Data: $COMPOSER_DATA_DIR, else ~/.local/share/composer-v2.

import { serve } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Bus } from './bus.js';
import { EventStore } from './store/index.js';
import { Processor } from './processor/index.js';
import { router } from './http/index.js';
import { KnowledgeStore } from './knowledge.js';
import { listOpenCodeModels } from './models.js';
import { PlanningOrchestrator, resumeStrandedTurns } from './planning.js';
import { AssistantOrchestrator, resumeStrandedThreads } from './assistant.js';
import { PipelineRunner } from './runner/index.js';
import { cancelInterruptedRuns, seedDefaultPipelines } from './pipelines.js';
import { FakeEngine } from './engine/fake.js';
import { OpenCodeServeEngine } from './engine/serve.js';
import type { AgentEngine } from './engine/types.js';
import type { ComposerCaller } from './agents/planner/index.js';

export interface Config {
  addr: string;
  dataDir: string;
  /** Test/dev hook: build the agent engine over the booted processor. */
  engineFactory?: (caller: ComposerCaller) => AgentEngine;
  /** Off switch for the planning turn (the v1 PLANNER_ENABLED kill switch). */
  plannerEnabled?: boolean;
  /** Off switch for the global assistant turn. */
  assistantEnabled?: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    addr: env['COMPOSER_HTTP_ADDR'] ?? '127.0.0.1:5214',
    dataDir: env['COMPOSER_DATA_DIR'] ?? defaultDataDir(env),
  };
}

/**
 * The default data home per platform (packaged desktops): XDG on Linux,
 * %APPDATA% on Windows (the packaged app sets COMPOSER_DATA_DIR itself
 * when it wants a private dir — this default serves bare `node dist`).
 */
function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const appData = env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'composer-v2');
  }
  return join(homedir(), '.local', 'share', 'composer-v2');
}

export async function boot(config: Config): Promise<{
  close: () => Promise<void>;
  url: string;
  stopPlanning: () => void;
}> {
  const store = new EventStore();
  await store.connect(config.dataDir);
  const bus = new Bus(store);
  const rehydrated = await bus.rehydrate();
  const knowledge = new KnowledgeStore(config.dataDir);
  const processor = new Processor(bus, knowledge);

  // t10: a restart drops in-flight turns; tell the stranded sessions (and
  // the desktop's send-lock) before anything listens.
  const resumed = await resumeStrandedTurns(bus);
  const resumedThreads = await resumeStrandedThreads(bus);

  // D5: a restart ends non-terminal runs `cancelled`; the default coding
  // pipeline seeds every project that has neither it nor its tombstone
  // (including projects created while the server runs).
  const cancelled = await cancelInterruptedRuns(bus);
  await seedDefaultPipelines(bus.state, bus);

  const [hostname, port] = config.addr.includes(':')
    ? (config.addr.split(':') as [string, string])
    : ['127.0.0.1', config.addr];
  const server = serve({
    fetch: router(bus, processor, store, knowledge, listOpenCodeModels).fetch,
    hostname,
    port: Number(port),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : Number(port);
  const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${boundPort}`;

  // The engine (real opencode, or the scripted fake) is shared by the
  // planning turn and the pipeline runner. The kill switches gate only the
  // planners; user-authored pipelines always run.
  const plannerEnabled = config.plannerEnabled ?? process.env['COMPOSER_PLANNER_ENABLED'] !== '0';
  const assistantEnabled =
    config.assistantEnabled ?? process.env['COMPOSER_ASSISTANT_ENABLED'] !== '0';
  const makeEngine = (): AgentEngine =>
    config.engineFactory?.(processor) ??
    (process.env['COMPOSER_FAKE_ENGINE'] === '1'
      ? new FakeEngine(processor)
      : new OpenCodeServeEngine());
  let stopPlanning: () => void = () => undefined;
  let stopAssistant: () => void = () => undefined;
  let stopRunner: () => void = () => undefined;
  let closeAssistantEngine: (() => void) | undefined;
  let closeEngine: (() => void) | undefined;
  {
    const engine = makeEngine();
    closeEngine = () => engine.close?.();
    if (plannerEnabled) {
      const orchestrator = new PlanningOrchestrator(bus, engine, {
        serverUrl: url,
        mcpScriptPath: mcpScriptPath(),
        getModel: () => store.getSettings(),
      });
      orchestrator.start();
      stopPlanning = () => orchestrator.stop();
    }
    if (assistantEnabled) {
      // The assistant streams: its turn runs on a long-lived `opencode
      // serve` per thread whose SSE feed carries token deltas (the `run`
      // command buffers a turn's text). The kill switch falls back to the
      // shared run engine.
      const assistantEngine: AgentEngine =
        config.engineFactory !== undefined || process.env['COMPOSER_ASSISTANT_SERVE'] === '0'
          ? engine
          : new OpenCodeServeEngine();
      const workspaceDir = join(config.dataDir, 'assistant');
      const assistant = new AssistantOrchestrator(bus, assistantEngine, {
        serverUrl: url,
        mcpScriptPath: assistantMcpScriptPath(),
        workspaceDir,
        getModel: () => store.getSettings(),
      });
      assistant.start();
      stopAssistant = () => assistant.stop();
      closeAssistantEngine = () => assistantEngine.close?.();
    }
    const runner = new PipelineRunner(bus, engine, {
      serverUrl: url,
      mcpScriptPath: workerMcpScriptPath(),
      getModel: () => store.getSettings(),
    });
    runner.start();
    stopRunner = () => runner.stop();
  }

  console.log(
    `composer v2 listening on ${url}` +
      ` (replayed ${rehydrated} events, ${bus.state.projects.size} projects` +
      `${cancelled > 0 ? `, cancelled ${cancelled} interrupted run${cancelled === 1 ? '' : 's'}` : ''}` +
      `${resumed > 0 ? `, resumed ${resumed} stranded turn${resumed === 1 ? '' : 's'}` : ''}` +
      `${resumedThreads > 0 ? `, resumed ${resumedThreads} stranded thread${resumedThreads === 1 ? '' : 's'}` : ''}` +
      `)` +
      (plannerEnabled ? ' [planner: on]' : ' [planner: off]') +
      (assistantEnabled ? ' [assistant: on]' : ' [assistant: off]'),
  );
  return {
    url,
    close: async () => {
      stopRunner();
      stopPlanning();
      stopAssistant();
      closeAssistantEngine?.();
      closeEngine?.();
      // Open SSE streams count as connections; drop them so close resolves.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
    stopPlanning,
  };
}

/** The planner's MCP child script (dist/mcp/planner.js) — resolved from the src or dist layout. */
function mcpScriptPath(): string {
  return process.env['COMPOSER_MCP_SCRIPT'] ?? fileURLToPath(new URL('../dist/mcp/planner.js', import.meta.url));
}

/** The assistant's MCP child script (dist/mcp/assistant.js). */
function assistantMcpScriptPath(): string {
  return (
    process.env['COMPOSER_ASSISTANT_MCP_SCRIPT'] ??
    fileURLToPath(new URL('../dist/mcp/assistant.js', import.meta.url))
  );
}

/** The workers' MCP child script (dist/mcp/worker.js). */
function workerMcpScriptPath(): string {
  return (
    process.env['COMPOSER_WORKER_MCP_SCRIPT'] ??
    fileURLToPath(new URL('../dist/mcp/worker.js', import.meta.url))
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  const config = configFromEnv();
  boot(config).catch((error) => {
    console.error('boot failed:', error);
    process.exit(1);
  });
}
