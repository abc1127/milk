/* ────────────────────────────────────────────────────────────────
 * voice-tts.js · 真实语音模块
 *   - MyMemory 翻译中文 → 日语（免费，无需注册）
 *   - 语气后处理：去敬语，调整为冷漠/嘴硬/命令式混合风格
 *   - ElevenLabs TTS 生成日语语音
 *   - ElevenLabs 声音克隆（上传音频 → 生成 Voice ID）
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

    function saveTtsConfig(elevenKey, voiceId) {
        _saveConfig({ elevenKey, voiceId });
    }

    function isTtsReady() {
        const c = _getConfig();
        return !!(c.elevenKey && c.voiceId);
    }

    // ─────────── 语气后处理：去敬语 + 傲娇/冷漠/命令式 ───────────
    // 想调整语气风格，修改这里的替换规则就好
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
            [/〜ていただけますか/g, 'か'],
            [/いただけます/g,    'くれ'],
            [/よろしいでしょうか/g, 'いいか'],
            [/よろしくお願いします/g, 'よろしく'],
            [/〜かもしれません/g, 'かもな'],
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

            // ── 冷漠短句收尾 ──
            [/〜ですが/g,        'だが'],
            [/〜ますが/g,        'るが'],
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
        if (!res.ok) {
            throw new Error(`MyMemory 翻译请求失败 (${res.status})`);
        }

        const data = await res.json();
        if (data.responseStatus !== 200) {
            throw new Error(`MyMemory 翻译失败: ${data.responseDetails || '未知错误'}`);
        }

        const translated = data.responseData.translatedText;
        // 翻译后进行语气后处理
        return _adjustTone(translated);
    }

    // ─────────── ElevenLabs TTS ───────────
    async function generateSpeech(japaneseText) {
        const { elevenKey, voiceId } = _getConfig();
        if (!elevenKey || !voiceId) throw new Error('未配置 ElevenLabs Key 或 Voice ID');

        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': elevenKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: japaneseText,
                model_id: 'eleven_turbo_v2_5',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`ElevenLabs TTS 失败 (${res.status}): ${err}`);
        }

        const audioBlob = await res.blob();
        return URL.createObjectURL(audioBlob);
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
        const { elevenKey } = _getConfig();
        if (!elevenKey) throw new Error('请先填写 ElevenLabs API Key');

        const formData = new FormData();
        formData.append('name', voiceName || '梦角');
        formData.append('files', audioFile);
        formData.append('description', 'Cloned voice for companion app');

        const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
            method: 'POST',
            headers: { 'xi-api-key': elevenKey },
            body: formData
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`声音克隆失败 (${res.status}): ${err}`);
        }

        const data = await res.json();
        return data.voice_id;
    }

    // ─────────── 试听：用一句符合梦角风格的日语测试 ───────────
    async function previewClonedVoice(voiceId) {
        const { elevenKey } = _getConfig();
        if (!elevenKey) throw new Error('未配置 ElevenLabs API Key');

        // 傲娇风格试听句
        const previewText = 'おい、ちゃんと聞いてるか。…まあ、会えてよかったけどな。';

        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': elevenKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: previewText,
                model_id: 'eleven_turbo_v2_5',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`试听失败 (${res.status}): ${err}`);
        }

        const blob = await res.blob();
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
