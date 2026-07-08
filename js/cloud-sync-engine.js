/**
 * cloud-sync-engine.js — 阶段二：文字数据实时同步引擎
 *
 * 依赖：CloudSync（阶段一）、localforage、APP_PREFIX
 *
 * 职责：
 *   1. 收集本地所有"文字类"数据，打包成一个 JSON
 *   2. 通过阿里云 OSS V4 签名上传到 Bucket 的 sync/text-data.json
 *   3. 触发时机：本地写入后 3 秒防抖 / 页面隐藏 / 启动检测
 *   4. 静默恢复：启动时若本地空但云端有数据，弹窗询问是否恢复
 *   5. 状态：exposed via CloudSync.getSyncStatus()，UI 主动读取
 *
 * 完全后台运行，不弹 Toast、不闪图标、不打断用户。
 * 唯一会打扰用户的是：连续失败 → 数据管理面板显示不显眼红点。
 */
(function (global) {
    'use strict';

    // ==== 常量 ====
    var APP_PREFIX_STR = (typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'CHAT_APP_V3_');

    // 云端对象命名：按 SESSION_ID 隔离两个梦角
    function _syncObjectKey() {
        var sid = (typeof SESSION_ID !== 'undefined' && SESSION_ID) ? SESSION_ID : 'default';
        return 'sync/' + sid + '/text-data.json';
    }

    // "文字类"数据的键名匹配规则（按 SESSION_ID 前缀过滤后再匹配）
    // 图片/音频类不在此列表 → 留给阶段三
    var TEXT_KEY_NEEDLES = [
        // 聊天
        'chatMessages', 'sessionList', 'chatSettings', 'showPartnerNameInChat',
        'envelopeData', 'pending_envelope',
        // 回复 / 氛围
        'customReplies', 'customPokes', 'customStatuses', 'customMottos',
        'customIntros', 'customEmojis',
        'customReplyGroups', 'customPokeGroups', 'customStatusGroups',
        // 纪念日
        'anniversaries',
        // 心情手账（不含图片）
        'moodCalendar', 'customMoodOptions', 'moodTrash',
        // 主题配置（不含图片本身）
        'customThemes', 'themeSchemes', 'partnerPersonas',
        // 陪伴日记文字（背景图独立存，未来阶段三处理）
        'companionData', 'companionDiary'
    ];

    // localStorage 中的文字类键
    var TEXT_LS_KEYS = [
        'groupChatSettings',
        'disabledReplyItems', 'pokeSym_my', 'pokeSym_partner',
        'pokeSym_my_custom', 'pokeSym_partner_custom',
        'disabledStickerItems',
        'dg_custom_data', 'dg_status_pool', 'weekly_fortune', 'daily_fortune',
        'voiceTtsConfig'
    ];
    // localStorage 前缀匹配
    var TEXT_LS_PREFIXES = ['customWeather_'];

    // 同步状态（内存）
    var _state = {
        lastSyncAt: null,          // Date | null
        lastSyncOk: null,          // true | false | null
        lastError: null,           // string | null
        consecutiveFailures: 0,
        syncing: false,
        pendingTimer: null,
        pendingReason: null,       // 'change' | 'visibility' | 'manual'
        restoreOffered: false,     // 本次会话是否已经询问过恢复
        listeners: [],
        // ready 标记：只有 SESSION_ID 就绪 + 启动检测完成后才允许触发同步。
        // 避免 app 启动加载数据时被误认为"数据变化"，把 pending 表覆盖到云端。
        ready: false
    };

    // 防抖延迟（数据变化后）
    var DEBOUNCE_MS = 3000;
    // 静默失败告警阈值（连续失败几次才提示）
    var FAIL_ALERT_THRESHOLD = 3;

    // ==== 状态通知 ====
    function _notify() {
        for (var i = 0; i < _state.listeners.length; i++) {
            try {
                _state.listeners[i]({
                    lastSyncAt: _state.lastSyncAt,
                    lastSyncOk: _state.lastSyncOk,
                    lastError: _state.lastError,
                    consecutiveFailures: _state.consecutiveFailures,
                    syncing: _state.syncing,
                    hasFailAlert: _state.consecutiveFailures >= FAIL_ALERT_THRESHOLD
                });
            } catch (e) {}
        }
    }

    function onSyncStatusChange(fn) {
        if (typeof fn === 'function') _state.listeners.push(fn);
    }

    function getSyncStatus() {
        return {
            lastSyncAt: _state.lastSyncAt,
            lastSyncOk: _state.lastSyncOk,
            lastError: _state.lastError,
            consecutiveFailures: _state.consecutiveFailures,
            syncing: _state.syncing,
            hasFailAlert: _state.consecutiveFailures >= FAIL_ALERT_THRESHOLD
        };
    }

    // ==== 判断某个 localforage key 是否属于"文字类" ====
    function _isTextKey(key) {
        // 只处理带 APP_PREFIX 的键
        if (key.indexOf(APP_PREFIX_STR) !== 0) return false;

        // SESSION_ID 隔离：只同步当前 SESSION 的数据
        var sid = (typeof SESSION_ID !== 'undefined' && SESSION_ID) ? SESSION_ID : null;
        if (sid) {
            var expectedPrefix = APP_PREFIX_STR + sid + '_';
            if (key.indexOf(expectedPrefix) !== 0) return false;
        }

        // 是否匹配任一文字类键名
        for (var i = 0; i < TEXT_KEY_NEEDLES.length; i++) {
            if (key.indexOf(TEXT_KEY_NEEDLES[i]) !== -1) return true;
        }
        return false;
    }

    // ==== 收集本地文字类数据 ====
    async function _collectTextData() {
        var payload = {
            version: 1,
            sessionId: (typeof SESSION_ID !== 'undefined' ? SESSION_ID : null),
            savedAt: new Date().toISOString(),
            indexedDB: {},
            localStorage: {}
        };

        // localforage
        try {
            var keys = await localforage.keys();
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (!_isTextKey(k)) continue;
                try {
                    var v = await localforage.getItem(k);
                    if (v !== undefined) payload.indexedDB[k] = v;
                } catch (e) {
                    console.warn('[cloud-sync-engine] 读取失败', k, e);
                }
            }
        } catch (e) {
            console.warn('[cloud-sync-engine] 遍历 localforage 失败', e);
        }

        // localStorage
        try {
            for (var j = 0; j < localStorage.length; j++) {
                var lk = localStorage.key(j);
                if (!lk) continue;
                var match = false;
                if (TEXT_LS_KEYS.indexOf(lk) !== -1) match = true;
                else {
                    for (var p = 0; p < TEXT_LS_PREFIXES.length; p++) {
                        if (lk.indexOf(TEXT_LS_PREFIXES[p]) === 0) { match = true; break; }
                    }
                }
                if (!match) continue;
                try {
                    payload.localStorage[lk] = localStorage.getItem(lk);
                } catch (e) {}
            }
        } catch (e) {}

        return payload;
    }

    // ==== 上传到 OSS ====
    async function _uploadToOSS(jsonString) {
        var cfg = window.CloudSync && window.CloudSync.getConfig();
        if (!cfg || !window.CloudSync.isConnected()) {
            throw new Error('未连接云端');
        }
        var objectKey = _syncObjectKey();
        var url = await window.CloudSync.buildSignedUrl(cfg, 'PUT', objectKey, {});
        // 注意：不加 Content-Type 头。因为 V4 签名只签了 host，加额外 header 会导致 CanonicalHeaders 不匹配。
        // OSS 允许无 Content-Type 的 PUT，会按默认存储。
        var res = await fetch(url, {
            method: 'PUT',
            body: jsonString
        });
        if (!res.ok) {
            var text = '';
            try { text = await res.text(); } catch (e) {}
            throw new Error('上传失败：HTTP ' + res.status + (text ? ' - ' + text.slice(0, 200) : ''));
        }
        return true;
    }

    // ==== 从 OSS 下载 ====
    async function _downloadFromOSS() {
        var cfg = window.CloudSync && window.CloudSync.getConfig();
        if (!cfg || !window.CloudSync.isConnected()) {
            throw new Error('未连接云端');
        }
        var objectKey = _syncObjectKey();
        var url = await window.CloudSync.buildSignedUrl(cfg, 'GET', objectKey, {});
        var res = await fetch(url, { method: 'GET' });
        if (res.status === 404) return null; // 云端没有数据
        if (!res.ok) {
            throw new Error('下载失败：HTTP ' + res.status);
        }
        var text = await res.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error('云端数据格式错误');
        }
    }

    // ==== 应用从云端拉回的数据 ====
    async function _applyRemoteData(payload) {
        if (!payload || typeof payload !== 'object') return 0;
        var count = 0;
        // indexedDB
        if (payload.indexedDB) {
            for (var k in payload.indexedDB) {
                if (!Object.prototype.hasOwnProperty.call(payload.indexedDB, k)) continue;
                try {
                    await localforage.setItem(k, payload.indexedDB[k]);
                    count++;
                } catch (e) {
                    console.warn('[cloud-sync-engine] 写入失败', k, e);
                }
            }
        }
        // localStorage
        if (payload.localStorage) {
            for (var lk in payload.localStorage) {
                if (!Object.prototype.hasOwnProperty.call(payload.localStorage, lk)) continue;
                try {
                    var v = payload.localStorage[lk];
                    if (v == null) localStorage.removeItem(lk);
                    else localStorage.setItem(lk, v);
                    count++;
                } catch (e) {}
            }
        }
        return count;
    }

    // ==== 主同步动作（异步，不抛错） ====
    async function _doSync(reason) {
        if (_state.syncing) return;
        if (!window.CloudSync || !window.CloudSync.isConnected()) return;
        // SESSION_ID 未就绪时不同步（避免读取到错误的 session 数据）
        if (typeof SESSION_ID === 'undefined' || !SESSION_ID) return;

        _state.syncing = true;
        _notify();
        try {
            var payload = await _collectTextData();
            var jsonString = JSON.stringify(payload);
            await _uploadToOSS(jsonString);

            _state.lastSyncAt = new Date();
            _state.lastSyncOk = true;
            _state.lastError = null;
            _state.consecutiveFailures = 0;
        } catch (e) {
            _state.lastSyncOk = false;
            _state.lastError = String(e && e.message || e);
            _state.consecutiveFailures++;
            console.warn('[cloud-sync-engine] 同步失败（第 ' + _state.consecutiveFailures + ' 次）:', e);
        } finally {
            _state.syncing = false;
            _notify();
        }
    }

    // ==== 触发（防抖） ====
    function _scheduleSync(reason, immediate) {
        if (!window.CloudSync || !window.CloudSync.isConnected()) return;
        // 未就绪时不同步：避免 app 启动加载数据时被误触发
        if (!_state.ready && reason === 'change') return;
        if (_state.pendingTimer) {
            clearTimeout(_state.pendingTimer);
            _state.pendingTimer = null;
        }
        if (immediate) {
            _doSync(reason);
        } else {
            _state.pendingReason = reason;
            _state.pendingTimer = setTimeout(function () {
                _state.pendingTimer = null;
                _doSync(reason);
            }, DEBOUNCE_MS);
        }
    }

    function requestSync() { _scheduleSync('manual', false); }
    function requestSyncNow() { _scheduleSync('manual', true); }

    // ==== 监听 localforage 写入（Hook） ====
    // 通过包装 localforage.setItem / removeItem 来监听变化
    function _hookLocalforage() {
        if (typeof localforage === 'undefined') return;
        if (localforage.__cloudSyncHooked) return;
        localforage.__cloudSyncHooked = true;

        var origSetItem = localforage.setItem.bind(localforage);
        var origRemoveItem = localforage.removeItem.bind(localforage);

        localforage.setItem = function (key, value, cb) {
            var p = origSetItem(key, value, cb);
            if (typeof key === 'string' && _isTextKey(key)) {
                _scheduleSync('change', false);
            }
            return p;
        };
        localforage.removeItem = function (key, cb) {
            var p = origRemoveItem(key, cb);
            if (typeof key === 'string' && _isTextKey(key)) {
                _scheduleSync('change', false);
            }
            return p;
        };
    }

    // ==== 监听 localStorage 写入 ====
    // Safari 里直接给 localStorage.setItem 赋值可能失败，用 Storage.prototype 覆盖更稳
    function _hookLocalStorage() {
        if (window.__cloudSyncLSHooked) return;
        try {
            window.__cloudSyncLSHooked = true;
            var proto = Storage.prototype;
            var origSet = proto.setItem;
            var origRemove = proto.removeItem;

            function _matchLS(k) {
                if (TEXT_LS_KEYS.indexOf(k) !== -1) return true;
                for (var p = 0; p < TEXT_LS_PREFIXES.length; p++) {
                    if (k.indexOf(TEXT_LS_PREFIXES[p]) === 0) return true;
                }
                return false;
            }

            proto.setItem = function (key, value) {
                var r = origSet.call(this, key, value);
                if (this === window.localStorage && typeof key === 'string' && _matchLS(key)) {
                    _scheduleSync('change', false);
                }
                return r;
            };
            proto.removeItem = function (key) {
                var r = origRemove.call(this, key);
                if (this === window.localStorage && typeof key === 'string' && _matchLS(key)) {
                    _scheduleSync('change', false);
                }
                return r;
            };
        } catch (e) {
            console.warn('[cloud-sync-engine] Hook localStorage 失败', e);
        }
    }

    // ==== 页面隐藏时立即同步 ====
    function _hookVisibility() {
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                // 强制立即同步（如果有 pending 的话）
                if (_state.pendingTimer) {
                    clearTimeout(_state.pendingTimer);
                    _state.pendingTimer = null;
                    _scheduleSync('visibility', true);
                }
            }
        });
        // pagehide 事件更可靠（iOS Safari 关闭页签时）
        window.addEventListener('pagehide', function () {
            if (_state.pendingTimer) {
                clearTimeout(_state.pendingTimer);
                _state.pendingTimer = null;
                _scheduleSync('visibility', true);
            }
        });
    }

    // ==== 启动检测：本地空但云端有 → 询问恢复 ====
    async function _checkRestoreOnStart() {
        if (_state.restoreOffered) return;
        if (!window.CloudSync || !window.CloudSync.isConnected()) {
            // 未连接也允许后续同步（连接后会自动重跑本函数）
            _state.ready = true;
            return;
        }
        // 等 SESSION_ID 就绪（app 初始化异步）
        if (typeof SESSION_ID === 'undefined' || !SESSION_ID) {
            setTimeout(_checkRestoreOnStart, 1000);
            return;
        }

        // 判断本地是否为"空"：只要有 chatMessages 或 sessionList 就算非空
        try {
            var keys = await localforage.keys();
            var hasLocalData = false;
            for (var i = 0; i < keys.length; i++) {
                if (!_isTextKey(keys[i])) continue;
                if (keys[i].indexOf('chatMessages') !== -1 || keys[i].indexOf('sessionList') !== -1) {
                    hasLocalData = true;
                    break;
                }
            }
            if (hasLocalData) {
                _state.ready = true;
                return;
            }

            // 本地空，检查云端
            var remote = await _downloadFromOSS();
            if (!remote) {
                _state.ready = true;
                return;
            }
            _state.restoreOffered = true;

            var savedAt = remote.savedAt ? new Date(remote.savedAt).toLocaleString('zh-CN') : '未知';
            var msg = '检测到云端有数据，是否恢复到本设备？\n\n云端最后同步时间：' + savedAt +
                      '\n\n（恢复后请刷新页面以生效）';
            if (confirm(msg)) {
                var count = await _applyRemoteData(remote);
                alert('已恢复 ' + count + ' 项数据。\n请刷新页面以生效。');
            }
            _state.ready = true;
        } catch (e) {
            console.warn('[cloud-sync-engine] 启动检测失败', e);
            _state.ready = true; // 出错也标记就绪，不然永远不同步
        }
    }

    // ==== 手动恢复（数据管理入口） ====
    async function manualRestore() {
        if (!window.CloudSync || !window.CloudSync.isConnected()) {
            throw new Error('未连接云端');
        }
        var remote = await _downloadFromOSS();
        if (!remote) throw new Error('云端没有可恢复的数据');
        var count = await _applyRemoteData(remote);
        return { count: count, savedAt: remote.savedAt };
    }

    // ==== 启动 ====
    function boot() {
        if (typeof window.CloudSync === 'undefined' || typeof localforage === 'undefined') {
            setTimeout(boot, 200);
            return;
        }

        // 需要在阶段一暴露 buildSignedUrl；如果没有，等待
        if (typeof window.CloudSync.buildSignedUrl !== 'function') {
            setTimeout(boot, 200);
            return;
        }

        _hookLocalforage();
        _hookLocalStorage();
        _hookVisibility();

        // 首次启动检测（延迟 3 秒等 app 加载完）
        setTimeout(_checkRestoreOnStart, 3000);

        // 连接状态变化时重新检查恢复（比如用户在数据管理里刚填完密钥）
        window.CloudSync.onStatusChange(function (evt) {
            if (evt.connected) {
                setTimeout(_checkRestoreOnStart, 1000);
            }
        });
    }

    // ==== 暴露 ====
    global.CloudSyncEngine = {
        requestSync: requestSync,
        requestSyncNow: requestSyncNow,
        manualRestore: manualRestore,
        getSyncStatus: getSyncStatus,
        onSyncStatusChange: onSyncStatusChange
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(typeof window !== 'undefined' ? window : this);
