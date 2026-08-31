const http=require("http"),fs=require("fs"),path=require("path"),url=require("url"),QRCode=require("qrcode"),crypto=require("crypto");
const PORT=process.env.PORT||3000, ROOT=__dirname, DATA=p=>path.join(ROOT,p);
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"123456";
const read=p=>JSON.parse(fs.readFileSync(DATA(p),"utf8")); const write=(p,x)=>fs.writeFileSync(DATA(p),JSON.stringify(x,null,2));
const sessions=new Set();
const send=(res,s,t,b)=>{res.writeHead(s,{"Content-Type":t,"Access-Control-Allow-Origin":"*"});res.end(b)};
const json=(res,s,o)=>send(res,s,"application/json; charset=utf-8",JSON.stringify(o));
const parseBody=req=>new Promise((ok,no)=>{let s="";req.on("data",d=>s+=d);req.on("end",()=>{try{ok(JSON.parse(s||"{}"))}catch(e){no(e)}})});
function authed(req){const c=req.headers.cookie||"";const m=c.match(/sid=([^;]+)/);return m&&sessions.has(m[1])}
const server=http.createServer(async(req,res)=>{
 const u=url.parse(req.url,true), p=u.pathname;
 if(req.method==="GET"&&p==="/api/menu")return json(res,200,read("menu.json").filter(x=>x.on));
 if(req.method==="POST"&&p==="/api/login"){let b=await parseBody(req);if(String(b.password)===ADMIN_PASSWORD){let sid=crypto.randomBytes(20).toString("hex");sessions.add(sid);res.writeHead(200,{"Set-Cookie":`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`,"Content-Type":"application/json"});return res.end('{"ok":true}')}return json(res,401,{error:"密码错误"})}
 if(req.method==="POST"&&p==="/api/logout"){let c=req.headers.cookie||"",m=c.match(/sid=([^;]+)/);if(m)sessions.delete(m[1]);res.writeHead(200,{"Set-Cookie":"sid=; Max-Age=0; Path=/","Content-Type":"application/json"});return res.end('{"ok":true}')}
 if(req.method==="GET"&&p==="/api/orders"){if(!authed(req))return json(res,401,{error:"unauthorized"});return json(res,200,read("orders.json"))}
 if(req.method==="POST"&&p==="/api/orders"){
   try{let b=await parseBody(req), menu=read("menu.json"),items=(b.items||[]).map(x=>{let m=menu.find(z=>z.id===x.id);return m?{id:m.id,name:m.name,kr:m.kr,qty:Math.max(1,Number(x.qty)),price:m.price}:null}).filter(Boolean);
   let total=items.reduce((s,x)=>s+x.price*x.qty,0),orders=read("orders.json");
   let o={id:Date.now().toString(36).toUpperCase(),table:Math.min(30,Math.max(1,Number(b.table)||1)),items,total,note:String(b.note||"").slice(0,200),type:b.type==="TAKEOUT"?"TAKEOUT":"DINE_IN",status:"NEW",createdAt:new Date().toISOString()};
   orders.push(o);write("orders.json",orders);return json(res,201,o)
   }catch(e){return json(res,400,{error:"invalid"})}
 }
 if(req.method==="POST"&&p.startsWith("/api/orders/")&&p.endsWith("/status")){if(!authed(req))return json(res,401,{error:"unauthorized"});let id=p.split("/")[3],b=await parseBody(req),os=read("orders.json"),o=os.find(x=>x.id===id);if(!o)return json(res,404,{error:"not found"});o.status=b.status;write("orders.json",os);return json(res,200,o)}
 if(req.method==="DELETE"&&p.startsWith("/api/orders/")){if(!authed(req))return json(res,401,{error:"unauthorized"});let id=p.split("/")[3],os=read("orders.json").filter(x=>x.id!==id);write("orders.json",os);return json(res,200,{ok:true})}
 if(req.method==="GET"&&p==="/api/menu/all"){if(!authed(req))return json(res,401,{error:"unauthorized"});return json(res,200,read("menu.json"))}
 if(req.method==="POST"&&p==="/api/menu"){
  if(!authed(req))return json(res,401,{error:"unauthorized"});

  let b=await parseBody(req);
  let ms=read("menu.json");

  if(!b.id){
    let item={
      id:"menu-"+Date.now().toString(36),
      name:String(b.name||"新菜品"),
      kr:String(b.kr||""),
      price:Math.max(0,Number(b.price)||0),
      emoji:String(b.emoji||"🍽️"),
      on:b.on!==false
    };

    ms.push(item);
    write("menu.json",ms);

    return json(res,201,item);
  }

  let i=ms.findIndex(x=>x.id===b.id);

  if(i<0)return json(res,404,{error:"not found"});

  ms[i].name=String(b.name||ms[i].name);
  ms[i].kr=String(b.kr||ms[i].kr);
  ms[i].price=Math.max(0,Number(b.price)||0);
  ms[i].emoji=String(b.emoji||ms[i].emoji||"🍽️");
  ms[i].on=!!b.on;

  write("menu.json",ms);

  return json(res,200,ms[i]);
}
 if(req.method==="GET"&&p==="/api/qr"){let table=Math.min(30,Math.max(1,Number(u.query.table)||1)),base=`${req.headers["x-forwarded-proto"]||"http"}://${req.headers.host}`,target=`${base}/?table=${table}`;let svg=await QRCode.toString(target,{type:"svg",margin:2,width:360});return send(res,200,"image/svg+xml; charset=utf-8",svg)}
 if(req.method==="GET"&&p==="/api/stats"){if(!authed(req))return json(res,401,{error:"unauthorized"});let os=read("orders.json"),done=os.filter(x=>x.status==="DONE"),today=new Date().toISOString().slice(0,10),tod=os.filter(x=>x.createdAt.startsWith(today));return json(res,200,{orders:os.length,todayOrders:tod.length,todaySales:tod.reduce((s,x)=>s+x.total,0),doneSales:done.reduce((s,x)=>s+x.total,0)})}
 let file=p==="/"?"/index.html":p==="/admin"?"/admin.html":p; let f=path.join(ROOT,"public",path.normalize(file));
 if(!f.startsWith(path.join(ROOT,"public")))return send(res,403,"text/plain","Forbidden");
fs.readFile(f,(e,d)=>e?send(res,404,"text/plain","Not found"):send(res,200,({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"}[path.extname(f)]||"application/octet-stream"),d));});
server.listen(PORT,()=>console.log(`四季三餐 v3: http://localhost:${PORT}`));
