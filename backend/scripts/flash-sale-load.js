import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import jwt from 'jsonwebtoken';

const count = Number(process.env.LOAD_USERS || 10000);
const concurrency = Number(process.env.LOAD_CONCURRENCY || 500);
const reset = process.argv.includes('--reset');

try {
  const product = (await pool.query("SELECT p.id,p.name,i.available,i.reserved,i.sold FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.sku='FLASH-NOVA-001'")).rows[0];
  if (!product) throw new Error('Flash sale missing. Run npm run db:seed.');

  if (reset) {
    await pool.query('BEGIN');
    try {
      await pool.query(`DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM reservations WHERE product_id=$1) OR aggregate_id IN (SELECT p.id FROM payments p JOIN reservations r ON r.id=p.reservation_id WHERE r.product_id=$1) OR aggregate_id IN (SELECT o.id FROM orders o JOIN reservations r ON r.id=o.reservation_id WHERE r.product_id=$1)`, [product.id]);
      await pool.query("DELETE FROM idempotency WHERE scope='buy-now' AND (user_id,key) IN (SELECT user_id,idempotency_key FROM reservations WHERE product_id=$1)", [product.id]);
      await pool.query('DELETE FROM shipments s USING orders o WHERE s.order_id=o.id AND o.reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
      await pool.query('DELETE FROM order_items oi USING orders o WHERE oi.order_id=o.id AND o.reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
      await pool.query('DELETE FROM orders WHERE reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
      await pool.query('DELETE FROM payments WHERE reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
      await pool.query('DELETE FROM reservations WHERE product_id=$1', [product.id]);
      await pool.query('UPDATE inventory SET available=100,reserved=0,sold=0 WHERE product_id=$1', [product.id]);
      await pool.query('COMMIT');
    } catch (e) { await pool.query('ROLLBACK'); throw e; }
  } else if (Number(product.available) !== 100 || Number(product.reserved) !== 0 || Number(product.sold) !== 0) {
    throw new Error(`Flash stock is not pristine (available=${product.available}, reserved=${product.reserved}, sold=${product.sold}). Run with --reset to clear this demo flash-sale's history and restore its 100 units.`);
  }

  const user = (await pool.query("SELECT id,name,email,role FROM users WHERE email='hello@shopzen.demo'")).rows[0];
  if (!user) throw new Error('Run npm run db:seed to create the demo buyer.');
  const token = jwt.sign(user, process.env.JWT_SECRET || 'local-demo-secret-change-before-deploy', { expiresIn: '15m' });
  const base = `http://localhost:${process.env.PORT || 4000}`;
  const statuses = new Map(); let next = 0;

  async function runner() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      try {
        const response = await fetch(`${base}/api/reservations`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `load-${process.pid}-${i}-${crypto.randomUUID()}` }, body: JSON.stringify({ productId: product.id, quantity: 1 }) });
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        await response.arrayBuffer();
      } catch { statuses.set('NETWORK_ERROR', (statuses.get('NETWORK_ERROR') || 0) + 1); }
    }
  }

  const start = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, runner));
  const elapsed = Number(((Date.now() - start) / 1000).toFixed(2));
  const stock = (await pool.query('SELECT available,reserved,sold FROM inventory WHERE product_id=$1', [product.id])).rows[0];
  const success = statuses.get(201) || 0, oversell = Math.max(0, success - 100);
  const report = { scenario: `${count.toLocaleString()} simultaneous Buy Now requests`, concurrency, elapsedSeconds: elapsed, responses: Object.fromEntries(statuses), successfulReservations: success, stock, overselling: oversell, proof: success <= 100 && Number(stock.available) >= 0 && oversell === 0 ? 'PASS' : 'FAIL' };
  console.log(JSON.stringify(report, null, 2));
  if (report.proof === 'FAIL') process.exitCode = 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
