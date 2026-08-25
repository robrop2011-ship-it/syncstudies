/**
 * A tiny read-only console against the dev database.
 *
 *   cd apps/realtime
 *   npx tsx --env-file=.env scripts/psql.mjs noteItem '{"take":5}'
 *   npx tsx --env-file=.env scripts/psql.mjs roomEvent '{"where":{"type":"feedback"}}'
 *
 * Run it with tsx: @syncstudy/db uses extensionless relative imports (ADR 0002),
 * which Node's own ESM resolver rejects.
 */
import { prisma } from '@syncstudy/db';

const [model, argsJson] = process.argv.slice(2);
const client = prisma[model];
if (client === undefined) {
  console.error(`no such model: ${model}`);
  process.exit(1);
}
const args = argsJson === undefined ? {} : JSON.parse(argsJson);
console.log(JSON.stringify(await client.findMany(args), (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
await prisma.$disconnect();
