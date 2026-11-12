import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

webpush.setVapidDetails(
  'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { targetUserId, title, body, url } = req.body;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', targetUserId)
      .single();

    if (error || !subs || !subs.subscription) {
      return res.status(404).json({ error: 'کاربر اعلان‌ها را فعال نکرده است' });
    }

    const payload = JSON.stringify({
      title: title || 'پیام‌رسان قراردادها',
      body: body || 'پیام جدیدی دارید',
      url: url || '/'
    });

    await webpush.sendNotification(subs.subscription, payload);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Push error:', err);
    return res.status(500).json({ error: err.message });
  }
}
