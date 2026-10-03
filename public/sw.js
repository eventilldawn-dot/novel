/**
 * sw.js — 让 app 在电脑没开机时也能在手机上打开
 *
 * 策略：
 *   · 页面和静态资源：缓存优先，后台更新（离线也能打开）
 *   · /api/* 一律不碰，永远走网络（不然会把旧剧情当成新的）
 *   · 跨域请求（模型接口、隧道）一律不碰
 */

const CACHE = 'novel-shell-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './favicon.svg',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/api.js',
  './js/engine.js',
  './js/presets.js',
  './js/prompt.js',
  './js/sheet.js',
  './js/store.js',
  './js/sync.js',
  './js/ui.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;      // 跨域（模型接口 / 隧道）不插手
  if (url.pathname.includes('/api/')) return;           // 接口永远走网络

  // 打开页面：先试网络，失败就用缓存里的壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // 静态资源：网络优先（保证更新立刻生效），断网时回退到缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
