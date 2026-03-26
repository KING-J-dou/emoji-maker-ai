// Replicate API 调用
async function generateEmoji(prompt, apiToken) {
  // 创建预测
  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: 'fofr/emoji-maker',
      input: { prompt }
    })
  });

  if (!createRes.ok) {
    throw new Error('Failed to create prediction');
  }

  const prediction = await createRes.json();
  const predictionId = prediction.id;

  // 轮询结果（最多等待 60 秒）
  for (let i = 0; i < 30; i++) {
    await sleep(2000);

    const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Token ${apiToken}` }
    });

    const status = await statusRes.json();

    if (status.status === 'succeeded') {
      return status.output[0]; // 返回图片 URL
    }

    if (status.status === 'failed' || status.status === 'canceled') {
      throw new Error('Generation failed');
    }
  }

  throw new Error('Generation timeout');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 额度管理
async function checkQuota(ip, env) {
  const key = `quota:${ip}`;
  const today = new Date().toISOString().split('T')[0];
  
  const data = await env.QUOTA_KV.get(key, 'json');
  
  if (!data || data.date !== today) {
    return { remaining: 3, date: today };
  }
  
  return data;
}

async function decrementQuota(ip, env) {
  const key = `quota:${ip}`;
  const quota = await checkQuota(ip, env);
  
  const newQuota = {
    remaining: Math.max(0, quota.remaining - 1),
    date: quota.date
  };
  
  await env.QUOTA_KV.put(key, JSON.stringify(newQuota), {
    expirationTtl: 86400 // 24 小时后过期
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
