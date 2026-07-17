// server.js
// 问卷星自动填写平台 v2.0
//   🆓 每日免费 3 次   💰 200份 = 18元
//   🌐 随机 IP 伪装    🔐 用户注册/登录 + 管理员后台

const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wjx-filler-v2-' + uuidv4().slice(0, 8);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 随机 IP 工具 ====================

/** 生成随机中国 IP 地址 */
function randomChinaIP() {
    // 真实中国 IP 段范围
    const ranges = [
        { start: [1, 2, 4, 0], end: [1, 2, 4, 255] },        // 1.2.4.x
        { start: [27, 0, 0, 0], end: [27, 255, 255, 255] },   // 27.x.x.x
        { start: [36, 0, 0, 0], end: [36, 255, 255, 255] },
        { start: [42, 0, 0, 0], end: [42, 255, 255, 255] },
        { start: [49, 0, 0, 0], end: [49, 255, 255, 255] },
        { start: [58, 0, 0, 0], end: [61, 255, 255, 255] },
        { start: [101, 0, 0, 0], end: [101, 255, 255, 255] },
        { start: [106, 0, 0, 0], end: [106, 255, 255, 255] },
        { start: [110, 0, 0, 0], end: [125, 255, 255, 255] },
        { start: [171, 0, 0, 0], end: [171, 255, 255, 255] },
        { start: [175, 0, 0, 0], end: [175, 255, 255, 255] },
        { start: [180, 0, 0, 0], end: [183, 255, 255, 255] },
        { start: [202, 0, 0, 0], end: [203, 255, 255, 255] },
        { start: [210, 0, 0, 0], end: [211, 255, 255, 255] },
        { start: [218, 0, 0, 0], end: [223, 255, 255, 255] },
    ];

    const range = ranges[Math.floor(Math.random() * ranges.length)];
    const oct1 = range.start[0];
    const oct2 = range.start[1] + Math.floor(Math.random() * (range.end[1] - range.start[1] + 1));
    const oct3 = Math.floor(Math.random() * 256);
    const oct4 = 1 + Math.floor(Math.random() * 254);
    return `${oct1}.${oct2}.${oct3}.${oct4}`;
}

/** 保存当前 IP（用于同一份答卷内部保持 IP 一致性） */
let currentSessionIP = randomChinaIP();

/** 获取 IP（单次提交时翻新，批量时保持一定存活性） */
function getSessionIP(refresh = true) {
    if (refresh) currentSessionIP = randomChinaIP();
    return currentSessionIP;
}

/** 生成随机 User-Agent */
const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];
function randomUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }

// ==================== 数据库 ====================
const {
    userGet, userGetById, userCreate, userAddCredits, userConsumeCredit,
    creditLogAdd, creditLogGetByUser,
    orderCreate, orderGetById, orderGetByUser, orderGetPending, orderUpdateStatus,
    announceGetActive, announceCreate,
    settingGet, settingSet, settingGetAll,
    dailyFreeGet, dailyFreeSet,
    calculatePrice,
} = require('./db');

// ==================== JWT 认证中间件 ====================

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '请先登录' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
}

function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
}

// ==================== 用户 API ====================

app.post('/api/auth/register', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
        if (username.length < 3 || username.length > 20) return res.status(400).json({ error: '用户名3-20个字符' });
        if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

        const existing = userGet(username);
        if (existing) return res.status(400).json({ error: '用户名已存在' });

        const hash = bcrypt.hashSync(password, 10);
        const user = userCreate(username, hash);
        if (!user) return res.status(500).json({ error: '注册失败' });

        // 赠送初始免费额度
        const freeQuota = parseInt(settingGet('daily_free_quota', '3'));
        userAddCredits(user.id, freeQuota);
        creditLogAdd(user.id, freeQuota, 'free_daily', '新用户注册赠送');

        const token = jwt.sign({ id: user.id, username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user.id, username, role: user.role, credits: freeQuota } });
    } catch (err) {
        console.error('[注册失败]', err);
        res.status(500).json({ error: '注册失败' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

        const user = userGet(username);
        if (!user) return res.status(400).json({ error: '用户名或密码错误' });

        const valid = bcrypt.compareSync(password, user.password_hash);
        if (!valid) return res.status(400).json({ error: '用户名或密码错误' });

        // 每日免费额度
        grantDailyFree(user.id);
        const updated = userGetById(user.id);

        const token = jwt.sign({ id: updated.id, username: updated.username, role: updated.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true, token,
            user: { id: updated.id, username: updated.username, role: updated.role, credits: updated.credits, totalUsed: updated.total_used },
        });
    } catch (err) {
        console.error('[登录失败]', err);
        res.status(500).json({ error: '登录失败' });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    grantDailyFree(req.user.id);
    const user = userGetById(req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ id: user.id, username: user.username, role: user.role, credits: user.credits, totalUsed: user.total_used });
});

function grantDailyFree(userId) {
    const today = new Date().toLocaleDateString('zh-CN');
    const last = dailyFreeGet(userId);
    if (last !== today) {
        const user = userGetById(userId);
        const freeQuota = parseInt(settingGet('daily_free_quota', '3'));
        if (user && user.credits < freeQuota) {
            const need = freeQuota - user.credits;
            if (need > 0) {
                userAddCredits(userId, need);
                creditLogAdd(userId, need, 'free_daily', '每日免费额度补充');
            }
        }
        dailyFreeSet(userId, today);
    }
}

// ==================== 订单 API ====================

app.get('/api/pricing', (req, res) => {
    const dailyFree = settingGet('daily_free_quota', '3');
    res.json({
        dailyFree: parseInt(dailyFree),
        unitPrice: '10元/100次（买100送10，实得110次）',
        minBuy: parseInt(settingGet('min_buy_amount', '100')),
        presets: [
            { amount: 100, price: '10.00', bonus: 10, receive: 110, label: '基础包' },
            { amount: 200, price: '20.00', bonus: 20, receive: 220, label: '推荐包' },
            { amount: 400, price: '40.00', bonus: 40, receive: 440, label: '超值包' },
        ],
        formula: '每100次=10元，每100次再送10次。例：买200次得220次=20元',
        bonusRule: '每满100次送10次',
    });
});

app.post('/api/orders/create', authMiddleware, (req, res) => {
    try {
        const { amount, paymentNote } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: '请输入有效的购买份数' });
        const pricing = calculatePrice(amount);
        // 订单记录原始购买量，赠送在审核时加上
        const order = orderCreate(req.user.id, pricing.amount, pricing.priceCents, paymentNote || '');
        console.log(`[订单] 用户${req.user.username} 创建 #${order.id}: ${pricing.amount}份 ${pricing.yuan}元 (送${pricing.bonus}次，实得${pricing.totalReceive})`);
        res.json({
            success: true, order,
            pricing,
            paymentInfo: {
                method: settingGet('payment_method', '微信扫码支付'),
                qrcode: settingGet('payment_qrcode', ''),
                instructions: settingGet('payment_instructions', ''),
            },
        });
    } catch (err) {
        console.error('[创建订单失败]', err);
        res.status(500).json({ error: '创建订单失败' });
    }
});

app.get('/api/orders/my', authMiddleware, (req, res) => {
    res.json({ success: true, orders: orderGetByUser(req.user.id) });
});

// 用户自助确认付款（解放双手，无需管理员手动审核）
app.post('/api/orders/self-confirm', authMiddleware, (req, res) => {
    try {
        const { orderId } = req.body;
        const order = orderGetById(orderId);
        if (!order) return res.status(404).json({ error: '订单不存在' });
        if (order.user_id !== req.user.id) return res.status(403).json({ error: '只能确认自己的订单' });
        if (order.status !== 'pending') return res.status(400).json({ error: '该订单已处理' });

        // 订单创建后至少等10秒才能自助确认
        const elapsed = Date.now() - new Date(order.created_at).getTime();
        if (elapsed < 10000) return res.status(400).json({ error: '订单刚创建，请付款后再确认' });

        orderUpdateStatus(orderId, 'paid', null, '用户自助确认');
        const bonus = Math.floor(order.amount / 100) * 10;
        const totalCredits = order.amount + bonus;
        userAddCredits(order.user_id, totalCredits);
        creditLogAdd(order.user_id, totalCredits, 'purchase',
            `订单#${orderId} 自助确认 (${order.amount}+赠送${bonus}=${totalCredits}次)`, orderId);

        const updatedUser = userGetById(req.user.id);
        console.log(`[自助确认] ${req.user.username} 订单#${orderId}，得${totalCredits}次`);
        res.json({ success: true, message: `确认成功！获得 ${totalCredits} 次（含赠送 ${bonus} 次）`, credits: updatedUser.credits });
    } catch (err) { res.status(500).json({ error: '操作失败' }); }
});

app.get('/api/credits/log', authMiddleware, (req, res) => {
    res.json({ success: true, logs: creditLogGetByUser(req.user.id) });
});

app.get('/api/public-settings', (req, res) => {
    res.json({
        siteName: settingGet('site_name', '问卷星自动填写平台'),
        dailyFree: parseInt(settingGet('daily_free_quota', '3')),
        priceYuan: (parseInt(settingGet('price_per_200', '1800')) / 100).toFixed(2),
        minBuy: parseInt(settingGet('min_buy_amount', '200')),
        paymentQrcode: settingGet('payment_qrcode', ''),
        paymentInstructions: settingGet('payment_instructions', ''),
    });
});

app.get('/api/announcements', (req, res) => {
    const a = announceGetActive();
    res.json({ success: true, announcement: a });
});

// ==================== 管理员 API ====================

app.get('/api/admin/orders/pending', authMiddleware, adminMiddleware, (req, res) => {
    res.json({ success: true, orders: orderGetPending() });
});

app.post('/api/admin/orders/approve', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { orderId, adminNote } = req.body;
        const order = orderGetById(orderId);
        if (!order) return res.status(404).json({ error: '订单不存在' });
        if (order.status !== 'pending') return res.status(400).json({ error: '状态不是待支付' });

        orderUpdateStatus(orderId, 'paid', req.user.id, adminNote || '');

        // 计算赠送: 每100次送10次
        const bonus = Math.floor(order.amount / 100) * 10;
        const totalCredits = order.amount + bonus;
        userAddCredits(order.user_id, totalCredits);
        creditLogAdd(order.user_id, totalCredits, 'purchase', `订单#${orderId} 已支付 (购买${order.amount}+赠送${bonus}=${totalCredits}次)`, orderId);

        console.log(`[管理员] 订单#${orderId} 审核通过，用户获得${totalCredits}次（含赠送${bonus}）`);
        res.json({ success: true, message: `已确认，用户获得${totalCredits}次（含赠送${bonus}次）` });
    } catch (err) { res.status(500).json({ error: '操作失败' }); }
});

app.post('/api/admin/orders/reject', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { orderId, adminNote } = req.body;
        const order = orderGetById(orderId);
        if (!order) return res.status(404).json({ error: '订单不存在' });
        orderUpdateStatus(orderId, 'cancelled', req.user.id, adminNote || '');
        res.json({ success: true, message: '已拒绝' });
    } catch (err) { res.status(500).json({ error: '操作失败' }); }
});

app.post('/api/admin/grant-credits', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { username, amount, note } = req.body;
        const user = userGet(username);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        const amt = parseInt(amount) || 0;
        if (amt <= 0) return res.status(400).json({ error: '数量无效' });
        userAddCredits(user.id, amt);
        creditLogAdd(user.id, amt, 'admin_grant', note || '管理员赠送');
        console.log(`[管理员] 手动给${username}充值${amt}次`);
        res.json({ success: true, message: `已为${username}增加${amt}次` });
    } catch (err) { res.status(500).json({ error: '操作失败' }); }
});

app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    res.json({ success: true, settings: settingGetAll() });
});

app.post('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body)) settingSet(key, String(value));
        res.json({ success: true, message: '设置已更新' });
    } catch (err) { res.status(500).json({ error: '保存失败' }); }
});

app.post('/api/admin/announce', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const { title, content } = req.body;
        if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
        announceCreate(title, content);
        res.json({ success: true, message: '公告已发布' });
    } catch (err) { res.status(500).json({ error: '发布失败' }); }
});

// ==================== 问卷代理 API（含随机IP） ====================

// 分析问卷
app.post('/api/analyze', authMiddleware, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: '请提供问卷链接' });

        const ip = getSessionIP(true);
        const ua = randomUA();
        console.log(`[分析] ${req.user.username} → IP:${ip}`);
        grantDailyFree(req.user.id);

        const response = await axios.get(url, {
            headers: {
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'X-Forwarded-For': ip,
                'X-Real-IP': ip,
                'Referer': 'https://www.wjx.cn/',
            },
            timeout: 15000,
            maxRedirects: 5,
        });

        const html = response.data;
        const doc = new JSDOM(html).window.document;
        const title = doc.querySelector('title')?.textContent || '未知问卷';
        const questions = parseQuestions(doc);
        const submitUrl = extractSubmitUrl(doc, url);
        const hiddenFields = extractHiddenFields(doc);

        console.log(`[分析] 共${questions.length}题`);

        res.json({ success: true, title, questionCount: questions.length, questions, submitUrl, hiddenFields });
    } catch (err) {
        console.error('[分析失败]', err.message);
        if (err.response && typeof err.response.data === 'string' && err.response.data.includes('div_question')) {
            const doc = new JSDOM(err.response.data).window.document;
            const questions = parseQuestions(doc);
            return res.json({ success: true, title: doc.querySelector('title')?.textContent || '', questionCount: questions.length, questions, submitUrl: extractSubmitUrl(doc, req.body.url), hiddenFields: extractHiddenFields(doc) });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// 批量提交（含随机IP）
app.post('/api/batch-submit', authMiddleware, async (req, res) => {
    try {
        const { submitUrl, formDataTemplate, count, delay, referer, questions, customConfig, answerMode } = req.body;
        if (!submitUrl || !formDataTemplate) return res.status(400).json({ error: '缺少必要参数' });

        grantDailyFree(req.user.id);
        const user = userGetById(req.user.id);
        const totalCount = Math.min(count || 1, 500);

        if (user.credits < totalCount) {
            return res.status(402).json({
                error: '次数不足', credits: user.credits, required: totalCount,
                hint: `剩余 ${user.credits} 次，需要 ${totalCount} 次。请购买更多次数。`,
            });
        }

        if (!userConsumeCredit(user.id, totalCount)) {
            return res.status(402).json({ error: '次数扣减失败' });
        }
        creditLogAdd(user.id, -totalCount, 'consume', `批量提交${totalCount}份`);

        const delayMs = Math.max(delay || 500, 200);
        console.log(`[批量] ${user.username} 提交${totalCount}份, 余额:${userGetById(user.id).credits}`);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let successCount = 0, failCount = 0;

        for (let i = 0; i < totalCount; i++) {
            // 🌐 每N份换一个IP（N随机5-15）
            const ipRefreshInterval = 5 + Math.floor(Math.random() * 11);
            const ip = (i % ipRefreshInterval === 0) ? getSessionIP(true) : getSessionIP(false);
            const ua = randomUA();

            try {
                let formData;
                if (answerMode === 'custom' && customConfig) {
                    formData = applyCustomConfig(formDataTemplate, customConfig, questions);
                } else if (answerMode === 'mixed' && customConfig) {
                    formData = generateRandomAnswers(formDataTemplate, questions);
                    formData = mergeCustomConfig(formData, customConfig, questions);
                } else {
                    formData = generateRandomAnswers(formDataTemplate, questions);
                }

                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(formData)) {
                    if (Array.isArray(value)) value.forEach(v => params.append(key, v));
                    else params.append(key, value);
                }

                const resp = await axios.post(submitUrl, params.toString(), {
                    headers: {
                        'User-Agent': ua,
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'Accept': '*/*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Origin': new URL(submitUrl).origin,
                        'Referer': referer || submitUrl,
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Forwarded-For': ip,
                        'X-Real-IP': ip,
                        'Client-IP': ip,
                    },
                    timeout: 15000,
                    maxRedirects: 3,
                });

                const rd = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
                if ((resp.status === 200 && rd.includes('成功')) || resp.status === 200 && rd.length < 500) successCount++;
                else failCount++;

                res.write(`data: ${JSON.stringify({
                    type: 'progress', current: i + 1, total: totalCount,
                    success: successCount, fail: failCount,
                    percent: Math.round(((i + 1) / totalCount) * 100),
                    ip: ip,
                })}\n\n`);

            } catch (err) {
                failCount++;
                res.write(`data: ${JSON.stringify({
                    type: 'progress', current: i + 1, total: totalCount,
                    success: successCount, fail: failCount,
                    percent: Math.round(((i + 1) / totalCount) * 100),
                    lastError: err.message, ip: ip,
                })}\n\n`);
            }
            if (i < totalCount - 1) await sleep(delayMs);
        }

        const updated = userGetById(req.user.id);
        res.write(`data: ${JSON.stringify({ type: 'complete', total: totalCount, success: successCount, fail: failCount })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'credits', credits: updated.credits })}\n\n`);
        console.log(`[批量完成] ${user.username}: ${successCount}/${totalCount} 成功, 余额:${updated.credits}`);
        res.end();

    } catch (err) {
        console.error('[批量失败]', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else { res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`); res.end(); }
    }
});

// 单次提交
app.post('/api/submit', authMiddleware, async (req, res) => {
    try {
        const { submitUrl, formData, referer } = req.body;
        if (!submitUrl || !formData) return res.status(400).json({ error: '缺少必要参数' });

        grantDailyFree(req.user.id);
        const user = userGetById(req.user.id);
        if (user.credits < 1) return res.status(402).json({ error: '次数不足', credits: 0 });

        userConsumeCredit(user.id, 1);
        creditLogAdd(user.id, -1, 'consume', '单次提交');

        const ip = getSessionIP(true);
        const ua = randomUA();
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(formData)) {
            if (Array.isArray(v)) v.forEach(x => params.append(k, x));
            else params.append(k, v);
        }

        const resp = await axios.post(submitUrl, params.toString(), {
            headers: {
                'User-Agent': ua,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Origin': new URL(submitUrl).origin,
                'Referer': referer || submitUrl,
                'X-Requested-With': 'XMLHttpRequest',
                'X-Forwarded-For': ip,
                'X-Real-IP': ip,
                'Client-IP': ip,
            },
            timeout: 15000,
            maxRedirects: 3,
        });

        res.json({ success: true, status: resp.status, ip });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), ip: getSessionIP(false) });
});

// ==================== 问卷解析函数 ====================

function parseQuestions(doc) {
    const questions = [];
    const containers = findQuestionContainers(doc);
    containers.forEach((container, idx) => {
        const type = detectType(container);
        if (type === 'unknown') return;
        const title = extractTitle(container);
        if (!title || title.length < 2) return;
        questions.push({ index: idx + 1, type, title: title.slice(0, 120), options: extractOptions(container, type), fieldName: extractFieldName(container, type) });
    });
    return questions;
}

function findQuestionContainers(doc) {
    for (const sel of ['.div_question', 'fieldset', '.question', '.field', '[id^="divquestion"]', '.topic', '.ui-field-contain']) {
        const els = doc.querySelectorAll(sel);
        if (els.length >= 2) return Array.from(els);
    }
    return [];
}

function detectType(c) {
    const h = (c.outerHTML || '');
    if (h.includes('sortrank')) return 'sort';
    if (h.includes('rate_off') || h.includes('rate_on')) return 'star';
    if (h.includes('jqCheckbox') || c.querySelector('input[type="checkbox"]')) return 'checkbox';
    if (h.includes('jqRadio') || c.querySelector('input[type="radio"]')) return 'radio';
    if (c.querySelector('select')) return 'select';
    if (c.querySelector('textarea')) return 'textarea';
    if (c.querySelector('input[type="text"], input:not([type])')) return 'text';
    return 'unknown';
}

function extractTitle(c) {
    for (const s of ['.div_title_question', 'legend', '.field-label', 'label:first-of-type']) {
        const e = c.querySelector(s);
        if (e && e.textContent.trim().length > 1) return e.textContent.replace(/\s+/g, ' ').trim();
    }
    return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function extractOptions(c, t) {
    const opts = [];
    if (t === 'radio') {
        c.querySelectorAll('a.jqRadio').forEach((a, i) => opts.push({ index: i, text: a.textContent.trim().slice(0, 60), val: a.getAttribute('val') || String(i + 1) }));
        if (!opts.length) c.querySelectorAll('input[type="radio"]').forEach((inp, i) => { const l = inp.closest('label') || inp.parentElement; opts.push({ index: i, text: (l?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), val: inp.value || String(i + 1) }); });
    }
    if (t === 'checkbox') {
        c.querySelectorAll('a.jqCheckbox').forEach((a, i) => opts.push({ index: i, text: a.textContent.trim().slice(0, 60), val: a.getAttribute('val') || String(i + 1) }));
        if (!opts.length) c.querySelectorAll('input[type="checkbox"]').forEach((inp, i) => { const l = inp.closest('label') || inp.parentElement; opts.push({ index: i, text: (l?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), val: inp.value || String(i + 1) }); });
    }
    return opts;
}

function extractFieldName(c, t) {
    if (t === 'radio') { const r = c.querySelector('input[type="radio"]'); return r?.name || ''; }
    if (t === 'checkbox') { const r = c.querySelector('input[type="checkbox"]'); return r?.name || ''; }
    if (t === 'text' || t === 'textarea') { const r = c.querySelector('input[type="text"], input:not([type]), textarea'); return r?.name || ''; }
    return '';
}

function extractSubmitUrl(doc, pageUrl) {
    const a = doc.querySelector('form')?.getAttribute('action');
    return a ? new URL(a, pageUrl).href : pageUrl.replace(/\?.*$/, '');
}

function extractHiddenFields(doc) {
    const f = {};
    doc.querySelectorAll('input[type="hidden"]').forEach(inp => { const n = inp.getAttribute('name'), v = inp.getAttribute('value'); if (n && v) f[n] = v; });
    return f;
}

function generateRandomAnswers(template, questions) {
    const data = { ...template };
    if (!questions) return data;
    questions.forEach(q => {
        const fn = q.fieldName; if (!fn) return;
        switch (q.type) {
            case 'radio': if (q.options.length) data[fn] = q.options[Math.floor(Math.random() * q.options.length)].val; break;
            case 'checkbox': {
                const cnt = 1 + Math.floor(Math.random() * Math.min(3, q.options.length));
                const p = [...q.options].sort(() => Math.random() - 0.5).slice(0, cnt);
                const cl = fn.replace('[]', '');
                fn.includes('[]') ? (data[cl] = p.map(x => x.val)) : p.forEach((x, i) => { data[`${cl}[${i}]`] = x.val; });
                break;
            }
            case 'text': case 'textarea': data[fn] = ['不错，希望优化。','服务好，会推荐。','体验良好。','性价比高。','质量可靠。'][Math.floor(Math.random() * 5)]; break;
            case 'select': if (q.options.length) data[fn] = q.options[Math.floor(Math.random() * q.options.length)].val; break;
            case 'star': data[fn] = String(3 + Math.floor(Math.random() * 3)); break;
        }
    });
    return data;
}

function applyCustomConfig(t, cfg, qs) {
    const d = { ...t };
    if (!qs) return d;
    qs.forEach(q => {
        const fn = q.fieldName; if (!fn) return;
        const c = cfg[fn]; if (!c) return;
        switch (q.type) {
            case 'radio': case 'select': d[fn] = c.val || ''; break;
            case 'checkbox': { const cl = fn.replace('[]', ''); fn.includes('[]') ? (d[cl] = c.vals || []) : (c.vals || []).forEach((v, i) => { d[`${cl}[${i}]`] = v; }); break; }
            case 'text': case 'textarea': d[fn] = c.text || ''; break;
            case 'star': d[fn] = c.val || '4'; break;
        }
    });
    return d;
}

function mergeCustomConfig(rd, cfg, qs) {
    const d = { ...rd };
    if (!qs) return d;
    qs.forEach(q => {
        const fn = q.fieldName; if (!fn) return;
        const c = cfg[fn]; if (!c) return;
        switch (q.type) {
            case 'radio': case 'select': if (c.val) d[fn] = c.val; break;
            case 'checkbox': if (c.vals?.length) { const cl = fn.replace('[]', ''); fn.includes('[]') ? (d[cl] = c.vals) : c.vals.forEach((v, i) => { d[`${cl}[${i}]`] = v; }); } break;
            case 'text': case 'textarea': if (c.text) d[fn] = c.text; break;
            case 'star': if (c.val) d[fn] = c.val; break;
        }
    });
    return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==================== 启动 ====================
app.listen(PORT, () => {
    const fq = settingGet('daily_free_quota', '3');
    console.log(`
╔═══════════════════════════════════════════════╗
║     📋 问卷星自动填写平台 v2.0                 ║
║                                               ║
║  🌐 本地: http://localhost:${PORT}                ║
║  👤 管理员: admin / admin123                  ║
║  🆓 每日免费: ${fq} 次                         ║
║  💰 100次=10元 (再送10次→实得110次)           ║
║  🌐 随机IP: 已启用 (真实中国IP段)             ║
║  💾 数据: JSON 文件存储 (data/ 目录)          ║
╚═══════════════════════════════════════════════╝
`);
});
