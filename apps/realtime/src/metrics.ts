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
  // The 3 ms bucket is §15.5's target for this metric. Without it the nearest
  // boundaries are 2 and 5, so a p99 of 2.4 ms and one of 4.9 ms report
  // identically as "≤5" — and the load test could neither pass nor fail the
  // target honestly. A histogram with no bucket at the threshold you alert on
  // is a histogram that cannot answer the question you are asking it.
  buckets: [0.5, 1, 2, 3, 5, 10, 25, 50, 100, 250],
  registers: [registry],
});

export const rateLimitHitsTotal = new Counter<'event'>({
  name: 'ss_ratelimit_hits_total',
  help: 'Rate-limit breaches, by event — abuse detection',
  labelNames: ['event'],
  registers: [registry],
});

export const chatMessagesTotal = new Counter<'kind'>({
  name: 'ss_chat_messages_total',
  help: 'Chat messages broadcast, by kind (user/system)',
  labelNames: ['kind'],
  registers: [registry],
});

/**
 * Unwritten rows sitting in a write-behind queue (§6.5).
 *
 * The one to alert on. A depth that climbs and does not come back down means
 * Postgres is not keeping up, and the transcript people are reading is ahead of
 * the transcript that will survive a restart.
 */
export const writeBehindDepth = new Gauge<'queue'>({
  name: 'ss_write_behind_depth',
  help: 'Items queued for durable write, by queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const writeBehindFailuresTotal = new Counter<'queue'>({
  name: 'ss_write_behind_failures_total',
  help: 'Write-behind batches that failed and were requeued',
  labelNames: ['queue'],
  registers: [registry],
});

/** Non-zero means durable data was lost. There is no acceptable rate for this. */
export const writeBehindDroppedTotal = new Counter<'queue'>({
  name: 'ss_write_behind_dropped_total',
  help: 'Items discarded without ever reaching Postgres',
  labelNames: ['queue'],
  registers: [registry],
});

export const callParticipants = new Histogram({
  name: 'ss_call_participants',
  help: 'Mesh size observed at each rtc:join — validates the §9.1 caps',
  buckets: [1, 2, 3, 4, 5, 6, 8, 10],
  registers: [registry],
});

export const rtcSignalsTotal = new Counter<'kind'>({
  name: 'ss_rtc_signals_total',
  help: 'Signaling messages relayed, by kind',
  labelNames: ['kind'],
  registers: [registry],
});

/**
 * ICE configurations minted, split by whether this deployment can actually
 * relay. A production node reporting `stun` means TURN_SECRET is missing and
 * ~10-15% of peer pairs (§9.3) silently cannot connect.
 */
export const iceGrantsTotal = new Counter<'relay'>({
  name: 'ss_ice_grants_total',
  help: 'ICE server configurations issued, by available relay',
  labelNames: ['relay'],
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
