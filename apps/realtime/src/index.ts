/**
 * The realtime service entry point.
 *
 * Deliberately thin: parse the environment, start the server, wire the signals.
 * Everything else is in `server.ts` behind `createServer()`, so an integration
 * suite can start the same server on an ephemeral port and shut it down again
 * (§15.1). A module that starts listening as a side effect of being imported
 * cannot be tested, which is why this file no longer does.
 */
import { loadConfig, type Config } from './config.js';
import { createServer } from './server.js';

// Fail fast, with a message a human can act on, before anything else starts.
// A node that boots without REDIS_URL and only finds out on the first join has
// already taken the outage; refusing to start fails the deploy instead.
function bootConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

const server = createServer(bootConfig());
await server.listen();

let exiting = false;

async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;

  // The backstop for a drain that hangs — a Postgres that has stopped answering
  // must not keep a machine in rotation forever.
  const hardExit = setTimeout(() => {
    server.log.error('graceful shutdown timed out; exiting');
    process.exit(1);
  }, 20_000);
  hardExit.unref();

  try {
    await server.shutdown(signal);
    clearTimeout(hardExit);
    process.exit(0);
  } catch (err) {
    server.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // Logged, not fatal: one dropped promise must not end 200 sessions.
  server.log.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // The process state is no longer trustworthy. Log it, then let the platform
  // restart us — clients reconnect and resync.
  server.log.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});
