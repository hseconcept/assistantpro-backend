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

// --- Defaults ---
const DEFAULT_TEMPLATE_NAME =
  process.env.DEFAULT_TEMPLATE_NAME || "appel_manque";
const DEFAULT_TEMPLATE_LANG = process.env.DEFAULT_TEMPLATE_LANG || "fr";
const DEFAULT_CALENDLY_LINK =
  process.env.DEFAULT_CALENDLY_LINK || "https://calendly.com/franchises-yyours";

const DEFAULT_CONTACT_NAME =
  process.env.DEFAULT_CONTACT_NAME || "Cecilia";
const DEFAULT_COMPANY_NAME =
  process.env.DEFAULT_COMPANY_NAME || "YYours";

const FOLLOWUP_TEMPLATE_NAME =
  process.env.FOLLOWUP_TEMPLATE_NAME || "relance_appel_manque";

const FOLLOWUP_DELAY_MINUTES = Number(
  process.env.FOLLOWUP_DELAY_MINUTES || 2
);

// Admin API key
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "CHANGE_ME_LATER";

// --- DB ---
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

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

function safeAlter(sql) {
  db.run(sql, (err) => {
    if (
      err &&
      !String(err.message || "").includes("duplicate column name")
    ) {
      console.error("Erreur migration SQLite :", err.message);
    }
  });
}

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
    twilio_number TEXT,
    initial_template TEXT,
    followup_template TEXT,
    calendly_link TEXT,
    contact_name TEXT,
    company_name TEXT,
    missed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done INTEGER DEFAULT 0,
    reply_received INTEGER DEFAULT 0,
    initial_message_id TEXT,
    followup_message_id TEXT,
    followup_sent_at DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twilio_number TEXT UNIQUE,
    template_name TEXT,
    template_lang TEXT,
    calendly_link TEXT,
    contact_name TEXT,
    company_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS whatsapp_outbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_number TEXT,
    template_name TEXT,
    lang TEXT,
    parameters_json TEXT,
    wa_message_id TEXT UNIQUE,
    status TEXT,
    status_timestamp DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw_response_json TEXT,
    raw_status_json TEXT
  )`);

  safeAlter(`ALTER TABLE clients ADD COLUMN contact_name TEXT`);
  safeAlter(`ALTER TABLE clients ADD COLUMN company_name TEXT`);

  safeAlter(`ALTER TABLE followups ADD COLUMN twilio_number TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN initial_template TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN followup_template TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN calendly_link TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN contact_name TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN company_name TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN reply_received INTEGER DEFAULT 0`);
  safeAlter(`ALTER TABLE followups ADD COLUMN initial_message_id TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN followup_message_id TEXT`);
  safeAlter(`ALTER TABLE followups ADD COLUMN followup_sent_at DATETIME`);
});

// --- Utils ---
function normalizeToWhatsapp(number) {
  if (!number) return "";

  let n = String(number).trim();

  if (n.startsWith("whatsapp:")) {
    n = n.replace("whatsapp:", "");
  }

  n = n.replace(/[\s\-()]/g, "");

  // cas renvoi Maurice qui transforme +33... en +2300033...
  if (n.startsWith("+23000")) {
    n = "+" + n.slice(6);
  }

  // cas standard 00XXXXXXXX -> +XXXXXXXX
  if (n.startsWith("00")) {
    n = "+" + n.slice(2);
  }

  // si pas de +, on l'ajoute
  if (!n.startsWith("+")) {
    n = "+" + n;
  }

  return n;
}

function normalizeE164(number) {
  if (!number) return "";

  let n = String(number).trim();

  if (n.startsWith("whatsapp:")) {
    n = n.replace("whatsapp:", "");
  }

  n = n.replace(/[\s\-()]/g, "");

  if (n.startsWith("00")) {
    n = "+" + n.slice(2);
  }

  if (!n.startsWith("+")) {
    n = "+" + n;
  }

  return n;
}

function unixSecondsToIso(ts) {
  if (!ts) return null;
  const date = new Date(Number(ts) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

// --- Resolve config from Twilio number (fallback to defaults) ---
async function getClientConfigForTwilioNumber(twilioTo) {
  const toE164 = normalizeE164(twilioTo);

  const row = await dbGet("SELECT * FROM clients WHERE twilio_number = ?", [
    toE164,
  ]);

  return {
    templateName: row?.template_name || DEFAULT_TEMPLATE_NAME,
    lang: row?.template_lang || DEFAULT_TEMPLATE_LANG,
    calendlyLink: row?.calendly_link || DEFAULT_CALENDLY_LINK,
    contactName: row?.contact_name || DEFAULT_CONTACT_NAME,
    companyName: row?.company_name || DEFAULT_COMPANY_NAME,
    matchedClient: row || null,
  };
}

// --- WhatsApp Senders ---
async function sendWhatsappTemplate(toWa, { templateName, lang, parameters }) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error("❌ WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN manquant dans .env");
    return null;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWa,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: parameters.map((value) => ({
            type: "text",
            text: String(value ?? ""),
          })),
        },
      ],
    },
  };

  console.log(
    `📨 Envoi WhatsApp TEMPLATE => to=${toWa} template=${templateName} parameters=${JSON.stringify(parameters)}`
  );

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  console.log("✅ Réponse WhatsApp API :", JSON.stringify(response.data));

  const messageId = response?.data?.messages?.[0]?.id || null;
  const messageStatus = response?.data?.messages?.[0]?.message_status || "accepted";

  await dbRun(
    `INSERT INTO whatsapp_outbound
      (to_number, template_name, lang, parameters_json, wa_message_id, status, raw_response_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      toWa,
      templateName,
      lang,
      JSON.stringify(parameters || []),
      messageId,
      messageStatus,
      JSON.stringify(response.data || {}),
    ]
  );

  return {
    messageId,
    status: messageStatus,
    raw: response.data,
  };
}

// (optionnel)
async function sendWhatsappText(toWa, body) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error("❌ WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN manquant dans .env");
    return null;
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
  return response.data;
}

// --- WhatsApp Cloud inbound webhook + statuses ---
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 /webhook WhatsApp Cloud appelé");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages || [];
    const statuses = value?.statuses || [];

    // 1) Messages entrants
    for (const message of messages) {
      const from = normalizeToWhatsapp(message.from || "");
      const body = message.text?.body ?? "";

      console.log(`📩 Message WhatsApp reçu de ${from}: "${body}"`);

      await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [
        from,
        body,
      ]);

      // Annule les followups en attente pour ce numéro
      await dbRun(
        `UPDATE followups
         SET reply_received = 1, done = 1
         WHERE from_number = ? AND done = 0`,
        [from]
      );

      console.log(`✅ Relances annulées pour ${from} suite à réponse entrante`);
    }

    // 2) Statuts des messages sortants
    for (const statusItem of statuses) {
      const waMessageId = statusItem.id;
      const status = statusItem.status || null;
      const statusTimestamp = unixSecondsToIso(statusItem.timestamp);

      console.log(
        `📬 Statut WhatsApp reçu => id=${waMessageId} status=${status}`
      );

      await dbRun(
        `UPDATE whatsapp_outbound
         SET status = ?,
             status_timestamp = ?,
             raw_status_json = ?
         WHERE wa_message_id = ?`,
        [
          status,
          statusTimestamp,
          JSON.stringify(statusItem || {}),
          waMessageId,
        ]
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Erreur /webhook :", err?.response?.data || err.message);
    return res.sendStatus(200);
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

    const contact_name =
      req.body.contact_name && req.body.contact_name !== "DEFAULT"
        ? String(req.body.contact_name)
        : null;

    const company_name =
      req.body.company_name && req.body.company_name !== "DEFAULT"
        ? String(req.body.company_name)
        : null;

    const now = new Date().toISOString();

    await dbRun(
      `
      INSERT INTO clients (
        twilio_number,
        template_name,
        template_lang,
        calendly_link,
        contact_name,
        company_name,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(twilio_number) DO UPDATE SET
        template_name=excluded.template_name,
        template_lang=excluded.template_lang,
        calendly_link=excluded.calendly_link,
        contact_name=excluded.contact_name,
        company_name=excluded.company_name,
        updated_at=excluded.updated_at
    `,
      [
        twilio_number,
        template_name,
        template_lang,
        calendly_link,
        contact_name,
        company_name,
        now,
      ]
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

/* === 🟣 TWILIO VOICE WEBHOOK === */
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // ex: +33665200155
    const to = req.body.To; // ex: +33948353493
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", { from, to, callSid });

    const waNumber = normalizeToWhatsapp(from);

    // pick config from "to" number
    const cfg = await getClientConfigForTwilioNumber(to);

    console.log(
      "🧩 Config résolue:",
      cfg.matchedClient
        ? {
            twilio: to,
            template: cfg.templateName,
            link: cfg.calendlyLink,
            contact: cfg.contactName,
            company: cfg.companyName,
          }
        : {
            twilio: to,
            template: cfg.templateName,
            link: cfg.calendlyLink,
            contact: cfg.contactName,
            company: cfg.companyName,
            note: "DEFAULT",
          }
    );

    // --- anti-doublon 24h sur le message initial ---
    const alreadySentInitial = await dbGet(
      `
      SELECT id, created_at
      FROM whatsapp_outbound
      WHERE to_number = ?
        AND template_name = ?
        AND created_at >= datetime('now', '-24 hours')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [waNumber, cfg.templateName]
    );

    if (alreadySentInitial) {
      console.log(
        `⏭️ Anti-doublon 24h: aucun envoi pour ${waNumber} (déjà contacté le ${alreadySentInitial.created_at})`
      );
    } else {
      try {
        const sendResult = await sendWhatsappTemplate(waNumber, {
          templateName: cfg.templateName,
          lang: cfg.lang,
          parameters: [
            cfg.contactName,
            cfg.companyName,
            cfg.contactName,
            cfg.calendlyLink,
          ],
        });

        // store followup only if initial message was sent
        await dbRun(
          `INSERT INTO followups (
            from_number,
            twilio_number,
            initial_template,
            followup_template,
            calendly_link,
            contact_name,
            company_name,
            initial_message_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            waNumber,
            normalizeE164(to),
            cfg.templateName,
            FOLLOWUP_TEMPLATE_NAME,
            cfg.calendlyLink,
            cfg.contactName,
            cfg.companyName,
            sendResult?.messageId || null,
          ]
        );
      } catch (err) {
        console.error(
          "Erreur envoi WhatsApp :",
          err?.response?.data || err.message
        );
      }
    }

    // Reject call (no voice)
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Reject reason="busy"/></Response>';

    return res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("Erreur /twilio/voice :", err.message);

    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response><Reject reason="busy"/></Response>';

    return res.type("text/xml").send(twiml);
  }
});

// --- Follow-up loop ---
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups...");

    const followups = await dbAll(
      `
      SELECT id, from_number, missed_at, calendly_link, contact_name, followup_template, reply_received, done, followup_message_id
      FROM followups
      WHERE done = 0
        AND missed_at <= datetime('now', ?)
      `,
      [`-${FOLLOWUP_DELAY_MINUTES} minutes`]
    );

    for (const f of followups) {
      const {
        id,
        from_number,
        missed_at,
        calendly_link,
        contact_name,
        followup_template,
        reply_received,
        followup_message_id,
      } = f;

      if (reply_received) {
        console.log(`❌ Pas de relance, ${from_number} a déjà répondu.`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      // sécurité supplémentaire : vérifier s’il y a eu une réponse en base
      const reply = await dbGet(
        `
        SELECT 1
        FROM messages
        WHERE from_number = ?
          AND created_at > ?
          AND body != "__missed_call__"
        LIMIT 1
        `,
        [from_number, missed_at]
      );

      if (reply) {
        console.log(`❌ Pas de relance, ${from_number} a déjà répondu.`);
        await dbRun(
          "UPDATE followups SET reply_received = 1, done = 1 WHERE id = ?",
          [id]
        );
        continue;
      }

      // sécurité : ne jamais envoyer 2 relances
      if (followup_message_id) {
        console.log(`⏭️ Relance déjà envoyée pour ${from_number}`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      const existingRelance = await dbGet(
        `
        SELECT id
        FROM whatsapp_outbound
        WHERE to_number = ?
          AND template_name = ?
          AND created_at > ?
        LIMIT 1
        `,
        [from_number, followup_template || FOLLOWUP_TEMPLATE_NAME, missed_at]
      );

      if (existingRelance) {
        console.log(`⏭️ Relance déjà présente en base pour ${from_number}`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      try {
        console.log(`🔁 Relance automatique envoyée à ${from_number}`);

        const sendResult = await sendWhatsappTemplate(from_number, {
          templateName: followup_template || FOLLOWUP_TEMPLATE_NAME,
          lang: DEFAULT_TEMPLATE_LANG,
          parameters: [contact_name || DEFAULT_CONTACT_NAME, calendly_link || DEFAULT_CALENDLY_LINK],
        });

        await dbRun(
          `
          UPDATE followups
          SET done = 1,
              followup_message_id = ?,
              followup_sent_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [sendResult?.messageId || null, id]
        );
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

