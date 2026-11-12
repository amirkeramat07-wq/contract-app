const CACHE_NAME = 'contract-app-v27';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('supabase.co')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request).catch(() => {
          return new Response('', { status: 408, statusText: 'Network Error' });
      });
    })
  );
});
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// دریافت نوتیفیکیشن
self.addEventListener('push', function(event) {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body,
      icon: './logo.png',
      badge: './logo.png',
      data: { url: data.url || '/' },
      vibrate: [200, 100, 200]
    };
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

// وقتی روی نوتیفیکیشن کلیک شد
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      // اگر برنامه باز است، فوکوس کن
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      // وگرنه برنامه را باز کن
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});
