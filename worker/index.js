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

    if (url.pathname === '/pricing' || url.pathname === '/pricing/') {
      return handlePricing(request, env);
    }

    // API: 用户状态（登录状态 + 订阅 + 额度）
    if (url.pathname === '/api/user/status' && request.method === 'GET') {
      return handleUserStatus(request, env);
    }

    // ========== PayPal 订阅 ==========
    if (url.pathname === '/api/paypal/create-subscription' && request.method === 'POST') {
      return handlePayPalCreateSubscription(request, env);
    }
    if (url.pathname === '/api/paypal/webhook' && request.method === 'POST') {
      return handlePayPalWebhook(request, env);
    }
    if (url.pathname === '/api/paypal/activate' && request.method === 'POST') {
      return handlePayPalActivate(request, env);
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

    // Yandex Webmaster 验证文件
    if (url.pathname === '/3b5345e5d76ae962.html') {
      return new Response('<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>Verification: 3b5345e5d76ae962</body></html>', {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }

    // Robots.txt
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\nSitemap: https://aiemojimaker.xyz/sitemap.xml\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // 阻止 Google 索引带 authCallback 的 URL（加 noindex 头，不影响正常访问）
    if (url.searchParams.has('authCallback')) {
      return new Response(HTML.replace('__USER_DATA__', '{}'), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow',
        }
      });
    }

    // Sitemap XML
    if (url.pathname === '/sitemap.xml') {
      return new Response(SITEMAP_XML, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        }
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
    plan: userData?.plan || 'free', // 'free' | 'monthly_pro' | 'yearly_pro'
    dailyLimit: userData?.dailyLimit || 10,
    isPro: !!userData?.plan && userData.plan !== 'free',
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
  const plan = user.plan || 'free';
  const dailyLimit = PLAN_LIMITS[plan] || 10;
  const quota = await checkUserQuota(user.sub, env, dailyLimit);

  return jsonResponse({
    loggedIn: true,
    user: {
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      plan: plan,
      isPro: plan !== 'free',
    },
    quota: {
      remaining: quota.remaining,
      dailyLimit: dailyLimit,
    }
  });
}

async function handleAccount(request, env) {
  const url = new URL(request.url);
  const sessionToken = url.searchParams.get('token');
  const subscribed = url.searchParams.get('subscribed');
  let user = null;
  let isLoggedIn = false;
  let quota = { remaining: 10, dailyLimit: 10 };

  if (sessionToken) {
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (sessionData) {
      user = JSON.parse(sessionData);
      isLoggedIn = true;
      const plan = user.plan || 'free';
      const dailyLimit = PLAN_LIMITS[plan] || 10;
      quota = await checkUserQuota(user.sub, env, dailyLimit);
      quota.dailyLimit = dailyLimit;
    }
  }

  const userJson = JSON.stringify({
    loggedIn: isLoggedIn,
    user: user ? { sub: user.sub, email: user.email, name: user.name, picture: user.picture, plan: user.plan || 'free' } : null,
    quota,
    showSubscribedMessage: subscribed === '1',
  });

  return new Response(ACCOUNT_HTML.replace('__USER_DATA__', userJson), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function handlePricing(request, env) {
  const sessionToken = new URL(request.url).searchParams.get('token');
  let isLoggedIn = false;
  let isPro = false;

  if (sessionToken) {
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (sessionData) {
      const user = JSON.parse(sessionData);
      isLoggedIn = true;
      isPro = user.isPro || false;
    }
  }

  // PayPal Client ID 从环境变量读取
  const paypalClientId = env.PAYPAL_CLIENT_ID || '';

  return new Response(
    PRICING_HTML
      .replace('__IS_LOGGED_IN__', String(isLoggedIn))
      .replace('__IS_PRO__', String(isPro))
      .replace('__PAYPAL_CLIENT_ID__', paypalClientId),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// ==========================================
// PayPal 订阅
// ==========================================

// const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
const PAYPAL_API_BASE = 'https://api-m.paypal.com'; // 生产环境

async function getPayPalAccessToken(env) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('PayPal token error: ' + err);
  }
  const data = await res.json();
  return data.access_token;
}

async function handlePayPalCreateSubscription(request, env) {
  try {
    const { planType, sessionToken } = await request.json();

    if (!sessionToken) {
      return jsonResponse({ error: 'Not logged in' }, 401);
    }

    // 验证 session
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (!sessionData) {
      return jsonResponse({ error: 'Invalid session' }, 401);
    }
    const user = JSON.parse(sessionData);

    const accessToken = await getPayPalAccessToken(env);

    // 订阅计划 ID（需要在 PayPal Dashboard 创建，或用客户端ID方案）
    // 方案：用 PayPal 计划 ID 或者直接传 price 做 inline 订阅
    const planId = planType === 'monthly'
      ? (env.PAYPAL_MONTHLY_PLAN_ID || 'MONTHLY_PLAN_ID_NOT_SET')
      : (env.PAYPAL_YEARLY_PLAN_ID || 'YEARLY_PLAN_ID_NOT_SET');

    // 创建订阅
    const subRes = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `sub-${user.sub}-${Date.now()}`,
      },
      body: JSON.stringify({
        plan_id: planId,
        subscriber: {
          email_address: user.email,
        },
        custom_id: user.sub, // 关联我们的用户 ID
        start_time: new Date(Date.now() + 30 * 1000).toISOString(), // 30秒后开始
        application_context: {
          brand_name: 'Emoji Maker AI',
          user_action: 'SUBSCRIBE_NOW',
          return_url: 'https://aiemojimaker.xyz/account?subscribed=1',
          cancel_url: 'https://aiemojimaker.xyz/pricing?cancelled=1',
        },
      }),
    });

    if (!subRes.ok) {
      const err = await subRes.json();
      console.error('PayPal subscription error:', err);
      return jsonResponse({ error: 'Failed to create subscription', details: err }, 500);
    }

    const sub = await subRes.json();
    // 找到 approval URL
    const approveLink = sub.links.find(l => l.rel === 'approve');
    return jsonResponse({ approvalUrl: approveLink?.href, subscriptionId: sub.id });

  } catch (err) {
    console.error('PayPal create subscription error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handlePayPalWebhook(request, env) {
  // PayPal webhook 验证（生产环境需要验证 webhook signature）
  // 这里先做简单处理：记录 event 并返回 200
  try {
    const event = await request.json();
    console.log('PayPal webhook event:', JSON.stringify(event));

    const eventType = event.event_type;
    const subscriptionId = event.resource?.id;
    const customId = event.resource?.custom_id;

    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' && customId) {
      // 订阅激活，升级用户 plan
      const planMap = {
        'MONTHLY_PLAN_ID': 'monthly_pro',
        'YEARLY_PLAN_ID': 'yearly_pro',
      };
      const plan = planMap[event.resource?.plan_id] || event.resource?.plan_id;
      const userData = await env.QUOTA_KV.get(`user:${customId}`, 'json') || {};
      userData.plan = plan;
      userData.paypalSubscriptionId = subscriptionId;
      await env.QUOTA_KV.put(`user:${customId}`, JSON.stringify(userData), { expirationTtl: 86400 * 365 });

      // 更新 session
      const allKeys = await env.QUOTA_KV.list({ prefix: 'session:' });
      for (const key of allKeys.keys) {
        const sessionData = await env.QUOTA_KV.get(key.name, 'text');
        if (sessionData) {
          const session = JSON.parse(sessionData);
          if (session.sub === customId) {
            session.plan = plan;
            session.isPro = !!plan && plan !== 'free';
            await env.QUOTA_KV.put(key.name, JSON.stringify(session), { expirationTtl: 604800 });
          }
        }
      }
      console.log(`User ${customId} upgraded to ${plan}`);
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('PayPal webhook error:', err);
    return new Response('Error', { status: 500 });
  }
}

async function handlePayPalActivate(request, env) {
  // 客户端通过这个端点通知后端订阅已审批（approval 后跳转回来）
  // 这个端点由前端在 /account 页面加载时调用，检查订阅状态
  try {
    const { sessionToken } = await request.json();
    if (!sessionToken) return jsonResponse({ error: 'No session' }, 401);

    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (!sessionData) return jsonResponse({ error: 'Invalid session' }, 401);

    const user = JSON.parse(sessionData);
    const userData = await env.QUOTA_KV.get(`user:${user.sub}`, 'json') || {};
    if (userData.plan && userData.plan !== 'free') {
      // 已激活
      return jsonResponse({ plan: userData.plan, activated: true });
    }
    return jsonResponse({ activated: false });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ==========================================
// 额度检查（按用户 sub，非 IP）
// ==========================================

const PLAN_LIMITS = {
  'free': 10,
  'monthly_pro': 50,
  'yearly_pro': 100,
};

async function checkUserQuota(sub, env, dailyLimit) {
  const key = `uquota:${sub}`;
  const today = new Date().toISOString().split('T')[0];
  const data = await env.QUOTA_KV.get(key, 'json');
  if (!data || data.date !== today) {
    const newQuota = { remaining: dailyLimit, date: today };
    await env.QUOTA_KV.put(key, JSON.stringify(newQuota), { expirationTtl: 86400 });
    return newQuota;
  }
  return data;
}

async function decrementUserQuota(sub, env, dailyLimit) {
  const key = `uquota:${sub}`;
  const quota = await checkUserQuota(sub, env, dailyLimit);
  const newQuota = { remaining: Math.max(0, quota.remaining - 1), date: quota.date };
  await env.QUOTA_KV.put(key, JSON.stringify(newQuota), { expirationTtl: 86400 });
  return newQuota;
}

// ==========================================
// 现有的生成和额度逻辑
// ==========================================

async function handleGenerate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { prompt, sessionToken } = await request.json();

  if (!prompt || prompt.length > 500) {
    return jsonResponse({ error: 'Invalid prompt' }, 400);
  }

  // 检查登录状态和 plan
  let user = null;
  if (sessionToken) {
    const sessionData = await env.QUOTA_KV.get(`session:${sessionToken}`, 'text');
    if (sessionData) {
      user = JSON.parse(sessionData);
    }
  }

  const plan = user?.plan || 'free';
  const dailyLimit = PLAN_LIMITS[plan] || 10;
  const needsWatermark = plan === 'free'; // 只有 Free 用户需要水印

  // 检查/扣减额度
  if (!user) {
    // 未登录：使用 IP 额度（10次/天，有水印）
    const quota = await checkQuota(ip, env);
    if (quota.remaining <= 0) {
      return jsonResponse({ error: 'Daily quota exceeded' }, 429);
    }
    await decrementQuota(ip, env);
    const newQuota = await checkQuota(ip, env);
    try {
      const imageUrl = await generateEmoji(prompt, env);
      return jsonResponse({ imageUrl, remaining: newQuota.remaining, needsWatermark: true });
    } catch (err) {
      console.error('Generate error:', err);
      return jsonResponse({ error: err.message || 'Generation failed' }, 500);
    }
  } else {
    // 已登录：使用用户额度
    const quota = await checkUserQuota(user.sub, env, dailyLimit);
    if (quota.remaining <= 0) {
      return jsonResponse({ error: 'Daily quota exceeded' }, 429);
    }
    const newQuota = await decrementUserQuota(user.sub, env, dailyLimit);
    try {
      const imageUrl = await generateEmoji(prompt, env);
      return jsonResponse({ imageUrl, remaining: newQuota.remaining, needsWatermark });
    } catch (err) {
      console.error('Generate error:', err);
      return jsonResponse({ error: err.message || 'Generation failed' }, 500);
    }
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
// Sitemap XML
// ==========================================
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://aiemojimaker.xyz/</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://aiemojimaker.xyz/account</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://aiemojimaker.xyz/pricing</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;

// ==========================================
// 内嵌 HTML（包含 Google 登录 UI）
// ==========================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Emoji Maker AI - AI 生成专属 Emoji</title>
<meta name="yandex-verification" content="3b5345e5d76ae962" />
<meta name="google-site-verification" content="9qHDHlLjXna-ayH0ymgsbu-PlzW3qGoLrJztuO7Ea2k" />
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
.quota-badge { display: block; text-align: center; font-size: 0.8rem; color: #888; margin-top: 10px; }
.quota-badge .num { font-weight: 800; color: #a78bfa; }
.login-prompt-row { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; }
.inline-login-btn { padding: 6px 16px; background: linear-gradient(135deg, #6c63ff, #e040fb); border: none; border-radius: 20px; font-size: 0.8rem; font-weight: 600; color: white; cursor: pointer; transition: opacity 0.2s; }
.inline-login-btn:hover { opacity: 0.85; }

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

/* ==========================================
   Mobile 修复（Google Search Console Mobile Usability）
   ========================================== */
@media (max-width: 600px) {
  body { font-size: 16px; }
  header h1 { font-size: 1.6rem; }
  header p { font-size: 0.9rem; }
  .nav { padding: 12px 16px; }
  .nav-brand { font-size: 1rem; }
  .nav-user-name { font-size: 0.8rem; }
  .google-login-btn { font-size: 0.8rem; padding: 6px 12px; }
  .quota-badge { font-size: 0.85rem; }
  .char-count { font-size: 0.85rem; }
  .modal-box { padding: 24px 20px; margin: 16px; max-width: calc(100% - 32px); }
  .modal-box p { font-size: 0.9rem; }
  .modal-sub { font-size: 0.85rem !important; }
  .inline-login-btn { font-size: 0.85rem; padding: 8px 16px; }
  .opt-btn { font-size: 0.85rem; padding: 10px 14px; min-height: 44px; }
  .generate-btn { font-size: 1rem; padding: 14px; }
  .btn-primary, .btn-secondary { font-size: 0.9rem; padding: 12px 18px; }
  .modal-icon { font-size: 2.5rem; }
  .modal-box h3 { font-size: 1.1rem; }
  textarea { font-size: 16px; }
  #resultImg { width: 160px; height: 160px; }
}
</style>
</head>
<body>

<!-- 导航栏 -->
<nav class="nav">
  <a href="/" class="nav-brand">✨ Emoji Maker AI</a>
  <div class="nav-user">
    <!-- 登录后：显示头像+名字+账号链接 -->
    <a id="pricingLink" href="/pricing" style="display:none; color:#aaa; text-decoration:none; font-size:0.85rem; padding: 4px 10px; border: 1px solid #333; border-radius: 20px;">Pricing</a>
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
<div id="quotaBadge" class="quota-badge">免费 <span id="quotaLeft">10</span> 次/天 · <span id="watermarkHint">带水印</span></div>
<div id="loginPrompt" class="login-prompt-row">
  <span style="color:#666;font-size:0.8rem;">登录解锁</span>
  <button id="inlineLoginBtn" class="inline-login-btn">立即登录（10次/免水印）</button>
</div>
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
<div class="modal-box" style="text-align:center;">
<div class="modal-icon">🚀</div>
<h3 style="margin-bottom:8px;">Today's limit reached!</h3>
<p style="color:#888;font-size:0.85rem;margin-bottom:6px;">You have used all 10 free generations.</p>
<p style="color:#aaa;font-size:0.9rem;margin-bottom:20px;font-weight:600;">Upgrade to Pro for unlimited access</p>
<a href="/account" class="btn-primary" style="display:block;width:100%;padding:12px;border-radius:10px;font-weight:700;text-align:center;text-decoration:none;">✨ View Pro Plans</a>
<button id="closeModal" class="btn-secondary" style="margin-top:10px;background:transparent;border:none;color:#555;font-size:0.8rem;cursor:pointer;">Maybe later</button>
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
  const pricingLink = document.getElementById('pricingLink');
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
        pricingLink.style.display = 'inline';
        userAvatarNav.src = data.user.picture || '';
        userAvatarNav.style.display = 'block';
        userNameNav.textContent = data.user.name || data.user.email;
        userNameNav.style.display = 'inline';
        logoutBtn.style.display = 'inline';
        document.getElementById('loginPrompt').style.display = 'none';
        return;
      }
    } catch (e) {}
    // token 无效，清掉
    localStorage.removeItem('sessionToken');
  }
  loginBtn.style.display = 'flex';
  accountLink.style.display = 'none';
  pricingLink.style.display = 'none';
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
    const watermarkHint = document.getElementById('watermarkHint');
    if (token) {
      const res = await fetch('/api/user/status?token=' + encodeURIComponent(token));
      const data = await res.json();
      if (data.loggedIn) {
        const plan = data.user?.plan || 'free';
        const lp = document.getElementById('loginPrompt');
        if (lp) lp.style.display = 'none';
        if (plan === 'free') {
          if (watermarkHint) {
            watermarkHint.textContent = '已登录 — 无水印';
            watermarkHint.style.color = '#6c63ff';
          }
        } else if (plan === 'monthly_pro') {
          if (watermarkHint) {
            watermarkHint.textContent = '50次/天 — 无水印';
            watermarkHint.style.color = '#6c63ff';
          }
        } else if (plan === 'yearly_pro') {
          if (watermarkHint) {
            watermarkHint.textContent = '100次/天 — 无水印';
            watermarkHint.style.color = '#6c63ff';
          }
        }
        if (data.quota) {
          updateQuotaDisplay(data.quota.remaining);
        }
        return;
      }
    }
    if (watermarkHint) {
      watermarkHint.textContent = '带水印';
      watermarkHint.style.color = '#888';
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

// 立即登录按钮
document.getElementById('inlineLoginBtn')?.addEventListener('click', () => {
  window.location.href = '/auth/google';
});

// 隐藏已登录用户的登录提示
if (localStorage.getItem('sessionToken')) {
  const lp = document.getElementById('loginPrompt');
  if (lp) lp.style.display = 'none';
}
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
.plans { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; max-width: 900px; margin: 0 auto; }
.plan-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 20px; padding: 28px; text-align: left; position: relative; }
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
  .main { padding: 40px 16px; }
  .popular-badge { font-size: 0.75rem; }
  .plan-price-num { font-size: 1.8rem; }
  .plan-desc { font-size: 0.88rem; }
  .features li { font-size: 0.88rem; }
  .user-name { font-size: 0.88rem; }
  .user-email { font-size: 0.82rem; }
  .current-plan { font-size: 0.85rem; }
  .plan-btn { font-size: 0.9rem; padding: 12px; }
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
    'All emoji styles',
    'Watermark on downloads',
    'No signup required',
  ],
  monthly: [
    '50 generations per day',
    'All emoji styles',
    'No watermark',
    'Cancel anytime',
  ],
  yearly: [
    '100 generations per day',
    'All emoji styles',
    'No watermark',
    'Save $19.89 vs monthly',
    'Cancel anytime',
  ]
};

function renderPlans() {
  const plansEl = document.getElementById('plans');
  const isCurrentFree = user?.plan === 'free';
  const isCurrentMonthly = user?.plan === 'monthly_pro';
  const isCurrentYearly = user?.plan === 'yearly_pro';
  const isPro = user?.isPro || (user?.plan && user.plan !== 'free');

  plansEl.innerHTML = \`
    <div class="plan-card">
      <div class="plan-name">Free</div>
      <div class="plan-price">
        <span class="plan-price-num">$0</span>
        <span class="plan-price-period">/ month</span>
      </div>
      <div class="plan-desc">Perfect to get started</div>
      <ul class="features">
        \${features.free.map(f => \`<li><span class="check">✓</span>\${f}</li>\`).join('')}
      </ul>
      \${isCurrentFree ? '<div class="current-plan">✓ Current plan</div>' : '<div class="current-plan">Free</div>'}
    </div>
    <div class="plan-card">
      <div class="plan-name">Pro Monthly</div>
      <div class="plan-price">
        <span class="plan-price-num">$4.99</span>
        <span class="plan-price-period">/ month</span>
      </div>
      <div class="plan-desc">For regular creators</div>
      <ul class="features">
        \${features.monthly.map(f => \`<li><span class="check">✓</span>\${f}</li>\`).join('')}
      </ul>
      \${isCurrentMonthly ? '<div class="current-plan">✓ Current plan</div>' : \`<a href="/pricing?plan=monthly" class="plan-btn btn-pro">✨ Get Pro Monthly</a>\`}
    </div>
    <div class="plan-card popular">
      <div class="popular-badge">BEST VALUE</div>
      <div class="plan-name">Pro Yearly</div>
      <div class="plan-price">
        <span class="plan-price-num">$39.99</span>
        <span class="plan-price-period">/ year</span>
        <span class="plan-price-save">($3.33/mo)</span>
      </div>
      <div class="plan-desc">For heavy users, save 33%</div>
      <ul class="features">
        \${features.yearly.map(f => \`<li><span class="check">✓</span>\${f}</li>\`).join('')}
      </ul>
      \${isCurrentYearly ? '<div class="current-plan">✓ Current plan</div>' : \`<a href="/pricing?plan=yearly" class="plan-btn btn-pro">✨ Get Pro Yearly</a>\`}
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

// 如果从 PayPal 订阅页返回，显示成功消息并检查激活状态
if (userData.showSubscribedMessage && isLoggedIn) {
  const sub = document.getElementById('subtitle');
  if (sub) {
    sub.innerHTML = '<span style="color:#6c63ff;">✅ Subscription submitted! Checking activation...</span>';
  }

  // 检查激活状态
  const token = localStorage.getItem('sessionToken');
  if (token) {
    fetch('/api/paypal/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token }),
    })
    .then(r => r.json())
    .then(data => {
      if (data.activated) {
        if (sub) sub.innerHTML = '<span style="color:#6c63ff;">🎉 Subscription activated! Welcome to Pro.</span>';
        setTimeout(() => window.location.reload(), 2000);
      } else {
        if (sub) sub.innerHTML = '<span style="color:#f59e0b;">⏳ Subscription pending... PayPal will notify us when confirmed.</span>';
      }
    })
    .catch(() => {
      if (sub) sub.innerHTML = '<span style="color:#f59e0b;">⏳ Subscription pending. Reload page to check status.</span>';
    });
  }
}
</script>
</body>
</html>`;

// ==========================================
// 定价页 HTML
// ==========================================
const PRICING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pricing - Emoji Maker AI</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }
.nav-brand { font-size: 1.2rem; font-weight: 700; background: linear-gradient(135deg, #6c63ff, #e040fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-decoration: none; }
.nav-links { display: flex; gap: 20px; }
.nav-links a { color: #aaa; text-decoration: none; font-size: 0.9rem; }
.nav-links a:hover { color: #e0e0e0; }
.main { max-width: 960px; margin: 0 auto; padding: 60px 20px; text-align: center; }
.gradient-text { background: linear-gradient(135deg, #6c63ff, #e040fb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2.5rem; font-weight: 800; margin-bottom: 8px; }
.subtitle { color: #888; font-size: 1rem; margin-bottom: 48px; }
.plans { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; max-width: 960px; margin: 0 auto; }
.plan-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 16px; padding: 24px; text-align: left; position: relative; }
.plan-card.popular { border-color: #6c63ff; box-shadow: 0 0 30px rgba(108, 99, 255, 0.15); }
.popular-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, #6c63ff, #e040fb); color: white; font-size: 0.65rem; font-weight: 700; padding: 3px 12px; border-radius: 20px; white-space: nowrap; }
.plan-name { font-size: 1.1rem; font-weight: 700; color: #e0e0e0; margin-bottom: 4px; }
.plan-price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 24px; }
.plan-price-num { font-size: 2.2rem; font-weight: 800; color: #e0e0e0; }
.plan-price-period { font-size: 0.85rem; color: #888; }
.plan-price-save { font-size: 0.75rem; color: #6c63ff; font-weight: 600; margin-left: 4px; }
.plan-desc { font-size: 0.82rem; color: #666; margin-bottom: 20px; }
.features { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
.features li { display: flex; align-items: center; gap: 10px; font-size: 0.88rem; color: #ccc; }
.features li .check { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #6c63ff, #e040fb); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; }
.features li .check.gray { background: #333; }
.plan-btn { display: block; width: 100%; padding: 12px; border-radius: 10px; font-size: 0.9rem; font-weight: 700; text-align: center; text-decoration: none; cursor: pointer; transition: opacity 0.2s; border: none; }
.plan-btn.pro { background: linear-gradient(135deg, #6c63ff, #e040fb); color: white; }
.plan-btn.pro:hover { opacity: 0.88; }
.plan-btn.free { background: #2a2a4a; color: #aaa; }
.plan-btn.free:hover { background: #3a3a5a; color: #e0e0e0; }
.current-plan { display: inline-block; font-size: 0.8rem; color: #6c63ff; font-weight: 600; margin-top: 12px; }
.social-proof { margin-top: 40px; font-size: 0.82rem; color: #555; }
.social-proof span { color: #888; font-weight: 600; }
.paypal-loading { font-size: 0.8rem; color: #666; margin-top: 8px; }
@media (max-width: 768px) {
  .plans { grid-template-columns: 1fr; }
  .gradient-text { font-size: 1.8rem; }
  .main { padding: 40px 16px; }
  .popular-badge { font-size: 0.75rem; }
  .plan-price-num { font-size: 1.8rem; }
  .plan-desc { font-size: 0.88rem; }
  .features li { font-size: 0.88rem; }
  .current-plan { font-size: 0.85rem; }
  .plan-btn { font-size: 0.9rem; padding: 12px; }
  .social-proof { font-size: 0.88rem; }
  .paypal-loading { font-size: 0.85rem; }
}
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-brand">✨ Emoji Maker AI</a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/pricing">Pricing</a>
  </div>
</nav>
<main class="main">
  <div class="gradient-text">Simple Pricing</div>
  <div class="subtitle">Start free, upgrade when you need more</div>

  <div class="plans">
    <!-- Monthly Plan -->
    <div class="plan-card">
      <div class="plan-name">Monthly Plan</div>
      <div class="plan-price">
        <span class="plan-price-num">$4.99</span>
        <span class="plan-price-period">/ month</span>
      </div>
      <div class="plan-desc">Pay month by month</div>
      <ul class="features">
        <li><span class="check gray">✓</span> Unlimited generations</li>
        <li><span class="check gray">✓</span> No watermark</li>
        <li><span class="check gray">✓</span> 7-day money-back guarantee</li>
        <li><span class="check gray">✓</span> Cancel anytime</li>
      </ul>
      <div id="monthlyBtnContainer">
        <a id="monthlyBtn" href="#monthly" class="plan-btn free">Start Monthly</a>
        <div id="monthlyPaypalBtn" class="paypal-btn-container"></div>
        <div id="monthlyLoading" class="paypal-loading" style="display:none;">Loading PayPal...</div>
      </div>
    </div>

    <!-- Yearly Plan -->
    <div class="plan-card popular">
      <div class="popular-badge">BEST VALUE</div>
      <div class="plan-name">Yearly Plan</div>
      <div class="plan-price">
        <span class="plan-price-num">$39.99</span>
        <span class="plan-price-period">/ year</span>
        <span class="plan-price-save">($3.33/mo)</span>
      </div>
      <div class="plan-desc">Pay once a year, save $19.89</div>
      <ul class="features">
        <li><span class="check">✓</span> Everything in Monthly</li>
        <li><span class="check">✓</span> Save 33% vs monthly</li>
        <li><span class="check">✓</span> 7-day money-back guarantee</li>
        <li><span class="check">✓</span> Cancel anytime</li>
      </ul>
      <div id="yearlyBtnContainer">
        <a id="yearlyBtn" href="#yearly" class="plan-btn pro">✨ Start Yearly — Save $19.89</a>
        <div id="yearlyPaypalBtn" class="paypal-btn-container"></div>
        <div id="yearlyLoading" class="paypal-loading" style="display:none;">Loading PayPal...</div>
      </div>
    </div>
  </div>

  <div class="social-proof">
    Trusted by <span>1,000+</span> creators worldwide
  </div>
</main>

<!-- PayPal SDK -->
<script src="https://www.paypal.com/sdk/js?client-id=__PAYPAL_CLIENT_ID__&currency=USD&intent=subscription&vault=true" data-sdk-integration-source="button-factory"></script>

<script>
const isPro = __IS_PRO__ === 'true';
const paypalClientId = '__PAYPAL_CLIENT_ID__';

function getSessionToken() {
  return localStorage.getItem('sessionToken');
}

async function checkLoginStatus() {
  const token = getSessionToken();
  if (!token) return { loggedIn: false, isPro: false };
  try {
    const res = await fetch('/api/user/status?token=' + encodeURIComponent(token));
    const data = await res.json();
    return { loggedIn: data.loggedIn, isPro: data.user?.isPro || false, user: data.user };
  } catch {
    return { loggedIn: false, isPro: false };
  }
}

async function updateBtns() {
  // Always check client-side login status (localStorage)
  const { loggedIn, isPro: userIsPro } = await checkLoginStatus();

  if (userIsPro) {
    const m = document.getElementById('monthlyBtn');
    const y = document.getElementById('yearlyBtn');
    if (m) { m.textContent = '✨ You are Pro'; m.className = 'plan-btn free'; m.style.pointerEvents = 'none'; }
    if (y) { y.textContent = '✨ You are Pro'; y.className = 'plan-btn free'; y.style.pointerEvents = 'none'; }
    document.getElementById('monthlyPaypalBtn').style.display = 'none';
    document.getElementById('yearlyPaypalBtn').style.display = 'none';
    return;
  }
  if (!loggedIn) {
    const m = document.getElementById('monthlyBtn');
    const y = document.getElementById('yearlyBtn');
    if (m) { m.textContent = 'Sign in to Subscribe'; m.href = '/auth/google'; }
    if (y) { y.textText = 'Sign in to Subscribe'; y.href = '/auth/google'; }
    document.getElementById('monthlyPaypalBtn').style.display = 'none';
    document.getElementById('yearlyPaypalBtn').style.display = 'none';
    return;
  }
  // Logged in but not Pro: show PayPal buttons
  initPayPal();
}

function getSessionToken() {
  return localStorage.getItem('sessionToken');
}

async function initPayPal() {
  const token = getSessionToken();
  if (!token) return;

  document.getElementById('monthlyLoading').style.display = 'block';
  document.getElementById('yearlyLoading').style.display = 'block';

  // Hide default buttons when PayPal renders
  document.getElementById('monthlyBtn').style.display = 'none';
  document.getElementById('yearlyBtn').style.display = 'none';

  try {
    // Create subscriptions on server side
    const [monthlyRes, yearlyRes] = await Promise.all([
      fetch('/api/paypal/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planType: 'monthly', sessionToken: token }),
      }),
      fetch('/api/paypal/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planType: 'yearly', sessionToken: token }),
      }),
    ]);

    const monthlyData = await monthlyRes.json();
    const yearlyData = await yearlyRes.json();

    document.getElementById('monthlyLoading').style.display = 'none';
    document.getElementById('yearlyLoading').style.display = 'none';

    if (monthlyData.approvalUrl) {
      document.getElementById('monthlyPaypalBtn').innerHTML = '<a href="' + monthlyData.approvalUrl + '" class="plan-btn pro" style="display:inline-block;text-align:center;">✨ Subscribe Monthly ($4.99/mo)</a>';
    }

    if (yearlyData.approvalUrl) {
      document.getElementById('yearlyPaypalBtn').innerHTML = '<a href="' + yearlyData.approvalUrl + '" class="plan-btn pro" style="display:inline-block;text-align:center;">✨ Subscribe Yearly ($39.99/yr)</a>';
    }
  } catch (e) {
    console.error('PayPal init error:', e);
    document.getElementById('monthlyLoading').style.display = 'none';
    document.getElementById('yearlyLoading').style.display = 'none';
    // Fall back to default links
    document.getElementById('monthlyBtn').style.display = 'block';
    document.getElementById('yearlyBtn').style.display = 'block';
  }
}

updateBtns().catch(console.error);
</script>
</body>
</html>`;
