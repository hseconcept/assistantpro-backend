import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();

// Pour WhatsApp Cloud (JSON)
app.use(express.json());
// Pour Twilio Voice (form-urlencoded)
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// --- Prépare le dossier data et la base ---
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // Table des messages WhatsApp
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table pour suivre les appels manqués
  db.run(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    missed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done INTEGER DEFAULT 0
  )`);
});

// Helpers Promises pour sqlite3
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

/* ============================================================
  WEBHOOK VERIFY (WHATSAPP META)
============================================================ */
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

// Test simple
app.get("/", (_req, res) => res.status(200).send("OK BACKEND"));

/* ============================================================
    ENVOI WHATSAPP — TEMPLATE APPEL_MANQUE_CECILIA
============================================================ */

async function sendWhatsappTemplateAppelManque(to) {
  const toClean = (to || "").replace(/^\+/, "");
  const calendly = process.env.CALENDLY_LINK || "https://calendly.com/ton-lien";

  console.log("📨 Envoi TEMPLATE appel_manque_cecilia vers :", toClean);

  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toClean,
        type: "template",
        template: {
          name: "appel_manque_cecilia",        // ⚠️ doit être exactement le nom du template Meta
          language: { code: "fr" },            // mets "fr_FR" ici si ton template est en fr_FR
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: calendly               // {{1}} = lien Calendly
                }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Réponse WhatsApp API (template) :", JSON.stringify(resp.data));
  } catch (error) {
    console.error(
      "❌ Erreur WhatsApp API (template) :",
      error.response?.status,
      JSON.stringify(error.response?.data || error.message)
    );
    throw error;
  }
}

/* ============================================================
         WEBHOOK WHATSAPP CLOUD (messages reçus)
============================================================ */
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 /webhook WhatsApp Cloud appelé");

    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      const body = message.text?.body ?? "";

      console.log(`📩 Message reçu WhatsApp de ${from}: "${body}"`);

      await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [
        from,
        body,
      ]);

      // Pour l’instant, on ne répond pas automatiquement aux messages entrants.
      // On se concentre sur les appels manqués.
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erreur /webhook WhatsApp :", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

/* ============================================================
                WEBHOOK TWILIO VOICE (APPELS)
============================================================ */
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // numéro du client qui appelle
    const to = req.body.To;     // numéro Twilio (celui de Cécilia)
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", { from, to, callSid });

    // On enregistre l'appel manqué
    await dbRun("INSERT INTO followups (from_number) VALUES (?)", [from]);

    try {
      await sendWhatsappTemplateAppelManque(from);
    } catch (e) {
      console.error("Erreur envoi WhatsApp (appel manqué) :", e);
    }

    // Twilio : SILENCE + raccrocher (aucune voix)
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<Response><Pause length='1'/><Hangup/></Response>";

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("Erreur /twilio/voice :", err.message);
    res.type("text/xml");
    res.send("<Response><Hangup/></Response>");
  }
});

/* ============================================================
     RELANCE AUTOMATIQUE (1 minute pour tests)
============================================================ */
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups...");
    const followups = await dbAll(
      `SELECT id, from_number, missed_at
       FROM followups
       WHERE done = 0
         AND missed_at <= datetime('now', '-1 minute')`
    );

    for (const f of followups) {
      const { id, from_number, missed_at } = f;

      const reply = await dbGet(
        `SELECT 1 FROM messages
         WHERE from_number = ?
           AND created_at > ?
         LIMIT 1`,
        [from_number, missed_at]
      );

      if (reply) {
        console.log(`❌ Pas de relance, ${from_number} a répondu.`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      console.log(`🔁 Relance automatique envoyée à ${from_number}`);
      try {
        await sendWhatsappTemplateAppelManque(from_number);
      } catch (e) {
        console.error("Erreur envoi WhatsApp (relance) :", e);
      }

      await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
    }
  } catch (err) {
    console.error("Erreur relance :", err.message);
  }
}, CHECK_INTERVAL_MS);

// Lancement du serveur
app.listen(PORT, () => {
  console.log(`🚀 Assistant Pro backend démarré : ${PORT}`);
});
