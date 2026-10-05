import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from './pool.js';
const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
try { await pool.query(sql); console.log('ShopZen schema migrated.'); } finally { await pool.end(); }
