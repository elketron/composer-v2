// The serve HTTP client (SRV-006): the per-chat session bookkeeping and the
// session/prompt/abort requests against a `ServeHandle`. Turn policy (the
// idle/error poll, the 404 recreation) stays in `serve.ts`'s engine `run`.

import type { AgentTurnSpec } from './types.js';
import type { ServeHandle } from './serve-process.js';

export class OpenCodeServeClient {
  private readonly sessions = new Map<string, string>();

  /**
   * Resolves the chat's opencode session id, reusing the recorded one when
   * it still exists and creating a fresh one otherwise.
   */
  async ensureSession(serve: ServeHandle, spec: AgentTurnSpec): Promise<string> {
    const known = spec.engineSessionId ?? this.sessions.get(spec.sessionId);
    if (known !== undefined) {
      const exists = await fetch(`${serve.base}/session/${known}`, { signal: AbortSignal.timeout(5_000) });
      if (exists.ok) return known;
      this.sessions.delete(spec.sessionId);
    }
    const created = await fetch(`${serve.base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `composer:${spec.sessionId}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) {
      throw new Error(`opencode session creation failed with ${created.status}`);
    }
    const session = (await created.json()) as { id: string };
    this.sessions.set(spec.sessionId, session.id);
    return session.id;
  }

  /** POSTs the turn's prompt; the caller interprets the status (204 or 404 …). */
  async prompt(serve: ServeHandle, sessionId: string, spec: AgentTurnSpec): Promise<Response> {
    return fetch(`${serve.base}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: spec.prompt }],
        agent: spec.agentName,
        ...(spec.model !== undefined && spec.model.includes('/') ? { model: toModel(spec.model) } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async abort(serve: ServeHandle, spec: AgentTurnSpec): Promise<void> {
    const sessionId = this.sessions.get(spec.sessionId);
    if (sessionId === undefined) return;
    try {
      await fetch(`${serve.base}/session/${sessionId}/abort`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The turn's poll loop notices an idle/error state regardless.
    }
  }

  /** Drops the recorded session (a stale runtime — the caller recreates once). */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function toModel(model: string): { providerID: string; modelID: string } {
  const at = model.indexOf('/');
  return at < 0
    ? { providerID: model, modelID: model }
    : { providerID: model.slice(0, at), modelID: model.slice(at + 1) };
}