// ============================================================
// 手搖飲揪團機器人 - Cloud Functions 後端
// 功能: LINE Webhook 接收群組訊息 / 開團 / 點餐 / 結單分帳 / 附近店家搜尋
// ============================================================

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

const LINE_API = "https://api.line.me/v2/bot/message/reply";
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_PROFILE_API = "https://api.line.me/v2/bot";

function verifySignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken, messages) {
  await fetch(LINE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function pushMessage(to, messages) {
  await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
}

async function getDisplayName(groupId, userId) {
  try {
    const res = await fetch(
      `${LINE_PROFILE_API}/group/${groupId}/member/${userId}`,
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    if (!res.ok) return "匿名";
    const data = await res.json();
    return data.displayName || "匿名";
  } catch (e) {
    return "匿名";
  }
}

function textMsg(text) {
  return { type: "text", text };
}

function parseOrderText(text) {
  let qty = 1;
  const qtyMatch = text.match(/[xX*×]\s*(\d+)/);
  if (qtyMatch) {
    qty = parseInt(qtyMatch[1], 10);
    text = text.replace(qtyMatch[0], "");
  }
  return { itemText: text.trim(), qty };
}

function matchMenuItem(shop, itemText) {
  if (!shop.menu || !shop.menu.length) return null;
  const cleaned = itemText.replace(/\s+/g, "");
  let best = null;
  for (const item of shop.menu) {
    const name = (item.name || "").replace(/\s+/g, "");
    if (!name) continue;
    if (cleaned.includes(name) || name.includes(cleaned)) {
      if (!best || name.length > best.name.replace(/\s+/g, "").length) {
        best = item;
      }
    }
  }
  return best;
}

function computeTally(orders) {
  const byUser = {};
  let total = 0;
  for (const o of orders) {
    if (!byUser[o.userId]) {
      byUser[o.userId] = { userName: o.userName, amount: 0, items: [] };
    }
    const lineTotal = (o.price || 0) * (o.qty || 1);
    byUser[o.userId].amount += lineTotal;
    byUser[o.userId].items.push(
      `${o.itemName}${o.qty > 1 ? " x" + o.qty : ""} $${lineTotal}`
    );
    total += lineTotal;
  }
  return { byUser, total };
}

function formatTallyText(shopName, byUser, total) {
  let lines = [`🧋 ${shopName} 結單囉!`, ""];
  for (const uid in byUser) {
    const u = byUser[uid];
    lines.push(`${u.userName}: $${u.amount}`);
    for (const item of u.items) lines.push(`　- ${item}`);
  }
  lines.push("");
  lines.push(`總金額: $${total}`);
  return lines.join("\n");
}

exports.lineWebhook = onRequest({ region: "asia-east1" }, async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody;

  if (!signature || !verifySignature(rawBody, signature)) {
    res.status(401).send("invalid signature");
    return;
  }

  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).send("OK");
});

async function handleEvent(event) {
  if (event.source.type !== "group") {
    if (event.type === "message" && event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg("請把我加入你的LINE群組,在群組裡使用開團功能喔!"),
      ]);
    }
    return;
  }

  const groupId = event.source.groupId;
  const groupRef = db.collection("groups").doc(groupId);

  if (event.type === "join") {
    await groupRef.set(
      { createdAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg(
          "大家好!我是手搖飲揪團小幫手 🧋\n\n用法:\n「選單」查看可訂購店家\n「開團 店名」開始揪團\n「品項 x數量」點餐,例如: 珍珠奶茶 半糖 x2\n「目前」查看目前訂單\n「結單」結束並列出分帳\n「附近」尋找附近手搖飲店"
        ),
      ]);
    }
    return;
  }

  if (event.type === "location") {
    await handleLocation(event, groupId);
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  if (text === "選單" || text === "店家列表") {
    await handleShopList(event);
    return;
  }

  if (text.startsWith("開團")) {
    await handleStartSession(event, groupId, text.replace("開團", "").trim());
    return;
  }

  if (text === "目前" || text === "目前訂單" || text === "查看訂單") {
    await handleShowCurrent(event, groupId);
    return;
  }

  if (text === "結單") {
    await handleCloseSession(event, groupId);
    return;
  }

  if (text === "附近" || text === "附近店家") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg("請傳送你的目前位置給
