import { createClient } from '@supabase/supabase-js';

/**
 * دریافت خطاهای زمان اجرای سمت کلاینت.
 * هدف: دیدن خرابی‌هایی که کاربر فقط «هیچ اتفاقی نیفتاد» می‌بیند و هیچ‌کس از آن‌ها خبر ندارد.
 * نوشتن با کلید سرویس انجام می‌شود؛ جدول هیچ سیاست RLS برای کلاینت ندارد.
 */

const MAX_MESSAGE = 500;
const MAX_STACK = 2000;
const MAX_URL = 500;
const MAX_UA = 300;
const MAX_PER_MINUTE = 40;

const buckets = new Map();

function throttled(ip) {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.start > 60000) {
    buckets.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_MINUTE;
}

function clip(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .split(',')[0]
    .trim();
  if (throttled(ip)) return res.status(429).end();

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(204).end();

  const body = req.body || {};
  const level = ['error', 'warn', 'info'].includes(String(body.level)) ? String(body.level) : 'error';

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // اگر کاربر لاگین کرده باشد، خطا به او نسبت داده می‌شود (اختیاری و بی‌اثر بر ثبت)
  let userId = null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token) {
    try {
      const { data } = await admin.auth.getUser(token);
      userId = data && data.user ? data.user.id : null;
    } catch (e) {
      userId = null;
    }
  }

  try {
    const { error } = await admin.from('client_errors').insert({
      user_id: userId,
      level,
      message: clip(body.message, MAX_MESSAGE) || 'unknown error',
      stack: clip(body.stack, MAX_STACK),
      url: clip(body.url, MAX_URL),
      user_agent: clip(req.headers['user-agent'] || '', MAX_UA),
    });
    if (error) console.warn('client-log insert failed:', error.message);
  } catch (e) {
    console.warn('client-log insert failed:', e && e.message);
  }

  return res.status(204).end();
}
