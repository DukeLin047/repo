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
  const snap
