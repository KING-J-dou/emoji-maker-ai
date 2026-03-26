const API_BASE = 'https://emoji-maker-ai.king-j-dou.workers.dev';
let selectedStyle = 'emoji';
let selectedMood = '';
let history = [];
let isGenerating = false;

// DOM
const promptEl = document.getElementById('prompt');
const charCountEl = document.getElementById('charCount');
const generateBtn = document.getElementById('generateBtn');
const btnText = document.getElementById('btnText');
const btnLoading = document.getElementById('btnLoading');
const resultArea = document.getElementById('resultArea');
const resultImg = document.getElementById('resultImg');
const historyArea = document.getElementById('historyArea');
const historyGrid = document.getElementById('historyGrid');
const quotaLeft = document.getElementById('quotaLeft');
const quotaModal = document.getElementById('quotaModal');

// 字数统计
promptEl.addEventListener('input', () => {
  charCountEl.textContent = promptEl.value.length;
});

// 风格/表情选择
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

// 生成
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
    // 构建完整 prompt
    const fullPrompt = buildPrompt(prompt, selectedStyle, selectedMood);

    const res = await fetch(API_BASE + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: fullPrompt })
    });

    const data = await res.json();

    if (res.status === 429) {
      showQuotaModal();
      return;
    }

    if (!res.ok || data.error) {
      throw new Error(data.error || '生成失败，请重试');
    }

    // 显示结果
    showResult(data.imageUrl, prompt);
    updateQuota(data.remaining);

  } catch (err) {
    alert(err.message || '生成失败，请重试');
  } finally {
    setLoading(false);
  }
}

function buildPrompt(text, style, mood) {
  let p = `${style}, ${text}`;
  if (mood) p += `, ${mood} expression`;
  p += ', white background, high quality, clean';
  return p;
}

function showResult(url, prompt) {
  resultImg.src = url;
  resultImg.alt = prompt;
  resultArea.classList.remove('hidden');
  resultArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // 加入历史
  addToHistory(url, prompt);
}

function addToHistory(url, prompt) {
  history.unshift({ url, prompt });
  if (history.length > 6) history.pop();
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) return;
  historyArea.style.display = 'block';
  historyGrid.innerHTML = history.map((item, i) => `
    <div class="history-item" onclick="viewHistory(${i})" title="${item.prompt}">
      <img src="${item.url}" alt="${item.prompt}" loading="lazy">
    </div>
  `).join('');
}

window.viewHistory = function(i) {
  const item = history[i];
  resultImg.src = item.url;
  resultImg.alt = item.prompt;
  resultArea.classList.remove('hidden');
  resultArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// 下载
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const url = resultImg.src;
  if (!url) return;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'emoji.png';
    a.click();
  } catch {
    // 跨域时直接打开
    window.open(url, '_blank');
  }
});

// 重新生成
document.getElementById('generateAgainBtn').addEventListener('click', generate);

// 额度
function updateQuota(remaining) {
  if (remaining !== undefined) {
    quotaLeft.textContent = remaining;
  }
}

// 超限弹窗
function showQuotaModal() {
  quotaModal.classList.remove('hidden');
}

document.getElementById('closeModal').addEventListener('click', () => {
  quotaModal.classList.add('hidden');
});

// 加载状态
function setLoading(loading) {
  isGenerating = loading;
  generateBtn.disabled = loading;
  btnText.classList.toggle('hidden', loading);
  btnLoading.classList.toggle('hidden', !loading);
}

// 初始化：获取剩余次数
async function initQuota() {
  try {
    const res = await fetch(API_BASE + '/api/quota');
    const data = await res.json();
    updateQuota(data.remaining);
  } catch {}
}

initQuota();
