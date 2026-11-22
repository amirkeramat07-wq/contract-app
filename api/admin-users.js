import { createClient } from '@supabase/supabase-js';

/**
 * ویرایش مشخصات کاربران توسط ادمین.
 * چرا سرور؟ جدول profiles سیاست UPDATE برای «دیگران» ندارد و درست هم همین است؛
 * پس تغییر نقش/نام/مدیران/وضعیت با کلید سرویس و پس از احراز هویت ادمین انجام می‌شود.
 */

const ALLOWED_ROLES = ['مدیر', 'رئیس', 'سرپرست', 'کارشناس'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 120;

function bad(res, status, message) {
  return res.status(status).json({ error: message });
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

  // ۲) و باید ادمین سیستم باشد (بر اساس پروفایل، نه ادعای کلاینت)
  const { data: caller, error: callerError } = await admin
    .from('profiles')
    .select('id, username, role, active')
    .eq('id', callerId)
    .maybeSingle();

  if (callerError) return bad(res, 500, 'خطا در بررسی دسترسی');
  if (!caller || caller.username !== 'admin' || caller.active === false) {
    return bad(res, 403, 'فقط مدیر سیستم دسترسی دارد');
  }

  const body = req.body || {};
  if (typeof body === 'string') {
    try {
      Object.assign(body, JSON.parse(body));
    } catch (e) {
      return bad(res, 400, 'بدنهٔ درخواست نامعتبر است');
    }
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

  const update = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > MAX_NAME) return bad(res, 400, 'نام باید بین ۱ تا ۱۲۰ کاراکتر باشد');
    update.name = name;
  }

  if (body.role !== undefined) {
    const role = String(body.role).trim();
    if (!ALLOWED_ROLES.includes(role)) return bad(res, 400, 'نقش نامعتبر است');
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

  if (Object.keys(update).length === 0) return bad(res, 400, 'تغییری برای ذخیره وجود ندارد');

  // محافظت از حساب مدیر سیستم: نه غیرفعال شود، نه نقشش عوض شود
  if (target.username === 'admin') {
    if (update.active === false) return bad(res, 400, 'حساب مدیر سیستم را نمی‌توان غیرفعال کرد');
    if (update.role !== undefined && update.role !== 'مدیر') {
      return bad(res, 400, 'نقش حساب مدیر سیستم قابل تغییر نیست');
    }
  }

  const { error: updateError } = await admin.from('profiles').update(update).eq('id', userId);
  if (updateError) {
    console.error('admin-users update failed:', updateError.message);
    return bad(res, 500, 'خطا در ذخیرهٔ تغییرات');
  }

  return res.status(200).json({ ok: true });
}
