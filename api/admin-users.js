import { createClient } from '@supabase/supabase-js';

/**
 * مدیریت کاربران توسط ادمین و مدیران سلسله‌مراتبی.
 * چرا سرور؟ جدول profiles سیاست UPDATE برای «دیگران» ندارد و درست هم همین است؛
 * پس تغییر نقش/نام/مدیران/وضعیت/رمز با کلید سرویس و پس از احراز هویت انجام می‌شود.
 *
 * اکشن‌ها (body.action):
 *   update        پیش‌فرض؛ ویرایش پروفایل
 *   resetPassword تغییر رمز عبور + بستن نشست‌های فعال کاربر
 *   audit         آخرین رخدادهای ثبت‌شده (فقط مدیر سیستم)
 */

const ALLOWED_ROLES = ['مدیر', 'رئیس', 'سرپرست', 'کارشناس'];
const ROLE_RANK = { 'مدیر': 4, 'رئیس': 3, 'سرپرست': 2, 'کارشناس': 1 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 120;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;
const MAX_SUBTREE_DEPTH = 6;

// ورود با «نام کاربری + @example.com» انجام می‌شود؛ پس ایمیل حساب احراز هویت
// باید همیشه از روی همین نام کاربری ساخته شود.
function loginEmail(username) {
  return String(username).trim().toLowerCase() + '@example.com';
}

function bad(res, status, message) {
  return res.status(status).json({ error: message });
}

function clientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  return String(raw).split(',')[0].trim().slice(0, 60);
}

// ثبت رخداد امنیتی؛ اگر جدول audit_log نصب نشده باشد، جریان اصلی نباید بشکند.
async function recordAudit(admin, req, entry) {
  try {
    const { error } = await admin.from('audit_log').insert({
      actor_id: entry.actorId || null,
      action: entry.action,
      target_id: entry.targetId || null,
      details: entry.details || {},
      ip: clientIp(req),
    });
    if (error) console.warn('audit insert failed:', error.message);
  } catch (e) {
    console.warn('audit insert failed:', e && e.message);
  }
}

// اگر ستون session_epoch هنوز ساخته نشده باشد، همان درخواست بدون آن ذخیره می‌شود.
async function updateProfile(admin, userId, patch) {
  const payload = { ...patch };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await admin.from('profiles').update(payload).eq('id', userId);
    if (!error) return { ok: true };
    const msg = String(error.message || '');
    if (attempt === 0 && Object.prototype.hasOwnProperty.call(payload, 'session_epoch') && /session_epoch/i.test(msg)) {
      delete payload.session_epoch;
      continue;
    }
    console.error('admin-users update failed:', msg);
    return { ok: false, error: { message: msg } };
  }
  return { ok: false, error: { message: 'update failed' } };
}

function isSystemAdmin(caller) {
  return !!caller && caller.username === 'admin' && caller.active !== false;
}

// آیا کاربر هدف در زیرمجموعهٔ (مستقیم یا غیرمستقیم) این مدیر قرار دارد؟
async function isInSubtree(admin, targetId, managerId) {
  const seen = new Set([targetId]);
  let frontier = [targetId];
  for (let depth = 0; depth < MAX_SUBTREE_DEPTH && frontier.length; depth++) {
    const { data: rows, error } = await admin
      .from('profiles')
      .select('id, manager_id')
      .in('id', frontier);
    if (error || !rows || rows.length === 0) return false;
    const next = [];
    for (const row of rows) {
      const ids = String(row.manager_id || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.includes(managerId)) return true;
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }
  return false;
}

async function authorize(admin, caller, target) {
  if (isSystemAdmin(caller)) return { ok: true, admin: true };
  const callerRank = ROLE_RANK[caller.role] || 0;
  const targetRank = ROLE_RANK[target.role] || 0;
  if (callerRank < ROLE_RANK['رئیس']) {
    return { ok: false, status: 403, message: 'فقط مدیر سیستم و رئیس‌ها می‌توانند کاربران را تغییر دهند' };
  }
  if (target.username === 'admin') {
    return { ok: false, status: 403, message: 'فقط مدیر سیستم می‌تواند حساب مدیر را تغییر دهد' };
  }
  if (targetRank >= callerRank) {
    return { ok: false, status: 403, message: 'فقط می‌توانید زیردستان خودتان را تغییر دهید' };
  }
  const inTree = await isInSubtree(admin, target.id, caller.id);
  if (!inTree) return { ok: false, status: 403, message: 'این کاربر زیرمجموعهٔ شما نیست' };
  return { ok: true, admin: false };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 405, 'Method not allowed');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return bad(res, 500, 'سرور پیکربندی نشده است (کلید سرویس موجود نیست)');
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return bad(res, 401, 'نشست شما معتبر نیست؛ دوباره وارد شوید');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ۱) فراخواننده باید کاربر واقعی باشد
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const callerId = userData && userData.user ? userData.user.id : null;
  if (userError || !callerId) return bad(res, 401, 'نشست شما معتبر نیست؛ دوباره وارد شوید');

  // ۲) و باید مدیر سیستم یا مدیر یک زیرمجموعه باشد (بر اساس پروفایل، نه ادعای کلاینت)
  const { data: caller, error: callerError } = await admin
    .from('profiles')
    .select('id, username, name, role, active, manager_id')
    .eq('id', callerId)
    .maybeSingle();

  if (callerError) return bad(res, 500, 'خطا در بررسی دسترسی');
  if (!caller || caller.active === false) return bad(res, 403, 'حساب شما فعال نیست');

  const callerRank = ROLE_RANK[caller.role] || 0;
  const canEnterPanel = isSystemAdmin(caller) || callerRank >= ROLE_RANK['رئیس'];
  if (!canEnterPanel) return bad(res, 403, 'فقط مدیر سیستم و رئیس‌ها دسترسی دارند');

  const body = req.body || {};
  if (typeof body === 'string') {
    try {
      Object.assign(body, JSON.parse(body));
    } catch (e) {
      return bad(res, 400, 'بدنهٔ درخواست نامعتبر است');
    }
  }

  const action = String(body.action || 'update');

  // ---- گزارش فعالیت (فقط مدیر سیستم) ----
  if (action === 'audit') {
    if (!isSystemAdmin(caller)) return bad(res, 403, 'فقط مدیر سیستم دسترسی دارد');
    const { data: rows, error } = await admin
      .from('audit_log')
      .select('id, actor_id, action, target_id, details, ip, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      console.error('admin-users audit read failed:', error.message);
      return bad(res, 500, 'خطا در خواندن گزارش فعالیت (جدول audit_log ساخته شده است؟)');
    }
    const actorIds = Array.from(new Set((rows || []).map((r) => r.actor_id).filter(Boolean)));
    let names = {};
    if (actorIds.length) {
      const { data: actors } = await admin.from('profiles').select('id, name').in('id', actorIds);
      (actors || []).forEach((a) => { names[a.id] = a.name; });
    }
    return res.status(200).json({
      ok: true,
      entries: (rows || []).map((r) => ({ ...r, actor_name: names[r.actor_id] || null })),
    });
  }

  const userId = String(body.userId || '').trim();
  if (!UUID_RE.test(userId)) return bad(res, 400, 'شناسهٔ کاربر نامعتبر است');

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('id, username, name, role, manager_id, active')
    .eq('id', userId)
    .maybeSingle();

  if (targetError) return bad(res, 500, 'خطا در دریافت کاربر');
  if (!target) return bad(res, 404, 'کاربر پیدا نشد');

  const gate = await authorize(admin, caller, target);
  if (!gate.ok) return bad(res, gate.status || 403, gate.message);

  // ---- تغییر رمز عبور + بستن نشست‌های فعال ----
  if (action === 'resetPassword') {
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
      return bad(res, 400, 'رمز باید بین ' + MIN_PASSWORD + ' تا ' + MAX_PASSWORD + ' کاراکتر باشد');
    }
    const { error: passError } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
    if (passError) {
      console.error('admin-users resetPassword failed:', passError.message);
      return bad(res, 500, 'تغییر رمز انجام نشد: ' + passError.message);
    }
    // نشست‌های قبلی با تغییر «مهر نشست» باطل می‌شوند؛ اپ در ضربان بعدی
    // خودش را بیرون می‌برد و سیاست امنیتی دیتابیس هم کاربر غیرمجاز را می‌بندد.
    // اگر مدیر رمز خودش را عوض کند، نشست جاری‌اش نباید بسته شود.
    const bumpEpoch = userId !== callerId;
    const epoch = bumpEpoch
      ? await updateProfile(admin, userId, { session_epoch: new Date().toISOString() })
      : { ok: true };
    if (!epoch.ok) console.warn('session_epoch bump failed (ستون ساخته نشده؟)');
    await recordAudit(admin, req, {
      actorId: callerId,
      action: 'reset_password',
      targetId: userId,
      details: { target: target.username },
    });
    return res.status(200).json({ ok: true, sessionsRevoked: epoch.ok });
  }

  // ---- ویرایش پروفایل ----
  // نام کاربری همان چیزی است که کاربر با آن وارد می‌شود؛ تغییرش باید ایمیل
  // حساب احراز هویت را هم عوض کند، وگرنه ورود با نام قدیمی می‌ماند.
  let nextUsername = target.username;
  if (body.username !== undefined) {
    const username = String(body.username).trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      return bad(res, 400, 'نام کاربری باید ۳ تا ۳۰ کاراکتر انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد');
    }
    if (target.username === 'admin') {
      if (username !== 'admin') return bad(res, 400, 'نام کاربری حساب مدیر سیستم قابل تغییر نیست');
    } else if (username === 'admin') {
      return bad(res, 400, 'این نام کاربری رزرو شده است');
    } else if (username !== target.username) {
      const { data: dup, error: dupError } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();
      if (dupError) return bad(res, 500, 'خطا در بررسی نام کاربری');
      if (dup && dup.id !== userId) {
        return bad(res, 400, 'این نام کاربری قبلاً برای کاربر دیگری ثبت شده است');
      }
      nextUsername = username;
    }
  }

  const update = {};
  if (nextUsername !== target.username) update.username = nextUsername;

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > MAX_NAME) return bad(res, 400, 'نام باید بین ۱ تا ۱۲۰ کاراکتر باشد');
    update.name = name;
  }

  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (!ALLOWED_ROLES.includes(role)) return bad(res, 400, 'نقش نامعتبر است');
    // هیچ‌کس نمی‌تواند نقشی هم‌رتبه یا بالاتر از خودش بدهد (جز مدیر سیستم)
    if (!gate.admin && (ROLE_RANK[role] || 0) >= callerRank) {
      return bad(res, 403, 'نمی‌توانید نقشی هم‌رتبه یا بالاتر از خودتان تعیین کنید');
    }
    update.role = role;
  }

  if (body.manager_id !== undefined) {
    const raw = Array.isArray(body.manager_id) ? body.manager_id.join(',') : String(body.manager_id || '');
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.some((id) => !UUID_RE.test(id))) return bad(res, 400, 'شناسهٔ مدیر نامعتبر است');
    if (ids.includes(userId)) return bad(res, 400, 'کاربر نمی‌تواند مدیر مستقیم خودش باشد');
    update.manager_id = ids.join(',');
  }

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return bad(res, 400, 'وضعیت نامعتبر است');
    update.active = body.active;
  }

  // ایمیل ورود باید با نام کاربری هم‌خوان باشد؛ اگر قبلاً دستی عوض شده باشد
  // (نام کاربری پروفایل جدید و ایمیل ورود قدیمی)، همین‌جا اصلاح می‌شود.
  const desiredEmail = loginEmail(nextUsername);
  const { data: authUserData, error: authUserError } = await admin.auth.admin.getUserById(userId);
  if (authUserError) {
    console.error('admin-users getUserById failed:', authUserError.message);
    return bad(res, 500, 'خطا در دریافت حساب کاربر');
  }
  const currentEmail = authUserData && authUserData.user ? String(authUserData.user.email || '') : '';
  const emailNeedsSync = currentEmail.toLowerCase() !== desiredEmail;

  if (Object.keys(update).length === 0 && !emailNeedsSync) {
    return bad(res, 400, 'تغییری برای ذخیره وجود ندارد');
  }

  // محافظت از حساب مدیر سیستم: نه غیرفعال شود، نه نقشش عوض شود
  if (target.username === 'admin') {
    if (update.active === false) return bad(res, 400, 'حساب مدیر سیستم را نمی‌توان غیرفعال کرد');
    if (update.role !== undefined && update.role !== 'مدیر') {
      return bad(res, 400, 'نقش حساب مدیر سیستم قابل تغییر نیست');
    }
  }

  if (emailNeedsSync) {
    const { error: emailError } = await admin.auth.admin.updateUserById(userId, {
      email: desiredEmail,
      email_confirm: true,
      user_metadata: { username: nextUsername },
    });
    if (emailError) {
      console.error('admin-users email sync failed:', emailError.message);
      return bad(res, 500, 'تغییر نام کاربری برای ورود ذخیره نشد؛ دوباره تلاش کنید');
    }
  }

  // غیرفعال‌سازی یا تغییر رمز باید نشست‌های باز را هم ببندد.
  const revokeSessions = update.active === false || body.revokeSessions === true;
  if (revokeSessions) update.session_epoch = new Date().toISOString();

  if (Object.keys(update).length > 0) {
    const saved = await updateProfile(admin, userId, update);
    if (!saved.ok) {
      // برگرداندن ایمیل ورود تا حساب با نام کاربریِ ذخیره‌نشده ناهم‌خوان نماند
      if (emailNeedsSync && currentEmail) {
        try {
          await admin.auth.admin.updateUserById(userId, { email: currentEmail, email_confirm: true });
        } catch (e) {
          console.error('admin-users email rollback failed:', e && e.message);
        }
      }
      return bad(res, 500, 'خطا در ذخیرهٔ تغییرات');
    }
  }

  await recordAudit(admin, req, {
    actorId: callerId,
    action: 'update_user',
    targetId: userId,
    details: {
      target: nextUsername,
      fields: Object.keys(update),
      deactivated: update.active === false,
    },
  });

  return res.status(200).json({ ok: true, username: nextUsername, sessionsRevoked: revokeSessions });
}
