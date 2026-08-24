/**
 * The sync simulator's entry point (PLAN.md §15.3).
 *
 * Import from here rather than from the individual modules: `sim.ts` is the
 * only file that is meant to be constructed directly, and the rest are its
 * parts. Nothing under `sim/` imports `players/index.ts` — that barrel pulls in
 * the `'use client'` YouTube adapter, and the simulator must run in plain Node.
 */
export { SyncSim, WARMUP_MS, classifyConflicts } from './sim';
export { SimServer } from './server';
export { SimClient } from './client';
export { Link, DEFAULT_LATENCY_MS } from './link';
export { VirtualScheduler } from './scheduler';
export { chance, hashString, mulberry32, stream, symmetric } from './rng';
export type { Rng } from './rng';
export type { ControlRecord, VideoStatePayload, SimServerOptions } from './server';
export type { SimClientOptions } from './client';
export type { LinkSpec } from './link';
export type {
  ConflictOutcome,
  SimClientResult,
  SimClientSpec,
  SimOutageSpec,
  SimResult,
  SimSample,
  SimScriptStep,
  SimStallSpec,
  SyncSimOptions,
} from './types';
