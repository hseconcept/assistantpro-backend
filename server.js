import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import sqlite3 from "sqlite3";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// WhatsApp Cloud (JSON)
app.use(express.json());
// Twilio Voice (form-urlencoded)
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// --- Defaults (tu peux changer plus tard) ---
const DEFAULT_TEMPLATE_NAME =
  process.env.DEFAULT_TEMPLATE_NAME || "assistant_cecilia_rdv";
const DEFAULT_TEMPLATE_LANG = process.env.DEFAULT_TEMPLATE_LANG || "fr";
const DEFAULT_CALENDLY_LINK =
  process.env.DEFAULT_CALENDLY_LINK || "https://calendly.com/franchises-yyyours";

// Admin API key (mets ce que tu veux sur Render)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "CHANGE_ME_LATER";

// --- DB ---
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    missed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done INTEGER DEFAULT 0
  )`);

  // Mapping Twilio number -> config (template, calendly, etc.)
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twilio_number TEXT UNIQUE,
    template_name TEXT,
    template_lang TEXT,
    calendly_link TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// --- sqlite helpers ---
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });

// --- Utils ---
function normalizeToWhatsapp(number) {
  if (!number) return "";
  let n = String(number).trim();
  if (n.startsWith("whatsapp:")) n = n.replace("whatsapp:", "");
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("0")) n = "33" + n.slice(1);
  return n; // ex: "33665200155"
}

function normalizeE164(number) {
  if (!number) return "";
  let n = String(number).trim();
  if (!n.startsWith("+")) n = "+" + n.replace(/^\+/, "");
  return n;
}

function requireAdmin(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

// --- WhatsApp Webhook Verify (Meta) ---
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === verifyToken) {
    console.log("✅ Webhook WhatsApp vérifié !");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Root
app.get("/", (_req, res) => res.status(200).send("OK BACKEND"));

// --- WhatsApp Senders ---
async function sendWhatsappTemplate(toWa, { templateName, lang, calendlyLink }) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error("❌ WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN manquant dans .env");
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWa, // "336..."
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: calendlyLink,
            },
          ],
        },
      ],
    },
  };

  console.log(
    `📨 Envoi WhatsApp TEMPLATE => to=${toWa} template=${templateName} link=${calendlyLink}`
  );

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  console.log("✅ Réponse WhatsApp API :", JSON.stringify(response.data));
}

// (optionnel)
async function sendWhatsappText(toWa, body) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error("❌ WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN manquant dans .env");
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWa,
    type: "text",
    text: { body },
  };

  console.log("📨 Envoi WhatsApp TEXTE vers :", toWa);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  console.log("✅ Réponse WhatsApp API (texte) :", JSON.stringify(response.data));
}

// --- WhatsApp Cloud inbound webhook (si besoin) ---
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 /webhook WhatsApp Cloud appelé");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];

    if (message) {
      const from = message.from; // "336..."
      const body = message.text?.body ?? "";
      console.log(`📩 Message WhatsApp reçu de ${from}: "${body}"`);

      await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [
        from,
        body,
      ]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erreur /webhook :", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

// --- ADMIN: manage clients mapping ---
app.post("/admin/clients", requireAdmin, async (req, res) => {
  try {
    const twilio_number = normalizeE164(req.body.twilio_number || "");
    if (!twilio_number) {
      return res.status(400).json({ error: "twilio_number is required" });
    }

    const template_name =
      req.body.template_name && req.body.template_name !== "DEFAULT"
        ? String(req.body.template_name)
        : null;
    const template_lang =
      req.body.template_lang && req.body.template_lang !== "DEFAULT"
        ? String(req.body.template_lang)
        : null;
    const calendly_link =
      req.body.calendly_link && req.body.calendly_link !== "DEFAULT"
        ? String(req.body.calendly_link)
        : null;

    const now = new Date().toISOString();

    await dbRun(
      `
      INSERT INTO clients (twilio_number, template_name, template_lang, calendly_link, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(twilio_number) DO UPDATE SET
        template_name=excluded.template_name,
        template_lang=excluded.template_lang,
        calendly_link=excluded.calendly_link,
        updated_at=excluded.updated_at
    `,
      [twilio_number, template_name, template_lang, calendly_link, now]
    );

    const saved = await dbGet(
      "SELECT * FROM clients WHERE twilio_number = ?",
      [twilio_number]
    );

    return res.json({ ok: true, client: saved });
  } catch (err) {
    console.error("Erreur /admin/clients :", err.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/admin/clients", requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(
      "SELECT * FROM clients ORDER BY updated_at DESC"
    );
    res.json({ ok: true, clients: rows });
  } catch (err) {
    console.error("Erreur GET /admin/clients :", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Resolve config from Twilio number (fallback to defaults)
async function getClientConfigForTwilioNumber(twilioTo) {
  const toE164 = normalizeE164(twilioTo);

  const row = await dbGet("SELECT * FROM clients WHERE twilio_number = ?", [
    toE164,
  ]);

  return {
    templateName: row?.template_name || DEFAULT_TEMPLATE_NAME,
    lang: row?.template_lang || DEFAULT_TEMPLATE_LANG,
    calendlyLink: row?.calendly_link || DEFAULT_CALENDLY_LINK,
    matchedClient: row || null,
  };
}

/* === 🟣 TWILIO VOICE WEBHOOK === */
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // ex: +33665200155
    const to = req.body.To; // ex: +33948353493 (le numéro twilio appelé)
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", { from, to, callSid });

    const waNumber = normalizeToWhatsapp(from);

    // store followup
    await dbRun("INSERT INTO followups (from_number) VALUES (?)", [waNumber]);

    // pick config from "to" number
    const cfg = await getClientConfigForTwilioNumber(to);
    console.log(
      "🧩 Config résolue:",
      cfg.matchedClient
        ? { twilio: to, template: cfg.templateName, link: cfg.calendlyLink }
        : { twilio: to, template: cfg.templateName, link: cfg.calendlyLink, note: "DEFAULT" }
    );

    // send WA template
    try {
      await sendWhatsappTemplate(waNumber, cfg);
      console.log("✅ WhatsApp envoyé après appel Twilio pour", waNumber);
    } catch (e) {
      console.error(
        "Erreur envoi WhatsApp (immédiat) :",
        e?.response?.data || e.message
      );
    }

    // Reject call (no voice)
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Reject reason="busy"/></Response>';

    res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("Erreur /twilio/voice :", err.message);

    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Reject reason="busy"/></Response>';

    res.type("text/xml").send(twiml);
  }
});

// --- Follow-up loop ---
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups...");

    const followups = await dbAll(
      `
      SELECT id, from_number, missed_at
      FROM followups
      WHERE done = 0
        AND missed_at <= datetime('now', '-1 minute')
    `
    );

    for (const f of followups) {
      const { id, from_number, missed_at } = f;

      const reply = await dbGet(
        `
        SELECT 1 FROM messages
        WHERE from_number = ?
          AND created_at > ?
          AND body != "__missed_call__"
        LIMIT 1
      `,
        [from_number, missed_at]
      );

      if (reply) {
        console.log(`❌ Pas de relance, ${from_number} a déjà répondu.`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      // Relance: on renvoie le même template DEFAULT (ou custom si tu veux plus tard)
      try {
        console.log(`🔁 Relance automatique envoyée à ${from_number}`);
        await sendWhatsappTemplate(from_number, {
          templateName: DEFAULT_TEMPLATE_NAME,
          lang: DEFAULT_TEMPLATE_LANG,
          calendlyLink: DEFAULT_CALENDLY_LINK,
        });
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
      } catch (e) {
        console.error(
          "Erreur envoi WhatsApp (relance) :",
          e?.response?.data || e.message
        );
      }
    }
  } catch (err) {
    console.error("Erreur relance :", err.message);
  }
}, CHECK_INTERVAL_MS);

app.get("/health", (_req, res) => {
  res.status(200).send("healthy");
});
app.listen(PORT, () => {
  console.log(`🚀 Backend Assistant Pro running on port ${PORT}`);
  if (ADMIN_API_KEY === "CHANGE_ME_LATER") {
    console.warn(
      "⚠️ ADMIN_API_KEY est sur la valeur par défaut. Mets une vraie clé sur Render."
    );
  }
});


