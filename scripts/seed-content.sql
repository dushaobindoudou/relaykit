-- 演示内容：公告与帮助文章。
-- 真实部署时店主在这里换成自己的内容。用 INSERT OR REPLACE 便于反复执行。

INSERT OR REPLACE INTO announcements (id, title, body, banner_text, active, popup, sort, updated_at)
VALUES
  (1,
   'Welcome',
   '<p>All items are delivered automatically after your payment confirms on-chain. Codes usually arrive within seconds.</p><p>Need help? See the help center.</p>',
   'Instant delivery · Pay in USDT · No account required',
   1, 1, 0, '2026-09-11T00:00:00.000Z');

INSERT OR REPLACE INTO articles (slug, title, summary, body, published, pinned, sort, updated_at)
VALUES
  ('how-to-pay',
   'How to pay with USDT',
   'Step-by-step: choosing a network, sending the exact amount, and what happens next.',
   '<h2>1. Pick a network</h2><p>Polygon and BSC have the lowest network fees. TRC20 works too, but the per-transfer fee is much higher and can exceed the value of a small order.</p><h2>2. Send the exact amount</h2><p>The amount shown on your order page has specific trailing decimals. Those decimals are how we identify your payment. Sending a rounded amount means the payment cannot be matched automatically and will need manual review.</p><h2>3. Wait for confirmations</h2><p>Your order page updates by itself. Once the required number of confirmations is reached, your code appears on the same page.</p>',
   1, 1, 0, '2026-09-11T00:00:00.000Z'),

  ('delivery-and-warranty',
   'Delivery and warranty',
   'What "instant delivery" means, and what the warranty on each item covers.',
   '<h2>Instant vs manual delivery</h2><p>Items marked <strong>instant delivery</strong> are released from stock the moment your payment confirms. Items marked <strong>manual delivery</strong> are fulfilled by hand and are not immediate; you will be contacted by email.</p><h2>Warranty</h2><p>Warranty terms are listed on each product page and differ per item. Read the product description before ordering.</p><h2>If something goes wrong</h2><p>Keep your order number and order password. Use the order lookup page to check status at any time.</p>',
   1, 0, 1, '2026-09-11T00:00:00.000Z'),

  ('order-lookup',
   'Finding your order again',
   'How to retrieve your code later using your order number and password.',
   '<p>When you place an order you set an <strong>order password</strong>. That password, together with your order number, is what lets you view your code again later.</p><p>Go to the order lookup page, enter both, and your order opens with the code visible.</p><p>We deliberately return the same response whether the order number is wrong or the password is wrong. This prevents anyone from probing for valid order numbers.</p>',
   1, 0, 2, '2026-09-11T00:00:00.000Z');
