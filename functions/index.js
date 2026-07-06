const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

admin.initializeApp();

const sampoServiceAccount = require(path.join(__dirname, "sampo-service-account.json"));
const sampoApp = admin.initializeApp(
  { credential: admin.credential.cert(sampoServiceAccount) },
  "sampoApp"
);
const sampoDb = sampoApp.firestore();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_API = "https://api.line.me/v2/bot/message/reply";

function verifySignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken, messages) {
  const res = await fetch(LINE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({ replyToken: replyToken, messages: messages }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("LINE reply failed: " + res.status + " " + errText);
  }
}

function textMsg(text) {
  return { type: "text", text: text };
}

async function queryStock(modelRaw) {
  const model = modelRaw.trim().toUpperCase();
  const snap = await sampoDb.collection("dealerStock").get();
  let total = 0;
  let dealerCount = 0;
  snap.forEach(function (doc) {
    const data = doc.data();
    const stock = data.stock || {};
    const qty = stock[model];
    if (typeof qty === "number" && qty > 0) {
      total += qty;
      dealerCount += 1;
    }
  });
  return { model: model, total: total, dealerCount: dealerCount };
}

exports.lineWebhook = onRequest({ region: "asia-east1" }, async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody;

  if (!signature || !verifySignature(rawBody, signature)) {
    console.error("Signature mismatch");
    res.status(401).send("invalid signature");
    return;
  }

  const events = req.body.events || [];
  try {
    await Promise.all(
      events.map(function (event) {
        return handleEvent(event).catch(function (err) {
          console.error("handleEvent error:", err);
        });
      })
    );
  } catch (err) {
    console.error("Webhook top-level error:", err);
  }
  res.status(200).send("OK");
});

async function handleEvent(event) {
  if (event.type === "join") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg(
          "哈囉!我是聲寶庫存查詢小幫手。\n\n輸入「查」加型號即可查詢庫存,例如:\n查QM-98MI5200"
        ),
      ]);
    }
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  if (text.charAt(0) === "查") {
    const modelRaw = text.slice(1).trim();

    if (!modelRaw) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「查」後面接完整型號,例如:查QM-98MI5200"),
        ]);
      }
      return;
    }

    const result = await queryStock(modelRaw);

    if (!event.replyToken) return;

    if (result.total > 0) {
      await replyMessage(event.replyToken, [
        textMsg(
          result.model +
            " 目前有貨\n總庫存量:" +
            result.total +
            "\n經銷商家數:" +
            result.dealerCount
        ),
      ]);
    } else {
      await replyMessage(event.replyToken, [textMsg(result.model + " 目前無貨")]);
    }
  }
}