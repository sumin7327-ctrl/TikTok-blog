const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Anthropic API 중계
app.post('/api/generate', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.body.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        messages: req.body.messages,
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gemini 이미지 생성 중계 (CORS 우회)
app.post('/api/image', async (req, res) => {
  const { geminiKey, prompt } = req.body;
  const models = [
    'gemini-2.0-flash-exp-image-generation',
    'gemini-2.5-flash-preview-05-20',
    'gemini-3.1-flash-image-preview',
  ];

  const errors = [];
  for (const model of models) {
    try {
      console.log(`[이미지] 모델 시도: ${model}`);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
        }
      );
      const data = await response.json();
      console.log(`[이미지] ${model} 응답:`, JSON.stringify(data).slice(0, 300));
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (imagePart) {
        return res.json({ success: true, image: imagePart.inlineData });
      }
      errors.push(`${model}: 이미지 파트 없음 — ${JSON.stringify(data?.error || data?.candidates?.[0]?.finishReason || '응답이상')}`);
    } catch (e) {
      console.error(`[이미지] ${model} 오류:`, e.message);
      errors.push(`${model}: ${e.message}`);
    }
  }
  console.error('[이미지] 모든 모델 실패:', errors);
  res.status(500).json({ error: '이미지 생성 실패', details: errors });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));
