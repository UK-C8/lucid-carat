import { Pool, PoolClient } from "pg";

// Two pools:
//   APP_POOL — connects as lucidcarat_app; RLS is enforced. All user-facing queries go here.
//   SVC_POOL — connects as DB owner; bypasses RLS. Reserved for auth lookup and admin ops
//              that run before a tenant context is established (e.g. login).

let appPool: Pool | null = null;
let svcPool: Pool | null = null;

function getAppPool(): Pool {
  if (!appPool) {
    appPool = new Pool({
      connectionString:
        process.env.LC_APP_DATABASE_URL ??
        "postgresql://lucidcarat_app:lucidcarat_app_dev@localhost/lucidcarat_dev",
    });
  }
  return appPool;
}

function getSvcPool(): Pool {
  if (!svcPool) {
    svcPool = new Pool({
      connectionString:
        process.env.LC_DATABASE_URL ??
        "postgresql://urvilkargathala@localhost/lucidcarat_dev",
    });
  }
  return svcPool;
}

/** Owner-level query — bypasses RLS. Use only for auth and platform-level ops. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getSvcPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Tenant-scoped query — connects as lucidcarat_app and sets
 * app.current_tenant_id for the duration of the transaction.
 * RLS policies enforce that only rows belonging to tenantId are visible.
 */
export async function queryAsTenant<T = Record<string, unknown>>(
  tenantId: string,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const client: PoolClient = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, TRUE)",
      [tenantId]
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
