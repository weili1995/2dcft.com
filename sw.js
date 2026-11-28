// Decrypts the site on this device. Keys come from the password page (index.html) and stay in this browser's IndexedDB.
const BASE = new URL(self.registration.scope).pathname;
const PUBLIC = /^(sw\.js$|d\/|robots\.txt$|CNAME$)/;
const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", pdf: "application/pdf", woff2: "font/woff2", xml: "application/xml" };
const enc = new TextEncoder();
const db = () => new Promise((ok, no) => {
  const r = indexedDB.open("2dcft", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("k");
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
const idb = async (mode, f) => {
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction("k", mode), q = f(t.objectStore("k"));
    t.oncomplete = () => { d.close(); ok(q.result); };
    t.onerror = () => { d.close(); no(t.error); };
  });
};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || e.request.method !== "GET" || !u.pathname.startsWith(BASE)) return;
  const rel = decodeURIComponent(u.pathname.slice(BASE.length));
  if (!PUBLIC.test(rel)) e.respondWith(serve(rel, e.request));
});
async function open(keys, path) {
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, enc.encode(path)));
  const name = [...h].slice(0, 20).map((x) => x.toString(16).padStart(2, "0")).join("");
  const r = await fetch(BASE + "d/" + name, { cache: "no-cache" });  // GitHub Pages says max-age=600: ask again (cheap 304s), so a publish shows at once
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("network " + r.status);
  const b = new Uint8Array(await r.arrayBuffer());
  const p = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: enc.encode(path) }, keys.aes, b.subarray(12)));
  const body = p.subarray(5, 5 + new DataView(p.buffer).getUint32(1));
  return p[0] ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : body;
}
const reply = (body, path, status = 200) => new Response(body, { status, headers: { "Content-Type": TYPES[path.split(".").pop()] || "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function serve(rel, request) {
  if (rel === "lock") {
    await idb("readwrite", (s) => s.delete("keys"));
    return Response.redirect(BASE, 302);
  }
  const keys = await idb("readonly", (s) => s.get("keys")).catch(() => null);
  if (!keys) return fetch(request);
  if (keys.idle) {  // "Remember on this device" was unticked: forget the key after keys.idle ms without opening a page
    if (Date.now() - (keys.seen || 0) > keys.idle) {
      await idb("readwrite", (s) => s.delete("keys"));
      return fetch(request);
    }
    if (request.mode === "navigate") await idb("readwrite", (s) => s.put({ ...keys, seen: Date.now() }, "keys")).catch(() => {});
  }
  const path = rel === "" || rel.endsWith("/") ? rel + "index.html" : rel;
  try {
    const body = await open(keys, path);
    if (body) return reply(body, path);
    if (rel && !rel.endsWith("/") && (await open(keys, rel + "/index.html"))) return Response.redirect(BASE + rel + "/", 302);
    const missing = await open(keys, "404.html");
    if (missing) return reply(missing, "404.html", 404);
    // none of the names exist: these keys belong to an earlier password
    await idb("readwrite", (s) => s.delete("keys"));
    return fetch(request);
  } catch (err) {
    if (err.name === "OperationError") {
      await idb("readwrite", (s) => s.delete("keys"));
      return fetch(request);
    }
    return new Response("The page could not be loaded. Check the connection and reload.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
