/**
 * moments.js - 动态功能
 * 数据结构 · 触发逻辑 · 点赞评论链 · 通知队列
 *
 * 依赖：
 *   - state.js：customReplies, stickerLibrary, SESSION_ID, settings
 *   - core.js：getStorageKey, optimizeImage
 *   - cloud-media.js：CloudMedia（OSS 上传）
 *   - cloud-sync.js：CloudSync.isConnected()
 *
 * 接入 checklist（首次启用需改其他文件）：
 *   1. envelope.js：移除 checkPartnerInitiatedLetter 调用，暴露 window._generatePartnerLetter
 *   2. core.js loadData：把 checkEnvelopeStatus() 后面追加 checkMomentsStatus()
 *   3. index.html：<script src="js/features/moments.js"> 加在 envelope.js 后面
 */

// ─────────────────────────────────────────────
//  数据结构
// ─────────────────────────────────────────────
// Post {
//   id: string
//   type: 'partner' | 'user'
//   text: string
//   images: string[]           base64 或 oss:// 引用
//   date: string               'YYYY-MM-DD'（仅展示，不暴露具体时间）
//   timestamp: number          毫秒时间戳（内部排序用）
//   isNewForUser: boolean      用户是否已读（partner 帖专用，用于角标）
//   partnerLiked: boolean      梦角是否已点赞（user 帖专用）
//   pendingLikeTime: number|null  计划点赞时间
//   comments: Comment[]
//   pendingPartnerComment: { text: string, time: number } | null
//   chainProbability: number|null  null = 链条已死；否则为用户下次评论后梦角回复的概率
// }
//
// Comment {
//   id: string
//   authorType: 'partner' | 'user'
//   text: string
//   timestamp: number
//   isNew: boolean             用户是否已读（partner 评论专用）
// }

let momentsData = { posts: [] };

// ─────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────
const _M_STORAGE_KEY     = 'momentsData';
const _M_COOLDOWN_KEY    = 'partnerLetterNextTime'; // 与信箱共享同一个冷却 key
const _M_COOLDOWN_MIN    = 48 * 60 * 60 * 1000;    // 48 小时
const _M_COOLDOWN_MAX    = 72 * 60 * 60 * 1000;    // 72 小时
const _M_ACTION_PROB     = 0.40;                   // 40% 概率触发
const _M_DELAY_MIN       = 5  * 60 * 1000;         // 5 分钟
const _M_DELAY_MAX       = 20 * 60 * 1000;         // 20 分钟

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────
function _mRandomDelay() {
    return _M_DELAY_MIN + Math.random() * (_M_DELAY_MAX - _M_DELAY_MIN);
}

function _mTodayStr() {
    return new Date().toISOString().slice(0, 10);
}

function _mUid(prefix) {
    return (prefix || 'id') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
}

function _mPartnerName() {
    return (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
}

// 从字卡库随机抽 3～5 句拼成动态正文
function _mGeneratePostText() {
    const pool = [...(window._customReplies || customReplies || [])];
    if (!pool.length) return '想着你呢。';
    const count = 3 + Math.floor(Math.random() * 3); // 3~5
    let text = '';
    for (let i = 0; i < count; i++) {
        const s = pool[Math.floor(Math.random() * pool.length)];
        const p = Math.random() < 0.2 ? '！' : (Math.random() < 0.2 ? '……' : '。');
        text += s + p;
    }
    return text;
}

// 从贴纸库随机抽 1～3 张（40% 概率有图，60% 纯文字）
function _mPickImages() {
    if (Math.random() >= 0.40) return [];
    const pool = [...(stickerLibrary || [])];
    if (!pool.length) return [];
    const count = 1 + Math.floor(Math.random() * 3); // 1~3
    return pool.sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));
}

// 梦角评论/回复：从字卡库随机抽 1 句
function _mGenerateCommentText() {
    const pool = [...(window._customReplies || customReplies || [])];
    if (!pool.length) return '嗯嗯~';
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────
//  存储
// ─────────────────────────────────────────────
async function loadMomentsData() {
    try {
        const saved = await localforage.getItem(getStorageKey(_M_STORAGE_KEY));
        if (saved) momentsData = saved;
    } catch (e) {
        console.warn('[Moments] loadMomentsData 失败', e);
    }
}

function saveMomentsData() {
    try {
        localforage.setItem(getStorageKey(_M_STORAGE_KEY), momentsData);
    } catch (e) {
        console.warn('[Moments] saveMomentsData 失败', e);
    }
}

// ─────────────────────────────────────────────
//  通知队列
// ─────────────────────────────────────────────
let _notifQueue = [];
let _notifBusy  = false;

function _queueNotif(type, postId) {
    _notifQueue.push({ type, postId });
    _drainNotifQueue();
}

function _drainNotifQueue() {
    if (_notifBusy || _notifQueue.length === 0) return;
    const next = _notifQueue.shift();
    _notifBusy = true;
    _showMomentsNotif(next.type, next.postId);
}

function _showMomentsNotif(type, postId) {
    const existing = document.getElementById('moments-notif-popup');
    if (existing) existing.remove();

    const name = _mPartnerName();
    const configs = {
        newPost:   { icon: '📸', title: `${name}发了新动态`,       sub: '快去看看 Ta 的动态~' },
        liked:     { icon: '❤️', title: `${name}为你的动态点了赞`,  sub: '' },
        commented: { icon: '💬', title: `${name}评论了你的动态`,    sub: '去看看 Ta 说了什么~' },
        replied:   { icon: '💬', title: `${name}回复了你`,          sub: '去看看 Ta 说了什么~' },
    };
    const cfg = configs[type] || configs.newPost;

    const popup = document.createElement('div');
    popup.id = 'moments-notif-popup';
    popup.style.cssText = [
        'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);',
        'background:var(--secondary-bg);border:1px solid var(--border-color);',
        'border-radius:20px;padding:18px 20px;z-index:8000;',
        'max-width:320px;width:88%;',
        'box-shadow:0 8px 32px rgba(0,0,0,0.18);',
        'display:flex;flex-direction:column;gap:12px;',
        'animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);'
    ].join('');

    popup.innerHTML = `
        <style>
            @keyframes _mSlideUp {
                from { opacity:0; transform:translateX(-50%) translateY(24px) scale(0.9); }
                60%  { transform:translateX(-50%) translateY(-4px) scale(1.02); }
                to   { opacity:1; transform:translateX(-50%) translateY(0) scale(1); }
            }
        </style>
        <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:26px;">${cfg.icon}</span>
            <div>
                <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${cfg.title}</div>
                ${cfg.sub ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">${cfg.sub}</div>` : ''}
            </div>
        </div>
        <div style="display:flex;gap:8px;">
            <button
                onclick="document.getElementById('moments-notif-popup').remove(); window._momentsNotifDone();"
                style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;">
                稍后查看
            </button>
            <button
                onclick="window._openMomentsPost('${postId}'); document.getElementById('moments-notif-popup').remove(); window._momentsNotifDone();"
                style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">
                立即查看 ✦
            </button>
        </div>`;

    document.body.appendChild(popup);
    setTimeout(() => {
        if (popup.parentNode) {
            popup.remove();
            window._momentsNotifDone();
        }
    }, 8000);
}

window._momentsNotifDone = function() {
    _notifBusy = false;
    setTimeout(_drainNotifQueue, 400);
};

// 打开指定动态（UI 层实现后替换这个 stub）
window._openMomentsPost = function(postId) {
    console.log('[Moments] 跳转到动态:', postId);
    if (typeof window.openMomentsModal === 'function') {
        window.openMomentsModal(postId);
    }
};

// ─────────────────────────────────────────────
//  梦角发动态
// ─────────────────────────────────────────────
async function generatePartnerMoment() {
    const now  = Date.now();
    const post = {
        id:       _mUid('partner'),
        type:     'partner',
        text:     _mGeneratePostText(),
        images:   _mPickImages(),
        date:     _mTodayStr(),
        timestamp: now,
        isNewForUser: true,
        partnerLiked: false,
        pendingLikeTime: null,
        comments: [],
        pendingPartnerComment: null,
        chainProbability: 0.70,  // 用户评论后梦角 70% 概率回复
    };

    // 10% 概率梦角在 5~20 分钟内自评
    if (Math.random() < 0.10) {
        post.pendingPartnerComment = {
            text: _mGenerateCommentText(),
            time: now + Math.floor(_mRandomDelay()),
            isSelfComment: true,  // 标记：自评，交付时不推送通知
        };
    }

    momentsData.posts.unshift(post);
    saveMomentsData();
    _queueNotif('newPost', post.id);
}

// ─────────────────────────────────────────────
//  用户发动态后的钩子（由 UI 层调用）
// ─────────────────────────────────────────────

// 用户创建帖子后：安排梦角点赞 + 90% 概率主动评论
function onUserPostCreated(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post || post.type !== 'user') return;

    // 安排点赞（5~20 分钟后）
    post.pendingLikeTime = Date.now() + _mRandomDelay();

    // 90% 概率梦角主动评论
    if (Math.random() < 0.90) {
        post.pendingPartnerComment = {
            text: _mGenerateCommentText(),
            time: Date.now() + _mRandomDelay(),
        };
        post.chainProbability = 0.45; // 梦角首评后，用户回复有 45% 概率再触发
    } else {
        post.chainProbability = null;  // 梦角没评论，链条直接结束
    }

    saveMomentsData();
}

// 用户在某条帖子下发评论后：触发梦角回复链
function onUserCommented(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;

    const prob = post.chainProbability;

    // 链条已死 或 概率太低 → 不回复
    if (prob === null || prob < 0.06) {
        post.chainProbability = null;
        saveMomentsData();
        return;
    }

    if (Math.random() < prob) {
        // 命中：安排梦角回复
        post.pendingPartnerComment = {
            text: _mGenerateCommentText(),
            time: Date.now() + _mRandomDelay(),
        };
        post.chainProbability = prob / 2;  // 下次减半
    } else {
        // 未命中：链条断裂
        post.chainProbability = null;
    }

    saveMomentsData();
}

// ─────────────────────────────────────────────
//  状态检查（页面加载 + visibilitychange 时运行）
// ─────────────────────────────────────────────
async function checkMomentsStatus() {
    await loadMomentsData();
    const now = Date.now();
    let changed = false;

    for (const post of momentsData.posts) {

        // 交付待发点赞
        if (post.pendingLikeTime && !post.partnerLiked && now >= post.pendingLikeTime) {
            post.partnerLiked    = true;
            post.pendingLikeTime = null;
            changed = true;
            _queueNotif('liked', post.id);
        }

        // 交付待发评论/回复
        if (post.pendingPartnerComment && now >= post.pendingPartnerComment.time) {
            const ppc = post.pendingPartnerComment;
            const comment = {
                id:         _mUid('c'),
                authorType: 'partner',
                text:       ppc.text,
                timestamp:  ppc.time,
                isNew:      true,
            };
            post.comments.push(comment);
            post.pendingPartnerComment = null;
            changed = true;

            // 梦角自评（isSelfComment = true）：静默交付，不推送通知
            if (!ppc.isSelfComment) {
                const notifType = post.type === 'user' ? 'commented' : 'replied';
                _queueNotif(notifType, post.id);
            }
        }
    }

    if (changed) saveMomentsData();

    // 检查共享触发器（写信 or 发动态）
    // ⚠️ 启用前必须先从 envelope.js 移除 checkPartnerInitiatedLetter 调用
    await _checkPartnerInitiatedAction();
}

// ─────────────────────────────────────────────
//  共享触发器：写信 or 发动态（替代 envelope.js 的 checkPartnerInitiatedLetter）
// ─────────────────────────────────────────────
async function _checkPartnerInitiatedAction() {
    try {
        const KEY  = getStorageKey(_M_COOLDOWN_KEY);
        const now  = Date.now();
        const next = await localforage.getItem(KEY);

        if (next !== null && now < next) return;

        // 设置下次冷却窗口（无论是否触发都先设，防止重复检查）
        const cooldown = _M_COOLDOWN_MIN + Math.random() * (_M_COOLDOWN_MAX - _M_COOLDOWN_MIN);
        await localforage.setItem(KEY, now + cooldown);

        if (Math.random() >= _M_ACTION_PROB) return; // 40% 概率触发

        // 50% 写信，50% 发动态
        if (Math.random() < 0.5) {
            if (typeof window._generatePartnerLetter === 'function') {
                window._generatePartnerLetter();
            } else {
                console.warn('[Moments] window._generatePartnerLetter 未注册，跳过写信');
            }
        } else {
            await generatePartnerMoment();
        }
    } catch (e) {
        console.warn('[Moments] _checkPartnerInitiatedAction 失败', e);
    }
}

// ─────────────────────────────────────────────
//  visibilitychange 监听
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        checkMomentsStatus().catch(e => console.warn('[Moments] visibilitychange 检查失败', e));
    }
});

// ─────────────────────────────────────────────
//  角标 & 已读
// ─────────────────────────────────────────────

// 未读数：partner 帖未读 + 未读评论数
function getMomentsUnreadCount() {
    let count = 0;
    for (const post of momentsData.posts) {
        if (post.isNewForUser) count++;
        for (const c of post.comments) {
            if (c.authorType === 'partner' && c.isNew) count++;
        }
    }
    return count;
}

// 标记某条帖子及其评论为已读
function markPostRead(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    post.isNewForUser = false;
    post.comments.forEach(c => { c.isNew = false; });
    saveMomentsData();
    _updateMomentsBadge();
}

// 更新主页角标（UI 层挂载后自动生效）
function _updateMomentsBadge() {
    const badge = document.getElementById('moments-header-badge');
    if (!badge) return;
    const count = getMomentsUnreadCount();
    badge.style.display = count > 0 ? 'inline-block' : 'none';
}

// ─────────────────────────────────────────────
//  暴露到 window
// ─────────────────────────────────────────────
window.loadMomentsData      = loadMomentsData;
window.saveMomentsData      = saveMomentsData;
window.checkMomentsStatus   = checkMomentsStatus;
window.generatePartnerMoment = generatePartnerMoment;
window.onUserPostCreated    = onUserPostCreated;
window.onUserCommented      = onUserCommented;
window.getMomentsUnreadCount = getMomentsUnreadCount;
window.markPostRead         = markPostRead;
window._updateMomentsBadge  = _updateMomentsBadge;

// 调试用：直接访问数据
Object.defineProperty(window, '_momentsData', { get: () => momentsData });
