import { pool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

export async function beginPayment(userId,reservationId,key,mode='SUCCESS') {
 if(!key) throw Object.assign(new Error('Idempotency-Key header is required'),{status:400});
 const c=await pool.connect();
 try{await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${userId}:${key}`]);
  const old=await c.query('SELECT * FROM payments WHERE idempotency_key=$1 FOR UPDATE',[`${userId}:${key}`]);
  if(old.rowCount){await c.query('COMMIT');return old.rows[0]}
  const r=await c.query("SELECT r.*,p.price_cents FROM reservations r JOIN products p ON p.id=r.product_id WHERE r.id=$1 AND r.user_id=$2 FOR UPDATE",[reservationId,userId]);
  if(!r.rowCount||!['RESERVED','PAYMENT_PENDING'].includes(r.rows[0].status)||new Date(r.rows[0].expires_at)<new Date()) throw Object.assign(new Error('Reservation is unavailable or expired'),{status:409});
  const existingPayment=await c.query('SELECT * FROM payments WHERE reservation_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[reservationId]);if(existingPayment.rowCount){await c.query('COMMIT');return existingPayment.rows[0]}
  const m=['SUCCESS','FAILED','TIMEOUT','DUPLICATE'].includes(mode)?mode:'SUCCESS';
  const status=m==='FAILED'?'FAILED':m==='TIMEOUT'?'TIMEOUT':'PENDING';
  const ref=`sz_${randomUUID()}`;
  const p=await c.query(`INSERT INTO payments(reservation_id,provider_reference,amount_cents,status,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[reservationId,ref,r.rows[0].price_cents*r.rows[0].quantity,status,`${userId}:${key}`,JSON.stringify({mode:m})]);
  if(status==='PENDING'||status==='TIMEOUT') { await c.query("UPDATE reservations SET status='PAYMENT_PENDING' WHERE id=$1",[reservationId]); const o=await c.query("INSERT INTO orders(user_id,reservation_id,order_number,status,subtotal_cents,total_cents) VALUES($1,$2,$3,'PAYMENT_PENDING',$4,$4) RETURNING id",[userId,reservationId,`SZ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0,4).toUpperCase()}`,p.rows[0].amount_cents]); await c.query('UPDATE payments SET order_id=$2 WHERE id=$1',[p.rows[0].id,o.rows[0].id]); await c.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,$3,$4)',[o.rows[0].id,r.rows[0].product_id,r.rows[0].quantity,r.rows[0].price_cents]); if(status==='PENDING')await c.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('payment.process',$1,$2)",[p.rows[0].id,JSON.stringify({paymentId:p.rows[0].id,mode:m})]); }
  if(status==='FAILED') { await c.query("UPDATE reservations SET status='RELEASED' WHERE id=$1",[reservationId]); await c.query('UPDATE inventory SET available=available+$2,reserved=GREATEST(0,reserved-$2) WHERE product_id=$1',[r.rows[0].product_id,r.rows[0].quantity]); await c.query("INSERT INTO orders(user_id,reservation_id,order_number,status,subtotal_cents,total_cents) VALUES($1,$2,$3,'FAILED',$4,$4) ON CONFLICT(reservation_id) DO UPDATE SET status='FAILED',updated_at=now()",[userId,reservationId,`SZ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0,4).toUpperCase()}`,p.rows[0].amount_cents]); }
  if(status==='TIMEOUT') await c.query("UPDATE reservations SET status='PAYMENT_PENDING' WHERE id=$1",[reservationId]);
  await c.query('COMMIT'); return p.rows[0];
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

export async function processEvent(event) {
 const {paymentId,mode}=event.payload; const c=await pool.connect();
 try{await c.query('BEGIN'); const p=await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[paymentId]); if(!p.rowCount||p.rows[0].status!=='PENDING'){await c.query('COMMIT');return}
  const pay=p.rows[0], r=await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE',[pay.reservation_id]);
  if(!r.rowCount){await c.query('COMMIT');return}
  if(mode==='TIMEOUT'){await c.query("UPDATE payments SET status='TIMEOUT',updated_at=now() WHERE id=$1",[paymentId]); await c.query('COMMIT');return}
  if(mode==='FAILED'){await c.query("UPDATE payments SET status='FAILED',updated_at=now() WHERE id=$1",[paymentId]); if(['RESERVED','PAYMENT_PENDING'].includes(r.rows[0].status)){await c.query("UPDATE reservations SET status='RELEASED' WHERE id=$1",[r.rows[0].id]);await c.query('UPDATE inventory SET available=available+$2,reserved=GREATEST(0,reserved-$2) WHERE product_id=$1',[r.rows[0].product_id,r.rows[0].quantity])} await c.query("UPDATE orders SET status='FAILED',updated_at=now() WHERE reservation_id=$1 AND status='PAYMENT_PENDING'",[r.rows[0].id]);await c.query('COMMIT');return}
  // Payment success is persisted before order materialization. The outbox makes order creation retryable.
  await c.query("UPDATE payments SET status='SUCCESS',updated_at=now() WHERE id=$1",[paymentId]);
  await c.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('order.create',$1,$2)",[paymentId,JSON.stringify({paymentId,simulateFailure:mode==='DUPLICATE'})]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

export async function createOrderForPayment(event) {
 const c=await pool.connect();
 try{await c.query('BEGIN');
  const p=await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[event.payload.paymentId]); if(!p.rowCount||p.rows[0].status!=='SUCCESS'){await c.query('COMMIT');return null}
  const pay=p.rows[0], rr=await c.query('SELECT r.*,p.name,p.price_cents FROM reservations r JOIN products p ON p.id=r.product_id WHERE r.id=$1 FOR UPDATE',[pay.reservation_id]); if(!rr.rowCount){await c.query('COMMIT');return null}
  const r=rr.rows[0];
  const existing=await c.query('SELECT * FROM orders WHERE reservation_id=$1 FOR UPDATE',[r.id]); if(existing.rowCount&&existing.rows[0].status==='CONFIRMED'){await c.query('COMMIT');return existing.rows[0]}
  if(r.expires_at<new Date()||!['PAYMENT_PENDING','RESERVED'].includes(r.status)){await c.query('COMMIT');return null}
  const o=existing.rowCount?await c.query("UPDATE orders SET status='CONFIRMED',updated_at=now() WHERE id=$1 RETURNING *",[existing.rows[0].id]):await c.query(`INSERT INTO orders(user_id,reservation_id,order_number,status,subtotal_cents,total_cents) VALUES($1,$2,$3,'CONFIRMED',$4,$4) RETURNING *`,[r.user_id,r.id,`SZ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,pay.amount_cents]);
  if(!existing.rowCount) await c.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,$3,$4)',[o.rows[0].id,r.product_id,r.quantity,r.price_cents]);
  await c.query("UPDATE reservations SET status='CONFIRMED' WHERE id=$1",[r.id]);
  await c.query('UPDATE inventory SET reserved=GREATEST(0,reserved-$2),sold=sold+$2 WHERE product_id=$1',[r.product_id,r.quantity]);
  await c.query("INSERT INTO shipments(order_id,tracking_number,status,eta) VALUES($1,$2,'PROCESSING',CURRENT_DATE+5) ON CONFLICT(order_id) DO NOTHING",[o.rows[0].id,`TRK${randomUUID().replaceAll('-','').slice(0,12).toUpperCase()}`]);
  await c.query("INSERT INTO outbox_events(event_type,aggregate_id,payload) VALUES('notification.order-confirmed',$1,$2)",[o.rows[0].id,JSON.stringify({orderId:o.rows[0].id})]);
  await c.query('COMMIT');return o.rows[0];
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
