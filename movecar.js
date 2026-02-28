/**
 * MoveCar 多用户智能挪车系统 - v3.0
 * 优化：30分钟断点续传 + 域名优先级二维码 + 多用户隔离
 * 优化：增加挪车车牌验证（后4位）
 * 优化：增加无定位时，UI展示倒计时30秒，才可发送通知
 * 优化：添加重新获取定位的按钮
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 3600,         // 坐标等数据有效期：1 小时
  SESSION_TTL: 1800,    // 挪车会话有效期：30 分钟 (1800秒)
  RATE_LIMIT_TTL: 60    // 频率限制：60 秒
}

// 添加一个简单的 HTML 转义函数（放在文件顶部或 handleRequest 之前）
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function handleRequest(request) {
  // 安全防护
  const country = request.cf?.country;
  if (country && country !== 'CN') {
    return new Response('Access Denied', { status: 403 });
  }
  
  const url = new URL(request.url)
  const path = url.pathname
  const userParam = url.searchParams.get('u') || 'default';
  const userKey = userParam.toLowerCase();

  // 1. 二维码生成工具
  if (path === '/qr') return renderQRPage(url.origin, userKey);

  // 2. API 路由
  if (path === '/api/notify' && request.method === 'POST') return handleNotify(request, url, userKey);
  if (path === '/api/get-location') return handleGetLocation(userKey);
  if (path === '/api/owner-confirm' && request.method === 'POST') return handleOwnerConfirmAction(request, userKey);
  
  // 查询状态 API (带 Session 校验)
  if (path === '/api/check-status') {
    const s = url.searchParams.get('s');
    return handleCheckStatus(userKey, s);
  }

  // 3. 页面路由
  if (path === '/owner-confirm') return renderOwnerPage(userKey);

  // 默认进入挪车首页
  return renderMainPage(url.origin, userKey);
}

/** 配置读取 **/
function getUserConfig(userKey, envPrefix) {
  const specificKey = envPrefix + "_" + userKey.toUpperCase();
  if (typeof globalThis[specificKey] !== 'undefined') return globalThis[specificKey];
  if (typeof globalThis[envPrefix] !== 'undefined') return globalThis[envPrefix];
  return null;
}

// 坐标转换 (WGS-84 -> GCJ-02)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0; const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: "https://uri.amap.com/marker?position=" + gcj.lng + "," + gcj.lat + "&name=扫码者位置",
    appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=扫码者位置"
  };
}

/** 发送通知逻辑 **/
async function handleNotify(request, url, userKey) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') throw new Error('KV 未绑定');
    const lockKey = "lock_" + userKey;
    const isLocked = await MOVE_CAR_STATUS.get(lockKey);
    if (isLocked) throw new Error('发送频率过快，请一分钟后再试');

    const body = await request.json();
    const sessionId = body.sessionId; 

    const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN');
    const barkUrl = getUserConfig(userKey, 'BARK_URL');
    const email   = getUserConfig(userKey, 'EMAIL');
    const resendApiKey = getUserConfig("", 'RESEND_API_KEY');//直接获取resend全局key，所有用户通用
    const resendFrom = getUserConfig("", 'RESEND_FROM') || 'noreply_huang@xian5.de5.net'; // 默认测试邮箱
    
    const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
    const baseDomain = (typeof globalThis.EXTERNAL_URL !== 'undefined' && globalThis.EXTERNAL_URL) ? globalThis.EXTERNAL_URL.replace(/\/$/, "") : url.origin;
    const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey;

    let notifyText = "🚗 挪车请求【" + carTitle + "】\\n💬 留言: " + (body.message || '车旁有人等待');
    
    // 存储当前会话信息，有效期设为 30 分钟
    const statusData = { status: 'waiting', sessionId: sessionId };
    
    let maps = null;
    if (body.location && body.location.lat) {
      maps = generateMapUrls(body.location.lat, body.location.lng);
      await MOVE_CAR_STATUS.put("loc_" + userKey, JSON.stringify({ ...body.location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
    }

    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusData), { expirationTtl: CONFIG.SESSION_TTL });
    await MOVE_CAR_STATUS.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

    const tasks = [];
    if (ppToken) tasks.push(fetch('http://www.pushplus.plus/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ppToken, title: "🚗 挪车请求：" + carTitle, content: notifyText.replace(/\\n/g, '<br>') + '<br><br><a href="' + confirmUrl + '" style="font-size:18px;color:#0093E9">【点击处理】</a>', template: 'html' }) }));
    if (barkUrl) tasks.push(fetch(barkUrl + "/" + encodeURIComponent('挪车请求') + "/" + encodeURIComponent(notifyText) + "?url=" + encodeURIComponent(confirmUrl)));
    // 待增加邮件推送
    // if (email) tasks.push()
    if (email && resendApiKey) {
        // 构造邮件 HTML 内容（转义用户输入）
      const escapedMessage = escapeHtml(body.message || '车旁有人等待');
      let locationHtml = '';
      if (maps) {
        locationHtml = `<p><strong>扫码者位置：</strong><br>
          <a href="${maps.amapUrl}">高德地图</a> | 
          <a href="${maps.appleUrl}">苹果地图</a></p>`;
      }
      const mailHtml = `
        <h2>🚗 挪车请求【${carTitle}】</h2>
        <p><strong>留言：</strong>${escapedMessage}</p>
        ${locationHtml}
        <p><a href="${confirmUrl}" style="display:inline-block; padding:10px 20px; background:#0093E9; color:#fff; text-decoration:none; border-radius:5px;">点击处理挪车</a></p>
      `;
      tasks.push(
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: resendFrom,
            to: [email],
            subject: `挪车请求：${carTitle}`,
            html: mailHtml
          })
        }).catch(e => console.error('Resend error:', e))
      );
    }
    await Promise.all(tasks);
    return new Response(JSON.stringify({ success: true }));
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleCheckStatus(userKey, clientSessionId) {
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (!data) return new Response(JSON.stringify({ status: 'none' }));

  const statusObj = JSON.parse(data);
  if (statusObj.sessionId !== clientSessionId) {
    return new Response(JSON.stringify({ status: 'none' }));
  }

  const ownerLoc = await MOVE_CAR_STATUS.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({ 
    status: statusObj.status, 
    ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null 
  }));
}

async function handleGetLocation(userKey) {
  const data = await MOVE_CAR_STATUS.get("loc_" + userKey);
  return new Response(data || '{}');
}
/**
async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (data) {
    const statusObj = JSON.parse(data);
    statusObj.status = 'confirmed';
    if (body.location) {
      const urls = generateMapUrls(body.location.lat, body.location.lng);
      await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: 600 });
    }
    // 确认后状态继续保持，直到 SESSION_TTL 到期
    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusObj), { expirationTtl: 600 });
  }
  return new Response(JSON.stringify({ success: true }));
}
**/
// 增强版的车主回应函数
async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  const data = await MOVE_CAR_STATUS.get("status_" + userKey);
  if (data) {
    const statusObj = JSON.parse(data);
    statusObj.status = 'confirmed';
    // 准备车主信息对象
    let ownerInfo = {};
    if (body.location) {
      const urls = generateMapUrls(body.location.lat, body.location.lng);
      ownerInfo = { ...body.location, ...urls };
    }
    if (body.replyMessage) {
      ownerInfo.replyMessage = body.replyMessage;
    }
    await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify(ownerInfo), { expirationTtl: 600 });
    await MOVE_CAR_STATUS.put("status_" + userKey, JSON.stringify(statusObj), { expirationTtl: 600 });
  }
  return new Response(JSON.stringify({ success: true }));
}

/** 功能：二维码生成工具页 **/
function renderQRPage(origin, userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  let baseDomain = (typeof globalThis.EXTERNAL_URL !== 'undefined' && globalThis.EXTERNAL_URL) ? globalThis.EXTERNAL_URL.replace(/\/$/, "") : origin;
  const targetUrl = baseDomain + "/?u=" + userKey;
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>制作挪车码</title>
  <style>
    body { font-family: sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .qr-card { background: white; padding: 40px 20px; border-radius: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.05); text-align: center; width: 90%; max-width: 380px; }
    .qr-img { width: 250px; height: 250px; margin: 25px auto; border: 1px solid #f1f5f9; padding: 8px; border-radius: 12px; }
    .btn { display: block; background: #0093E9; color: white; text-decoration: none; padding: 16px; border-radius: 16px; font-weight: bold; margin-top: 20px; }
    .url-info { font-size: 11px; color: #cbd5e1; margin-top: 15px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="qr-card">
    <h2 style="color:#1e293b">${carTitle} 的专属挪车码</h2>
    <p style="color:#64748b; font-size:14px; margin-top:8px">扫码通知，保护隐私</p>
    <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=450x450&data=${encodeURIComponent(targetUrl)}">
    <a href="javascript:window.print()" class="btn">🖨️ 立即打印挪车牌</a>
    <div class="url-info">${targetUrl}</div>
  </div>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：扫码者页 **/
function renderMainPage(origin, userKey) {
  const phone = getUserConfig(userKey, 'PHONE_NUMBER') || '';
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主A888';
  const phoneHtml = phone ? '<a href="tel:' + phone + '" class="btn-phone">📞 拨打车主电话</a>' : '';
  
  // 提取后四位
  const lastFour = carTitle.length >= 4 ? carTitle.slice(-4) : carTitle;
  const needVerify = (carTitle !== '车主' && carTitle.length >= 4);

  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>挪车通知</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }
    .card { background: white; border-radius: 24px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
    .header { text-align: center; }
    .icon-wrap { width: 64px; height: 64px; background: #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 32px; color: white; }
    textarea { width: 100%; min-height: 90px; border: 1px solid #eee; border-radius: 14px; padding: 15px; font-size: 16px; outline: none; margin-top: 10px; background:#fcfcfc; resize:none; }
    .tag { display: inline-block; background: #f1f5f9; padding: 10px 16px; border-radius: 20px; font-size: 14px; margin: 5px 3px; cursor: pointer; color:#475569; }
    .btn-main { background: #0093E9; color: white; border: none; padding: 18px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; }
    .btn-main:disabled { background: #94a3b8; cursor: not-allowed; }
    .btn-phone { background: #ef4444; color: white; border: none; padding: 15px; border-radius: 15px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 10px; }
    .btn-retry { background: #f59e0b; color: white; border: none; padding: 8px 16px; border-radius: 20px; font-size: 13px; cursor: pointer; margin-left: 10px; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 14px; border-radius: 14px; text-align: center; text-decoration: none; color: white; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
    /* 验证码输入框样式 */
    .code-inputs { display: flex; justify-content: center; gap: 10px; margin: 20px 0; }
    .code-inputs input { width: 60px; height: 70px; text-align: center; font-size: 32px; font-weight: bold; border: 2px solid #e2e8f0; border-radius: 12px; outline: none; transition: border 0.2s; background: #f8fafc; }
    .code-inputs input:focus { border-color: #0093E9; }
    .error-msg { color: #ef4444; font-size: 14px; min-height: 20px; }
    .verify-btn { background: #10b981; color: white; border: none; padding: 16px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
    /* 定位状态行布局 */
    .loc-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .loc-text { font-size: 13px; color: #94a3b8; }
    .countdown-msg { font-size: 14px; color: #f97316; text-align: center; margin: 8px 0; min-height: 24px; background-color: #fff3e0; padding: 6px 12px; border-radius: 20px; font-weight: 500; display: none; } /* 默认隐藏 */
  </style>
</head>
<body>
  <!-- 验证界面 -->
  <div class="container" id="verifyView" ${needVerify ? '' : 'style="display:none"'}>
    <div class="card">
      <div class="icon-wrap">🔐</div>
      <h2 style="color:#1e293b">验证车牌</h2>
      <p style="color:#64748b; margin-top:5px">请输入车牌号后四位</p>
      <div class="code-inputs" id="codeInputs">
        <input type="text" maxlength="1" pattern="[A-Za-z0-9]" class="code-digit" inputmode="text" autofocus>
        <input type="text" maxlength="1" pattern="[A-Za-z0-9]" class="code-digit" inputmode="text">
        <input type="text" maxlength="1" pattern="[A-Za-z0-9]" class="code-digit" inputmode="text">
        <input type="text" maxlength="1" pattern="[A-Za-z0-9]" class="code-digit" inputmode="text">
      </div>
      <div class="error-msg" id="verifyError"></div>
      <button class="verify-btn" id="verifyBtn">验证</button>
    </div>
  </div>

  <!-- 主界面 -->
  <div class="container ${needVerify ? 'hidden' : ''}" id="mainView">
    <div class="card header">
      <div class="icon-wrap">🚗</div>
      <h2 style="color:#1e293b">呼叫 ${carTitle}</h2>
      <p style="color:#64748b; font-size:14px; margin-top:5px">提示：车主将收到即时提醒</p>
    </div>
    <div class="card">
      <textarea id="msgInput" placeholder="请输入留言...\n(获取定位后通知，车主回复更快哦！)"></textarea>
      <div style="margin-top:5px">
        <div class="tag" onclick="setTag('麻烦挪下车，谢谢')">🚧 挡路了</div>
        <div class="tag" onclick="setTag('有急事外出，速来')">🏃 急事</div>
        <div class="tag" onclick="setTag('有叔叔贴条，速度来挪车！')">⏱️ 温馨提醒</div>
        <div class="tag" onclick="setTag('请挪车，我在你车旁，请查看位置，尽快前来！')">🏃 发送我的位置</div>
        <div class="tag" onclick="setTag('这是我的车位，我要用了，谢谢')">🚧 占我车位</div>
      </div>
    </div>
    <!-- 定位状态卡片，增加重试按钮 -->
    <div class="card" id="locStatusCard">
      <div class="loc-row">
        <span class="loc-text" id="locStatus">定位请求中...</span>
        <button id="retryLocationBtn" class="btn-retry" style="display:none;" onclick="retryLocation()">重新获取</button>
      </div>
    </div>
    <!-- 倒计时显示区域（默认隐藏） -->
    <div class="countdown-msg" id="countdownMsg"></div>
    <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 发送通知</button>
  </div>

  <!-- 成功界面 -->
  <div class="container hidden" id="successView">
    <div class="card" style="text-align:center">
      <div style="font-size:64px; margin-bottom:15px">📧</div>
      <h2 style="color:#1e293b">通知已送达</h2>
      <p style="color:#64748b">车主已收到挪车请求，请在车旁稍候</p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center; border: 2.5px solid #10b981;">
      <div style="font-size:40px">👨‍✈️</div>
      <h3 id="ownerReplyMsg" style="color:#059669">车主回复：马上到</h3>
      <div class="map-links">
        <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-main" style="background:#f59e0b; margin-top:10px;" onclick="location.reload()">🔄 刷新状态</button>
      ${phoneHtml}
    </div>
  </div>

  <script>
    let userLoc = null;
    const userKey = "${userKey}";
    const correctLastFour = "${lastFour}";
    const needVerify = ${needVerify ? 'true' : 'false'};
    
    // 定位就绪标志及倒计时
    let locationReady = false;
    let countdown = 30;
    let countdownInterval = null;

    // 会话持久化
    let sessionId = localStorage.getItem('movecar_session_' + userKey);
    if (!sessionId) {
      sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('movecar_session_' + userKey, sessionId);
    }

    // 验证状态持久化（刷新页面后不再重复验证）
    const verifiedFlag = 'verified_' + userKey;
    let isVerified = sessionStorage.getItem(verifiedFlag) === 'true';

    if (!needVerify) {
      initializeMainView();
    } else {
      if (isVerified) {
        // 已经验证过，直接显示主界面
        document.getElementById('verifyView').style.display = 'none';
        document.getElementById('mainView').classList.remove('hidden');
        initializeMainView();
      } else {
        initializeVerifyView();
      }
    }

    // 验证界面初始化
    function initializeVerifyView() {
      const inputs = document.querySelectorAll('.code-digit');
      const verifyBtn = document.getElementById('verifyBtn');
      const errorDiv = document.getElementById('verifyError');

      inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          if (e.target.value && index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && index > 0) {
            inputs[index - 1].focus();
          }
        });
        input.addEventListener('paste', (e) => e.preventDefault());
      });

      verifyBtn.addEventListener('click', () => {
        const code = Array.from(inputs).map(i => i.value).join('');
        if (code.length !== 4) {
          errorDiv.textContent = '请输入四位验证码';
          return;
        }
        if (code.toUpperCase() === correctLastFour.toUpperCase()) {
          // 验证成功，存储标记
          sessionStorage.setItem(verifiedFlag, 'true');
          document.getElementById('verifyView').style.display = 'none';
          document.getElementById('mainView').classList.remove('hidden');
          initializeMainView();
        } else {
          errorDiv.textContent = '验证码错误，请重新输入';
          inputs.forEach(i => i.value = '');
          inputs[0].focus();
        }
      });

      inputs.forEach(input => {
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') verifyBtn.click();
        });
      });
    }

    // 主界面初始化
    async function initializeMainView() {
      // 先检查是否有活跃会话
      const hasActiveSession = await checkActiveSession();
      if (hasActiveSession) {
        // 已有活跃会话，直接显示成功界面，跳过后续定位请求
        console.log('检测到活跃会话，跳过定位请求');
        return;
      }

      // 无活跃会话，继续正常的定位初始化
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      countdown = 30;
      locationReady = false;
      
      // 隐藏倒计时提示
      const msgDiv = document.getElementById('countdownMsg');
      if (msgDiv) msgDiv.style.display = 'none';
      
      // 隐藏重试按钮
      const retryBtn = document.getElementById('retryLocationBtn');
      if (retryBtn) retryBtn.style.display = 'none';

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          // 成功回调
          p => {
            userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
            locationReady = true;
            document.getElementById('locStatus').innerText = '📍 位置已锁定(获取成功)';
            document.getElementById('locStatus').style.color = '#10b981';
            
            // 清除倒计时
            if (countdownInterval) {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            // 隐藏倒计时提示
            const msgDiv = document.getElementById('countdownMsg');
            if (msgDiv) msgDiv.style.display = 'none';
            
            // 隐藏重试按钮
            const retryBtn = document.getElementById('retryLocationBtn');
            if (retryBtn) retryBtn.style.display = 'none';
            
            // 启用通知按钮
            document.getElementById('notifyBtn').disabled = false;
          },
          // 失败回调
          err => {
            console.warn('定位失败:', err);
            document.getElementById('locStatus').innerText = '📍 无法获取精确位置';
            document.getElementById('locStatus').style.color = '#ef4444';
            
            // 显示重试按钮
            const retryBtn = document.getElementById('retryLocationBtn');
            if (retryBtn) retryBtn.style.display = 'inline-block';
            
            if (!locationReady && !countdownInterval) {
              startCountdown();
            }
          },
          { timeout: 10000 }
        );
      } else {
        document.getElementById('locStatus').innerText = '📍 浏览器不支持定位';
        document.getElementById('locStatus').style.color = '#ef4444';
        
        // 显示重试按钮（虽然不支持定位，但点击重试也不会改变，但可以保留提示）
        const retryBtn = document.getElementById('retryLocationBtn');
        if (retryBtn) retryBtn.style.display = 'inline-block';
        
        if (!locationReady && !countdownInterval) {
          startCountdown();
        }
      }
    }

    // 启动倒计时
    function startCountdown() {
      countdown = 30;
      const btn = document.getElementById('notifyBtn');
      const msgDiv = document.getElementById('countdownMsg');
      
      if (!msgDiv) return; // 安全起见
      
      // 显示倒计时区域
      msgDiv.style.display = 'block';
      btn.disabled = true;
      msgDiv.innerText = \`定位获取失败，等待 \${countdown} 秒后可发送\`;

      countdownInterval = setInterval(() => {
        countdown--;
        console.log('倒计时:', countdown);
        if (countdown <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          btn.disabled = false;
          msgDiv.innerText = '现在可以发送通知（位置未获取）';
          // 倒计时结束后，仍然显示重试按钮（如果之前显示了）
        } else {
          msgDiv.innerText = \`定位获取失败，等待 \${countdown} 秒后可发送\`;
        }
      }, 1000);
    }

    // 重试获取位置
    function retryLocation() {
      if (!navigator.geolocation) {
        alert('浏览器不支持定位功能');
        return;
      }
      
      // 显示重试中状态
      const retryBtn = document.getElementById('retryLocationBtn');
      retryBtn.disabled = true;
      retryBtn.innerText = '获取中...';
      
      navigator.geolocation.getCurrentPosition(
        p => {
          // 成功
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          locationReady = true;
          document.getElementById('locStatus').innerText = '📍 位置已锁定(获取成功)';
          document.getElementById('locStatus').style.color = '#10b981';
          
          // 清除倒计时
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          // 隐藏倒计时提示
          const msgDiv = document.getElementById('countdownMsg');
          if (msgDiv) msgDiv.style.display = 'none';
          
          // 隐藏重试按钮
          retryBtn.style.display = 'none';
          
          // 启用通知按钮
          document.getElementById('notifyBtn').disabled = false;
          
          // 恢复按钮文字
          retryBtn.disabled = false;
          retryBtn.innerText = '重新获取';
        },
        err => {
          console.warn('重试定位失败:', err);
          alert('再次获取位置失败，请稍后重试或等待倒计时结束');
          // 恢复按钮
          retryBtn.disabled = false;
          retryBtn.innerText = '重新获取';
          // 如果倒计时未启动，可能需要启动？
          if (!locationReady && !countdownInterval) {
            startCountdown();
          }
        },
        { timeout: 10000 }
      );
    }

    // 检查活跃会话，返回 true 表示有活跃会话并已显示成功界面
    async function checkActiveSession() {
      try {
        const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
        const data = await res.json();
        if (data.status && data.status !== 'none') {
          console.log('检测到活跃会话，状态:', data.status);
          showSuccess(data);
          pollStatus();
          return true;
        }
      } catch(e) {
        console.warn('检查会话失败', e);
      }
      return false;
    }

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      
      // 位置未就绪且倒计时未结束，阻止发送
      if (!locationReady && countdown > 0) {
        alert(\`尚未获取到您的位置，请给定位权限，或等待 \${countdown} 秒后再试\`);
        return;
      }

      btn.disabled = true; btn.innerText = '正在联络车主...';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ 
            message: document.getElementById('msgInput').value, 
            location: userLoc,
            sessionId: sessionId 
          })
        });
        const data = await res.json();
        if (data.success) {
          showSuccess({status: 'waiting'});
          pollStatus();
        } else { 
          alert(data.error); 
          btn.disabled = false; 
          btn.innerText = '🔔 发送通知'; 
        }
      } catch(e) { 
        alert('服务暂时不可用'); 
        btn.disabled = false; 
      }
    }

    function showSuccess(data) {
      document.getElementById('mainView').classList.add('hidden');
      document.getElementById('successView').classList.remove('hidden');
      updateUI(data);
    }

    function updateUI(data) {
      console.log('updateUI called with data:', data);
      if (data.status === 'confirmed') {
        document.getElementById('ownerFeedback').classList.remove('hidden');
        const replyMsg = data.ownerLocation?.replyMessage || '车主已确认，马上到';
        document.getElementById('ownerReplyMsg').innerText = '车主回复：' + replyMsg;
        if (data.ownerLocation) {
          document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl || '#';
          document.getElementById('ownerApple').href = data.ownerLocation.appleUrl || '#';
          console.log('设置车主位置链接:', data.ownerLocation);
        } else {
          console.log('车主位置为空');
        }
      }
    }

    function pollStatus() {
      // 清除可能存在的旧轮询
      if (window.pollInterval) clearInterval(window.pollInterval);
      window.pollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
          const data = await res.json();
          updateUI(data);
        } catch(e) {
          console.warn('轮询失败', e);
        }
      }, 5000);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：车主页 **/
function renderOwnerPage(userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>挪车处理</title>
  <style>
    body { font-family: sans-serif; background: #4f46e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin:0; padding:20px; }
    .card { background: white; padding: 35px 25px; border-radius: 30px; text-align: center; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
    .btn { background: #10b981; color: white; border: none; width: 100%; padding: 20px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; margin-top: 20px; box-shadow: 0 5px 15px rgba(16,185,129,0.3); }
    .btn-secondary { background: #6b7280; }
    .map-box { background: #f8fafc; padding: 20px; border-radius: 20px; margin-top: 15px; border: 1px solid #e2e8f0; display: none; }
    .map-btn { display: inline-block; padding: 12px 18px; background: #2563eb; color: white; text-decoration: none; border-radius: 12px; margin: 5px; font-size: 14px; }
    .reply-section { margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    .fold-btn { background: #e2e8f0; color: #1e293b; border: none; padding: 10px; border-radius: 30px; font-size: 14px; cursor: pointer; width: 100%; margin-bottom: 10px; }
    .fold-content { display: none; }
    .textarea-reply { width: 100%; min-height: 80px; border: 1px solid #ccc; border-radius: 14px; padding: 12px; font-size: 16px; margin-top: 10px; resize: vertical; }
    .tag { display: inline-block; background: #f1f5f9; padding: 8px 12px; border-radius: 20px; font-size: 14px; margin: 5px 3px; cursor: pointer; color:#475569; }
    .tag:hover { background: #e2e8f0; }
    .btn-send { background: #2563eb; color: white; border: none; padding: 16px; border-radius: 18px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:50px">📣</div>
    <h2 style="margin:15px 0; color:#1e293b">${carTitle}</h2>
    <p style="color:#64748b">有人正在车旁等您，请确认：</p>
    <div id="mapArea" class="map-box">
      <p style="font-size:14px; color:#2563eb; margin-bottom:12px; font-weight:bold">对方实时位置 📍</p>
      <a id="amapLink" href="#" class="map-btn">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000">苹果地图</a>
    </div>

    <!-- 默认按钮 -->
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 我已知晓，马上过去</button>

    <!-- 折叠按钮和区域 -->
    <div class="reply-section">
      <button id="foldBtn" class="fold-btn" onclick="toggleFold()">✏️ 发送其他回复</button>
      <div id="foldContent" class="fold-content">
        <textarea id="customReply" class="textarea-reply" placeholder="请输入您的回复..."></textarea>
        <div style="margin-top:5px">
          <span class="tag" onclick="setReplyTag('定位错误，请确认')">🚫 定位错误</span>
          <span class="tag" onclick="setReplyTag('暂时无法离开，稍后')">⏳ 暂时无法离开</span>
          <span class="tag" onclick="setReplyTag('请稍等，马上到')">🏃 马上到</span>
          <span class="tag" onclick="setReplyTag('请拨打联系电话')">📞 拨打电话</span>
        </div>
        <button id="sendCustomBtn" class="btn-send" onclick="sendCustomReply()">📨 发送回复</button>
      </div>
    </div>
  </div>
  <script>
    const userKey = "${userKey}";
    let foldOpen = false;

    window.onload = async () => {
      // 获取扫码者位置
      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };

    // 切换折叠
    function toggleFold() {
      foldOpen = !foldOpen;
      document.getElementById('foldContent').style.display = foldOpen ? 'block' : 'none';
      document.getElementById('foldBtn').innerText = foldOpen ? '🔽 收起' : '✏️ 发送其他回复';
    }

    // 设置快捷回复到文本框
    function setReplyTag(text) {
      document.getElementById('customReply').value = text;
    }

    // 获取车主位置并发送确认（带回复）
    async function sendConfirmWithReply(replyMessage) {
      const btn = event?.target || document.getElementById('confirmBtn');
      const originalText = btn.innerText;
      btn.disabled = true;
      btn.innerText = '发送中...';

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          async p => {
            const location = { lat: p.coords.latitude, lng: p.coords.longitude };
            await sendConfirmRequest(location, replyMessage);
            btn.disabled = false;
            btn.innerText = originalText;
          },
          async () => {
            // 无法获取位置，仍发送（不带位置）
            await sendConfirmRequest(null, replyMessage);
            btn.disabled = false;
            btn.innerText = originalText;
          }
        );
      } else {
        // 不支持定位
        await sendConfirmRequest(null, replyMessage);
        btn.disabled = false;
        btn.innerText = originalText;
      }
    }

    // 发送确认请求到后端
    async function sendConfirmRequest(location, replyMessage) {
      try {
        const res = await fetch('/api/owner-confirm?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ location, replyMessage })
        });
        const data = await res.json();
        if (data.success) {
          alert('回复已发送');
          if (foldOpen) toggleFold(); // 发送成功后自动收起
        } else {
          alert('发送失败，请重试');
        }
      } catch (e) {
        alert('网络错误');
      }
    }

    // 默认的“我已知晓马上过去”按钮调用
    function confirmMove() {
      sendConfirmWithReply('马上到');
    }

    // 自定义回复发送
    function sendCustomReply() {
      const reply = document.getElementById('customReply').value.trim();
      if (!reply) {
        alert('请输入回复内容');
        return;
      }
      sendConfirmWithReply(reply);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/**
function renderMainPage(origin, userKey) {
  const phone = getUserConfig(userKey, 'PHONE_NUMBER') || '';
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  const phoneHtml = phone ? '<a href="tel:' + phone + '" class="btn-phone">📞 拨打车主电话</a>' : '';

  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>挪车通知</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }
    .card { background: white; border-radius: 24px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
    .header { text-align: center; }
    .icon-wrap { width: 64px; height: 64px; background: #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 32px; color: white; }
    textarea { width: 100%; min-height: 90px; border: 1px solid #eee; border-radius: 14px; padding: 15px; font-size: 16px; outline: none; margin-top: 10px; background:#fcfcfc; resize:none; }
    .tag { display: inline-block; background: #f1f5f9; padding: 10px 16px; border-radius: 20px; font-size: 14px; margin: 5px 3px; cursor: pointer; color:#475569; }
    .btn-main { background: #0093E9; color: white; border: none; padding: 18px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; }
    .btn-phone { background: #ef4444; color: white; border: none; padding: 15px; border-radius: 15px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 10px; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 14px; border-radius: 14px; text-align: center; text-decoration: none; color: white; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
  </style>
</head>
<body>
  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap">🚗</div>
      <h2 style="color:#1e293b">呼叫 ${carTitle}</h2>
      <p style="color:#64748b; font-size:14px; margin-top:5px">提示：车主将收到即时提醒</p>
    </div>
    <div class="card">
      <textarea id="msgInput" placeholder="请输入留言...（留言后一分钟内没收到车主回信，再拨打电话提醒哦！）"></textarea>
      <div style="margin-top:5px">
        <div class="tag" onclick="setTag('麻烦挪下车，谢谢')">🚧 挡路了</div>
        <div class="tag" onclick="setTag('有急事外出，速来')">🏃 急事</div>
        <div class="tag" onclick="setTag('有叔叔贴条，速度来挪车！')">⏱️ 温馨提醒</div>
        <div class="tag" onclick="setTag('请挪车，我在你车旁，请查看位置，尽快前来！')">🏃 发送我的位置</div>
        <div class="tag" onclick="setTag('这是我的车位，我要用了，谢谢')">🚧 占我车位</div>
      </div>
    </div>
    <div class="card" id="locStatus" style="font-size:13px; color:#94a3b8; text-align:center;">定位请求中...</div>
    <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 发送通知</button>
  </div>

  <div class="container hidden" id="successView">
    <div class="card" style="text-align:center">
      <div style="font-size:64px; margin-bottom:15px">📧</div>
      <h2 style="color:#1e293b">通知已送达</h2>
      <p style="color:#64748b">车主已收到挪车请求，请在车旁稍候</p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center; border: 2.5px solid #10b981;">
      <div style="font-size:40px">👨‍✈️</div>
      <h3 style="color:#059669">车主回复：马上到</h3>
      <div class="map-links">
        <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-main" style="background:#f59e0b; margin-top:10px;" onclick="location.reload()">🔄 刷新状态</button>
      ${phoneHtml}
    </div>
  </div>

  <script>
    let userLoc = null;
    const userKey = "${userKey}";
    
    // 会话持久化
    let sessionId = localStorage.getItem('movecar_session_' + userKey);
    if (!sessionId) {
      sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('movecar_session_' + userKey, sessionId);
    }

    window.onload = async () => {
      checkActiveSession();
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          document.getElementById('locStatus').innerText = '📍 位置已锁定';
          document.getElementById('locStatus').style.color = '#10b981';
        }, () => {
          document.getElementById('locStatus').innerText = '📍 无法获取精确位置';
        });
      }
    };

    async function checkActiveSession() {
      try {
        const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
        const data = await res.json();
        if (data.status && data.status !== 'none') {
          showSuccess(data);
          pollStatus();
        }
      } catch(e){}
    }

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerText = '正在联络车主...';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ 
            message: document.getElementById('msgInput').value, 
            location: userLoc,
            sessionId: sessionId 
          })
        });
        const data = await res.json();
        if (data.success) {
          showSuccess({status: 'waiting'});
          pollStatus();
        } else { alert(data.error); btn.disabled = false; btn.innerText = '🔔 发送通知'; }
      } catch(e) { alert('服务暂时不可用'); btn.disabled = false; }
    }

    function showSuccess(data) {
      document.getElementById('mainView').classList.add('hidden');
      document.getElementById('successView').classList.remove('hidden');
      updateUI(data);
    }

    function updateUI(data) {
      if (data.status === 'confirmed') {
        document.getElementById('ownerFeedback').classList.remove('hidden');
        if (data.ownerLocation) {
          document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl;
          document.getElementById('ownerApple').href = data.ownerLocation.appleUrl;
        }
      }
    }

    function pollStatus() {
      setInterval(async () => {
        try {
          const res = await fetch('/api/check-status?u=' + userKey + '&s=' + sessionId);
          const data = await res.json();
          updateUI(data);
        } catch(e){}
      }, 5000);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// 界面渲染：车主页
function renderOwnerPage(userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>挪车处理</title>
  <style>
    body { font-family: sans-serif; background: #4f46e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin:0; padding:20px; }
    .card { background: white; padding: 35px 25px; border-radius: 30px; text-align: center; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
    .btn { background: #10b981; color: white; border: none; width: 100%; padding: 20px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; margin-top: 20px; box-shadow: 0 5px 15px rgba(16,185,129,0.3); }
    .map-box { display: none; background: #f8fafc; padding: 20px; border-radius: 20px; margin-top: 15px; border: 1px solid #e2e8f0; }
    .map-btn { display: inline-block; padding: 12px 18px; background: #2563eb; color: white; text-decoration: none; border-radius: 12px; margin: 5px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:50px">📣</div>
    <h2 style="margin:15px 0; color:#1e293b">${carTitle}</h2>
    <p style="color:#64748b">有人正在车旁等您，请确认：</p>
    <div id="mapArea" class="map-box">
      <p style="font-size:14px; color:#2563eb; margin-bottom:12px; font-weight:bold">对方实时位置 📍</p>
      <a id="amapLink" href="#" class="map-btn">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000">苹果地图</a>
    </div>
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 我已知晓，马上过去</button>
  </div>
  <script>
    const userKey = "${userKey}";
    window.onload = async () => {
      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };
    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      btn.innerText = '已告知对方 ✓'; btn.disabled = true; btn.style.background = '#94a3b8';
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async p => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: {lat: p.coords.latitude, lng: p.coords.longitude} }) });
        }, async () => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null }) });
        });
      }
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
**/
