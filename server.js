const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// 갤러리 저장 경로 (Railway Volume: /data, 없으면 로컬)
const GALLERY_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'gallery')
  : path.join(__dirname, 'gallery');
const META_FILE = path.join(GALLERY_DIR, '_meta.json');

if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });
app.use('/gallery-files', express.static(GALLERY_DIR));

// multer 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, GALLERY_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
  catch { return []; }
}
function writeMeta(data) {
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

// 갤러리 목록 조회
app.get('/api/gallery', (req, res) => {
  const meta = readMeta();
  const tag = req.query.tag;
  const result = tag ? meta.filter(m => m.tags.includes(tag)) : meta;
  res.json(result.reverse());
});

// 갤러리 이미지 업로드
app.post('/api/gallery/upload', upload.array('images', 20), (req, res) => {
  const meta = readMeta();
  const tags = req.body.tags ? req.body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const added = req.files.map(f => ({
    id: f.filename,
    filename: f.filename,
    originalName: f.originalname,
    url: `/gallery-files/${f.filename}`,
    tags,
    size: f.size,
    uploadedAt: new Date().toISOString(),
  }));
  meta.push(...added);
  writeMeta(meta);
  res.json({ success: true, added });
});

// 갤러리 이미지 삭제
app.delete('/api/gallery/:id', (req, res) => {
  let meta = readMeta();
  const item = meta.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: '없음' });
  try { fs.unlinkSync(path.join(GALLERY_DIR, item.filename)); } catch {}
  meta = meta.filter(m => m.id !== req.params.id);
  writeMeta(meta);
  res.json({ success: true });
});

// 태그 수정
app.patch('/api/gallery/:id/tags', (req, res) => {
  const meta = readMeta();
  const item = meta.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: '없음' });
  item.tags = req.body.tags || [];
  writeMeta(meta);
  res.json({ success: true, item });
});

// Giphy URL → 갤러리에 저장
app.post('/api/gallery/giphy', async (req, res) => {
  const { gifUrl, title, tags=[] } = req.body;
  if(!gifUrl) return res.status(400).json({ error: 'gifUrl 필요' });
  try {
    const response = await fetch(gifUrl);
    if(!response.ok) throw new Error('GIF 다운로드 실패: '+response.status);
    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const filename = `giphy_${Date.now()}_${Math.random().toString(36).slice(2,7)}.gif`;
    const filepath = path.join(GALLERY_DIR, filename);
    fs.writeFileSync(filepath, buffer);

    const meta = readMeta();
    const item = {
      id: filename,
      filename,
      originalName: title || 'giphy.gif',
      url: `/gallery-files/${filename}`,
      tags: [...new Set([...tags, 'Giphy', 'GIF'])],
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
      source: 'giphy',
    };
    meta.push(item);
    writeMeta(meta);
    res.json({ success: true, item });
  } catch(e) {
    console.error('[Giphy 저장 오류]', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// Gemini 이미지 생성 중계
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
