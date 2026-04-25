require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

// LINE SDK設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// GitHub設定
const GITHUB = {
  token: process.env.GITHUB_TOKEN,
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
};

// ============================================================
// グループごとの最近のテキストメッセージを記録（イベント検出用）
// ============================================================
const recentMessages = {}; // groupId -> [{text, timestamp, senderName}]
const MAX_MSG_BUFFER = 20;
const MSG_WINDOW_MS = 60 * 60 * 1000; // 1時間以内のメッセージを参照

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '松島会アルバムBot 稼働中' });
});

// LINE Webhook エンドポイント（express.json()より前に配置すること！）
// ※ line.middleware が raw body を必要とするため、
//    express.json() がWebhookより先に適用されると署名検証が壊れる
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('イベント処理エラー:', err.message);
    }
  }
});

// メタデータ更新API（ギャラリーからの編集用）
// ※ express.json() はWebhookルートの後に配置
app.use(express.json());

app.post('/api/update-meta', async (req, res) => {
  try {
    const { filename, event, memo } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const meta = await getMetadata();
    if (meta[filename]) {
      if (event !== undefined) meta[filename].event = event;
      if (memo !== undefined) meta[filename].memo = memo;
    }
    await saveMetadata(meta);
    res.json({ ok: true });
  } catch (err) {
    console.error('メタデータ更新失敗:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || 'direct';
  const senderId = event.source.userId;
  const msgType = event.message.type;

  // テキストメッセージ → バッファに記録（イベント検出用）
  if (msgType === 'text') {
    let senderName = 'メンバー';
    try {
      if (event.source.type === 'group') {
        const profile = await lineClient.getGroupMemberProfile(groupId, senderId);
        senderName = profile.displayName;
      }
    } catch (e) {}

    if (!recentMessages[groupId]) recentMessages[groupId] = [];
    recentMessages[groupId].push({
      text: event.message.text,
      timestamp: event.timestamp,
      senderName,
    });
    // バッファ制限
    if (recentMessages[groupId].length > MAX_MSG_BUFFER) {
      recentMessages[groupId].shift();
    }
    return;
  }

  // 画像と動画のみ処理
  if (msgType !== 'image' && msgType !== 'video') return;

  const messageId = event.message.id;
  const isVideo = msgType === 'video';

  console.log(`${isVideo ? '動画' : '画像'}受信: messageId=${messageId}, sender=${senderId}`);

  // 送信者の表示名を取得
  let senderName = 'メンバー';
  try {
    if (event.source.type === 'group') {
      const profile = await lineClient.getGroupMemberProfile(groupId, senderId);
      senderName = profile.displayName;
    } else if (event.source.type === 'user') {
      const profile = await lineClient.getProfile(senderId);
      senderName = profile.displayName;
    }
  } catch (e) {
    console.warn('プロフィール取得失敗:', e.message);
  }

  // イベント情報を検出
  const eventInfo = detectEvent(groupId, event.timestamp);

  // LINEからコンテンツをダウンロード
  const contentBuffer = await downloadLineContent(messageId);
  if (!contentBuffer) return;

  // GitHubにアップロード
  const ext = isVideo ? 'mp4' : 'jpg';
  const filename = generateFilename(senderId, ext);
  const label = isVideo ? '動画' : '写真';
  const uploaded = await uploadToGitHub(filename, contentBuffer, senderName, label);

  if (uploaded) {
    // メタデータに追加
    const now = new Date(event.timestamp);
    const meta = await getMetadata();
    meta[filename] = {
      sender: senderName,
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
      event: eventInfo,
      memo: '',
      type: isVideo ? 'video' : 'image',
    };
    await saveMetadata(meta);
    console.log(`✅ アップロード完了: ${filename} (from ${senderName}, event: ${eventInfo})`);
  }
}

// ============================================================
// イベント検出: 最近のメッセージから日付やイベント名を推定
// ============================================================
function detectEvent(groupId, currentTimestamp) {
  const messages = recentMessages[groupId] || [];
  const recent = messages.filter(m => currentTimestamp - m.timestamp < MSG_WINDOW_MS);

  // 全メッセージのテキストを結合
  const allText = recent.map(m => m.text).join(' ');

  // 日付パターンを検出
  const datePatterns = [
    /(\d{1,2})月(\d{1,2})日/,
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
  ];

  let detectedDate = '';
  for (const p of datePatterns) {
    const m = allText.match(p);
    if (m) {
      detectedDate = m[0];
      break;
    }
  }

  // イベントキーワードを検出
  const eventKeywords = [
    '忘年会', '新年会', '歓迎会', '送別会', '花見', 'お花見',
    '飲み会', '食事会', '旅行', '合宿', 'BBQ', 'バーベキュー',
    '誕生日', 'バースデー', '結婚式', '二次会',
    'ゴルフ', '釣り', 'キャンプ', 'ハイキング',
    '同窓会', '松島', '温泉', 'カラオケ',
    'クリスマス', 'ハロウィン', '正月',
    '祝い', '記念', 'パーティ', '集まり', '会合',
    'ランチ', 'ディナー', '焼肉', '寿司', '鍋',
  ];

  let detectedEvent = '';
  for (const kw of eventKeywords) {
    if (allText.includes(kw)) {
      detectedEvent = kw;
      break;
    }
  }

  // メッセージ内容からイベント名を構築
  if (detectedEvent && detectedDate) {
    return `${detectedDate} ${detectedEvent}`;
  } else if (detectedEvent) {
    return detectedEvent;
  } else if (detectedDate) {
    return detectedDate;
  }

  // 検出できない場合は投稿日を返す
  const now = new Date(currentTimestamp);
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}/${mo}/${d}の投稿`;
}

// ============================================================
// GitHubのメタデータJSON管理
// ============================================================
async function getMetadata() {
  const url = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/contents/photos-meta.json`;
  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB.token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const data = JSON.parse(content);
    data._sha = res.data.sha;
    return data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw err;
  }
}

async function saveMetadata(meta) {
  const sha = meta._sha;
  delete meta._sha;

  const url = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/contents/photos-meta.json`;
  const content = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');

  const body = {
    message: '📝 メタデータ更新',
    content,
  };
  if (sha) body.sha = sha;

  await axios.put(url, body, {
    headers: {
      Authorization: `Bearer ${GITHUB.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

// LINEからコンテンツをダウンロード
async function downloadLineContent(messageId) {
  try {
    const stream = await blobClient.getMessageContent(messageId);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('コンテンツダウンロード失敗:', err.message);
    return null;
  }
}

// タイムスタンプベースのファイル名を生成
function generateFilename(senderId, ext) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  const suffix = senderId.slice(-4);
  return `${ts}_${suffix}.${ext}`;
}

// GitHubリポジトリにコンテンツをプッシュ
async function uploadToGitHub(filename, buffer, senderName, label) {
  const path = `photos/${filename}`;
  const content = buffer.toString('base64');
  const url = `https://api.github.com/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${path}`;

  try {
    await axios.put(url, {
      message: `${label === '動画' ? '🎬' : '📸'} ${senderName}さんの${label}を追加`,
      content: content,
    }, {
      headers: {
        Authorization: `Bearer ${GITHUB.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return true;
  } catch (err) {
    console.error('GitHub アップロード失敗:', err.response?.data?.message || err.message);
    return false;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
