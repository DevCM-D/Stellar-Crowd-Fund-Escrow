/**
 * Prisma Client Singleton with Connection Pooling and Monitoring
 *
 * Reuses a single PrismaClient instance across the app to avoid
 * exhausting the DB connection pool on hot reloads.
 *
 * Connection pool sizing:
 *   - Pool size is controlled via the `connection_limit` query parameter on
 *     DATABASE_URL (e.g. postgresql://...?connection_limit=20&pool_timeout=10).
 *   - The default Prisma pool size is num_cpus * 2 + 1, which is often too small
 *     under concurrent milestone-approval workloads. Set DATABASE_URL with an
 *     explicit connection_limit appropriate for your Postgres max_connections.
 *   - PRISMA_CONNECTION_LIMIT env var is applied when DATABASE_URL does not
 *     already contain a connection_limit parameter.
 */

import { PrismaClient } from '@prisma/client';
import { attachConnectionMonitoring, startConnectionMonitoring } from './connectionMonitor.js';
import { attachRetryMiddleware } from './retryUtils.js';
import { DEFAULT_TENANT_ID, getCurrentTenantId, isTenantScopeBypassed } from './tenantContext.js';

const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '500', 10);

/**
 * Append connection pool parameters to DATABASE_URL if not already set.
 * This ensures the shared singleton uses an explicit pool limit rather than
 * relying on Prisma's per-process default.
 */
function resolveDbUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) return url;
  if (url.includes('connection_limit=')) return url;
  const limit = parseInt(process.env.PRISMA_CONNECTION_LIMIT || '20', 10);
  const timeout = parseInt(process.env.PRISMA_POOL_TIMEOUT || '10', 10);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}connection_limit=${limit}&pool_timeout=${timeout}`;
}

const globalForPrisma = globalThis;

const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Escrow',
  'Milestone',
  'ReputationRecord',
  'Dispute',
  'DisputeEvidence',
  'DisputeAppeal',
  'UserProfile',
  'ContractEvent',
  'Payment',
  'KycVerification',
  'WebhookSubscription',
  'WebhookDelivery',
  'AdminAuditLog',
  'AuditLog',
]);

const READ_MANY_ACTIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

function mergeTenantWhere(where, tenantId) {
  if (!tenantId) return where;
  if (!where || Object.keys(where).length === 0) return { tenantId };
  if (where.tenantId === tenantId) return where;
  return { AND: [where, { tenantId }] };
}

function createPrismaClient() {
  const dbUrl = resolveDbUrl();
  const base = new PrismaClient({
    datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['error'],
    errorFormat: 'minimal',
  });

  if (process.env.NODE_ENV === 'development') {
    base.$on('query', (e) => {
      if (e.duration > SLOW_QUERY_MS) {
        console.warn(`[Prisma] Slow query (${e.duration}ms): ${e.query}`);
      }
    });
  }

  // Replace deprecated $use middleware with $extends query extension (Prisma 5+)
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tenantId = getCurrentTenantId();

          if (!tenantId || isTenantScopeBypassed() || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          args ??= {};

          if (READ_MANY_ACTIONS.has(operation)) {
            args.where = mergeTenantWhere(args.where, tenantId);
          }

          if (operation === 'findUnique') {
            // $extends doesn't allow changing operation name, so we use findFirst
            // by passing the where clause — Prisma handles this transparently
            args.where = mergeTenantWhere(args.where, tenantId);
          }

          if (operation === 'findUniqueOrThrow') {
            args.where = mergeTenantWhere(args.where, tenantId);
          }

          if (operation === 'create') {
            args.data = {
              ...args.data,
              tenantId: args.data?.tenantId ?? tenantId ?? DEFAULT_TENANT_ID,
            };
          }

          if (operation === 'createMany' && Array.isArray(args.data)) {
            args.data = args.data.map((entry) => ({
              ...entry,
              tenantId: entry.tenantId ?? tenantId ?? DEFAULT_TENANT_ID,
            }));
          }

          if (operation === 'upsert') {
            args.create = {
              ...args.create,
              tenantId: args.create?.tenantId ?? tenantId ?? DEFAULT_TENANT_ID,
            };
          }

          return query(args);
        },
      },
    },
  });
}

const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Attach connection monitoring and retry middleware
attachConnectionMonitoring(prisma);
attachRetryMiddleware(prisma);

export { startConnectionMonitoring };
export default prisma;
