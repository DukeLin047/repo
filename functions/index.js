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
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_PROFILE_API = "https://api.line.me/v2/bot";

// ── AI 開放式問答（Gemini）─────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_API =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

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
  try {
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
  } catch (e) {
    console.error("pushMessage error:", e);
  }
}

async function getNotifyUserId() {
  try {
    const doc = await sampoDb.collection("settings").doc("notify").get();
    if (!doc.exists) return null;
    return doc.data().userId || null;
  } catch (e) {
    console.error("getNotifyUserId error:", e);
    return null;
  }
}

async function getGroupLabel(groupId) {
  if (!groupId) return "私訊";
  try {
    const doc = await sampoDb.collection("allowedGroups").doc(groupId).get();
    if (doc.exists && doc.data().name) return doc.data().name;
  } catch (e) {
    console.error("getGroupLabel error:", e);
  }
  return groupId;
}

async function notifyLowStock(groupId, askerName, lowStockResults, location) {
  if (!lowStockResults || lowStockResults.length === 0) return;
  const notifyUserId = await getNotifyUserId();
  if (!notifyUserId) return;

  const groupLabel = await getGroupLabel(groupId);
  const asker = askerName || "有人";
  const lines = lowStockResults.map(function (r) {
    return r.model + "：" + r.stock + (r.stock === 0 ? "（無庫存）" : "（低庫存）");
  });

  const text =
    "📉 低庫存提醒\n\n群組：" + groupLabel +
    (location ? "\n儲位：" + location : "") +
    "\n詢問人：" + asker + "\n\n" + lines.join("\n");

  await pushMessage(notifyUserId, [textMsg(text)]);
}

async function leaveGroup(groupId) {
  try {
    const res = await fetch(
      "https://api.line.me/v2/bot/group/" + groupId + "/leave",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN },
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error("Leave group failed: " + res.status + " " + errText);
    }
  } catch (e) {
    console.error("Leave group error:", e);
  }
}

async function getDisplayName(groupId, userId) {
  if (!groupId || !userId) return null;
  try {
    const res = await fetch(
      LINE_PROFILE_API + "/group/" + groupId + "/member/" + userId,
      { headers: { Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName || null;
  } catch (e) {
    return null;
  }
}

// 取得群組權限：回傳 null 表示不在白名單
// 有設定 permissions 就照設定，沒有的話預設四個功能全開
async function getGroupPermissions(groupId) {
  if (!groupId) return null;
  try {
    const doc = await sampoDb.collection("allowedGroups").doc(groupId).get();
    if (!doc.exists) return null;
    const d = doc.data();
    const p = d.permissions || {};
    return {
      stock: p.stock !== false,
      feature: p.feature !== false,
      price: p.price !== false,
      list: p.list !== false,
      ai: p.ai !== false,
      location: d.location || "",
    };
  } catch (e) {
    console.error("getGroupPermissions error:", e);
    return null;
  }
}

// 記錄機器人加入某群組的時間（用於「未設定白名單就自動退出」）
async function markGroupJoined(groupId) {
  if (!groupId) return;
  try {
    await sampoDb.collection("pendingGroups").doc(groupId).set({
      joinedAt: Date.now(),
    });
  } catch (e) {
    console.error("markGroupJoined error:", e);
  }
}

async function clearGroupPending(groupId) {
  if (!groupId) return;
  try {
    await sampoDb.collection("pendingGroups").doc(groupId).delete();
  } catch (e) {
    console.error("clearGroupPending error:", e);
  }
}

// 檢查是否為「加入超過寬限時間、但仍未加入白名單」的群組
// 是的話讓機器人退出並回傳 true
const JOIN_GRACE_MS = 2 * 60 * 1000; // 2 分鐘

async function leaveIfGraceExpired(groupId) {
  if (!groupId) return false;
  try {
    const doc = await sampoDb.collection("pendingGroups").doc(groupId).get();
    if (!doc.exists) {
      // 沒有記錄（可能是舊群組），補記錄一次，從現在起算寬限時間
      await markGroupJoined(groupId);
      return false;
    }
    const joinedAt = doc.data().joinedAt || 0;
    if (Date.now() - joinedAt < JOIN_GRACE_MS) return false;

    await pushMessage(groupId, [
      textMsg("未在時限內完成白名單設定，我先退出囉。需要使用請再邀請我並盡快設定。"),
    ]);
    await leaveGroup(groupId);
    await clearGroupPending(groupId);
    return true;
  } catch (e) {
    console.error("leaveIfGraceExpired error:", e);
    return false;
  }
}

function textMsg(text) {
  return { type: "text", text: text };
}

// 取得庫存清單。指定 location 時取該儲位資料，
// 沒指定或該儲位無資料時，退回預設的 items
async function getItems(location) {
  const doc = await sampoDb.collection("inventory").doc("current").get();
  if (!doc.exists) return [];
  const data = doc.data();
  if (location) {
    const locations = data.locations || {};
    if (locations[location] && locations[location].length) {
      return locations[location];
    }
  }
  return data.items || [];
}

// 把 "AU/AM-HF28D" 這種合併寫法拆成 ["AU-HF28D", "AM-HF28D"]
// 如果沒有 "/" 就原樣傳回單一元素陣列
function expandSlashModel(raw) {
  const q = raw.trim().toUpperCase();
  const slashIdx = q.indexOf("/");
  if (slashIdx === -1) return [q];

  const afterSlash = q.slice(slashIdx + 1);
  const dashIdx = afterSlash.indexOf("-");
  if (dashIdx === -1) {
    return q
      .split("/")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }
  const firstPrefix = q.slice(0, slashIdx);
  const secondPrefix = afterSlash.slice(0, dashIdx);
  const suffix = afterSlash.slice(dashIdx);
  return [firstPrefix + suffix, secondPrefix + suffix];
}

// 清除型號裡看不見的字元，用於精準比對。
// 換行/空白會被轉成單一空格（而不是直接刪除），避免把
// "EM-50AIT3220\n MT-320" 這種兩段式資料黏成一個假型號
function normalizeModel(raw) {
  return String(raw)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\r\n\t\u3000\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// 取出型號的「主型號」部分：價格表常在型號後面接空格再加附註
// （例如 "EM-50AIT3220 MT-320"），比對時以第一段為準
function primaryModel(raw) {
  return normalizeModel(raw).split(" ")[0];
}

async function queryStockSingle(model, items) {
  const target = normalizeModel(model);
  const match = items.find(function (it) {
    return normalizeModel(it.model) === target;
  });

  if (match) {
    return { model: match.model, found: true, stock: match.stock };
  }

  // 找不到獨立型號時，反向找合併寫法：
  // 例如查 AU-NF50D，資料庫裡可能存的是 AU/AM-NF50D
  // 規則：把資料庫型號的 "X/Y-SUFFIX" 展開成 "X-SUFFIX" 與 "Y-SUFFIX" 再比對
  const combinedMatch = items.find(function (it) {
    const norm = primaryModel(it.model);
    if (norm.indexOf("/") === -1) return false;
    const expanded = expandSlashModel(norm);
    return expanded.some(function (e) {
      return normalizeModel(e) === target;
    });
  });

  if (combinedMatch) {
    return { model: model, found: true, stock: combinedMatch.stock };
  }

  return { model: model, found: false, stock: 0 };
}

async function queryStock(modelRaw, location) {
  const items = await getItems(location);
  const models = expandSlashModel(modelRaw);

  const results = [];
  for (let i = 0; i < models.length; i++) {
    results.push(await queryStockSingle(models[i], items));
  }

  // 如果拆分後每一筆都查無資料，且原始輸入本身有 "/"，
  // 再試一次用「合併寫法」直接比對（資料庫裡可能就是存成合併的一筆）
  const allNotFound = results.every(function (r) {
    return !r.found;
  });
  if (allNotFound && modelRaw.indexOf("/") !== -1) {
    const combined = await queryStockSingle(modelRaw.trim().toUpperCase(), items);
    if (combined.found) {
      // 資料庫裡是合併存放的一筆（例如 AU/AM-HF36D 或 RAU/RAM-HA80DC），
      // 但仍要拆成多筆分別顯示，庫存量沿用同一個數字
      return models.map(function (m) {
        return { model: m, found: true, stock: combined.stock };
      });
    }
  }

  return results;
}

async function listModels(keywordRaw, location) {
  const keyword = normalizeModel(keywordRaw);
  const items = await getItems(location);
  const matches = items.filter(function (it) {
    return normalizeModel(it.model).indexOf(keyword) !== -1;
  });
  return matches;
}

function queryFeaturesSingleFromSheets(model, sheets) {
  const target = normalizeModel(model);

  // 先做精準比對
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      return normalizeModel(it.model) === target;
    });
    if (match) {
      return { model: match.model, found: true, specs: match.specs || [] };
    }
  }

  // 價格表的機型欄位常在型號後面接附註（例如 "EM-50AIT3220 MT-320"），
  // 精準比對不到時，改用「主型號」（第一段文字）比對
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      return primaryModel(it.model) === target;
    });
    if (match) {
      return { model: match.model, found: true, specs: match.specs || [] };
    }
  }

  // 反向找合併寫法：查 RAU-HA50DC 時，價格表裡可能存的是 RAU/RAM-HA50DC
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      const norm = primaryModel(it.model);
      if (norm.indexOf("/") === -1) return false;
      return expandSlashModel(norm).some(function (e) {
        return normalizeModel(e) === target;
      });
    });
    if (match) {
      return { model: match.model, found: true, specs: match.specs || [] };
    }
  }

  return { model: model, found: false, specs: [] };
}

async function queryFeatures(modelRaw) {
  const models = expandSlashModel(modelRaw);
  const doc = await sampoDb.collection("priceList").doc("current").get();

  if (!doc.exists) {
    return models.map(function (m) {
      return { model: m, found: false, specs: [] };
    });
  }

  const sheets = doc.data().sheets || [];
  const results = models.map(function (m) {
    return queryFeaturesSingleFromSheets(m, sheets);
  });

  const allNotFound = results.every(function (r) {
    return !r.found;
  });
  if (allNotFound && modelRaw.indexOf("/") !== -1) {
    const combined = queryFeaturesSingleFromSheets(modelRaw.trim().toUpperCase(), sheets);
    if (combined.found) {
      return models.map(function (m) {
        return { model: m, found: true, specs: combined.specs };
      });
    }
  }

  return results;
}

function queryPriceSingleFromSheets(model, sheets) {
  const target = normalizeModel(model);

  // 先精準比對
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      return normalizeModel(it.model) === target;
    });
    if (match) {
      return { model: match.model, found: true, base: match.base || "", promo: match.promo || "" };
    }
  }

  // 價格表機型欄位常在型號後面接附註（例如 "EM-50AIT3220 MT-320"），
  // 改用「主型號」（第一段文字）比對
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      return primaryModel(it.model) === target;
    });
    if (match) {
      return { model: match.model, found: true, base: match.base || "", promo: match.promo || "" };
    }
  }

  // 反向找合併寫法：查 AU-NF50D，價格表裡可能存 AU/AM-NF50D
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      const norm = primaryModel(it.model);
      if (norm.indexOf("/") === -1) return false;
      return expandSlashModel(norm).some(function (e) {
        return normalizeModel(e) === target;
      });
    });
    if (match) {
      return { model: match.model, found: true, base: match.base || "", promo: match.promo || "" };
    }
  }

  return { model: model, found: false, base: "", promo: "" };
}

async function queryPrice(modelRaw) {
  const models = expandSlashModel(modelRaw);
  const doc = await sampoDb.collection("priceList").doc("current").get();

  if (!doc.exists) {
    return models.map(function (m) {
      return { model: m, found: false, base: "", promo: "" };
    });
  }

  const sheets = doc.data().sheets || [];
  const results = models.map(function (m) {
    return queryPriceSingleFromSheets(m, sheets);
  });

  const allNotFound = results.every(function (r) {
    return !r.found;
  });
  if (allNotFound && modelRaw.indexOf("/") !== -1) {
    const combined = queryPriceSingleFromSheets(modelRaw.trim().toUpperCase(), sheets);
    if (combined.found) {
      return models.map(function (m) {
        return { model: m, found: true, base: combined.base, promo: combined.promo };
      });
    }
  }

  return results;
}

async function listFeatureModels(keywordRaw) {
  const keyword = normalizeModel(keywordRaw);
  const doc = await sampoDb.collection("priceList").doc("current").get();
  if (!doc.exists) return [];

  const sheets = doc.data().sheets || [];
  const matches = [];
  sheets.forEach(function (sheet) {
    (sheet.items || []).forEach(function (it) {
      if (normalizeModel(it.model).indexOf(keyword) !== -1) {
        matches.push(it.model);
      }
    });
  });
  return matches;
}

// ── AI 開放式問答輔助函式 ─────────────────────────────────────

// 依問題內容，從價格表資料裡找出可以佐證回答的參考資料：
// 1) 優先找問題裡明確提到的型號，抓出它的完整規格
// 2) 沒提到具體型號時，依關鍵字比對品類，抓該品類前幾筆型號當參考
async function buildAiContext(question) {
  let doc;
  try {
    doc = await sampoDb.collection("priceList").doc("current").get();
  } catch (e) {
    console.error("buildAiContext read error:", e);
    return "";
  }
  if (!doc.exists) return "";

  const sheets = doc.data().sheets || [];
  const upperQ = question.toUpperCase();

  const mentioned = [];
  sheets.forEach(function (sheet) {
    (sheet.items || []).forEach(function (it) {
      const pm = primaryModel(it.model);
      if (pm && pm.length >= 4 && upperQ.indexOf(pm) !== -1) {
        mentioned.push({ sheet: sheet.name, item: it });
      }
    });
  });

  if (mentioned.length > 0) {
    return mentioned
      .slice(0, 6)
      .map(function (m) {
        const specsText = (m.item.specs || [])
          .map(function (s) {
            return s.label + "：" + s.value;
          })
          .join("；");
        return (
          "【" + m.sheet + "】" + m.item.model +
          (m.item.base ? "　批價：" + m.item.base : "") +
          (specsText ? "\n規格：" + specsText : "")
        );
      })
      .join("\n\n");
  }

  const CATEGORY_KEYWORDS = {
    "影音商品": ["電視", "TV"],
    "冰箱": ["冰箱"],
    "洗衣機": ["洗衣機"],
    "冷凍櫃": ["冷凍櫃", "冰櫃"],
    "除濕機": ["除濕機"],
  };

  let targetSheet = null;
  Object.keys(CATEGORY_KEYWORDS).some(function (name) {
    const hit = CATEGORY_KEYWORDS[name].some(function (kw) {
      return question.indexOf(kw) !== -1;
    });
    if (hit) {
      targetSheet = sheets.find(function (s) {
        return s.name === name;
      });
      return true;
    }
    return false;
  });

  if (targetSheet && targetSheet.items && targetSheet.items.length) {
    return targetSheet.items
      .slice(0, 8)
      .map(function (it) {
        const specsText = (it.specs || [])
          .map(function (s) {
            return s.label + "：" + s.value;
          })
          .join("；");
        return (
          it.model +
          (it.base ? "　批價：" + it.base : "") +
          (specsText ? "　" + specsText : "")
        );
      })
      .join("\n");
  }

  return "";
}

// 呼叫 Gemini API 產生回答；context 為空時仍會回答，但會提醒資料不足
async function askGemini(question, context) {
  if (!GEMINI_API_KEY) {
    return "AI 問答功能尚未設定完成，請聯繫管理員設定 GEMINI_API_KEY。";
  }

  const systemPrompt =
    "你是聲寶家電的商品顧問，只根據下面提供的參考資料回答，絕對不要編造資料中沒有的規格或價格數字。" +
    "如果參考資料不足以回答，請誠實告知使用者「資料庫裡沒有足夠的規格資訊」，並建議聯繫業務。" +
    "回答一律使用繁體中文，控制在150字以內，語氣自然口語化，適合在LINE聊天室閱讀，不要使用markdown符號（例如*號或#號）。";

  const userContent = context
    ? "參考資料：\n" + context + "\n\n使用者問題：" + question
    : "目前資料庫裡找不到跟這個問題直接相關的型號資料。使用者問題：" +
      question +
      "\n請照實告知資料不足，並建議聯繫業務取得正確資訊，不要自己編數字。";

  try {
    const res = await fetch(GEMINI_API + "?key=" + GEMINI_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Gemini API failed: " + res.status + " " + errText);
      return "AI 目前有點忙，請稍後再試，或直接聯繫業務。";
    }

    const data = await res.json();
    const answer =
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    return answer ? answer.trim() : "AI 沒有給出回應，換個方式問問看吧。";
  } catch (e) {
    console.error("askGemini error:", e);
    return "AI 問答暫時無法使用，請稍後再試。";
  }
}

exports.uploadAnnouncementFile = onRequest({ region: "asia-east1" }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.indexOf("Bearer ") === 0 ? authHeader.slice(7) : "";
  if (!idToken) {
    res.status(401).json({ ok: false, error: "missing token" });
    return;
  }

  try {
    await sampoApp.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).json({ ok: false, error: "invalid token" });
    return;
  }

  const fileName = req.body && req.body.fileName ? String(req.body.fileName) : "file";
  const contentType = req.body && req.body.contentType ? String(req.body.contentType) : "application/octet-stream";
  const dataBase64 = req.body && req.body.dataBase64 ? String(req.body.dataBase64) : "";

  if (!dataBase64) {
    res.status(400).json({ ok: false, error: "missing file data" });
    return;
  }

  try {
    const buffer = Buffer.from(dataBase64, "base64");
    // 限制單檔大小 8MB，避免超出 Cloud Functions 請求大小限制
    if (buffer.length > 8 * 1024 * 1024) {
      res.status(400).json({ ok: false, error: "檔案過大，請控制在 8MB 以內" });
      return;
    }

    const bucket = admin.storage().bucket();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = "announcements/" + Date.now() + "_" + safeName;
    const file = bucket.file(filePath);
    await file.save(buffer, { contentType: contentType, resumable: false });

    const encodedPath = encodeURIComponent(filePath);
    const url =
      "https://firebasestorage.googleapis.com/v0/b/" +
      bucket.name +
      "/o/" +
      encodedPath +
      "?alt=media";

    res.status(200).json({ ok: true, url: url });
  } catch (e) {
    console.error("uploadAnnouncementFile error:", e);
    res.status(500).json({ ok: false, error: "上傳失敗" });
  }
});

exports.leaveGroupNow = onRequest({ region: "asia-east1" }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.indexOf("Bearer ") === 0 ? authHeader.slice(7) : "";
  if (!idToken) {
    res.status(401).json({ ok: false, error: "missing token" });
    return;
  }

  try {
    await sampoApp.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).json({ ok: false, error: "invalid token" });
    return;
  }

  const groupId = req.body && req.body.groupId ? String(req.body.groupId) : "";
  if (!groupId) {
    res.status(400).json({ ok: false, error: "missing groupId" });
    return;
  }

  try {
    await pushMessage(groupId, [
      textMsg("此群組已被管理員移除使用權限，我先退出囉。"),
    ]);
    await leaveGroup(groupId);
    await clearGroupPending(groupId);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("leaveGroupNow error:", e);
    res.status(500).json({ ok: false, error: "退出失敗" });
  }
});

exports.sendAnnouncement = onRequest({ region: "asia-east1" }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.indexOf("Bearer ") === 0 ? authHeader.slice(7) : "";
  if (!idToken) {
    res.status(401).json({ ok: false, error: "missing token" });
    return;
  }

  try {
    await sampoApp.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).json({ ok: false, error: "invalid token" });
    return;
  }

  const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
  const fileUrl = req.body && req.body.fileUrl ? String(req.body.fileUrl) : "";
  const fileType = req.body && req.body.fileType ? String(req.body.fileType) : "";

  if (!text && !fileUrl) {
    res.status(400).json({ ok: false, error: "empty announcement" });
    return;
  }

  const messages = [];
  if (fileType === "image" && fileUrl) {
    messages.push({ type: "image", originalContentUrl: fileUrl, previewImageUrl: fileUrl });
  }
  if (text) {
    messages.push(textMsg(text));
  }
  if (fileType !== "image" && fileUrl) {
    messages.push(textMsg("附件下載連結：\n" + fileUrl));
  }

  const pushMessages = messages.slice(0, 5);

  let groupIds = [];
  try {
    const snap = await sampoDb.collection("allowedGroups").get();
    snap.forEach(function (doc) {
      groupIds.push(doc.id);
    });
  } catch (e) {
    console.error("讀取白名單失敗:", e);
    res.status(500).json({ ok: false, error: "讀取白名單失敗" });
    return;
  }

  let successCount = 0;
  for (let i = 0; i < groupIds.length; i++) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
        },
        body: JSON.stringify({ to: groupIds[i], messages: pushMessages }),
      });
      if (r.ok) {
        successCount++;
      } else {
        const errText = await r.text();
        console.error("push failed for group " + groupIds[i] + ": " + errText);
      }
    } catch (e) {
      console.error("push error for group " + groupIds[i], e);
    }
  }

  res.status(200).json({ ok: true, total: groupIds.length, success: successCount });
});

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
  const groupId = event.source.type === "group" ? event.source.groupId : null;
  const userId = event.source.userId;

  if (event.type === "join") {
    if (groupId) {
      const perms = await getGroupPermissions(groupId);
      if (perms) {
        // 已在白名單，清除待設定記錄
        await clearGroupPending(groupId);
      } else {
        // 尚未設定白名單：開始計算 2 分鐘寬限時間
        await markGroupJoined(groupId);
      }
    }
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg(
          "哈囉!我是聲寶庫存查詢小幫手。\n\n輸入「groupid」可以取得這個群組的 ID,提供給管理員設定白名單。\n※若 2 分鐘內未完成設定,我會自動退出群組。\n\n設定完成後可以這樣查詢:\n查QM-98MI5200（查庫存）\n查ES-B10F功能（查規格）\n查ES-B10F價錢（查批價）\n問ES-B10F適合幾人家庭（AI開放式問答）"
        ),
      ]);
    }
    return;
  }

  if (event.type === "leave") {
    // 被踢出或自行退出時清除記錄
    await clearGroupPending(groupId);
    return;
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // 除錯用指令：不受白名單限制，方便取得 ID 來建立白名單
  if (text === "groupid") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg("這個群組的 ID：\n" + (groupId || "（不是群組，是個人對話）")),
      ]);
    }
    return;
  }

  if (text === "myid") {
    if (event.replyToken) {
      await replyMessage(event.replyToken, [textMsg("你的使用者 ID：\n" + userId)]);
    }
    return;
  }

  // 群組內任何其他訊息：若不在白名單且已超過寬限時間，先退出
  if (groupId) {
    const stillPending = await getGroupPermissions(groupId);
    if (!stillPending) {
      const left = await leaveIfGraceExpired(groupId);
      if (left) return;
    }
  }

  // 其餘查詢指令：僅限白名單群組使用（私訊一律不回應）
  if (!groupId) return;
  const perms = await getGroupPermissions(groupId);
  if (!perms) {
    // 不在白名單：若已超過寬限時間，直接退出群組
    await leaveIfGraceExpired(groupId);
    return;
  }
  // 已在白名單，清掉待設定記錄
  await clearGroupPending(groupId);

  if (text.indexOf("功能列表") === 0) {
    if (!perms.list) return;
    const keyword = text.slice(4).trim();

    if (!keyword) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「功能列表」後面接關鍵字,例如:功能列表EM-43"),
        ]);
      }
      return;
    }

    const matches = await listFeatureModels(keyword);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n" : "";

    if (matches.length === 0) {
      await replyMessage(event.replyToken, [
        textMsg(namePrefix + "價格表資料裡找不到包含「" + keyword + "」的型號"),
      ]);
      return;
    }

    await replyMessage(event.replyToken, [
      textMsg(namePrefix + "找到 " + matches.length + " 筆\n\n" + matches.slice(0, 40).join("\n")),
    ]);
    return;
  }

  if (text.indexOf("列表") === 0) {
    if (!perms.list) return;
    const keyword = text.slice(2).trim();

    if (!keyword) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「列表」後面接關鍵字,例如:列表冷氣 或 列表AW"),
        ]);
      }
      return;
    }

    const matches = await listModels(keyword, perms.location);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n\n" : "";

    if (matches.length === 0) {
      await replyMessage(event.replyToken, [
        textMsg(namePrefix + "找不到包含「" + keyword + "」的型號"),
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
        (idx === 0 ? namePrefix : "") +
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

  // AI 開放式問答：問[問題]，例如「問ES-B10F適合幾人家庭」「問小家庭適合哪台冰箱」
  if (text.charAt(0) === "問") {
    if (!perms.ai) return;
    const question = text.slice(1).trim();

    if (!question) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「問」後面接你的問題,例如:問ES-B10F適合幾人家庭"),
        ]);
      }
      return;
    }

    const context = await buildAiContext(question);
    const answer = await askGemini(question, context);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n\n" : "";

    await replyMessage(event.replyToken, [textMsg(namePrefix + answer)]);
    return;
  }

  // 支援「價錢」「價格」「多少錢」三種說法
  const priceSuffix = ["價錢", "價格", "多少錢"].find(function (s) {
    return text.charAt(0) === "查" && text.slice(-s.length) === s;
  });

  if (priceSuffix) {
    if (!perms.price) return;
    const modelRaw = text.slice(1, -priceSuffix.length).trim();

    if (!modelRaw) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「查」和「價錢」中間輸入型號,例如:查ES-B10F價錢\n(也可以用「價格」或「多少錢」)"),
        ]);
      }
      return;
    }

    const results = await queryPrice(modelRaw);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n" : "";

    if (results.length === 1) {
      const result = results[0];
      if (!result.found) {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 查無此型號的價格資料,請確認型號是否正確"),
        ]);
      } else if (!result.base) {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 目前沒有登記批價"),
        ]);
      } else {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + "\n批價：" + result.base),
        ]);
      }
    } else {
      const lines = results.map(function (result) {
        if (!result.found) {
          return result.model + "：查無此型號的價格資料";
        }
        if (!result.base) {
          return result.model + "：目前沒有登記批價";
        }
        return result.model + "　批價：" + result.base;
      });
      await replyMessage(event.replyToken, [
        textMsg(namePrefix + lines.join("\n")),
      ]);
    }
    return;
  }

  if (text.charAt(0) === "查" && text.slice(-2) === "功能") {
    if (!perms.feature) return;
    const modelRaw = text.slice(1, -2).trim();

    if (!modelRaw) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「查」和「功能」中間輸入型號,例如:查ES-B10F功能"),
        ]);
      }
      return;
    }

    const results = await queryFeatures(modelRaw);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n" : "";

    if (results.length === 1) {
      const result = results[0];
      if (!result.found) {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 查無此型號的功能資料,請確認型號是否正確"),
        ]);
      } else if (result.specs.length === 0) {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 目前沒有登記功能規格資料"),
        ]);
      } else {
        const lines = result.specs.map(function (sp) {
          return sp.label + "：" + sp.value;
        });
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 功能規格\n\n" + lines.join("\n")),
        ]);
      }
    } else {
      // AU/AM 或 RAU/RAM 這種合併寫法：拆成多筆分別顯示
      const blocks = results.map(function (result) {
        if (!result.found) {
          return result.model + "：查無此型號的功能資料";
        }
        if (result.specs.length === 0) {
          return result.model + "：目前沒有登記功能規格資料";
        }
        const lines = result.specs.map(function (sp) {
          return "　" + sp.label + "：" + sp.value;
        });
        return result.model + " 功能規格\n" + lines.join("\n");
      });
      await replyMessage(event.replyToken, [
        textMsg(namePrefix + blocks.join("\n\n")),
      ]);
    }
    return;
  }

  if (text.charAt(0) === "查") {
    if (!perms.stock) return;
    const modelRaw = text.slice(1).trim();

    if (!modelRaw) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「查」後面接完整型號,例如:查QM-98MI5200"),
        ]);
      }
      return;
    }

    const results = await queryStock(modelRaw, perms.location);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n" : "";
    const warning = "\n\n※庫存10個以下需跟業務確認\n※無庫存也可以詢問業務";

    if (results.length === 1) {
      const result = results[0];
      if (!result.found) {
        await replyMessage(event.replyToken, [
          textMsg(namePrefix + result.model + " 查無此型號,請確認型號是否正確"),
        ]);
      } else if (result.stock > 0) {
        await replyMessage(event.replyToken, [
          textMsg(
            namePrefix + result.model + " 目前有貨\n庫存量:" + result.stock + warning
          ),
        ]);
      } else {
        await replyMessage(event.replyToken, [
          textMsg(
            namePrefix + result.model + " 目前沒貨\n庫存量:0" + warning
          ),
        ]);
      }
    } else {
      // AU/AM 這種合併寫法：拆成多筆分別顯示
      const lines = results.map(function (result) {
        if (!result.found) {
          return result.model + "：查無此型號";
        }
        return result.model + "：" + result.stock + "台";
      });
      await replyMessage(event.replyToken, [
        textMsg(namePrefix + lines.join("\n") + warning),
      ]);
    }

    // 低庫存（含無庫存）自動通知管理員
    const lowStockResults = results.filter(function (r) {
      return r.found && r.stock <= 10;
    });
    if (lowStockResults.length > 0) {
      notifyLowStock(groupId, displayName, lowStockResults, perms.location).catch(function (err) {
        console.error("notifyLowStock error:", err);
      });
    }
  }
}
