// ==UserScript==
// @name         飞书招聘候选人采集器（增强版）
// @namespace    https://bytedance.com/hire-grabber
// @version      2.2
// @description  一键采集飞书招聘候选人信息：字段选择、联系方式/评估结论自动补全、CSV导出、断点续抓、失败重试、台账提示词
// @match        *://*.feishu.cn/*
// @match        *://*.larksuite.com/*
// @match        *://*.larkoffice.com/*
// @match        *://*.bytedance.net/*
// @match        *://*.bytedance.com/*
// @include      /^https?:\/\/[^/]*hire[^/]*\//
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/pingwenchao/hire-candidate-grabber/main/hire-candidate-grabber.user.js
// @downloadURL  https://raw.githubusercontent.com/pingwenchao/hire-candidate-grabber/main/hire-candidate-grabber.user.js
// ==/UserScript==

/**
 * 飞书招聘候选人采集器（增强版） v2.2
 *
 * 功能概述：
 *   1. 在飞书招聘候选人列表页注入可拖拽的悬浮按钮
 *   2. 弹窗让用户勾选要采集的列（姓名/ID/链接固定输出）
 *   3. 自动滚动列表，逐行提取候选人基础信息（DOM 抓取）
 *   4. 对勾选了联系方式列的记录，并发调用 contact_info 接口补全手机号/邮箱
 *   5. 对勾选了评估结论列的记录，分页调用 application/list_v4 接口补全面试评估
 *   6. 结果面板支持搜索、筛选（全部/有联系方式/仅失败项）、脱敏显示
 *   7. 支持复制 JSON、导出 CSV（带 BOM + 公式注入防护）、复制邮箱、登台账提示词
 *   8. 断点续抓：每 5 轮滚动保存一次到 sessionStorage，刷新/中断后可恢复
 *   9. 失败重试：联系方式 429/5xx 自动指数退避重试，结果面板可手动重试失败项
 *
 * 技术要点：
 *   - 纯原生 JS，无外部依赖，@grant none，在页面主世界运行（可直接复用页面 cookie/fetch）
 *   - 所有面板通过 DOM 注入，z-index 999998/999999，不污染页面 JS 环境
 *   - 悬浮按钮容器只创建一次，用 display:none/flex 切换显隐，避免 SPA 导航时重建丢失位置
 *   - 联系方式接口可能 403（无权限），一旦 403 立即标记 contactBlocked 跳过后续请求
 *   - 评估接口用 POST list_v4，支持 offset 和 search_after_page_token 两种分页
 *   - AbortController + setTimeout 实现请求超时，路由变化/取消时统一 abort
 *
 * 数据安全：
 *   - 所有数据仅在浏览器本地处理，不发送到任何第三方服务
 *   - 配置存 localStorage，断点存 sessionStorage，关闭结果面板即清空断点
 */

(function () {
  'use strict';

  // ============ 存储工具 ============
  // 对 localStorage 的薄封装，统一加前缀并吞掉异常（隐私模式/配额满时不报错）
  const Storage = {
    PREFIX: '__hireGrabber_',
    get(key, def) {
      try {
        const raw = localStorage.getItem(this.PREFIX + key);
        return raw !== null ? JSON.parse(raw) : def;
      } catch (_) { return def; }
    },
    set(key, val) {
      try { localStorage.setItem(this.PREFIX + key, JSON.stringify(val)); } catch (_) {}
    }
  };

  // ============ 默认配置 ============
  // 用户可通过设置面板修改的参数；高级参数（超时/重试/滚动轮数等）不暴露 UI，仅在此处调
  const DEFAULT_CONFIG = {
    UNIQUE_MODE: 'talent',          // 去重维度：talent=按候选人去重 | application=按申请去重（同一人不同岗位各保留一条）
    CONTACT_CONCURRENCY: 6,         // 联系方式接口并发数
    CONTACT_GAP_MS: 120,            // 每个联系方式请求之间的间隔（ms），降低被限流概率
    REQUEST_TIMEOUT_MS: 10000,      // 单个请求超时时间（ms）
    MAX_RETRIES: 2,                 // 联系方式请求失败后最大重试次数（429/5xx/网络错误）
    RETRY_BASE_MS: 800,             // 指数退避基数（ms），实际延迟 = base * 2^attempt + 随机抖动
    SCROLL_STEP: 600,               // 每次滚动距离（px）
    SCROLL_WAIT_MS: 350,            // 每次滚动后固定等待（ms），让懒加载数据渲染
    BOTTOM_STABLE_ROUNDS: 6,        // 连续多少轮到底且无新数据后判定滚动结束
    FINAL_SCAN_WAIT_MS: 800,        // 滚动结束后额外等待（ms），再做最后一次扫描
    MAX_SCROLL_ROUNDS: 3000,        // 最大滚动轮数（安全上限，防止异常页面无限滚动）
    EVALUATION_PAGE_SIZE: 50,       // 评估结论接口每页条数
    EVALUATION_MAX_PAGES: 100,      // 评估结论接口最大分页数
    EVALUATION_PAGE_GAP_MS: 80,     // 评估结论分页请求间隔（ms）
    MASK_DISPLAY: true,             // 结果面板默认脱敏显示手机号/邮箱
    MASK_EXPORT: false,             // 导出 CSV / 复制 JSON 时是否也脱敏
    LEDGER_URL: '',                 // 常用台账链接（登台账时自动带入）
    FIELD_MAP: {},                  // 字段名映射 {原始列名: 台账字段名}，导出时替换表头
    FAB_POS: null                   // 悬浮按钮位置 {left, top}（px），null 表示默认右下角
  };

  // 合并用户配置（localStorage 中的旧配置覆盖默认值，但新增的默认字段会保留）
  let CONFIG = { ...DEFAULT_CONFIG, ...Storage.get('config', {}) };
  // 防御性校验：旧版本配置或手动篡改 localStorage 可能产生非法值（如并发数 0、字符串），统一 clamp 到安全范围
  // 注意：用 Number.isFinite 而非 ||，因为 0 是合法值（如请求间隔设为 0），|| 会误把 0 替换为默认值
  function clampConfigNum(v, def, min, max = Infinity) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  }
  CONFIG.CONTACT_CONCURRENCY = clampConfigNum(CONFIG.CONTACT_CONCURRENCY, 6, 1, 10);
  CONFIG.CONTACT_GAP_MS = clampConfigNum(CONFIG.CONTACT_GAP_MS, 120, 0);
  CONFIG.SCROLL_STEP = clampConfigNum(CONFIG.SCROLL_STEP, 600, 100);
  CONFIG.SCROLL_WAIT_MS = clampConfigNum(CONFIG.SCROLL_WAIT_MS, 350, 100);
  if (!['talent', 'application'].includes(CONFIG.UNIQUE_MODE)) CONFIG.UNIQUE_MODE = 'talent';

  // 持久化当前配置到 localStorage
  function saveConfig() { Storage.set('config', CONFIG); }

  // ============ 常量 ============
  // 所有注入面板的 DOM ID，集中管理避免冲突
  const IDS = {
    fabContainer: '__hireGrabberFabContainer',
    fab: '__hireGrabberFab',
    fabSettings: '__hireGrabberFabSettings',
    selectPanel: '__hireGrabberSelectPanel',
    settingsPanel: '__hireGrabberSettingsPanel',
    progressPanel: '__hireGrabberProgressPanel',
    resultPanel: '__hireGrabberResultPanel'
  };

  const CHECKPOINT_KEY = '__hireGrabberCheckpoint';

  // ============ 工具函数 ============
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 规范化文本：null/undefined 安全，合并连续空白为单个空格
  function normText(v) { return String(v ?? '').trim().replace(/\s+/g, ' '); }
  // 规范化表头：去所有空白并转小写，用于模糊匹配列名
  function normHeader(v) { return normText(v).replace(/\s+/g, '').toLowerCase(); }

  // 需要统一关闭的面板类型（FAB 容器不在此列，它只显隐不删除）
  const PANEL_IDS = ['selectPanel', 'settingsPanel', 'progressPanel', 'resultPanel'];
  function removePanels() {
    PANEL_IDS.forEach(k => document.getElementById(IDS[k])?.remove());
  }

  /**
   * 创建 DOM 元素的辅助函数
   * @param {string} tag - 标签名
   * @param {object} props - 属性/特性；text→textContent, html→innerHTML, className→className, 其余按 in 检查决定 property 还是 attribute
   * @param {object} styles - CSS 样式键值对，直接赋值给 style
   */
  function el(tag, props = {}, styles = {}) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'className') e.className = v;
      else if (k in e && typeof v !== 'object') e[k] = v;
      else e.setAttribute(k, v);
    }
    Object.assign(e.style, styles);
    return e;
  }

  // 手机号脱敏：保留前 3 后 4，中间 4 个 *
  function maskPhone(p) {
    if (!p || p.length < 7) return p;
    return p.slice(0, 3) + '****' + p.slice(-4);
  }
  // 邮箱脱敏：用户名保留前 2 位，域名保留
  function maskEmail(e) {
    if (!e || !e.includes('@')) return e;
    const [name, domain] = e.split('@');
    if (name.length <= 2) return name[0] + '***@' + domain;
    return name.slice(0, 2) + '***@' + domain;
  }

  // ============ 表头识别 ============
  // 根据表头文字判断联系方式列类型：phone | email | contact（电话+邮箱混合列）| ''（非联系方式列）
  function getContactType(name) {
    const n = normHeader(name);
    if (['电话', '手机号', '手机号码', '联系电话', 'mobile', 'phone'].includes(n)) return 'phone';
    if (['邮箱', '电子邮箱', '邮件', 'email', 'e-mail'].includes(n)) return 'email';
    if (['联系方式', '联系信息', '电话/邮箱', '电话邮箱', '手机/邮箱', '手机邮箱', 'contact'].includes(n)) return 'contact';
    return '';
  }

  // 当表头名无法直接判断时，启发式推断：检查前 10 行该列是否含 talent-tag 标签（联系方式列通常有解锁标签）
  function inferContactType(header) {
    const explicit = getContactType(header.name);
    if (explicit) return explicit;
    const rows = Array.from(document.querySelectorAll('tr.throne-biz-table-row')).slice(0, 10);
    const hasTag = rows.some(row => {
      const cell = row.querySelector(`td[data-throne-biz-table-col="${header.col}"]`);
      return Boolean(cell?.querySelector('.throne-biz-talent-tag'));
    });
    return hasTag ? 'contact' : '';
  }

  // 判断是否为姓名列（姓名列固定输出，不需要在勾选列表中重复出现）
  function isNameHeader(name) {
    return ['姓名', '候选人姓名', '候选人', '人才姓名', 'name'].includes(normHeader(name));
  }

  // 判断是否为评估结论列（评估列需调用接口补全，不直接取 DOM 文本）
  function isEvaluationHeader(name) {
    const n = normHeader(name);
    if (!n) return false;
    return ['评估结论', '面试结论', '评估结果', '面试评估结论', '评估意见'].includes(n) || n.includes('评估结论');
  }

  // 从 th/td 元素上提取列索引：优先 data-throne-biz-table-col，其次 aria-colindex（1-based），最后用 fallback
  function getColIndex(element, fallback) {
    const raw = element.getAttribute('data-throne-biz-table-col');
    if (raw !== null && /^\d+$/.test(raw)) return Number(raw);
    const aria = element.getAttribute('aria-colindex');
    if (aria !== null && /^\d+$/.test(aria)) return Number(aria) - 1;
    return fallback;
  }

  // 用指定选择器收集表头，按 col 去重并排序
  function collectHeaders(selector) {
    const map = new Map();
    document.querySelectorAll(selector).forEach((element, index) => {
      const name = normText(element.innerText || element.textContent);
      if (!name) return;
      const col = getColIndex(element, index);
      if (!map.has(col)) map.set(col, { col, name });
    });
    return Array.from(map.values()).sort((a, b) => a.col - b.col);
  }

  // 为表头补充输出名（重名列加序号后缀）和类型标记（联系方式/姓名/评估）
  function makeOutputNames(headers) {
    const counts = new Map();
    return headers.map(h => {
      const count = (counts.get(h.name) || 0) + 1;
      counts.set(h.name, count);
      return {
        ...h,
        outputName: count === 1 ? h.name : `${h.name}(${count})`,
        contactType: inferContactType(h),
        isName: isNameHeader(h.name),
        isEvaluation: isEvaluationHeader(h.name)
      };
    });
  }

  // 读取候选人列表表头：优先标准 thead，兜底多种 class 选择器
  function getHeaders() {
    let headers = collectHeaders('thead th, thead td');
    if (!headers.length) {
      headers = collectHeaders('.throne-biz-table-header-cell, [class*="table-header-cell"], [class*="header-cell"], [role="columnheader"]');
    }
    return makeOutputNames(headers);
  }

  // ============ 总人数自动探测 ============
  // 在页面中查找"共 N 人"文本，用于采集后核验人数是否一致；找不到返回 null
  function detectTotalCount() {
    // 1. 尝试常见选择器（total/count/pagination/summary 等类名）
    const selectors = [
      '[class*="total"]', '[class*="Total"]', '[class*="count"]', '[class*="Count"]',
      '[class*="pagination"]', '[class*="Pagination"]', '[class*="summary"]'
    ];
    for (const sel of selectors) {
      for (const node of document.querySelectorAll(sel)) {
        const text = normText(node.textContent);
        const m = text.match(/(?:共|共计|总计|合计)\s*([\d,]+)\s*[人条个项]/);
        if (m) return Number(m[1].replace(/,/g, ''));
      }
    }
    // 2. 在表格父级链中向上扫描 6 层
    const table = document.querySelector('.throne-biz-table, table');
    if (table) {
      let p = table.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const m = normText(p.textContent).match(/共\s*([\d,]+)\s*[人条个项]/);
        if (m) return Number(m[1].replace(/,/g, ''));
        p = p.parentElement;
      }
    }
    return null;
  }

  // ============ 滚动容器探测 ============
  // 找到真正负责候选人列表滚动的 DOM 元素（可能是表格内部 div 而非 window）
  // 策略：从第一行向上找所有 overflowY=auto/scroll 且 scrollHeight>clientHeight+100 的祖先，
  //       按其中包含的候选人行数打分，取最高分；兜底用 document.scrollingElement
  function findScroller() {
    const candidates = [];
    const rows = document.querySelectorAll('tr.throne-biz-table-row');
    if (rows.length) {
      let p = rows[0].parentElement;
      while (p && p !== document.body) {
        if (p.scrollHeight > p.clientHeight + 100) {
          const style = getComputedStyle(p);
          if (/(auto|scroll)/.test(style.overflowY)) {
            const rowCount = p.querySelectorAll('tr.throne-biz-table-row').length;
            candidates.push({ el: p, score: rowCount });
          }
        }
        p = p.parentElement;
      }
    }
    // 兜底：从候选人链接向上找
    if (!candidates.length) {
      const anchor = document.querySelector('a[href*="/hire/talent/"]');
      if (anchor) {
        let e = anchor.parentElement;
        while (e && e !== document.body) {
          if (e.scrollHeight > e.clientHeight + 100) {
            const style = getComputedStyle(e);
            if (/(auto|scroll)/.test(style.overflowY)) {
              candidates.push({ el: e, score: 1 });
            }
          }
          e = e.parentElement;
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || document.scrollingElement || document.documentElement;
  }

  // ============ 智能等待（DOM 变更稳定后继续） ============
  // 滚动后等待懒加载内容渲染完毕：用 MutationObserver 监听 DOM 变化，
  // 当连续 minMs 毫秒无变更、或总等待超过 maxMs 时 resolve
  function waitForStable(scroller, minMs = 200, maxMs = 2000) {
    return new Promise(resolve => {
      let lastChange = Date.now();
      const observer = new MutationObserver(() => { lastChange = Date.now(); });
      try {
        observer.observe(scroller, { childList: true, subtree: true, characterData: true });
      } catch (_) {
        // 某些元素（如 document.scrollingElement）不支持 observe，降级到 body
        observer.observe(document.body, { childList: true, subtree: true });
      }
      const start = Date.now();
      const tick = setInterval(() => {
        const elapsed = Date.now() - start;
        if (Date.now() - lastChange > minMs || elapsed > maxMs) {
          clearInterval(tick);
          observer.disconnect();
          resolve();
        }
      }, 100);
      // 安全兜底：maxMs+500 后必定结束，防止 observer 异常导致永久等待
      setTimeout(() => {
        clearInterval(tick);
        observer.disconnect();
        resolve();
      }, maxMs + 500);
    });
  }

  // ============ 行数据提取 ============
  // 获取指定单元格的文本：克隆节点后移除 talent-tag（解锁按钮等），避免标签文字混入
  function getCellText(row, col) {
    const cell = row.querySelector(`td[data-throne-biz-table-col="${col}"]`);
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.throne-biz-talent-tag').forEach(t => t.remove());
    return normText(clone.innerText || clone.textContent);
  }

  // 从候选人链接中解析 talentId 和 applicationId
  // 链接格式：/hire/talent/{talentId}?application_id=...
  function parseTalentLink(anchor) {
    try {
      const url = new URL(anchor.getAttribute('href') || '', location.origin);
      const m = url.pathname.match(/\/hire\/talent\/(\d+)/) || url.pathname.match(/\/talent\/(\d+)/);
      if (!m) return null;
      return { talentId: m[1], applicationId: url.searchParams.get('application_id') || '' };
    } catch (_) { return null; }
  }

  // 清洗姓名：去除括号备注（中英文括号），如"张三（实习）"→"张三"、"李四(外包)"→"李四"
  function cleanName(v) { return normText(v).replace(/[（(][^）)]*[）)]/g, '').trim(); }

  // 生成去重键：按候选人模式用 talentId；按申请模式用 talentId_applicationId
  function makeUniqueKey(talentId, applicationId) {
    return CONFIG.UNIQUE_MODE === 'application'
      ? `${talentId}_${applicationId || 'no_application'}`
      : talentId;
  }

  // ============ 评估结论 ============
  // 将单条评估记录格式化为"评估人：结论"字符串
  function getEvalStatus(ev) {
    // 优先使用接口返回的显式结论文案
    const explicit = ev.conclusion_name || ev.conclusion_text || ev.conclusion_label || ev.status_name;
    if (explicit) return normText(explicit);
    // commit_status=2 或 conclusion 为空表示未评估
    if (ev.commit_status === 2 || ev.conclusion == null) return '未评估';
    return { 1: '通过', 2: '未通过' }[ev.conclusion] || `结论${ev.conclusion}`;
  }

  // 将 stage_evaluation_list 格式化为"张三：通过；李四：未通过"字符串
  // 如果 URL 带 stage_id，只取该轮次的评估；否则取全部轮次
  function formatEvalList(stageList) {
    if (!Array.isArray(stageList)) return '';
    const stageId = new URL(location.href).searchParams.get('stage_id');
    const matched = stageId ? stageList.filter(s => String(s.stage_id || '') === stageId) : [];
    const stages = matched.length ? matched : stageList;
    const seen = new Set();
    const vals = [];
    stages.forEach(stage => {
      (stage.evaluation_list || []).forEach(ev => {
        const name = normText(ev.evaluator?.name || ev.evaluator?.i18n_name || ev.evaluator?.en_name);
        if (!name) return;
        const status = getEvalStatus(ev);
        const key = `${ev.evaluator?.id || name}_${status}`;
        if (seen.has(key)) return; // 同一评估人同一结论去重
        seen.add(key);
        vals.push(`${name}：${status}`);
      });
    });
    return vals.join('；');
  }

  // 从 document.cookie 中读取指定名称的 cookie 值（用于获取 CSRF token）
  function getCookie(name) {
    const prefix = name + '=';
    const item = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }

  // 从 URL 的 jobCategoryValue 参数中解析 job_active_status（在招/停招筛选），默认 1
  function getJobActiveStatus(url) {
    try {
      const raw = url.searchParams.get('jobCategoryValue');
      if (!raw) return 1;
      return Number(JSON.parse(raw).job_active_status ?? 1);
    } catch (_) { return 1; }
  }

  // 构建评估列表接口的 POST body，从当前 URL 提取 job_id/folder_id/stage_id 等筛选条件
  function buildEvalPayload(offset, pageToken = '') {
    const url = new URL(location.href);
    const jobId = url.searchParams.get('job_id') || '';
    const folderId = url.searchParams.get('folder_id') || '';
    const payload = {
      q: '', filters: '{}',
      sidebar_search_info: {
        job_id_list: jobId ? [jobId] : [],
        department_id_list: [], job_permission_list: [],
        job_active_status: getJobActiveStatus(url),
        subject_id_list: [],
        folder_id_list: folderId ? [folderId] : []
      },
      job_process_id: url.searchParams.get('job_process_id') || '20000',
      list_type: 1, time_zone: 'Asia/Shanghai',
      stage_id: url.searchParams.get('stage_id') || '',
      limit: CONFIG.EVALUATION_PAGE_SIZE, offset,
      enable_cross_stage_search: false
    };
    if (pageToken) payload.search_after_page_token = pageToken;
    return payload;
  }

  // 请求一页评估列表（POST /atsx/api/application/list_v4/），带超时和 CSRF 头
  async function fetchEvalPage(offset, pageToken, state) {
    const ctrl = new AbortController();
    state.activeControllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const csrf = getCookie('atsx-csrf-token');
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const resp = await fetch('/atsx/api/application/list_v4/', {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify(buildEvalPayload(offset, pageToken)),
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return JSON.parse(await resp.text());
    } finally {
      clearTimeout(timer);
      state.activeControllers.delete(ctrl);
    }
  }

  /**
   * 分页拉取评估结论并回填到 records
   * 评估接口返回的是全量申请列表（非按 talent_id 查询），所以用 byApp/byTalent 两个索引做匹配
   * @param {Array} records - 候选人记录数组
   * @param {Array} evalCols - 评估类型列配置
   * @param {object} state - 采集状态（cancelled/activeControllers 等）
   * @param {object} progress - 进度面板回调 {update}
   */
  async function collectEvaluations(records, evalCols, state, progress) {
    if (!evalCols.length || !records.length) return;
    // 建立 applicationId / talentId → record 的索引，用于接口返回时快速匹配
    const byApp = new Map(records.filter(r => r.applicationId).map(r => [String(r.applicationId), r]));
    const byTalent = new Map(records.filter(r => r.talentId).map(r => [String(r.talentId), r]));
    const unresolved = new Set(records);
    records.forEach(r => { r.evalStatus = 'pending'; });
    let offset = 0, pageToken = '', apiError = null;

    for (let page = 0; page < CONFIG.EVALUATION_MAX_PAGES && unresolved.size && !state.cancelled; page++) {
      progress.update(`接口抓取评估结论 ${page + 1} 页`, records.length - unresolved.size);
      let payload;
      try {
        payload = await fetchEvalPage(offset, pageToken, state);
      } catch (e) {
        apiError = e.message || String(e);
        break;
      }
      const rows = Array.isArray(payload?.data?.application_list) ? payload.data.application_list : [];
      if (!rows.length) break;

      rows.forEach(item => {
        const aid = String(item.application_id || item.id || '');
        const tid = String(item.talent_id || item.talent?.id || '');
        const record = byApp.get(aid) || byTalent.get(tid);
        if (!record) return;
        const value = formatEvalList(item.stage_evaluation_list || []);
        evalCols.forEach(c => { record.fields[c.outputName] = value; });
        record.evalStatus = value ? 'matched' : 'no_evaluation';
        unresolved.delete(record);
      });

      // 优先使用 search_after 分页 token；token 未变化时回退到 offset 分页
      const next = payload?.data?.search_after_page_token || payload?.data?.next_page_token ||
                   payload?.data?.page_token || payload?.data?.next_token || '';
      pageToken = (next && next !== pageToken) ? next : '';
      offset += rows.length;
      if (rows.length < CONFIG.EVALUATION_PAGE_SIZE && !pageToken) break;
      if (CONFIG.EVALUATION_PAGE_GAP_MS > 0) await sleep(CONFIG.EVALUATION_PAGE_GAP_MS);
    }

    // 未匹配到的记录：接口报错则标记 api_error，否则标记 no_evaluation
    unresolved.forEach(r => {
      r.evalStatus = apiError ? 'api_error' : 'no_evaluation';
      evalCols.forEach(c => { if (!(c.outputName in r.fields)) r.fields[c.outputName] = ''; });
    });
    state.evalApiError = apiError;
    state.evalMatched = records.filter(r => r.evalStatus === 'matched').length;
    state.evalNoEval = records.filter(r => r.evalStatus === 'no_evaluation').length;
    state.evalApiErrorCount = records.filter(r => r.evalStatus === 'api_error').length;
  }

  // ============ 联系方式 ============
  // 解析 contact_info 接口返回，提取手机号（去掉 86 国家码前缀）和邮箱
  function parseContactPayload(payload) {
    const c = payload?.data?.talent_contact_info;
    if (!c || typeof c !== 'object') return null;
    const digits = String(c.mobile || '').replace(/\D/g, '');
    const phone = digits.replace(/^86(?=1[3-9]\d{9}$)/, '');
    return { email: String(c.email || '').trim(), phone };
  }

  // 计算重试延迟：优先用 Retry-After 头（秒），否则指数退避 + 随机抖动
  function retryDelay(resp, attempt) {
    const ra = resp?.headers?.get('Retry-After');
    if (ra && /^\d+$/.test(ra)) return Math.min(Number(ra) * 1000, 10000);
    return CONFIG.RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
  }

  /**
   * 获取单个候选人的联系方式（GET /atsx/api/talent/contact_info/）
   * 返回 {status, phone?, email?, httpStatus?}
   * status 可能值：success | forbidden | skipped_after_forbidden | rate_limited | server_error |
   *               http_error | parse_failed | timeout | request_failed | cancelled
   * - 401/403：无权限，立即标记 contactBlocked，后续所有请求直接跳过
   * - 429/5xx：自动重试（指数退避），超过 MAX_RETRIES 后返回对应状态
   * - 超时/网络错误：自动重试
   */
  async function fetchContact(record, needPhone, needEmail, state) {
    const params = new URLSearchParams({
      talent_id: record.talentId,
      with_email: String(needEmail),
      with_mobile: String(needPhone)
    });
    const url = `/atsx/api/talent/contact_info/?${params}`;

    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      if (state.cancelled) return { status: 'cancelled' };
      if (state.contactBlocked) return { status: 'skipped_after_forbidden' };

      const ctrl = new AbortController();
      state.activeControllers.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (resp.status === 401 || resp.status === 403) { state.contactBlocked = true; return { status: 'forbidden', httpStatus: resp.status }; }
        if (resp.status === 429) { if (attempt < CONFIG.MAX_RETRIES) { await sleep(retryDelay(resp, attempt)); continue; } return { status: 'rate_limited', httpStatus: 429 }; }
        if (resp.status >= 500) { if (attempt < CONFIG.MAX_RETRIES) { await sleep(retryDelay(resp, attempt)); continue; } return { status: 'server_error', httpStatus: resp.status }; }
        if (!resp.ok) return { status: 'http_error', httpStatus: resp.status };
        let payload;
        try { payload = JSON.parse(await resp.text()); } catch (_) { return { status: 'parse_failed' }; }
        const contact = parseContactPayload(payload);
        if (!contact) return { status: 'parse_failed' };
        return { status: 'success', ...contact };
      } catch (e) {
        if (state.cancelled) return { status: 'cancelled' };
        const status = e?.name === 'AbortError' ? 'timeout' : 'request_failed';
        if (attempt < CONFIG.MAX_RETRIES) { await sleep(retryDelay(null, attempt)); continue; }
        return { status };
      } finally {
        clearTimeout(timer);
        state.activeControllers.delete(ctrl);
      }
    }
    return { status: 'request_failed' };
  }

  /**
   * 并发获取所有候选人的联系方式
   * 用 N 个 worker 协程从共享 cursor 取任务，已 success 的记录跳过（断点续抓）
   */
  async function collectContacts(records, needPhone, needEmail, state, progress) {
    if (!needPhone && !needEmail) return;
    records.forEach(r => {
      if (needPhone) r.phone = r.phone || '';
      if (needEmail) r.email = r.email || '';
      if (!r.contactStatus || r.contactStatus === 'pending') r.contactStatus = 'pending';
    });

    let cursor = 0, processed = 0;
    async function worker() {
      while (!state.cancelled) {
        const i = cursor++;
        if (i >= records.length) return;
        const r = records[i];
        // 断点恢复时已成功的记录跳过
        if (r.contactStatus === 'success') { processed++; progress.update('接口抓取', records.length, processed, records.length); continue; }
        const result = await fetchContact(r, needPhone, needEmail, state);
        r.contactStatus = result.status;
        r.contactHttpStatus = result.httpStatus || null;
        if (result.status === 'success') {
          if (needPhone) r.phone = result.phone || '';
          if (needEmail) r.email = result.email || '';
        }
        processed++;
        progress.update('接口抓取', records.length, processed, records.length);
        if (CONFIG.CONTACT_GAP_MS > 0) await sleep(CONFIG.CONTACT_GAP_MS);
      }
    }
    const n = Math.min(CONFIG.CONTACT_CONCURRENCY, records.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    // 取消时仍处于 pending 的记录标记为 cancelled
    if (state.cancelled) records.forEach(r => { if (r.contactStatus === 'pending') r.contactStatus = 'cancelled'; });
  }

  // ============ 断点续抓 ============
  // 断点存 sessionStorage（关闭标签页自动清除），包含 URL、时间戳、已抓记录和选中列
  function saveCheckpoint(data) {
    try {
      sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ time: Date.now(), ...data }));
    } catch (_) {}
  }
  function loadCheckpoint() {
    try {
      const raw = sessionStorage.getItem(CHECKPOINT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function clearCheckpoint() { sessionStorage.removeItem(CHECKPOINT_KEY); }

  // ============ 输出构建 ============
  // 应用字段名映射：如果用户在设置中配置了 {原始名: 台账字段名}，导出时替换
  function applyFieldMap(name) {
    return CONFIG.FIELD_MAP?.[name] || name;
  }

  // 将内部记录数组转为导出用的普通对象数组
  // 固定输出：姓名、候选人ID、申请ID、候选人链接；其余按用户勾选列追加
  function buildOutput(records, selectedCols, needPhone, needEmail, maskExport) {
    const textCols = selectedCols.filter(c => !c.contactType && !c.isName && !c.isEvaluation);
    const evalCols = selectedCols.filter(c => c.isEvaluation);
    return records.map(r => {
      const out = {
        [applyFieldMap('姓名')]: r.name,
        [applyFieldMap('候选人ID')]: r.talentId,
        [applyFieldMap('申请ID')]: r.applicationId,
        [applyFieldMap('候选人链接')]: r.talentUrl || ''
      };
      textCols.forEach(c => { out[applyFieldMap(c.outputName)] = r.fields[c.outputName] || ''; });
      evalCols.forEach(c => { out[applyFieldMap(c.outputName)] = r.fields[c.outputName] || ''; });
      if (needPhone) out[applyFieldMap('电话')] = maskExport ? maskPhone(r.phone) : (r.phone || '');
      if (needEmail) out[applyFieldMap('邮箱')] = maskExport ? maskEmail(r.email) : (r.email || '');
      return out;
    });
  }

  // 统计某字段的重复情况：dupes=有多少个不同值出现了重复，extra=多出的记录条数
  function countDupes(records, key) {
    const counts = new Map();
    records.forEach(r => { const v = r[key]; if (v) counts.set(v, (counts.get(v) || 0) + 1); });
    let extra = 0, dupes = 0;
    counts.forEach(c => { if (c > 1) { dupes++; extra += c - 1; } });
    return { dupes, extra };
  }

  // ============ CSV 导出 ============
  // 将对象数组转为 CSV 字符串：
  // - 带 UTF-8 BOM（\ufeff），Excel 打开不乱码
  // - 以 = + - @ Tab 回车开头的值前置单引号，防止 CSV 公式注入
  // - 含逗号/引号/换行的值用双引号包裹，内部双引号转义为两个双引号
  function toCSV(data) {
    if (!data.length) return '';
    const keys = Object.keys(data[0]);
    const esc = v => {
      let s = String(v ?? '');
      if (s && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [keys.map(esc).join(',')];
    data.forEach(r => lines.push(keys.map(k => esc(r[k])).join(',')));
    return '\ufeff' + lines.join('\r\n');
  }

  // 触发浏览器下载 CSV 文件
  function downloadCSV(filename, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延迟撤销 URL，避免部分浏览器在下载尚未开始时就释放了 blob
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ============ 复制工具 ============
  // 复制文本到剪贴板：优先用 Clipboard API，失败时降级到 textarea + execCommand
  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {
      const ta = el('textarea', { value: text }, { position: 'fixed', left: '-9999px' });
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  // 从记录中提取去重邮箱列表：支持分号/逗号/空白分隔多邮箱，按小写去重保留原始大小写
  function collectEmailsFromRecords(records) {
    const map = new Map();
    records.forEach(r => String(r.email || '').split(/[;,，；\s]+/).map(e => e.trim()).filter(Boolean).forEach(e => {
      const key = e.toLowerCase();
      if (!map.has(key)) map.set(key, e);
    }));
    return [...map.values()];
  }

  // ============ 浮动按钮（可拖拽） ============
  let fabDragging = false;      // FAB 是否正在被拖拽（拖拽中不隐藏容器）
  let isGrabbing = false;       // 采集是否进行中（防止重复点击启动多个采集流程）
  let currentRunState = null;   // 当前采集流程的 state 引用（路由变化时用于中止）

  // 创建或显示悬浮按钮容器。容器只创建一次，后续用 display:none/flex 切换，
  // 避免 SPA 导航时候选人表格短暂消失导致容器被删除重建、拖拽位置丢失
  function showFab() {
    let container = document.getElementById(IDS.fabContainer);
    if (container) { container.style.display = 'flex'; return; }
    container = el('div', { id: IDS.fabContainer, title: '按住可拖动，双击空白处复位' }, {
      position: 'fixed', zIndex: '999998',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
      padding: '6px', borderRadius: '28px',
      background: 'rgba(51,112,255,0.08)',
      cursor: 'grab', userSelect: 'none', fontFamily: 'sans-serif'
    });

    const fab = el('button', { id: IDS.fab, text: '📋 采集候选人' }, {
      background: '#3370ff', color: '#fff', border: 'none', borderRadius: '24px',
      padding: '10px 20px', fontSize: '14px', cursor: 'pointer',
      boxShadow: '0 4px 16px rgba(51,112,255,.4)',
      display: 'flex', alignItems: 'center', gap: '6px'
    });
    const gear = el('button', { id: IDS.fabSettings, text: '⚙️', title: '采集器设置' }, {
      background: '#fff', color: '#333', border: '1px solid #ddd', borderRadius: '50%',
      width: '36px', height: '36px', fontSize: '16px', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.15)'
    });
    fab.addEventListener('click', startFlow);
    gear.addEventListener('click', () => showSettings());
    container.append(fab, gear);
    document.body.appendChild(container);

    // 恢复上次拖拽位置，需在 appendChild 后用容器实际尺寸 clamp，防止窗口缩小后按钮跑出屏幕
    const pos = CONFIG.FAB_POS;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      const maxL = Math.max(0, window.innerWidth - container.offsetWidth);
      const maxT = Math.max(0, window.innerHeight - container.offsetHeight);
      container.style.left = Math.min(Math.max(0, pos.left), maxL) + 'px';
      container.style.top = Math.min(Math.max(0, pos.top), maxT) + 'px';
    } else {
      container.style.right = '24px';
      container.style.bottom = '80px';
    }

    makeFabDraggable(container);
  }

  function hideFab() {
    if (fabDragging) return; // 拖拽中不隐藏，避免松手时容器被删导致位置丢失
    const container = document.getElementById(IDS.fabContainer);
    if (container) container.style.display = 'none';
  }

  // 判断当前页面是否为候选人列表页（既有候选人链接又有表格行/表格元素）
  function isCandidateListPage() {
    return !!document.querySelector('a[href*="/hire/talent/"]') &&
           !!document.querySelector('tr.throne-biz-table-row, .throne-biz-table');
  }

  // ============ 设置面板 ============
  // 渲染设置弹窗：去重模式、并发数、请求间隔、滚动参数、脱敏、台账链接、字段映射
  function showSettings() {
    document.getElementById(IDS.settingsPanel)?.remove();
    const panel = el('div', { id: IDS.settingsPanel }, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '999999', background: '#fff', border: '2px solid #3370ff',
      borderRadius: '10px', padding: '20px', boxShadow: '0 8px 32px rgba(0,0,0,.3)',
      width: '520px', maxHeight: '85vh', overflowY: 'auto', fontFamily: 'sans-serif'
    });

    panel.appendChild(el('div', { text: '⚙️ 采集器设置' }, {
      fontWeight: 'bold', fontSize: '16px', color: '#3370ff', marginBottom: '16px'
    }));

    const fields = [
      { key: 'UNIQUE_MODE', label: '去重模式', type: 'select', options: [['talent', '按候选人（同一人只保留一条）'], ['application', '按申请（同一人不同岗位分别保留）']] },
      { key: 'CONTACT_CONCURRENCY', label: '联系方式并发数（1-10）', type: 'number', min: 1, max: 10 },
      { key: 'CONTACT_GAP_MS', label: '联系方式请求间隔（ms）', type: 'number', min: 0 },
      { key: 'SCROLL_STEP', label: '每次滚动距离（px）', type: 'number', min: 100 },
      { key: 'SCROLL_WAIT_MS', label: '滚动后等待（ms）', type: 'number', min: 100 },
    ];

    const inputs = {};
    fields.forEach(f => {
      const row = el('div', {}, { marginBottom: '10px' });
      row.appendChild(el('label', { text: f.label }, { display: 'block', fontSize: '13px', marginBottom: '4px', color: '#555' }));
      let input;
      if (f.type === 'select') {
        input = el('select', {}, { width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px' });
        f.options.forEach(([v, t]) => {
          const opt = el('option', { value: v, text: t });
          if (CONFIG[f.key] === v) opt.selected = true;
          input.appendChild(opt);
        });
      } else {
        input = el('input', { type: 'number', value: CONFIG[f.key] }, {
          width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box'
        });
      }
      inputs[f.key] = input;
      row.appendChild(input);
      panel.appendChild(row);
    });

    // 脱敏设置：面板显示脱敏 + 导出脱敏
    const maskRow = el('div', {}, { marginBottom: '10px' });
    const maskDisplayCb = el('input', { type: 'checkbox' }, { marginRight: '4px' });
    maskDisplayCb.checked = CONFIG.MASK_DISPLAY;
    const maskExportCb = el('input', { type: 'checkbox' }, { marginRight: '4px', marginLeft: '16px' });
    maskExportCb.checked = CONFIG.MASK_EXPORT;
    const maskDisplayLabel = el('label', {}, { fontSize: '13px' });
    maskDisplayLabel.append(maskDisplayCb, document.createTextNode(' 面板中脱敏显示'));
    const maskExportLabel = el('label', {}, { fontSize: '13px' });
    maskExportLabel.append(maskExportCb, document.createTextNode(' 导出/复制时也脱敏'));
    maskRow.append(maskDisplayLabel, maskExportLabel);
    panel.appendChild(maskRow);

    // 台账链接
    const ledgerRow = el('div', {}, { marginBottom: '10px' });
    ledgerRow.appendChild(el('label', { text: '常用台账链接' }, { display: 'block', fontSize: '13px', marginBottom: '4px', color: '#555' }));
    const ledgerInput = el('input', { type: 'text', value: CONFIG.LEDGER_URL, placeholder: 'https://...' }, {
      width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box'
    });
    ledgerRow.appendChild(ledgerInput);
    panel.appendChild(ledgerRow);

    // 字段映射（JSON）
    const mapRow = el('div', {}, { marginBottom: '10px' });
    mapRow.appendChild(el('label', { text: '字段映射（JSON，可选）' }, { display: 'block', fontSize: '13px', marginBottom: '4px', color: '#555' }));
    mapRow.appendChild(el('div', { text: '例：{"应聘岗位":"投递职位","学历":"最高学历"}' }, { fontSize: '11px', color: '#999', marginBottom: '4px' }));
    const mapInput = el('textarea', { text: JSON.stringify(CONFIG.FIELD_MAP, null, 2) }, {
      width: '100%', height: '80px', padding: '6px 8px', border: '1px solid #ddd', borderRadius: '4px',
      fontSize: '12px', fontFamily: 'monospace', boxSizing: 'border-box'
    });
    mapRow.appendChild(mapInput);
    panel.appendChild(mapRow);

    const actions = el('div', {}, { textAlign: 'right', marginTop: '16px' });
    const cancelBtn = el('button', { text: '取消' }, {
      border: '1px solid #ddd', background: '#fff', borderRadius: '6px', padding: '8px 18px', cursor: 'pointer', marginRight: '8px'
    });
    const saveBtn = el('button', { text: '保存' }, {
      background: '#3370ff', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 24px', cursor: 'pointer'
    });
    actions.append(cancelBtn, saveBtn);
    panel.appendChild(actions);
    document.body.appendChild(panel);

    cancelBtn.onclick = () => panel.remove();
    saveBtn.onclick = () => {
      const errors = [];
      fields.forEach(f => {
        const v = inputs[f.key].value;
        if (f.type === 'select') { CONFIG[f.key] = v; return; }
        const n = Number(v);
        if (!Number.isFinite(n)) { errors.push(f.label); return; }
        let clamped = n;
        if (f.min !== undefined) clamped = Math.max(f.min, clamped);
        if (f.max !== undefined) clamped = Math.min(f.max, clamped);
        if (clamped !== n) inputs[f.key].value = clamped;
        CONFIG[f.key] = clamped;
      });
      if (errors.length) { alert('以下项输入无效（需为数字）：\n' + errors.join('\n')); return; }
      CONFIG.MASK_DISPLAY = maskDisplayCb.checked;
      CONFIG.MASK_EXPORT = maskExportCb.checked;
      CONFIG.LEDGER_URL = ledgerInput.value.trim();
      try { CONFIG.FIELD_MAP = JSON.parse(mapInput.value || '{}'); } catch (_) { alert('字段映射 JSON 格式有误'); return; }
      saveConfig();
      panel.remove();
    };
  }

  // ============ 列选择面板 ============
  // 渲染列勾选弹窗，返回 Promise<选中的列配置数组 | null（用户取消）>
  function showSelectPanel(headers) {
    return new Promise(resolve => {
      document.getElementById(IDS.selectPanel)?.remove();
      const panel = el('div', { id: IDS.selectPanel }, {
        position: 'fixed', top: '30px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '999999', background: '#fff', border: '2px solid #3370ff',
        borderRadius: '10px', padding: '16px', boxShadow: '0 8px 32px rgba(0,0,0,.3)',
        width: '500px', fontFamily: 'sans-serif', maxHeight: '85vh', overflowY: 'auto'
      });

      panel.appendChild(el('div', { text: '勾选要抓取的列' }, { fontWeight: 'bold', fontSize: '15px', color: '#3370ff', marginBottom: '4px' }));
      panel.appendChild(el('div', { text: `${headers.length} 个列，默认全选；姓名和唯一 ID 固定输出` }, { fontSize: '12px', color: '#999', marginBottom: '10px' }));

      // 快速设置行：去重模式
      const quickRow = el('div', {}, { display: 'flex', gap: '12px', marginBottom: '10px', fontSize: '12px', alignItems: 'center' });
      const dedupLabel = el('label', {}, { cursor: 'pointer' });
      dedupLabel.appendChild(document.createTextNode('去重：'));
      const dedupSel = el('select', {}, { fontSize: '12px', padding: '2px 4px' });
      [['talent', '按候选人'], ['application', '按申请']].forEach(([v, t]) => {
        const o = el('option', { value: v, text: t });
        if (CONFIG.UNIQUE_MODE === v) o.selected = true;
        dedupSel.appendChild(o);
      });
      dedupLabel.appendChild(dedupSel);
      quickRow.appendChild(dedupLabel);
      panel.appendChild(quickRow);

      // 全选/取消全选
      const allLabel = el('label', {}, { fontSize: '13px', cursor: 'pointer' });
      const allCb = el('input', { type: 'checkbox', checked: true }, { marginRight: '4px' });
      allLabel.append(allCb, document.createTextNode('全选 / 取消全选'));
      panel.appendChild(allLabel);

      // 列勾选网格（两列布局），联系方式列和评估列显示接口标签
      const grid = el('div', {}, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', marginTop: '8px', marginBottom: '12px' });
      const cbs = headers.map(h => {
        const label = el('label', {}, { fontSize: '13px', cursor: 'pointer' });
        const cb = el('input', { type: 'checkbox', checked: true }, { marginRight: '4px' });
        cb.__meta = h;
        label.append(cb, document.createTextNode(h.name));
        if (h.contactType) {
          const tag = h.contactType === 'phone' ? '电话接口' : h.contactType === 'email' ? '邮箱接口' : '联系方式接口';
          label.appendChild(el('span', { text: `（${tag}）` }, { color: '#3370ff', fontSize: '11px' }));
        }
        if (h.isEvaluation) label.appendChild(el('span', { text: '（评估接口）' }, { color: '#722ed1', fontSize: '11px' }));
        grid.appendChild(label);
        return cb;
      });
      panel.appendChild(grid);

      const actions = el('div', {}, { textAlign: 'right' });
      const cancelBtn = el('button', { text: '取消' }, { border: '1px solid #ddd', background: '#fff', borderRadius: '6px', padding: '8px 18px', cursor: 'pointer', marginRight: '8px' });
      const startBtn = el('button', { text: '开始抓取' }, { background: '#3370ff', color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 24px', cursor: 'pointer', fontSize: '14px' });
      actions.append(cancelBtn, startBtn);
      panel.appendChild(actions);
      document.body.appendChild(panel);

      allCb.onchange = () => cbs.forEach(cb => { cb.checked = allCb.checked; });
      cbs.forEach(cb => cb.onchange = () => {
        const n = cbs.filter(c => c.checked).length;
        allCb.checked = n === cbs.length;
        allCb.indeterminate = n > 0 && n < cbs.length;
      });
      cancelBtn.onclick = () => { panel.remove(); resolve(null); };
      startBtn.onclick = () => {
        const selected = cbs.filter(cb => cb.checked).map(cb => cb.__meta);
        if (!selected.length) { alert('至少勾选一列'); return; }
        CONFIG.UNIQUE_MODE = dedupSel.value;
        saveConfig();
        panel.remove();
        resolve(selected);
      };
    });
  }

  // ============ 进度面板 ============
  // 顶部蓝色进度条，显示当前阶段/已抓人数/联系方式进度/耗时，带取消按钮
  // 返回 {update(label, count, pc?, tc?), remove()}
  function showProgress(state, startedAt) {
    const panel = el('div', { id: IDS.progressPanel }, {
      position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '999999', background: '#3370ff', color: '#fff', padding: '10px 14px',
      borderRadius: '8px', fontFamily: 'sans-serif', fontSize: '14px',
      display: 'flex', alignItems: 'center', gap: '12px'
    });
    const text = el('span', { text: '准备中...' });
    const cancelBtn = el('button', { text: '取消' }, {
      border: '1px solid rgba(255,255,255,.8)', background: 'transparent', color: '#fff',
      borderRadius: '4px', padding: '3px 10px', cursor: 'pointer'
    });
    cancelBtn.onclick = () => {
      state.cancelled = true;
      state.activeControllers.forEach(c => c.abort());
      text.textContent = '正在取消...';
    };
    panel.append(text, cancelBtn);
    document.body.appendChild(panel);
    return {
      update(label, count, pc = null, tc = null) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const ct = pc === null ? '' : ` | 联系方式 ${pc}/${tc}`;
        text.textContent = `${label}... ${count} 人${ct} | ${elapsed}s`;
      },
      remove() { panel.remove(); }
    };
  }

  // ============ 结果面板 ============
  /**
   * 渲染采集结果面板
   * @param {Array} records - 全部候选人记录
   * @param {Array} selectedCols - 用户选中的列配置
   * @param {boolean} needPhone - 是否需要电话
   * @param {boolean} needEmail - 是否需要邮箱
   * @param {number|null} expectedCount - 页面探测到的总人数（用于核验）
   * @param {object} state - 采集状态
   * @param {number} startedAt - 采集开始时间戳
   */
  function showResult(records, selectedCols, needPhone, needEmail, expectedCount, state, startedAt) {
    document.getElementById(IDS.resultPanel)?.remove();

    let filterMode = 'all';     // all=全部 | contact=有联系方式 | failed=仅失败项
    let searchTerm = '';
    let maskDisplay = CONFIG.MASK_DISPLAY;

    // 根据当前筛选模式和搜索词过滤记录
    function getFiltered() {
      return records.filter(r => {
        if (filterMode === 'contact') {
          // 至少有一种所需的联系方式才保留
          const hasNeededPhone = needPhone && !!r.phone;
          const hasNeededEmail = needEmail && !!r.email;
          if (!hasNeededPhone && !hasNeededEmail) return false;
        }
        if (filterMode === 'failed') {
          // 联系方式非成功/非取消状态，或评估接口报错
          const contactFail = r.contactStatus && r.contactStatus !== 'success' && r.contactStatus !== 'cancelled';
          const evalFail = r.evalStatus === 'api_error';
          if (!contactFail && !evalFail) return false;
        }
        if (searchTerm) {
          const hay = [r.name, r.phone, r.email, ...Object.values(r.fields || {})].join(' ').toLowerCase();
          if (!hay.includes(searchTerm.toLowerCase())) return false;
        }
        return true;
      });
    }

    function buildJSON() {
      const filtered = getFiltered();
      const out = buildOutput(filtered, selectedCols, needPhone, needEmail, CONFIG.MASK_EXPORT);
      return JSON.stringify(out, null, 2);
    }

    // 面板使用 flex 列布局，textarea 占满剩余空间，随面板 resize 自适应
    const panel = el('div', { id: IDS.resultPanel }, {
      position: 'fixed', top: '40px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '999999', background: '#fff', border: '2px solid #3370ff',
      borderRadius: '8px', padding: '12px', boxShadow: '0 4px 24px rgba(0,0,0,.3)',
      width: '680px', maxWidth: '95vw', maxHeight: '92vh',
      minWidth: '480px', minHeight: '320px', resize: 'both', overflow: 'hidden',
      boxSizing: 'border-box', fontFamily: 'sans-serif',
      display: 'flex', flexDirection: 'column'
    });

    // ---- 汇总信息 ----
    const statusCounts = {};
    records.forEach(r => { if (r.contactStatus) statusCounts[r.contactStatus] = (statusCounts[r.contactStatus] || 0) + 1; });
    const contactFailures = Object.entries(statusCounts).filter(([s]) => s !== 'success').reduce((sum, [, c]) => sum + c, 0);

    const lines = [];
    lines.push(`抓取唯一记录：${records.length} 人（当前筛选 ${getFiltered().length} 人）`);
    lines.push(expectedCount === null ? '页面总数：未探测到' : `页面总数：${expectedCount} 人${expectedCount === records.length ? ' ✅' : ' ⚠️ 不一致'}`);
    if (needPhone) {
      const missing = records.filter(r => !r.phone).length;
      const d = countDupes(records, 'phone');
      lines.push(`电话：缺失 ${missing}，重复 ${d.dupes} 个值（多余 ${d.extra} 条）`);
    }
    if (needEmail) {
      const missing = records.filter(r => !r.email).length;
      const d = countDupes(records, 'email');
      lines.push(`邮箱：缺失 ${missing}，重复 ${d.dupes} 个值（多余 ${d.extra} 条）`);
    }
    if (needPhone || needEmail) {
      // 联系方式状态码→中文映射
      const statusLabels = {
        success: '成功', pending: '等待中', forbidden: '无权限', skipped_after_forbidden: '跳过(无权限)',
        rate_limited: '限流', server_error: '服务器错误', http_error: '请求错误',
        parse_failed: '解析失败', timeout: '超时', request_failed: '请求失败', cancelled: '已取消'
      };
      const detail = Object.entries(statusCounts).map(([s, c]) => `${statusLabels[s] || s} ${c}`).join('，');
      lines.push(`联系方式状态：${detail || '无'}`);
    }
    if (state.evalRequested) {
      if (state.evalApiError) lines.push(`评估结论：接口错误（${state.evalApiError}），${state.evalApiErrorCount} 人未获取`);
      else lines.push(`评估结论：已获取 ${state.evalMatched}，无评估 ${state.evalNoEval}`);
    }
    if (state.cancelled) lines.push('⚠️ 用户已取消，当前为部分结果');

    // 标题颜色：绿色=全部通过核验，黄色=总数未探测到，红色=有失败/不一致/取消
    const countMismatch = expectedCount !== null && expectedCount !== records.length;
    const hasFailure = contactFailures > 0;
    const hasEvalFailure = state.evalApiErrorCount > 0;
    const ready = !state.cancelled && !countMismatch && !hasFailure && !hasEvalFailure;
    const level = ready ? (expectedCount === null ? 'warning' : 'success') : 'error';
    const title = ready ? (expectedCount === null ? '抓取完成（总数未核验）' : '抓取完成并通过核验 ✅') : '⚠️ 需要人工核对';

    const color = level === 'success' ? '#52c41a' : level === 'warning' ? '#d48806' : '#f5222d';
    const titleBar = el('div', { text: `${title}｜${((Date.now() - startedAt) / 1000).toFixed(1)}s｜拖动标题移动` }, {
      marginBottom: '6px', fontWeight: 'bold', color, cursor: 'move', userSelect: 'none', padding: '2px 0'
    });
    panel.appendChild(titleBar);
    makeDraggable(panel, titleBar);

    const ul = el('ul', {}, { margin: '0 0 8px 18px', padding: '0', fontSize: '12px', color: '#555' });
    lines.forEach(l => ul.appendChild(el('li', { text: l })));
    panel.appendChild(ul);

    // ---- 筛选栏（搜索 + 筛选按钮 + 脱敏开关） ----
    const filterBar = el('div', {}, { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' });
    const searchInput = el('input', { type: 'text', placeholder: '搜索姓名/学校/岗位...' }, {
      padding: '4px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px', width: '180px'
    });
    let searchTimer = null;
    searchInput.oninput = () => {
      // 200ms 防抖，避免大数据量下每次按键都重新过滤渲染
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTerm = searchInput.value; updateTextarea(); updateSummary();
      }, 200);
    };
    filterBar.appendChild(searchInput);

    [['all', '全部'], ['contact', '有联系方式'], ['failed', '仅失败项']].forEach(([v, t]) => {
      const btn = el('button', { text: t }, {
        padding: '3px 10px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '4px',
        background: v === 'all' ? '#3370ff' : '#fff', color: v === 'all' ? '#fff' : '#333', cursor: 'pointer'
      });
      btn.onclick = () => {
        filterMode = v;
        filterBar.querySelectorAll('button').forEach(b => { b.style.background = '#fff'; b.style.color = '#333'; });
        btn.style.background = '#3370ff'; btn.style.color = '#fff';
        updateTextarea(); updateSummary();
      };
      filterBar.appendChild(btn);
    });

    const maskCb = el('input', { type: 'checkbox' }, { marginLeft: '8px' });
    maskCb.checked = maskDisplay;
    maskCb.onchange = () => { maskDisplay = maskCb.checked; updateTextarea(); };
    const maskLabel = el('label', { text: ' 脱敏显示' }, { fontSize: '12px', cursor: 'pointer' });
    maskLabel.insertBefore(maskCb, maskLabel.firstChild);
    filterBar.appendChild(maskLabel);

    panel.appendChild(filterBar);

    // ---- JSON 文本框（flex:1 自适应面板高度） ----
    const textarea = el('textarea', { readOnly: true }, {
      width: '100%', flex: '1', minHeight: '200px', fontSize: '11px', boxSizing: 'border-box',
      fontFamily: 'monospace', border: '1px solid #ddd', borderRadius: '4px', resize: 'none'
    });
    panel.appendChild(textarea);

    function updateTextarea() {
      let json = buildJSON();
      if (maskDisplay && !CONFIG.MASK_EXPORT) {
        // 仅显示脱敏，不改变实际数据：对 JSON 文本中的手机号/邮箱做正则脱敏
        json = json.replace(/1[3-9]\d{9}/g, m => maskPhone(m));
        json = json.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, m => maskEmail(m));
      }
      textarea.value = json;
    }
    function updateSummary() {
      const filtered = getFiltered();
      ul.firstChild.textContent = `抓取唯一记录：${records.length} 人（当前筛选 ${filtered.length} 人）`;
    }
    updateTextarea();

    // ---- 台账链接输入 ----
    const ledgerRow = el('div', {}, { marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'center' });
    ledgerRow.appendChild(el('label', { text: '台账链接：' }, { fontSize: '12px', whiteSpace: 'nowrap' }));
    const ledgerInput = el('input', { type: 'text', value: CONFIG.LEDGER_URL, placeholder: '粘贴台账链接后点"登台账"' }, {
      flex: '1', padding: '4px 8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px'
    });
    ledgerInput.onchange = () => { CONFIG.LEDGER_URL = ledgerInput.value.trim(); saveConfig(); };
    ledgerRow.appendChild(ledgerInput);
    panel.appendChild(ledgerRow);

    // ---- 操作按钮区 ----
    // 居中分散布局：按钮大小固定不缩放，间距一致；容器变窄时自动换行，每行始终居中
    const actions = el('div', {}, {
      marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px',
      justifyContent: 'center', alignItems: 'center'
    });
    const mkBtn = (text, bg, color = '#fff') => el('button', { text }, {
      background: bg, color, border: 'none', borderRadius: '4px', padding: '6px 14px',
      cursor: 'pointer', fontSize: '13px', flex: '0 0 auto', whiteSpace: 'nowrap'
    });

    const copyBtn = mkBtn('复制 JSON', '#3370ff');
    const csvBtn = mkBtn('导出 CSV', '#13c2c2');
    const copyEmailBtn = mkBtn('复制邮箱', '#52c41a');
    copyEmailBtn.title = '复制当前筛选结果中的所有邮箱（分号分隔，去重），可直接粘贴到飞书邮箱密送栏';
    const ledgerBtn = mkBtn('登台账', '#722ed1');
    const retryBtn = mkBtn('重试失败项', '#fa8c16');
    const closeBtn = el('button', { text: '关闭并清空' }, {
      border: '1px solid #ddd', background: '#fff', borderRadius: '4px', padding: '6px 14px',
      cursor: 'pointer', fontSize: '13px', flex: '0 0 auto', whiteSpace: 'nowrap'
    });

    actions.append(copyBtn, csvBtn, copyEmailBtn, ledgerBtn, retryBtn, closeBtn);
    panel.appendChild(actions);
    document.body.appendChild(panel);

    // 复制当前筛选结果的 JSON
    copyBtn.onclick = async () => {
      const json = buildJSON();
      copyBtn.textContent = (await copyToClipboard(json)) ? '✅ 已复制' : '❌ 复制失败';
      setTimeout(() => { copyBtn.textContent = '复制 JSON'; }, 2000);
    };

    // 导出当前筛选结果为 CSV（文件名用本地日期，非 UTC）
    csvBtn.onclick = () => {
      const data = buildOutput(getFiltered(), selectedCols, needPhone, needEmail, CONFIG.MASK_EXPORT);
      if (!data.length) { csvBtn.textContent = '❌ 无数据'; return; }
      const d = new Date();
      const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      downloadCSV(`候选人_${ts}.csv`, toCSV(data));
      csvBtn.textContent = '✅ 已导出';
      setTimeout(() => { csvBtn.textContent = '导出 CSV'; }, 2000);
    };

    // 复制当前筛选结果中的所有邮箱（分号分隔），用于飞书邮箱群发
    copyEmailBtn.onclick = async () => {
      const emails = collectEmailsFromRecords(getFiltered());
      if (!emails.length) { copyEmailBtn.textContent = '❌ 无邮箱'; return; }
      const text = emails.join(';');
      copyEmailBtn.textContent = (await copyToClipboard(text)) ? `✅ 已复制 ${emails.length} 个` : '❌ 失败';
      setTimeout(() => { copyEmailBtn.textContent = '复制邮箱'; }, 2000);
    };

    // 登台账：生成一段提示词（含台账链接 + 当前数据 JSON + 写入规则），复制到剪贴板后粘贴给豆包
    ledgerBtn.onclick = async () => {
      const ledgerUrl = ledgerInput.value.trim();
      if (!ledgerUrl) { alert('请先填写台账链接'); ledgerInput.focus(); return; }
      CONFIG.LEDGER_URL = ledgerUrl; saveConfig();
      const data = buildOutput(getFiltered(), selectedCols, needPhone, needEmail, false);
      const promptText = `请将下面的 JSON 数据写入指定台账。
台账链接：${ledgerUrl}
JSON 数据：
${JSON.stringify(data, null, 2)}
请按以下规则执行：
1. 先识别台账类型、目标工作表或数据表，并读取现有表头和字段类型。
2. 根据字段名称和含义，将 JSON 字段映射到台账字段。字段名称不完全一致时，可以按语义匹配，但不要凭空补充数据。
3. 对于每条记录，将"候选人链接"作为对应"姓名"单元格的超链接目标，姓名显示文本保持不变；不要将候选人链接单独写入台账字段，也不要新建链接列。若目标台账或当前工具不支持姓名富文本超链接，请在填入方案中明确说明，不要把裸链接写进姓名。
4. 写入前先检查必填字段、日期格式、手机号、邮箱、枚举值和数字格式是否符合台账要求。
5. 默认只填写 JSON 中有明确值的字段；空值不要覆盖台账中已有内容。
6. 不要修改表头、字段类型、公式、视图、筛选条件和其他已有记录。除非我明确要求，否则不要覆盖非空单元格，也不要删除记录。
7. 如果字段映射存在歧义、缺少必填字段、没有编辑权限，或无法确定目标工作表，请先停止写入并向我说明问题。
8. 信息确认无误后，先把填入方案（含字段映射关系、预计写入条数）告诉我，等我明确回复"可以开始"后再执行写入。
9. 写入完成后重新读取新增或更新的记录进行核验，并汇报：成功写入数量、跳过的重复记录数量、失败记录及原因、实际字段映射关系。
10. 数据仅用于本次台账录入，不要发送到外部服务，不要在其他位置保存候选人姓名、电话、邮箱等个人信息。
如果 JSON 是一个数组，请逐条处理；如果是单个对象，则只写入一条记录。`;
      ledgerBtn.textContent = (await copyToClipboard(promptText)) ? '✅ 提示词已复制' : '❌ 失败';
      setTimeout(() => { ledgerBtn.textContent = '登台账'; }, 2000);
    };

    // 重试失败项：重试期间禁用所有按钮和筛选控件，关闭面板会取消重试
    let activeRetryState = null;

    retryBtn.onclick = async () => {
      const failedContacts = records.filter(r => r.contactStatus && !['success', 'cancelled', 'forbidden', 'skipped_after_forbidden'].includes(r.contactStatus));
      const failedEval = records.filter(r => r.evalStatus === 'api_error');
      if (!failedContacts.length && !failedEval.length) {
        retryBtn.textContent = '无失败项';
        setTimeout(() => { retryBtn.textContent = '重试失败项'; }, 2000);
        return;
      }
      // 重试期间禁用所有操作按钮和筛选控件，避免数据不一致
      const allBtns = [copyBtn, csvBtn, copyEmailBtn, ledgerBtn, retryBtn, closeBtn];
      const filterControls = filterBar.querySelectorAll('button,input');
      allBtns.forEach(b => b.disabled = true);
      filterControls.forEach(b => b.disabled = true);
      retryBtn.textContent = '重试中...';
      activeRetryState = { cancelled: false, contactBlocked: state.contactBlocked, activeControllers: new Set() };

      try {
        if (failedContacts.length) {
          failedContacts.forEach(r => { r.contactStatus = 'pending'; });
          await collectContacts(failedContacts, needPhone, needEmail, activeRetryState, {
            update: (label, total, pc, tc) => { retryBtn.textContent = `重试联系方式 ${pc}/${tc}`; }
          });
        }
        if (failedEval.length && !activeRetryState.cancelled) {
          const evalCols = selectedCols.filter(c => c.isEvaluation);
          try {
            await collectEvaluations(failedEval, evalCols, activeRetryState, {
              update: (label, count) => { retryBtn.textContent = `重试评估 ${count}/${failedEval.length}`; }
            });
          } catch (e) { console.error('[采集器] 评估重试失败', e); }
        }
      } finally {
        activeRetryState = null;
      }

      if (!document.getElementById(IDS.resultPanel)) return; // 面板已被关闭，不重建
      // 刷新面板
      panel.remove();
      clearCheckpoint();
      showResult(records, selectedCols, needPhone, needEmail, expectedCount, state, startedAt);
    };

    closeBtn.onclick = () => {
      // 关闭时取消正在进行的重试
      if (activeRetryState) {
        activeRetryState.cancelled = true;
        activeRetryState.activeControllers.forEach(c => { try { c.abort(); } catch (_) {} });
      }
      textarea.value = '';
      clearCheckpoint();
      panel.remove();
    };

    // 离开页面前提醒（结果面板打开时），全局只注册一次
    if (!window.__hireGrabberBeforeUnload) {
      window.__hireGrabberBeforeUnload = true;
      window.addEventListener('beforeunload', e => {
        if (document.getElementById(IDS.resultPanel)) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }
  }

  // ============ 通用拖拽（结果面板/设置面板等） ============
  // 使 panel 可通过按住 handle 拖拽移动，带视口边界限制
  function makeDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      // 拖拽前将居中定位转换为绝对 left/top
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.transform = 'none';
      drag = { pointerId: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top };
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const r = panel.getBoundingClientRect();
      const ml = Math.max(0, window.innerWidth - r.width);
      const mt = Math.max(0, window.innerHeight - Math.min(r.height, window.innerHeight));
      panel.style.left = Math.min(ml, Math.max(0, e.clientX - drag.ox)) + 'px';
      panel.style.top = Math.min(mt, Math.max(0, e.clientY - drag.oy)) + 'px';
    });
    const stop = e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture?.(e.pointerId);
      drag = null;
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  // ============ 悬浮按钮容器拖拽 ============
  // 与 makeDraggable 的区别：
  //   - 有 5px 移动阈值区分点击和拖拽（点击触发按钮，拖拽移动容器）
  //   - 拖拽后 suppressClick 拦截松手时的 click 事件，避免误触发按钮
  //   - 拖拽结束后保存位置到 CONFIG
  //   - 双击非按钮区域复位到默认右下角
  function makeFabDraggable(container) {
    // 注入样式：拖拽中强制所有子元素（含按钮）显示 grabbing 光标
    if (!document.getElementById('__hireGrabberFabDragStyle')) {
      const st = document.createElement('style');
      st.id = '__hireGrabberFabDragStyle';
      st.textContent = `#${IDS.fabContainer}[data-dragging="true"], #${IDS.fabContainer}[data-dragging="true"] * { cursor: grabbing !important; }`;
      document.head.appendChild(st);
    }
    let drag = null, moved = false, startX = 0, startY = 0, suppressClick = false;

    container.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      fabDragging = true;
      const r = container.getBoundingClientRect();
      // 从 right/bottom 定位切换为 left/top 定位，以便拖拽
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = r.left + 'px';
      container.style.top = r.top + 'px';
      startX = e.clientX; startY = e.clientY; moved = false;
      drag = { pointerId: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, captured: false };
      // 注意：此处不能调用 setPointerCapture，也不能 preventDefault，
      // 否则 pointerup 会被重定向到容器，导致按钮的 click 事件不触发。
      // 指针捕获延迟到确认拖拽（移动超过 5px）后再进行。
    }, true);

    container.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      // 超过 5px 阈值才判定为拖拽
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > 5) {
        moved = true;
        container.dataset.dragging = 'true';
        // 确认拖拽后再捕获指针，保证拖拽过程中即使鼠标移出容器也能继续接收事件；
        // 此时已不需要 click 事件，不会影响按钮点击
        if (!drag.captured) {
          container.setPointerCapture?.(drag.pointerId);
          drag.captured = true;
        }
      }
      if (!moved) return;
      e.preventDefault(); // 拖拽中阻止文本选择等默认行为
      const r = container.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - r.width);
      const maxTop = Math.max(0, window.innerHeight - r.height);
      container.style.left = Math.min(maxLeft, Math.max(0, e.clientX - drag.ox)) + 'px';
      container.style.top = Math.min(maxTop, Math.max(0, e.clientY - drag.oy)) + 'px';
    });

    const stop = e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.captured) container.releasePointerCapture?.(e.pointerId);
      container.dataset.dragging = 'false';
      if (moved) {
        const r = container.getBoundingClientRect();
        CONFIG.FAB_POS = { left: r.left, top: r.top };
        saveConfig();
        // 拖拽松手后短暂拦截 click，避免误触发按钮
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 100);
      }
      drag = null;
      fabDragging = false;
    };
    container.addEventListener('pointerup', stop);
    container.addEventListener('pointercancel', stop);

    // 拖拽后拦截按钮 click（捕获阶段），避免松手时误触发采集/设置
    container.addEventListener('click', e => {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // 双击空白处（非按钮）复位到默认右下角
    container.addEventListener('dblclick', e => {
      if (e.target.closest('button')) return;
      CONFIG.FAB_POS = null;
      saveConfig();
      container.style.left = '';
      container.style.top = '';
      container.style.right = '24px';
      container.style.bottom = '80px';
    });
  }

  // ============ 主采集流程 ============
  /**
   * 执行完整采集流程：
   *   1. 探测总人数、找滚动容器、检查断点
   *   2. 滚动列表并逐行抓取 DOM 数据（每 5 轮保存断点）
   *   3. 调用评估接口补全评估结论
   *   4. 并发调用联系方式接口补全手机/邮箱
   *   5. 清空断点，弹出结果面板
   */
  async function runGrab(selectedCols) {
    const startedAt = Date.now();
    const expectedCount = detectTotalCount();
    const state = { cancelled: false, contactBlocked: false, activeControllers: new Set() };
    currentRunState = state;
    const results = new Map();
    const scroller = findScroller();
    if (!scroller) { alert('找不到候选人列表或滚动容器'); return; }

    const needPhone = selectedCols.some(c => ['phone', 'contact'].includes(c.contactType));
    const needEmail = selectedCols.some(c => ['email', 'contact'].includes(c.contactType));
    const evalCols = selectedCols.filter(c => c.isEvaluation);
    const progress = showProgress(state, startedAt);

    // 检查断点：仅同 URL 且 30 分钟内有效
    let resumed = false;
    const cp = loadCheckpoint();
    if (cp && cp.records && cp.records.length && cp.url === location.href && Date.now() - cp.time < 30 * 60 * 1000) {
      const resume = confirm(`检测到 ${Math.round((Date.now() - cp.time) / 60000)} 分钟前的未完成采集（${cp.records.length} 人），是否继续？\n点"确定"继续，点"取消"重新开始。`);
      if (resume) {
        cp.records.forEach(r => results.set(r.uniqueKey, r));
        resumed = true;
      } else {
        clearCheckpoint();
      }
    } else if (cp) {
      clearCheckpoint();
    }

    // 从一行 DOM 中提取候选人数据并合并到 results
    function scrapeRow(row) {
      const anchor = row.querySelector('a[href*="/hire/talent/"]');
      if (!anchor) return null;
      const parsed = parseTalentLink(anchor);
      if (!parsed) return null;
      const key = makeUniqueKey(parsed.talentId, parsed.applicationId);
      const record = results.get(key) || {
        uniqueKey: key, talentId: parsed.talentId, applicationId: parsed.applicationId,
        talentUrl: anchor.href || '', name: cleanName(anchor.textContent), fields: {}
      };
      if (!record.applicationId && parsed.applicationId) record.applicationId = parsed.applicationId;
      if (!record.talentUrl && anchor.href) record.talentUrl = anchor.href;
      if (!record.name) record.name = cleanName(anchor.textContent);
      selectedCols.forEach(c => {
        if (c.contactType || c.isName || c.isEvaluation) return; // 这些列由接口补全或固定输出
        const v = getCellText(row, c.col);
        if (v || !(c.outputName in record.fields)) record.fields[c.outputName] = v;
      });
      results.set(key, record);
      return record;
    }

    // 扫描当前 DOM 中所有候选人行
    async function scrapeVisible() {
      const rows = Array.from(document.querySelectorAll('tr.throne-biz-table-row'));
      for (const row of rows) {
        if (state.cancelled) break;
        scrapeRow(row);
      }
    }

    isGrabbing = true;
    try {
      // 断点恢复且记录数已达预期时，跳过滚动直接补全联系方式/评估
      const skipScroll = resumed && results.size > 0 &&
        (expectedCount === null || results.size >= expectedCount);

      if (!skipScroll) {
        scroller.scrollTop = 0;
        await sleep(500);
        let stableRounds = 0, prevCount = -1, cpCounter = 0;

        for (let round = 0; round < CONFIG.MAX_SCROLL_ROUNDS && !state.cancelled; round++) {
          await scrapeVisible();
          progress.update(evalCols.length ? '读取列表并滚动' : '滚动抓取', results.size);

          const beforeTop = scroller.scrollTop;
          const beforeHeight = scroller.scrollHeight;
          const atBottomBefore = beforeTop + scroller.clientHeight >= beforeHeight - 2;
          scroller.scrollTop = Math.min(beforeTop + CONFIG.SCROLL_STEP, beforeHeight);
          await sleep(CONFIG.SCROLL_WAIT_MS);
          await waitForStable(scroller, 200, 1500);

          await scrapeVisible();
          const atBottomAfter = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
          const noNew = results.size === prevCount;
          const posStable = scroller.scrollTop === beforeTop || (atBottomBefore && atBottomAfter);

          // 连续 BOTTOM_STABLE_ROUNDS 轮"到底+无新数据+位置不变"才判定结束
          if (atBottomAfter && noNew && posStable) stableRounds++;
          else stableRounds = 0;
          prevCount = results.size;

          // 每 5 轮保存一次断点
          cpCounter++;
          if (cpCounter % 5 === 0) {
            saveCheckpoint({ url: location.href, records: Array.from(results.values()), selectedCols: selectedCols.map(c => ({ col: c.col, outputName: c.outputName })) });
          }

          if (stableRounds >= CONFIG.BOTTOM_STABLE_ROUNDS) break;
        }

        // 滚动结束后再做一次最终扫描，防止最后一批数据漏抓
        if (!state.cancelled) {
          await sleep(CONFIG.FINAL_SCAN_WAIT_MS);
          await scrapeVisible();
        }
      }

      const records = Array.from(results.values());
      saveCheckpoint({ url: location.href, records, selectedCols: selectedCols.map(c => ({ col: c.col, outputName: c.outputName })) });

      // 补全评估结论
      if (evalCols.length && records.length && !state.cancelled) {
        state.evalRequested = true;
        progress.update('抓取评估结论', records.length);
        try {
          await collectEvaluations(records, evalCols, state, progress);
        } catch (e) {
          state.evalApiError = e.message || String(e);
          console.error('[采集器] 评估结论失败：', e);
        }
      }

      // 补全联系方式
      if ((needPhone || needEmail) && records.length && !state.cancelled) {
        progress.update('抓取联系方式', records.length, 0, records.length);
        await collectContacts(records, needPhone, needEmail, state, progress);
      }

      clearCheckpoint();
      showResult(records, selectedCols, needPhone, needEmail, expectedCount, state, startedAt);
    } catch (e) {
      console.error('[采集器] 运行失败：', e);
      alert(`运行失败：${e?.message || String(e)}`);
    } finally {
      isGrabbing = false;
      currentRunState = null;
      state.activeControllers.forEach(c => c.abort());
      state.activeControllers.clear();
      progress.remove();
    }
  }

  // ============ 入口流程 ============
  // 点击"采集候选人"按钮的入口：等待表格加载 → 读取表头 → 列选择 → 执行采集
  async function startFlow() {
    if (isGrabbing) return; // 采集进行中，忽略重复点击
    removePanels();
    await sleep(500);
    // 等待表格行出现（最多 5×300ms）
    for (let i = 0; i < 5 && !document.querySelector('tr.throne-biz-table-row'); i++) await sleep(300);
    let headers = getHeaders();
    if (!headers.length) { await sleep(1000); headers = getHeaders(); }
    if (!headers.length) { alert('没读到表头，请确认当前页面已显示候选人列表'); return; }

    const selected = await showSelectPanel(headers);
    if (!selected) return;
    await runGrab(selected);
  }

  // ============ SPA 路由监听 ============
  // 飞书招聘是 SPA，导航不会刷新页面，用 setInterval 监听 URL 变化
  // 路由变化时：中止正在进行的采集、移除所有面板、根据新页面决定显隐 FAB
  let lastUrl = location.href;
  function checkPage() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (currentRunState) {
        currentRunState.cancelled = true;
        currentRunState.activeControllers.forEach(c => { try { c.abort(); } catch (_) {} });
      }
      removePanels();
    }
    if (isCandidateListPage()) showFab();
    else hideFab();
  }
  setInterval(checkPage, 1500);
  checkPage();

  console.log('[飞书招聘采集器] 增强版 v2.2 已加载，如页面有候选人列表将显示浮动按钮');
})();
