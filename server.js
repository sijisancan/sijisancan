```js
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const QRCode = require("qrcode");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = (p) => path.join(ROOT, p);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const POS_API_KEY = process.env.POS_API_KEY || "change-this-pos-key";

const MENU_FILE = "menu.json";
const ORDERS_FILE = "orders.json";

const sessions = new Set();

function read(p) {
  try {
    return JSON.parse(fs.readFileSync(DATA(p), "utf8"));
  } catch (e) {
    return [];
  }
}

function write(p, x) {
  fs.writeFileSync(
    DATA(p),
    JSON.stringify(x, null, 2),
    "utf8"
  );
}

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function json(res, status, obj, extraHeaders = {}) {
  send(
    res,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(obj),
    extraHeaders
  );
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });

    req.on("error", reject);
  });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const reg = new RegExp(
    "(?:^|;\\s*)" +
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "=([^;]+)"
  );

  const match = cookie.match(reg);
  return match ? match[1] : null;
}

function authed(req) {
  const sid = getCookie(req, "sid");
  return !!sid && sessions.has(sid);
}

function posAuthed(req) {
  const key =
    req.headers["x-pos-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  return key && key === POS_API_KEY && POS_API_KEY !== "change-this-pos-key";
}

function validTable(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 1;

  return Math.min(
    30,
    Math.max(1, Math.floor(n))
  );
}

function cleanText(value, max = 200) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function normalizeStatus(status) {
  const allowed = [
    "NEW",
    "COOKING",
    "DONE",
    "CANCELLED"
  ];

  return allowed.includes(status)
    ? status
    : "NEW";
}

function normalizePaymentStatus(status) {
  const allowed = [
    "UNPAID",
    "PAID",
    "REFUNDED"
  ];

  return allowed.includes(status)
    ? status
    : "UNPAID";
}

function ensureOrderShape(order) {
  if (!order.paymentStatus) {
    order.paymentStatus = "UNPAID";
  }

  if (!order.status) {
    order.status = "NEW";
  }

  if (!order.createdAt) {
    order.createdAt = new Date().toISOString();
  }

  return order;
}

function loadOrders() {
  const orders = read(ORDERS_FILE);

  orders.forEach(ensureOrderShape);

  return orders;
}

function saveOrders(orders) {
  write(ORDERS_FILE, orders);
}

function createOrderId() {
  return (
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function getPublicBase(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    "http";

  const host = req.headers.host;

  return `${proto}://${host}`;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();

  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  };

  return map[ext] || "application/octet-stream";
}

function safePublicFile(pathname) {
  let requested =
    pathname === "/"
      ? "/index.html"
      : pathname === "/admin"
      ? "/admin.html"
      : pathname;

  requested = path.normalize(requested);

  if (requested.includes("..")) {
    return null;
  }

  const publicRoot = path.resolve(
    ROOT,
    "public"
  );

  const file = path.resolve(
    publicRoot,
    "." + requested
  );

  if (
    file !== publicRoot &&
    !file.startsWith(publicRoot + path.sep)
  ) {
    return null;
  }

  return file;
}

const server = http.createServer(
  async (req, res) => {
    try {
      const parsed = url.parse(
        req.url,
        true
      );

      const pathname = parsed.pathname;

      /*
       * ==============================
       * 健康检查
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/health"
      ) {
        return json(res, 200, {
          ok: true,
          version: "4.0.0",
          service: "四季三餐"
        });
      }

      /*
       * ==============================
       * 顾客菜单
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/menu"
      ) {
        const menu = read(MENU_FILE)
          .filter((x) => x.on !== false);

        return json(res, 200, menu);
      }

      /*
       * ==============================
       * 老板登录
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname === "/api/login"
      ) {
        const body = await parseBody(req);

        if (
          String(body.password || "") ===
          ADMIN_PASSWORD
        ) {
          const sid =
            crypto.randomBytes(32).toString("hex");

          sessions.add(sid);

          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie":
                `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`
            }
          );
        }

        return json(res, 401, {
          error: "密码错误"
        });
      }

      /*
       * ==============================
       * 老板退出
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname === "/api/logout"
      ) {
        const sid = getCookie(req, "sid");

        if (sid) {
          sessions.delete(sid);
        }

        return json(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie":
              "sid=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/"
          }
        );
      }

      /*
       * ==============================
       * 获取全部订单
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/orders"
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        return json(res, 200, loadOrders());
      }

      /*
       * ==============================
       * 顾客创建订单
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname === "/api/orders"
      ) {
        try {
          const body = await parseBody(req);

          const menu = read(MENU_FILE);

          const rawItems = Array.isArray(body.items)
            ? body.items
            : [];

          const items = rawItems
            .map((item) => {
              const menuItem = menu.find(
                (m) => m.id === item.id
              );

              if (!menuItem) {
                return null;
              }

              if (menuItem.on === false) {
                return null;
              }

              const qty = Math.min(
                99,
                Math.max(
                  1,
                  Math.floor(Number(item.qty) || 1)
                )
              );

              return {
                id: menuItem.id,
                name: menuItem.name,
                kr: menuItem.kr || "",
                emoji:
                  menuItem.emoji || "🍽️",
                qty,
                price: Number(menuItem.price) || 0
              };
            })
            .filter(Boolean);

          if (!items.length) {
            return json(res, 400, {
              error: "订单不能为空"
            });
          }

          const total = items.reduce(
            (sum, item) =>
              sum +
              item.price * item.qty,
            0
          );

          const orders = loadOrders();

          const order = {
            id: createOrderId(),

            table: validTable(body.table),

            items,

            total,

            note: cleanText(
              body.note,
              200
            ),

            type:
              body.type === "TAKEOUT"
                ? "TAKEOUT"
                : "DINE_IN",

            status: "NEW",

            paymentStatus: "UNPAID",

            paymentMethod: null,

            paymentTransactionId: null,

            paidAt: null,

            closedAt: null,

            createdAt:
              new Date().toISOString()
          };

          orders.push(order);

          saveOrders(orders);

          return json(res, 201, order);
        } catch (e) {
          console.error(e);

          return json(res, 400, {
            error: "invalid order"
          });
        }
      }

      /*
       * ==============================
       * 修改订单制作状态
       *
       * NEW
       * COOKING
       * DONE
       * CANCELLED
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname.match(
          /^\/api\/orders\/[^/]+\/status$/
        )
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        const id =
          pathname.split("/")[3];

        const body =
          await parseBody(req);

        const status =
          normalizeStatus(body.status);

        const orders = loadOrders();

        const order = orders.find(
          (x) => x.id === id
        );

        if (!order) {
          return json(res, 404, {
            error: "订单不存在"
          });
        }

        order.status = status;

        saveOrders(orders);

        return json(res, 200, order);
      }

      /*
       * ==============================
       * 手动结账
       *
       * 给老板后台使用
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname.match(
          /^\/api\/orders\/[^/]+\/pay$/
        )
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        const id =
          pathname.split("/")[3];

        const body =
          await parseBody(req);

        const method =
          cleanText(
            body.paymentMethod ||
              "MANUAL",
            30
          );

        const transactionId =
          cleanText(
            body.transactionId ||
              "",
            100
          );

        const orders = loadOrders();

        const order = orders.find(
          (x) => x.id === id
        );

        if (!order) {
          return json(res, 404, {
            error: "订单不存在"
          });
        }

        if (
          order.paymentStatus ===
          "PAID"
        ) {
          return json(res, 200, order);
        }

        order.paymentStatus = "PAID";
        order.paymentMethod = method;

        order.paymentTransactionId =
          transactionId || null;

        order.paidAt =
          new Date().toISOString();

        /*
         * 结账后订单自动结束
         */
        order.closedAt =
          new Date().toISOString();

        /*
         * 如果还没完成制作，
         * 付款并不强制把厨房状态改成 DONE。
         *
         * paymentStatus 与 status 分开保存。
         */

        saveOrders(orders);

        return json(res, 200, {
          ok: true,
          order
        });
      }

      /*
       * ==============================
       * POS 支付回调接口
       *
       * 以后真正接 POS 时使用
       *
       * Header:
       * X-POS-API-Key
       *
       * Body:
       * {
       *   orderId,
       *   paymentMethod,
       *   transactionId
       * }
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname ===
          "/api/pos/payment"
      ) {
        if (!posAuthed(req)) {
          return json(res, 401, {
            error:
              "POS authorization failed"
          });
        }

        const body =
          await parseBody(req);

        const orderId =
          cleanText(
            body.orderId,
            100
          );

        if (!orderId) {
          return json(res, 400, {
            error:
              "orderId required"
          });
        }

        const orders = loadOrders();

        const order = orders.find(
          (x) => x.id === orderId
        );

        if (!order) {
          return json(res, 404, {
            error: "订单不存在"
          });
        }

        /*
         * 防止 POS 重复回调造成重复结账
         */
        if (
          order.paymentStatus ===
          "PAID"
        ) {
          return json(res, 200, {
            ok: true,
            alreadyPaid: true,
            order
          });
        }

        order.paymentStatus = "PAID";

        order.paymentMethod =
          cleanText(
            body.paymentMethod ||
              "POS",
            30
          );

        order.paymentTransactionId =
          cleanText(
            body.transactionId ||
              "",
            100
          ) || null;

        order.paidAt =
          new Date().toISOString();

        /*
         * POS 支付成功
         * 自动关闭订单
         */
        order.closedAt =
          new Date().toISOString();

        saveOrders(orders);

        return json(res, 200, {
          ok: true,
          message:
            "POS支付成功，订单已结账",
          order
        });
      }

      /*
       * ==============================
       * POS 查询订单
       *
       * 以后 POS 可以根据订单号查询
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname.match(
          /^\/api\/pos\/orders\/[^/]+$/
        )
      ) {
        if (!posAuthed(req)) {
          return json(res, 401, {
            error:
              "POS authorization failed"
          });
        }

        const id =
          pathname.split("/")[4];

        const orders = loadOrders();

        const order = orders.find(
          (x) => x.id === id
        );

        if (!order) {
          return json(res, 404, {
            error: "订单不存在"
          });
        }

        return json(res, 200, order);
      }

      /*
       * ==============================
       * POS 退款
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname.match(
          /^\/api\/pos\/orders\/[^/]+\/refund$/
        )
      ) {
        if (!posAuthed(req)) {
          return json(res, 401, {
            error:
              "POS authorization failed"
          });
        }

        const id =
          pathname.split("/")[4];

        const body =
          await parseBody(req);

        const orders = loadOrders();

        const order = orders.find(
          (x) => x.id === id
        );

        if (!order) {
          return json(res, 404, {
            error: "订单不存在"
          });
        }

        if (
          order.paymentStatus !==
          "PAID"
        ) {
          return json(res, 400, {
            error:
              "该订单尚未付款"
          });
        }

        order.paymentStatus =
          "REFUNDED";

        order.refundedAt =
          new Date().toISOString();

        order.refundTransactionId =
          cleanText(
            body.transactionId ||
              "",
            100
          ) || null;

        saveOrders(orders);

        return json(res, 200, {
          ok: true,
          order
        });
      }

      /*
       * ==============================
       * 删除订单
       * ==============================
       */

      if (
        req.method === "DELETE" &&
        pathname.match(
          /^\/api\/orders\/[^/]+$/
        )
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        const id =
          pathname.split("/")[3];

        const orders =
          loadOrders().filter(
            (x) => x.id !== id
          );

        saveOrders(orders);

        return json(res, 200, {
          ok: true
        });
      }

      /*
       * ==============================
       * 获取完整菜单
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/menu/all"
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        return json(
          res,
          200,
          read(MENU_FILE)
        );
      }

      /*
       * ==============================
       * 新增 / 修改菜单
       * ==============================
       */

      if (
        req.method === "POST" &&
        pathname === "/api/menu"
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        const body =
          await parseBody(req);

        const menu =
          read(MENU_FILE);

        /*
         * 新增
         */
        if (!body.id) {
          const item = {
            id:
              "menu-" +
              Date.now().toString(36),

            name:
              cleanText(
                body.name ||
                  "新菜品",
                100
              ),

            kr:
              cleanText(
                body.kr || "",
                100
              ),

            price: Math.max(
              0,
              Number(body.price) || 0
            ),

            emoji:
              cleanText(
                body.emoji ||
                  "🍽️",
                10
              ),

            on:
              body.on !== false
          };

          menu.push(item);

          write(
            MENU_FILE,
            menu
          );

          return json(
            res,
            201,
            item
          );
        }

        /*
         * 修改
         */

        const index =
          menu.findIndex(
            (x) =>
              x.id === body.id
          );

        if (index < 0) {
          return json(res, 404, {
            error:
              "菜品不存在"
          });
        }

        menu[index].name =
          cleanText(
            body.name ||
              menu[index].name,
            100
          );

        menu[index].kr =
          cleanText(
            body.kr ||
              menu[index].kr ||
              "",
            100
          );

        menu[index].price =
          Math.max(
            0,
            Number(
              body.price ??
                menu[index].price
            ) || 0
          );

        menu[index].emoji =
          cleanText(
            body.emoji ||
              menu[index].emoji ||
              "🍽️",
            10
          );

        menu[index].on =
          body.on !== undefined
            ? !!body.on
            : !!menu[index].on;

        write(
          MENU_FILE,
          menu
        );

        return json(
          res,
          200,
          menu[index]
        );
      }

      /*
       * ==============================
       * QR二维码
       *
       * /api/qr?table=1
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/qr"
      ) {
        const table =
          validTable(
            parsed.query.table
          );

        const base =
          getPublicBase(req);

        const target =
          `${base}/?table=${table}`;

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

      /*
       * ==============================
       * 订单统计
       * ==============================
       */

      if (
        req.method === "GET" &&
        pathname === "/api/stats"
      ) {
        if (!authed(req)) {
          return json(res, 401, {
            error: "unauthorized"
          });
        }

        const orders =
          loadOrders();

        const today =
          new Date()
            .toISOString()
            .slice(0, 10);

        const todayOrders =
          orders.filter(
            (x) =>
              x.createdAt &&
              x.createdAt.startsWith(
                today
              )
          );

        const paidOrders =
          orders.filter(
            (x) =>
              x.paymentStatus ===
              "PAID"
          );

        const todayPaid =
          todayOrders.filter(
            (x) =>
              x.paymentStatus ===
              "PAID"
          );

        const completed =
          orders.filter(
            (x) =>
              x.status === "DONE"
          );

        return json(
          res,
          200,
          {
            version: "4.0.0",

            orders:
              orders.length,

            todayOrders:
              todayOrders.length,

            todaySales:
              todayOrders.reduce(
                (sum, x) =>
                  sum +
                  Number(
                    x.total || 0
                  ),
                0
              ),

            todayPaidOrders:
              todayPaid.length,

            todayPaidSales:
              todayPaid.reduce(
                (sum, x) =>
                  sum +
                  Number(
                    x.total || 0
                  ),
                0
              ),

            paidOrders:
              paidOrders.length,

            paidSales:
              paidOrders.reduce(
                (sum, x) =>
                  sum +
                  Number(
                    x.total || 0
                  ),
                0
              ),

            completedOrders:
              completed.length,

            completedSales:
              completed.reduce(
                (sum, x) =>
                  sum +
                  Number(
                    x.total || 0
                  ),
                0
              )
          }
        );
      }

      /*
       * ==============================
       * 静态网页
       * ==============================
       */

      const file =
        safePublicFile(
          pathname
        );

      if (!file) {
        return send(
          res,
          403,
          "text/plain; charset=utf-8",
          "Forbidden"
        );
      }

      fs.readFile(
        file,
        (error, data) => {
          if (error) {
            return send(
              res,
              404,
              "text/plain; charset=utf-8",
              "Not found"
            );
          }

          return send(
            res,
            200,
            contentType(file),
            data
          );
        }
      );
    } catch (error) {
      console.error(
        "SERVER ERROR:",
        error
      );

      return json(
        res,
        500,
        {
          error:
            "服务器内部错误"
        }
      );
    }
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `四季三餐 v4.0: http://localhost:${PORT}`
    );

    console.log(
      "POS payment API: POST /api/pos/payment"
    );
  }
);
```
