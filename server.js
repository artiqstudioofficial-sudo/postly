import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// SERVE FRONTEND STATIC FILES IN PRODUCTION
const distPath = path.resolve('dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth-callback';

// 1. UPLOAD LOCAL MEDIA FILE TO PUBLIC HOST (FOR INSTAGRAM / FB GRAPH API)
app.post('/api/upload', async (req, res) => {
  const { dataUrl, filename } = req.body;
  if (!dataUrl) {
    return res.status(400).json({ error: 'Missing dataUrl' });
  }

  try {
    if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
      return res.json({ success: true, url: dataUrl });
    }

    const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid base64 data format' });
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    const safeName = filename || `upload-${Date.now()}.${mimeType.split('/')[1] || 'png'}`;

    const blob = new Blob([buffer], { type: mimeType });
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('time', '72h');
    formData.append('fileToUpload', blob, safeName);

    const uploadRes = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
      method: 'POST',
      body: formData
    });

    const publicUrl = await uploadRes.text();
    if (publicUrl && publicUrl.startsWith('http')) {
      return res.json({ success: true, url: publicUrl.trim() });
    } else {
      return res.json({ success: true, url: dataUrl });
    }
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: err.message, fallbackUrl: dataUrl });
  }
});

// 2. GET META OAUTH URL
app.get('/api/channels/meta/auth-url', (req, res) => {
  if (!META_APP_ID) {
    return res.status(400).json({ error: 'META_APP_ID not configured in .env' });
  }

  const scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts'
  ].join(',');

  const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&scope=${encodeURIComponent(scopes)}&response_type=code`;

  res.json({ authUrl });
});

// 3. EXCHANGE CODE FOR ACCESS TOKEN & FETCH REAL ACCOUNTS
app.post('/api/channels/meta/exchange', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI
    )}&code=${code}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('Meta Token Error:', tokenData.error);
      return res.status(400).json({ error: tokenData.error.message });
    }

    const shortToken = tokenData.access_token;
    const longTokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`;
    const longTokenRes = await fetch(longTokenUrl);
    const longTokenData = await longTokenRes.json();
    const userAccessToken = longTokenData.access_token || shortToken;

    // Get User's Facebook Pages & Connected Instagram Accounts
    const pagesUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${userAccessToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    const discoveredAccounts = [];

    if (pagesData.data && Array.isArray(pagesData.data)) {
      pagesData.data.forEach((page) => {
        if (page.name.toLowerCase().includes('rumatemu')) return;

        discoveredAccounts.push({
          id: 'fb-' + page.id,
          platform: 'facebook',
          name: page.name + ' (Halaman Resmi)',
          handle: '@' + page.name.toLowerCase().replace(/\s+/g, ''),
          avatar: `https://graph.facebook.com/v21.0/${page.id}/picture?type=small`,
          accountType: 'page',
          pageId: page.id,
          accessToken: page.access_token,
          isActive: true,
          color: '#1877f2',
          badge: 'f',
          charLimit: 5000
        });

        if (page.instagram_business_account) {
          const ig = page.instagram_business_account;
          discoveredAccounts.push({
            id: 'ig-' + ig.id,
            platform: 'instagram',
            name: ig.username ? `@${ig.username}` : 'Instagram Bisnis',
            handle: '@' + (ig.username || 'instagram'),
            avatar: ig.profile_picture_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
            accountType: 'business',
            igUserId: ig.id,
            pageAccessToken: page.access_token,
            isActive: true,
            color: '#e1306c',
            badge: 'IG',
            charLimit: 2200
          });
        }
      });
    }

    res.json({ success: true, accounts: discoveredAccounts });
  } catch (err) {
    console.error('Exchange error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DIRECT FB PUBLISH HELPER
async function publishFbDirect({ pageId, pageAccessToken, message, imageUrl }) {
  const targetPageId = pageId || '701867863007834';
  const token = pageAccessToken || process.env.META_PAGE_ACCESS_TOKEN_ARTIQ;
  let url = imageUrl
    ? `https://graph.facebook.com/v21.0/${targetPageId}/photos`
    : `https://graph.facebook.com/v21.0/${targetPageId}/feed`;
  let body = imageUrl
    ? { url: imageUrl, caption: message || '', access_token: token }
    : { message: message || '', access_token: token };

  const fbRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await fbRes.json();
}

// DIRECT IG PUBLISH HELPER
async function publishIgDirect({ igUserId, pageAccessToken, caption, imageUrl, postType = 'post', firstComment }) {
  const targetIgUserId = igUserId || process.env.META_IG_USER_ID_ARTIQ || '17841475322023382';
  const targetToken = pageAccessToken || process.env.META_PAGE_ACCESS_TOKEN_ARTIQ;
  const targetImage = imageUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&h=1080&fit=crop';

  let containerParams = { caption: caption || '', access_token: targetToken };
  const isVideo = targetImage.match(/\.(mp4|mov|webm)($|\?)/i) || postType === 'reel';

  if (isVideo) {
    containerParams.media_type = 'REELS';
    containerParams.video_url = targetImage;
    containerParams.share_to_feed = true;
  } else if (postType === 'story') {
    containerParams.media_type = 'STORIES';
    containerParams.image_url = targetImage;
  } else {
    containerParams.image_url = targetImage;
  }

  const containerQuery = new URLSearchParams(containerParams).toString();
  const containerRes = await fetch(`https://graph.facebook.com/v21.0/${targetIgUserId}/media?${containerQuery}`, {
    method: 'POST'
  });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(containerData.error.message);

  const creationId = containerData.id;
  const maxPolls = isVideo ? 12 : 6;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(
      `https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${targetToken}`
    );
    const statusData = await statusRes.json();
    if (statusData.status_code === 'FINISHED') break;
    if (statusData.status_code === 'ERROR') throw new Error('Instagram media processing failed');
  }

  const publishRes = await fetch(
    `https://graph.facebook.com/v21.0/${targetIgUserId}/media_publish?creation_id=${creationId}&access_token=${targetToken}`,
    { method: 'POST' }
  );
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(publishData.error.message);

  if (firstComment && firstComment.trim() && publishData.id) {
    try {
      await fetch(
        `https://graph.facebook.com/v21.0/${publishData.id}/comments?message=${encodeURIComponent(
          firstComment.trim()
        )}&access_token=${targetToken}`,
        { method: 'POST' }
      );
    } catch (e) {}
  }
  return publishData;
}

// 4. PUBLISH TO FACEBOOK PAGE
app.post('/api/publish/facebook', async (req, res) => {
  try {
    const data = await publishFbDirect(req.body);
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ success: true, postId: data.id || data.post_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. PUBLISH TO INSTAGRAM
app.post('/api/publish/instagram', async (req, res) => {
  try {
    const data = await publishIgDirect(req.body);
    res.json({ success: true, postId: data.id, permalink: 'https://www.instagram.com/artiqstudio.official/' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. REAL AUTOMATED BACKGROUND CRON SCHEDULER
let scheduledQueue = [];

// =========================================================================
// 7. REAL MANYCHAT-STYLE INSTAGRAM AUTOMATION ENGINE (META GRAPH API)
// =========================================================================
let automationRules = [
  {
    id: 'auto-1',
    enabled: true,
    type: 'comment_to_dm',
    name: 'Auto-DM Link Brosur Properti & Promo',
    platform: 'instagram',
    keywords: ['mau', 'link', 'info', 'harga', 'promo', 'brosur', 'katalog'],
    publicReply: 'Sudah kami kirimkan detail dan link lengkapnya ke DM kamu ya kak! Silakan cek inbox ya 😊',
    dmMessage: 'Halo kak! Terima kasih sudah komen di @artiqstudio.official. Ini link info lengkap dan diskon booking-nya ya: https://artiqstudio.com/promo 🏡✨',
    buttonText: 'Buka Brosur Promo',
    buttonUrl: 'https://artiqstudio.com/promo',
    triggerCount: 0,
    lastTriggered: null
  },
  {
    id: 'auto-2',
    enabled: true,
    type: 'welcome_dm',
    name: 'Say Hi to New Followers (Welcome DM)',
    platform: 'instagram',
    keywords: [],
    dmMessage: 'Halo kak! Selamat datang di keluarga @artiqstudio.official 👋 Terima kasih sudah follow kami. Ada yang bisa kami bantu seputar jasa kreatif dan properti?',
    buttonText: 'Lihat Portfolio',
    buttonUrl: 'https://artiqstudio.com',
    triggerCount: 0,
    lastTriggered: null
  }
];

let repliedCommentIds = new Set();

// SCAN AND AUTO-RESPOND TO REAL INSTAGRAM COMMENTS ON @artiqstudio.official
async function scanAndReplyInstagramComments() {
  const token = process.env.META_PAGE_ACCESS_TOKEN_ARTIQ;
  const igUserId = process.env.META_IG_USER_ID_ARTIQ || '17841475322023382';
  if (!token || !igUserId) return { checked: 0, triggered: 0 };

  const activeRule = automationRules.find((r) => r.enabled && r.type === 'comment_to_dm');
  if (!activeRule) return { checked: 0, triggered: 0 };

  try {
    const mediaRes = await fetch(
      `https://graph.facebook.com/v21.0/${igUserId}/media?fields=id,caption,permalink,comments{id,text,from,timestamp}&limit=5&access_token=${token}`
    );
    const mediaData = await mediaRes.json();
    if (mediaData.error) {
      console.error(`[ManyChat Engine] ⚠️ Meta API Token Notice: ${mediaData.error.message}`);
      return { checked: 0, triggered: 0, error: mediaData.error.message, code: mediaData.error.code };
    }
    if (!mediaData.data) return { checked: 0, triggered: 0 };

    let totalChecked = 0;
    let totalTriggered = 0;

    for (const item of mediaData.data) {
      const comments = item.comments?.data || [];
      for (const comment of comments) {
        totalChecked++;
        if (repliedCommentIds.has(comment.id)) continue;

        const textLower = (comment.text || '').toLowerCase();
        const matched = activeRule.keywords.some((kw) => textLower.includes(kw.toLowerCase()));

        if (matched) {
          repliedCommentIds.add(comment.id);
          activeRule.triggerCount++;
          activeRule.lastTriggered = new Date().toLocaleTimeString('id-ID');
          totalTriggered++;

          console.log(`\n======================================================`);
          console.log(`[ManyChat Engine] ⚡ Keyword Match Detected!`);
          console.log(`[ManyChat Engine] Post: ${item.permalink}`);
          console.log(`[ManyChat Engine] Komentar: "${comment.text}"`);
          console.log(`======================================================`);

          // 1. Reply publicly on Instagram via Meta Graph API
          try {
            const replyRes = await fetch(
              `https://graph.facebook.com/v21.0/${comment.id}/replies?message=${encodeURIComponent(
                activeRule.publicReply
              )}&access_token=${token}`,
              { method: 'POST' }
            );
            const replyData = await replyRes.json();
            console.log(`[ManyChat Engine] ✅ Sukses Balas Komentar Publik:`, replyData);
          } catch (err) {
            console.error(`[ManyChat Engine] ❌ Error Balas Komentar:`, err.message);
          }

          // 2. Dispatch Direct Message (Private Reply) to Instagram Commenter
          try {
            const pageId = '701867863007834';
            const dmRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages?access_token=${token}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipient: { comment_id: comment.id },
                message: { text: activeRule.dmMessage }
              })
            });
            const dmData = await dmRes.json();
            if (dmData.error) {
              console.error(`[ManyChat Engine] ❌ Meta Gagal Kirim DM:`, dmData.error.message, `(Code: ${dmData.error.code})`);
              if (dmData.error.code === 230) {
                console.error(`[ManyChat Engine] 💡 Solusi: Token membutuhkan izin 'instagram_manage_messages'. Silakan perbarui token dengan mencentang izin tersebut.`);
              }
            } else {
              console.log(`[ManyChat Engine] 🚀 Sukses Mengirim Direct Message (DM) ke user!`, dmData);
            }
          } catch (dmErr) {
            console.error(`[ManyChat Engine] Private DM notice:`, dmErr.message);
          }
        }
      }
    }
    return { checked: totalChecked, triggered: totalTriggered };
  } catch (e) {
    return { checked: 0, triggered: 0, error: e.message };
  }
}

// 7A. GET AUTOMATION STATUS & META TOKEN HEALTH CHECK
app.get('/api/automations/status', async (req, res) => {
  const token = process.env.META_PAGE_ACCESS_TOKEN_ARTIQ;
  let tokenStatus = { valid: false, error: 'No token configured' };

  if (token) {
    try {
      const test = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${token}`);
      const d = await test.json();
      if (d.error) {
        tokenStatus = {
          valid: false,
          error: d.error.message,
          code: d.error.code,
          subcode: d.error.error_subcode
        };
      } else {
        tokenStatus = { valid: true, name: d.name, id: d.id };
      }
    } catch (err) {
      tokenStatus = { valid: false, error: err.message };
    }
  }

  res.json({
    active: true,
    engine: 'Postly Engine v2.0 (Live Meta Graph API)',
    targetAccount: '@artiqstudio.official',
    targetPage: 'Artiq Studio (ID: 701867863007834)',
    tokenStatus,
    rules: automationRules,
    processedCommentsCount: repliedCommentIds.size,
    lastScannedAt: new Date().toISOString()
  });
});

// 7A.1 UPDATE META TOKEN DIRECTLY VIA UI
app.post('/api/channels/meta/update-token', async (req, res) => {
  const { pageAccessToken } = req.body;
  if (!pageAccessToken || !pageAccessToken.trim()) {
    return res.status(400).json({ error: 'Token tidak boleh kosong' });
  }

  try {
    const cleanToken = pageAccessToken.trim();
    const test = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${cleanToken}`);
    const data = await test.json();
    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Set in runtime
    process.env.META_PAGE_ACCESS_TOKEN_ARTIQ = cleanToken;

    // Persist to .env
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      content = content.replace(/META_PAGE_ACCESS_TOKEN_ARTIQ=.*$/m, `META_PAGE_ACCESS_TOKEN_ARTIQ=${cleanToken}`);
      fs.writeFileSync(envPath, content, 'utf8');
    }

    console.log(`[Meta Token] 🔑 Token berhasil diperbarui untuk Page: ${data.name} (${data.id})`);
    res.json({ success: true, pageName: data.name, pageId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7A.2 DERIVE NEVER-EXPIRING PERMANENT PAGE ACCESS TOKEN
app.post('/api/channels/meta/exchange-permanent-token', async (req, res) => {
  const { userToken } = req.body;
  if (!userToken || !userToken.trim()) {
    return res.status(400).json({ error: 'User Token tidak boleh kosong.' });
  }

  const cleanUserToken = userToken.trim();

  try {
    console.log('\n[Meta Permanent Exchange] 🔄 Memulai alur penukaran token permanen...');

    // Step 1: Exchange short-lived token to 60-day Long-Lived User Token
    const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${cleanUserToken}`;
    const exchangeRes = await fetch(exchangeUrl);
    const exchangeData = await exchangeRes.json();

    if (exchangeData.error) {
      console.error('[Meta Permanent Exchange] ❌ Gagal menukar ke Long-Lived Token:', exchangeData.error);
      return res.status(400).json({ error: `Meta Error: ${exchangeData.error.message}` });
    }

    const longLivedUserToken = exchangeData.access_token;
    console.log('[Meta Permanent Exchange] ✅ Berhasil mendapatkan Long-Lived User Token (60 hari).');

    // Step 2: Fetch Page Accounts using the Long-Lived User Token
    // Meta guarantee: Page tokens derived from a Long-Lived User Token NEVER EXPIRE!
    const accountsUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${longLivedUserToken}`;
    const accountsRes = await fetch(accountsUrl);
    const accountsData = await accountsRes.json();

    if (accountsData.error) {
      return res.status(400).json({ error: accountsData.error.message });
    }

    if (!accountsData.data || accountsData.data.length === 0) {
      return res.status(400).json({
        error: 'Tidak ditemukan Facebook Page pada akun ini. Pastikan akun mengelola Halaman Artiq Studio.'
      });
    }

    // Find Artiq Studio or pick the first active page
    const targetPage =
      accountsData.data.find((p) => p.id === '701867863007834' || p.name.toLowerCase().includes('artiq')) ||
      accountsData.data[0];

    const permanentPageToken = targetPage.access_token;
    const igAccount = targetPage.instagram_business_account;

    // Step 3: Debug token with Meta to verify expiration
    const debugUrl = `https://graph.facebook.com/v21.0/debug_token?input_token=${permanentPageToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`;
    const debugRes = await fetch(debugUrl);
    const debugData = await debugRes.json();
    const isNeverExpiring = debugData.data?.expires_at === 0 || !debugData.data?.expires_at;

    console.log(`[Meta Permanent Exchange] 💎 PERMANENT TOKEN SECURED! Page: ${targetPage.name} (Never Expires: ${isNeverExpiring})`);

    // Step 4: Update runtime environment
    process.env.META_PAGE_ACCESS_TOKEN_ARTIQ = permanentPageToken;
    process.env.META_USER_ACCESS_TOKEN = longLivedUserToken;
    if (igAccount?.id) {
      process.env.META_IG_USER_ID_ARTIQ = igAccount.id;
    }

    // Step 5: Save to .env permanently
    const envPath = path.resolve('.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf8');
      content = content.replace(/META_PAGE_ACCESS_TOKEN_ARTIQ=.*$/m, `META_PAGE_ACCESS_TOKEN_ARTIQ=${permanentPageToken}`);
      content = content.replace(/META_USER_ACCESS_TOKEN=.*$/m, `META_USER_ACCESS_TOKEN=${longLivedUserToken}`);
      if (igAccount?.id) {
        content = content.replace(/META_IG_USER_ID_ARTIQ=.*$/m, `META_IG_USER_ID_ARTIQ=${igAccount.id}`);
      }
      fs.writeFileSync(envPath, content, 'utf8');
      console.log('[Meta Permanent Exchange] 💾 File .env berhasil diperbarui dengan Permanent Page Token.');
    }

    res.json({
      success: true,
      pageName: targetPage.name,
      pageId: targetPage.id,
      igUsername: igAccount?.username || 'artiqstudio.official',
      igUserId: igAccount?.id || '17841475322023382',
      expiresIn: isNeverExpiring ? 'Never (Permanen Selamanya)' : '60 Hari Auto-Renew',
      message: 'Token Permanen Meta berhasil dibuat dan disimpan!'
    });
  } catch (err) {
    console.error('[Meta Permanent Exchange] ❌ Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7B. SYNC / UPDATE AUTOMATION RULES FROM FRONTEND
app.post('/api/automations/rules', (req, res) => {
  const { rules } = req.body;
  if (Array.isArray(rules)) {
    automationRules = rules;
    console.log(`[ManyChat Engine] 🔄 Synced ${rules.length} automation rules.`);
  }
  res.json({ success: true, rules: automationRules });
});

// 7C. TRIGGER IMMEDIATE COMMENT SCAN
app.post('/api/automations/scan', async (req, res) => {
  const result = await scanAndReplyInstagramComments();
  res.json({
    success: true,
    ...result,
    rules: automationRules
  });
});

// 7D. TEST TRIGGER SIMULATOR (CALLABLE DIRECTLY FROM FRONTEND TERMINAL)
app.post('/api/automations/test-trigger', async (req, res) => {
  const { username, commentText, ruleId } = req.body;
  const activeRule =
    automationRules.find((r) => r.id === ruleId && r.enabled) ||
    automationRules.find((r) => r.enabled && r.type === 'comment_to_dm') ||
    automationRules[0];

  const userText = commentText || 'Mau info link brosur diskonnya dong kak!';
  const targetUser = username || '@nandaaldoariiansyah';

  const textLower = userText.toLowerCase();
  const matchedKeyword = (activeRule.keywords || []).find((kw) => textLower.includes(kw.toLowerCase()));

  const logs = [];
  logs.push(`[1] 📥 Komentar baru terdeteksi dari ${targetUser}: "${userText}"`);

  if (matchedKeyword) {
    logs.push(`[2] 🔍 Analisis Kata Kunci: Cocok dengan keyword "${matchedKeyword.toUpperCase()}"! Memulai otomasi ManyChat...`);
    logs.push(`[3] 💬 Mengirim Balasan Komentar Publik: "${activeRule.publicReply}"`);
    logs.push(
      `[4] 🚀 Sukses Mengirim Instagram Direct Message (DM) ke ${targetUser}! Link CTA: [${activeRule.buttonText || 'Buka Link'}] (${activeRule.buttonUrl || 'https://artiqstudio.com'})`
    );
    activeRule.triggerCount++;
    activeRule.lastTriggered = 'Baru saja';
  } else {
    logs.push(
      `[2] ℹ️ Kata kunci tidak cocok. Pemicu yang aktif: ${(activeRule.keywords || []).join(', ')}. Tidak ada balasan otomatis dikirim.`
    );
  }

  res.json({
    success: true,
    matched: Boolean(matchedKeyword),
    matchedKeyword: matchedKeyword || null,
    logs,
    rule: activeRule
  });
});

// 7E. META WEBHOOK VERIFICATION (FOR META DEVELOPERS / MANYCHAT INTEGRATION)
app.get('/api/webhooks/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'omnipulse_verify_token_2026') {
    console.log('[Webhook] Instagram Webhook Verified successfully!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 7F. META WEBHOOK EVENT RECEIVER
app.post('/api/webhooks/instagram', async (req, res) => {
  const body = req.body;
  console.log('[Webhook] Incoming Instagram event:', JSON.stringify(body));
  if (body.object === 'instagram') {
    await scanAndReplyInstagramComments();
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// PERIODIC BACKGROUND CHECK: AUTO-RESPOND COMMENTS EVERY 30 SECONDS
setInterval(async () => {
  await scanAndReplyInstagramComments();
}, 30000);

app.post('/api/scheduler/sync', (req, res) => {
  const { posts } = req.body;
  if (Array.isArray(posts)) {
    scheduledQueue = posts.filter((p) => p.status === 'scheduled');
    console.log(`[Scheduler] 🕒 Synced ${scheduledQueue.length} scheduled posts.`);
  }
  res.json({ success: true, queuedCount: scheduledQueue.length });
});

app.get('/api/scheduler/status', (req, res) => {
  res.json({
    active: true,
    currentTime: new Date().toISOString(),
    queuedCount: scheduledQueue.length,
    queue: scheduledQueue.map((p) => ({
      id: p.id,
      scheduledAt: p.scheduledAt,
      channels: p.targetChannels
    }))
  });
});

// BACKGROUND INTERVAL: CHECK EVERY 15 SECONDS
setInterval(async () => {
  if (scheduledQueue.length === 0) return;
  const now = new Date();

  for (const post of scheduledQueue) {
    if (post.status === 'scheduled' && post.scheduledAt) {
      const scheduledDate = new Date(post.scheduledAt);
      if (now >= scheduledDate) {
        console.log(`\n======================================================`);
        console.log(`[Auto-Pilot Cron] ⏰ WAKTUNYA TAYANG: Post ${post.id}`);
        console.log(`[Auto-Pilot Cron] Konten: "${post.content.slice(0, 50)}..."`);
        console.log(`======================================================`);

        post.status = 'published';
        post.publishedAt = now.toISOString();

        // 1. Publish to Facebook if selected
        if (post.targetChannels?.some((ch) => ch.includes('fb') || ch === 'ch-meta-1')) {
          try {
            await publishFbDirect({
              message: post.content,
              imageUrl: post.mediaUrls?.[0] || null
            });
            console.log(`[Auto-Pilot Cron] ✅ Sukses Auto-Post ke Facebook Page Artiq Studio!`);
          } catch (e) {
            console.error(`[Auto-Pilot Cron] ❌ FB Error:`, e.message);
          }
        }

        // 2. Publish to Instagram if selected
        if (post.targetChannels?.some((ch) => ch.includes('ig') || ch === 'ch-meta-ig')) {
          try {
            await publishIgDirect({
              caption: post.content,
              imageUrl: post.mediaUrls?.[0] || null,
              postType: post.postType || 'post',
              firstComment: post.firstComment || ''
            });
            console.log(`[Auto-Pilot Cron] ✅ Sukses Auto-Post ke Instagram @artiqstudio.official!`);
          } catch (e) {
            console.error(`[Auto-Pilot Cron] ❌ IG Error:`, e.message);
          }
        }
      }
    }
  }
}, 15000);

// SPA Fallback for all non-API web routes
if (fs.existsSync(distPath)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Postly Backend API Server running on http://localhost:${PORT}`);
  console.log(`[Auto-Pilot Cron Engine] 🟢 Active & watching for scheduled posts every 15s`);
});
