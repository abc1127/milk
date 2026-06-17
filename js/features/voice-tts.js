/* ────────────────────────────────────────────────────────────────
 * voice-tts.js · 真实语音模块
 *   - DeepL 翻译中文 → 日语（随意体）
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

    function saveTtsConfig(elevenKey, voiceId, deeplKey) {
        _saveConfig({ elevenKey, voiceId, deeplKey });
    }

    function isTtsReady() {
        const c = _getConfig();
        return !!(c.elevenKey && c.voiceId && c.deeplKey);
    }

    // ─────────── DeepL 翻译 ───────────
    async function translateToJapanese(text) {
        const { deeplKey } = _getConfig();
        if (!deeplKey) throw new Error('未配置 DeepL API Key');

        // DeepL 免费版域名是 api-free.deepl.com
        const res = await fetch('https://api-free.deepl.com/v2/translate', {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${deeplKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: [text],
                target_lang: 'JA',
                formality: 'less'   // 关闭敬语，用随意体
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`DeepL 翻译失败 (${res.status}): ${err}`);
        }

        const data = await res.json();
        return data.translations[0].text;
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

    // ─────────── 试听：用固定的一句日语测试声音效果 ───────────
    async function previewClonedVoice(voiceId) {
        const { elevenKey } = _getConfig();
        if (!elevenKey) throw new Error('未配置 ElevenLabs API Key');

        const previewText = 'ねえ、今日も会えて嬉しいよ。';

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
