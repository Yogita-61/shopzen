import 'dotenv/config';
import { pool } from '../src/db/pool.js';

try {
  const product = (await pool.query("SELECT id FROM products WHERE sku='FLASH-NOVA-001'")).rows[0];
  if (!product) throw new Error('Flash sale not found. Run the database seed first.');
  await pool.query('BEGIN');
  try {
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM reservations WHERE product_id=$1) OR aggregate_id IN (SELECT p.id FROM payments p JOIN reservations r ON r.id=p.reservation_id WHERE r.product_id=$1) OR aggregate_id IN (SELECT o.id FROM orders o JOIN reservations r ON r.id=o.reservation_id WHERE r.product_id=$1)`, [product.id]);
    await pool.query("DELETE FROM idempotency WHERE scope='buy-now' AND (user_id,key) IN (SELECT user_id,idempotency_key FROM reservations WHERE product_id=$1)", [product.id]);
    await pool.query('DELETE FROM shipments s USING orders o WHERE s.order_id=o.id AND o.reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
    await pool.query('DELETE FROM order_items oi USING orders o WHERE oi.order_id=o.id AND o.reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
    await pool.query('DELETE FROM orders WHERE reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
    await pool.query('DELETE FROM payments WHERE reservation_id IN (SELECT id FROM reservations WHERE product_id=$1)', [product.id]);
    await pool.query('DELETE FROM reservations WHERE product_id=$1', [product.id]);
    await pool.query('UPDATE inventory SET available=100,reserved=0,sold=0,updated_at=now() WHERE product_id=$1', [product.id]);
    await pool.query('COMMIT');
    console.log('Flash sale history cleared and inventory restored to 100.');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await pool.end(); }
