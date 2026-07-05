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

async function pushMessage(to, messages) {
  const res = await fetch(LINE_PUSH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({ to: to, messages: messages }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("LINE push failed: " + res.status + " " + errText);
  }
}

async function getDisplayName(groupId, userId) {
  try {
    const res = await fetch(
      LINE_PROFILE_API + "/group/" + groupId + "/member/" + userId,
      { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN } }
    );
    if (!res.ok) return "Anonymous";
    const data = await res.json();
    return data.displayName || "Anonymous";
  } catch (e) {
    return "Anonymous";
  }
}

function textMsg(text) {
  return { type: "text", text: text };
}

function parseOrderText(text) {
  let qty = 1;
  const qtyMatch = text.match(/[xX*\u00d7]\s*(\d+)/);
  if (qtyMatch) {
    qty = parseInt(qtyMatch[1], 10);
    text = text.replace(qtyMatch[0], "");
  }
  return { itemText: text.trim(), qty: qty };
}

function matchMenuItem(shop, itemText) {
  if (!shop.menu || !shop.menu.length) return null;
  const cleaned = itemText.replace(/\s+/g, "");
  let best = null;
  for (let i = 0; i < shop.menu.length; i++) {
    const item = shop.menu[i];
    const name = (item.name || "").replace(/\s+/g, "");
    if (!name) continue;
    if (cleaned.indexOf(name) !== -1 || name.indexOf(cleaned) !== -1) {
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
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (!byUser[o.userId]) {
      byUser[o.userId] = { userName: o.userName, amount: 0, items: [] };
    }
    const lineTotal = (o.price || 0) * (o.qty || 1);
    byUser[o.userId].amount += lineTotal;
    byUser[o.userId].items.push(
      o.itemName + (o.qty > 1 ? " x" + o.qty : "") + " $" + lineTotal
    );
    total += lineTotal;
  }
  return { byUser: byUser, total: total };
}

function formatTallyText(shopName, byUser, total) {
  let lines = [shopName + " summary:", ""];
  for (const uid in byUser) {
    const u = byUser[uid];
    lines.push(u.userName + ": $" + u.amount);
    for (let i = 0; i < u.items.length; i++) {
      lines.push("  - " + u.items[i]);
    }
  }
  lines.push("");
  lines.push("Total: $" + total);
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
        textMsg("Please add me to a LINE group to use the ordering features."),
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
          "Hi! I am the drink ordering bot.\n\nCommands:\nMenu - list shops\nStart <shop name> - start ordering\nItem xQty - order, e.g. Milk Tea x2\nCurrent - view current orders\nClose - close order and show summary\nNearby - find nearby drink shops"
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

  if (text === "Menu" || text === "menu" || text === "選單") {
    await handleShopList(event);
    return;
  }

  if (text.indexOf("Start") === 0 || text.indexOf("開團") === 0) {
    const shopName = text.replace("Start", "").replace("開團", "").trim();
    await handleStartSession(event, groupId, shopName);
    return;
  }

  if (text === "Current" || text === "目前") {
    await handleShowCurrent(event, groupId);
    return;
  }

  if (text === "Close" || text === "結單") {
    await handleCloseSession(event, groupId);
    return;
  }

  if (text === "Nearby" || text === "附近") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg("Please share your current location."),
      ]);
    }
    return;
  }

  await handleOrderText(event, groupId, userId, text);
}

async function handleShopList(event) {
  const snap = await db.collection("shops").orderBy("name").limit(30).get();
  if (snap.empty) {
    await replyMessage(event.replyToken, [textMsg("No shops available yet.")]);
    return;
  }
  const names = snap.docs.map(function (d) { return "- " + d.data().name; }).join("\n");
  await replyMessage(event.replyToken, [
    textMsg("Available shops:\n\n" + names),
  ]);
}

async function handleStartSession(event, groupId, shopName) {
  if (!shopName) {
    await replyMessage(event.replyToken, [textMsg("Please type: Start <shop name>")]);
    return;
  }

  const shopSnap = await db
    .collection("shops")
    .where("name", "==", shopName)
    .limit(1)
    .get();

  if (shopSnap.empty) {
    await replyMessage(event.replyToken, [
      textMsg("Could not find " + shopName + ". Type Menu to see shop list."),
    ]);
    return;
  }

  const shop = shopSnap.docs[0].data();
  const sessionRef = db.collection("groups").doc(groupId).collection("sessions").doc();

  await db.collection("groups").doc(groupId).set(
    { activeSessionId: sessionRef.id },
    { merge: true }
  );

  await sessionRef.set({
    shopId: shopSnap.docs[0].id,
    shopName: shop.name,
    status: "open",
    orders: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await replyMessage(event.replyToken, [
    textMsg(
      "Order started for " + shop.name + "! Type item names with x quantity to order. Type Close when done."
    ),
  ]);
}

async function getActiveSession(groupId) {
  const groupDoc = await db.collection("groups").doc(groupId).get();
  const activeSessionId = groupDoc.exists ? groupDoc.data().activeSessionId : null;
  if (!activeSessionId) return null;
  const sessionRef = db
    .collection("groups")
    .doc(groupId)
    .collection("sessions")
    .doc(activeSessionId);
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists || sessionDoc.data().status !== "open") return null;
  return { ref: sessionRef, data: sessionDoc.data() };
}

async function handleOrderText(event, groupId, userId, text) {
  const session = await getActiveSession(groupId);
  if (!session) return;

  const shopDoc = await db.collection("shops").doc(session.data.shopId).get();
  if (!shopDoc.exists) return;
  const shop = shopDoc.data();

  const parsed = parseOrderText(text);
  const matched = matchMenuItem(shop, parsed.itemText);

  if (!matched) {
    return;
  }

  const userName = await getDisplayName(groupId, userId);

  await session.ref.update({
    orders: admin.firestore.FieldValue.arrayUnion({
      userId: userId,
      userName: userName,
      itemName: matched.name,
      price: matched.price || 0,
      qty: parsed.qty,
    }),
  });

  await replyMessage(event.replyToken, [
    textMsg(
      userName + " ordered " + matched.name +
      (parsed.qty > 1 ? " x" + parsed.qty : "") +
      " $" + ((matched.price || 0) * parsed.qty)
    ),
  ]);
}

async function handleShowCurrent(event, groupId) {
  const session = await getActiveSession(groupId);
  if (!session) {
    await replyMessage(event.replyToken, [textMsg("No active order. Type Start <shop name> to begin.")]);
    return;
  }
  const result = computeTally(session.data.orders || []);
  if (Object.keys(result.byUser).length === 0) {
    await replyMessage(event.replyToken, [textMsg(session.data.shopName + " order is open, no items yet.")]);
    return;
  }
  await replyMessage(event.replyToken, [textMsg(formatTallyText(session.data.shopName, result.byUser, result.total))]);
}

async function handleCloseSession(event, groupId) {
  const session = await getActiveSession(groupId);
  if (!session) {
    await replyMessage(event.replyToken, [textMsg("No active order.")]);
    return;
  }

  const result = computeTally(session.data.orders || []);

  await session.ref.update({
    status: "closed",
    closedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("groups").doc(groupId).set({ activeSessionId: null }, { merge: true });

  if (Object.keys(result.byUser).length === 0) {
    await replyMessage(event.replyToken, [textMsg("No orders were placed. Closed.")]);
    return;
  }

  await replyMessage(event.replyToken, [textMsg(formatTallyText(session.data.shopName, result.byUser, result.total))]);
}

async function handleLocation(event, groupId) {
  if (!GOOGLE_MAPS_API_KEY) {
    await replyMessage(event.replyToken, [textMsg("Map feature not configured yet.")]);
    return;
  }
  const latitude = event.message.latitude;
  const longitude = event.message.longitude;
  const url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=" +
    latitude + "," + longitude +
    "&radius=800&keyword=bubble%20tea&key=" + GOOGLE_MAPS_API_KEY;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const results = (data.results || []).slice(0, 5);
    if (!results.length) {
      await replyMessage(event.replyToken, [textMsg("No drink shops found within 800m.")]);
      return;
    }
    const lines = results.map(function (r, i) {
      return (i + 1) + ". " + r.name + (r.vicinity ? " - " + r.vicinity : "");
    });
    await replyMessage(event.replyToken, [textMsg("Nearby drink shops:\n\n" + lines.join("\n"))]);
  } catch (e) {
    await replyMessage(event.replyToken, [textMsg("Error searching nearby shops. Please try again later.")]);
  }
}