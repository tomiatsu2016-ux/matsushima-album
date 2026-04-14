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

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '松島会アルバムBot 稼働中' });
});

// LINE Webhook エンドポイント
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200); // LINEには即座に200を返す

  const events = req.body.events;
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('イベント処理エラー:', err.message);
    }
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const msgType = event.message.type;
  // 画像と動画のみ処理
  if (msgType !== 'image' && msgType !== 'video') return;

  const messageId = event.message.id;
  const senderId = event.source.userId;
  const isVideo = msgType === 'video';

  console.log(`${isVideo ? '動画' : '画像'}受信: messageId=${messageId}, sender=${senderId}`);

  // 送信者の表示名を取得（グループの場合）
  let senderName = 'メンバー';
  try {
    if (event.source.type === 'group') {
      const profile = await lineClient.getGroupMemberProfile(
        event.source.groupId,
        senderId
      );
      senderName = profile.displayName;
    } else if (event.source.type === 'user') {
      const profile = await lineClient.getProfile(senderId);
      senderName = profile.displayName;
    }
  } catch (e) {
    console.warn('プロフィール取得失敗:', e.message);
  }

  // LINEからコンテンツをダウンロード
  const contentBuffer = await downloadLineContent(messageId);
  if (!contentBuffer) return;

  // GitHubにアップロード
  const ext = isVideo ? 'mp4' : 'jpg';
  const filename = generateFilename(senderId, ext);
  const label = isVideo ? '動画' : '写真';
  const uploaded = await uploadToGitHub(filename, contentBuffer, senderName, label);

  if (uploaded) {
    console.log(`✅ アップロード完了: ${filename} (from ${senderName})`);
  }
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
