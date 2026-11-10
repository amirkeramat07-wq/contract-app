const CACHE_NAME = 'contract-app-v24';
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
  // درخواست‌های ارسال داده به Supabase یا درخواست‌های غیر GET را کش نکن
  if (event.request.method !== 'GET' || event.request.url.includes('supabase.co')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((response) => {
      // اگر در کش بود، همان را بده. اگر نبود، از اینترنت بگیر.
      return response || fetch(event.request).catch(() => {
          // اگر اینترنت قطع بود یا CDN مسدود بود، کرش نکن
          return new Response('', { status: 408, statusText: 'Network Error' });
      });
    })
  );
});
