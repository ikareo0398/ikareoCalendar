require('dotenv').config();
const fs = require('fs').promises;
const { google } = require('googleapis');
const https = require('https');
const { Client, GatewayIntentBits } = require('discord.js');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const CREDENTIALS_PATH = 'credentials.json';
const TOKEN_PATH = 'token.json';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// --- Gemini解析 ---
async function analyzeWithGemini(text) {
    const apiKey = process.env.GEMINI_API_KEY;
    // モデル名を 1.5-flash に固定し、APIキーを確実に渡す
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const today = new Date().toLocaleDateString('ja-JP');

    const prompt = `今日の日付は${today}です。
    以下のテキストを解析し、予定なら以下のJSON形式「だけ」で答えて。余計な説明は禁止。
    {"summary": "タイトル", "start": "YYYY-MM-DDTHH:mm:ss", "end": "YYYY-MM-DDTHH:mm:ss"}
    もし予定でない場合は ignore とだけ返して。
    テキスト: "${text}"`;

    const data = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

    return new Promise((resolve) => {
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    
                    // --- 【重要】APIエラーのチェックを追加 ---
                    if (json.error) {
                        console.error("❌ Gemini APIエラー:", json.error.message);
                        return resolve(null);
                    }
                    if (!json.candidates || json.candidates.length === 0) {
                        console.error("❌ Geminiからの回答が空です。APIキーやモデル設定を確認してください。");
                        return resolve(null);
                    }

                    let raw = json.candidates[0].content.parts[0].text.trim();
                    if (raw.toLowerCase().includes('ignore')) return resolve(null);
                    
                    const jsonMatch = raw.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        resolve(JSON.parse(jsonMatch[0]));
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    console.log("解析エラー:", e.message);
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => {
            console.error("通信エラー:", e.message);
            resolve(null);
        });
        req.write(data);
        req.end();
    });
}

// --- カレンダー登録 ---
async function registerToCalendar(details) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const { client_id, client_secret, redirect_uris } = keys.installed || keys.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(JSON.parse(await fs.readFile(TOKEN_PATH)));
    const calendar = google.calendar({ version: 'v3', auth });
    return await calendar.events.insert({
        calendarId: 'primary',
        resource: {
            summary: details.summary,
            start: { dateTime: details.start, timeZone: 'Asia/Tokyo' },
            end: { dateTime: details.end, timeZone: 'Asia/Tokyo' }
        }
    });
}

// --- メイン処理 ---
client.once('ready', () => {
    console.log(`✅ Bot起動: ${client.user.tag}`);
    console.log(`監視対象チャンネルID: ${process.env.TARGET_CHANNEL_ID}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // デバッグ用ログ
    console.log(`--- メッセージ受信 ---`);
    console.log(`ID: ${message.channel.id} / 内容: ${message.content}`);

    // IDが一致するか判定
    if (message.channel.id !== process.env.TARGET_CHANNEL_ID) {
        console.log("判定: チャンネルIDが違うため無視します。");
        return;
    }

    console.log("判定: IDが一致しました。Geminiで解析します...");
    const details = await analyzeWithGemini(message.content);

    if (details) {
        console.log("解析結果:", details);
        const statusMsg = await message.reply("⏳ カレンダーに登録中...");
        try {
            const res = await registerToCalendar(details);
            await statusMsg.edit(`✅ 登録完了！\n📌 **${details.summary}**\n📅 ${details.start}\n🔗 [カレンダー](${res.data.htmlLink})`);
            console.log("✅ 登録成功！");
        } catch (e) {
            console.error("❌ 登録失敗:", e.message);
            await statusMsg.edit(`❌ カレンダー登録に失敗しました。`);
        }
    } else {
        console.log("判定: 予定とはみなされませんでした。");
    }
});

client.login(process.env.DISCORD_TOKEN);