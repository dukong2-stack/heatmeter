// 증시 온도계 서비스 워커: 크롬 '앱 설치' 조건을 맞추고, 오프라인일 때 마지막 화면을 보여 줍니다.
// 항상 네트워크를 먼저 쓰므로 최신 데이터가 우선입니다.
const CACHE = "heatmeter-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const key = req.url.split("?")[0];
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key))
  );
});
