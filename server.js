import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import fs from "fs";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// --- Variables d'environnement ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || "+33939241644";

const DEFAULT_CONTACT_NAME = process.env.DEFAULT_CONTACT_NAME || "Florimond";
const DEFAULT_COMPANY_NAME = process.env.DEFAULT_COMPANY_NAME || "Hse concept";
const DEFAULT_CALENDLY_LINK = process.env.DEFAULT_CALENDLY_LINK || "https://calendly.com/franchises-yyyours";

const FOLLOWUP_DELAY_MINUTES = Number(process.env.FOLLOWUP_DELAY_MINUTES || 1440);
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "CHANGE_ME_LATER";

// --- Twilio client ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- DB SQLite ---
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

// --- Helpers SQLite ---
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
    if (err && !String(err.message || "").includes("duplicate column name")) {
      console.error("Erreur migration SQLite :", err.message);
    }
  });
}

// --- Initialisation DB ---
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
    calendly_link TEXT,
    contact_name TEXT,
    company_name TEXT,
    missed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done INTEGER DEFAULT 0,
    reply_received INTEGER DEFAULT 0,
    initial_message_sid TEXT,
    followup_message_sid TEXT,
    followup_sent_at DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twilio_number TEXT UNIQUE,
    contact_name TEXT,
    company_name TEXT,
    calendly_link TEXT,
    sms_initial TEXT,
    sms_followup TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sms_outbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_number TEXT,
    from_number TEXT,
    body TEXT,
    message_sid TEXT UNIQUE,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  safeAlter(`ALTER TABLE clients ADD COLUMN sms_initial TEXT`);
  safeAlter(`ALTER TABLE clients ADD COLUMN sms_followup TEXT`);
});

// --- Utils ---
function normalizeE164(number) {
  if (!number) return "";
  let n = String(number).trim();
  if (n.startsWith("whatsapp:")) n = n.replace("whatsapp:", "");
  n = n.replace(/[\s\-()]/g, "");
  if (n.startsWith("00")) n = "+" + n.slice(2);
  if (!n.startsWith("+")) n = "+" + n;
  return n;
}

function requireAdmin(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

// --- Config client selon numéro Twilio ---
async function getClientConfig(twilioTo) {
  const toE164 = normalizeE164(twilioTo);
  const row = await dbGet("SELECT * FROM clients WHERE twilio_number = ?", [toE164]);
  return {
    contactName: row?.contact_name || DEFAULT_CONTACT_NAME,
    companyName: row?.company_name || DEFAULT_COMPANY_NAME,
    calendlyLink: row?.calendly_link || DEFAULT_CALENDLY_LINK,
    smsInitial: row?.sms_initial || null,
    smsFollowup: row?.sms_followup || null,
    matchedClient: row || null,
  };
}

// --- Construction des SMS ---
function buildInitialSms(cfg) {
  if (cfg.smsInitial) return cfg.smsInitial;
  return `Bonjour, vous avez essayé de joindre ${cfg.contactName} chez ${cfg.companyName}. Nous n'avons pas pu répondre. Réservez un créneau ici : ${cfg.calendlyLink}`;
}

function buildFollowupSms(cfg) {
  if (cfg.smsFollowup) return cfg.smsFollowup;
  return `Bonjour, ${cfg.contactName} de ${cfg.companyName} souhaite vous recontacter. Votre créneau est toujours disponible : ${cfg.calendlyLink}`;
}

// --- Envoi SMS ---
async function sendSms(toNumber, fromNumber, body) {
  const message = await twilioClient.messages.create({
    from: fromNumber,
    to: toNumber,
    body: body,
  });

  console.log(`📱 SMS envoyé à ${toNumber} depuis ${fromNumber} : ${message.sid}`);

  await dbRun(
    `INSERT INTO sms_outbound (to_number, from_number, body, message_sid, status)
     VALUES (?, ?, ?, ?, ?)`,
    [toNumber, fromNumber, body, message.sid, message.status]
  );

  return message;
}

// --- Routes de base ---
app.get("/", (_req, res) => res.status(200).send("OK - Assistant Pro SMS"));
app.get("/health", (_req, res) => res.status(200).send("healthy"));

// --- Webhook Twilio Voice (appel manqué) ---
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = normalizeE164(req.body.From); // numéro du client qui appelle
    const to = req.body.To;                    // numéro Twilio du pro
    const callSid = req.body.CallSid;

    console.log("📞 Appel reçu :", { from, to, callSid });

    const cfg = await getClientConfig(to);
    const fromE164 = normalizeE164(to);

    console.log("🧩 Config :", {
      twilio: to,
      contact: cfg.contactName,
      company: cfg.companyName,
      link: cfg.calendlyLink,
      source: cfg.matchedClient ? "CLIENT" : "DEFAULT",
    });

    // Anti-doublon 24h
    const alreadySent = await dbGet(
      `SELECT id FROM sms_outbound
       WHERE to_number = ? AND from_number = ?
         AND created_at >= datetime('now', '-24 hours')
       LIMIT 1`,
      [from, fromE164]
    );

    if (alreadySent) {
      console.log(`⏭️ Anti-doublon 24h : SMS déjà envoyé à ${from}`);
    } else {
      try {
        const smsBody = buildInitialSms(cfg);
        const message = await sendSms(from, fromE164, smsBody);

        // Planifier le follow-up
        await dbRun(
          `INSERT INTO followups (
            from_number, twilio_number, calendly_link,
            contact_name, company_name, initial_message_sid
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [from, fromE164, cfg.calendlyLink, cfg.contactName, cfg.companyName, message.sid]
        );

        console.log(`✅ SMS initial envoyé à ${from}`);
      } catch (err) {
        console.error("Erreur envoi SMS :", err.message);
      }
    }

    // Raccrocher sans sonner
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

// --- Webhook Twilio SMS entrant (réponse du client) ---
app.post("/twilio/sms", async (req, res) => {
  try {
    const from = normalizeE164(req.body.From);
    const body = req.body.Body || "";

    console.log(`📩 SMS reçu de ${from} : "${body}"`);

    await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [from, body]);

    // Annuler les follow-ups en attente
    await dbRun(
      `UPDATE followups SET reply_received = 1, done = 1
       WHERE from_number = ? AND done = 0`,
      [from]
    );

    console.log(`✅ Follow-ups annulés pour ${from}`);

    return res.type("text/xml").send(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
    );
  } catch (err) {
    console.error("Erreur /twilio/sms :", err.message);
    return res.type("text/xml").send(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
    );
  }
});

// --- Loop follow-up (toutes les minutes) ---
setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups...");

    const followups = await dbAll(
      `SELECT * FROM followups
       WHERE done = 0
         AND missed_at <= datetime('now', ?)`,
      [`-${FOLLOWUP_DELAY_MINUTES} minutes`]
    );

    for (const f of followups) {
      const reply = await dbGet(
        `SELECT 1 FROM messages
         WHERE from_number = ? AND created_at > ? LIMIT 1`,
        [f.from_number, f.missed_at]
      );

      if (reply || f.reply_received) {
        console.log(`❌ Pas de relance, ${f.from_number} a déjà répondu.`);
        await dbRun("UPDATE followups SET reply_received = 1, done = 1 WHERE id = ?", [f.id]);
        continue;
      }

      if (f.followup_message_sid) {
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [f.id]);
        continue;
      }

      try {
        const cfg = {
          contactName: f.contact_name || DEFAULT_CONTACT_NAME,
          companyName: f.company_name || DEFAULT_COMPANY_NAME,
          calendlyLink: f.calendly_link || DEFAULT_CALENDLY_LINK,
          smsFollowup: null,
        };

        const smsBody = buildFollowupSms(cfg);
        const message = await sendSms(f.from_number, f.twilio_number, smsBody);

        await dbRun(
          `UPDATE followups
           SET done = 1, followup_message_sid = ?, followup_sent_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [message.sid, f.id]
        );

        console.log(`🔁 Relance SMS envoyée à ${f.from_number}`);
      } catch (e) {
        console.error("Erreur envoi SMS relance :", e.message);
      }
    }
  } catch (err) {
    console.error("Erreur loop follow-up :", err.message);
  }
}, 60 * 1000);

// --- Admin API ---
app.post("/admin/clients", requireAdmin, async (req, res) => {
  try {
    const twilio_number = normalizeE164(req.body.twilio_number || "");
    if (!twilio_number) {
      return res.status(400).json({ error: "twilio_number is required" });
    }

    const now = new Date().toISOString();

    await dbRun(
      `INSERT INTO clients (twilio_number, contact_name, company_name, calendly_link, sms_initial, sms_followup, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(twilio_number) DO UPDATE SET
         contact_name=excluded.contact_name,
         company_name=excluded.company_name,
         calendly_link=excluded.calendly_link,
         sms_initial=excluded.sms_initial,
         sms_followup=excluded.sms_followup,
         updated_at=excluded.updated_at`,
      [
        twilio_number,
        req.body.contact_name || null,
        req.body.company_name || null,
        req.body.calendly_link || null,
        req.body.sms_initial || null,
        req.body.sms_followup || null,
        now,
      ]
    );

    const saved = await dbGet("SELECT * FROM clients WHERE twilio_number = ?", [twilio_number]);
    return res.json({ ok: true, client: saved });
  } catch (err) {
    console.error("Erreur /admin/clients :", err.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/admin/clients", requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM clients ORDER BY updated_at DESC");
    res.json({ ok: true, clients: rows });
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/admin/followups", requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM followups ORDER BY missed_at DESC LIMIT 100");
    res.json({ ok: true, followups: rows });
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/admin/sms", requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM sms_outbound ORDER BY created_at DESC LIMIT 100");
    res.json({ ok: true, sms: rows });
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Assistant Pro SMS running on port ${PORT}`);
  if (ADMIN_API_KEY === "CHANGE_ME_LATER") {
    console.warn("⚠️ ADMIN_API_KEY est sur la valeur par défaut. Change-la sur Render !");
  }
});
