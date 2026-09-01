const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const BUNDLED_UPLOADS = path.join(PUBLIC, "uploads");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const UPLOADS = path.join(DATA_DIR, "uploads");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";

const MENU_FILE = path.join(DATA_DIR, "menu.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

const sessions = new Set(); // 兼容旧版临时会话
const LOGIN_DAYS = 30;
const AUTH_SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("sijisancan-v62:" + ADMIN_PASSWORD).digest("hex");

const MAX_BODY_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// =====================================================
// 初始化
// =====================================================

function ensureDirectory(dir) {
  if (fs.existsSync(dir)) {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      const backup = dir + ".invalid-" + Date.now();
      fs.renameSync(dir, backup);
      console.warn("发现同名文件，已自动移走:", backup);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

ensureDirectory(PUBLIC);
ensureDirectory(DATA_DIR);
ensureDirectory(UPLOADS);

// 如果使用 Render Persistent Disk 且磁盘里还没有数据，先复制仓库中的初始 JSON。
function seedDataFile(target, bundled, fallback) {
  if (fs.existsSync(target)) return;
  try {
    if (fs.existsSync(bundled) && fs.statSync(bundled).isFile()) {
      fs.copyFileSync(bundled, target);
      return;
    }
  } catch (e) {
    console.error("初始化数据文件失败:", e);
  }
  fs.writeFileSync(target, JSON.stringify(fallback, null, 2), "utf8");
}

seedDataFile(MENU_FILE, path.join(ROOT, "menu.json"), []);
seedDataFile(ORDERS_FILE, path.join(ROOT, "orders.json"), []);

// =====================================================
// JSON
// =====================================================

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );

      return fallback;
    }

    const text = fs.readFileSync(file, "utf8").trim();

    if (!text) {
      return fallback;
    }

    return JSON.parse(text);

  } catch (error) {
    console.error("读取 JSON 失败:", file);
    console.error(error);

    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

// =====================================================
// HTTP Response
// =====================================================

function send(res, status, type, body) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function json(res, status, data) {
  send(
    res,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(data)
  );
}

// =====================================================
// Cookie / 登录
// =====================================================

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";

  const match = cookie.match(
    new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")
  );

  return match ? match[1] : "";
}

function makeAuthToken(exp) {
  const payload = String(exp);
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}

function validAuthToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return false;
    const exp = Number(parts[0]);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const expected = crypto.createHmac("sha256", AUTH_SECRET).update(parts[0]).digest("hex");
    const a = Buffer.from(parts[1], "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function authed(req) {
  const auth = getCookie(req, "admin_auth");
  if (validAuthToken(auth)) return true;

  // 兼容 V6 旧版当前进程中的 sid
  const sid = getCookie(req, "sid");
  return !!(sid && sessions.has(sid));
}

// =====================================================
// 普通 Body
// =====================================================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk.toString("utf8");

      if (data.length > MAX_BODY_SIZE) {
        reject(new Error("请求数据太大"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }

      const contentType = String(
        req.headers["content-type"] || ""
      ).toLowerCase();

      try {
        // JSON
        if (
          contentType.includes("application/json")
        ) {
          resolve(JSON.parse(data));
          return;
        }

        // form-urlencoded
        if (
          contentType.includes(
            "application/x-www-form-urlencoded"
          )
        ) {
          const params = new URLSearchParams(data);
          const result = {};

          for (const [key, value] of params.entries()) {
            result[key] = value;
          }

          resolve(result);
          return;
        }

        // 兼容以前的请求
        if (
          data.trim().startsWith("{") ||
          data.trim().startsWith("[")
        ) {
          resolve(JSON.parse(data));
          return;
        }

        reject(
          new Error(
            "不支持的 Content-Type: " +
            contentType
          )
        );

      } catch (error) {
        console.error("请求 Body 解析失败");
        console.error("Content-Type:", contentType);
        console.error("Body:", data.slice(0, 1000));

        reject(error);
      }
    });

    req.on("error", reject);
  });
}

// =====================================================
// multipart/form-data 解析
//
// 不依赖 multer / busboy，直接使用 Node.js 原生 Buffer。
// 支持：
// - 普通字段
// - 图片文件
// =====================================================

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(
      req.headers["content-type"] || ""
    );

    const match = contentType.match(
      /boundary=(?:"([^"]+)"|([^;]+))/i
    );

    if (!match) {
      reject(
        new Error(
          "multipart/form-data 缺少 boundary"
        )
      );

      return;
    }

    const boundary =
      match[1] || match[2];

    const boundaryBuffer =
      Buffer.from("--" + boundary);

    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;

      if (totalSize > MAX_BODY_SIZE) {
        reject(
          new Error(
            "上传数据超过 15MB 限制"
          )
        );

        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const buffer =
          Buffer.concat(chunks);

        const result = {};
        const files = {};

        let position = 0;

        while (position < buffer.length) {
          const boundaryIndex =
            buffer.indexOf(
              boundaryBuffer,
              position
            );

          if (boundaryIndex === -1) {
            break;
          }

          position =
            boundaryIndex +
            boundaryBuffer.length;

          // 最终 boundary
          if (
            buffer[position] === 45 &&
            buffer[position + 1] === 45
          ) {
            break;
          }

          // 跳过 CRLF
          if (
            buffer[position] === 13 &&
            buffer[position + 1] === 10
          ) {
            position += 2;
          }

          const headerEnd =
            buffer.indexOf(
              Buffer.from("\r\n\r\n"),
              position
            );

          if (headerEnd === -1) {
            break;
          }

          const headerText =
            buffer
              .slice(
                position,
                headerEnd
              )
              .toString("utf8");

          const headers =
            parseMultipartHeaders(
              headerText
            );

          const contentStart =
            headerEnd + 4;

          const nextBoundary =
            buffer.indexOf(
              boundaryBuffer,
              contentStart
            );

          if (nextBoundary === -1) {
            break;
          }

          let contentEnd =
            nextBoundary;

          // 删除 boundary 前的 CRLF
          if (
            buffer[contentEnd - 2] === 13 &&
            buffer[contentEnd - 1] === 10
          ) {
            contentEnd -= 2;
          }

          const content =
            buffer.slice(
              contentStart,
              contentEnd
            );

          const disposition =
            headers["content-disposition"] || "";

          const nameMatch =
            disposition.match(
              /name="([^"]+)"/i
            );

          if (!nameMatch) {
            position =
              nextBoundary;

            continue;
          }

          const fieldName =
            nameMatch[1];

          const fileMatch =
            disposition.match(
              /filename="([^"]*)"/i
            );

          if (fileMatch) {
            const filename =
              path.basename(
                fileMatch[1] || ""
              );

            files[fieldName] = {
              filename,
              contentType:
                headers["content-type"] ||
                "application/octet-stream",
              size:
                content.length,
              buffer:
                content
            };

          } else {
            result[fieldName] =
              content.toString("utf8");
          }

          position =
            nextBoundary;
        }

        resolve({
          fields: result,
          files
        });

      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function parseMultipartHeaders(text) {
  const headers = {};

  const lines =
    text.split(/\r\n/);

  for (const line of lines) {
    const index =
      line.indexOf(":");

    if (index === -1) {
      continue;
    }

    const key =
      line
        .slice(0, index)
        .trim()
        .toLowerCase();

    const value =
      line
        .slice(index + 1)
        .trim();

    headers[key] = value;
  }

  return headers;
}

// =====================================================
// 图片
// =====================================================

function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      ext: "png",
      mime: "image/png"
    };
  }

  // JPEG
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      ext: "jpg",
      mime: "image/jpeg"
    };
  }

  // GIF
  if (
    buffer.slice(0, 6).toString("ascii") ===
    "GIF87a" ||
    buffer.slice(0, 6).toString("ascii") ===
    "GIF89a"
  ) {
    return {
      ext: "gif",
      mime: "image/gif"
    };
  }

  // WEBP
  if (
    buffer.slice(0, 4).toString("ascii") ===
      "RIFF" &&
    buffer.slice(8, 12).toString("ascii") ===
      "WEBP"
  ) {
    return {
      ext: "webp",
      mime: "image/webp"
    };
  }

  return null;
}

function saveUploadedImage(file) {
  if (!file) {
    return "";
  }

  if (!file.buffer || !file.buffer.length) {
    throw new Error("图片文件为空");
  }

  if (
    file.buffer.length >
    MAX_IMAGE_SIZE
  ) {
    throw new Error(
      "图片不能超过 10MB"
    );
  }

  const detected =
    detectImageType(file.buffer);

  if (!detected) {
    throw new Error(
      "只支持 JPG / PNG / GIF / WEBP 图片"
    );
  }

  const randomName =
    crypto.randomBytes(16).toString("hex") +
    "." +
    detected.ext;

  const filename =
    path.basename(randomName);

  const target =
    path.join(
      UPLOADS,
      filename
    );

  fs.writeFileSync(
    target,
    file.buffer
  );

  return "/uploads/" + filename;
}

function deleteUploadedImage(imageUrl) {
  if (!imageUrl) {
    return;
  }

  if (
    !String(imageUrl).startsWith(
      "/uploads/"
    )
  ) {
    return;
  }

  const filename =
    path.basename(
      String(imageUrl)
    );

  const file =
    path.join(
      UPLOADS,
      filename
    );

  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    console.error(
      "删除旧图片失败:",
      error
    );
  }
}

// =====================================================
// 安全数值
// =====================================================

function koreaDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return `${out.year}-${out.month}-${out.day}`;
}

function todayString() {
  return koreaDateString(new Date());
}

function isTodayKorea(order) {
  if (!order || !order.createdAt) return false;
  const d = new Date(order.createdAt);
  if (Number.isNaN(d.getTime())) return false;
  return koreaDateString(d) === todayString();
}

function safeTable(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 1;
  }

  return Math.min(
    20,
    Math.max(
      1,
      Math.floor(n)
    )
  );
}

function safeQty(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 1;
  }

  return Math.min(
    99,
    Math.max(
      1,
      Math.floor(n)
    )
  );
}

function safePrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.max(
    0,
    Math.round(n)
  );
}

// =====================================================
// 订单
// =====================================================

function orderDetail(order) {
  const items =
    Array.isArray(order.items)
      ? order.items
      : [];

  return {
    id:
      order.id || "",

    table:
      safeTable(order.table),

    type:
      order.type === "TAKEOUT"
        ? "TAKEOUT"
        : "DINE_IN",

    status:
      order.status || "NEW",

    note:
      String(
        order.note || ""
      ),

    createdAt:
      order.createdAt || "",

    doneAt:
      order.doneAt || "",

    paidAt:
      order.paidAt || "",

    cancelledAt:
      order.cancelledAt || "",

    items:
      items.map((item) => {
        const price =
          safePrice(item.price);

        const qty =
          safeQty(item.qty);

        return {
          id:
            item.id || "",

          name:
            item.name || "",

          kr:
            item.kr || "",

          variantId: item.variantId || "",
          variantName: item.variantName || "",
          variantKr: item.variantKr || "",
          refillable: !!item.refillable,
          kind: item.kind || "ITEM",

          qty,

          price,

          subtotal:
            price * qty
        };
      }),

    total:
      safePrice(order.total),

    isRefill: !!order.isRefill,
    parentOrderId: order.parentOrderId || "",
    printState: order.printState || "PENDING",
    printedAt: order.printedAt || "",
    printCount: Number(order.printCount || 0),
    printError: order.printError || ""
  };
}

function createOrderId() {
  return (
    Date.now()
      .toString(36)
      .toUpperCase() +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()
  );
}

function createMenuId(
  name,
  menus
) {
  let base =
    String(name || "")
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        "-"
      )
      .replace(
        /^-|-$/g,
        ""
      );

  if (!base) {
    base = "menu";
  }

  let id = base;
  let number = 2;

  while (
    menus.some(
      (item) =>
        item.id === id
    )
  ) {
    id =
      base +
      "-" +
      number++;
  }

  return id;
}

// =====================================================
// HTTP SERVER
// =====================================================

const server =
  http.createServer(
    async (req, res) => {
      try {
        const requestUrl =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );

        const p =
          requestUrl.pathname;

        // =================================================
        // OPTIONS
        // =================================================

        if (
          req.method === "OPTIONS"
        ) {
          res.writeHead(204, {
            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Credentials":
              "true",

            "Access-Control-Allow-Methods":
              "GET,POST,DELETE,OPTIONS",

            "Access-Control-Allow-Headers":
              "Content-Type"
          });

          return res.end();
        }

        // =================================================
        // 顾客：菜单
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/menu"
        ) {
          const menu =
            readJson(
              MENU_FILE,
              []
            );

          // V6.3：顾客端保留售罄菜品，由前端灰色显示并禁止下单
          return json(
            res,
            200,
            menu
          );
        }

        // =================================================
        // 老板登录
        // =================================================

        if (
          req.method === "POST" &&
          p === "/api/login"
        ) {
          const body =
            await parseBody(req);

          if (
            String(
              body.password || ""
            ) ===
            ADMIN_PASSWORD
          ) {
            const sid = crypto.randomBytes(24).toString("hex");
            sessions.add(sid);

            const exp = Date.now() + LOGIN_DAYS * 24 * 60 * 60 * 1000;
            const authToken = makeAuthToken(exp);

            res.writeHead(200, {
              "Set-Cookie": [
                "admin_auth=" + authToken + "; Max-Age=" + (LOGIN_DAYS * 86400) + "; HttpOnly; SameSite=Lax; Path=/",
                "sid=" + sid + "; HttpOnly; SameSite=Lax; Path=/"
              ],

              "Content-Type":
                "application/json; charset=utf-8",

              "Cache-Control":
                "no-store"
            });

            return res.end(
              JSON.stringify({
                ok: true
              })
            );
          }

          return json(
            res,
            401,
            {
              error:
                "密码错误"
            }
          );
        }

        // =================================================
        // 老板退出
        // =================================================

        if (
          req.method === "POST" &&
          p === "/api/logout"
        ) {
          const sid =
            getCookie(
              req,
              "sid"
            );

          if (sid) {
            sessions.delete(
              sid
            );
          }

          res.writeHead(200, {
            "Set-Cookie": [
              "admin_auth=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
              "sid=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/"
            ],

            "Content-Type":
              "application/json; charset=utf-8"
          });

          return res.end(
            JSON.stringify({
              ok: true
            })
          );
        }

        // =================================================
        // V6.3 顾客：查看本设备已提交的订单
        // 只按随机订单号查询，不允许按桌号枚举，避免看到其他客人的订单。
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/customer/orders"
        ) {
          const raw = String(requestUrl.searchParams.get("ids") || "");
          const ids = raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 50);
          if (!ids.length) return json(res, 200, []);
          const idSet = new Set(ids);
          const orders = readJson(ORDERS_FILE, []);
          const found = orders
            .filter(o => idSet.has(String(o.id || "")))
            .sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .map(orderDetail);
          return json(res, 200, found);
        }

        // =================================================
        // 老板：全部订单
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/orders"
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          return json(
            res,
            200,
            orders.map(
              orderDetail
            )
          );
        }

        // =================================================
        // 老板：今日订单
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/orders/today"
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const todayOrders = orders.filter(isTodayKorea);

          return json(
            res,
            200,
            todayOrders.map(
              orderDetail
            )
          );
        }

        // =================================================
        // 顾客：提交订单
        // =================================================

        if (
          req.method === "POST" &&
          p === "/api/orders"
        ) {
          const body =
            await parseBody(req);

          const menu =
            readJson(
              MENU_FILE,
              []
            );

          if (
            !Array.isArray(
              body.items
            )
          ) {
            return json(
              res,
              400,
              {
                error:
                  "订单商品数据无效"
              }
            );
          }

          const items =
            body.items
              .map(
                (item) => {
                  const menuItem =
                    menu.find(
                      (m) =>
                        String(m.id) ===
                        String(item.id)
                    );

                  if (!menuItem) {
                    return null;
                  }

                  if (
                    menuItem.on ===
                    false
                  ) {
                    return null;
                  }

                  const qty = safeQty(item.qty);
                  const variants = Array.isArray(menuItem.variants) ? menuItem.variants : [];
                  let variant = null;
                  if (variants.length) {
                    variant = variants.find(v => String(v.id) === String(item.variantId || ""));
                    if (!variant) return null;
                  }
                  const price = safePrice(variant ? variant.price : menuItem.price);

                  return {
                    id: menuItem.id,
                    name: menuItem.name,
                    kr: menuItem.kr || "",
                    variantId: variant ? String(variant.id || "") : "",
                    variantName: variant ? String(variant.name || "") : "",
                    variantKr: variant ? String(variant.kr || "") : "",
                    refillable: !!(variant && variant.refillable),
                    kind: "ITEM",
                    qty,
                    price,
                    subtotal: price * qty
                  };
                }
              )
              .filter(Boolean);

          if (!items.length) {
            return json(
              res,
              400,
              {
                error:
                  "购物车为空"
              }
            );
          }

          const total =
            items.reduce(
              (sum, item) =>
                sum +
                item.subtotal,
              0
            );

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const order = {
            id:
              createOrderId(),

            table:
              safeTable(
                body.table
              ),

            items,

            total,

            note:
              String(
                body.note || ""
              ).slice(
                0,
                200
              ),

            type:
              body.type ===
              "TAKEOUT"
                ? "TAKEOUT"
                : "DINE_IN",

            status:
              "NEW",

            printState: "PENDING",
            printCount: 0,

            createdAt:
              new Date().toISOString()
          };

          orders.push(order);

          writeJson(
            ORDERS_FILE,
            orders
          );

          return json(
            res,
            201,
            orderDetail(order)
          );
        }

        // =================================================
        // 修改订单状态
        // =================================================

        if (
          req.method === "POST" &&
          /^\/api\/orders\/[^/]+\/status$/.test(
            p
          )
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const id =
            p.split("/")[3];

          const body =
            await parseBody(req);

          const allowed = [
            "NEW",
            "COOKING",
            "DONE",
            "PAID",
            "CANCELLED"
          ];

          if (
            !allowed.includes(
              body.status
            )
          ) {
            return json(
              res,
              400,
              {
                error:
                  "无效订单状态"
              }
            );
          }

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const order =
            orders.find(
              (item) =>
                String(
                  item.id
                ) ===
                String(id)
            );

          if (!order) {
            return json(
              res,
              404,
              {
                error:
                  "订单不存在"
              }
            );
          }

          order.status =
            body.status;

          if (body.status === "DONE" && !order.doneAt) {
            order.doneAt = new Date().toISOString();
          }
          if (body.status === "PAID" && !order.paidAt) {
            order.paidAt = new Date().toISOString();
          }
          if (body.status === "CANCELLED" && !order.cancelledAt) {
            order.cancelledAt = new Date().toISOString();
          }

          writeJson(
            ORDERS_FILE,
            orders
          );

          return json(
            res,
            200,
            orderDetail(order)
          );
        }

        // =================================================
        // 删除订单
        // =================================================

        if (
          req.method === "DELETE" &&
          /^\/api\/orders\/[^/]+$/.test(
            p
          )
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const id =
            p.split("/")[3];

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const newOrders =
            orders.filter(
              (order) =>
                String(
                  order.id
                ) !==
                String(id)
            );

          if (
            newOrders.length ===
            orders.length
          ) {
            return json(
              res,
              404,
              {
                error:
                  "订单不存在"
              }
            );
          }

          writeJson(
            ORDERS_FILE,
            newOrders
          );

          return json(
            res,
            200,
            {
              ok: true
            }
          );
        }

        // =================================================
        // 后台：全部菜单
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/menu/all"
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          return json(
            res,
            200,
            readJson(
              MENU_FILE,
              []
            )
          );
        }

        // =================================================
        // 后台：新增 / 修改菜单
        //
        // 同时支持：
        // application/json
        // multipart/form-data
        // =================================================

        if (
          req.method === "POST" &&
          p === "/api/menu"
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const contentType =
            String(
              req.headers[
                "content-type"
              ] || ""
            ).toLowerCase();

          let body = {};
          let uploadedFile =
            null;

          if (
            contentType.includes(
              "multipart/form-data"
            )
          ) {
            const parsed =
              await parseMultipart(
                req
              );

            body =
              parsed.fields;

            uploadedFile =
              parsed.files.image ||
              null;

          } else {
            body =
              await parseBody(req);
          }

          const menus =
            readJson(
              MENU_FILE,
              []
            );

          // =================================================
          // 修改现有菜品
          // =================================================

          if (body.id) {
            const index =
              menus.findIndex(
                (item) =>
                  String(
                    item.id
                  ) ===
                  String(
                    body.id
                  )
              );

            if (index < 0) {
              return json(
                res,
                404,
                {
                  error:
                    "菜单不存在"
                }
              );
            }

            const old =
              menus[index];

            if (
              body.name !==
              undefined
            ) {
              old.name =
                String(
                  body.name
                ).trim();
            }

            if (
              body.kr !==
              undefined
            ) {
              old.kr =
                String(
                  body.kr
                ).trim();
            }

            if (
              body.category !==
              undefined
            ) {
              old.category =
                String(
                  body.category
                ).trim();
            }

            if (
              body.price !==
              undefined
            ) {
              old.price =
                safePrice(
                  body.price
                );
            }

            if (body.variants !== undefined) {
              let raw = body.variants;
              if (typeof raw === "string") {
                try { raw = JSON.parse(raw); } catch { raw = []; }
              }
              old.variants = Array.isArray(raw) ? raw.map((v, idx) => ({
                id: String(v.id || `v${idx+1}`),
                name: String(v.name || "").trim(),
                kr: String(v.kr || "").trim(),
                price: safePrice(v.price),
                refillable: v.refillable === true || v.refillable === "true" || v.refillable === 1 || v.refillable === "1"
              })).filter(v => v.name && v.kr) : [];
            }

            if (
              body.emoji !==
              undefined
            ) {
              old.emoji =
                String(
                  body.emoji ||
                    "🍽️"
                ).trim();
            }

            if (
              body.on !==
              undefined
            ) {
              old.on =
                body.on === true ||
                body.on === "true" ||
                body.on === 1 ||
                body.on === "1";
            }

            if (
              body.image !==
              undefined
            ) {
              old.image =
                String(
                  body.image || ""
                ).trim();
            }

            // 如果 JSON 请求直接指定图片地址
            // 则保存地址
            //
            // 如果 multipart 上传了新图片，
            // 则下面会覆盖旧地址。

            if (uploadedFile) {
              try {
                const oldImage =
                  old.image;

                const newImage =
                  saveUploadedImage(
                    uploadedFile
                  );

                old.image =
                  newImage;

                if (
                  oldImage &&
                  oldImage !==
                    newImage
                ) {
                  deleteUploadedImage(
                    oldImage
                  );
                }

              } catch (error) {
                return json(
                  res,
                  400,
                  {
                    error:
                      error.message ||
                      "图片上传失败"
                  }
                );
              }
            }

            writeJson(
              MENU_FILE,
              menus
            );

            return json(
              res,
              200,
              old
            );
          }

          // =================================================
          // 新增菜品
          // =================================================

          const name =
            String(
              body.name || ""
            ).trim();

          const kr =
            String(
              body.kr || ""
            ).trim();

          const category =
            String(
              body.category || ""
            ).trim();

          const price =
            safePrice(
              body.price
            );

          const emoji =
            String(
              body.emoji ||
                "🍽️"
            ).trim();

          if (!name) {
            return json(
              res,
              400,
              {
                error:
                  "请填写中文菜名"
              }
            );
          }

          if (!kr) {
            return json(
              res,
              400,
              {
                error:
                  "请填写韩文菜名"
              }
            );
          }

          if (!category) {
            return json(
              res,
              400,
              {
                error:
                  "请填写菜品分类"
              }
            );
          }

          const id =
            createMenuId(
              name,
              menus
            );

          let image = "";

          if (uploadedFile) {
            try {
              image =
                saveUploadedImage(
                  uploadedFile
                );
            } catch (error) {
              return json(
                res,
                400,
                {
                  error:
                    error.message ||
                    "图片上传失败"
                }
              );
            }
          }

          let variants = body.variants;
          if (typeof variants === "string") {
            try { variants = JSON.parse(variants); } catch { variants = []; }
          }
          variants = Array.isArray(variants) ? variants.map((v, idx) => ({
            id: String(v.id || `v${idx+1}`),
            name: String(v.name || "").trim(),
            kr: String(v.kr || "").trim(),
            price: safePrice(v.price),
            refillable: v.refillable === true || v.refillable === "true" || v.refillable === 1 || v.refillable === "1"
          })).filter(v => v.name && v.kr) : [];

          const item = {
            id,

            name,

            kr,

            price,

            variants,

            emoji,

            image,

            on:
              !(
                body.on ===
                  false ||
                body.on ===
                  "false" ||
                body.on ===
                  0 ||
                body.on ===
                  "0"
              ),

            category
          };

          menus.push(item);

          writeJson(
            MENU_FILE,
            menus
          );

          return json(
            res,
            201,
            item
          );
        }

        // =================================================
        // 更换已有菜品图片
        //
        // POST /api/menu/:id/image
        // =================================================

        if (
          req.method === "POST" &&
          /^\/api\/menu\/[^/]+\/image$/.test(
            p
          )
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const contentType =
            String(
              req.headers[
                "content-type"
              ] || ""
            ).toLowerCase();

          if (
            !contentType.includes(
              "multipart/form-data"
            )
          ) {
            return json(
              res,
              400,
              {
                error:
                  "请使用图片上传方式"
              }
            );
          }

          const parsed =
            await parseMultipart(
              req
            );

          const file =
            parsed.files.image;

          if (!file) {
            return json(
              res,
              400,
              {
                error:
                  "没有找到图片文件"
              }
            );
          }

          const id =
            p.split("/")[3];

          const menus =
            readJson(
              MENU_FILE,
              []
            );

          const item =
            menus.find(
              (menuItem) =>
                String(
                  menuItem.id
                ) ===
                String(id)
            );

          if (!item) {
            return json(
              res,
              404,
              {
                error:
                  "菜单不存在"
              }
            );
          }

          try {
            const oldImage =
              item.image || "";

            const newImage =
              saveUploadedImage(
                file
              );

            item.image =
              newImage;

            writeJson(
              MENU_FILE,
              menus
            );

            if (
              oldImage &&
              oldImage !==
                newImage
            ) {
              deleteUploadedImage(
                oldImage
              );
            }

            return json(
              res,
              200,
              item
            );

          } catch (error) {
            return json(
              res,
              400,
              {
                error:
                  error.message ||
                  "照片上传失败"
              }
            );
          }
        }

        // =================================================
        // V6：删除菜品图片
        // =================================================
        if (req.method === "DELETE" && /^\/api\/menu\/[^/]+\/image$/.test(p)) {
          if (!authed(req)) return json(res,401,{error:"unauthorized"});
          const id = p.split("/")[3];
          const menus = readJson(MENU_FILE, []);
          const item = menus.find(x => String(x.id) === String(id));
          if (!item) return json(res,404,{error:"菜单不存在"});
          if (item.image) deleteUploadedImage(item.image);
          item.image = "";
          writeJson(MENU_FILE, menus);
          return json(res,200,item);
        }

        // =================================================
        // V6：免费续面资格（大份/可续面规格）
        // =================================================
        if (req.method === "GET" && p === "/api/refill-eligibility") {
          const table = safeTable(requestUrl.searchParams.get("table"));
          const orders = readJson(ORDERS_FILE, []);
          const candidates = orders.filter(o =>
            isTodayKorea(o) && o.type !== "TAKEOUT" && Number(o.table) === table && !["CANCELLED","PAID"].includes(o.status)
          ).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
          let source = null, sourceItem = null;
          for (const o of candidates) {
            const found = (Array.isArray(o.items)?o.items:[]).find(x => x.refillable);
            if (found) { source=o; sourceItem=found; break; }
          }
          return json(res, 200, {
            eligible: !!source,
            sourceOrderId: source ? source.id : "",
            itemName: sourceItem ? `${sourceItem.name}${sourceItem.variantName ? `（${sourceItem.variantName}）` : ""}` : ""
          });
        }

        // =================================================
        // V6：顾客提交免费续面追加单
        // =================================================
        if (req.method === "POST" && p === "/api/refill") {
          const body = await parseBody(req);
          const table = safeTable(body.table);
          const qty = Math.min(5, safeQty(body.qty || 1));
          const orders = readJson(ORDERS_FILE, []);
          const candidates = orders.filter(o =>
            isTodayKorea(o) && o.type !== "TAKEOUT" && Number(o.table) === table && !["CANCELLED","PAID"].includes(o.status)
          ).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
          let source = null, sourceItem = null;
          for (const o of candidates) {
            const found = (Array.isArray(o.items)?o.items:[]).find(x => x.refillable);
            if (found) { source=o; sourceItem=found; break; }
          }
          if (!source || !sourceItem) return json(res, 400, {error:"本桌暂时没有可免费续面的订单"});
          const order = {
            id: createOrderId(), table, type:"DINE_IN", status:"NEW",
            isRefill:true, parentOrderId:source.id,
            items:[{ id:sourceItem.id, name:`${sourceItem.name}续面`, kr:"면 추가", variantName:sourceItem.variantName || "", variantKr:sourceItem.variantKr || "", qty, price:0, subtotal:0, refillable:false, kind:"REFILL" }],
            total:0, note:String(body.note||"").slice(0,100),
            printState:"PENDING", printCount:0, createdAt:new Date().toISOString()
          };
          orders.push(order); writeJson(ORDERS_FILE, orders);
          return json(res, 201, orderDetail(order));
        }

        // =================================================
        // V6：后台手动补打
        // =================================================
        if (req.method === "POST" && /^\/api\/orders\/[^/]+\/reprint$/.test(p)) {
          if (!authed(req)) return json(res,401,{error:"unauthorized"});
          const id=p.split("/")[3];
          const orders=readJson(ORDERS_FILE,[]); const order=orders.find(o=>String(o.id)===String(id));
          if(!order) return json(res,404,{error:"订单不存在"});
          order.printState="PENDING"; order.printForce=true; order.printError=""; order.printClaimedAt=""; order.reprintRequestedAt=new Date().toISOString();
          writeJson(ORDERS_FILE,orders); return json(res,200,orderDetail(order));
        }

        // =================================================
        // V6：本地打印桥队列（PRINT_KEY）
        // =================================================
        if (req.method === "GET" && p === "/api/print/jobs") {
          const key = requestUrl.searchParams.get("key") || req.headers["x-print-key"] || "";
          const expected = process.env.PRINT_KEY || "sijisancan-print";
          if (String(key) !== String(expected)) return json(res,401,{error:"print unauthorized"});
          const orders=readJson(ORDERS_FILE,[]); const now=Date.now(); const jobs=[];
          for(const o of orders){
            // 旧版本历史订单没有 printState：升级后绝不自动补打，避免厨房一次打印旧单。
            if(!o.printState && !o.printForce) continue;
            if((o.status === "CANCELLED" || o.status === "PAID") && !o.printForce) continue;
            if((o.printState||"PENDING") === "PRINTED" && !o.printForce) continue;
            const claimed = o.printClaimedAt ? new Date(o.printClaimedAt).getTime() : 0;
            if((o.printState||"") === "CLAIMED" && claimed && now-claimed < 45000) continue;
            o.printState="CLAIMED"; o.printClaimedAt=new Date().toISOString(); jobs.push(orderDetail(o));
            if(jobs.length>=5) break;
          }
          if(jobs.length) writeJson(ORDERS_FILE,orders);
          return json(res,200,jobs);
        }

        if (req.method === "POST" && /^\/api\/print\/[^/]+\/ack$/.test(p)) {
          const key = requestUrl.searchParams.get("key") || req.headers["x-print-key"] || "";
          const expected = process.env.PRINT_KEY || "sijisancan-print";
          if (String(key) !== String(expected)) return json(res,401,{error:"print unauthorized"});
          const id=p.split("/")[3]; const body=await parseBody(req); const orders=readJson(ORDERS_FILE,[]);
          const order=orders.find(o=>String(o.id)===String(id)); if(!order) return json(res,404,{error:"订单不存在"});
          if(body.success===true || body.success==="true"){
            order.printState="PRINTED"; order.printedAt=new Date().toISOString(); order.printCount=Number(order.printCount||0)+1; order.printError=""; order.printForce=false;
          } else {
            order.printState="ERROR"; order.printError=String(body.error||"打印失败").slice(0,200);
          }
          order.printClaimedAt=""; writeJson(ORDERS_FILE,orders); return json(res,200,orderDetail(order));
        }

        // =================================================
        // 二维码
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/qr"
        ) {
          const table =
            safeTable(
              requestUrl.searchParams.get(
                "table"
              )
            );

          const protocol =
            String(
              req.headers[
                "x-forwarded-proto"
              ] ||
                "http"
            ).split(",")[0];

          const host =
            req.headers.host ||
            "localhost:" +
              PORT;

          const base =
            protocol +
            "://" +
            host;

          const target =
            base +
            "/?table=" +
            table;

          const svg =
            await QRCode.toString(
              target,
              {
                type: "svg",
                margin: 2,
                width: 360
              }
            );

          return send(
            res,
            200,
            "image/svg+xml; charset=utf-8",
            svg
          );
        }

        // =================================================
        // V6：桌号实时状态
        // =================================================
        if (req.method === "GET" && p === "/api/tables") {
          if (!authed(req)) return json(res, 401, { error:"unauthorized" });
          const orders = readJson(ORDERS_FILE, []);
          const todayOrders = orders.filter(isTodayKorea);
          const tables = [];
          for (let table=1; table<=20; table++) {
            const list = todayOrders.filter(o => Number(o.table)===table && o.type!=="TAKEOUT");
            const active = list.filter(o => ["NEW","COOKING","DONE"].includes(o.status));
            const latest = list.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0] || null;
            tables.push({
              table,
              status: active.some(o=>o.status==="NEW") ? "NEW" : active.some(o=>o.status==="COOKING") ? "COOKING" : active.some(o=>o.status==="DONE") ? "DONE" : "FREE",
              activeOrders: active.length,
              activeTotal: active.reduce((sum,o)=>sum+safePrice(o.total),0),
              latest: latest ? orderDetail(latest) : null
            });
          }
          return json(res,200,tables);
        }

        // =================================================
        // 后台统计
        // =================================================

        if (
          req.method === "GET" &&
          p === "/api/stats"
        ) {
          if (!authed(req)) {
            return json(
              res,
              401,
              {
                error:
                  "unauthorized"
              }
            );
          }

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const todayOrders = orders.filter(isTodayKorea);

          const newOrders =
            todayOrders.filter(
              (order) =>
                order.status ===
                "NEW"
            ).length;

          const cookingOrders =
            todayOrders.filter(
              (order) =>
                order.status ===
                "COOKING"
            ).length;

          const doneOrders =
            todayOrders.filter(
              (order) =>
                order.status ===
                "DONE"
            ).length;

          const paidOrders = todayOrders.filter(order => order.status === "PAID").length;
          const cancelledOrders = todayOrders.filter(order => order.status === "CANCELLED").length;

          const todaySales =
            todayOrders
              .filter(order => order.status === "PAID")
              .reduce(
                (sum, order) => sum + safePrice(order.total),
                0
              );

          const doneSales =
            todayOrders
              .filter(
                (order) =>
                  order.status ===
                  "DONE"
              )
              .reduce(
                (sum, order) =>
                  sum +
                  safePrice(
                    order.total
                  ),
                0
              );

          return json(
            res,
            200,
            {
              orders:
                orders.length,

              todayOrders:
                todayOrders.length,

              todaySales,

              doneSales,

              newOrders,

              cookingOrders,

              doneOrders,

              paidOrders,

              cancelledOrders,

              pendingOrders:
                newOrders +
                cookingOrders
            }
          );
        }

        // =================================================
        // 上传图片静态访问（V5 修复）
        // 图片实际保存到 DATA_DIR/uploads，不再依赖 public/uploads。
        // 同时兼容旧版已经放在 public/uploads 中的图片。
        // =================================================

        if (req.method === "GET" && p.startsWith("/uploads/")) {
          let filename;
          try {
            filename = path.basename(decodeURIComponent(p));
          } catch (e) {
            return send(res, 400, "text/plain; charset=utf-8", "Bad request");
          }

          if (!filename) {
            return send(res, 404, "text/plain; charset=utf-8", "Not found");
          }

          const runtimeFile = path.join(UPLOADS, filename);
          let bundledFile = null;
          try {
            if (fs.existsSync(BUNDLED_UPLOADS) && fs.statSync(BUNDLED_UPLOADS).isDirectory()) {
              bundledFile = path.join(BUNDLED_UPLOADS, filename);
            }
          } catch (e) {}

          let target = runtimeFile;
          if (!fs.existsSync(target) && bundledFile && fs.existsSync(bundledFile)) {
            target = bundledFile;
          }

          return fs.readFile(target, (error, data) => {
            if (error) {
              return send(res, 404, "text/plain; charset=utf-8", "Not found");
            }
            const ext = path.extname(target).toLowerCase();
            const imageTypes = {
              ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
              ".webp":"image/webp", ".gif":"image/gif"
            };
            return send(res, 200, imageTypes[ext] || "application/octet-stream", data);
          });
        }

        // =================================================
        // 静态文件
        // =================================================

        let file;

        if (p === "/") {
          file =
            "index.html";
        } else if (
          p === "/admin"
        ) {
          file =
            "admin.html";
        } else {
          file =
            decodeURIComponent(
              p
            ).replace(
              /^[/\\]+/,
              ""
            );
        }

        const fullPath =
          path.resolve(
            PUBLIC,
            file
          );

        const publicRoot =
          path.resolve(
            PUBLIC
          );

        // 防止 ../ 路径穿越
        if (
          fullPath !==
            publicRoot &&
          !fullPath.startsWith(
            publicRoot +
              path.sep
          )
        ) {
          return send(
            res,
            403,
            "text/plain; charset=utf-8",
            "Forbidden"
          );
        }

        fs.readFile(
          fullPath,
          (error, data) => {
            if (error) {
              return send(
                res,
                404,
                "text/plain; charset=utf-8",
                "Not found"
              );
            }

            const ext =
              path.extname(
                fullPath
              ).toLowerCase();

            const types = {
              ".html":
                "text/html; charset=utf-8",

              ".js":
                "text/javascript; charset=utf-8",

              ".css":
                "text/css; charset=utf-8",

              ".json":
                "application/json; charset=utf-8",

              ".svg":
                "image/svg+xml",

              ".png":
                "image/png",

              ".jpg":
                "image/jpeg",

              ".jpeg":
                "image/jpeg",

              ".webp":
                "image/webp",

              ".gif":
                "image/gif",

              ".ico":
                "image/x-icon"
            };

            send(
              res,
              200,
              types[ext] ||
                "application/octet-stream",
              data
            );
          }
        );

      } catch (error) {
        console.error(
          "SERVER ERROR:",
          error
        );

        if (!res.headersSent) {
          return json(
            res,
            500,
            {
              error:
                "服务器内部错误",

              detail:
                process.env.NODE_ENV ===
                "development"
                  ? String(
                      error.message ||
                        error
                    )
                  : undefined
            }
          );
        }
      }
    }
  );

// =====================================================
// 启动
// =====================================================

server.listen(
  PORT,
  () => {
    console.log(
      "四季三餐 V6 营业版: http://localhost:" +
      PORT
    );

    console.log(
      "图片目录:",
      UPLOADS
    );

    console.log(
      "数据目录:",
      DATA_DIR
    );
  }
);