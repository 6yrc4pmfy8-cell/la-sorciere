/*
  Agent revendeur La Sorcière ✦ — backend zéro dépendance (Node 18+).
  Flux : client paie par Mobile Money (Campay) → webhook Campay → commande
  automatique sur exobooster au prix de gros → la marge reste pour La Sorcière.

  Lancement test  : MOCK=1 PORT=4567 node server.js
  Lancement réel  : CAMPAY_USERNAME=... CAMPAY_PASSWORD=... CAMPAY_WEBHOOK_SECRET=...
                    EXO_API_KEY=... EXO_ABO_SERVICE=... EXO_TT_SERVICE=...
                    SITE_URL=https://mon-serveur.onrender.com node server.js
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CFG = {
  MOCK: process.env.MOCK === "1",
  PORT: parseInt(process.env.PORT || "4567", 10),
  SITE_URL: process.env.SITE_URL || "http://localhost:" + (process.env.PORT || "4567"),
  CAMPAY_BASE: (process.env.CAMPAY_BASE || "https://campay.net").replace(/\/+$/, ""), // test : https://demo.campay.net
  CAMPAY_TOKEN: process.env.CAMPAY_TOKEN || "",                  // jeton permanent (APP KEYS)
  CAMPAY_WEBHOOK_SECRET: process.env.CAMPAY_WEBHOOK_SECRET || "",
  EXO_API_URL: process.env.EXO_API_URL || "https://exosupplier.com/api/v2",
  EXO_API_KEY: process.env.EXO_API_KEY || "",
  USD_XAF: parseFloat(process.env.USD_XAF || "600"), // taux USD → FCFA pour le prix de gros
  NOTIFY_PHONE: process.env.NOTIFY_PHONE || "",          // ton numéro WhatsApp (237…)
  CALLMEBOT_APIKEY: process.env.CALLMEBOT_APIKEY || "",  // clé gratuite callmebot.com
  CALLMEBOT_BASE: process.env.CALLMEBOT_BASE || "https://api.callmebot.com/whatsapp.php",
};

/* ---- Catalogue : prix CLIENT (ce que paie le client) + service exosupplier (prix de gros) ----
   IDs vérifiés sur https://exosupplier.com/api/v2 le 2026-09-21 (action=services).
   usdPer100 = prix de gros pour 100 unités ; marge = prix client − gros × taux USD_XAF. */
const SERVICES = {
  abo: {
    label: "Abonnés",
    clientPer100: 500,                                   // 500 FCFA / 100 abonnés (prix La Sorcière)
    exoByPlatform: {
      TikTok:    { id: process.env.EXO_ABO_TIKTOK    || "3036", usdPer100: 0.35 }, // qualité moyenne
      Instagram: { id: process.env.EXO_ABO_INSTAGRAM || "3106", usdPer100: 0.20 }, // qualité moyenne
      Facebook:  { id: process.env.EXO_ABO_FACEBOOK  || "3123", usdPer100: 0.20 }, // page, qualité moyenne
    },
  },
  tt: {
    label: "TikTok monétisé",
    clientFlat: 5000,                                    // 5 000 FCFA (prix La Sorcière)
    exoServiceId: process.env.EXO_TT_SERVICE || "",      // ⚠️ absent du catalogue exosupplier → exécution manuelle
    exoFlat: parseInt(process.env.EXO_TT_FLAT || "0", 10),
  },
};

const ORDERS_FILE = path.join(__dirname, "orders.json");
let orders = {};
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch (_) {}
function saveOrders() { if (!CFG.MOCK) fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
function newRef() { return "LS-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(); }
function clientPrice(service, qty) {
  const s = SERVICES[service];
  if (!s) return null;
  if (service === "tt") return s.clientFlat;
  return Math.max(1, Math.round(qty / 100)) * s.clientPer100;
}
function wholesale(service, qty, platform) {
  const s = SERVICES[service];
  if (service === "tt") return s.exoFlat || null;
  const p = s.exoByPlatform[platform] || s.exoByPlatform.TikTok;
  const packs = Math.max(1, Math.round((qty || 0) / 100));
  return Math.round(packs * p.usdPer100 * CFG.USD_XAF);
}

/* ---------- Campay ---------- */
async function campayCollect(order) {
  if (CFG.MOCK) return { reference: "MOCK-" + order.ref, ussd_string: "*126*3*1*237XXXXXXX#", mock: true };
  const res = await fetch(CFG.CAMPAY_BASE + "/api/collect/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Token " + CFG.CAMPAY_TOKEN,
    },
    body: JSON.stringify({
      amount: order.clientPrice,
      currency: "XAF",
      from: order.phone,
      description: "La Sorciere - " + order.serviceLabel + (order.qty && order.service === "abo" ? " x" + order.qty : ""),
      external_reference: order.ref,
      callback_url: CFG.SITE_URL + "/api/campay/callback",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error_code) throw new Error("Campay " + (data.error_code || res.status) + ": " + (data.message || data.detail || ""));
  return data; // {reference, status, ussd_string?, redirect_url?}
}

/* Signature webhook Campay : JWT (HS256) signé avec le Webhook Secret
   — méthode identique à ValidateCallback du SDK officiel campay-go-sdk. */
function campaySignatureOK(body) {
  if (!CFG.CAMPAY_WEBHOOK_SECRET) return true; // non configuré : on accepte (mode dev)
  const parts = String(body.signature || "").split(".");
  if (parts.length !== 3) return false;
  const expected = crypto.createHmac("sha256", CFG.CAMPAY_WEBHOOK_SECRET)
    .update(parts[0] + "." + parts[1]).digest();
  const given = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/* ---------- exosupplier (API SMM standard : key + action=add) ---------- */
async function exoAdd(order) {
  const s = SERVICES[order.service];
  const serviceId = order.service === "abo"
    ? ((s.exoByPlatform[order.platform] || s.exoByPlatform.TikTok).id)
    : s.exoServiceId;
  const exoOrder = { service_id: serviceId, quantity: order.qty, link: order.link, wholesale: order.wholesale };
  if (CFG.MOCK) {
    exoOrder.order_id = "EXO-MOCK-" + Math.floor(Math.random() * 1e6);
    return exoOrder;
  }
  if (!CFG.EXO_API_KEY || !serviceId) throw new Error("exosupplier non configuré (EXO_API_KEY / service ID)");
  const body = new URLSearchParams({ key: CFG.EXO_API_KEY, action: "add", service: String(serviceId), quantity: String(order.qty), link: order.link });
  const res = await fetch(CFG.EXO_API_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error("exosupplier: " + data.error);
  exoOrder.order_id = data.order || null;
  return exoOrder;
}

/* Notification WhatsApp automatique (CallMeBot, gratuit) — uniquement APRÈS paiement encaissé */
function notifyWhatsApp(order) {
  if (CFG.MOCK || !CFG.CALLMEBOT_APIKEY || !CFG.NOTIFY_PHONE) return Promise.resolve();
  const msg = "COMMANDE PAYEE " + order.ref
    + "\n" + order.serviceLabel + (order.service === "abo" ? " x" + order.qty : "")
    + " (" + order.platform + ")"
    + "\nLien: " + order.link
    + "\nMontant client: " + fmt(order.clientPrice) + " FCFA"
    + (order.margin != null ? "\nMarge: " + fmt(order.margin) + " FCFA" : "")
    + "\nStatut: " + order.status;
  const u = CFG.CALLMEBOT_BASE + "?phone=" + encodeURIComponent(CFG.NOTIFY_PHONE)
    + "&text=" + encodeURIComponent(msg) + "&apikey=" + encodeURIComponent(CFG.CALLMEBOT_APIKEY);
  return fetch(u).then(() => {}).catch(() => {});
}

/* ---------- HTTP ---------- */
function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (_) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, mock: CFG.MOCK, campay: !!CFG.CAMPAY_TOKEN, exo: !!CFG.EXO_API_KEY });
    }

    if (req.method === "POST" && url.pathname === "/api/quote") {
      const b = await readBody(req);
      const price = clientPrice(b.service, parseInt(b.qty, 10));
      if (price === null) return send(res, 400, { error: "service inconnu" });
      return send(res, 200, { service: b.service, qty: b.service === "tt" ? 1 : parseInt(b.qty, 10), clientPrice: price, clientPriceText: fmt(price) + " FCFA" });
    }

    if (req.method === "POST" && url.pathname === "/api/order") {
      const b = await readBody(req);
      const qty = parseInt(b.qty, 10);
      const phone = String(b.phone || "").replace(/[\s+]/g, "");
      const link = String(b.link || "").trim();
      if (!SERVICES[b.service]) return send(res, 400, { error: "service inconnu" });
      if (!/^237\d{9}$/.test(phone)) return send(res, 400, { error: "numéro Mobile Money invalide (format 237XXXXXXXXX)" });
      if (!/^https?:\/\/.+/.test(link)) return send(res, 400, { error: "lien du compte/vidéo manquant" });
      if (b.service === "abo" && (!qty || qty < 100 || qty % 100 !== 0)) return send(res, 400, { error: "quantité : minimum 100, par paliers de 100" });

      const ref = newRef();
      const price = clientPrice(b.service, qty);
      const platform = b.service === "abo" ? (SERVICES.abo.exoByPlatform[b.plateforme] ? b.plateforme : "TikTok") : "TikTok";
      orders[ref] = {
        ref, service: b.service, serviceLabel: SERVICES[b.service].label, platform,
        qty: b.service === "tt" ? 1 : qty, link, phone,
        clientPrice: price, wholesale: wholesale(b.service, qty, platform),
        margin: wholesale(b.service, qty, platform) !== null ? price - wholesale(b.service, qty, platform) : null,
        status: "awaiting_payment", created: new Date().toISOString(),
      };
      saveOrders();
      try {
        const pay = await campayCollect(orders[ref]);
        orders[ref].campay = pay;
        saveOrders();
        return send(res, 200, { ref, clientPrice: price, clientPriceText: fmt(price) + " FCFA", payment: pay });
      } catch (e) {
        orders[ref].status = "payment_error"; saveOrders();
        return send(res, 502, { error: String(e.message || e), ref });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/campay/callback") {
      const b = await readBody(req);
      if (!campaySignatureOK(b)) return send(res, 401, { error: "signature invalide" });
      const ref = b.external_reference;
      const order = orders[ref];
      if (!order) return send(res, 404, { error: "commande inconnue" });
      const ok = /succe/i.test(String(b.status || ""));
      if (!ok) { order.status = "payment_" + String(b.status || "failed").toLowerCase(); saveOrders(); return send(res, 200, { received: true }); }
      order.status = "paid";
      try {
        order.exoOrder = await exoAdd(order);
        order.status = "boosting";
      } catch (e) {
        order.status = "paid_fulfillment_failed";
        order.exoError = String(e.message || e);
      }
      saveOrders();
      notifyWhatsApp(order); // le client a payé → on prévient ton WhatsApp
      return send(res, 200, { received: true, status: order.status });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/status/")) {
      const order = orders[url.pathname.split("/").pop()];
      if (!order) return send(res, 404, { error: "commande inconnue" });
      const { phone, ...safe } = order;
      return send(res, 200, { ...safe, phone: phone.slice(0, 5) + "•••••" });
    }

    /* Tableau de bord des commandes : /admin?pass=… (mot de passe via ADMIN_PASS) */
    if (req.method === "GET" && url.pathname === "/admin") {
      const pass = url.searchParams.get("pass") || "";
      if (!pass || pass !== (process.env.ADMIN_PASS || "lasorciere")) return send(res, 401, { error: "mot de passe requis (?pass=...)" });
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const rows = Object.values(orders)
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))
        .map((o) => `<tr><td>${esc(o.ref)}</td><td>${esc(o.serviceLabel)}${o.service === "abo" ? " x" + o.qty : ""}</td><td><a href="${esc(o.link)}">${esc(o.link)}</a></td><td>${fmt(o.clientPrice)}</td><td>${o.wholesale == null ? "—" : fmt(o.wholesale)}</td><td>${o.margin == null ? "—" : fmt(o.margin)}</td><td>${esc(o.status)}</td><td>${esc(o.created)}</td></tr>`)
        .join("");
      const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commandes — La Sorcière</title><style>body{font:14px system-ui,sans-serif;background:#0b0618;color:#eee;padding:1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:.45rem .6rem;text-align:left;font-size:13px}a{color:#c4b5fd}h1{font-size:1.1rem}</style><h1>✦ Commandes La Sorcière</h1><table><tr><th>Réf</th><th>Service</th><th>Lien</th><th>Client (FCFA)</th><th>Gros</th><th>Marge</th><th>Statut</th><th>Date</th></tr>${rows || '<tr><td colspan="8">Aucune commande pour l’instant</td></tr>'}</table></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    send(res, 404, { error: "route inconnue" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(CFG.PORT, "0.0.0.0", () => {
  console.log("Agent La Sorcière démarré sur :" + CFG.PORT + (CFG.MOCK ? " (MOCK — Campay et exobooster simulés)" : " (réel)"));
});
