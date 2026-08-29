# 四季三餐扫码点餐系统 v3.0

## 这版新增
- 管理员登录
- 订单后台
- 新订单 / 制作中 / 完成 / 删除
- 今日订单、今日营业额统计
- 菜品价格修改、上架/下架
- 堂食 / 打包
- 30桌独立二维码
- 服务器端真实保存订单（orders.json）
- 菜单保存（menu.json）

## 本地测试
安装 Node.js 18+
在本目录打开终端：
npm install
npm start

顾客端：http://localhost:3000/?table=1
后台：http://localhost:3000/admin
默认后台密码：123456

## 部署到公网
推荐使用任意支持 Node.js 的云服务器/云平台。
部署时：
1. 上传整个项目
2. 安装依赖：npm install
3. 启动命令：npm start
4. 平台提供公网 HTTPS 域名后，用这个域名访问顾客端。
5. 设置环境变量 ADMIN_PASSWORD 为你自己的强密码。

注意：当前订单和菜单使用本地 JSON 文件保存。部分云平台的本地磁盘可能会重启后恢复/清空，因此正式营业前建议升级到 PostgreSQL/Supabase 等持久化数据库。
