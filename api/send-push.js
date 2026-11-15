import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@parizpishro.ir',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const MAX_TITLE = 120;
const MAX_BODY = 300;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // ۱) فراخواننده باید کاربر لاگین‌کرده باشد
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const callerId = userData && userData.user ? userData.user.id : null;
  if (userError || !callerId) return res.status(401).json({ error: 'Unauthorized' });

  const { taskId, targetUserId, title, body, url } = req.body || {};
  if (!taskId || !targetUserId) {
    return res.status(400).json({ error: 'taskId and targetUserId are required' });
  }
  if (targetUserId === callerId) {
    return res.status(400).json({ error: 'Invalid target' });
  }

  // ۲) فراخواننده باید طرف موضوع باشد و مقصد باید طرف دیگر همان موضوع باشد
  const { data: task, error: taskError } = await admin
    .from('tasks')
    .select('id, from_user_id, to_user_id')
    .eq('id', taskId)
    .maybeSingle();

  if (taskError || !task) return res.status(404).json({ error: 'Task not found' });

  const isParty = task.from_user_id === callerId || task.to_user_id === callerId;
  const otherParty =
    task.from_user_id === callerId ? task.to_user_id : task.from_user_id;
  if (!isParty || otherParty !== targetUserId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ۳) اشتراک پوش کاربر مقصد
  const { data: row } = await admin
    .from('push_subscriptions')
    .select('subscription')
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (!row || !row.subscription) {
    return res.status(404).json({ error: 'کاربر اعلان‌ها را فعال نکرده است' });
  }

  const safeUrl =
    typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '/';

  const payload = JSON.stringify({
    title: String(title || 'پیام‌رسان قراردادها').slice(0, MAX_TITLE),
    body: String(body || 'پیام جدیدی دارید').slice(0, MAX_BODY),
    url: safeUrl,
    tag: 'task-' + taskId,
  });

  try {
    await webpush.sendNotification(row.subscription, payload);
    return res.status(200).json({ success: true });
  } catch (err) {
    const statusCode = err && err.statusCode;
    // اشتراک منقضی یا حذف‌شده: پاک‌سازی تا دفعه بعد خطا ندهد
    if (statusCode === 404 || statusCode === 410) {
      await admin.from('push_subscriptions').delete().eq('user_id', targetUserId);
      return res.status(410).json({ error: 'Subscription expired' });
    }
    console.error('Push error:', statusCode || '', (err && err.message) || err);
    return res.status(500).json({ error: 'Push failed' });
  }
}
