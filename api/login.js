import { createClient } from '@supabase/supabase-js';

/**
 * ورود سمت سرور.
 *
 * قبلاً کلاینت نام کاربری را به ایمیل تبدیل می‌کرد و رمز را خودِ مرورگر با
 * `signInWithPassword` بررسی می‌کرد؛ یعنی هیچ شمارش تلاش، قفل موقت یا ثبت
 * «آخرین ورود» وجود نداشت و هر کسی می‌توانست پیوسته رمز را حدس بزند.
 *
 * اکنون این مسیر:
 *   ۱) نام کاربری را به ایمیل تبدیل می‌کند،
 *   ۲) رمز را روی سرور بررسی می‌کند،
 *   ۳) تلاش‌های ناموفق را در جدول login_attempts می‌شمارد،
 *   ۴) پس از LOCK_THRESHOLD خطا در بازهٔ LOCK_WINDOW_MS حساب را موقتاً قفل می‌کند،
 *   ۵) در ورود موفق، آخرین ورود را ثبت و شمارندهٔ خطا را صفر می‌کند،
 *   ۶) و در پایان نشست (access_token/refresh_token) را به کلاینت می‌دهد تا
 *      سیاست‌های RLS مثل قبل با هویت خودِ کاربر اجرا شوند.
 *
 * دو حالت ورودی:
 *   { username }            → فقط حل نام کاربری (سازگاری با app.js کش‌شدهٔ قدیمی)
 *   { username, password }  → ورود کامل
 *
 * اگر جدول login_attempts نصب نشده باشد (supabase/login-attempts.sql)، ورود
 * سالم می‌ماند و فقط شمارش/قفل غیرفعال می‌شود؛ یک مهاجرت نیمه‌کاره نباید
 * ورود همهٔ کاربران را بشکند.
 */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const MAX_PASSWORD = 200;

// محدودیت نرخ هر IP: با انتقال همهٔ ورودها به سرور، این سقف سهم بیشتری دارد
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 60;

// قفل موقت حساب: ۵ خطای رمز در ۱۵ دقیقه
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_THRESHOLD = 5;

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

function clientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  return String(raw).split(',')[0].trim().slice(0, 60);
}

function isMissingTable(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(msg);
}

// بعد از یک بار تشخیص نبودن جدول، دیگر در هر ورود سراغش نمی‌رویم
let attemptsTableMissing = false;
let lastLoginColumnMissing = false;

async function recordAttempt(admin, entry) {
  if (attemptsTableMissing) return;
  try {
    const { error } = await admin.from('login_attempts').insert({
      username: entry.username,
      ip: entry.ip || null,
      succeeded: !!entry.succeeded,
    });
    if (error) {
      if (isMissingTable(error)) {
        attemptsTableMissing = true;
        console.warn('login_attempts missing; run supabase/login-attempts.sql');
      } else {
        console.warn('login attempt record failed:', error.message);
      }
    }
  } catch (e) {
    console.warn('login attempt record failed:', e && e.message);
  }
}

// خطاهای رمز در بازهٔ قفل، از قدیم به جدید
async function recentFailures(admin, username) {
  if (attemptsTableMissing) return [];
  const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from('login_attempts')
    .select('created_at')
    .eq('username', username)
    .eq('succeeded', false)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      attemptsTableMissing = true;
      console.warn('login_attempts missing; run supabase/login-attempts.sql');
    } else {
      console.warn('login attempt read failed:', error.message);
    }
    return [];
  }
  return data || [];
}

async function clearFailures(admin, username) {
  if (attemptsTableMissing) return;
  const { error } = await admin
    .from('login_attempts')
    .delete()
    .eq('username', username)
    .eq('succeeded', false);
  if (error) {
    if (isMissingTable(error)) attemptsTableMissing = true;
    else console.warn('login attempt reset failed:', error.message);
  }
}

async function touchLastLogin(admin, userId) {
  if (lastLoginColumnMissing) return null;
  const now = new Date().toISOString();
  const { error } = await admin.from('profiles').update({ last_login_at: now }).eq('id', userId);
  if (error) {
    const msg = String(error.message || '');
    if (/last_login_at/i.test(msg)) {
      lastLoginColumnMissing = true;
      console.warn('profiles.last_login_at missing; run supabase/login-attempts.sql');
    } else {
      console.warn('last login update failed:', msg);
    }
    return null;
  }
  return now;
}

async function recordAudit(admin, entry) {
  try {
    const { error } = await admin.from('audit_log').insert({
      actor_id: entry.actorId || null,
      action: entry.action,
      target_id: entry.actorId || null,
      details: entry.details || {},
      ip: entry.ip || null,
    });
    if (error) console.warn('audit insert failed:', error.message);
  } catch (e) {
    console.warn('audit insert failed:', e && e.message);
  }
}

async function resolveEmail(admin, username, userId) {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data || !data.user) {
    console.error('login resolve getUserById failed:', error && error.message);
    return { status: 500, error: 'خطا در دریافت حساب کاربر' };
  }
  const email = String(data.user.email || '').trim().toLowerCase();
  if (!email) {
    // پشتیبان سازگار با حساب‌های قدیمی بدون ایمیل
    return { email: username + '@example.com' };
  }
  return { email };
}

function lockMessage(minutes) {
  return 'حساب شما به دلیل تلاش‌های ناموفق موقتاً قفل شده است؛ حدود ' + minutes + ' دقیقه دیگر دوباره تلاش کنید';
}

// کلید قابل استفاده برای بررسی رمز: کلید عمومی (درست‌ترین) و در نبودش کلید سرویس
function authKeys(serviceKey) {
  const list = [process.env.SUPABASE_ANON_KEY, process.env.SUPABASE_PUBLISHABLE_KEY, serviceKey];
  const keys = [];
  for (const key of list) {
    const value = String(key || '').trim();
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = clientIp(req);
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

  const password = typeof body.password === 'string' ? body.password : '';

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
    await recordAttempt(admin, { username, ip, succeeded: false });
    // کد ماشینی به کلاینت اجازه می‌دهد پیام «نام کاربری ناموجود» را از «رمز اشتباه» جدا کند
    return res.status(404).json({ error: 'این نام کاربری وجود ندارد', code: 'USER_NOT_FOUND' });
  }
  if (profile.active === false) {
    return res.status(403).json({ error: 'حساب غیرفعال است' });
  }

  // قفل موقت: تا وقتی خطاهای بازه به سقف نرسیده، بررسی رمز ادامه می‌یابد
  const failures = await recentFailures(admin, username);
  if (failures.length >= LOCK_THRESHOLD) {
    const oldest = new Date(failures[0].created_at).getTime();
    const remaining = oldest + LOCK_WINDOW_MS - Date.now();
    const minutes = Math.max(1, Math.ceil(remaining / 60000));
    // در حالت قفل تلاش‌ها ثبت نمی‌شوند تا قفل با حملهٔ ادامه‌دار بی‌پایان نشود
    return res.status(423).json({ code: 'ACCOUNT_LOCKED', error: lockMessage(minutes), retryAfterMinutes: minutes });
  }

  const emailRes = await resolveEmail(admin, username, profile.id);
  if (emailRes.error) {
    return res.status(emailRes.status || 500).json({ error: emailRes.error });
  }

  // حالت فقط‌حل‌نام (کلاینت قدیمی): هیچ رمزی بررسی و قفل نشده است
  if (!password) {
    return res.status(200).json({ ok: true, email: emailRes.email });
  }
  if (password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: 'رمز عبور نامعتبر است' });
  }

  // بررسی رمز روی سرور
  let session = null;
  let authError = null;
  for (const key of authKeys(serviceKey)) {
    const authClient = createClient(supabaseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({
      email: emailRes.email,
      password,
    });
    if (!error && data && data.session) {
      session = data.session;
      authError = null;
      break;
    }
    authError = error || { message: 'empty session' };
    // رمز نادرست است یا حساب قفل/تأییدنشده؛ با کلید دیگر فرقی نمی‌کند
    if (/invalid|credentials|password|not confirmed|email/i.test(String(authError.message || '') + ' ' + String(authError.code || ''))) {
      break;
    }
    console.warn('login sign-in with one key failed:', authError.message);
  }

  if (!session) {
    const message = String((authError && authError.message) || '');
    if (/not confirmed/i.test(message)) {
      return res.status(403).json({ error: 'ایمیل حساب تأیید نشده است؛ با مدیر سیستم تماس بگیرید' });
    }
    if (/invalid|credentials|password/i.test(message) || (authError && authError.status === 400)) {
      await recordAttempt(admin, { username, ip, succeeded: false });
      const after = await recentFailures(admin, username);
      const left = Math.max(0, LOCK_THRESHOLD - after.length);
      if (left <= 0) {
        const oldest = after.length ? new Date(after[0].created_at).getTime() : Date.now();
        const minutes = Math.max(1, Math.ceil((oldest + LOCK_WINDOW_MS - Date.now()) / 60000));
        return res.status(423).json({ code: 'ACCOUNT_LOCKED', error: lockMessage(minutes), retryAfterMinutes: minutes });
      }
      return res.status(401).json({ code: 'BAD_PASSWORD', error: 'رمز عبور اشتباه است', attemptsLeft: left });
    }
    console.error('login sign-in failed:', message);
    return res.status(502).json({ error: 'سرویس ورود در دسترس نیست؛ دوباره تلاش کنید' });
  }

  // ورود موفق
  await clearFailures(admin, username);
  const lastLoginAt = await touchLastLogin(admin, profile.id);
  await recordAttempt(admin, { username, ip, succeeded: true });
  await recordAudit(admin, {
    actorId: profile.id,
    action: 'login',
    ip,
    details: { username },
  });

  return res.status(200).json({
    ok: true,
    email: emailRes.email,
    last_login_at: lastLoginAt,
    user: { id: profile.id },
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
    },
  });
}
