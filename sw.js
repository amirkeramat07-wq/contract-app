const CACHE_NAME = 'contract-app-v29';
const SHELL = ['./', './index.html', './app.js', './app-version.json', './manifest.json', './logo.png', './icon-192.png', './icon-512.png', './supabase.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((n) => (n === CACHE_NAME ? null : caches.delete(n)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // درخواست‌های غیر GET و ارتباط با Supabase و API را دست نمی‌زنیم
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // صفحه اصلی و کد اپ: شبکه اول، کش به‌عنوان پشتیبان
  // (اگر app.js کش‌اول باشد، کاربر نسخهٔ جدید صفحه را با کد قدیمی می‌گیرد؛
  // پس همان سیاست صفحه برای آن هم اعمال می‌شود.)
  const isNavigation = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  const isCode = url.pathname.endsWith('/app.js') || url.pathname.endsWith('/app-version.json');
  if (isNavigation || isCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => {
            if (hit) return hit;
            return isNavigation ? caches.match('./index.html') : Response.error();
          })
        )
    );
    return;
  }

  // فایل‌های ثابت: کش اول
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const options = {
    body: data.body || 'پیام جدیدی دارید',
    icon: './logo.png',
    badge: './logo.png',
    dir: 'rtl',
    lang: 'fa',
    tag: data.tag || 'contract-app',
    renotify: true,
    data: { url: data.url || './' },
    vibrate: [180, 90, 180],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'پیام‌رسان قراردادها', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
