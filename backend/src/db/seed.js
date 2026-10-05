import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
const data = [
 ['Mobiles','mobiles','▣',[['Nova X Pro 5G','₹64,999',64999,74999,'https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=700','Best seller'],['Pixelwave 9','₹42,990',42990,48990,'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=700','New'],['Galaxy Note Air','₹29,999',29999,35999,'https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?w=700','']]],
 ['Laptops','laptops','▰',[['MacBook Air M3','₹1,14,900',114900,129900,'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=700','Top rated'],['ZenBook OLED 14','₹84,990',84990,99990,'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=700','Limited'],['ProBook Studio 16','₹1,39,990',139990,159990,'https://images.unsplash.com/photo-1588872657578-7efd1f1555ed?w=700','']]],
 ['Audio & Tech','audio-tech','◖',[['StudioPods Pro','₹18,990',18990,23990,'https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?w=700','Trending'],['QuietComfort Headphones','₹24,990',24990,29990,'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=700',''],['Smartwatch Active 2','₹12,499',12499,16999,'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=700','']]],
 ['Fashion','fashion','◉',[['Everyday Linen Shirt','₹2,490',2490,3490,'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=700','Organic cotton'],['Classic Leather Tote','₹5,990',5990,7990,'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=700',''],['Cloud Knit Sneakers','₹4,499',4499,5999,'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=700','Bestseller']]],
 ['Beauty','beauty','✧',[['Daily Glow Serum','₹1,299',1299,1699,'https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?w=700','Clean beauty'],['Skin Ritual Set','₹2,890',2890,3890,'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?w=700',''],['Sculpt & Blend Brush Set','₹1,890',1890,2490,'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=700','']]],
 ['Home & Living','home-living','⌂',[['Sculptural Table Lamp','₹6,499',6499,8499,'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=700',''],['Softform Throw','₹3,299',3299,4299,'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=700','Handwoven'],['Pour-over Coffee Set','₹2,499',2499,3299,'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=700','']]],
 ['Accessories','accessories','◇',[['Everyday Crossbody','₹3,990',3990,5490,'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=700',''],['Minimalist Sunglasses','₹2,290',2290,3190,'https://images.unsplash.com/photo-1511499767150-a48a237f0083?w=700',''],['Travel Carry-on','₹8,990',8990,11990,'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=700','']]]
];
try {
 const adminHash = await bcrypt.hash('ShopZenAdmin2026!', 12);
 const customerHash = await bcrypt.hash('ShopZen123!', 12);
 await pool.query(`INSERT INTO users(name,email,password_hash,role) VALUES ('ShopZen Admin','admin@shopzen.demo',$1,'admin'),('Demo Customer','hello@shopzen.demo',$2,'customer') ON CONFLICT(email) DO NOTHING`,[adminHash,customerHash]);
 let flashId;
 for (const [cat,slug,icon,items] of data) {
  const cr = await pool.query('INSERT INTO categories(name,slug,icon) VALUES($1,$2,$3) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id',[cat,slug,icon]);
  for (const [i,[name,_price,price,compare,image,badge]] of items.entries()) {
   const sku = `${slug.toUpperCase()}-${String(i+1).padStart(3,'0')}`, slugProduct = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
   const p = await pool.query(`INSERT INTO products(sku,name,slug,description,category_id,price_cents,compare_at_cents,rating,review_count,image_url,badge,is_flash_sale) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(sku) DO UPDATE SET name=EXCLUDED.name,price_cents=EXCLUDED.price_cents,compare_at_cents=EXCLUDED.compare_at_cents,image_url=EXCLUDED.image_url,badge=EXCLUDED.badge RETURNING id`,[sku,name,slugProduct,`Thoughtfully selected ${name.toLowerCase()} with thoughtful design, premium quality, and an everyday price worth smiling about.`,cr.rows[0].id,price*100,compare*100,Number((4.3+Math.random()*.7).toFixed(1)),Math.floor(40+Math.random()*1100),image,badge||null,false]);
   await pool.query('INSERT INTO inventory(product_id,available) VALUES($1,35) ON CONFLICT(product_id) DO NOTHING',[p.rows[0].id]);
  }
 }
 const cat = await pool.query("SELECT id FROM categories WHERE slug='mobiles'");
 const flash = await pool.query(`INSERT INTO products(sku,name,slug,description,category_id,price_cents,compare_at_cents,rating,review_count,image_url,badge,is_flash_sale) VALUES('FLASH-NOVA-001','Nova X Pro 5G — Flash Drop','nova-x-pro-flash','Flagship speed meets a seriously good price. Limited flash drop.', $1,6499900,7499900,4.9,2841,'https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=900','Flash deal',true) ON CONFLICT(sku) DO UPDATE SET name=EXCLUDED.name,price_cents=EXCLUDED.price_cents,is_flash_sale=true RETURNING id`,[cat.rows[0].id]);
 flashId=flash.rows[0].id; await pool.query('INSERT INTO inventory(product_id,available,reserved,sold) VALUES($1,100,0,0) ON CONFLICT(product_id) DO NOTHING',[flashId]);
 console.log(`Seeded ${data.reduce((n,x)=>n+x[3].length,0)+1} products. Flash item ${flashId} starts with exactly 100 units. Demo login: hello@shopzen.demo / ShopZen123!`);
} finally { await pool.end(); }
