/* ────────────────────────────────────────────────────────────────
 * 首页改造 · 梦角伪语音模块
 *   - 对方文本消息 20% 概率渲染成语音条样式（下方贴原文字）
 *   - 用户没有发语音的功能
 *   - 点击伪语音条：
 *       有 TTS 配置 → 翻译成日语 → ElevenLabs 生成真实语音播放
 *       无配置     → 假装播放（按时长走完）
 * ──────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    const FAKE_VOICE_PROBABILITY = 0.20;
    const FAKE_VOICE_KEY = 'fakeVoiceEnabled';

    function _isFakeVoiceOn() {
        const stored = localStorage.getItem(FAKE_VOICE_KEY);
        return stored === null ? true : stored === 'true';
    }

    function _syncFakeVoiceUI() {
        const row = document.getElementById('fake-voice-toggle');
        if (row) row.classList.toggle('active', _isFakeVoiceOn());
    }

    window._toggleFakeVoice = function() {
        localStorage.setItem(FAKE_VOICE_KEY, String(!_isFakeVoiceOn()));
        _syncFakeVoiceUI();
    };

    // 页面加载后同步开关状态
    document.addEventListener('DOMContentLoaded', _syncFakeVoiceUI);
    setTimeout(_syncFakeVoiceUI, 500);

    function ready(fn) {
        if (document.readyState !== 'loading') {
            setTimeout(fn, 80);
        } else {
            document.addEventListener('DOMContentLoaded', () => setTimeout(fn, 80));
        }
    }

    ready(function init() {
        const chatContainer = document.getElementById('chat-container');
        if (!chatContainer) return;

        // ─────────── 视频通话按钮：调用项目内置的发起通话函数 ───────────
        const videocallBtn = document.getElementById('videocall-btn');
        if (videocallBtn) {
            videocallBtn.addEventListener('click', () => {
                if (window.callFeature && typeof window.callFeature.startCall === 'function') {
                    window.callFeature.startCall(false);
                } else {
                    if (typeof showNotification === 'function') {
                        showNotification('视频通话功能未就绪', 'error');
                    }
                }
            });
        }

        // ─────────── 监听新消息：决定是否变成伪语音 + 渲染气泡 ───────────
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((m) => {
                m.addedNodes.forEach((node) => {
                    if (!(node instanceof HTMLElement)) return;
                    if (node.classList && node.classList.contains('message-wrapper')) {
                        maybeFakeVoiceForPartner(node);
                        renderVoiceIfNeeded(node);
                    }
                });
            });
        });
        observer.observe(chatContainer, { childList: true });

        // 启动时扫一遍（处理刷新后从数据恢复的消息）
        chatContainer.querySelectorAll('.message-wrapper').forEach(renderVoiceIfNeeded);

        // ─────────── 对方文本消息 → 20% 概率改成伪语音 ───────────
        function maybeFakeVoiceForPartner(wrapper) {
            if (!wrapper.classList.contains('received')) return;
            const msgId = wrapper.dataset.msgId || wrapper.dataset.id;
            if (!msgId) return;
            const msg = findMessage(msgId);
            if (!msg) return;
            if (msg.voice || msg.image || msg.type === 'system') return;
            if (!msg.text || !msg.text.trim()) return;
            if (msg._fakeVoiceConsidered) return;
            msg._fakeVoiceConsidered = true;

            // 语音消息开关关闭时跳过
            if (!_isFakeVoiceOn()) return;

            // 陪伴页激活时，不改造为伪语音（陪伴中梦角的回复永远是文字）
            const companionPage = document.getElementById('companion-page');
            if (companionPage && companionPage.classList.contains('active')) return;

            if (Math.random() >= FAKE_VOICE_PROBABILITY) return;

            // 时长根据字数算 = 字数/3 + 随机 0-3 秒（最少 1 秒）
            const textLen = msg.text.trim().length;
            const duration = Math.max(1, Math.floor(textLen / 3) + Math.floor(Math.random() * 4));
            msg.voice = {
                url: '',
                duration: duration,
                fakeText: msg.text,
                transcript: ''
            };
            msg.text = '';
            if (typeof throttledSaveData === 'function') throttledSaveData();
        }

        // ─────────── 把语音消息渲染成气泡 ───────────
        function renderVoiceIfNeeded(wrapper) {
            const msgId = wrapper.dataset.msgId || wrapper.dataset.id;
            if (!msgId) return;
            const msg = findMessage(msgId);
            if (!msg || !msg.voice) return;
            if (wrapper.dataset.voiceRendered === '1') return;
            wrapper.dataset.voiceRendered = '1';

            const bubble = wrapper.querySelector('.message');
            if (!bubble) return;

            wrapper.classList.add('has-voice');

            const duration = msg.voice.duration || 0;
            const fakeText = msg.voice.fakeText || '';
            const widthPx = Math.round(80 + Math.min(duration, 60) / 60 * 120);

            // 仿微信的"倒下的 wifi"声波弧（对方语音，图标朝右）
            const waveSvg = `
                <svg class="voice-bubble-wifi" viewBox="0 0 22 22" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="6" cy="11" r="1.3" fill="currentColor" stroke="none"/>
                    <path d="M10 8 A 3.5 3.5 0 0 1 10 14"/>
                    <path d="M13 5 A 7 7 0 0 1 13 17"/>
                </svg>
            `;

            bubble.innerHTML = `
                <div class="voice-bubble" data-fake="1" data-duration="${duration}" data-msg-id="${msgId}" style="width:${widthPx}px;">
                    ${waveSvg}
                    <span class="voice-bubble-duration">${duration}"</span>
                </div>
                ${fakeText ? `<div class="voice-fake-text">${escapeHtml(fakeText)}</div>` : ''}
            `;
        }

        // ─────────── 当前播放的 Audio 对象 ───────────
        let _currentAudio = null;
        let currentBubble = null;

        function _stopCurrentAudio() {
            if (_currentAudio) {
                _currentAudio.pause();
                _currentAudio = null;
            }
            if (currentBubble) {
                currentBubble.classList.remove('playing', 'tts-loading');
                if (currentBubble._fakeTimer) {
                    clearTimeout(currentBubble._fakeTimer);
                    currentBubble._fakeTimer = null;
                }
                currentBubble = null;
            }
        }

        // ─────────── 点击语音条 ───────────
        document.body.addEventListener('click', async (e) => {
            const bubble = e.target.closest('.voice-bubble');
            if (!bubble) return;

            // 正在加载中，忽略重复点击
            if (bubble.classList.contains('tts-loading')) return;

            // 已在播这个 → 停
            if (currentBubble === bubble && bubble.classList.contains('playing')) {
                _stopCurrentAudio();
                return;
            }

            // 停掉之前的
            _stopCurrentAudio();

            const duration = Number(bubble.dataset.duration) || 3;
            const msgId = bubble.dataset.msgId;

            // ── 有 TTS 配置：走真实语音 ──
            if (window.voiceTTS && window.voiceTTS.isTtsReady() && msgId) {
                const msg = findMessage(msgId);
                const textToSpeak = msg && msg.voice && msg.voice.fakeText
                    ? msg.voice.fakeText
                    : null;

                if (textToSpeak) {
                    currentBubble = bubble;
                    bubble.classList.add('tts-loading');

                    try {
                        const audioUrl = await window.voiceTTS.getAudioForMessage(msgId, textToSpeak);
                        // 加载期间用户可能已点别处
                        if (currentBubble !== bubble) return;

                        bubble.classList.remove('tts-loading');
                        bubble.classList.add('playing');

                        const audio = new Audio(audioUrl);
                        _currentAudio = audio;
                        audio.play();
                        audio.onended = () => {
                            bubble.classList.remove('playing');
                            if (currentBubble === bubble) currentBubble = null;
                            if (_currentAudio === audio) _currentAudio = null;
                        };
                        audio.onerror = () => {
                            bubble.classList.remove('playing');
                            if (currentBubble === bubble) currentBubble = null;
                            if (_currentAudio === audio) _currentAudio = null;
                            if (typeof showNotification === 'function') {
                                showNotification('语音播放失败', 'error');
                            }
                        };
                    } catch (err) {
                        bubble.classList.remove('tts-loading', 'playing');
                        currentBubble = null;
                        console.error('[voice-tts] 生成语音失败:', err);
                        if (typeof showNotification === 'function') {
                            showNotification('语音生成失败，请检查 API 配置', 'error');
                        }
                    }
                    return;
                }
            }

            // ── 无配置：假装播放 ──
            currentBubble = bubble;
            bubble.classList.add('playing');
            bubble._fakeTimer = setTimeout(() => {
                bubble.classList.remove('playing');
                bubble._fakeTimer = null;
                if (currentBubble === bubble) currentBubble = null;
            }, duration * 1000);
        });

        // ─────────── helpers ───────────
        function findMessage(id) {
            if (typeof messages === 'undefined' || !Array.isArray(messages)) return null;
            return messages.find(m => String(m.id) === String(id));
        }
        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
    });
})();
