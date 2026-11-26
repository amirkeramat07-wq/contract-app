import { createClient } from '@supabase/supabase-js';

/**
 * تبدیل «نام کاربری» به ایمیل حساب احراز هویت، در سمت سرور.
 *
 * قبلاً کلاینت خودش ایمیل `<username>@example.com` را می‌ساخت؛ یعنی مدل هویت
 * به یک قرارداد ساختگی در مرورگر وابسته بود و هر تغییری در آن اپ را می‌شکست.
 * از این پس سرور صاحب نگاشت نام کاربری → ایمیل است (و می‌تواند بعداً ایمیل
 * واقعی هر کاربر را هم برگرداند).
 */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 30;

// محدودیت سادهٔ نرخ در حافظهٔ همان نمونهٔ سرور (Vercel)
const attempts = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .split(',')[0]
    .trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'سرور پیکربندی نشده است' });
  }

  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'نام کاربری نامعتبر است' });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, username, active')
    .eq('username', username)
    .maybeSingle();

  if (profileError) {
    console.error('login resolve failed:', profileError.message);
    return res.status(500).json({ error: 'خطا در بررسی نام کاربری' });
  }
  if (!profile) {
    // کد ماشینی به کلاینت اجازه می‌دهد پیام «نام کاربری ناموجود» را از «رمز اشتباه» جدا کند
    return res.status(404).json({ error: 'این نام کاربری وجود ندارد', code: 'USER_NOT_FOUND' });
  }
  if (profile.active === false) {
    return res.status(403).json({ error: 'حساب غیرفعال است' });
  }

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(profile.id);
  if (authError || !authUser || !authUser.user) {
    console.error('login resolve getUserById failed:', authError && authError.message);
    return res.status(500).json({ error: 'خطا در دریافت حساب کاربر' });
  }

  const email = String(authUser.user.email || '').trim().toLowerCase();
  if (!email) {
    // پشتیبان سازگار با حساب‌های قدیمی بدون ایمیل
    return res.status(200).json({ ok: true, email: username + '@example.com' });
  }

  return res.status(200).json({ ok: true, email });
}
