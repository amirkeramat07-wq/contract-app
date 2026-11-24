/* ============================================================
   پیام‌رسان مدیریت قراردادها — منطق اپ
   این فایل از index.html جدا شده است تا نگهداری، بازبینی و
   بررسی خودکار (tools/check-app.mjs و CI) ساده‌تر شود.
   ============================================================ */

var db = null;
var currentUser = null;
var currentTaskId = null;
var currentContactId = null;
var currentTaskData = null;
var pollInterval = null;
var lastMessageId = null;
var lastMessageAt = null;
var lastSeenCache = null;
var onlineCache = false;
var lastPresenceAt = 0;
var lastMarkReadAt = 0;
var readSupport = true;
var readRpcSupport = true;
var presenceRpcSupport = true;
var presenceVisibilityHooked = false;

var heartbeatInterval = null;
var forcedLogout = false;

/* ---------- ابزار امن نمایش دادهٔ کاربر ----------
   هر متنی که از دیتابیس می‌آید «داده» است، نه HTML. از این پس همه‌جا
   با textContent یا esc() ساخته می‌شود تا اسکریپت ذخیره‌شده اجرا نشود. */
function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        if (ch === '&') return '&amp;';
        if (ch === '<') return '&lt;';
        if (ch === '>') return '&gt;';
        if (ch === '"') return '&quot;';
        return '&#39;';
    });
}

function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

/* جدیدترین زمان از بین دو مقدار */
function latestOf(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/* ---------- حضور ---------- */
var ONLINE_WINDOW_MS = 120000;
function isUserOnline(seen) {
    if (!seen) return false;
    var t = new Date(seen).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) < ONLINE_WINDOW_MS;
}

function markPresenceDirect() {
    if (!db || !currentUser) return;
    db.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', currentUser.id)
        .then(function () {}, function () {});
}

function markPresence() {
    if (!db) return;
    if (!presenceRpcSupport) return markPresenceDirect();
    db.rpc('touch_last_seen').then(function (res) {
        if (res && !res.error) return;
        var err = res && res.error;
        var msg = String((err && err.message) || '');
        if (!err || err.code === 'PGRST202' || /could not find|does not exist|schema cache/i.test(msg)) {
            presenceRpcSupport = false;
            markPresenceDirect();
        } else {
            console.warn('[presence] touch_last_seen failed:', msg);
        }
    }).catch(function () {
        presenceRpcSupport = false;
        markPresenceDirect();
    });
}

/* ---------- جریان زنده (Supabase Realtime) ---------- */
var renderedIds = new Set();
var isPolling = false;
var isSending = false;

var rtChannel = null;
var rtTaskId = null;
var rtConnected = false;
var rtProven = false;
var rtRefreshTimer = null;
var rtSafetyAt = 0;
var POLL_FALLBACK_MS = 3000;
var RT_SAFETY_MS = 30000;

var cachedUsers = [];
var allContacts = [];
var unreadByContact = {};

var mediaRecorder = null;
var audioChunks = [];
var isRecording = false;
var deferredPrompt = null;
var globalAudioPlayer = null;
var activePlayBtn = null;

var RECORDING_MAX_SECONDS = 120;
var RECORDING_WARNING_SECONDS = 90;
var MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024;
var recordingTimer = null;
var recordingSeconds = 0;

/* صفحه‌بندی و جستجوی پیام‌ها */
var hasMoreMessages = false;
var oldestMessageAt = null;
var isLoadingOlder = false;

/* گروه‌ها */
var currentGroupId = null;
var groupPollInterval = null;
var groupRenderedIds = new Set();
var groupLastAt = null;

/* به‌روزرسانی اپ اندروید */
var appUpdateInfo = null;

/* ===== Push Notification Setup ===== */
var VAPID_PUBLIC_KEY = 'BClsxFi-nA5LuAs91fA5jtKcjAQ9hRdIMwgoRMnsZrro8-w0FsT8fgvGCvoT4vmGuzHj-s5-1NoJ7gBxruFO1sM';

function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function keyMatchesCurrent(subscription) {
    try {
        var current = subscription.options && subscription.options.applicationServerKey;
        if (!current) return false;
        var a = new Uint8Array(current);
        var b = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    } catch (e) { return false; }
}

async function subscribePush(options) {
    var silent = !!(options && options.silent);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (!silent) alert('مرورگر شما از اعلان پوش پشتیبانی نمی‌کند.');
        return false;
    }
    if (!db || Notification.permission === 'denied') {
        if (!silent) alert('اجازه اعلان داده نشده است. از تنظیمات مرورگر اجازه دهید.');
        return false;
    }
    if (Notification.permission === 'default') {
        if (silent) return false;
        var permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            alert('شما اجازه اعلان را نداده‌اید. از تنظیمات مرورگر اجازه دهید.');
            return false;
        }
    }

    var registration = await navigator.serviceWorker.ready;
    var subscription = await registration.pushManager.getSubscription();

    // اگر اشتراک قدیمی با کلید قبلی ساخته شده باشد، جایگزین می‌شود
    if (subscription && !keyMatchesCurrent(subscription)) {
        try { await subscription.unsubscribe(); } catch (e) {}
        subscription = null;
    }

    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
    }

    var sessionRes = await db.auth.getSession();
    var session = sessionRes && sessionRes.data ? sessionRes.data.session : null;
    if (!session) return false;

    var result = await db.from('push_subscriptions').upsert({
        user_id: session.user.id,
        subscription: subscription.toJSON()
    }, { onConflict: 'user_id' });

    if (result.error) throw result.error;
    return true;
}

async function requestPushPermission() {
    try {
        var ok = await subscribePush({ silent: false });
        if (ok) alert('اعلان‌های پوش با موفقیت فعال شد!');
    } catch (err) {
        console.error('Push setup error:', err);
        alert('خطا در فعال‌سازی اعلان‌ها: ' + err.message);
    }
    updateNotifBanner();
}

function updateNotifBanner() {
    var bar = document.getElementById('notif-permission-bar');
    if (!bar) return;
    if (appHasNativeBridge()) {
        bar.classList.add('hidden');
        return;
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        bar.classList.add('hidden');
        return;
    }
    if (Notification.permission === 'granted') {
        bar.classList.add('hidden');
        return;
    }
    var denied = Notification.permission === 'denied';
    var title = document.getElementById('npb-title');
    var desc = document.getElementById('npb-desc');
    var btn = document.getElementById('npb-btn');
    if (title) title.textContent = denied ? 'اعلان‌ها مسدود شده‌اند' : 'اعلان‌ها را فعال کنید';
    if (desc) desc.textContent = denied
        ? 'برای دریافت اعلان، از تنظیمات مرورگر اجازهٔ اعلان را بدهید.'
        : 'تا پیام‌ها و مهلت‌ها را از دست ندهید.';
    if (btn) btn.textContent = denied ? 'چگونه؟' : 'فعال‌سازی';
    bar.classList.remove('hidden');
}

function showNotifPermissionHelp() {
    alert('برای فعال‌سازی اعلان:\nروی آیکون قفل کنار آدرس سایت بزنید ← اعلان‌ها ← اجازه.\nدر گوشی: تنظیمات مرورگر ← اعلان‌ها ← این سایت ← اجازه.');
}

function handleNotifBannerClick() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'denied') { showNotifPermissionHelp(); return; }
    requestPushPermission();
}

function appHasNativeBridge() {
    return !!(window.flutter_inappwebview && typeof window.flutter_inappwebview.callHandler === 'function');
}

function updateAppBadge(count) {
    var n = Number(count) || 0;
    if (n < 0) n = 0;
    try {
        if (appHasNativeBridge()) {
            window.flutter_inappwebview.callHandler('appBadge', n).catch(function () {});
        }
    } catch (e) {}
    try {
        if (!('setAppBadge' in navigator)) return;
        if (n > 0) navigator.setAppBadge(n);
        else if (navigator.clearAppBadge) navigator.clearAppBadge();
    } catch (e) {}
}

async function triggerPush(targetUserId, title, body, taskId) {
    if (!targetUserId || !taskId || !db) return;
    try {
        var sessionRes = await db.auth.getSession();
        var session = sessionRes && sessionRes.data ? sessionRes.data.session : null;
        if (!session) return;
        await fetch('/api/send-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session.access_token
            },
            body: JSON.stringify({
                taskId: taskId,
                targetUserId: targetUserId,
                title: title,
                body: body,
                url: window.location.origin
            })
        });
    } catch (e) {
        console.warn('Push failed silently', e);
    }
}

/* ===== Theme ===== */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('app_theme', theme); } catch (e) {}
}
function updateThemeButton(theme) {
    var sun = document.querySelector('.ico-sun');
    var moon = document.querySelector('.ico-moon');
    var label = document.getElementById('drawer-theme-label');
    if (!sun || !moon || !label) return;
    if (theme === 'dark') {
        sun.style.display = 'block';
        moon.style.display = 'none';
        label.textContent = 'تغییر به حالت روز';
    } else {
        sun.style.display = 'none';
        moon.style.display = 'block';
        label.textContent = 'تغییر به حالت شب';
    }
}
function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    updateThemeButton(next);
}

var ICO = {
    play: '<svg class="ico ico-play" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5.1v13.8c0 .84-.9 1.34-1.6.9L4.3 12.9a1.04 1.04 0 0 1 0-1.75L14.4 4.2c.7-.45 1.6.05 1.6.9Z"/></svg>',
    pause: '<svg class="ico ico-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6.8" y="5" width="3.8" height="14" rx="1.5"/><rect x="13.4" y="5" width="3.8" height="14" rx="1.5"/></svg>',
    load: '<svg class="ico ico-load" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="8" stroke-dasharray="34 22"/></svg>',
    download: '<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9"/><path d="M8.4 9.4 12 13l3.6-3.6"/><path d="M5 16.6v1.5A1.9 1.9 0 0 0 6.9 20h10.2a1.9 1.9 0 0 0 1.9-1.9v-1.5"/></svg>',
    doc: '<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M6 3.5h7.2L18 8.3v12.2H6z"/><path d="M9 12h6M9 15.5h4" stroke-linecap="round"/></svg>'
};

window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });

function handleInstallClick() {
    if (window.matchMedia('(display-mode: standalone)').matches) { alert('برنامه از قبل روی گوشی شما نصب است.'); return; }
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (r) { if (r.outcome === 'accepted') console.log('installed'); deferredPrompt = null; });
    } else {
        var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) alert('برای نصب روی آیفون:\n۱. در سافاری روی Share بزنید.\n۲. Add to Home Screen.\n۳. Add.');
        else alert('برای نصب روی اندروید:\n۱. در کروم سه‌نقطه بالا.\n۲. Install app یا Add to Home screen.\n۳. Install.');
    }
}

/* ===== اعلان‌های خوانده‌شده (محلی) ===== */
var readNotifs = [];
try { readNotifs = JSON.parse(localStorage.getItem('read_notifs') || '[]'); } catch (e) { readNotifs = []; }
if (!Array.isArray(readNotifs)) readNotifs = [];
(function pruneReadNotifs() {
    var now = Date.now();
    var pruned = readNotifs
        .filter(function (x) { return (now - ((x && x.ts) || 0)) < 60 * 24 * 3600 * 1000; })
        .map(function (x) { return (x && x.id) || x; });
    if (pruned.length !== readNotifs.length) {
        readNotifs = pruned;
        try { localStorage.setItem('read_notifs', JSON.stringify(readNotifs)); } catch (e) {}
    }
})();

function markRead(id) {
    if (readNotifs.some(function (x) { return ((x && x.id) || x) === id; })) return;
    readNotifs.push({ id: id, ts: Date.now() });
    try { localStorage.setItem('read_notifs', JSON.stringify(readNotifs)); } catch (e) {}
}
function isRead(id) { return readNotifs.some(function (x) { return ((x && x.id) || x) === id; }); }

/* ===== هویت ورود: نام کاربری → ایمیل، از سمت سرور ===== */
function formatEmail(username) {
    var u = String(username || '').trim().toLowerCase();
    return u + '@example.com';
}

async function resolveLoginEmail(username) {
    try {
        var res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username })
        });
        var body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        if (res.ok && body && body.email) return { email: String(body.email) };
        if (body && body.error) return { error: String(body.error) };
        // سرور در دسترس نیست: مسیر پشتیبان (رفتار قدیمی) استفاده می‌شود
        return null;
    } catch (e) {
        return null;
    }
}

/* ===== پایش خطای کلاینت ===== */
function installErrorMonitoring() {
    var sent = 0;
    var lastAt = 0;

    function send(level, message, stack) {
        if (sent >= 20) return;
        var now = Date.now();
        if (now - lastAt < 3000) return;
        lastAt = now;
        sent += 1;
        var payload = {
            level: level,
            message: String(message == null ? '' : message).slice(0, 500) || 'unknown error',
            stack: String(stack == null ? '' : stack).slice(0, 2000),
            url: String(location.href).slice(0, 500)
        };
        try {
            var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            if (navigator.sendBeacon && navigator.sendBeacon('/api/client-log', blob)) return;
        } catch (e) {}
        try {
            fetch('/api/client-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(function () {});
        } catch (e) {}
    }

    window.addEventListener('error', function (ev) {
        if (!ev || ev.message === undefined) return; // خطای منابع را نادیده می‌گیریم
        send('error', ev.message, ev.error && ev.error.stack);
    });
    window.addEventListener('unhandledrejection', function (ev) {
        var r = ev && ev.reason;
        send('error', (r && r.message) || String(r), r && r.stack);
    });
}

/* ===== صف ارسال آفلاین (تضمین تحویل) ===== */
var outbox = [];
var isFlushing = false;

function outboxKey() {
    return 'msg_outbox_v1:' + (currentUser ? currentUser.id : 'anon');
}
function loadOutbox() {
    try {
        var raw = JSON.parse(localStorage.getItem(outboxKey()) || '[]');
        outbox = Array.isArray(raw) ? raw : [];
    } catch (e) { outbox = []; }
}
function saveOutbox() {
    try { localStorage.setItem(outboxKey(), JSON.stringify(outbox)); } catch (e) {}
}
function removeOutboxItem(cid) {
    outbox = outbox.filter(function (x) { return x.cid !== cid; });
    saveOutbox();
}
function newClientId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function flushOutbox() {
    if (isFlushing || !outbox.length || !db) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    isFlushing = true;
    try {
        var queue = outbox.slice();
        for (var i = 0; i < queue.length; i++) {
            var item = queue[i];
            var res = await callBackend('sendTextMessage', {
                taskId: item.taskId,
                text: item.text,
                otherUserId: item.otherUserId,
                clientId: item.cid
            });
            if (res && res.ok) {
                removeOutboxItem(item.cid);
                removePendingBubble(item.cid);
            } else {
                item.attempt = (item.attempt || 0) + 1;
                item.error = (res && res.error) || 'ارسال نشد';
                saveOutbox();
            }
        }
    } catch (e) {
        console.warn('outbox flush failed', e);
    } finally {
        isFlushing = false;
    }
    updatePendingStates();
    if (currentTaskId) pollUpdates(true);
}

function removePendingBubble(cid) {
    var area = document.getElementById('messages-area');
    if (!area) return;
    var node = area.querySelector('.message[data-cid="' + cid + '"]');
    if (node) node.parentNode.removeChild(node);
}

function updatePendingStates() {
    var area = document.getElementById('messages-area');
    if (!area) return;
    outbox.forEach(function (item) {
        var node = area.querySelector('.message[data-cid="' + item.cid + '"]');
        if (!node) return;
        var state = node.querySelector('.msg-state');
        if (!state) return;
        if (item.error) {
            state.textContent = 'ارسال نشد — برای تلاش دوباره بزنید';
            state.classList.add('is-failed');
            state.onclick = function () { retryOutboxItem(item.cid); };
        } else {
            state.textContent = 'در حال ارسال…';
            state.classList.remove('is-failed');
            state.onclick = null;
        }
    });
}

function retryOutboxItem(cid) {
    var item = outbox.filter(function (x) { return x.cid === cid; })[0];
    if (!item) return;
    item.error = null;
    saveOutbox();
    updatePendingStates();
    flushOutbox();
}

function renderPendingMessage(item) {
    if (!currentTaskId || item.taskId !== currentTaskId) return;
    var area = document.getElementById('messages-area');
    if (!area) return;
    var note = area.querySelector('.empty-note');
    if (note) note.parentNode.removeChild(note);
    var bubble = el('div', 'message me pending');
    bubble.dataset.cid = item.cid;
    bubble.appendChild(el('div', 'msg-text', item.text));
    var meta = el('div', 'msg-meta');
    var state = el('span', 'msg-state', 'در حال ارسال…');
    meta.appendChild(state);
    bubble.appendChild(meta);
    area.appendChild(bubble);
    area.scrollTop = area.scrollHeight;
}

/* ===== لایهٔ داده ===== */
var MSG_COLUMNS = 'id,task_id,from_user_id,type,content,transcription,created_at,read_at';

async function callBackend(action, data) {
    data = data || {};
    try {
        if (!db) return { ok: false, error: 'سیستم در حال بارگذاری است. لطفاً اینترنت را بررسی کنید.' };

        if (action === 'login') {
            var resolved = await resolveLoginEmail(data.username);
            if (resolved && resolved.error) return { ok: false, error: resolved.error };
            var email = (resolved && resolved.email) || formatEmail(data.username);
            var authRes = await db.auth.signInWithPassword({ email: email, password: data.password });
            if (authRes.error) return { ok: false, error: 'نام کاربری یا رمز اشتباه است' };
            var profileRes = await db.from('profiles').select('*').eq('id', authRes.data.user.id).single();
            if (profileRes.error) { await db.auth.signOut(); return { ok: false, error: 'پروفایل یافت نشد' }; }
            if (!profileRes.data.active) { await db.auth.signOut(); return { ok: false, error: 'حساب غیرفعال است' }; }
            try {
                if (profileRes.data.session_epoch) {
                    localStorage.setItem('session_epoch', String(profileRes.data.session_epoch));
                }
            } catch (e) {}
            return { ok: true, user: profileRes.data };
        }

        if (action === 'logout') { await db.auth.signOut(); return { ok: true }; }

        var sessionRes = await db.auth.getSession();
        var session = sessionRes && sessionRes.data ? sessionRes.data.session : null;
        if (!session) return { ok: false, error: 'نشست منقضی شده' };
        var myId = session.user.id;

        if (action === 'heartbeat') {
            if (presenceRpcSupport) {
                try {
                    var rpcRes = await db.rpc('touch_last_seen');
                    if (!rpcRes.error) {
                        // ادامه: بررسی وضعیت حساب
                    } else {
                        var rpcMsg = String((rpcRes.error && rpcRes.error.message) || '');
                        if (rpcRes.error.code === 'PGRST202' || /could not find|does not exist|schema cache/i.test(rpcMsg)) {
                            presenceRpcSupport = false;
                        } else {
                            console.warn('[presence] touch_last_seen failed:', rpcMsg);
                        }
                    }
                } catch (e) {
                    presenceRpcSupport = false;
                }
            }
            if (!presenceRpcSupport) {
                await db.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', myId);
            }
            // بستن نشست پس از غیرفعال‌سازی یا تغییر رمز توسط مدیر
            try {
                var selfRes = await db.from('profiles').select('active, session_epoch').eq('id', myId).maybeSingle();
                if (selfRes.error) {
                    var fallback = await db.from('profiles').select('active').eq('id', myId).maybeSingle();
                    if (fallback.data && fallback.data.active === false) {
                        return { ok: false, forceLogout: true, reason: 'حساب شما غیرفعال شده است؛ با مدیر سیستم تماس بگیرید.' };
                    }
                } else if (!selfRes.data) {
                    // سیاست امنیتی «حساب فعال» ردیف پروفایل را از دید این کاربر پنهان کرده است
                    return { ok: false, forceLogout: true, reason: 'دسترسی حساب شما غیرفعال شده است؛ با مدیر سیستم تماس بگیرید.' };
                } else {
                    if (selfRes.data.active === false) {
                        return { ok: false, forceLogout: true, reason: 'حساب شما غیرفعال شده است؛ با مدیر سیستم تماس بگیرید.' };
                    }
                    var storedEpoch = null;
                    try { storedEpoch = localStorage.getItem('session_epoch'); } catch (e) {}
                    if (storedEpoch && selfRes.data.session_epoch) {
                        if (new Date(selfRes.data.session_epoch).getTime() > new Date(storedEpoch).getTime() + 1000) {
                            return { ok: false, forceLogout: true, reason: 'رمز عبور شما تغییر کرده است؛ دوباره وارد شوید.' };
                        }
                    }
                }
            } catch (e) {}
            return { ok: true };
        }

        if (action === 'getContacts') {
            var contactsRes = await db.from('profiles').select('*').neq('id', myId).neq('username', 'admin').eq('active', true);
            return {
                ok: true,
                contacts: (contactsRes.data || []).map(function (c) {
                    return Object.assign({}, c, { lastTask: null });
                })
            };
        }

        if (action === 'getUnreadCounts') {
            if (!readSupport) return { ok: true, counts: {} };
            var unreadRes = await db.from('messages')
                .select('task_id')
                .is('read_at', null)
                .neq('from_user_id', myId)
                .limit(1000);
            if (unreadRes.error) {
                if (String(unreadRes.error.message || '').indexOf('read_at') !== -1) readSupport = false;
                return { ok: true, counts: {} };
            }
            var tasksRes = await db.from('tasks').select('id,from_user_id,to_user_id');
            var perTask = {};
            (unreadRes.data || []).forEach(function (m) {
                perTask[m.task_id] = (perTask[m.task_id] || 0) + 1;
            });
            var counts = {};
            (tasksRes.data || []).forEach(function (t) {
                var c = perTask[t.id];
                if (!c) return;
                var other = t.from_user_id === myId ? t.to_user_id : t.from_user_id;
                counts[other] = (counts[other] || 0) + c;
            });
            return { ok: true, counts: counts };
        }

        if (action === 'getTasksByContact') {
            var taskList = await db.from('tasks').select('*')
                .or('and(from_user_id.eq.' + myId + ',to_user_id.eq.' + data.contactId + '),and(from_user_id.eq.' + data.contactId + ',to_user_id.eq.' + myId + ')')
                .order('created_at', { ascending: false });
            return { ok: true, tasks: taskList.data || [] };
        }

        if (action === 'getTaskDetail' || action === 'getOlderMessages') {
            var pageSize = Math.min(Math.max(parseInt(data.limit, 10) || 40, 10), 100);
            var taskRes = await db.from('tasks')
                .select('id,title,description,status,due_date,due_time,from_user_id,to_user_id,created_at')
                .eq('id', data.taskId).maybeSingle();
            if (taskRes.error || !taskRes.data) return { ok: false, error: 'موضوع یافت نشد یا حذف شده است', deleted: true };
            var task = taskRes.data;

            var msgQuery = db.from('messages')
                .select(MSG_COLUMNS)
                .eq('task_id', data.taskId)
                .order('created_at', { ascending: false })
                .limit(pageSize + 1);
            if (data.before) msgQuery = msgQuery.lt('created_at', data.before);
            var msgsRes = await msgQuery;
            if (msgsRes.error) return { ok: false, error: msgsRes.error.message };

            var rows = msgsRes.data || [];
            var hasMore = rows.length > pageSize;
            var page = rows.slice(0, pageSize).reverse();
            var otherUserId = myId === task.from_user_id ? task.to_user_id : task.from_user_id;

            if (action === 'getOlderMessages') {
                return { ok: true, task: task, messages: page, hasMore: hasMore, otherUserId: otherUserId, canDelete: myId === task.from_user_id };
            }

            var otherProfileRes = await db.from('profiles').select('last_seen').eq('id', otherUserId).maybeSingle();
            markPresence();
            var lastOtherMsg = null;
            for (var i = page.length - 1; i >= 0; i--) {
                if (page[i].from_user_id === otherUserId) { lastOtherMsg = page[i]; break; }
            }
            return {
                ok: true,
                task: task,
                messages: page,
                hasMore: hasMore,
                otherUserLastSeen: latestOf(otherProfileRes.data && otherProfileRes.data.last_seen, lastOtherMsg && lastOtherMsg.created_at) || task.created_at,
                otherUserOnline: isUserOnline(otherProfileRes.data && otherProfileRes.data.last_seen),
                canDelete: myId === task.from_user_id,
                otherUserId: otherUserId
            };
        }

        if (action === 'getUpdates') {
            var updTaskRes = await db.from('tasks')
                .select('id,title,description,status,due_date,due_time,from_user_id,to_user_id')
                .eq('id', data.taskId).maybeSingle();
            if (updTaskRes.error || !updTaskRes.data) return { ok: false, error: 'موضوع یافت نشد یا حذف شده است', deleted: true };
            var updTask = updTaskRes.data;

            var updQuery = db.from('messages').select(MSG_COLUMNS).eq('task_id', data.taskId);
            if (data.since) updQuery = updQuery.gte('created_at', data.since);
            var updMsgsRes = await updQuery.order('created_at', { ascending: true }).limit(100);
            if (updMsgsRes.error) return { ok: false, error: updMsgsRes.error.message };

            var otherUserId2 = myId === updTask.from_user_id ? updTask.to_user_id : updTask.from_user_id;
            var myReadStates = null;
            if (data.wantReadStates && readSupport) {
                var readRes = await db.from('messages')
                    .select('id,read_at')
                    .eq('task_id', data.taskId)
                    .eq('from_user_id', myId)
                    .order('created_at', { ascending: false })
                    .limit(30);
                if (readRes.error) {
                    if (String(readRes.error.message || '').indexOf('read_at') !== -1) readSupport = false;
                    myReadStates = [];
                } else {
                    myReadStates = readRes.data || [];
                }
            }

            var lastOtherMsg2 = null;
            var updRows = updMsgsRes.data || [];
            for (var j = updRows.length - 1; j >= 0; j--) {
                if (updRows[j].from_user_id === otherUserId2) { lastOtherMsg2 = updRows[j]; break; }
            }
            var lastSeen = data.lastSeenCache || null;
            var online = !!data.onlineCache;
            if (data.wantPresence) {
                var otherProfile2 = await db.from('profiles').select('last_seen').eq('id', otherUserId2).maybeSingle();
                lastSeen = latestOf(otherProfile2.data && otherProfile2.data.last_seen, lastOtherMsg2 && lastOtherMsg2.created_at) || null;
                online = isUserOnline(otherProfile2.data && otherProfile2.data.last_seen);
            } else {
                lastSeen = latestOf(lastSeen, lastOtherMsg2 && lastOtherMsg2.created_at) || null;
            }

            return {
                ok: true,
                task: updTask,
                newMessages: updRows,
                myReadStates: myReadStates,
                otherUserLastSeen: lastSeen,
                otherUserOnline: online,
                canDelete: myId === updTask.from_user_id,
                otherUserId: otherUserId2
            };
        }

        if (action === 'searchMessages') {
            var q = String(data.query || '').trim();
            if (q.length < 2) return { ok: false, error: 'حداقل دو حرف برای جستجو لازم است' };
            var safe = q.replace(/[\\%_]/g, '\\$&');
            var searchRes = await db.from('messages')
                .select('id,task_id,from_user_id,type,content,created_at')
                .eq('task_id', data.taskId)
                .ilike('content', '%' + safe + '%')
                .order('created_at', { ascending: false })
                .limit(50);
            if (searchRes.error) return { ok: false, error: searchRes.error.message };
            return { ok: true, results: searchRes.data || [] };
        }

        if (action === 'updateTaskStatus') {
            var allowed = ['در انتظار', 'در حال انجام', 'انجام شد', 'گذشته از مهلت', 'لغو شد'];
            if (allowed.indexOf(data.status) === -1) return { ok: false, error: 'وضعیت نامعتبر' };
            var statusRes = await db.from('tasks').update({ status: data.status }).eq('id', data.taskId);
            if (statusRes.error) return { ok: false, error: 'خطا در تغییر وضعیت: ' + statusRes.error.message };
            return { ok: true };
        }

        if (action === 'sendTextMessage') {
            var payload = { task_id: data.taskId, from_user_id: myId, type: 'text', content: data.text };
            if (data.clientId) payload.client_id = data.clientId;
            var sendRes = await db.from('messages').insert(payload);
            if (sendRes.error) {
                var errMsg = String(sendRes.error.message || '');
                var errCode = String(sendRes.error.code || '');
                // ستون client_id هنوز نصب نشده: بدون آن دوباره تلاش می‌کنیم
                if (payload.client_id && /client_id/i.test(errMsg)) {
                    delete payload.client_id;
                    sendRes = await db.from('messages').insert(payload);
                    errMsg = sendRes.error ? String(sendRes.error.message || '') : '';
                    errCode = sendRes.error ? String(sendRes.error.code || '') : '';
                }
                // همین پیام قبلاً ثبت شده است (تلاش دوباره پس از قطع شبکه)
                if (sendRes.error && errCode !== '23505') {
                    return { ok: false, error: errMsg || 'ارسال نشد' };
                }
            }
            if (data.otherUserId) triggerPush(data.otherUserId, 'پیام جدید', data.text, data.taskId);
            return { ok: true };
        }

        if (action === 'sendVoiceMessage') {
            var ext = data.mimeType && data.mimeType.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
            var fileName = data.taskId + '_' + Date.now() + '.' + ext;
            var uploadRes = await db.storage.from('voice-messages').upload(fileName, data.blob, { contentType: data.mimeType });
            if (uploadRes.error) return { ok: false, error: 'خطا در آپلود: ' + uploadRes.error.message };
            var voiceRes = await db.from('messages').insert({
                task_id: data.taskId, from_user_id: myId, type: 'voice', content: fileName, transcription: ''
            });
            if (voiceRes.error) return { ok: false, error: 'خطای دیتابیس: ' + voiceRes.error.message };
            if (data.otherUserId) triggerPush(data.otherUserId, 'پیام صوتی جدید', 'یک پیام صوتی دریافت کردید', data.taskId);
            return { ok: true };
        }

        if (action === 'manualTranscribe') {
            var sessRes = await db.auth.getSession();
            var token = sessRes.data.session.access_token;
            var fnRes = await db.functions.invoke('transcribe', {
                headers: { Authorization: 'Bearer ' + token },
                body: { audioUrl: data.audioUrl }
            });
            if (fnRes.error) return { ok: false, error: 'خطای تبدیل: ' + fnRes.error.message };
            var updRes = await db.from('messages').update({ transcription: fnRes.data.text }).eq('id', data.msgId);
            if (updRes.error) return { ok: false, error: 'خطای ذخیره متن: ' + updRes.error.message };
            return { ok: true, text: fnRes.data.text };
        }

        if (action === 'markRead') {
            if (!readSupport) return { ok: true, count: 0 };
            if (readRpcSupport) {
                try {
                    var rpcRes2 = await db.rpc('mark_task_read', { p_task_id: data.taskId });
                    if (!rpcRes2.error) return { ok: true, count: rpcRes2.data || 0 };
                    var rpcMsg2 = String((rpcRes2.error && rpcRes2.error.message) || '');
                    var missing = (rpcRes2.error && rpcRes2.error.code === 'PGRST202') ||
                        /could not find|does not exist|schema cache/i.test(rpcMsg2);
                    if (missing) readRpcSupport = false;
                    else console.warn('[read] mark_task_read failed:', rpcMsg2);
                } catch (e) {
                    readRpcSupport = false;
                }
            }
            var readUpd = await db.from('messages')
                .update({ read_at: new Date().toISOString() })
                .eq('task_id', data.taskId)
                .neq('from_user_id', myId)
                .is('read_at', null)
                .select('id');
            if (readUpd.error) {
                if (String(readUpd.error.message || '').indexOf('read_at') !== -1) readSupport = false;
                console.warn('[read] update read_at failed:', readUpd.error.message);
                return { ok: false, error: readUpd.error.message };
            }
            if ((readUpd.data || []).length === 0) {
                console.warn('[read] update affected 0 rows - احتمالاً سیاست UPDATE اجازه نمی‌دهد؛ read-receipts.sql را اجرا کنید.');
            }
            return { ok: true, count: (readUpd.data || []).length };
        }

        if (action === 'createTask') {
            var createdRes = await db.from('tasks').insert({
                title: data.title, description: data.description,
                from_user_id: myId, to_user_id: data.to_user_id,
                due_date: data.due_date, due_time: data.due_time
            }).select('id').single();
            if (createdRes.error) return { ok: false, error: createdRes.error.message };
            triggerPush(data.to_user_id, 'موضوع جدید', data.title, createdRes.data && createdRes.data.id);
            return { ok: true };
        }

        if (action === 'deleteTask') {
            var delRes = await db.from('tasks').delete().eq('id', data.taskId).eq('from_user_id', myId);
            if (delRes.error) return { ok: false, error: delRes.error.message };
            return { ok: true };
        }

        if (action === 'getNotifications') {
            var now = new Date();
            var in24h = new Date(now.getTime() + 24 * 3600 * 1000);
            var notifs = [];
            var seen = new Set();

            function dueDateTime(t) {
                if (!t.due_date) return null;
                var time = (t.due_time || '23:59').slice(0, 5);
                return new Date(t.due_date + 'T' + time + ':00');
            }
            function pushTaskNotif(t, type, msg, owner) {
                var key = t.id + ':' + owner + ':' + type;
                if (seen.has(key)) return;
                seen.add(key);
                var dueAt = t.due_date ? dueDateTime(t) : null;
                notifs.push({
                    id: t.id, title: t.title, status: t.status, message: msg, type: type, owner: owner,
                    due: (dueAt && !isNaN(dueAt.getTime())) ? dueAt.toISOString() : null
                });
            }

            var incomingRes = await db.from('tasks').select('*')
                .eq('to_user_id', myId)
                .in('status', ['در انتظار', 'در حال انجام', 'گذشته از مهلت']);

            (incomingRes.data || []).forEach(function (t) {
                var due = t.due_date ? dueDateTime(t) : null;
                if (due && due < now) {
                    if (!isRead(t.id + ':late')) pushTaskNotif(t, 'danger', 'مهلت این موضوع گذشته است!', 'receiver');
                } else if (due && due <= in24h && t.status !== 'گذشته از مهلت') {
                    if (!isRead(t.id + ':soon')) pushTaskNotif(t, 'warn', 'کمتر از ۲۴ ساعت به مهلت باقی مانده', 'receiver');
                } else if (t.status === 'در انتظار' && !isRead(t.id)) {
                    pushTaskNotif(t, 'info', 'موضوع جدید در انتظار بررسی شما', 'receiver');
                } else if (t.status === 'در حال انجام' && !isRead(t.id + ':doing')) {
                    pushTaskNotif(t, 'info', 'موضوع در حال انجام است', 'receiver');
                }
            });

            var outgoingRes = await db.from('tasks').select('*')
                .eq('from_user_id', myId)
                .in('status', ['در انتظار', 'در حال انجام', 'گذشته از مهلت']);

            (outgoingRes.data || []).forEach(function (t) {
                var due = t.due_date ? dueDateTime(t) : null;
                if (due && due < now && !isRead(t.id + ':senderLate')) {
                    pushTaskNotif(t, 'danger', 'موضوع ارسالی شما از مهلت گذشته است', 'sender');
                }
            });

            return { ok: true, notifications: notifs };
        }

        /* ---------- گروه‌ها ---------- */
        if (action === 'getGroups') {
            var memberRows = await db.from('chat_group_members').select('group_id').eq('user_id', myId);
            if (memberRows.error) return { ok: false, missing: true, error: 'گروه‌ها هنوز در دیتابیس فعال نشده‌اند (groups.sql را اجرا کنید)' };
            var groupIds = (memberRows.data || []).map(function (m) { return m.group_id; });
            if (!groupIds.length) return { ok: true, groups: [] };

            var groupsRes = await db.from('chat_groups').select('id,name,created_by,created_at').in('id', groupIds);
            if (groupsRes.error) return { ok: false, error: groupsRes.error.message };
            var membersRes = await db.from('chat_group_members').select('group_id,user_id').in('group_id', groupIds);
            var profilesRes = await db.from('profiles').select('id,name');

            var nameById = {};
            (profilesRes.data || []).forEach(function (p) { nameById[p.id] = p.name; });
            var membersByGroup = {};
            (membersRes.data || []).forEach(function (m) {
                if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
                membersByGroup[m.group_id].push({ id: m.user_id, name: nameById[m.user_id] || 'همکار' });
            });

            var groups = (groupsRes.data || []).map(function (g) {
                return Object.assign({}, g, { members: membersByGroup[g.id] || [] });
            }).sort(function (a, b) {
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
            return { ok: true, groups: groups };
        }

        if (action === 'createGroup') {
            var name = String(data.name || '').trim();
            if (!name) return { ok: false, error: 'نام گروه الزامی است' };
            var groupIns = await db.from('chat_groups').insert({ name: name, created_by: myId }).select('id').single();
            if (groupIns.error) return { ok: false, error: groupIns.error.message };
            var gid = groupIns.data.id;
            var memberIds = Array.isArray(data.memberIds) ? data.memberIds.slice() : [];
            if (memberIds.indexOf(myId) === -1) memberIds.push(myId);
            var rows = memberIds.map(function (uid) { return { group_id: gid, user_id: uid }; });
            var memberIns = await db.from('chat_group_members').insert(rows);
            if (memberIns.error) return { ok: false, error: memberIns.error.message };
            return { ok: true, groupId: gid };
        }

        if (action === 'getGroupMessages') {
            var gMsgQuery = db.from('chat_group_messages')
                .select('id,group_id,from_user_id,content,created_at')
                .eq('group_id', data.groupId)
                .order('created_at', { ascending: true })
                .limit(100);
            if (data.since) gMsgQuery = gMsgQuery.gte('created_at', data.since);
            var gMsgRes = await gMsgQuery;
            if (gMsgRes.error) return { ok: false, error: gMsgRes.error.message };
            return { ok: true, messages: gMsgRes.data || [] };
        }

        if (action === 'sendGroupMessage') {
            var gPayload = { group_id: data.groupId, from_user_id: myId, content: data.text };
            if (data.clientId) gPayload.client_id = data.clientId;
            var gSend = await db.from('chat_group_messages').insert(gPayload);
            if (gSend.error) {
                var gErr = String(gSend.error.message || '');
                if (gPayload.client_id && /client_id/i.test(gErr)) {
                    delete gPayload.client_id;
                    gSend = await db.from('chat_group_messages').insert(gPayload);
                    gErr = gSend.error ? String(gSend.error.message || '') : '';
                }
                if (gSend.error && String(gSend.error.code || '') !== '23505') {
                    return { ok: false, error: gErr || 'ارسال نشد' };
                }
            }
            return { ok: true };
        }

        return { ok: false, error: 'اکشن نامشخص' };
    } catch (error) {
        return { ok: false, error: 'خطای شبکه: ' + error.message };
    }
}

/* ===== ضربان حضور و بستن نشست توسط مدیر ===== */
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(function () {
        callBackend('heartbeat').then(function (res) {
            if (res && res.forceLogout) forceLogout(res.reason);
        }).catch(function () {});
    }, 60000);
    if (!presenceVisibilityHooked) {
        presenceVisibilityHooked = true;
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && currentUser) {
                callBackend('heartbeat').then(function (res) {
                    if (res && res.forceLogout) forceLogout(res.reason);
                }).catch(function () {});
            }
        });
    }
}

async function forceLogout(reason) {
    if (forcedLogout) return;
    forcedLogout = true;
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    stopRealtime();
    stopGroupPolling();
    try { await db.auth.signOut({ scope: 'local' }); } catch (e) {}
    alert(reason || 'نشست شما بسته شد؛ دوباره وارد شوید.');
    location.reload();
}

/* ===== کاربران (پنل مدیریت) ===== */
function canManageUsers() {
    // فقط مدیر سیستم (username === admin) به مدیریت کاربران دسترسی دارد
    return !!(currentUser && currentUser.username === "admin");
}

async function adminApi(payload) {
    var sessRes = await db.auth.getSession();
    var session = sessRes && sessRes.data ? sessRes.data.session : null;
    if (!session) throw new Error('نشست شما منقضی شده است؛ دوباره وارد شوید');
    var res;
    try {
        res = await fetch('/api/admin-users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session.access_token
            },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        throw new Error('ارتباط با سرور برقرار نشد');
    }
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((body && body.error) || ('خطای سرور (' + res.status + ')'));
    return body || { ok: true };
}

function adminUpdateUser(payload) { return adminApi(payload); }

function populateManagersCheckboxes(selectedIds) {
    var container = document.getElementById('u-manager-container');
    if (!container) return;
    container.innerHTML = '';
    cachedUsers.forEach(function (u) {
        if (!u.active || u.id === currentUser.id || u.username === 'admin') return;
        var label = el('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = u.id;
        if (selectedIds.indexOf(u.id) !== -1) box.checked = true;
        label.appendChild(box);
        label.appendChild(el('span', null, u.name));
        container.appendChild(label);
    });
}

async function submitUserForm() {
    var editId = document.getElementById('edit-user-id').value;
    var name = document.getElementById('u-name').value;
    var role = document.getElementById('u-role').value;
    var manager_ids = Array.prototype.slice
        .call(document.querySelectorAll('#u-manager-container input:checked'))
        .map(function (cb) { return cb.value; })
        .join(',');
    if (!name || !role) return alert('نام و نقش الزامی است');
    if (editId) {
        var username = document.getElementById('u-username').value.trim().toLowerCase();
        if (!username) return alert('نام کاربری الزامی است');
        if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
            return alert('نام کاربری باید ۳ تا ۳۰ کاراکتر انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد');
        }
        var btn = document.getElementById('save-user-btn');
        btn.disabled = true; btn.textContent = 'در حال ذخیره...';
        try {
            await adminUpdateUser({ userId: editId, username: username, name: name, role: role, manager_id: manager_ids });
            closeUserModal();
            loadAdminUsers();
        } catch (err) {
            alert('خطا در ویرایش: ' + err.message);
        } finally {
            btn.disabled = false; btn.textContent = 'ذخیره';
        }
    } else {
        var newUsername = document.getElementById('u-username').value;
        var password = document.getElementById('u-password').value;
        if (!newUsername || !password) return alert('نام کاربری و رمز الزامی است');
        var addBtn = document.getElementById('save-user-btn');
        addBtn.disabled = true; addBtn.textContent = 'در حال ساخت...';
        try {
            var sessRes = await db.auth.getSession();
            var fnRes = await db.functions.invoke('admin-users', {
                headers: { Authorization: 'Bearer ' + sessRes.data.session.access_token },
                body: { action: 'createUser', data: { name: name, username: newUsername, password: password, role: role, manager_id: manager_ids } }
            });
            if (fnRes.error) throw fnRes.error;
            alert('کاربر با موفقیت ساخته شد.');
            closeUserModal();
            loadAdminUsers();
        } catch (err) {
            alert('خطا: ' + err.message);
        } finally {
            addBtn.disabled = false; addBtn.textContent = 'ذخیره';
        }
    }
}

function openAdminResetPassModal(userId) {
    var u = cachedUsers.filter(function (x) { return x.id === userId; })[0];
    document.getElementById('admin-pass-user-id').value = userId;
    document.getElementById('admin-pass-username-label').textContent = u ? ('کاربر: ' + u.name + ' (' + u.username + ')') : '';
    document.getElementById('admin-new-password').value = '';
    document.getElementById('admin-confirm-password').value = '';
    openModalEl(document.getElementById('admin-pass-modal'));
}
function closeAdminPassModal() { closeModalEl(document.getElementById('admin-pass-modal')); }

async function submitAdminResetPass() {
    var userId = document.getElementById('admin-pass-user-id').value;
    var p1 = document.getElementById('admin-new-password').value.trim();
    var p2 = document.getElementById('admin-confirm-password').value.trim();
    if (p1.length < 6) return alert('حداقل ۶ کاراکتر');
    if (p1 !== p2) return alert('رمزها یکسان نیستند');
    var btn = document.getElementById('save-pass-btn');
    btn.disabled = true; btn.textContent = 'در حال تغییر...';
    try {
        var out = await adminApi({ action: 'resetPassword', userId: userId, newPassword: p1 });
        alert('رمز عبور تغییر کرد.' + (out && out.sessionsRevoked ? ' نشست‌های قبلی این کاربر بسته شد.' : ''));
        closeAdminPassModal();
    } catch (err) {
        alert('خطا: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'ذخیره';
    }
}

function openAddUserModal() {
    if (!canManageUsers()) return alert('فقط مدیر سیستم دسترسی دارد');
    document.getElementById('user-modal-title').textContent = 'کاربر جدید';
    document.getElementById('edit-user-id').value = '';
    document.getElementById('u-name').value = '';
    document.getElementById('u-username').value = '';
    document.getElementById('u-password').value = '';
    document.getElementById('u-role').value = 'کارشناس';
    document.getElementById('username-group').style.display = 'block';
    document.getElementById('password-group').style.display = 'block';
    document.getElementById('u-username').readOnly = false;
    populateManagersCheckboxes([]);
    openModalEl(document.getElementById('user-modal'));
}
function closeUserModal() { closeModalEl(document.getElementById('user-modal')); }

function openEditUserModal(userId) {
    var u = cachedUsers.filter(function (x) { return x.id === userId; })[0];
    if (!u) return;
    document.getElementById('user-modal-title').textContent = 'ویرایش کاربر';
    document.getElementById('edit-user-id').value = u.id;
    document.getElementById('u-name').value = u.name;
    document.getElementById('u-username').value = u.username;
    document.getElementById('u-role').value = u.role;
    document.getElementById('username-group').style.display = 'block';
    document.getElementById('password-group').style.display = 'none';
    var unameInput = document.getElementById('u-username');
    unameInput.readOnly = (u.username === 'admin');
    unameInput.title = (u.username === 'admin')
        ? 'نام کاربری حساب مدیر سیستم قابل تغییر نیست'
        : 'کاربر با این نام کاربری وارد می‌شود';
    populateManagersCheckboxes(u.manager_id ? String(u.manager_id).split(',') : []);
    openModalEl(document.getElementById('user-modal'));
}

async function toggleUserStatus(id, currentStatus) {
    if (currentStatus && !confirm('با غیرفعال‌سازی، نشست فعال این کاربر هم بسته می‌شود. ادامه می‌دهید؟')) return;
    try {
        await adminUpdateUser({ userId: id, active: !currentStatus });
        loadAdminUsers();
    } catch (err) {
        alert('خطا در تغییر وضعیت: ' + err.message);
    }
}

async function openAdminPanel() {
    if (!canManageUsers()) return alert('دسترسی غیرمجاز');
    document.getElementById('contacts-view').classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden');
    await loadAdminUsers();
}
function closeAdminPanel() {
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('contacts-view').classList.remove('hidden');
    loadContacts();
}

async function loadAdminUsers() {
    var container = document.getElementById('users-list-container');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    var usersRes = await db.from('profiles').select('*');
    if (usersRes.error) {
        container.innerHTML = '';
        var errNote = el('p', 'empty-note', 'خطا در دریافت لیست');
        errNote.style.color = 'var(--danger)';
        container.appendChild(errNote);
        return;
    }
    cachedUsers = usersRes.data || [];
    container.innerHTML = '';
    document.getElementById('add-user-btn').style.display = canManageUsers() ? 'block' : 'none';

    cachedUsers.forEach(function (u) {
        var card = el('div', 'user-card');

        var info = el('div', 'user-info');
        var nameRow = el('span', 'user-name', u.name + ' ');
        var roleTag = el('span', null, '(' + u.role + ')');
        roleTag.style.fontSize = '12px';
        roleTag.style.color = u.role === 'مدیر' ? '#e84118'
            : (u.role === 'رئیس' ? '#fbc531' : (u.role === 'سرپرست' ? '#00a8ff' : '#718093'));
        nameRow.appendChild(roleTag);
        info.appendChild(nameRow);
        info.appendChild(el('span', 'user-role', 'کاربری: ' + u.username));
        card.appendChild(info);

        var actions = el('div', 'user-actions');

        var editBtn = el('button', 'user-btn btn-edit', 'ویرایش');
        editBtn.type = 'button';
        editBtn.addEventListener('click', function () { openEditUserModal(u.id); });
        actions.appendChild(editBtn);

        var passBtn = el('button', 'user-btn btn-pass', 'رمز');
        passBtn.type = 'button';
        passBtn.addEventListener('click', function () { openAdminResetPassModal(u.id); });
        actions.appendChild(passBtn);

        var toggleBtn = el('button', 'user-btn btn-toggle' + (u.active ? ' active' : ''), u.active ? 'فعال' : 'غیرفعال');
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', function () { toggleUserStatus(u.id, u.active); });
        actions.appendChild(toggleBtn);

        card.appendChild(actions);
        container.appendChild(card);
    });
}

async function openAuditLog() {
    var container = document.getElementById('audit-list');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    openModalEl(document.getElementById('audit-modal'));
    try {
        var out = await adminApi({ action: 'audit' });
        container.innerHTML = '';
        var entries = (out && out.entries) || [];
        if (!entries.length) {
            container.appendChild(el('p', 'empty-note', 'رخدادی ثبت نشده است.'));
            return;
        }
        entries.forEach(function (entry) {
            var row = el('div', 'audit-row');
            row.appendChild(el('div', 'audit-action', entry.action));
            row.appendChild(el('div', 'audit-meta',
                (entry.actor_name || 'سیستم') + ' • ' + timeAgo(entry.created_at) +
                (entry.ip ? (' • ' + entry.ip) : '')));
            var details = entry.details && typeof entry.details === 'object' ? entry.details : {};
            var parts = Object.keys(details).map(function (k) { return k + ': ' + String(details[k]); });
            if (parts.length) row.appendChild(el('div', 'audit-details', parts.join(' | ')));
            container.appendChild(row);
        });
    } catch (err) {
        container.innerHTML = '';
        container.appendChild(el('p', 'empty-note', err.message));
    }
}
function closeAuditLog() { closeModalEl(document.getElementById('audit-modal')); }

async function purgeOldMessages() {
    if (!confirm('پیام‌های قدیمی‌تر از ۳۶۵ روز حذف می‌شوند. این کار برگشت‌پذیر نیست. ادامه می‌دهید؟')) return;
    try {
        var res = await db.rpc('purge_old_messages', { p_days: 365 });
        if (res.error) throw res.error;
        alert('پاک‌سازی انجام شد. تعداد پیام‌های حذف‌شده: ' + (res.data == null ? '؟' : res.data));
    } catch (err) {
        alert('خطا در پاک‌سازی: ' + (err.message || err));
    }
}

/* ===== منو ===== */
function toggleDrawer() {
    document.getElementById('side-drawer').classList.add('open');
    document.getElementById('drawer-overlay').classList.add('show');
}
function closeDrawer() {
    document.getElementById('side-drawer').classList.remove('open');
    document.getElementById('drawer-overlay').classList.remove('show');
}

/* ===== ورود و خروج ===== */
function showContactsView() {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('contacts-view').classList.remove('hidden');
    document.getElementById('profile-view').classList.add('hidden');
    document.getElementById('chat-view').classList.add('hidden');
    document.getElementById('user-info').textContent = currentUser.name + ' (' + currentUser.role + ')';
    document.getElementById('drawer-name').textContent = currentUser.name;
    document.getElementById('drawer-role').textContent = currentUser.role;
    document.getElementById('drawer-admin-btn').style.display = canManageUsers() ? 'flex' : 'none';
    updateNotifBanner();
    loadContacts();
}

async function handleLogin() {
    var user = document.getElementById('login-username').value.trim();
    var pass = document.getElementById('login-password').value.trim();
    if (!user || !pass) return loginError('نام کاربری و رمز عبور را وارد کنید');
    var btn = document.getElementById('login-btn');
    btn.disabled = true; btn.textContent = 'در حال ورود...';
    var res = await callBackend('login', { username: user, password: pass });
    if (res.ok) {
        currentUser = res.user;
        loadOutbox();
        showContactsView();
        loadNotifications();
        startHeartbeat();
        subscribePush({ silent: true }).catch(function () {});
        flushOutbox();
        checkAppUpdate();
    } else {
        loginError(res.error || 'ورود ناموفق بود، دوباره تلاش کنید');
    }
    btn.disabled = false; btn.textContent = 'ورود به سیستم';
}

async function handleLogout() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    stopRecordingTimer();
    stopGroupPolling();
    updateAppBadge(0);
    // دادهٔ محلی حساس هنگام خروج پاک می‌شود
    try {
        localStorage.removeItem(outboxKey());
        localStorage.removeItem('session_epoch');
        if (signedUrlCache) signedUrlCache.clear();
    } catch (e) {}
    await callBackend('logout');
    location.reload();
}

function timeAgo(d) {
    if (!d) return 'نامشخص';
    var s = Math.floor((new Date() - new Date(d)) / 1000);
    if (s < 60) return 'لحظاتی پیش';
    if (s < 3600) return Math.floor(s / 60) + ' دقیقه پیش';
    if (s < 86400) return Math.floor(s / 3600) + ' ساعت پیش';
    return Math.floor(s / 86400) + ' روز پیش';
}
function formatJalali(d) {
    if (!d) return '';
    var p = String(d).split('-');
    var j = gregorian_to_jalali(parseInt(p[0], 10), parseInt(p[1], 10), parseInt(p[2], 10));
    return j[0] + '/' + j[1] + '/' + j[2];
}

async function loadNotifications() {
    if (!currentUser) return;
    var res = await callBackend('getNotifications');
    if (!res.ok) return;
    updateAppBadge(res.notifications.length);
    var b = document.getElementById('bell-badge');
    var dbadge = document.getElementById('drawer-bell-badge');
    if (res.notifications.length > 0) {
        b.style.display = 'block';
        dbadge.style.display = 'inline-block';
        dbadge.textContent = String(res.notifications.length);
    } else {
        b.style.display = 'none';
        dbadge.style.display = 'none';
    }
}

function dismissTaskNotifs(notif) {
    var taskId = notif && notif.id ? notif.id : notif;
    if (!taskId) return;
    markRead(taskId);
    var now = Date.now();
    var dueMs = notif && notif.due ? new Date(notif.due).getTime() : NaN;
    var isLate = !isNaN(dueMs) && dueMs < now;
    var isSoon = !isNaN(dueMs) && !isLate && (dueMs - now) <= 24 * 3600 * 1000;
    if (isLate) {
        markRead(taskId + ':late');
        markRead(taskId + ':senderLate');
    } else if (isSoon) {
        markRead(taskId + ':soon');
    }
    if (notif && notif.status === 'در حال انجام') markRead(taskId + ':doing');
    loadNotifications();
}

async function openNotifModal() {
    openModalEl(document.getElementById('notif-modal'));
    var container = document.getElementById('notif-list-container');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    var res = await callBackend('getNotifications');
    if (!res.ok) {
        container.innerHTML = '';
        container.appendChild(el('p', 'empty-note', res.error || 'خطا در دریافت اعلان‌ها'));
        return;
    }
    container.innerHTML = '';
    if (!res.notifications.length) {
        container.appendChild(el('p', 'empty-note', 'اعلان جدیدی ندارید.'));
        return;
    }
    res.notifications.forEach(function (n) {
        var item = el('div', 'notif-item ' + (n.type || 'info'));
        item.appendChild(el('span', 'n-title', n.title));
        item.appendChild(el('span', 'n-msg', n.message));
        item.addEventListener('click', function () {
            if (item.parentNode) item.parentNode.removeChild(item);
            if (container && !container.querySelector('.notif-item')) {
                container.appendChild(el('p', 'empty-note', 'اعلان جدیدی ندارید.'));
            }
            dismissTaskNotifs(n);
            closeNotifModal();
            openChat(n.id);
        });
        container.appendChild(item);
    });
}
function closeNotifModal() { closeModalEl(document.getElementById('notif-modal')); }

/* ===== مخاطبان و شمارندهٔ خوانده‌نشده ===== */
async function loadContacts() {
    var container = document.getElementById('contacts-container');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    var res = await callBackend('getContacts');
    if (res.ok) {
        allContacts = res.contacts || [];
        await loadUnreadCounts();
        renderContacts(allContacts);
    } else {
        container.innerHTML = '';
        container.appendChild(el('p', 'empty-note', res.error || 'خطا'));
    }
}

async function loadUnreadCounts() {
    if (!currentUser) return;
    var res = await callBackend('getUnreadCounts');
    if (res && res.ok && res.counts) {
        unreadByContact = res.counts;
        renderContacts(allContacts);
    }
}

function filterContacts() {
    var q = document.getElementById('search-contacts').value.trim().toLowerCase();
    var list = q
        ? allContacts.filter(function (c) { return String(c.name || '').toLowerCase().indexOf(q) !== -1; })
        : allContacts;
    renderContacts(list);
}

function renderContacts(list) {
    var container = document.getElementById('contacts-container');
    if (!container) return;
    container.innerHTML = '';
    if (!list.length) {
        container.appendChild(el('p', 'empty-note', 'مخاطبی یافت نشد.'));
        return;
    }
    list.forEach(function (u) {
        var item = el('div', 'contact-item');
        item.appendChild(el('div', 'avatar', String(u.name || '?').charAt(0)));

        var info = el('div', 'contact-info');
        var nameRow = el('div', 'contact-name');
        nameRow.appendChild(el('span', null, u.name));
        nameRow.appendChild(el('span', 'contact-role', u.role));
        info.appendChild(nameRow);
        info.appendChild(el('div', 'contact-last-msg', 'برای گفتگو کلیک کنید'));
        item.appendChild(info);

        var unread = unreadByContact[u.id] || 0;
        if (unread > 0) {
            item.appendChild(el('span', 'unread-pill', unread > 99 ? '99+' : String(unread)));
        }

        item.addEventListener('click', function () { openProfile(u.id, u.name, u.role); });
        container.appendChild(item);
    });
}

async function openProfile(id, name, role) {
    currentContactId = id;
    document.getElementById('contacts-view').classList.add('hidden');
    document.getElementById('profile-view').classList.remove('hidden');
    document.getElementById('profile-avatar').textContent = String(name || '?').charAt(0);
    document.getElementById('profile-name').textContent = name;
    document.getElementById('profile-role').textContent = role;
    var container = document.getElementById('profile-tasks-container');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    var res = await callBackend('getTasksByContact', { contactId: id });
    container.innerHTML = '';
    if (!res.ok) {
        container.appendChild(el('p', 'empty-note', res.error || 'خطا'));
        return;
    }
    if (!res.tasks.length) {
        container.appendChild(el('p', 'empty-note', 'هنوز موضوعی بین شما و این شخص ایجاد نشده است.'));
        return;
    }
    res.tasks.forEach(function (t) {
        var card = el('div', 'task-card');
        var head = el('div', 'task-card-header');
        head.appendChild(el('span', 'task-title', t.title));
        var badge = el('span', 'badge-status', t.status);
        badge.style.background = statusColor(t.status);
        head.appendChild(badge);
        card.appendChild(head);
        card.appendChild(el('div', 'contact-last-msg', 'مهلت: ' + formatJalali(t.due_date)));
        card.addEventListener('click', function () { openChat(t.id); });
        container.appendChild(card);
    });
}
function closeProfile() {
    currentContactId = null;
    document.getElementById('profile-view').classList.add('hidden');
    document.getElementById('contacts-view').classList.remove('hidden');
    loadContacts();
}

function statusColor(s) {
    if (s === 'گذشته از مهلت') return 'var(--danger)';
    if (s === 'انجام شد') return 'var(--success)';
    if (s === 'لغو شد') return '#6e6e6e';
    if (s === 'در حال انجام') return 'var(--warning)';
    return 'var(--primary)';
}

/* ===== گفتگو ===== */
async function openChat(id) {
    currentTaskId = id;
    lastMessageId = null;
    lastMessageAt = null;
    lastSeenCache = null;
    onlineCache = false;
    lastPresenceAt = 0;
    renderedIds.clear();
    currentTaskData = null;
    hasMoreMessages = false;
    oldestMessageAt = null;
    lastTaskInfoSignature = '';

    document.getElementById('contacts-view').classList.add('hidden');
    document.getElementById('profile-view').classList.add('hidden');
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('groups-view').classList.add('hidden');
    document.getElementById('group-chat-view').classList.add('hidden');
    closeNotifModal();
    document.getElementById('chat-view').classList.remove('hidden');
    document.getElementById('messages-area').innerHTML = '<p class="empty-note">در حال دریافت...</p>';

    var res = await callBackend('getTaskDetail', { taskId: id, limit: 40 });
    if (!res.ok) {
        alert(res.error || 'خطا در دریافت موضوع');
        closeChat();
        return;
    }
    currentTaskData = res.task;
    onlineCache = !!res.otherUserOnline;
    updateTaskInfoUI(res.task, res.otherUserLastSeen, res.canDelete, onlineCache);

    var area = document.getElementById('messages-area');
    area.innerHTML = '';
    if (res.messages.length > 0) {
        var last = res.messages[res.messages.length - 1];
        lastMessageId = last.id;
        lastMessageAt = last.created_at || null;
        oldestMessageAt = res.messages[0].created_at || null;
        res.messages.forEach(function (m) { appendMessage(m); });
        lastMarkReadAt = 0;
        markConversationRead();
    } else {
        area.innerHTML = '<p class="empty-note">پیامی وجود ندارد. اولین پیام را بفرستید!</p>';
    }
    hasMoreMessages = !!res.hasMore;
    updateOlderButton();

    // پیام‌های در انتظار ارسال دوباره نمایش داده می‌شوند
    outbox.filter(function (item) { return item.taskId === id; }).forEach(renderPendingMessage);
    updatePendingStates();

    area.scrollTop = area.scrollHeight;
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollUpdates, POLL_FALLBACK_MS);
    startRealtime(id);
    flushOutbox();
}

function closeChat() {
    if (signedUrlCache) signedUrlCache.clear();
    if (isRecording) {
        try { mediaRecorder.stop(); } catch (e) {}
        isRecording = false;
        document.getElementById('mic-btn').classList.remove('recording');
    }
    stopRecordingTimer();
    currentTaskId = null;
    currentTaskData = null;
    lastMessageId = null;
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    stopRealtime();
    document.getElementById('chat-view').classList.add('hidden');
    if (currentContactId) {
        document.getElementById('profile-view').classList.remove('hidden');
    } else if (document.getElementById('groups-view') && !document.getElementById('groups-view').classList.contains('hidden')) {
        // از گروه برگشتیم؛ ویو خودش باز می‌ماند
    } else {
        document.getElementById('contacts-view').classList.remove('hidden');
        loadContacts();
    }
}

/* ---- صفحه‌بندی: بارگذاری پیام‌های قدیمی‌تر ---- */
function updateOlderButton() {
    var btn = document.getElementById('older-msg-btn');
    if (!btn) return;
    btn.style.display = hasMoreMessages ? 'block' : 'none';
}

async function loadOlderMessages() {
    if (!currentTaskId || !oldestMessageAt || isLoadingOlder) return;
    isLoadingOlder = true;
    var btn = document.getElementById('older-msg-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'در حال دریافت...'; }
    var area = document.getElementById('messages-area');
    var prevHeight = area.scrollHeight;
    try {
        var res = await callBackend('getOlderMessages', { taskId: currentTaskId, before: oldestMessageAt, limit: 40 });
        if (res.ok && res.messages && res.messages.length) {
            var fresh = res.messages.filter(function (m) { return !renderedIds.has(m.id); });
            for (var i = fresh.length - 1; i >= 0; i--) appendMessage(fresh[i], true);
            oldestMessageAt = res.messages[0].created_at || oldestMessageAt;
            hasMoreMessages = !!res.hasMore;
        } else if (res.ok) {
            hasMoreMessages = false;
        } else {
            alert(res.error || 'خطا در دریافت پیام‌های قبلی');
        }
        area.scrollTop = area.scrollHeight - prevHeight + area.scrollTop;
    } finally {
        isLoadingOlder = false;
        if (btn) { btn.disabled = false; btn.textContent = 'پیام‌های قدیمی‌تر'; }
        updateOlderButton();
    }
}

/* ---- جستجوی پیام‌ها ---- */
function openSearchModal() {
    if (!currentTaskId) return;
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-query').value = '';
    openModalEl(document.getElementById('search-modal'));
    setTimeout(function () {
        var input = document.getElementById('search-query');
        if (input) input.focus();
    }, 200);
}
function closeSearchModal() { closeModalEl(document.getElementById('search-modal')); }

async function runMessageSearch() {
    var q = document.getElementById('search-query').value.trim();
    var container = document.getElementById('search-results');
    if (q.length < 2) {
        container.innerHTML = '';
        container.appendChild(el('p', 'empty-note', 'حداقل دو حرف بنویسید.'));
        return;
    }
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', 'در حال جستجو...'));
    var res = await callBackend('searchMessages', { taskId: currentTaskId, query: q });
    container.innerHTML = '';
    if (!res.ok) {
        container.appendChild(el('p', 'empty-note', res.error || 'خطا'));
        return;
    }
    if (!res.results.length) {
        container.appendChild(el('p', 'empty-note', 'نتیجه‌ای پیدا نشد.'));
        return;
    }
    var nameById = {};
    allContacts.forEach(function (c) { nameById[c.id] = c.name; });
    if (currentUser) nameById[currentUser.id] = currentUser.name;

    res.results.forEach(function (m) {
        var row = el('div', 'search-result');
        row.appendChild(el('div', 'search-result-meta',
            (nameById[m.from_user_id] || 'همکار') + ' • ' + timeAgo(m.created_at)));
        row.appendChild(el('div', 'search-result-text', m.type === 'voice' ? 'پیام صوتی' : m.content));
        row.addEventListener('click', function () {
            closeSearchModal();
            var area = document.getElementById('messages-area');
            var target = area ? area.querySelector('.message[data-id="' + m.id + '"]') : null;
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('flash');
                setTimeout(function () { target.classList.remove('flash'); }, 1600);
            }
        });
        container.appendChild(row);
    });
}

/* ---- Realtime ---- */
function startRealtime(taskId) {
    stopRealtime();
    if (!db || typeof db.channel !== 'function') return;
    rtTaskId = taskId;
    rtConnected = false;
    rtProven = false;
    var ch = db.channel('chat-' + taskId);
    ch.on('postgres_changes', {
        event: '*', schema: 'public', table: 'messages',
        filter: 'task_id=eq.' + taskId
    }, function (payload) {
        if (ch !== rtChannel) return;
        rtSafetyAt = Date.now();
        rtProven = true;
        handleRealtimeMessage(payload);
    });
    ch.on('postgres_changes', {
        event: '*', schema: 'public', table: 'tasks',
        filter: 'id=eq.' + taskId
    }, function () {
        if (ch !== rtChannel) return;
        rtSafetyAt = Date.now();
        rtProven = true;
        scheduleRealtimeRefresh();
    });
    rtChannel = ch;
    ch.subscribe(function (status) {
        if (ch !== rtChannel) return;
        if (status === 'SUBSCRIBED') {
            rtConnected = true;
            rtSafetyAt = Date.now();
            scheduleRealtimeRefresh();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            rtConnected = false;
        }
    });
}

function stopRealtime() {
    if (rtRefreshTimer) { clearTimeout(rtRefreshTimer); rtRefreshTimer = null; }
    var ch = rtChannel;
    rtChannel = null;
    rtTaskId = null;
    rtConnected = false;
    rtProven = false;
    rtSafetyAt = 0;
    if (ch && db && typeof db.removeChannel === 'function') {
        try { db.removeChannel(ch); } catch (e) {}
    }
}

function scheduleRealtimeRefresh() {
    if (rtRefreshTimer) return;
    rtRefreshTimer = setTimeout(function () {
        rtRefreshTimer = null;
        if (currentTaskId && document.visibilityState === 'visible') pollUpdates(true);
    }, 250);
}

function handleRealtimeMessage(payload) {
    if (!payload || !payload.new) { scheduleRealtimeRefresh(); return; }
    var row = payload.new;
    if (currentUser && row.from_user_id === currentUser.id && row.read_at) {
        applyReadStates([{ id: row.id, read_at: row.read_at }]);
        if (payload.eventType === 'UPDATE') return;
    }
    scheduleRealtimeRefresh();
}

async function pollUpdates(force) {
    if (!currentTaskId || isPolling) return;
    if (!force && document.visibilityState !== 'visible') return;
    if (!force && rtConnected && rtProven) {
        if (Date.now() - rtSafetyAt < RT_SAFETY_MS) return;
        rtSafetyAt = Date.now();
    }
    isPolling = true;
    try {
        var wantPresence = (Date.now() - lastPresenceAt >= 30000);
        if (wantPresence) lastPresenceAt = Date.now();
        var res = await callBackend('getUpdates', {
            taskId: currentTaskId,
            since: lastMessageAt,
            wantReadStates: true,
            wantPresence: wantPresence,
            lastSeenCache: lastSeenCache,
            onlineCache: onlineCache
        });
        if (res.ok) {
            currentTaskData = res.task;
            if (res.otherUserLastSeen) lastSeenCache = res.otherUserLastSeen;
            onlineCache = !!res.otherUserOnline;
            updateTaskInfoUI(res.task, lastSeenCache || res.task.created_at, res.canDelete, onlineCache);

            var fresh = (res.newMessages || []).filter(function (m) { return !renderedIds.has(m.id); });
            if (fresh.length > 0) {
                var area = document.getElementById('messages-area');
                var note = area.querySelector('.empty-note');
                if (note) note.parentNode.removeChild(note);
                var atBottom = area.scrollHeight - area.scrollTop <= area.clientHeight + 80;
                fresh.forEach(function (m) {
                    appendMessage(m);
                    lastMessageAt = latestOf(lastMessageAt, m.created_at);
                    lastMessageId = m.id;
                });
                if (atBottom) area.scrollTop = area.scrollHeight;
            }
            if (res.myReadStates) applyReadStates(res.myReadStates);
            if (fresh.length > 0 && document.visibilityState === 'visible') markConversationRead();
        } else if (res.deleted) {
            alert('این موضوع توسط فرستنده حذف شده است.');
            closeChat();
        }
    } catch (e) {
        console.warn('poll failed', e);
    } finally {
        isPolling = false;
    }
    // پیام‌های در صف همیشه یک فرصت دوباره می‌گیرند
    if (outbox.length) flushOutbox();
}

var lastTaskInfoSignature = '';
function updateTaskInfoUI(task, lastSeen, canDelete, online) {
    if (!task) return;
    var titleEl = document.getElementById('chat-title');
    if (titleEl && titleEl.textContent !== task.title) titleEl.textContent = task.title || '';

    var signature = [task.description || '', task.status || '', task.due_date || '', task.due_time || '', lastSeen || '', online ? 'on' : 'off', canDelete ? 1 : 0].join('|');
    if (signature === lastTaskInfoSignature) return;
    lastTaskInfoSignature = signature;

    var details = document.getElementById('chat-task-details');
    if (details) {
        details.innerHTML = '';
        details.appendChild(el('p', null, task.description || 'بدون توضیحات'));
        var status = el('span', 'status');
        status.textContent = 'مهلت: ' + formatJalali(task.due_date) +
            (task.due_time ? ' - ' + String(task.due_time).slice(0, 5) : '') + ' | ';
        if (online) {
            status.appendChild(el('span', 'presence-online', 'آنلاین'));
        } else {
            status.appendChild(document.createTextNode('آخرین بازدید: ' + timeAgo(lastSeen)));
        }
        details.appendChild(status);
    }
    var delBtn = document.getElementById('delete-task-btn');
    if (delBtn) delBtn.style.display = canDelete ? 'block' : 'none';
}

function appendMessage(msg, prepend) {
    if (!msg) return;
    if (msg.id) {
        if (renderedIds.has(msg.id)) return;
        renderedIds.add(msg.id);
    }
    var mine = msg.from_user_id === currentUser.id;
    var area = document.getElementById('messages-area');
    if (!area) return;

    var bubble = el('div', 'message ' + (mine ? 'me' : 'other'));
    if (msg.id) bubble.dataset.id = msg.id;

    if (msg.type === 'voice') {
        var player = el('div', 'audio-player');
        var playBtn = el('button', 'play-btn');
        playBtn.type = 'button';
        playBtn.setAttribute('aria-label', 'پخش');
        playBtn.innerHTML = ICO.play + ICO.pause + ICO.load;
        playBtn.addEventListener('click', function () { playAudioDirect(msg.content, playBtn); });
        player.appendChild(playBtn);

        var dlBtn = el('button', 'download-btn');
        dlBtn.type = 'button';
        dlBtn.setAttribute('aria-label', 'دانلود');
        dlBtn.innerHTML = ICO.download;
        dlBtn.addEventListener('click', function () { downloadAudio(msg.id, msg.content); });
        player.appendChild(dlBtn);

        var transText = msg.transcription || '';
        var transBox = el('div', 'transcription-box' + (transText ? '' : ' hidden'));
        transBox.id = 'trans-box-' + msg.id;
        if (transText) transBox.textContent = transText;

        if (!transText) {
            var transBtn = el('button', 'transcribe-btn', 'تبدیل به متن');
            transBtn.type = 'button';
            transBtn.addEventListener('click', function () {
                manualTranscribe(msg.id, msg.content, transBtn, transBox);
            });
            player.appendChild(transBtn);
        }

        bubble.appendChild(player);
        bubble.appendChild(transBox);
    } else {
        var textEl = el('div', 'msg-text');
        textEl.textContent = msg.content || '';
        bubble.appendChild(textEl);
    }

    var meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'msg-time', formatMsgTime(msg.created_at)));
    if (mine) meta.insertAdjacentHTML('beforeend', tickMarkup(!!msg.read_at));
    bubble.appendChild(meta);

    if (prepend) area.insertBefore(bubble, area.firstChild);
    else area.appendChild(bubble);
}

async function manualTranscribe(msgId, audioUrl, btn, box) {
    btn.textContent = 'در حال تبدیل...';
    btn.disabled = true;
    try {
        var signed = await resolveAudioUrl(audioUrl);
        var res = await callBackend('manualTranscribe', { msgId: msgId, audioUrl: signed });
        if (res.ok) {
            var target = box || document.getElementById('trans-box-' + msgId);
            if (target) {
                target.textContent = res.text;
                target.classList.remove('hidden');
            }
            btn.remove();
        } else {
            alert(res.error);
            btn.textContent = 'تبدیل به متن';
            btn.disabled = false;
        }
    } catch (e) {
        alert('خطای ارتباط');
        btn.textContent = 'تبدیل به متن';
        btn.disabled = false;
    }
}

var SIGNED_URL_TTL = 3600;
var signedUrlCache = new Map();

function extractVoicePath(value) {
    if (!value) return null;
    var marker = '/voice-messages/';
    var idx = value.indexOf(marker);
    if (idx !== -1) return decodeURIComponent(value.slice(idx + marker.length).split('?')[0]);
    if (/^https?:\/\//i.test(value)) return null;
    return value.replace(/^\/+/, '');
}

async function resolveAudioUrl(value) {
    if (!value) return value;
    if (/^https?:\/\//i.test(value) && value.indexOf('/voice-messages/') === -1) return value;
    var path = extractVoicePath(value);
    if (!path || !db) return value;

    var cached = signedUrlCache.get(path);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;

    var res = await db.storage.from('voice-messages').createSignedUrl(path, SIGNED_URL_TTL);
    if (res.error || !res.data || !res.data.signedUrl) {
        console.warn('signed url failed', res.error && res.error.message);
        return value;
    }
    signedUrlCache.set(path, {
        url: res.data.signedUrl,
        expiresAt: Date.now() + SIGNED_URL_TTL * 1000
    });
    return res.data.signedUrl;
}

async function playAudioDirect(url, btn) {
    if (globalAudioPlayer && activePlayBtn === btn) {
        if (globalAudioPlayer.paused) {
            globalAudioPlayer.play();
            btn.classList.add('is-playing');
            btn.classList.remove('is-loading');
        } else {
            globalAudioPlayer.pause();
            btn.classList.remove('is-playing');
        }
        return;
    }
    if (globalAudioPlayer) {
        globalAudioPlayer.pause();
        if (activePlayBtn) activePlayBtn.classList.remove('is-playing', 'is-loading');
    }
    btn.classList.add('is-loading');
    var src = await resolveAudioUrl(url);
    globalAudioPlayer = new Audio(src);
    activePlayBtn = btn;
    globalAudioPlayer.play().then(function () {
        btn.classList.remove('is-loading');
        btn.classList.add('is-playing');
    }).catch(function () {
        btn.classList.remove('is-loading', 'is-playing');
        alert('خطا در پخش صدا. ممکن است فرمت این فایل در مرورگر شما پشتیبانی نشود.');
    });
    globalAudioPlayer.onended = function () {
        btn.classList.remove('is-playing', 'is-loading');
        globalAudioPlayer = null;
        activePlayBtn = null;
    };
}

async function downloadAudio(msgId, url) {
    var src = await resolveAudioUrl(url);
    try {
        var cache = await caches.open('voice-cache-v1');
        var response = await cache.match(src);
        if (!response) response = await fetch(src);
        if (response.ok) {
            var blob = await response.blob();
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'voice-message-' + msgId + '.webm';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else {
            window.open(src, '_blank');
        }
    } catch (e) {
        window.open(src, '_blank');
    }
}

function formatMsgTime(value) {
    if (!value) return '';
    var dt = new Date(value);
    if (isNaN(dt.getTime())) return '';
    try {
        return dt.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
    }
}

function tickMarkup(isRead) {
    return '<span class="msg-ticks' + (isRead ? ' is-read' : '') + '" aria-label="' + (isRead ? 'خوانده شد' : 'ارسال شد') + '">' +
        '<svg viewBox="0 0 19 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M1 7.1 4.2 10.2 9.8 3"/>' +
        '<path class="tick-b" d="M8.4 7.1 11.6 10.2 17.4 3"/>' +
        '</svg></span>';
}

function applyReadStates(states) {
    if (!states || !states.length) return;
    var area = document.getElementById('messages-area');
    if (!area) return;
    states.forEach(function (st) {
        if (!st || !st.id) return;
        var node = area.querySelector('.message[data-id="' + st.id + '"]');
        if (!node) return;
        var ticks = node.querySelector('.msg-ticks');
        if (!ticks) return;
        if (st.read_at) ticks.classList.add('is-read');
    });
}

function markConversationRead() {
    if (!currentTaskId || !readSupport) return;
    var now = Date.now();
    if (now - lastMarkReadAt < 4000) return;
    lastMarkReadAt = now;
    var otherId = currentTaskData
        ? (currentUser.id === currentTaskData.from_user_id ? currentTaskData.to_user_id : currentTaskData.from_user_id)
        : null;
    callBackend('markRead', { taskId: currentTaskId }).then(function (r) {
        if (r && !r.ok) console.warn('[read] markConversationRead:', r.error);
        if (otherId && unreadByContact[otherId]) {
            unreadByContact[otherId] = 0;
            if (!document.getElementById('contacts-view').classList.contains('hidden')) {
                renderContacts(allContacts);
            }
        }
    }).catch(function () {});
}

/* ---- ضبط صدا ---- */
function formatTimer(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function updateRecordingTimerUI() {
    var node = document.getElementById('recording-timer');
    if (node) node.textContent = formatTimer(recordingSeconds);
}
function startRecordingTimer() {
    stopRecordingTimer();
    recordingSeconds = 0;
    updateRecordingTimerUI();
    var indicator = document.getElementById('recording-indicator');
    if (indicator) indicator.classList.remove('hidden', 'warning', 'danger');
    recordingTimer = setInterval(function () {
        recordingSeconds++;
        updateRecordingTimerUI();
        if (recordingSeconds >= RECORDING_MAX_SECONDS) {
            stopRecordingTimer();
            if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
                try { mediaRecorder.stop(); } catch (e) {}
                isRecording = false;
                document.getElementById('mic-btn').classList.remove('recording');
            }
        } else if (recordingSeconds >= RECORDING_MAX_SECONDS - 10) {
            var ind = document.getElementById('recording-indicator');
            if (ind) { ind.classList.remove('warning'); ind.classList.add('danger'); }
        } else if (recordingSeconds >= RECORDING_WARNING_SECONDS) {
            var ind2 = document.getElementById('recording-indicator');
            if (ind2 && !ind2.classList.contains('danger')) ind2.classList.add('warning');
        }
    }, 1000);
}
function stopRecordingTimer() {
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    recordingSeconds = 0;
    var indicator = document.getElementById('recording-indicator');
    if (indicator) {
        indicator.classList.add('hidden');
        indicator.classList.remove('warning', 'danger');
    }
}

async function toggleRecording() {
    var micBtn = document.getElementById('mic-btn');
    if (!isRecording) {
        try {
            var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            var options = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : { mimeType: 'audio/mp4' };
            mediaRecorder = new MediaRecorder(stream, options);
            mediaRecorder.ondataavailable = function (e) { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.onstop = async function () {
                stopRecordingTimer();
                var mimeType = mediaRecorder.mimeType || 'audio/webm';
                var audioBlob = new Blob(audioChunks, { type: mimeType });
                audioChunks = [];
                if (audioBlob.size > 0) await uploadVoiceBlob(audioBlob, mimeType);
                stream.getTracks().forEach(function (track) { track.stop(); });
            };
            audioChunks = [];
            mediaRecorder.start();
            isRecording = true;
            micBtn.classList.add('recording');
            startRecordingTimer();
        } catch (err) {
            document.getElementById('audio-upload').click();
        }
    } else {
        mediaRecorder.stop();
        isRecording = false;
        micBtn.classList.remove('recording');
    }
}

async function uploadVoiceBlob(blob, mimeType) {
    if (isSending) return;
    if (blob.size > MAX_AUDIO_FILE_SIZE) {
        alert('حجم پیام صوتی بیش از حد مجاز (۱۰ مگابایت) است.');
        return;
    }
    isSending = true;
    var micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.classList.add('busy');
    try {
        var otherUserId = currentTaskData
            ? (currentUser.id === currentTaskData.from_user_id ? currentTaskData.to_user_id : currentTaskData.from_user_id)
            : null;
        var res = await callBackend('sendVoiceMessage', { taskId: currentTaskId, blob: blob, mimeType: mimeType, otherUserId: otherUserId });
        if (res.ok) setTimeout(pollUpdates, 500);
        else alert('خطا در ارسال: ' + res.error);
    } catch (err) {
        alert('خطای شبکه یا دیتابیس: ' + err.message);
    } finally {
        if (micBtn) micBtn.classList.remove('busy');
        isSending = false;
    }
}

function handleAudioUpload(event) {
    var file = event.target.files[0];
    if (!file) return;

    if (file.size > MAX_AUDIO_FILE_SIZE) {
        alert('حجم فایل صوتی بیش از حد مجاز (۱۰ مگابایت) است.');
        event.target.value = '';
        return;
    }

    var audio = new Audio();
    var objectUrl = URL.createObjectURL(file);
    var handled = false;
    var finish = function (ok, errMsg) {
        if (handled) return;
        handled = true;
        try { URL.revokeObjectURL(objectUrl); } catch (e) {}
        if (!ok) {
            if (errMsg) alert(errMsg);
            event.target.value = '';
            return;
        }
        uploadVoiceBlob(file, file.type || 'audio/mp4');
        event.target.value = '';
    };

    var timeoutId = setTimeout(function () { finish(true); }, 5000);

    audio.onloadedmetadata = function () {
        clearTimeout(timeoutId);
        var dur = audio.duration;
        if (isFinite(dur) && dur > RECORDING_MAX_SECONDS + 5) {
            finish(false, 'مدت فایل صوتی (' + Math.round(dur) + ' ثانیه) بیش از حد مجاز ۲ دقیقه است.');
        } else {
            finish(true);
        }
    };
    audio.onerror = function () {
        clearTimeout(timeoutId);
        finish(true);
    };
    audio.src = objectUrl;
}

async function handleDeleteTask() {
    if (!confirm('آیا مطمئن هستید؟ این موضوع و همه پیام‌های آن حذف می‌شود.')) return;
    var res = await callBackend('deleteTask', { taskId: currentTaskId });
    if (res.ok) {
        currentTaskData = null;
        closeChat();
    } else {
        alert(res.error || 'خطا در حذف');
    }
}

/* ---- ارسال پیام: صف آفلاین + تضمین تحویل ---- */
async function sendTextMessage() {
    var input = document.getElementById('chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !currentTaskId) return;
    input.value = '';
    var otherUserId = currentTaskData
        ? (currentUser.id === currentTaskData.from_user_id ? currentTaskData.to_user_id : currentTaskData.from_user_id)
        : null;
    var item = {
        cid: newClientId(),
        taskId: currentTaskId,
        text: text,
        otherUserId: otherUserId,
        ts: Date.now(),
        attempt: 0,
        error: null
    };
    outbox.push(item);
    saveOutbox();
    renderPendingMessage(item);
    await flushOutbox();
}

/* ===== گروه‌ها ===== */
async function openGroups() {
    closeDrawer();
    document.getElementById('contacts-view').classList.add('hidden');
    document.getElementById('groups-view').classList.remove('hidden');
    await loadGroups();
}
function closeGroups() {
    document.getElementById('groups-view').classList.add('hidden');
    document.getElementById('contacts-view').classList.remove('hidden');
    loadContacts();
}

async function loadGroups() {
    var container = document.getElementById('groups-list-container');
    container.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    var res = await callBackend('getGroups');
    container.innerHTML = '';
    if (!res.ok) {
        container.appendChild(el('p', 'empty-note', res.error || 'گروه‌ها در دسترس نیستند'));
        return;
    }
    if (!res.groups.length) {
        container.appendChild(el('p', 'empty-note', 'هنوز گروهی ندارید. با دکمهٔ بالا گروه بسازید.'));
        return;
    }
    res.groups.forEach(function (g) {
        var item = el('div', 'contact-item');
        item.appendChild(el('div', 'avatar', String(g.name || 'گ').charAt(0)));
        var info = el('div', 'contact-info');
        var nameRow = el('div', 'contact-name');
        nameRow.appendChild(el('span', null, g.name));
        nameRow.appendChild(el('span', 'contact-role', (g.members ? g.members.length : 0) + ' عضو'));
        info.appendChild(nameRow);
        var names = (g.members || []).map(function (m) { return m.name; }).join('، ');
        info.appendChild(el('div', 'contact-last-msg', names || 'بدون عضو'));
        item.appendChild(info);
        item.addEventListener('click', function () { openGroupChat(g.id, g.name); });
        container.appendChild(item);
    });
}

function openCreateGroupModal() {
    var container = document.getElementById('group-members');
    container.innerHTML = '';
    if (!cachedUsers.length) {
        db.from('profiles').select('*').then(function (res) {
            cachedUsers = (res && res.data) || [];
            openCreateGroupModal();
        });
        return;
    }
    cachedUsers.forEach(function (u) {
        if (!u.active || u.id === currentUser.id || u.username === 'admin') return;
        var label = el('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = u.id;
        label.appendChild(box);
        label.appendChild(el('span', null, u.name));
        container.appendChild(label);
    });
    document.getElementById('group-name').value = '';
    openModalEl(document.getElementById('group-modal'));
}
function closeCreateGroupModal() { closeModalEl(document.getElementById('group-modal')); }

async function submitNewGroup() {
    var name = document.getElementById('group-name').value.trim();
    if (!name) return alert('نام گروه الزامی است');
    var memberIds = Array.prototype.slice
        .call(document.querySelectorAll('#group-members input:checked'))
        .map(function (cb) { return cb.value; });
    if (!memberIds.length) return alert('حداقل یک عضو انتخاب کنید');
    var btn = document.getElementById('save-group-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
    try {
        var res = await callBackend('createGroup', { name: name, memberIds: memberIds });
        if (!res.ok) throw new Error(res.error || 'خطا');
        closeCreateGroupModal();
        await loadGroups();
    } catch (err) {
        alert('خطا: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'ساخت گروه'; }
    }
}

async function openGroupChat(groupId, name) {
    currentGroupId = groupId;
    groupRenderedIds.clear();
    groupLastAt = null;
    document.getElementById('groups-view').classList.add('hidden');
    document.getElementById('group-chat-view').classList.remove('hidden');
    document.getElementById('group-chat-title').textContent = name || 'گروه';
    var area = document.getElementById('group-messages-area');
    area.innerHTML = '<p class="empty-note">در حال دریافت...</p>';
    await pollGroupMessages(true);
    if (groupPollInterval) clearInterval(groupPollInterval);
    groupPollInterval = setInterval(function () { pollGroupMessages(false); }, POLL_FALLBACK_MS);
}

function stopGroupPolling() {
    if (groupPollInterval) { clearInterval(groupPollInterval); groupPollInterval = null; }
}

function closeGroupChat() {
    stopGroupPolling();
    currentGroupId = null;
    document.getElementById('group-chat-view').classList.add('hidden');
    document.getElementById('groups-view').classList.remove('hidden');
    loadGroups();
}

async function pollGroupMessages(reset) {
    if (!currentGroupId) return;
    var area = document.getElementById('group-messages-area');
    var res = await callBackend('getGroupMessages', {
        groupId: currentGroupId,
        since: reset ? null : groupLastAt
    });
    if (!res.ok) {
        if (reset && area) {
            area.innerHTML = '';
            area.appendChild(el('p', 'empty-note', res.error || 'خطا در دریافت پیام‌های گروه'));
        }
        return;
    }
    var note = area.querySelector('.empty-note');
    if (note && res.messages.length) note.parentNode.removeChild(note);
    res.messages.forEach(function (m) {
        if (groupRenderedIds.has(m.id)) return;
        groupRenderedIds.add(m.id);
        groupLastAt = latestOf(groupLastAt, m.created_at);
        renderGroupMessage(m);
    });
    if (reset && !res.messages.length) {
        area.innerHTML = '';
        area.appendChild(el('p', 'empty-note', 'هنوز پیامی در این گروه نیست.'));
    }
    area.scrollTop = area.scrollHeight;
}

function renderGroupMessage(m) {
    var area = document.getElementById('group-messages-area');
    if (!area) return;
    var mine = m.from_user_id === currentUser.id;
    var bubble = el('div', 'message ' + (mine ? 'me' : 'other'));
    bubble.dataset.id = m.id;
    var sender = null;
    if (!mine) {
        var found = cachedUsers.filter(function (u) { return u.id === m.from_user_id; })[0];
        sender = found ? found.name : 'همکار';
        bubble.appendChild(el('div', 'msg-sender', sender));
    }
    bubble.appendChild(el('div', 'msg-text', m.content));
    var meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'msg-time', formatMsgTime(m.created_at)));
    bubble.appendChild(meta);
    area.appendChild(bubble);
}

async function sendGroupMessage() {
    var input = document.getElementById('group-chat-input');
    var text = input.value.trim();
    if (!text || !currentGroupId) return;
    input.value = '';
    var res = await callBackend('sendGroupMessage', { groupId: currentGroupId, text: text, clientId: newClientId() });
    if (!res.ok) {
        alert('ارسال نشد: ' + res.error);
        input.value = text;
        return;
    }
    await pollGroupMessages(false);
}

/* ===== تقویم شمسی ===== */
var jMonths = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
function initCalendar() {
    var y = document.getElementById('jYear');
    var m = document.getElementById('jMonth');
    var n = new Date();
    var jn = gregorian_to_jalali(n.getFullYear(), n.getMonth() + 1, n.getDate());
    y.innerHTML = '';
    for (var i = jn[0] - 1; i <= jn[0] + 2; i++) {
        y.innerHTML += '<option value="' + i + '"' + (i === jn[0] ? ' selected' : '') + '>' + i + '</option>';
    }
    m.innerHTML = '';
    for (var j = 0; j < 12; j++) {
        m.innerHTML += '<option value="' + (j + 1) + '"' + (j + 1 === jn[1] ? ' selected' : '') + '>' + jMonths[j] + '</option>';
    }
    updateDays();
    m.onchange = updateDays;
    y.onchange = updateDays;
}
function updateDays() {
    var y = parseInt(document.getElementById('jYear').value, 10);
    var m = parseInt(document.getElementById('jMonth').value, 10);
    var d = document.getElementById('jDay');
    var days = 31;
    if (m >= 7 && m <= 11) days = 30;
    if (m === 12) days = isLeapJalali(y) ? 30 : 29;
    var cd = parseInt(d.value, 10) || 1;
    d.innerHTML = '';
    for (var i = 1; i <= days; i++) {
        d.innerHTML += '<option value="' + i + '"' + (i === cd ? ' selected' : '') + '>' + i + '</option>';
    }
}
function isLeapJalali(jy) { return [1, 5, 9, 13, 17, 22, 26, 30].indexOf(jy % 33) !== -1; }
function jalali_to_gregorian(jy, jm, jd) {
    var gy = (jy <= 979) ? 621 : 1600;
    jy -= (jy <= 979) ? 0 : 979;
    var days = (365 * jy) + (parseInt(jy / 33, 10) * 8) + parseInt(((jy % 33) + 3) / 4, 10) + 78 + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    gy += 400 * parseInt(days / 146097, 10);
    days %= 146097;
    if (days > 36524) { gy += 100 * parseInt(--days / 36524, 10); days %= 36524; if (days >= 365) days++; }
    gy += 4 * parseInt(days / 1461, 10);
    days %= 1461;
    if (days > 365) { gy += parseInt((days - 1) / 365, 10); days = (days - 1) % 365; }
    var gd = days + 1;
    var sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var gm;
    for (gm = 0; gm < 13 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
    return [gy, gm, gd];
}
function gregorian_to_jalali(gy, gm, gd) {
    var g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = (365 * gy) + (parseInt((gy2 + 3) / 4, 10)) - (parseInt((gy2 + 99) / 100, 10)) + (parseInt((gy2 + 399) / 400, 10)) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * (parseInt(days / 12053, 10));
    days %= 12053;
    jy += 4 * (parseInt(days / 1461, 10));
    days %= 1461;
    if (days > 365) { jy += parseInt((days - 1) / 365, 10); days = (days - 1) % 365; }
    var jm = (days < 186) ? 1 + parseInt(days / 31, 10) : 7 + parseInt((days - 186) / 30, 10);
    var jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return [jy, jm, jd];
}

async function openCreateModalFromProfile() {
    openModalEl(document.getElementById('create-modal'));
    initCalendar();
}
function closeCreateModal() { closeModalEl(document.getElementById('create-modal')); }

async function submitNewTask() {
    var title = document.getElementById('task-title').value;
    var desc = document.getElementById('task-desc').value;
    var time = document.getElementById('task-time').value;
    var jy = parseInt(document.getElementById('jYear').value, 10);
    var jm = parseInt(document.getElementById('jMonth').value, 10);
    var jd = parseInt(document.getElementById('jDay').value, 10);
    var g = jalali_to_gregorian(jy, jm, jd);
    var date = g[0] + '-' + (g[1] < 10 ? '0' + g[1] : g[1]) + '-' + (g[2] < 10 ? '0' + g[2] : g[2]);
    if (!title) return alert('عنوان الزامی است');
    var res = await callBackend('createTask', {
        title: title, description: desc, to_user_id: currentContactId, due_date: date, due_time: time
    });
    if (res.ok) {
        closeCreateModal();
        openProfile(currentContactId, document.getElementById('profile-name').textContent, document.getElementById('profile-role').textContent);
    } else {
        alert(res.error);
    }
}

/* ===== به‌روزرسانی اپ اندروید ===== */
async function checkAppUpdate() {
    try {
        var res = await fetch('app-version.json?ts=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        var info = await res.json();
        var code = parseInt(info && info.versionCode, 10) || 0;
        if (!code) return;
        var seen = parseInt(localStorage.getItem('app_version_code') || '0', 10) || 0;
        if (!seen) {
            try { localStorage.setItem('app_version_code', String(code)); } catch (e) {}
            return;
        }
        if (code > seen) {
            appUpdateInfo = info;
            var bar = document.getElementById('update-bar');
            var text = document.getElementById('update-bar-text');
            if (text) text.textContent = 'نسخهٔ ' + (info.versionName || code) + ' اپ موجود است';
            if (bar) bar.classList.remove('hidden');
        }
    } catch (e) {}
}

function openAppUpdate() {
    if (!appUpdateInfo || !appUpdateInfo.url) return;
    var url;
    try {
        url = new URL(String(appUpdateInfo.url), window.location.href).href;
    } catch (e) {
        url = String(appUpdateInfo.url);
    }
    try {
        if (appHasNativeBridge()) {
            window.flutter_inappwebview.callHandler('openUrl', url).catch(function () {
                window.open(url, '_blank');
            });
        } else {
            window.open(url, '_blank');
        }
    } catch (e) {
        window.open(url, '_blank');
    }
    try { localStorage.setItem('app_version_code', String(appUpdateInfo.versionCode || 0)); } catch (e) {}
    dismissAppUpdate();
}

function dismissAppUpdate() {
    var bar = document.getElementById('update-bar');
    if (bar) bar.classList.add('hidden');
}

/* ===== راه‌اندازی ===== */
window.addEventListener('load', function () {
    installErrorMonitoring();
    updateThemeButton(document.documentElement.getAttribute('data-theme') || 'light');

    if (window.supabase) {
        db = window.supabase.createClient('https://trnzzevllluhkyvvrtms.supabase.co', 'sb_publishable_Kn5TfcuZGZrPjfQ8IGbNeg_KX2nVLsc');
        db.auth.getSession().then(function (res) {
            var session = res && res.data ? res.data.session : null;
            if (!session) return;
            db.from('profiles').select('*').eq('id', session.user.id).single().then(function (profileRes) {
                var profile = profileRes && profileRes.data;
                if (!profile) return;
                currentUser = profile;
                loadOutbox();
                showContactsView();
                loadNotifications();
                startHeartbeat();
                subscribePush({ silent: true }).catch(function () {});
                flushOutbox();
                checkAppUpdate();
            });
        }).catch(function () {
            // نشانهٔ ورود خراب/منقضی: پاک می‌شود تا صفحه با فرم ورود باز شود
            try { db.auth.signOut({ scope: 'local' }); } catch (e) {}
        });
    }
});

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    updateNotifBanner();
    if (currentUser) {
        loadNotifications();
        loadUnreadCounts();
        flushOutbox();
        if (currentTaskId) pollUpdates(true);
        if (currentGroupId) pollGroupMessages(false);
    }
});

// هر ۶۰ ثانیه در حالت باز بودن صفحه، شمارندهٔ اعلان‌ها و بج تازه می‌شود
setInterval(function () {
    if (document.visibilityState !== 'visible' || !currentUser) return;
    loadNotifications();
    loadUnreadCounts();
}, 60000);

// تلاش دوبارهٔ صف ارسال
setInterval(function () {
    if (!currentUser) return;
    if (outbox.length) flushOutbox();
}, 20000);

window.addEventListener('online', function () {
    if (outbox.length) flushOutbox();
    if (currentTaskId) pollUpdates(true);
});

/* ارسال با Enter */
(function bindEnterToSend() {
    function bind(inputId, action) {
        var input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                action();
            }
        });
    }
    bind('chat-input', sendTextMessage);
    bind('group-chat-input', sendGroupMessage);
})();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(console.log);
    });
    navigator.serviceWorker.addEventListener('message', function (ev) {
        if (ev.data && ev.data.type === 'notification-click' && currentTaskId) pollUpdates(true);
    });
}
