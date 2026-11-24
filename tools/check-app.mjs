import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const problems = [];

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    problems.push('فایل ' + path + ' پیدا نشد');
    return '';
  }
}

// ۱) نحو اسکریپت اصلی
try {
  execFileSync(process.execPath, ['--check', 'app.js'], { stdio: 'pipe' });
} catch (e) {
  problems.push('app.js خطای نحو دارد: ' + String(e.stderr || e.message).trim());
}

const html = read('index.html');
const app = read('app.js');

// ۲) index.html باید اسکریپت را از فایل جداگانه بارگذاری کند
if (!/<script src="\.\/app\.js"><\/script>/.test(html)) {
  problems.push('index.html فایل app.js را بارگذاری نمی‌کند');
}

// ۳) هیچ داده‌ای نباید با innerHTML (قالب رشته‌ای) تزریق شود
const unsafeHtml = app.match(/innerHTML\s*\+?=\s*`[^`]*\$\{/g);
if (unsafeHtml) {
  problems.push('app.js از innerHTML با رشتهٔ قالبی استفاده می‌کند: ' + unsafeHtml.length + ' مورد');
}
for (const file of ['api/admin-users.js', 'api/login.js', 'api/client-log.js', 'api/send-push.js']) {
  const src = read(file);
  if (!src) continue;
  if (src.indexOf('admin') !== -1 && /password/i.test(src) && file === 'api/client-log.js') {
    problems.push(file + ' نباید رمز عبور ببیند');
  }
}

// ۴) سیاست‌های امنیتی نباید حذف/سست شده باشند
const sqlFiles = ['supabase/security.sql', 'supabase/rbac-sessions.sql', 'supabase/groups.sql', 'supabase/audit.sql'];
for (const file of sqlFiles) {
  const sql = read(file);
  if (!sql) continue;
  if (/alter table [\s\S]{0,80}disable row level security/i.test(sql)) {
    problems.push(file + ' RLS را غیرفعال می‌کند');
  }
  if (/policy[\s\S]{0,120}using\s*\(\s*true\s*\)/i.test(sql)) {
    problems.push(file + ' سیاستی با using(true) دارد');
  }
}

// ۵) سرویس‌ورکر باید فایل‌های جدید را کش کند
const sw = read('sw.js');
for (const asset of ['./app.js', './app-version.json']) {
  if (sw.indexOf(asset) === -1) problems.push('sw.js فهرست کش را به‌روز ندارد: ' + asset);
}

if (problems.length) {
  console.error('بررسی ناموفق:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('بررسی اپ با موفقیت انجام شد.');
