/**
 * Prometheus metrics (PLAN.md §16.5).
 *
 * These are deliberately product metrics, not generic APM. `ss_video_drift_seconds`
 * is the one that tells you whether the product actually works; everything else
 * tells you why it stopped working.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import type { ControlRejectReason } from '@syncstudy/shared';

export const registry = new Registry();

// Event-loop lag, heap, GC, handles. `nodejs_eventloop_lag_p99` is the canary.
collectDefaultMetrics({ register: registry, prefix: '' });

export const socketConnections = new Gauge({
  name: 'ss_socket_connections',
  help: 'Open Socket.IO connections on this node',
  registers: [registry],
});

export const roomsActive = new Gauge({
  name: 'ss_rooms_active',
  help: 'Rooms with at least one socket on this node',
  registers: [registry],
});

export const participantsPerRoom = new Histogram({
  name: 'ss_participants_per_room',
  help: 'Participant count observed at each room join/leave — validates the mesh caps',
  buckets: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 25],
  registers: [registry],
});

export const videoDriftSeconds = new Histogram({
  name: 'ss_video_drift_seconds',
  help: 'Client-reported |drift| against the authoritative anchor',
  buckets: [0.05, 0.1, 0.25, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10],
  registers: [registry],
});

export const hardSeeksTotal = new Counter({
  name: 'ss_hard_seeks_total',
  help: 'Client-reported hard seeks — drift-correction pressure',
  registers: [registry],
});

export const controlRejectedTotal = new Counter<'reason'>({
  name: 'ss_control_rejected_total',
  help: 'Video control commands rejected, by reason',
  labelNames: ['reason'],
  registers: [registry],
});

export const clockOffsetMs = new Histogram({
  name: 'ss_clock_offset_ms',
  help: 'Client-reported |clock offset| — detects a broken offset estimator',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});

export const eventLatencyMs = new Histogram<'event'>({
  name: 'ss_event_latency_ms',
  help: 'Socket handler wall time',
  labelNames: ['event'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

export const redisTransactMs = new Histogram({
  name: 'ss_redis_transact_ms',
  help: 'Lua transact round-trip — Lua script health',
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

export const rateLimitHitsTotal = new Counter<'event'>({
  name: 'ss_ratelimit_hits_total',
  help: 'Rate-limit breaches, by event — abuse detection',
  labelNames: ['event'],
  registers: [registry],
});

export const handlerErrorsTotal = new Counter<'event'>({
  name: 'ss_handler_errors_total',
  help: 'Handler throws caught by the safety wrapper',
  labelNames: ['event'],
  registers: [registry],
});

/** Typed helper so a typo in a reason label cannot silently create a new series. */
export function recordControlRejection(reason: ControlRejectReason): void {
  controlRejectedTotal.inc({ reason });
}

export function observeEventLatency(event: string, startedAt: number): void {
  eventLatencyMs.observe({ event }, Date.now() - startedAt);
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
