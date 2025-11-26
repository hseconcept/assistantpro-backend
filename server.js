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

// 🔗 Lien Calendly de Cécilia (fixe)
const CALENDLY_LINK = "https://calendly.com/franchises-yyyours";

// --- Prépare le dossier data et la base ---
const DB_PATH = process.env.DB_URL || "./data/bot.db";
fs.mkdirSync("data", { recursive: true });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // Table des messages WhatsApp reçus
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

// --- utilitaires ---

// Normalise un numéro FR Twilio (+336...) vers le format WhatsApp (336...)
function normalizeToWhatsapp(number) {
  if (!number) return "";
  let n = number.trim();
  if (n.startsWith("+")) n = n.slice(1);
  // très simplifié : si ça commence par 0 (fixe ou mobile FR), on met 33
  if (n.startsWith("0")) n = "33" + n.slice(1);
  return n;
}

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

// --- Fonction pour envoyer le template WhatsApp ---

/**
 * Envoie le template "assistant_cecilia_rdv" avec le lien Calendly
 * vers un numéro WhatsApp au format 336XXXXXXXX.
 */
async function sendWhatsappTemplate(toWa) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error("❌ WHATSAPP_PHONE_ID ou WHATSAPP_TOKEN manquant dans .env");
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWa, // ex: "33665200155"
    type: "template",
    template: {
      name: "assistant_cecilia_rdv", // NOM DU MODÈLE META
      language: { code: "fr" },     // langue du modèle
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: CALENDLY_LINK, // {{1}}
            },
          ],
        },
      ],
    },
  };

  console.log("📨 Envoi WhatsApp via TEMPLATE vers :", toWa);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  console.log("✅ Réponse WhatsApp API :", JSON.stringify(response.data));
}

// (optionnel) Fonction texte simple, non utilisée en prod mais gardée au cas où
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

// --- WHATSAPP CLOUD WEBHOOK ---
// (messages entrants des clients vers le numéro Meta, si un jour tu en as besoin)
app.post("/webhook", async (req, res) => {
  try {
    console.log("🔥🔥🔥 /webhook WhatsApp Cloud appelé 🔥🔥🔥");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];

    if (message) {
      const from = message.from; // ex: "33665200155"
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

/* === 🟣 WEBHOOK TWILIO VOICE (APPELS RENVOYÉS) === */
app.post("/twilio/voice", async (req, res) => {
  try {
    const from = req.body.From; // numéro appelant, ex: +33665200155
    const to = req.body.To;     // ton numéro Twilio
    const callSid = req.body.CallSid;

    console.log("📞 Appel Twilio reçu :", { from, to, callSid });

    const waNumber = normalizeToWhatsapp(from); // "3366..."

    // On stocke ce numéro pour une éventuelle relance auto
    await dbRun("INSERT INTO followups (from_number) VALUES (?)", [waNumber]);

    // Envoi immédiat du WhatsApp avec le template
    try {
      await sendWhatsappTemplate(waNumber);
      console.log("✅ WhatsApp envoyé après appel Twilio pour", waNumber);
    } catch (e) {
      console.error(
        "Erreur envoi WhatsApp (immédiat) :",
        e?.response?.data || e.message
      );
    }

    // Twilio attend un TwiML – ici on raccroche directement (pas de voix)
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' + "<Response><Hangup/></Response>";

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("Erreur /twilio/voice :", err.message);
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' + "<Response><Hangup/></Response>";
    res.type("text/xml");
    res.send(twiml);
  }
});

// --- Relance automatique toutes les 60 secondes (TEST / DEMO) ---
const CHECK_INTERVAL_MS = 60 * 1000;

setInterval(async () => {
  try {
    console.log("⏰ Vérification des follow-ups...");

    // Pour tests : relance après 1 minute si pas de nouveau message
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

      // On regarde si la personne a envoyé un WhatsApp après l'appel manqué
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

      // Relance automatique (toujours via le template)
      try {
        console.log(`🔁 Relance automatique envoyée à ${from_number}`);
        await sendWhatsappTemplate(from_number);
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

app.listen(PORT, () => {
  console.log(`🚀 Backend Assistant Pro running on port ${PORT}`);
});


