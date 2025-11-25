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
  // Table des messages
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_number TEXT,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table pour suivre les appels manqués à relancer
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

// --- Webhook Verify (WhatsApp Meta) ---
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

// Route racine
app.get("/", (_req, res) => res.status(200).send("OK BACKEND"));

// Petite fonction pour envoyer un message WhatsApp
async function sendWhatsappText(to, body) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
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

// --- WHATSAPP CLOUD WEBHOOK ---
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥🔥🔥 /webhook WhatsApp Cloud appelé 🔥🔥🔥");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // --- 1) Gestion des messages classiques ---
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      const body = message.text?.body ?? "";
      const normalizedBody = body.trim().toLowerCase();

      console.log(`📩 Message reçu de ${from}: "${body}"`);

      // On enregistre
      await dbRun("INSERT INTO messages (from_number, body) VALUES (?, ?)", [
        from,
        body,
      ]);

      // SIMULATION d'appel manqué via mot-clé
      if (normalizedBody === "simulate_missed_call") {
        console.log("🎭 SIMULATION D'APPEL MANQUÉ POUR :", from);

        await dbRun("INSERT INTO followups (from_number) VALUES (?)", [from]);

        const link = process.env.CALENDLY_LINK || "https://calendly.com/ton-lien";

        await sendWhatsappText(
          from,
          "👋 Bonjour ! (simulation) J’ai vu votre appel manqué.\n" +
            "👉 Réservez un rendez-vous ici : " + link
        );
      } else {
        // Réponse normale
        await sendWhatsappText(
          from,
          "👋 Bonjour ! Merci pour votre message, je vous réponds dès que possible 😊"
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erreur /webhook :", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

/* === 🟣 WEBHOOK TWILIO VOICE (APPELS RENVOYÉS) === */
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // numéro du client
    const to = req.body.To;     // ton numéro Twilio
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", { from, to, callSid });

    // On stocke le followup
    await dbRun("INSERT INTO followups (from_number) VALUES (?)", [from]);

    // On envoie immédiatement le WhatsApp
    const link = process.env.CALENDLY_LINK || "https://calendly.com/ton-lien";

    try {
      await sendWhatsappText(
        from,
        "👋 Bonjour ! Vous avez essayé de nous joindre et nous étions indisponibles.\n\n" +
          "👉 Réservez un rendez-vous ici : " + link
      );
      console.log("✅ WhatsApp envoyé après appel Twilio pour", from);
    } catch (e) {
      console.error("Erreur envoi WhatsApp :", e?.response?.data || e.message);
    }

    // Twilio attend un TwiML
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<Response><Hangup/></Response>";

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("Erreur /twilio/voice :", err.message);
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<Response><Hangup/></Response>";
    res.type("text/xml");
    res.send(twiml);
  }
});

// --- Relance automatique toutes les 60 secondes (TEST) ---
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups en attente...");

    // Pour tests : 1 minute
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
        console.log(`❌ Pas de relance, ${from_number} a répondu.`);
        await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
        continue;
      }

      const link = process.env.CALENDLY_LINK || "https://calendly.com/ton-lien";

      console.log(`🔁 Relance automatique envoyée à ${from_number}`);

      await sendWhatsappText(
        from_number,
        "👋 Rebonjour ! Je reviens vers vous suite à votre appel manqué.\n\n" +
          "👉 Réservez un créneau ici : " + link
      );

      await dbRun("UPDATE followups SET done = 1 WHERE id = ?", [id]);
    }
  } catch (err) {
    console.error("Erreur relance :", err.message);
  }
}, CHECK_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`🚀 Backend Assistant Pro running on port ${PORT}`);
});
