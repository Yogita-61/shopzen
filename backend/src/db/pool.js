import pg from 'pg';
import Redis from 'ioredis';
import 'dotenv/config';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 30), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
pool.on('error', e => console.error('postgres idle client error', e));
export const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: n => Math.min(n * 250, 3000) }) : null;
if (redis) redis.on('error', e => console.warn('redis unavailable; using database fallback:', e.message));
export async function health() {
  const db = await pool.query('SELECT 1'); let cache = 'disabled';
  if (redis) { try { await redis.ping(); cache = 'ready'; } catch { cache = 'degraded'; } }
  return { database: 'ready', cache };
}
