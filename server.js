// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();

// ---------- CONFIG ----------
const SHOPIFY_DOMAIN = 'play-farhan.myshopify.com';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = '2025-07'; 
const PROTECTION_VARIANT_DYNAMIC = '45626932789401';
const PROTECTION_THRESHOLD = 100; // USD threshold to apply protection
const PROTECTION_PERCENT = 0.03; // 3%
const PROTECTION_BASE_INCREMENT = 0.01; // add 0.01 as you requested

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(bodyParser.json());

// ---------- Simple in-memory lock per-variant to serialize updates ----------
const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  locks.set(key, true);
  try {
    return await fn();
  } finally {
    locks.delete(key);
  }
}

// ---------- Helper to get a working fetch implementation ----------
async function getFetch() {
  if (typeof global.fetch === 'function') {
    return global.fetch;
  }
  // dynamic import for node-fetch v3 (ESM). This returns the default export.
  const mod = await import('node-fetch');
  return mod.default;
}

// ---------- Helper: update variant price via Admin REST API ----------
async function updateVariantPrice(variantId, newPrice) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/variants/${variantId}.json`;
  const body = {
    variant: {
      id: Number(variantId),
      price: newPrice.toFixed(2)
    }
  };

  const fetchFn = await getFetch();

  const res = await fetchFn(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_API_TOKEN
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Shopify Admin API error: ${res.status} ${res.statusText} - ${text}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  return json.variant;
}

app.post('/update-protection', async (req, res) => {
  try {
    console.log('[server] /update-protection called with body:', req.body);

    const { subtotal, reset, new_price, variant_id } = req.body;

    // If reset flag is true → set to provided new_price directly
    if (reset === true) {
      if (typeof new_price !== 'number' || isNaN(new_price) || new_price <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid new_price for reset' });
      }
      console.log(`[server] Reset mode: setting variant ${variant_id || PROTECTION_VARIANT_DYNAMIC} price -> ${new_price}`);
      const updatedVariant = await withLock(variant_id || PROTECTION_VARIANT_DYNAMIC, async () => {
        return await updateVariantPrice(variant_id || PROTECTION_VARIANT_DYNAMIC, new_price);
      });
      return res.json({
        success: true,
        variant_id: updatedVariant.id,
        new_price: updatedVariant.price,
        note: `Reset price to ${new_price}`
      });
    } 

    // Normal calculation mode (must have subtotal)
    if (typeof subtotal !== 'number' || isNaN(subtotal) || subtotal < 0) {
      return res.status(400).json({ success: false, error: 'subtotal must be a positive number (USD)' });
    }

    // Below threshold → fixed price of 2.17
    if (subtotal < PROTECTION_THRESHOLD) {
      const fixedPrice = 2.17;
      console.log(`[server] subtotal < ${PROTECTION_THRESHOLD}. Setting fixed price -> ${fixedPrice}`);
      const updatedVariant = await withLock(PROTECTION_VARIANT_DYNAMIC, async () => {
        return await updateVariantPrice(PROTECTION_VARIANT_DYNAMIC, fixedPrice);
      });
      return res.json({
        success: true,
        variant_id: updatedVariant.id,
        new_price: updatedVariant.price,
        note: `Set fixed protection price because subtotal ${subtotal.toFixed(2)} < ${PROTECTION_THRESHOLD}`
      });
    }

    // Above threshold → dynamic calculation
    const feeRaw = subtotal * PROTECTION_PERCENT; // e.g., 150 * 0.03 = 4.5
    const targetPrice = Number((feeRaw + PROTECTION_BASE_INCREMENT).toFixed(2));
    console.log(`[server] subtotal >= ${PROTECTION_THRESHOLD}. Setting dynamic price -> ${targetPrice}`);

    const updatedVariant = await withLock(PROTECTION_VARIANT_DYNAMIC, async () => {
      return await updateVariantPrice(PROTECTION_VARIANT_DYNAMIC, targetPrice);
    });

    return res.json({ 
      success: true,
      variant_id: updatedVariant.id,
      new_price: updatedVariant.price,
      note: `Set dynamic protection price based on subtotal ${subtotal.toFixed(2)}`
    });
  } catch (err) {
    console.error('[server] /update-protection error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message || 'unknown error' });
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Protection server running on port ${PORT}`));
