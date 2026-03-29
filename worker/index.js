// 内嵌前端页面的 Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // ========== OAuth 路由 ==========
    if (url.pathname === '/auth/google') {
      return handleAuthGoogle(request, env);
    }
    if (url.pathname === '/auth/callback') {
      return handleAuthCallback(request, env);
    }
    if (url.pathname === '/auth/logout') {
      return handleAuthLogout(request, env);
    }
    if (url.pathname === '/auth/me') {
      return handleAuthMe(request, env);
    }

    // ========== 账号中心 ==========
    if (url.pathname === '/account' || url.pathname === '/account/') {
      return handleAccount(request, env);
    }

    // API: 用户状态（登录状态 + 订阅 + 额度）
    if (url.pathname === '/api/user/status' && request.method === 'GET') {
      return handleUserStatus(request, env);
    }

    // ========== 现有的 API 路由 ==========
    // API: 生成图片（直接返回二进制）
    if (url.pathname === '/api/generate-image' && request.method === 'POST') {
      return handleGenerateImage(request, env);
    }

    // API: 生成（返回 JSON）
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    // API: 额度
    if (url.pathname === '/api/quota' && request.method === 'GET') {
      return handleQuota(request, env);
    }

    // 根路径返回 HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ==========================================
// Google OAuth 登录
// ==========================================

const GOOGLE_CLIENT_ID = '957308333828-s9c0n3s00soq3nma4mutir9o5smjl0pp.apps.googleusercontent.com';
// REDIRECT_URI 动态设置（根据请求 origin）
function getRedirectUri(request) {
  const origin = new URL(request.url).origin;
  return `${origin}/auth/callback`;
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return Array.from(values).map(v => chars[v % chars.length]).join('');
}

async function sha256Base64Url(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Step 1: 跳转到 Google 授权页
async function handleAuthGoogle(request, env) {
  const codeVerifier = generateRandomString(128);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateRandomString(32);
  const redirectUri = getRedirectUri(request);

  // 临时存储 code_verifier（10分钟有效期）
  await env.QUOTA_KV.put(`oauth_verifier:${state}`, codeVerifier, { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
    prompt: 'select_account',
  });

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

// Step 2: Google 回调，处理 code 换 token
async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const redirectUri = getRedirectUri(request);

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // 取回 code_verifier
  const codeVerifier = await env.QUOTA_KV.get(`oauth_verifier:${state}`, 'text');
  if (!codeVerifier) {
    return new Response('OAuth state expired or invalid. Please try logging in again.', { status: 400 });
  }
  await env.QUOTA_KV.delete(`oauth_verifier:${state}`);

  // 用 code + verifier 换 token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code: code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('Token exchange error:', errText);
    return new Response(`Token exchange failed: ${errText}`, { status: 500 });
  }

  const tokens = await tokenRes.json();
  const accessToken = tokens.access_token;
  const idToken = tokens.id_token;

  // 用 access_token 获取用户信息
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const userInfo = await userInfoRes.json();

  // 生成 session token（随机字符串）
  const sessionToken = generateRandomString(64);
  // 检查用户是否已订阅 Pro（从 KV 读取）
  const userData = await env.QUOTA_KV.get(`user:${userInfo.sub}`, 'json');
  const sessionData = {
    sub: userInfo.sub,
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    isPro: userData?.isPro || false,
    loggedInAt: Date.now(),
  };

  // 存 session 到 KV（7天有效期）
  await env.QUOTA_KV.put(`session:${sessionToken}`, JSON.stringify(sessionData), { expirationTtl: 604800 });

  // 清理 URL 并重定向到首页，顺便带上 session token
  return Response.redirect(`${redirectUri.replace('/auth/callback', '')}/?session=${sessionToken}`, 302);
}

// 退出登录
async function handleAuthLogout(request, env) {
  const url = new URL(request.url);
  const sessionToken = url.searchParams.get('token');

  if (sessionToken) {
    await env.QUOTA_KV.delete(`session:${sessionToken}`);
  }

  return Response.redirect('/', 302);
}

// 获取当前登录用户
async function handleAuthMe(request, env) {
  const sessionToken = new URL(request.url).searchParams.get('token');
  if (!sessionToken) {
    return jsonResponse({ loggedIn: false });
  }

  const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
  if (!sessionData) {
    return jsonResponse({ loggedIn: false });
  }

  return jsonResponse({ loggedIn: true, user: JSON.parse(sessionData) });
}

// ==========================================
// 账号中心 & 用户状态
// ==========================================

async function handleUserStatus(request, env) {
  const sessionToken = new URL(request.url).searchParams.get('token');
  if (!sessionToken) {
    return jsonResponse({ loggedIn: false });
  }

  const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
  if (!sessionData) {
    return jsonResponse({ loggedIn: false });
  }

  const user = JSON.parse(sessionData);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const quota = await checkQuota(ip, env);

  return jsonResponse({
    loggedIn: true,
    user: {
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      isPro: user.isPro || false,
    },
    quota: {
      remaining: quota.remaining,
      isUnlimited: user.isPro || false,
    }
  });
}

async function handleAccount(request, env) {
  const sessionToken = new URL(request.url).searchParams.get('token');
  let user = null;
  let isLoggedIn = false;
  let quota = { remaining: 10 };

  if (sessionToken) {
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (sessionData) {
      user = JSON.parse(sessionData);
      isLoggedIn = true;
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      quota = await checkQuota(ip, env);
    }
  }

  const userJson = JSON.stringify({
    loggedIn: isLoggedIn,
    user: user ? { sub: user.sub, email: user.email, name: user.name, picture: user.picture, isPro: user.isPro || false } : null,
    quota,
  });

  return new Response(ACCOUNT_HTML.replace('__USER_DATA__', userJson), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ==========================================
// 现有的生成和额度逻辑
// ==========================================

async function handleGenerate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  
  const quota = await checkQuota(ip, env);
  if (quota.remaining <= 0) {
    return jsonResponse({ error: 'Daily quota exceeded' }, 429);
  }

  const { prompt, sessionToken } = await request.json();
  if (!prompt || prompt.length > 500) {
    return jsonResponse({ error: 'Invalid prompt' }, 400);
  }

  // 检查用户是否登录
  let isLoggedIn = false;
  if (sessionToken) {
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (sessionData) {
      const user = JSON.parse(sessionData);
      if (user.isPro) {
        isLoggedIn = true;
      }
    }
  }

  // 未登录或未付费用户需要水印
  const needsWatermark = !isLoggedIn;

  try {
    // Pro 用户不扣额度
    if (!isLoggedIn) {
      await decrementQuota(ip, env);
    }
    const newQuota = await checkQuota(ip, env);
    const imageUrl = await generateEmoji(prompt, env);
    return jsonResponse({ imageUrl, remaining: newQuota.remaining, needsWatermark });
  } catch (err) {
    console.error('Generate error:', err);
    return jsonResponse({ error: err.message || 'Generation failed' }, 500);
  }
}

async function handleGenerateImage(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  
  const quota = await checkQuota(ip, env);
  if (quota.remaining <= 0) {
    return new Response(JSON.stringify({ error: 'Daily quota exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const { prompt } = await request.json();
  if (!prompt || prompt.length > 500) {
    return new Response(JSON.stringify({ error: 'Invalid prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const seed = Math.floor(Math.random() * 999999999);
    const emojiPrompt = prompt;
    const result = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
      prompt: emojiPrompt,
      seed: seed,
    });

    let imageData;
    if (result instanceof Uint8Array) {
      imageData = result;
    } else if (result && result.image instanceof Uint8Array) {
      imageData = result.image;
    } else if (result && typeof result.getReader === 'function') {
      const reader = result.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const imgArr = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { imgArr.set(c, offset); offset += c.length; }
      imageData = imgArr;
    } else if (result instanceof ArrayBuffer) {
      imageData = new Uint8Array(result);
    } else {
      throw new Error('Unexpected AI response type: ' + typeof result);
    }

    await decrementQuota(ip, env);
    const newQuota = await checkQuota(ip, env);

    return new Response(imageData, {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'X-Remaining': String(newQuota.remaining),
      }
    });
  } catch (err) {
    console.error('Generate image error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Generation failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}


async function handleQuota(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const quota = await checkQuota(ip, env);
  return jsonResponse({ remaining: quota.remaining });
}

async function generateEmoji(prompt, env) {
  const seed = Math.floor(Math.random() * 999999999);
  const emojiPrompt = prompt;
  
  const response = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
    prompt: emojiPrompt,
    seed: seed,
  });

  let imageBytes;
  try {
    if (response instanceof Uint8Array) {
      imageBytes = response;
    } else if (response && typeof response.getReader === 'function') {
      const reader = response.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      imageBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        imageBytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else if (response instanceof ArrayBuffer) {
      imageBytes = new Uint8Array(response);
    } else if (response instanceof Response) {
      const buf = await response.arrayBuffer();
      imageBytes = new Uint8Array(buf);
    } else if (response && response.image) {
      imageBytes = response.image instanceof Uint8Array ? response.image : new Uint8Array(Object.values(response.image));
    } else {
      const vals = Object.values(response);
      imageBytes = new Uint8Array(vals);
    }
  } catch (e) {
    throw new Error('Failed to decode image: ' + e.message);
  }

  if (!imageBytes || imageBytes.length === 0) throw new Error('Empty image data from AI');

  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < imageBytes.length; i += chunkSize) {
    binary += String.fromCharCode(...imageBytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  
  return `data:image/png;base64,${base64}`;
}

async function checkQuota(ip, env) {
  const key = `quota:${ip}`;
  const today = new Date().toISOString().split('T')[0];
  const data = await env.QUOTA_KV.get(key, 'json');
  if (!data || data.date !== today) {
    const newQuota = { remaining: 10, date: today };
    await env.QUOTA_KV.put(key, JSON.stringify(newQuota), { expirationTtl: 86400 });
    return newQuota;
  }
  return data;
}

async function decrementQuota(ip, env) {
  const key = `quota:${ip}`;
  const quota = await checkQuota(ip, env);
  const newQuota = { remaining: Math.max(0, quota.remaining - 1), date: quota.date };
  await env.QUOTA_KV.put(key, JSON.stringify(newQuota), { expirationTtl: 86400 });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ==========================================
// 内嵌 HTML（包含 Google 登录 UI）
// ==========================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Emoji Maker AI - AI 生成专属 Emoji</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }

/* 顶部导航 */
.nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }
.nav-brand { font-size: 1.2rem; font-weight: 700; background: linear-gradient(135deg, #6c63ff, #e040fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.nav-user { display: flex; align-items: center; gap: 10px; }
.nav-user img { width: 32px; height: 32px; border-radius: 50%; border: 2px solid #6c63ff; }
.nav-user-name { font-size: 0.85rem; color: #aaa; }
.google-login-btn { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: #fff; border: none; border-radius: 20px; font-size: 0.85rem; font-weight: 600; color: #333; cursor: pointer; transition: opacity 0.2s; }
.google-login-btn:hover { opacity: 0.85; }
.google-login-btn img { width: 18px; height: 18px; }

/* 头部 */
header { background: linear-gradient(135deg, #6c63ff 0%, #e040fb 100%); text-align: center; padding: 32px 20px; color: white; }
header h1 { font-size: 2.2rem; margin-bottom: 8px; }
header p { opacity: 0.85; font-size: 1rem; }

/* 主内容 */
main { max-width: 680px; margin: 32px auto; padding: 0 16px; display: flex; flex-direction: column; gap: 24px; }
.generator { background: #1a1a2e; border-radius: 20px; padding: 28px; border: 1px solid #2a2a4a; }
.input-area { position: relative; margin-bottom: 20px; }
textarea { width: 100%; height: 100px; background: #0f0f1a; border: 2px solid #2a2a4a; border-radius: 12px; color: #e0e0e0; font-size: 1rem; padding: 14px; resize: none; outline: none; transition: border-color 0.2s; font-family: inherit; }
textarea:focus { border-color: #6c63ff; }
textarea::placeholder { color: #555; }
.char-count { text-align: right; font-size: 0.78rem; color: #555; margin-top: 4px; }
.options-row { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
.option-group label { display: block; font-size: 0.82rem; font-weight: 600; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
.btn-group { display: flex; flex-wrap: wrap; gap: 8px; }
.opt-btn { padding: 7px 16px; border: 2px solid #2a2a4a; border-radius: 20px; background: transparent; color: #aaa; font-size: 0.85rem; cursor: pointer; transition: all 0.2s; }
.opt-btn:hover { border-color: #6c63ff; color: #e0e0e0; }
.opt-btn.active { border-color: #6c63ff; background: #6c63ff22; color: #a78bfa; font-weight: 600; }
.generate-btn { width: 100%; padding: 16px; background: linear-gradient(135deg, #6c63ff, #e040fb); border: none; border-radius: 14px; color: white; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: opacity 0.2s, transform 0.1s; margin-bottom: 12px; }
.generate-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.generate-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.quota-info { text-align: center; font-size: 0.82rem; color: #666; }
.quota-info strong { color: #a78bfa; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 结果区 */
.result-area { background: #1a1a2e; border-radius: 20px; padding: 28px; border: 1px solid #2a2a4a; text-align: center; }
.result-area h2 { font-size: 1rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 20px; }
.result-main { display: flex; flex-direction: column; align-items: center; gap: 20px; }
#resultImg { width: 200px; height: 200px; border-radius: 20px; object-fit: cover; border: 2px solid #2a2a4a; }
.result-actions { display: flex; gap: 12px; }
.btn-primary, .btn-secondary { padding: 10px 22px; border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn-primary { background: linear-gradient(135deg, #6c63ff, #e040fb); color: white; }
.btn-primary:hover { opacity: 0.9; }
.btn-secondary { background: #2a2a4a; color: #aaa; }
.btn-secondary:hover { background: #3a3a5a; color: #e0e0e0; }

/* 弹窗 */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-box { background: #1a1a2e; border-radius: 20px; padding: 36px 32px; text-align: center; max-width: 320px; border: 1px solid #2a2a4a; }
.modal-icon { font-size: 3rem; margin-bottom: 16px; }
.modal-box h3 { font-size: 1.2rem; margin-bottom: 10px; }
.modal-box p { color: #888; font-size: 0.9rem; margin-bottom: 8px; }
.modal-sub { font-size: 0.8rem !important; color: #555 !important; }
.modal-box .btn-primary { margin-top: 20px; width: 100%; padding: 12px; }
.hidden { display: none !important; }
</style>
</head>
<body>

<!-- 导航栏 -->
<nav class="nav">
  <a href="/" class="nav-brand">✨ Emoji Maker AI</a>
  <div class="nav-user">
    <!-- 登录后：显示头像+名字+账号链接 -->
    <a id="accountLink" href="/account" style="display:none; align-items:center; gap:8px; color:#aaa; text-decoration:none; font-size:0.85rem;">
      <img id="userAvatarNav" src="" alt="" style="width:28px; height:28px; border-radius:50%; border:2px solid #6c63ff; display:none;">
      <span id="userNameNav" style="display:none;"></span>
    </a>
    <!-- 登录前 -->
    <button class="google-login-btn" id="loginBtn" onclick="googleLogin()">
      <img src="https://www.gstatic.com/f2e/images/favicon.svg" alt="Google">
      用 Google 登录
    </button>
    <!-- 登录后 -->
    <button id="logoutBtn" class="btn-secondary" style="display:none; padding: 5px 12px; font-size: 0.75rem;" onclick="logout()">退出</button>
  </div>
</nav>

<header>
<h1>✨ Emoji Maker AI</h1>
<p>输入描述，AI 帮你生成专属 Emoji</p>
</header>

<main>
<section class="generator">
<div class="input-area">
<textarea id="prompt" placeholder="描述你想要的 Emoji，例如：一只戴墨镜的猫咪、开心的熊猫、愤怒的小鸟..." maxlength="200"></textarea>
<div class="char-count"><span id="charCount">0</span>/200</div>
</div>
<div class="options-row">
<div class="option-group">
<label>风格</label>
<div class="btn-group" id="styleGroup">
<button class="opt-btn active" data-value="emoji">Emoji</button>
<button class="opt-btn" data-value="3d emoji">3D</button>
<button class="opt-btn" data-value="pixel art emoji">像素</button>
<button class="opt-btn" data-value="sticker">贴纸</button>
</div>
</div>
<div class="option-group">
<label>表情</label>
<div class="btn-group" id="moodGroup">
<button class="opt-btn active" data-value="">默认</button>
<button class="opt-btn" data-value="happy">😊 开心</button>
<button class="opt-btn" data-value="sad">😢 悲伤</button>
<button class="opt-btn" data-value="cool">😎 酷</button>
<button class="opt-btn" data-value="angry">😡 愤怒</button>
<button class="opt-btn" data-value="surprised">😮 惊讶</button>
</div>
</div>
</div>
<button id="generateBtn" class="generate-btn">
<span id="btnText">✨ 生成 Emoji</span>
<span id="btnLoading" class="hidden"><span class="spinner"></span> AI 生成中...</span>
</button>
<div id="quotaInfo" class="quota-info">今日剩余免费次数：<strong id="quotaLeft">10</strong> 次</div>
</section>
<section class="result-area hidden" id="resultArea">
<h2>生成结果</h2>
<div class="result-main">
<img id="resultImg" src="" alt="生成的 Emoji">
<div class="result-actions">
<button id="downloadBtn" class="btn-primary">⬇️ 下载 PNG</button>
<button id="generateAgainBtn" class="btn-secondary">🔄 重新生成</button>
</div>
</div>
</section>
<div id="quotaModal" class="modal hidden">
<div class="modal-box">
<div class="modal-icon">🚀</div>
<h3>今日免费次数已用完</h3>
<p>每天免费生成 10 次，明天可继续使用</p>
<button id="closeModal" class="btn-primary">知道了</button>
</div>
</div>
</main>

<script>
const API_BASE = '';
let selectedStyle = 'emoji';
let selectedMood = '';
let isGenerating = false;
let sessionToken = localStorage.getItem('sessionToken') || null;

const promptEl = document.getElementById('prompt');
const charCountEl = document.getElementById('charCount');
const generateBtn = document.getElementById('generateBtn');
const btnText = document.getElementById('btnText');
const btnLoading = document.getElementById('btnLoading');
const resultArea = document.getElementById('resultArea');
const resultImg = document.getElementById('resultImg');
const quotaLeft = document.getElementById('quotaLeft');
const quotaModal = document.getElementById('quotaModal');

// ==========================================
// 认证相关
// ==========================================

function googleLogin() {
  window.location.href = '/auth/google';
}

function logout() {
  const token = localStorage.getItem('sessionToken');
  if (token) {
    fetch('/auth/logout?token=' + encodeURIComponent(token));
  }
  localStorage.removeItem('sessionToken');
  sessionToken = null;
  updateAuthUI();
}

async function updateAuthUI() {
  const token = localStorage.getItem('sessionToken');
  const loginBtn = document.getElementById('loginBtn');
  const accountLink = document.getElementById('accountLink');
  const userAvatarNav = document.getElementById('userAvatarNav');
  const userNameNav = document.getElementById('userNameNav');
  const logoutBtn = document.getElementById('logoutBtn');

  if (token) {
    try {
      const res = await fetch('/auth/me?token=' + encodeURIComponent(token));
      const data = await res.json();
      if (data.loggedIn && data.user) {
        loginBtn.style.display = 'none';
        accountLink.style.display = 'flex';
        userAvatarNav.src = data.user.picture || '';
        userAvatarNav.style.display = 'block';
        userNameNav.textContent = data.user.name || data.user.email;
        userNameNav.style.display = 'inline';
        logoutBtn.style.display = 'inline';
        return;
      }
    } catch (e) {}
    // token 无效，清掉
    localStorage.removeItem('sessionToken');
  }
  loginBtn.style.display = 'flex';
  accountLink.style.display = 'none';
  userAvatarNav.style.display = 'none';
  userNameNav.style.display = 'none';
  logoutBtn.style.display = 'none';
}

function getSessionToken() {
  return localStorage.getItem('sessionToken');
}

// ==========================================
// 生成相关
// ==========================================

promptEl.addEventListener('input', () => {
  charCountEl.textContent = promptEl.value.length;
});

document.getElementById('styleGroup').addEventListener('click', e => {
  if (!e.target.classList.contains('opt-btn')) return;
  document.querySelectorAll('#styleGroup .opt-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  selectedStyle = e.target.dataset.value;
});

document.getElementById('moodGroup').addEventListener('click', e => {
  if (!e.target.classList.contains('opt-btn')) return;
  document.querySelectorAll('#moodGroup .opt-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  selectedMood = e.target.dataset.value;
});

generateBtn.addEventListener('click', generate);

// 添加水印到 image 元素
function addWatermark(imgElement) {
  const canvas = document.createElement('canvas');
  canvas.width = imgElement.naturalWidth || 512;
  canvas.height = imgElement.naturalHeight || 512;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgElement, 0, 0);
  ctx.font = 'bold ' + Math.max(12, canvas.width / 32) + 'px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.textAlign = 'right';
  const x = canvas.width - 8;
  const y = canvas.height - 8;
  ctx.strokeText('aiemojimaker.xyz', x, y);
  ctx.fillText('aiemojimaker.xyz', x, y);
  return canvas.toDataURL('image/png');
}

async function generate() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    promptEl.focus();
    promptEl.style.borderColor = '#e040fb';
    setTimeout(() => promptEl.style.borderColor = '', 1500);
    return;
  }
  if (isGenerating) return;

  setLoading(true);

  try {
    const fullPrompt = buildPrompt(prompt, selectedStyle, selectedMood);
    const sessionToken = localStorage.getItem('sessionToken');

    // 使用 /api/generate（返回 JSON，支持水印标志）
    const res = await fetch(API_BASE + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fullPrompt, sessionToken })
    });

    if (res.status === 429) {
      showQuotaModal();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '生成失败，请重试');
    }

    const data = await res.json();
    updateQuotaDisplay(data.remaining);

    // 显示图片（未登录用户需要加水印）
    if (data.needsWatermark) {
      const img = new Image();
      img.onload = () => {
        const dataUrl = addWatermark(img);
        showResult(dataUrl, prompt);
      };
      img.src = data.imageUrl;
    } else {
      showResult(data.imageUrl, prompt);
    }

  } catch (err) {
    alert(err.message || '生成失败，请重试');
  } finally {
    setLoading(false);
  }
}

function buildPrompt(text, style, mood) {
  let p = text;
  if (style) p = style + ' style, ' + p;
  if (mood) p += ', ' + mood;
  p += ', white background, high quality, clean lines, vibrant colors';
  return p;
}

function showResult(url, prompt) {
  resultImg.src = url;
  resultImg.alt = prompt;
  resultArea.classList.remove('hidden');
  resultArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('downloadBtn').addEventListener('click', async () => {
  const url = resultImg.src;
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'emoji.png';
  a.click();
});

document.getElementById('generateAgainBtn').addEventListener('click', generate);

function updateQuotaDisplay(remaining) {
  if (remaining !== undefined) {
    quotaLeft.textContent = remaining;
  }
}

function showQuotaModal() {
  quotaModal.classList.remove('hidden');
}

document.getElementById('closeModal').addEventListener('click', () => {
  quotaModal.classList.add('hidden');
});

function setLoading(loading) {
  isGenerating = loading;
  generateBtn.disabled = loading;
  btnText.classList.toggle('hidden', loading);
  btnLoading.classList.toggle('hidden', !loading);
}

async function initQuota() {
  try {
    const token = localStorage.getItem('sessionToken');
    if (token) {
      const res = await fetch('/api/user/status?token=' + encodeURIComponent(token));
      const data = await res.json();
      if (data.loggedIn && data.user?.isPro) {
        quotaLeft.textContent = '∞';
        document.getElementById('quotaInfo').innerHTML = '✨ <strong>Pro</strong> — 无限次生成';
        return;
      }
      if (data.quota) {
        updateQuotaDisplay(data.quota.remaining);
        return;
      }
    }
    const res = await fetch(API_BASE + '/api/quota');
    const data = await res.json();
    updateQuotaDisplay(data.remaining);
  } catch {}
}

// ==========================================
// 初始化
// ==========================================

// 处理 URL 中的 session token（OAuth 回调后）
const urlParams = new URLSearchParams(window.location.search);
const sessionFromUrl = urlParams.get('session');
if (sessionFromUrl) {
  localStorage.setItem('sessionToken', sessionFromUrl);
  sessionToken = sessionFromUrl;
  // 清理 URL
  window.history.replaceState({}, document.title, '/');
}

updateAuthUI();
initQuota();
</script>
</body>
</html>`;

// ==========================================
// 账号中心 HTML（定价页风格）
// ==========================================
const ACCOUNT_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Upgrade - Emoji Maker AI</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }
.nav-brand { font-size: 1.2rem; font-weight: 700; background: linear-gradient(135deg, #6c63ff, #e040fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-decoration: none; }
.nav-links { display: flex; gap: 20px; }
.nav-links a { color: #aaa; text-decoration: none; font-size: 0.9rem; }
.nav-links a:hover, .nav-links a.active { color: #e0e0e0; }
.main { max-width: 900px; margin: 0 auto; padding: 60px 20px; text-align: center; }
.gradient-text { background: linear-gradient(135deg, #6c63ff, #e040fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2.5rem; font-weight: 800; margin-bottom: 8px; }
.subtitle { color: #888; font-size: 1rem; margin-bottom: 48px; }
.plans { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 720px; margin: 0 auto; }
.plan-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 20px; padding: 32px; text-align: left; position: relative; }
.plan-card.popular { border-color: #6c63ff; box-shadow: 0 0 40px rgba(108, 99, 255, 0.15); }
.popular-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, #6c63ff, #e040fb); color: white; font-size: 0.7rem; font-weight: 700; padding: 4px 14px; border-radius: 20px; white-space: nowrap; }
.plan-name { font-size: 1.1rem; font-weight: 700; color: #e0e0e0; margin-bottom: 4px; }
.plan-price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 24px; }
.plan-price-num { font-size: 2.2rem; font-weight: 800; color: #e0e0e0; }
.plan-price-period { font-size: 0.85rem; color: #888; }
.plan-desc { font-size: 0.82rem; color: #666; margin-bottom: 20px; }
.features { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
.features li { display: flex; align-items: center; gap: 10px; font-size: 0.88rem; color: #ccc; }
.check { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #6c63ff, #e040fb); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; }
.check.gray { background: #333; }
.plan-btn { display: block; width: 100%; padding: 12px; border-radius: 10px; font-size: 0.9rem; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; transition: opacity 0.2s; border: none; }
.btn-pro { background: linear-gradient(135deg, #6c63ff, #e040fb); color: white; }
.btn-pro:hover { opacity: 0.88; }
.btn-free { background: #2a2a4a; color: #aaa; }
.btn-free:hover { opacity: 0.88; }
.user-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
.user-avatar { width: 40px; height: 40px; border-radius: 50%; border: 2px solid #6c63ff; }
.user-name { font-size: 0.9rem; color: #aaa; }
.user-email { font-size: 0.78rem; color: #666; }
.current-plan { font-size: 0.78rem; color: #6c63ff; font-weight: 600; }
@media (max-width: 600px) {
  .plans { grid-template-columns: 1fr; }
  .gradient-text { font-size: 1.8rem; }
}
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-brand">✨ Emoji Maker AI</a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/account" class="active">Pricing</a>
  </div>
</nav>
<main class="main">
  <div class="gradient-text">Upgrade to Pro</div>
  <div class="subtitle" id="subtitle">Unlimited generations, no watermark</div>
  <div id="user-bar"></div>
  <div class="plans" id="plans"></div>
</main>
<script>
const userData = __USER_DATA__;
const isLoggedIn = userData.loggedIn;
const user = userData.user;
const quota = userData.quota;
const isPro = user && user.isPro;

const features = {
  free: [
    '10 generations per day',
    'Emoji + 3D + Pixel + Sticker styles',
    'No signup required',
    'Daily quota resets at midnight',
  ],
  pro: [
    'Unlimited generations',
    'No watermark on downloads',
    'Priority access to new features',
    'Cancel anytime',
  ]
};

function renderPlans() {
  const plansEl = document.getElementById('plans');
  const freeDisabled = isLoggedIn ? '' : 'href="/auth/google"';
  const proDisabled = isPro ? '' : 'href="#pro" onclick="event.preventDefault();alert(\'Pro subscription coming soon!\');"';

  plansEl.innerHTML = \`
    <div class="plan-card">
      <div class="plan-name">Free</div>
      <div class="plan-price">
        <span class="plan-price-num">$0</span>
        <span class="plan-price-period">/ month</span>
      </div>
      <div class="plan-desc">Get started with AI Emoji</div>
      <ul class="features">
        \${features.free.map(f => \`<li><span class="check gray">✓</span>\${f}</li>\`).join('')}
      </ul>
      \${isPro ? '<div class="current-plan">✓ Current Plan</div>' : \`<a \${freeDisabled} class="plan-btn btn-free">\${isLoggedIn ? 'Your Current Plan' : 'Get Started Free'}</a>\`}
    </div>
    <div class="plan-card popular">
      <div class="popular-badge">MOST POPULAR</div>
      <div class="plan-name">Pro</div>
      <div class="plan-price">
        <span class="plan-price-num">$4.99</span>
        <span class="plan-price-period">/ month</span>
      </div>
      <div class="plan-desc">For daily Emoji creators</div>
      <ul class="features">
        \${features.pro.map(f => \`<li><span class="check">✓</span>\${f}</li>\`).join('')}
      </ul>
      \${isPro ? '<div class="current-plan">✓ You are Pro</div>' : '<a href="#pro" class="plan-btn btn-pro">✨ Upgrade to Pro</a>'}
    </div>
  \`;
}

function renderUserBar() {
  const bar = document.getElementById('user-bar');
  if (!isLoggedIn || !user) return;
  bar.innerHTML = \`
    <div class="user-bar">
      <img src="\${user.picture || 'https://www.gstatic.com/f2e/images/favicon.svg'}" class="user-avatar" alt="avatar">
      <div>
        <div class="user-name">\${user.name}</div>
        <div class="user-email">\${user.email}</div>
      </div>
      \${isPro ? '<span class="current-plan">✨ Pro Member</span>' : '<span class="current-plan">Free Plan</span>'}
    </div>
  \`;
}

renderUserBar();
renderPlans();
</script>
</body>
</html>`;
