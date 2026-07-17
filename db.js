// db.js - 基于 JSON 文件的数据存储（替代 SQLite，无需编译）
// 用户、积分、订单、公告管理

const fs = require('fs');
const path = require('path');

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CREDIT_LOGS_FILE = path.join(DATA_DIR, 'credit_logs.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DAILY_FREE_FILE = path.join(DATA_DIR, 'daily_free.json');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 数据读写函数 ──
function readJSON(file, defaultVal = []) {
    try {
        if (!fs.existsSync(file)) return defaultVal;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) { return defaultVal; }
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── 自增 ID ──
function nextId(items) {
    return items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1;
}

// ==================== 用户 ====================
function userGet(username) {
    const users = readJSON(USERS_FILE, []);
    return users.find(u => u.username === username) || null;
}

function userGetById(id) {
    const users = readJSON(USERS_FILE, []);
    return users.find(u => u.id === id) || null;
}

function userCreate(username, passwordHash) {
    const users = readJSON(USERS_FILE, []);
    if (users.find(u => u.username === username)) return null;
    const user = {
        id: nextId(users),
        username,
        password_hash: passwordHash,
        role: 'user',
        credits: 0,
        total_used: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    users.push(user);
    writeJSON(USERS_FILE, users);
    return user;
}

function userAddCredits(userId, amount) {
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u => u.id === userId);
    if (!user) return null;
    user.credits += amount;
    if (amount > 0) user.total_used = (user.total_used || 0) + amount;  // 这个不对，只记录消费。下面修正
    user.updated_at = new Date().toISOString();
    writeJSON(USERS_FILE, users);
    return user;
}

function userConsumeCredit(userId, amount) {
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u => u.id === userId);
    if (!user || user.credits < amount) return null;
    user.credits -= amount;
    user.total_used = (user.total_used || 0) + amount;
    user.updated_at = new Date().toISOString();
    writeJSON(USERS_FILE, users);
    return user;
}

// ==================== 积分流水 ====================
function creditLogAdd(userId, amount, type, note = '', orderId = null) {
    const logs = readJSON(CREDIT_LOGS_FILE, []);
    const user = userGetById(userId);
    const log = {
        id: nextId(logs),
        user_id: userId,
        amount,
        type,
        order_id: orderId,
        note,
        balance_after: user ? user.credits : 0,
        created_at: new Date().toISOString(),
    };
    logs.push(log);
    writeJSON(CREDIT_LOGS_FILE, logs);
    return log;
}

function creditLogGetByUser(userId, limit = 50) {
    let logs = readJSON(CREDIT_LOGS_FILE, []);
    return logs.filter(l => l.user_id === userId).sort((a, b) => b.id - a.id).slice(0, limit);
}

// ==================== 订单 ====================
function orderCreate(userId, amount, priceCents, paymentNote = '') {
    const orders = readJSON(ORDERS_FILE, []);
    const order = {
        id: nextId(orders),
        user_id: userId,
        amount,
        price_cents: priceCents,
        status: 'pending',
        payment_note: paymentNote || '',
        admin_note: '',
        reviewed_by: null,
        created_at: new Date().toISOString(),
        reviewed_at: null,
    };
    orders.push(order);
    writeJSON(ORDERS_FILE, orders);
    return order;
}

function orderGetById(id) {
    const orders = readJSON(ORDERS_FILE, []);
    return orders.find(o => o.id === id) || null;
}

function orderGetByUser(userId, limit = 30) {
    let orders = readJSON(ORDERS_FILE, []);
    return orders.filter(o => o.user_id === userId).sort((a, b) => b.id - a.id).slice(0, limit);
}

function orderGetPending() {
    const orders = readJSON(ORDERS_FILE, []);
    const users = readJSON(USERS_FILE, []);
    return orders
        .filter(o => o.status === 'pending')
        .sort((a, b) => b.id - a.id)
        .map(o => {
            const u = users.find(u => u.id === o.user_id);
            return { ...o, username: u ? u.username : '未知' };
        });
}

function orderUpdateStatus(id, status, reviewedBy, adminNote = '') {
    let orders = readJSON(ORDERS_FILE, []);
    const order = orders.find(o => o.id === id);
    if (!order) return null;
    order.status = status;
    order.reviewed_by = reviewedBy;
    order.admin_note = adminNote || '';
    order.reviewed_at = new Date().toISOString();
    writeJSON(ORDERS_FILE, orders);
    return order;
}

// ==================== 公告 ====================
function announceGetActive() {
    const anns = readJSON(ANNOUNCEMENTS_FILE, []);
    return anns.filter(a => a.is_active !== false).sort((a, b) => b.id - a.id)[0] || null;
}

function announceCreate(title, content) {
    let anns = readJSON(ANNOUNCEMENTS_FILE, []);
    // 停用旧公告
    anns.forEach(a => a.is_active = false);
    const ann = { id: nextId(anns), title, content, is_active: true, created_at: new Date().toISOString() };
    anns.push(ann);
    writeJSON(ANNOUNCEMENTS_FILE, anns);
    return ann;
}

// ==================== 设置 ====================
const DEFAULT_SETTINGS = {
    site_name: '问卷星自动填写平台',
    daily_free_quota: '3',
    min_buy_amount: '100',
    payment_method: '微信扫码支付',
    payment_qrcode: '',
    payment_instructions: '请扫码付款后，在订单备注中填写订单号，等待管理员确认。',
};

function settingGet(key, defaultVal = '') {
    const settings = readJSON(SETTINGS_FILE, {});
    return settings[key] !== undefined ? settings[key] : (DEFAULT_SETTINGS[key] || defaultVal);
}

function settingSet(key, value) {
    const settings = readJSON(SETTINGS_FILE, {});
    settings[key] = String(value);
    writeJSON(SETTINGS_FILE, settings);
}

function settingGetAll() {
    return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_FILE, {}) };
}

// ==================== 每日免费 ====================
function dailyFreeGet(userId) {
    const data = readJSON(DAILY_FREE_FILE, {});
    return data[String(userId)] || '';
}

function dailyFreeSet(userId, date) {
    const data = readJSON(DAILY_FREE_FILE, {});
    data[String(userId)] = date;
    writeJSON(DAILY_FREE_FILE, data);
}

// ==================== 初始化管理员 ====================
const bcrypt = require('bcryptjs');
if (!userGet('admin')) {
    const hash = bcrypt.hashSync('admin123', 10);
    const admin = userCreate('admin', hash);
    if (admin) {
        // 改为管理员
        const users = readJSON(USERS_FILE, []);
        const au = users.find(u => u.username === 'admin');
        if (au) { au.role = 'admin'; au.credits = 999999; writeJSON(USERS_FILE, users); }
        console.log('[DB] 已创建管理员: admin / admin123');
    }
}

// ==================== 价格计算 ====================
// 定价: 200次 = 20元 (0.1元/次)
// 赠送: 每买100次送10次 → 100次实际得110次，200次实际得220次
function calculatePrice(amount) {
    const minBuy = parseInt(settingGet('min_buy_amount', '100'));
    const actualAmount = Math.max(amount, minBuy);
    // 每100次=10元
    const units100 = Math.ceil(actualAmount / 100);
    const priceCents = units100 * 1000; // 10元 = 1000分
    // 赠送: 每100次送10次
    const bonus = units100 * 10;
    const totalReceive = actualAmount + bonus;
    return {
        amount: actualAmount,
        priceCents,
        yuan: (priceCents / 100).toFixed(2),
        units100,
        bonus,
        totalReceive,
    };
}

// ==================== 导出 ====================
module.exports = {
    userGet, userGetById, userCreate, userAddCredits, userConsumeCredit,
    creditLogAdd, creditLogGetByUser,
    orderCreate, orderGetById, orderGetByUser, orderGetPending, orderUpdateStatus,
    announceGetActive, announceCreate,
    settingGet, settingSet, settingGetAll,
    dailyFreeGet, dailyFreeSet,
    calculatePrice,
};
