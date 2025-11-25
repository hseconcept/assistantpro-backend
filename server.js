import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();

// WhatsApp Cloud → JSON
app.use(express.json());

// Twilio Voice → x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// Préparation dossier + DB SQLite
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

// Création des tables
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
});

// Helpers SQLite (promises)
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

// Vérification Webhook WhatsApp Meta
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ Webhook Meta validé");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Route test
app.get("/", (_req, res) => res.status(200).send("OK BACKEND"));

// Fonction envoi WhatsApp 💬
async function sendWhatsappText(to, body) {
  // Normalise le numéro sans "+"
  const normalizedTo = (to || "").replace(/^\+/, "");
  console.log("📤 Envoi WhatsApp vers :", normalizedTo);

  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// Webhook WhatsApp Cloud
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥 Webhook WhatsApp Cloud reçu");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const from = message.from; // déjà sans "+"
      const body = message.text?.body ?? "";
      const normalized = body.trim().toLowerCase();

      console.log("📩 Message WA reçu de", from, ":", body);

      await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [
        from,
        body,
      ]);

      if (normalized === "simulate_missed_call") {
        console.log("🎭 Simulation d'appel manqué pour", from);
        await dbRun("INSERT INTO followups (from_number) VALUES (?)", [from]);

        const link = process.env.CALENDLY_LINK;

        await sendWhatsappText(
          from,
          `👋 (simulation) J'ai vu votre appel manqué.\n👉 Prenez RDV ici : ${link}`
        );
      } else {
        await sendWhatsappText(
          from,
          "👋 Bonjour ! Merci pour votre message, je vous réponds dès que possible."
        );
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Erreur Webhook WA :", e?.response?.data || e.message);
    res.sendStatus(200);
  }
});

// Webhook Twilio Voice ☎️
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // ex: +33665200155
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", from, "CallSid:", callSid);

    await dbRun("INSERT INTO followups (from_number) VALUES (?)", [from]);

    const link = process.env.CALENDLY_LINK;

    try {
      await sendWhatsappText(
        from,
        `👋 Bonjour ! Vous avez essayé de nous joindre.\n👉 Prenez rendez-vous ici : ${link}`
      );
      console.log("✅ WhatsApp envoyé après appel Twilio");
    } catch (err) {
      console.error("❌ Erreur envoi WhatsApp (Twilio) :", err?.response?.data || err.message);
    }

    // Twilio attend du XML avec message vocal + Hangup
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
        '<Say language="fr-FR" voice="alice">' +
          "Bonjour, votre appel a bien été reçu. " +
          "Vous allez recevoir un message WhatsApp avec un lien pour prendre rendez-vous. " +
          "Au revoir." +
        '</Say>' +
        '<Hangup/>' +
      '</Response>';

    res.type("text/xml");
    res.send(twiml);

  } catch (e) {
    console.error("Erreur twilio/voice :", e.message);
    res.type("text/xml");
    res.send(`<Response><Hangup/></Response>`);
  }
});

// Relance automatique (1 min pour tests)
setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups en attente...");
    const followups = await dbAll(
      `SELECT id, from_number, missed_at
       FROM followups
       WHERE done = 0 
         AND missed_at <= datetime('now', '-1 minute')`
    );

    for (const f of followups) {
      const reply = await dbGet(
        `SELECT 1 FROM messages
         WHERE from_number = ?
           AND created_at > ?
         LIMIT 1`,
        [f.from_number, f.missed_at]
      );

      if (reply) {
        console.log(`❌ Pas de relance, ${f.from_number} a déjà répondu.`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [f.id]);
        continue;
      }

      const link = process.env.CALENDLY_LINK;

      console.log(`🔁 Relance automatique envoyée à ${f.from_number}`);

      await sendWhatsappText(
        f.from_number,
        `👋 Rebonjour ! Nous revenons vers vous suite à votre appel manqué.\n👉 Réservez un créneau ici : ${link}`
      );

      await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [f.id]);
    }
  } catch (e) {
    console.error("Erreur relance :", e.message);
  }
}, 60000);

app.listen(PORT, () => console.log("🚀 Assistant Pro backend démarré :", PORT));


