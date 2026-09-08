// The HTTP route modules' shared environment: one per-resource `register`
// receives these and attaches its routes to the router.

import type { Bus } from '../bus.js';
import type { Processor } from '../processor/index.js';
import type { EventStore } from '../store/index.js';
import type { KnowledgeStore } from '../knowledge.js';
import type { Hono } from 'hono';

export interface HttpDeps {
  bus: Bus;
  processor: Processor;
  store?: EventStore;
  knowledge?: KnowledgeStore;
}

export type RouteRegistrar = (app: Hono, deps: HttpDeps) => void;
