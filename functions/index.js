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

async function isGroupAllowed(groupId) {
  if (!groupId) return false;
  try {
    const doc = await sampoDb.collection("allowedGroups").doc(groupId).get();
    return doc.exists;
  } catch (e) {
    console.error("isGroupAllowed error:", e);
    return false;
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

async function queryStockSingle(model, items) {
  const match = items.find(function (it) {
    return String(it.model).trim().toUpperCase().indexOf(model) === 0;
  });

  if (!match) {
    return { model: model, found: false, stock: 0 };
  }

  return { model: match.model, found: true, stock: match.stock };
}

async function queryStock(modelRaw) {
  const items = await getItems();
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
      return [combined];
    }
  }

  return results;
}

async function listModels(keywordRaw) {
  const keyword = keywordRaw.trim().toUpperCase();
  const items = await getItems();
  const matches = items.filter(function (it) {
    return String(it.model).trim().toUpperCase().indexOf(keyword) !== -1;
  });
  return matches;
}

async function queryFeatures(modelRaw) {
  const model = modelRaw.trim().toUpperCase();
  const doc = await sampoDb.collection("priceList").doc("current").get();

  if (!doc.exists) {
    return { model: model, found: false, specs: [] };
  }

  const sheets = doc.data().sheets || [];
  for (let i = 0; i < sheets.length; i++) {
    const items = sheets[i].items || [];
    const match = items.find(function (it) {
      return String(it.model).trim().toUpperCase().indexOf(model) === 0;
    });
    if (match) {
      return { model: match.model, found: true, specs: match.specs || [] };
    }
  }

  return { model: model, found: false, specs: [] };
}

async function listFeatureModels(keywordRaw) {
  const keyword = keywordRaw.trim().toUpperCase();
  const doc = await sampoDb.collection("priceList").doc("current").get();
  if (!doc.exists) return [];

  const sheets = doc.data().sheets || [];
  const matches = [];
  sheets.forEach(function (sheet) {
    (sheet.items || []).forEach(function (it) {
      if (String(it.model).trim().toUpperCase().indexOf(keyword) !== -1) {
        matches.push(it.model);
      }
    });
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
  const groupId = event.source.type === "group" ? event.source.groupId : null;
  const userId = event.source.userId;

  if (event.type === "join") {
    // ※自動退出邏輯暫時停用，方便收集群組 ID 建立白名單
    // const allowed = groupId ? await isGroupAllowed(groupId) : true;
    // if (groupId && !allowed) {
    //   await leaveGroup(groupId);
    //   return;
    // }
    if (event.replyToken) {
      await replyMessage(event.replyToken, [
        textMsg(
          "哈囉!我是聲寶庫存查詢小幫手。\n\n輸入「groupid」可以取得這個群組的 ID,提供給管理員設定白名單。\n\n設定完成後,即可輸入「查」加型號查詢庫存,例如:\n查QM-98MI5200"
        ),
      ]);
    }
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

  // 其餘查詢指令：僅限白名單群組使用（私訊一律不回應）
  if (!groupId) return;
  const allowed = await isGroupAllowed(groupId);
  if (!allowed) return;

  if (text.indexOf("功能列表") === 0) {
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

  if (text.charAt(0) === "查" && text.slice(-2) === "功能") {
    const modelRaw = text.slice(1, -2).trim();

    if (!modelRaw) {
      if (event.replyToken) {
        await replyMessage(event.replyToken, [
          textMsg("請在「查」和「功能」中間輸入型號,例如:查ES-B10F功能"),
        ]);
      }
      return;
    }

    const result = await queryFeatures(modelRaw);

    if (!event.replyToken) return;

    const displayName = await getDisplayName(groupId, userId);
    const namePrefix = displayName ? displayName + " ，你好！\n" : "";

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

    const results = await queryStock(modelRaw);

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
  }
}