import { pool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

export async function reserve(userId, productId, quantity = 1, key) {
 if (!key) { const e = new Error('Idempotency-Key header is required'); e.status = 400; throw e; }
 if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) { const e = new Error('Quantity must be between 1 and 5'); e.status=400; throw e; }
 const c = await pool.connect();
 try {
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${userId}:${key}`]);
  const prior = await c.query('SELECT r.*,p.name,p.price_cents,p.image_url FROM reservations r JOIN products p ON p.id=r.product_id WHERE r.user_id=$1 AND r.idempotency_key=$2 FOR UPDATE',[userId,key]);
  if (prior.rowCount) { await c.query('COMMIT'); return prior.rows[0]; }
  const stock = await c.query('UPDATE inventory SET available=available-$2,reserved=reserved+$2,updated_at=now() WHERE product_id=$1 AND available >= $2 RETURNING available,reserved',[productId,quantity]);
  if (!stock.rowCount) { const e = new Error('This item just sold out. Take a look at similar finds.'); e.status=409; e.code='OUT_OF_STOCK'; throw e; }
  const product = await c.query('SELECT name,price_cents,image_url FROM products WHERE id=$1 AND active=true',[productId]);
  if (!product.rowCount) throw Object.assign(new Error('Product not found'),{status:404});
  const expiry = new Date(Date.now()+Number(process.env.RESERVATION_TTL_SECONDS||300)*1000);
  const r = await c.query(`INSERT INTO reservations(user_id,product_id,quantity,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`,[userId,productId,quantity,key,expiry]);
  await c.query('INSERT INTO idempotency(scope,user_id,key,response) VALUES($1,$2,$3,$4)', ['buy-now',userId,key,JSON.stringify({reservationId:r.rows[0].id})]);
  await c.query('COMMIT'); return {...r.rows[0],...product.rows[0]};
 } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function expireReservations() {
 const c=await pool.connect();
 try { await c.query('BEGIN');
  const expired=await c.query(`SELECT id,product_id,quantity FROM reservations r WHERE status IN ('RESERVED','PAYMENT_PENDING') AND expires_at < now() AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=r.id AND p.status='SUCCESS') ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 250`);
  for(const r of expired.rows){
   await c.query("UPDATE reservations SET status='EXPIRED' WHERE id=$1",[r.id]);
   await c.query('UPDATE inventory SET available=available+$2,reserved=GREATEST(0,reserved-$2),updated_at=now() WHERE product_id=$1',[r.product_id,r.quantity]);
   await c.query("UPDATE payments SET status='TIMEOUT',updated_at=now() WHERE reservation_id=$1 AND status='PENDING'",[r.id]);
   await c.query("UPDATE orders SET status='CANCELLED',updated_at=now() WHERE reservation_id=$1 AND status='PAYMENT_PENDING'",[r.id]);
  }
  await c.query('COMMIT'); return expired.rowCount;
 } catch(e){await c.query('ROLLBACK');throw e} finally{c.release()}
}
export const newKey=()=>randomUUID();
