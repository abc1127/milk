/* ────────────────────────────────────────────────────────────────
 * voice-tts.js · 真实语音模块
 *   - MyMemory 翻译中文 → 日语（免费，无需注册）
 *   - 语气后处理：去敬语，调整为冷漠/嘴硬/命令式混合风格
 *   - MiniMax TTS 生成日语语音 + 声音克隆
 *   - 生成的音频 blob 缓存在内存，同一条消息不重复请求
 * ──────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    // ─────────── 存储 Key ───────────
    const STORE_KEY = 'voiceTtsConfig';

    // ─────────── 内存音频缓存：msgId → blob URL ───────────
    const _audioCache = {};

    // ─────────── 读写配置 ───────────
    function _getConfig() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    }

    function _saveConfig(cfg) {
        localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    }

    function getTtsConfig() { return _getConfig(); }

    function saveTtsConfig(minimaxKey, groupId, voiceId, model) {
        _saveConfig({ minimaxKey, groupId, voiceId, model: model || 'speech-02-turbo' });
    }

    function isTtsReady() {
        const c = _getConfig();
        return !!(c.minimaxKey && c.groupId && c.voiceId);
    }

    // ─────────── 语气后处理：去敬语 + 傲娇/冷漠/命令式 ───────────
    function _adjustTone(text) {
        const rules = [
            // ── 去除敬语词尾 ──
            [/です(?!か)/g,      'だ'],
            [/ですか[？?]/g,     'か？'],
            [/ですか$/g,         'か'],
            [/ですね/g,          'だな'],
            [/ですよ/g,          'だぞ'],
            [/ません/g,          'ない'],
            [/ますか[？?]/g,     'るか？'],
            [/ます(?!か)/g,      'る'],
            [/でしょう/g,        'だろ'],
            [/ましょう/g,        'ぞ'],
            [/ました/g,          'た'],
            [/ませんでした/g,    'なかった'],

            // ── 请求/命令语气 ──
            [/てください/g,      'ろ'],
            [/でください/g,      'ろ'],
            [/てくださいね/g,    'ろよ'],
            [/お願いします/g,    '頼む'],
            [/お願いいたします/g,'頼む'],

            // ── 感谢/道歉 → 傲娇版 ──
            [/ありがとうございます/g, '…感謝してやる'],
            [/ありがとう/g,      '…まあ、感謝する'],
            [/すみません/g,      '悪かった'],
            [/申し訳ありません/g,'悪かった'],
            [/ごめんなさい/g,    '悪かったな'],
            [/ごめん/g,          '悪い'],

            // ── 温柔表达 → 冷漠版 ──
            [/いただけます/g,    'くれ'],
            [/よろしいでしょうか/g, 'いいか'],
            [/よろしくお願いします/g, 'よろしく'],
            [/かもしれません/g,  'かもな'],
            [/かもしれない/g,    'かもな'],

            // ── 语气词微调 ──
            [/わかりました/g,    'わかった'],
            [/そうですね/g,      'そうだな'],
            [/そうですよ/g,      'そうだ'],
            [/なるほどですね/g,  'なるほどな'],
            [/本当ですか/g,      '本当か'],
            [/大丈夫ですか/g,    '大丈夫か'],
            [/大丈夫です/g,      '大丈夫だ'],
        ];

        let result = text;
        for (const [pattern, replacement] of rules) {
            result = result.replace(pattern, replacement);
        }
        return result;
    }

    // ─────────── MyMemory 翻译（免费，无需注册）───────────
    async function translateToJapanese(text) {
        const encoded = encodeURIComponent(text);
        const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=zh|ja`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`MyMemory 翻译请求失败 (${res.status})`);

        const data = await res.json();
        if (data.responseStatus !== 200) {
            throw new Error(`MyMemory 翻译失败: ${data.responseDetails || '未知错误'}`);
        }

        return _adjustTone(data.responseData.translatedText);
    }

    // ─────────── MiniMax TTS ───────────
    async function generateSpeech(japaneseText) {
        const { minimaxKey, groupId, voiceId, model } = _getConfig();
        if (!minimaxKey || !groupId || !voiceId) throw new Error('未配置 MiniMax Key、Group ID 或 Voice ID');
        const modelName = model || 'speech-02-turbo';

        const res = await fetch(`https://api.minimax.chat/v1/t2a_v2?GroupId=${groupId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${minimaxKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelName,
                text: japaneseText,
                stream: false,
                voice_setting: {
                    voice_id: voiceId,
                    speed: 1.0,
                    vol: 1.0,
                    pitch: 0
                },
                audio_setting: {
                    audio_sample_rate: 32000,
                    bitrate: 128000,
                    format: 'mp3'
                }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`MiniMax TTS 失败 (${res.status}): ${err}`);
        }

        const data = await res.json();
        if (!data.data || !data.data.audio) {
            throw new Error('MiniMax TTS 返回数据异常');
        }

        // MiniMax 返回 hex 编码的音频，需要转成 blob
        const hex = data.data.audio;
        const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        const blob = new Blob([bytes], { type: 'audio/mp3' });
        return URL.createObjectURL(blob);
    }

    // ─────────── 主入口：翻译 + TTS（带缓存）───────────
    async function getAudioForMessage(msgId, chineseText) {
        if (_audioCache[msgId]) return _audioCache[msgId];

        const japaneseText = await translateToJapanese(chineseText);
        const blobUrl = await generateSpeech(japaneseText);
        _audioCache[msgId] = blobUrl;
        return blobUrl;
    }

    // ─────────── 声音克隆：上传音频 → 返回 Voice ID ───────────
    async function cloneVoice(audioFile, voiceName) {
        const { minimaxKey, groupId } = _getConfig();
        if (!minimaxKey || !groupId) throw new Error('请先填写 MiniMax API Key 和 Group ID');

        // 第一步：上传音频文件
        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('purpose', 'voice_clone');

        const uploadRes = await fetch(`https://api.minimax.chat/v1/files/upload?GroupId=${groupId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${minimaxKey}` },
            body: formData
        });

        if (!uploadRes.ok) {
            const err = await uploadRes.text();
            throw new Error(`音频上传失败 (${uploadRes.status}): ${err}`);
        }

        const uploadData = await uploadRes.json();
        const fileId = uploadData.file?.file_id;
        if (!fileId) throw new Error('音频上传失败：未获取到 file_id');

        // 第二步：创建声音克隆
        const cloneRes = await fetch(`https://api.minimax.chat/v1/voice_clone?GroupId=${groupId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${minimaxKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                file_id: fileId,
                voice_name: voiceName || '梦角'
            })
        });

        if (!cloneRes.ok) {
            const err = await cloneRes.text();
            throw new Error(`声音克隆失败 (${cloneRes.status}): ${err}`);
        }

        const cloneData = await cloneRes.json();
        const newVoiceId = cloneData.voice_id || cloneData.input_sensitive_type;
        if (!newVoiceId) throw new Error('克隆失败：未获取到 voice_id');
        return newVoiceId;
    }

    // ─────────── 试听：用一句傲娇风格的日语测试 ───────────
    async function previewClonedVoice(voiceId) {
        const { minimaxKey, groupId, model } = _getConfig();
        if (!minimaxKey || !groupId) throw new Error('未配置 MiniMax Key 或 Group ID');
        const modelName = model || 'speech-02-turbo';
        const previewText = 'おい、ちゃんと聞いてるか。…まあ、会えてよかったけどな。';

        const res = await fetch(`https://api.minimax.chat/v1/t2a_v2?GroupId=${groupId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${minimaxKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelName,
                text: previewText,
                stream: false,
                voice_setting: {
                    voice_id: voiceId,
                    speed: 1.0,
                    vol: 1.0,
                    pitch: 0
                },
                audio_setting: {
                    audio_sample_rate: 32000,
                    bitrate: 128000,
                    format: 'mp3'
                }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`试听失败 (${res.status}): ${err}`);
        }

        const data = await res.json();
        if (!data.data || !data.data.audio) throw new Error('试听返回数据异常');

        const hex = data.data.audio;
        const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        const blob = new Blob([bytes], { type: 'audio/mp3' });
        return URL.createObjectURL(blob);
    }

    // ─────────── 暴露给外部 ───────────
    window.voiceTTS = {
        isTtsReady,
        getTtsConfig,
        saveTtsConfig,
        getAudioForMessage,
        cloneVoice,
        previewClonedVoice,
        translateToJapanese
    };

})();
