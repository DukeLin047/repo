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

async function getItems() {
  const doc = await sampoDb.collection("inventory").doc("current").get();
  if (!doc.exists) return [];
  return doc.data().items || [];
}

async function queryStock(modelRaw) {
  const model = modelRaw.trim().toUpperCase();
  const items = await getItems();
  const match = items.find(function (it) {
    return String(it.model).trim().toUpperCase() === model;
  });

  if (!match) {
    return { model: model, found: false, stock: 0 };
  }

  return { model: model, found: true, stock: match.stock };
}

async function listModels(keywordRaw) {
  const keyword = keywordRaw.trim().toUpperCase();
  const items = await getItems();
  const matches = items.filter(function (it) {
    return String(it.model).trim().toUpperCase().indexOf(keyword) !== -1;
  });
  return matches;
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
          "哈囉!我是聲寶庫存查詢小幫手。\n\n輸入「查」加型號即可查詢庫存,例如:\n查QM-98MI5200\n\n輸入「列表」加關鍵字可查詢多筆型號,例如:\n列表冷氣"
        ),
      ]);
    }
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  if (text.indexOf("列表") === 0) {
    const keyword = text.slice(2).trim();

    if (!keyword) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「列表」後面接關鍵字,例如:列表冷氣 或 列表AW"),
        ]);
      }
      return;
    }

    const matches = await listModels(keyword);

    if (!event.replyToken) return;

    if (matches.length === 0) {
      await replyMessage(event.replyToken, [
        textMsg("找不到包含「" + keyword + "」的型號"),
      ]);
      return;
    }

    const lines = matches.map(function (it) {
      return it.model + "：" + it.stock;
    });

    const chunkSize = 40;
    const chunks = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      chunks.push(lines.slice(i, i + chunkSize));
    }

    const limitedChunks = chunks.slice(0, 5);
    const messages = limitedChunks.map(function (chunk, idx) {
      const header =
        "找到 " +
        matches.length +
        " 筆" +
        (chunks.length > 1
          ? "（" + (idx + 1) + "/" + limitedChunks.length + "）"
          : "") +
        "\n\n";
      return textMsg(header + chunk.join("\n"));
    });

    await replyMessage(event.replyToken, messages);
    return;
  }

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

    if (!result.found) {
      await replyMessage(event.replyToken, [
        textMsg(result.model + " 查無此型號,請確認型號是否正確"),
      ]);
    } else if (result.stock > 0) {
      await replyMessage(event.replyToken, [
        textMsg(result.model + " 目前有貨\n庫存量:" + result.stock),
      ]);
    } else {
      await replyMessage(event.replyToken, [
        textMsg(result.model + " 目前沒貨\n庫存量:0"),
      ]);
    }
  }
}