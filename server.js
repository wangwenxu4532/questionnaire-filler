// server.js
// 问卷星自动填写平台 - 后端代理服务
// 核心功能：
//   1. 代理请求问卷星页面（解决跨域问题）
//   2. 分析题目结构返回给前端
//   3. 批量自动提交答卷

const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 中间件 ───
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 默认浏览器 UA（模拟真实浏览器）
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ==========================================================
//  API 1: 分析问卷 —— 获取页面、解析题目结构
//  POST /api/analyze
//  Body: { url: "https://www.wjx.cn/vm/xxxx.aspx" }
// ==========================================================
app.post('/api/analyze', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: '请提供问卷链接' });

        console.log(`[分析] 正在获取: ${url}`);

        // 获取问卷页面 HTML
        const response = await axios.get(url, {
            headers: {
                'User-Agent': DEFAULT_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': 'https://www.wjx.cn/',
            },
            timeout: 15000,
            maxRedirects: 5,
        });

        const html = response.data;
        const doc = new JSDOM(html).window.document;

        // ── 提取关键信息 ──
        const title = doc.querySelector('title')?.textContent || '未知问卷';
        const questions = parseQuestions(doc);

        // 提取提交URL（可能在 HTML 中或从页面URL推断）
        const submitUrl = extractSubmitUrl(doc, url);
        // 提取隐藏字段
        const hiddenFields = extractHiddenFields(doc);

        console.log(`[分析] 检测到 ${questions.length} 道题目, 提交地址: ${submitUrl}`);

        res.json({
            success: true,
            title,
            questionCount: questions.length,
            questions,
            submitUrl,
            hiddenFields,
            rawHtml: html,  // 原始HTML（供前端解析）
        });

    } catch (err) {
        console.error('[分析失败]', err.message);
        if (err.response) {
            // 返回状态码但内容是问卷页面的情况
            const html = err.response.data;
            if (typeof html === 'string' && html.includes('div_question')) {
                const doc = new JSDOM(html).window.document;
                const questions = parseQuestions(doc);
                const submitUrl = extractSubmitUrl(doc, url);
                const hiddenFields = extractHiddenFields(doc);
                console.log(`[分析-备用] 从错误响应中解析出 ${questions.length} 道题目`);
                return res.json({
                    success: true,
                    title: doc.querySelector('title')?.textContent || '问卷',
                    questionCount: questions.length,
                    questions,
                    submitUrl,
                    hiddenFields,
                    rawHtml: html,
                });
            }
        }
        res.status(500).json({
            success: false,
            error: `获取问卷失败: ${err.message}`,
            hint: '请检查链接是否正确，或确认问卷是否可以公开访问',
        });
    }
});

// ==========================================================
//  API 2: 提交问卷 —— 代理提交（解决跨域 + IP限制）
//  POST /api/submit
//  Body: { submitUrl, formData, referer }
// ==========================================================
app.post('/api/submit', async (req, res) => {
    try {
        const { submitUrl, formData, referer } = req.body;
        if (!submitUrl || !formData) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        console.log(`[提交] 目标: ${submitUrl}`);

        // 用 URLSearchParams 构建 form-urlencoded 数据
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(formData)) {
            if (Array.isArray(value)) {
                value.forEach(v => params.append(key, v));
            } else {
                params.append(key, value);
            }
        }

        const response = await axios.post(submitUrl, params.toString(), {
            headers: {
                'User-Agent': DEFAULT_UA,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Origin': new URL(submitUrl).origin,
                'Referer': referer || submitUrl.replace(/\/[^/]+\.aspx.*$/, '/'),
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout: 15000,
            maxRedirects: 3,
        });

        console.log(`[提交] 状态: ${response.status}, 响应长度: ${JSON.stringify(response.data).length}`);

        res.json({
            success: true,
            status: response.status,
            data: response.data,
        });

    } catch (err) {
        console.error('[提交失败]', err.message);
        if (err.response) {
            console.error('  状态码:', err.response.status);
            console.error('  响应:', typeof err.response.data === 'string' ? err.response.data.slice(0, 300) : JSON.stringify(err.response.data).slice(0, 300));
        }

        res.status(500).json({
            success: false,
            error: `提交失败: ${err.message}`,
            status: err.response?.status,
        });
    }
});

// ==========================================================
//  API 3: 批量提交
//  POST /api/batch-submit
//  Body: { submitUrl, formDataTemplate, count, delay, referer, questions }
// ==========================================================
app.post('/api/batch-submit', async (req, res) => {
    try {
        const { submitUrl, formDataTemplate, count, delay, referer, questions, customConfig, answerMode } = req.body;
        if (!submitUrl || !formDataTemplate) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        const totalCount = Math.min(count || 1, 500);  // 单次最多500
        const delayMs = Math.max(delay || 500, 200);    // 最小200ms间隔
        console.log(`[批量] 计划提交 ${totalCount} 份, 间隔 ${delayMs}ms, 模式: ${answerMode || 'random'}`);

        // 使用 SSE 流式返回进度
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < totalCount; i++) {
            try {
                // 根据模式生成答案
                let formData;
                if (answerMode === 'custom' && customConfig) {
                    // 纯自定义模式：完全使用用户配置，不随机
                    formData = applyCustomConfig(formDataTemplate, customConfig, questions);
                } else if (answerMode === 'mixed' && customConfig) {
                    // 混合模式：自定义优先，未设定则随机
                    formData = generateRandomAnswers(formDataTemplate, questions); // 先生成随机
                    formData = mergeCustomConfig(formData, customConfig, questions); // 再用自定义覆盖
                } else {
                    // 随机模式
                    formData = generateRandomAnswers(formDataTemplate, questions);
                }

                const params = new URLSearchParams();
                for (const [key, value] of Object.entries(formData)) {
                    if (Array.isArray(value)) {
                        value.forEach(v => params.append(key, v));
                    } else {
                        params.append(key, value);
                    }
                }

                const response = await axios.post(submitUrl, params.toString(), {
                    headers: {
                        'User-Agent': DEFAULT_UA,
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'Accept': '*/*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Origin': new URL(submitUrl).origin,
                        'Referer': referer || submitUrl,
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    timeout: 15000,
                    maxRedirects: 3,
                });

                // 判断是否提交成功
                const respData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                const isSuccess = response.status === 200 &&
                    (respData.includes('成功') || respData.includes('提交') || respData.includes('谢谢') || respData.includes('感谢') || respData.includes('success') || respData.includes('ok') || respData.includes('true'));

                if (isSuccess || response.status === 200) {
                    successCount++;
                } else {
                    failCount++;
                }

                // 发送进度事件
                res.write(`data: ${JSON.stringify({
                    type: 'progress',
                    current: i + 1,
                    total: totalCount,
                    success: successCount,
                    fail: failCount,
                    percent: Math.round(((i + 1) / totalCount) * 100),
                })}\n\n`);

            } catch (submitErr) {
                failCount++;
                res.write(`data: ${JSON.stringify({
                    type: 'progress',
                    current: i + 1,
                    total: totalCount,
                    success: successCount,
                    fail: failCount,
                    percent: Math.round(((i + 1) / totalCount) * 100),
                    lastError: submitErr.message,
                })}\n\n`);
            }

            // 间隔延迟
            if (i < totalCount - 1) {
                await sleep(delayMs);
            }
        }

        // 完成事件
        res.write(`data: ${JSON.stringify({
            type: 'complete',
            total: totalCount,
            success: successCount,
            fail: failCount,
        })}\n\n`);

        console.log(`[批量完成] ${successCount}/${totalCount} 成功, ${failCount} 失败`);
        res.end();

    } catch (err) {
        console.error('[批量失败]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        }
    }
});

// ==========================================================
//  API 4: 健康检查
// ==========================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ==========================================================
//  核心函数
// ==========================================================

/**
 * 解析问卷页面，提取所有题目
 */
function parseQuestions(doc) {
    const questions = [];
    const containers = findQuestionContainers(doc);

    containers.forEach((container, idx) => {
        const type = detectType(container);
        if (type === 'unknown') return;

        const title = extractTitle(container);
        if (!title || title.length < 2) return;

        const options = extractOptions(container, type);
        const fieldName = extractFieldName(container, type);

        questions.push({
            index: idx + 1,
            type,
            title: title.slice(0, 120),
            options,
            fieldName,  // 表单字段名（如 q1_1, q2[]）
        });
    });

    return questions;
}

/**
 * 寻找题目容器
 * 问卷星经典结构: div.div_question, fieldset
 */
function findQuestionContainers(doc) {
    const selectors = [
        '.div_question',
        'fieldset',
        '.question',
        '.field',
        '[id^="divquestion"]',
        '.topic',
        '.ui-field-contain',
    ];
    for (const sel of selectors) {
        const els = doc.querySelectorAll(sel);
        if (els.length >= 2) return Array.from(els);
    }
    return [];
}

/**
 * 检测题型
 */
function detectType(container) {
    const html = container.outerHTML || container.innerHTML;

    if (html.includes('sortrank') || html.includes('sort-item')) return 'sort';
    if (html.includes('rate_off') || html.includes('rate_on')) return 'star';
    if (html.includes('jqCheckbox') || container.querySelector('input[type="checkbox"]')) return 'checkbox';
    if (html.includes('jqRadio') || container.querySelector('input[type="radio"]')) return 'radio';
    if (container.querySelector('select')) return 'select';
    if (container.querySelector('textarea')) return 'textarea';
    if (container.querySelector('input[type="text"], input:not([type])')) return 'text';

    return 'unknown';
}

/**
 * 提取题目标题
 */
function extractTitle(container) {
    const titleSels = ['.div_title_question', 'legend', '.field-label', 'label:first-of-type', '.topic-title', 'h1', 'h2', 'h3'];
    for (const sel of titleSels) {
        const el = container.querySelector(sel);
        if (el && el.textContent.trim().length > 1) {
            return el.textContent.replace(/\s+/g, ' ').trim();
        }
    }
    return container.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * 提取选项列表
 */
function extractOptions(container, type) {
    const opts = [];

    if (type === 'radio') {
        container.querySelectorAll('a.jqRadio').forEach((a, i) => {
            opts.push({ index: i, text: a.textContent.trim().slice(0, 60), val: a.getAttribute('val') || String(i + 1) });
        });
        if (opts.length === 0) {
            container.querySelectorAll('input[type="radio"]').forEach((inp, i) => {
                const label = inp.closest('label') || inp.parentElement;
                opts.push({ index: i, text: (label?.textContent || inp.value || '').replace(/\s+/g, ' ').trim().slice(0, 60), val: inp.value || String(i + 1) });
            });
        }
    }

    if (type === 'checkbox') {
        container.querySelectorAll('a.jqCheckbox').forEach((a, i) => {
            opts.push({ index: i, text: a.textContent.trim().slice(0, 60), val: a.getAttribute('val') || String(i + 1) });
        });
        if (opts.length === 0) {
            container.querySelectorAll('input[type="checkbox"]').forEach((inp, i) => {
                const label = inp.closest('label') || inp.parentElement;
                opts.push({ index: i, text: (label?.textContent || inp.value || '').replace(/\s+/g, ' ').trim().slice(0, 60), val: inp.value || String(i + 1) });
            });
        }
    }

    return opts;
}

/**
 * 提取表单字段名（name属性）
 */
function extractFieldName(container, type) {
    if (type === 'radio') {
        const r = container.querySelector('input[type="radio"]');
        return r?.name || r?.getAttribute('name') || '';
    }
    if (type === 'checkbox') {
        const c = container.querySelector('input[type="checkbox"]');
        return c?.name || c?.getAttribute('name') || '';
    }
    if (type === 'text' || type === 'textarea') {
        const inp = container.querySelector('input[type="text"], input:not([type]), textarea');
        return inp?.name || inp?.getAttribute('name') || '';
    }
    return '';
}

/**
 * 提取提交URL
 */
function extractSubmitUrl(doc, pageUrl) {
    // 尝试从页面中寻找
    const formAction = doc.querySelector('form')?.getAttribute('action');
    if (formAction) {
        return new URL(formAction, pageUrl).href;
    }
    // 推断：将 /vm/xxx.aspx 替换为相关提交地址
    // 问卷星的提交通常是同一个URL或 ajaxpost 地址
    const baseUrl = pageUrl.replace(/\?.*$/, '');
    return baseUrl;  // 多数情况就是当前页面URL
}

/**
 * 提取隐藏表单字段（如 __VIEWSTATE 等）
 */
function extractHiddenFields(doc) {
    const fields = {};
    doc.querySelectorAll('input[type="hidden"]').forEach(inp => {
        const name = inp.getAttribute('name');
        const value = inp.getAttribute('value');
        if (name && value) fields[name] = value;
    });
    return fields;
}

/**
 * 根据模板和题目信息生成随机答案
 * 每调用一次生成一份全新的随机答卷
 */
function generateRandomAnswers(template, questions) {
    const data = { ...template };  // 复制隐藏字段

    if (!questions || questions.length === 0) {
        // 没有题目信息，直接微调模板
        return randomizeTemplate(template);
    }

    questions.forEach(q => {
        const fieldName = q.fieldName;
        if (!fieldName) return;

        switch (q.type) {
            case 'radio':
                if (q.options.length > 0) {
                    const pick = q.options[Math.floor(Math.random() * q.options.length)];
                    data[fieldName] = pick.val;
                }
                break;

            case 'checkbox': {
                // 随机选1-3个
                const count = 1 + Math.floor(Math.random() * Math.min(3, q.options.length));
                const shuffled = [...q.options].sort(() => Math.random() - 0.5);
                const picked = shuffled.slice(0, count);
                // 多选的name通常是 q2[]
                const cleanName = fieldName.replace('[]', '');
                if (fieldName.includes('[]')) {
                    data[cleanName] = picked.map(p => p.val);
                } else {
                    picked.forEach((p, i) => {
                        data[`${cleanName}[${i}]`] = p.val;
                    });
                }
                break;
            }

            case 'text':
            case 'textarea':
                const texts = [
                    '产品整体体验不错，希望能继续优化用户体验。',
                    '服务态度很好，功能齐全，会推荐给朋友使用。',
                    '使用体验良好，界面简洁美观，操作方便。',
                    '性价比不错，以后还会继续购买使用。',
                    '质量可靠，整体满意，值得推荐。',
                    '还不错，有些细节可以再优化一下就更好了。',
                ];
                data[fieldName] = texts[Math.floor(Math.random() * texts.length)];
                break;

            case 'select':
                if (q.options.length > 0) {
                    const pick = q.options[Math.floor(Math.random() * q.options.length)];
                    data[fieldName] = pick.val;
                }
                break;

            case 'star':
                data[fieldName] = String(3 + Math.floor(Math.random() * 3)); // 3-5星
                break;

            default:
                break;
        }
    });

    return data;
}

/**
 * 在没有题目信息时，随机微调模板数据
 */
function randomizeTemplate(template) {
    const data = { ...template };
    for (const [key, value] of Object.entries(data)) {
        // 单选题随机换
        if (typeof value === 'string' && !key.startsWith('__') && isNaN(Number(value))) {
            // 保持原样，因为不知道选项范围
        }
    }
    return data;
}

/**
 * 应用纯自定义配置（不随机）
 */
function applyCustomConfig(template, customConfig, questions) {
    const data = { ...template };
    if (!questions || questions.length === 0) return data;

    questions.forEach(q => {
        const fieldName = q.fieldName;
        if (!fieldName) return;
        const cfg = customConfig[fieldName];
        if (!cfg) return;  // 没有自定义配置则跳过（保持模板值）

        switch (q.type) {
            case 'radio':
            case 'select':
                data[fieldName] = cfg.val || '';
                break;
            case 'checkbox': {
                const cleanName = fieldName.replace('[]', '');
                if (fieldName.includes('[]')) {
                    data[cleanName] = cfg.vals || [];
                } else {
                    (cfg.vals || []).forEach((v, vi) => {
                        data[`${cleanName}[${vi}]`] = v;
                    });
                }
                break;
            }
            case 'text':
            case 'textarea':
                data[fieldName] = cfg.text || '';
                break;
            case 'star':
                data[fieldName] = cfg.val || '4';
                break;
        }
    });

    return data;
}

/**
 * 混合模式：先随机生成，再用自定义配置覆盖指定字段
 */
function mergeCustomConfig(randomData, customConfig, questions) {
    const data = { ...randomData };
    if (!questions || questions.length === 0) return data;

    questions.forEach(q => {
        const fieldName = q.fieldName;
        if (!fieldName) return;
        const cfg = customConfig[fieldName];
        if (!cfg) return;

        switch (q.type) {
            case 'radio':
            case 'select':
                data[fieldName] = cfg.val || data[fieldName];
                break;
            case 'checkbox': {
                const cleanName = fieldName.replace('[]', '');
                if (cfg.vals && cfg.vals.length > 0) {
                    if (fieldName.includes('[]')) {
                        data[cleanName] = cfg.vals;
                    } else {
                        cfg.vals.forEach((v, vi) => {
                            data[`${cleanName}[${vi}]`] = v;
                        });
                    }
                }
                break;
            }
            case 'text':
            case 'textarea':
                if (cfg.text) data[fieldName] = cfg.text;
                break;
            case 'star':
                if (cfg.val) data[fieldName] = cfg.val;
                break;
        }
    });

    return data;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── 启动服务器 ───
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════╗
║       📋 问卷星自动填写平台 v1.0         ║
║                                           ║
║  本地地址: http://localhost:${PORT}          ║
║  分析接口: POST /api/analyze              ║
║  提交接口: POST /api/submit               ║
║  批量接口: POST /api/batch-submit         ║
║                                           ║
╚═══════════════════════════════════════════╝
`);
});
