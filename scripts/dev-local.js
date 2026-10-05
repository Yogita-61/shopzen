import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.local', 'shopzen-live');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this through npm run dev so npm can locate its script runner.');

await mkdir(dataDir, { recursive: true });
const db = await PGlite.create(dataDir);
const postgres = new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1', maxConnections: 1 });
await postgres.start();
console.log('ShopZen local PostgreSQL is ready on 127.0.0.1:5432 (persistent dev data in .local/shopzen-live).');

const env = { ...process.env, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/postgres', PG_POOL_MAX: '1', REDIS_URL: '' };
async function runNpm(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited with status ${code}`)));
  });
}

let services;
let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  if (services && services.exitCode === null) services.kill('SIGTERM');
  await postgres.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  await runNpm(['run', 'migrate', '--workspace', 'backend']);
  await runNpm(['run', 'seed', '--workspace', 'backend']);
  services = spawn(process.execPath, [npmCli, 'run', 'dev:services'], { cwd: root, env, stdio: 'inherit' });
  services.once('error', err => { console.error(err); shutdown(1); });
  services.once('exit', code => shutdown(code ?? 0));
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
