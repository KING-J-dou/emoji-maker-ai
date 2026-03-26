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

// 生成 Emoji
async function handleGenerate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  
  const quota = await checkQuota(ip, env);
  if (quota.remaining <= 0) {
    return jsonResponse({ error: 'Daily quota exceeded' }, 429);
  }

  const { prompt } = await request.json();
  if (!prompt || prompt.length > 500) {
    return jsonResponse({ error: 'Invalid prompt' }, 400);
  }

  try {
    const imageUrl = await generateEmoji(prompt, env);
    await decrementQuota(ip, env);
    const newQuota = await checkQuota(ip, env);
    return jsonResponse({ imageUrl, remaining: newQuota.remaining });
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
    const emojiPrompt = `${prompt}, emoji art, kawaii style, flat design, vibrant colors, clean line art, white background, high quality, sticker`;
    const result = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
      prompt: emojiPrompt,
      seed: seed,
    });

    // AI.run() 返回 Uint8Array 或 {image: Uint8Array} 或 ReadableStream
    let imageData;
    if (result instanceof Uint8Array) {
      imageData = result;
    } else if (result && result.image instanceof Uint8Array) {
      imageData = result.image;
    } else if (result && typeof result.getReader === 'function') {
      // ReadableStream
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

// Cloudflare Workers AI
async function generateEmoji(prompt, env) {
  const seed = Math.floor(Math.random() * 999999999);
  const emojiPrompt = `${prompt}, emoji art, kawaii style, flat design, vibrant colors, clean line art, white background, high quality, sticker`;
  
  const response = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
    prompt: emojiPrompt,
    seed: seed,
  });

  // Workers AI stable-diffusion-xl 返回 Uint8Array
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
      // 某些版本返回 { image: Uint8Array }
      imageBytes = response.image instanceof Uint8Array ? response.image : new Uint8Array(Object.values(response.image));
    } else {
      // 最后兜底
      const vals = Object.values(response);
      imageBytes = new Uint8Array(vals);
    }
  } catch (e) {
    throw new Error('Failed to decode image: ' + e.message);
  }

  if (!imageBytes || imageBytes.length === 0) throw new Error('Empty image data from AI');

  // 转 base64
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
  if (!data || data.date !== today) return { remaining: 6, date: today };
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

// 内嵌 HTML（包含 CSS 和 JS）
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Emoji Maker AI</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }
header { background: linear-gradient(135deg, #6c63ff 0%, #e040fb 100%); text-align: center; padding: 32px 20px; color: white; }
header h1 { font-size: 2.2rem; margin-bottom: 8px; }
header p { opacity: 0.85; font-size: 1rem; }
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
<div id="quotaInfo" class="quota-info">今日剩余免费次数：<strong id="quotaLeft">6</strong> 次</div>
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
<p>每天免费生成 3 次，明天可继续使用</p>
<button id="closeModal" class="btn-primary">知道了</button>
</div>
</div>
</main>
<script>
const API_BASE = '';
let selectedStyle = 'emoji';
let selectedMood = '';
let isGenerating = false;

const promptEl = document.getElementById('prompt');
const charCountEl = document.getElementById('charCount');
const generateBtn = document.getElementById('generateBtn');
const btnText = document.getElementById('btnText');
const btnLoading = document.getElementById('btnLoading');
const resultArea = document.getElementById('resultArea');
const resultImg = document.getElementById('resultImg');
const quotaLeft = document.getElementById('quotaLeft');
const quotaModal = document.getElementById('quotaModal');

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

    const res = await fetch(API_BASE + '/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fullPrompt })
    });

    if (res.status === 429) {
      showQuotaModal();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '生成失败，请重试');
    }

    const remaining = res.headers.get('X-Remaining');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    showResult(blobUrl, prompt);
    updateQuota(remaining ? parseInt(remaining) : undefined);

  } catch (err) {
    alert(err.message || '生成失败，请重试');
  } finally {
    setLoading(false);
  }
}

function buildPrompt(text, style, mood) {
  let p = style + ', ' + text;
  if (mood) p += ', ' + mood + ' expression';
  p += ', white background, high quality, clean';
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

function updateQuota(remaining) {
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
    const res = await fetch(API_BASE + '/api/quota');
    const data = await res.json();
    updateQuota(data.remaining);
  } catch {}
}

initQuota();
</script>
</body>
</html>`;
