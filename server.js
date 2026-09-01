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

const sessions = new Set();

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

function authed(req) {
  const sid = getCookie(req, "sid");

  return !!(
    sid &&
    sessions.has(sid)
  );
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

function todayString() {
  const now = new Date();

  const y =
    now.getFullYear();

  const m =
    String(
      now.getMonth() + 1
    ).padStart(2, "0");

  const d =
    String(
      now.getDate()
    ).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function safeTable(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 1;
  }

  return Math.min(
    30,
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

          qty,

          price,

          subtotal:
            price * qty
        };
      }),

    total:
      safePrice(order.total)
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

          return json(
            res,
            200,
            menu.filter(
              (item) =>
                item.on !== false
            )
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
            const sid =
              crypto
                .randomBytes(24)
                .toString("hex");

            sessions.add(sid);

            res.writeHead(200, {
              "Set-Cookie":
                "sid=" +
                sid +
                "; HttpOnly; SameSite=Lax; Path=/",

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
            "Set-Cookie":
              "sid=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",

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

          const today =
            todayString();

          const orders =
            readJson(
              ORDERS_FILE,
              []
            );

          const todayOrders =
            orders.filter(
              (order) =>
                String(
                  order.createdAt ||
                  ""
                ).startsWith(
                  today
                )
            );

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

                  const qty =
                    safeQty(
                      item.qty
                    );

                  const price =
                    safePrice(
                      menuItem.price
                    );

                  return {
                    id:
                      menuItem.id,

                    name:
                      menuItem.name,

                    kr:
                      menuItem.kr ||
                      "",

                    qty,

                    price,

                    subtotal:
                      price * qty
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
            "DONE"
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

          if (
            body.status ===
              "DONE" &&
            !order.doneAt
          ) {
            order.doneAt =
              new Date().toISOString();
          }

          if (
            body.status !==
            "DONE"
          ) {
            delete order.doneAt;
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

          const item = {
            id,

            name,

            kr,

            price,

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

          const today =
            todayString();

          const todayOrders =
            orders.filter(
              (order) =>
                String(
                  order.createdAt ||
                    ""
                ).startsWith(
                  today
                )
            );

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

          const todaySales =
            todayOrders.reduce(
              (sum, order) =>
                sum +
                safePrice(
                  order.total
                ),
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
      "四季三餐 v5: http://localhost:" +
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