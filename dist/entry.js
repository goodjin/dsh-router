/**
 * DSH Router 根服务（宿主入口，计划 B2 的组装点）。
 *
 * 裸包名行加载本文件（浏览器行与宿主根服务共用一行：`name` 恰好等于包名的行
 * 才会被客户端注册表认成浏览器行，浏览器代码经 exports["./client"] 下发，不进
 * 宿主进程）。本文件在宿主进程里组装：
 *
 *   账本 + 文档 + 调度器 + 会话桥 + 问答桥 + 压缩驱动 + UI 状态
 *     → createRouterCore（src/host/core.ts）
 *     → ctx.provide('routerCore', …)（预设树里的工具行/上下文行经作用域链取用）
 *     → user-questions/request 瀑布全局监听（prepend：先于客户端兜底 UI 认领
 *       worker 提问，答案走 Router 界面浮窗）
 *     → 五条 HTTP exact 路由（webServer/connection 机会式注入；state 前置
 *       入口去重扫描，C4）
 *
 * 配置照 auto-resume 先例：Config 全部 volatile 可缺省，apply 内再做一层防御性
 * 解析（缺省补默认、负数取 0），宿主各版本 schema 默认值行为不一致时插件自己兜底。
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { TaskLedger } from "./host/ledger/store.js";
import { LedgerError } from "./host/ledger/errors.js";
import { TaskDocStore } from "./host/docs/task-docs.js";
import { Scheduler } from "./host/ledger/scheduler.js";
import { SessionBridge, releaseObservation } from "./host/bridge/sessions.js";
import { AnswerRelay, DEFAULT_QUESTION_BUDGET } from "./host/bridge/questions.js";
import { UiStateStore } from "./host/bridge/tabs.js";
import { RouterDedup, stateWithRedirect } from "./host/bridge/dedup.js";
import { adoptCanonicalRouterSessions } from "./host/bridge/dedup-adopt.js";
import { CompactionDriver } from "./host/context/compaction-driver.js";
import { registerRouterRoutes } from "./host/routes.js";
import { createRouterCore } from "./host/core.js";
import { workerInstructions as WORKER_INSTRUCTIONS } from "./host/prompts/worker-instructions.js";
import { SessionPromptStore } from "./host/prompts/session-prompt.js";
import { routerPrompt } from "./host/prompts/router.js";
import { BUILTIN_GENERAL_ID, BUILTIN_TEMPLATES, RouterDefaultsStore, WorkerTypeStore } from "./host/templates.js";
import { dynamicPresetId } from "./host/presets/dynamic.js";
import { DynamicPresetEngine } from "./host/presets/lifecycle.js";
import { MemoryDocStore } from "./host/memory/store.js";
import { ClosureIntentStore, OutcomeAdjudicator } from "./host/guard/adjudicator.js";
import { NotificationStore, anomalyActions } from "./host/guard/notifications.js";
import { search as searchMemory } from "./host/memory/retrieval.js";
import { BackgroundSummarizer, createCompletedTaskRecorder, createSummaryLlm, maxSurfaceSeq, summarizeSessionViaQuery, } from "./host/memory/adapter.js";
import { CircuitBreaker, DEFAULT_BREAKER_WINDOW_MS, DEFAULT_CREATION_THRESHOLD, DEFAULT_INFRA_THRESHOLD } from "./host/guard/breaker.js";
import { DispatchBudgets } from "./host/guard/budgets.js";
import { FirstRequestCacheObserver } from "./host/observability.js";
import { runEmergencyPause, emergencyPauseTargets, EMERGENCY_PAUSE_REASON } from "./host/guard/emergency.js";
export { Config } from "./host/root-config.js";
/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router';
/** 必需的宿主服务（缺席行装载失败，fail loud，不留静默残废）。
 *  agentPresets（r4 §1：动态注册预设的注册表，宿主基础组合常驻服务）。 */
export const inject = ['sessionController', 'agents', 'workspaceRegistry', 'sessionQuery', 'llm', 'agentPresets'];
/** 数值钳位：非数值回默认，负数取 0。 */
function nonNegative(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return value < 0 ? 0 : value;
}
/** 字符串：非空字符串否则回默认。 */
function stringOr(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}
/** 模板清单：形状不对逐条丢弃，全部不合法回内置。 */
function templatesOr(value) {
    if (!Array.isArray(value))
        return BUILTIN_TEMPLATES;
    const parsed = [];
    for (const entry of value) {
        const candidate = entry;
        if (candidate !== null && typeof candidate === 'object'
            && typeof candidate.templateId === 'string' && candidate.templateId !== ''
            && typeof candidate.name === 'string'
            && (candidate.role === 'supervisor' || candidate.role === 'worker')) {
            parsed.push({
                templateId: candidate.templateId,
                name: candidate.name,
                description: typeof candidate.description === 'string' ? candidate.description : '',
                role: candidate.role,
            });
        }
    }
    return parsed.length > 0 ? parsed : BUILTIN_TEMPLATES;
}
/**
 * 模式解析（v1.3 A1；评审 F1 修正）：宿主 loader 经 Config["~standard"].validate
 * 把 volatile 字段包成 {get} 惰性描述符再传 apply——先解引用再认字面值，只认两个
 * 合法值，其余回默认 cache-priority。导出供测试。
 */
export function spawnModeOr(value) {
    const resolved = typeof value === 'object' && value !== null && typeof value.get === 'function'
        ? value.get()
        : value;
    return resolved === 'minimal-face' ? 'minimal-face' : 'cache-priority';
}
/** 防御性解析（导出仅为测试与将来复用）：缺省补默认、枚举外回默认、负数取 0。 */
export function resolveRootConfig(raw) {
    const source = (typeof raw === 'object' && raw !== null ? raw : {});
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return {
        dataDir: stringOr(source.dataDir, join(home, 'router')),
        tasksDir: stringOr(source.tasksDir, '.router'),
        maxActiveCards: nonNegative(source.maxActiveCards, 12),
        perTypeConcurrency: nonNegative(source.perTypeConcurrency, 3),
        maxDepth: Math.max(1, nonNegative(source.maxDepth, 3)),
        routerPreset: stringOr(source.routerPreset, 'dsh-router'),
        supervisorPreset: stringOr(source.supervisorPreset, 'dsh-router-supervisor'),
        workerPreset: stringOr(source.workerPreset, 'dsh-router-worker'),
        // v1.3 C2（规格 §1）：防御性解析——两枚举值之外一律回默认 cache-priority
        //（宿主各版本对 union schema 缺省行为不一致时插件自己兜底，与 resolveRootConfig 总口径一致）。
        summarizationProvider: stringOr(source.summarizationProvider, ''),
        summarizationModel: stringOr(source.summarizationModel, ''),
        questionBudget: nonNegative(source.questionBudget, DEFAULT_QUESTION_BUDGET),
        firstResponseTimeoutMs: nonNegative(source.firstResponseTimeoutMs, 600_000),
        adjudicationWallClockMs: nonNegative(source.adjudicationWallClockMs, 1_800_000),
        breakerWindowMs: nonNegative(source.breakerWindowMs, DEFAULT_BREAKER_WINDOW_MS),
        breakerInfraThreshold: nonNegative(source.breakerInfraThreshold, DEFAULT_INFRA_THRESHOLD),
        breakerCreationThreshold: nonNegative(source.breakerCreationThreshold, DEFAULT_CREATION_THRESHOLD),
        workerSpawnMode: spawnModeOr(source.workerSpawnMode),
        templates: templatesOr(source.templates),
    };
}
/** node:fs/promises 适配成 FsAdapter。 */
function fsAdapter() {
    return {
        readFile: (p) => readFile(p, 'utf8'),
        writeFile: (p, content) => writeFile(p, content, 'utf8'),
        mkdirp: async (p) => {
            await mkdir(p, { recursive: true });
        },
        exists: async (p) => {
            try {
                await readFile(p);
                return true;
            }
            catch {
                return false;
            }
        },
        readdir: async (p) => {
            try {
                return await readdir(p);
            }
            catch {
                return [];
            }
        },
    };
}
/** 一个 JSON 文件的读改写持久化（账本与 UI 状态共用形状）。 */
function jsonFilePersistence(path) {
    return {
        async load() {
            try {
                return JSON.parse(await readFile(path, 'utf8'));
            }
            catch {
                return null;
            }
        },
        async save(value) {
            await mkdir(join(path, '..'), { recursive: true });
            await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
        },
    };
}
/** 装载入口：组装根服务并挂接宿主。 */
export function apply(ctx, rawConfig) {
    const config = resolveRootConfig(rawConfig);
    const log = ctx.logger?.(name) ?? { info: (m) => console.info(`[${name}] ${m}`), warn: (m) => console.warn(`[${name}] ${m}`) };
    // v1.3 C2：worker 派生模式的运行时值（规格 §1 volatile）。初值 = 启动配置；
    // 设置页 POST 即改（即时生效，存量任务/会话不受影响）；不落盘——宿主重启
    // 回到启动配置值（要常驻用宿主设置页改 workerSpawnMode 配置）。
    let currentSpawnMode = config.workerSpawnMode;
    const spawnMode = () => currentSpawnMode;
    const fs = fsAdapter();
    const ledger = new TaskLedger(jsonFilePersistence(join(config.dataDir, 'ledger.json')));
    const docStores = new Map();
    const docsFor = (cwd) => {
        const key = cwd === '' ? '.' : cwd;
        const existing = docStores.get(key);
        if (existing !== undefined)
            return existing;
        const store = new TaskDocStore(join(key, config.tasksDir), fs);
        docStores.set(key, store);
        return store;
    };
    const ui = new UiStateStore(jsonFilePersistence(join(config.dataDir, 'ui-state.json')));
    // 全局派发熔断器（v1.2 规格 §2）：状态落 <dataDir>/guard-state.json，宿主重启
    // 恢复冻结态（启动 effect 里自报）；窗口/阈值可配（root-config）。
    const breaker = new CircuitBreaker({
        fs,
        path: join(config.dataDir, 'guard-state.json'),
        now: () => Date.now(),
        windowMs: config.breakerWindowMs,
        infraThreshold: config.breakerInfraThreshold,
        creationThreshold: config.breakerCreationThreshold,
        logger: { warn: (message) => log.warn(message) },
    });
    // 派发预算（v1.2 规格 §3）：以轮次近似用户消息边界——running→true 即新轮
    //（下方 onStatusChange 接线；ask_user 的回答开启新轮，预算自然重计）。
    const budgets = new DispatchBudgets();
    // guard 通知段（v1.2 B4 最小投影）：B3 的统一通知面未合并前，紧急暂停的异常
    // 通知先落 <dataDir>/guard-notifications.json（guard-state.json 由熔断器独占，
    // worker 类型存储 + Router 默认值（v1.1 规格 §5/§6；首启种子化导入 v1 Config
    // 模板后 legacyImported 落盘，v1 templates 配置通道退役）。
    const typeStore = new WorkerTypeStore(fs, join(config.dataDir, 'worker-types.json'), {
        seedTemplates: config.templates,
    });
    const defaultsStore = new RouterDefaultsStore(fs, join(config.dataDir, 'router-defaults.json'));
    // 会话级系统提示词覆盖（v1.1 C5，规格 §7）：dataDir/router-prompts.json。
    // 默认文本走内存缓存（section 的 text 回调是同步的，不能等 defaults 读盘）：
    // 初值 = prompts/router.ts 静态缺省，启动恢复与每次保存默认后刷新缓存。
    const sessionPrompts = new SessionPromptStore(fs, join(config.dataDir, 'router-prompts.json'));
    let defaultsText = routerPrompt;
    /** prompt-section 行的同步文本源：当前会话覆盖 ?? 默认（缓存）。 */
    const sessionPromptText = (sessionId) => {
        if (sessionId === undefined)
            return defaultsText;
        return sessionPrompts.get(sessionId) ?? defaultsText;
    };
    /** templateId → 预设 id：启用类型走动态预设；内置通用 worker 走静态预设
     *  （保证任何情况下可派发）；禁用/未知 → undefined（回退静态角色预设，
     *  由核心的 assertTemplateUsable 拒绝派发）。 */
    const resolvePresetForTemplate = async (templateId, role) => {
        const record = await typeStore.get(templateId);
        if (record === undefined || !record.enabled || record.role !== role)
            return undefined;
        if (record.origin === 'builtin')
            return role === 'worker' ? config.workerPreset : config.supervisorPreset;
        return dynamicPresetId(templateId);
    };
    const workspaceRegistry = {
        list: () => ctx.workspaceRegistry.list(),
        get: (id) => ctx.workspaceRegistry.get(id),
    };
    // 入口去重（v1.1 Task C4 / 规格 §4）：宿主没有创建前拦截钩子，事后收敛——
    // /router/state 构建前扫描各 workspace，每项目最早的 dsh-router 预设会话为
    // 正主（原生 pinSession 置顶），其余较新者归档并写 redirect 指令；客户端
    // 消费跳转后 POST /router/redirect/ack 清除。readSession/pinSession 缺席
    // （旧宿主）时去重整体降级为直通，不挡装载。
    const dedup = ctx.sessionQuery.readSession !== undefined && ctx.workspaceRegistry.pinSession !== undefined
        ? new RouterDedup({
            workspaces: { list: () => ctx.workspaceRegistry.list() },
            sessionQuery: {
                readSession: async (sessionId) => {
                    const snapshot = await ctx.sessionQuery.readSession(sessionId);
                    if (snapshot === null || snapshot === undefined)
                        return undefined;
                    const events = snapshot.events ?? [];
                    const mapped = {
                        session: {
                            agentPreset: typeof snapshot.session?.agentPreset === 'string' ? snapshot.session.agentPreset : undefined,
                            createdAt: typeof snapshot.session?.createdAt === 'number' ? snapshot.session.createdAt : undefined,
                            // 评审 F2：分叉/种子会话识别的第三证据（header.isSeeded）。
                            isSeeded: snapshot.session?.isSeeded === true,
                        },
                        events: events.map((event) => ({
                            type: typeof event.type === 'string' ? event.type : '',
                            data: (typeof event.data === 'object' && event.data !== null ? event.data : {}),
                        })),
                    };
                    return mapped;
                },
            },
            registry: {
                pinSession: (sessionId) => ctx.workspaceRegistry.pinSession(sessionId),
                archiveSession: (sessionId, options) => ctx.workspaceRegistry.archiveSession(sessionId, options),
                archivedSessionIds: () => {
                    // 宿主为 getter 属性（数组）而非方法；兼容两形状。
                    const raw = ctx.workspaceRegistry.archivedSessionIds;
                    return typeof raw === 'function'
                        ? (raw() ?? [])
                        : Array.isArray(raw)
                            ? raw
                            : [];
                },
            },
            routerPreset: config.routerPreset,
            logger: { warn: (message) => log.warn(message) },
        })
        : undefined;
    if (dedup === undefined)
        log.warn('宿主缺 sessionQuery.readSession / workspaceRegistry.pinSession，入口去重降级为直通');
    const hosts = {
        sessionController: ctx.sessionController,
        agents: ctx.agents,
        workspaceRegistry,
        onSessionStatus: (callback) => {
            ctx.on('api-session/status', (sessionId, running) => callback(String(sessionId), Boolean(running)));
        },
    };
    // v1.2 B3：onDelivered 晚绑判定器（桥先于判定器建成）
    const adjudicatorRef = {};
    // v1.3 A3：minimal 五步的 buildForkSeed 面（@deepseek-ai/dsh-session/fork 懒加载；
    // 缺席时桥降级为普通创建并告警——r10 §2：双版本逐字节一致，正常宿主都有）。
    let forkSeedFn;
    const loadForkSeed = async () => {
        if (forkSeedFn !== undefined)
            return forkSeedFn;
        try {
            const specifier = '@deepseek-ai/dsh-session/fork';
            const mod = (await import(__rewriteRelativeImportExtension(specifier)));
            forkSeedFn = mod.buildForkSeed;
        }
        catch (error) {
            log.warn(`@deepseek-ai/dsh-session/fork 不可用，minimal-face 分叉降级为普通创建: ${error instanceof Error ? error.message : String(error)}`);
        }
        return forkSeedFn;
    };
    void loadForkSeed();
    const bridge = new SessionBridge({
        ledger,
        docsFor,
        workspaces: workspaceRegistry,
        onDelivered: (taskId) => { void adjudicatorRef.current?.onDispatched(taskId); },
        presets: { supervisor: config.supervisorPreset, worker: config.workerPreset },
        forTemplate: resolvePresetForTemplate,
        types: { get: (templateId) => typeStore.get(templateId) },
        // 紧急暂停的中断面（v1.2 B4，r8 §5）：agents.get(id)?.cancel —— 幂等、
        // 原因留痕 turn/end、keepInbox 保住排队消息；冷会话天然 no-op。
        interruptFace: ctx.agents,
        workerInstructions: () => workerInstructionsText(),
        logger: { warn: (message) => log.warn(message) },
        signal: undefined,
        // v1.3 A2：worker 生成模式与身份卡已发标记（Review Focus 5 幂等）。
        mode: spawnMode(),
        identityCards: {
            has: (sessionId) => ui.hasIdentityCard(sessionId),
            mark: (sessionId) => ui.markIdentityCardSent(sessionId),
        },
        // v1.3 A3：分叉创建面（cache=宿主 fork；minimal=五步复刻的宿主砖块，全可缺席）。
        host: {
            create: async (opts, signal) => (await ctx.sessionController.create(opts, signal)).sessionId,
            prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
            onStatus: (callback) => hosts.onSessionStatus(callback),
            rename: async (sessionId, title) => {
                await ctx.sessionController.rename({ sessionId, title });
            },
            // 规格 §5 默认模型钉法（r4 修正）：宿主 selectModel（UI ModelSelect 同通路）；
            // 宿主缺席时桥降级为不钉（类型清单仍如实记录）。
            selectModel: typeof ctx.sessionController.selectModel === 'function'
                ? (request, signal) => ctx.sessionController.selectModel(request, signal)
                : undefined,
            // wire session/fork（r10 §1：SessionCommandController.fork({sessionId,...})）。
            fork: typeof ctx.sessionController.fork === 'function'
                ? (request, signal) => ctx.sessionController.fork(request, signal)
                : undefined,
            observeSession: async (sessionId) => {
                const observation = await ctx.sessionQuery.observeSession(sessionId);
                const events = (observation.events ?? []);
                // 评审 F7：宿主租约经 [Symbol.dispose] 释放——双通道包装，五步路径不漏租约。
                return { events, dispose: () => releaseObservation(observation) };
            },
            buildForkSeed: async (events, boundary) => {
                const fn = await loadForkSeed();
                if (fn === undefined)
                    return undefined;
                return fn(events, boundary);
            },
            newSessionId: () => `session-${randomUUID()}`,
            agentsCreate: typeof ctx.agents.create === 'function'
                ? (options) => ctx.agents.create(options)
                : undefined,
            resolvePreset: typeof ctx.agentPresets.resolve === 'function'
                ? (presetId) => ctx.agentPresets.resolve(presetId)
                : undefined,
            mountPreset: typeof ctx.agentPresets.mount === 'function'
                ? (agentCtx, presetId) => ctx.agentPresets.mount(agentCtx, presetId)
                : undefined,
            attachWorkspace: async (workspaceId, sessionId) => {
                const registry = ctx.workspaceRegistry;
                const workspace = registry.get?.(workspaceId);
                const attach = workspace?.attachSession;
                if (typeof attach !== 'function')
                    throw new Error('workspace 缺 attachSession 面');
                await attach.call(workspace, sessionId);
            },
        },
    });
    /**
     * Router 身份卡投递（v1.3 A2 规格 §2.2）：两个入口共用——①我们创建的 Router
     * 会话（POST /router/sessions 成功后）②picker 自建、被去重收编为正主的 Router
     * 会话（GET /router/state 去重扫描后）。桥内按已发标记幂等，requestId=
     * identity-<sessionId> 宿主侧再去重；失败只告警不挡主流程（下次 state 再试）。
     */
    const deliverRouterCard = async (sessionId) => {
        try {
            await bridge.deliverRouterIdentityCard(sessionId);
        }
        catch (error) {
            log.warn(`Router 身份卡投递失败（下次 state 重试，requestId 幂等）: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    // 动态预设引擎：类型/默认值变更 → unregister+register 增量同步；每次注册的
    // 注销器自接线 ctx.effect（r4 条件①）；Router 动态注册失败回退静态定义。
    const engine = new DynamicPresetEngine({
        presets: ctx.agentPresets,
        effect: (factory, label) => ctx.effect(factory, label),
        skillDirs: () => undefined, // 初始技能目录解析（C3 设置页接入已装技能包时落地）
        logger: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
    });
    // 类型写路径后的引擎增量同步（C3 路由 deps 用）：只同步「启用」类型
    //（syncTypes 的调用方约定是喂启用清单；禁用 = 保留注册只拒派发，r4 §4）。
    // builtin 不经引擎（映射静态预设，ensureRegistered 对它恒 false）。
    const syncTypePresets = async (record) => {
        if (!record.enabled || record.origin === 'builtin')
            return;
        const outcome = await engine.syncTypes([record], spawnMode());
        for (const failed of outcome.failed) {
            log.warn(`类型 ${failed} 的动态预设注册失败（派发会被拒；保存的类型数据不受影响）`);
        }
    };
    const relay = new AnswerRelay({
        ledger,
        newId: () => randomUUID(),
        now: () => Date.now(),
        // 提问预算（v1.1 规格 §3.6）：每任务澄清提问批次数上限，超限自动回答案。
        questionBudget: config.questionBudget,
        // Router 会话每轮 1 批提问（v1.2 规格 §3）：认领层强制，第二批自动回
        //「请合并为一批重问」。Router 会话清单以 UI 登记为准。
        routerQuestions: {
            isRouterSession: (sessionId) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
            tryConsumeQuestionBatch: (sessionId) => budgets.tryConsumeQuestionBatch(sessionId),
        },
        logger: { warn: (message) => log.warn(message) },
    });
    const scheduler = new Scheduler(ledger, {
        maxDepth: config.maxDepth,
        concurrency: { default: config.perTypeConcurrency },
    });
    // 记忆服务接线（计划 B8）：三层文档 store 根目录 = <dataDir>/memory/；
    // 事件读走 observeSession 租约（adapter 内 finally 释放）；摘要流走
    // ctx.llm.stream（purpose:'compaction'）。路由对解析链：配置对 → 活任务
    // 会话最近一次路由头（compaction-basic routedTarget 同款）→ 缺失（触发方 warn）。
    const memoryStore = new MemoryDocStore(join(config.dataDir, 'memory'), fs);
    const closureIntents = new ClosureIntentStore({ fs, path: join(config.dataDir, 'closure-intents.json'), logger: { warn: (m) => log.warn(m) } });
    const notifications = new NotificationStore({ fs, path: join(config.dataDir, 'notifications.json'), newId: () => randomUUID(), logger: { warn: (m) => log.warn(m) } });
    const memoryQuery = {
        observeSession: (sessionId) => ctx.sessionQuery.observeSession(sessionId),
    };
    const resolveSummaryTarget = async () => {
        if (config.summarizationProvider !== '' && config.summarizationModel !== '') {
            return { provider: config.summarizationProvider, model: config.summarizationModel };
        }
        const records = await ledger.listAll();
        for (const record of records) {
            if (record.sessionId === undefined)
                continue;
            const agent = ctx.agents.get(record.sessionId);
            const routed = agent?.session?.requestHeader?.()?.config;
            if (routed !== undefined
                && typeof routed.provider === 'string' && routed.provider !== ''
                && typeof routed.model === 'string' && routed.model !== '') {
                return { provider: routed.provider, model: routed.model };
            }
        }
        return undefined;
    };
    const summaryLlm = createSummaryLlm(ctx.llm, resolveSummaryTarget);
    const summarizer = new BackgroundSummarizer({
        maxSeq: (sessionId) => maxSurfaceSeq(memoryQuery, sessionId),
        run: (sessionId) => summarizeSessionViaQuery(memoryQuery, memoryStore, sessionId, summaryLlm),
        onError: (sessionId, error) => {
            log.warn(`会话 ${sessionId} 记忆增量摘要失败（下次 idle 或新事件后重试）: ${error instanceof Error ? error.message : String(error)}`);
        },
    });
    const recordTaskMemory = createCompletedTaskRecorder({
        store: memoryStore,
        query: memoryQuery,
        llm: summaryLlm,
        onError: (_stage, error) => {
            log.warn(`任务完成的记忆写入失败（不阻塞完成协议）: ${error instanceof Error ? error.message : String(error)}`);
        },
    });
    /** 该会话是否绑定了任务（= worker/主管会话；Router 会话不做增量摘要）。 */
    const isTaskSession = async (sessionId) => {
        const records = await ledger.listAll();
        return records.some((record) => record.sessionId === sessionId);
    };
    /** routerCore.memory（brief 形状：search 直传 retrieval）。 */
    const memoryFace = {
        search: (query, scope) => searchMemory(memoryStore, query, scope),
        onTaskCompleted: (input) => recordTaskMemory(input),
    };
    let pairing = null;
    const queueWarned = new Set();
    const loadPairing = async () => {
        if (pairing !== null)
            return pairing;
        try {
            const specifier = '@deepseek-ai/dsh-compaction';
            const mod = (await import(__rewriteRelativeImportExtension(specifier)));
            pairing = {
                before: mod.toolPairingBalancedBefore,
                after: mod.toolPairingBalancedAfter,
            };
        }
        catch (error) {
            log.warn(`dsh-compaction 配对函数不可用，压缩区域预检放行: ${error instanceof Error ? error.message : String(error)}`);
            pairing = { before: () => true, after: () => true };
        }
        return pairing;
    };
    const driver = new CompactionDriver({
        getAgent: (sessionId) => ctx.agents.get(sessionId),
        // idle 且无排队消息才驱动压缩（brief 的驱动条件）：排队未清时压缩会把
        // 等着入场的上下文压进旧区域；查询失败按「还有排队」保守跳过（driver 内处理），
        // 这里每会话首次失败自报一声——持续失败 = 压缩永不跑，不能静默。
        queueEmpty: async (sessionId) => {
            try {
                const state = (await ctx.sessionController.state({ sessionId }));
                const queue = state?.queue;
                return queue === undefined || queue === null || queue.length === 0;
            }
            catch (error) {
                if (!queueWarned.has(sessionId)) {
                    queueWarned.add(sessionId);
                    log.warn(`会话 ${sessionId} 排队状态查询失败，派发后压缩将暂缓: ${error instanceof Error ? error.message : String(error)}`);
                }
                throw error;
            }
        },
        lastUserMessageSeq: async (sessionId) => {
            const sessionQuery = ctx.sessionQuery;
            if (sessionQuery === undefined)
                return null;
            try {
                const surface = await sessionQuery.readSurface?.(sessionId);
                const events = surface?.events ?? [];
                for (let i = events.length - 1; i >= 0; i -= 1) {
                    if (events[i]?.type === 'user/message')
                        return events[i].seq;
                }
                return null;
            }
            catch {
                return null;
            }
        },
        balancedBefore: async (session, seq) => Boolean((await loadPairing()).before(session, seq)),
        balancedAfter: async (session, seq) => Boolean((await loadPairing()).after(session, seq)),
        compactRegion: async (start, end, agent, signal) => {
            const engine = agent?.ctx
                ?.compaction;
            if (engine?.compactRegion === undefined) {
                throw new Error('compaction engine 在目标会话作用域内不可用（预设未挂 compaction 组？）');
            }
            return engine.compactRegion(start, end, agent, signal);
        },
        now: () => Date.now(),
    });
    const assembled = createRouterCore({
        notifications,
        ledger,
        docsFor,
        bridge,
        relay,
        driver,
        scheduler,
        ui,
        hosts,
        config,
        types: {
            enabled: () => typeStore.enabledTemplates(),
            summaries: () => typeStore.summaries(),
            // C2 类型工具的创建通道：建 router 来源类型后立刻经 C1 引擎增量同步
            // （注册动态预设）；校验/注册失败返回 false，由 create_worker_type 输出
            // 如实带出（不静默）。
            createRouterType: async (input) => {
                const record = await typeStore.create({ ...input, origin: 'router', enabled: true });
                const presetRegistered = await engine.ensureRegistered(record, spawnMode());
                return { record, presetRegistered };
            },
        },
        routerDefaults: { get: () => defaultsStore.get() },
        newId: () => randomUUID(),
        isRunning: (sessionId) => bridge.isRunning(sessionId),
        maxActiveCards: config.maxActiveCards,
        tasksDir: config.tasksDir,
        memory: memoryFace,
        breaker,
        budgets,
        logger: { warn: (message) => log.warn(message) },
    });
    // 供预设树的工具行 / 上下文行 / prompt-section 行经作用域链注入；memory 一并挂上（brief 形状）。
    // callerRoleOf（v1.3 A1）：superset 工具行执行层硬闸的角色数据源。
    ctx.provide('routerCore', {
        ...assembled.core,
        snapshotText: assembled.snapshotText,
        // v1.1 C5：会话级系统提示词文本源（prompt-section 行的 complete section 消费）。
        sessionPromptText,
        memory: { search: memoryFace.search },
        callerRoleOf: (sessionId) => assembled.core.callerRoleOf(sessionId),
    });
    // 会话空闲：压缩驱动（pending 只由我方投递打标；idle 且无排队消息才动作）
    // + 记忆增量摘要（worker/主管会话后台跑，同会话同增量位只跑一次）。
    // v1.2 B3：结果判定器（事件驱动两级 + 兜底定时器；规格 §4）
    const adjudicator = new OutcomeAdjudicator({
        ledger,
        observeSession: async (sessionId, options) => {
            void options;
            const observation = await ctx.sessionQuery.observeSession(sessionId);
            try {
                return { events: observation.events ?? [] };
            }
            finally {
                observation.dispose?.();
            }
        },
        prompt: (request) => ctx.sessionController.prompt(request, AbortSignal.timeout(120_000)),
        sessionState: async (sessionId) => {
            const state = ctx.sessionController.state;
            return state === undefined ? undefined : await state(sessionId);
        },
        agentsGet: (sessionId) => {
            const agent = ctx.agents.get(sessionId);
            return agent === undefined || agent.status === undefined ? undefined : { status: agent.status };
        },
        llm: summaryLlm,
        core: {
            completeTask: (caller, taskId, input) => assembled.core.completeTask(caller, taskId, input),
            reportBlocker: (caller, taskId, reason) => assembled.core.reportBlocker(caller, taskId, reason),
        },
        intents: closureIntents,
        recordIncident: (entry) => {
            void memoryStore.appendSummary('project', `任务 ${entry.taskId}`, {
                sourceRefs: [`task:${entry.taskId}`],
                kind: 'verified-fact',
                text: entry.text,
            }).catch((error) => {
                log.warn(`事故记忆写入失败（${entry.taskId}）: ${error instanceof Error ? error.message : String(error)}`);
            });
        },
        now: () => Date.now(),
        schedule: (delayMs, fn) => {
            const timer = setTimeout(() => { void fn(); }, delayMs);
            return () => clearTimeout(timer);
        },
        ...(config.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: config.firstResponseTimeoutMs } : {}),
        ...(config.adjudicationWallClockMs !== undefined ? { adjudicationWallClockMs: config.adjudicationWallClockMs } : {}),
        logger: { warn: (m) => log.warn(m) },
    });
    adjudicatorRef.current = adjudicator;
    bridge.watchStatus();
    // 轮次边界（v1.2 规格 §3）：running→true 即新轮——预算清零重计（ask_user 的
    // 回答开启新轮，自然重计）。
    bridge.onStatusChange((sessionId, running) => {
        if (running)
            budgets.onTurnStart(sessionId);
    });
    bridge.onStatusChange((sessionId, running) => {
        if (running)
            return;
        void driver.onIdle(sessionId).then((outcome) => {
            if (outcome === 'compacted')
                log.info(`会话 ${sessionId} 派发后上下文整理完成`);
        });
        void (async () => {
            if (!(await isTaskSession(sessionId)))
                return;
            summarizer.onIdle(sessionId);
        })();
    });
    // v1.2 B3：轮沿喂判定器（去抖在判定器内）
    bridge.onStatusChange((sessionId, running) => {
        if (running)
            adjudicator.onTurnStart(sessionId);
        else
            adjudicator.onTurnEnd(sessionId);
    });
    void adjudicator.syncWatched();
    // 问答瀑布：全局监听收所有会话；prepend 抢在客户端兜底 UI 之前认领 worker 提问
    //（答案走 Router 界面浮窗，见规格 §3.3）。
    ctx.on('user-questions/request', (async (request, next) => {
        const outcome = await relay.claimQuestion(request, next);
        // 问答变化影响活动快照的「待回答事项」，同步刷缓存（fire-and-forget）
        void assembled.refreshSnapshot();
        return outcome;
    }), { prepend: true });
    // 缓存命中观测（v1.3 C1，规格 §4 / r11）：根作用域 session/event 放行向上，
    // 一个监听器收所有会话的落账事件——过滤任务会话首条 assistant/message 的
    // data.usage.cacheReadTokens 记进账本任务（fire-and-forget，观测不挡事件流）。
    const cacheObserver = new FirstRequestCacheObserver({ ledger, logger: { warn: (message) => log.warn(message) } });
    ctx.on('session/event', ((session, event) => {
        void cacheObserver.onSessionEvent(session, event);
    }));
    // 启动恢复：动态预设同步（Router 动态化→静态兜底 + 启用类型全量注册）+ UI
    // 状态装载 + 账本孤儿问题清理 + 快照缓存预热 + 会话提示词覆盖装载。
    ctx.effect(() => {
        void (async () => {
            const defaults = await defaultsStore.get();
            defaultsText = defaults.routerSystemPrompt; // 默认文本缓存刷新（section 同步读）
            const routerOutcome = await engine.syncRouter(spawnMode());
            const enabledTypes = (await typeStore.list()).filter((record) => record.enabled);
            const outcomes = await engine.syncTypes(enabledTypes, spawnMode());
            if (outcomes.failed.length > 0) {
                log.warn(`动态预设注册失败被跳过的类型（派发会被拒）: ${outcomes.failed.join('、')}`);
            }
            log.info(`动态预设同步完成：Router=${routerOutcome}，类型注册 ${outcomes.registered.length} 个（内置 ${BUILTIN_GENERAL_ID} 走静态预设）`);
            await sessionPrompts.load();
            await ui.load();
            await ledger.listAll();
            const recovered = await assembled.recoverOrphans();
            if (recovered.length > 0)
                log.warn(`重启恢复：${recovered.length} 个待答问题已失效，对应任务标为受阻`);
            // 熔断状态恢复自报（规格 §2：宿主重启恢复冻结态；冻结时一切派发被拒，
            // 直至用户解除）。
            const guardState = await breaker.state();
            if (guardState.frozen) {
                const frozenAt = guardState.frozenAt !== undefined ? new Date(guardState.frozenAt).toISOString() : '未知时间';
                log.warn(`重启恢复：派发已冻结（${guardState.reason ?? '原因未记录'}，冻结于 ${frozenAt}）——请停止重试并向用户报告，直至用户解除`);
            }
            await assembled.refreshSnapshot();
            log.info('routerCore 就绪');
        })();
    }, 'dsh-router: 启动恢复与动态预设同步');
    // HTTP 路由（webServer/connection 机会式：缺席不挡装载）。
    // C4：GET /router/state 前 先跑去重扫描（判定按会话缓存，稳态零读取），
    // 返回前把该 workspace 未消费的 redirect 指令并进 state。
    // C3：worker 类型 / Router 默认值七条路由——写操作走 WorkerTypeStore /
    // RouterDefaultsStore，成功后触发动态预设引擎增量同步（重注册即重载工具行，
    // 该类型的 dispatch 描述随之刷新；Router 预设的描述刷新钩子归 C2，见任务报告）。
    ctx.inject?.(['webServer', 'connection'], (child) => {
        registerRouterRoutes(child, {
            getState: async (workspaceId) => {
                if (dedup !== undefined) {
                    await dedup.resolve();
                    // v1.3 A2 + 评审 F4：收编正主——picker 自建的 Router 预设会话先登记进
                    // ui.routerSessions（否则 superset 角色解析查不到，编排工具全被拒），
                    // 再按已发标记幂等补发身份卡。
                    await adoptCanonicalRouterSessions({
                        canonicals: dedup.canonicalSessions(),
                        known: (sessionId) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
                        register: (sessionId, wsId) => ui.addRouterSession(sessionId, wsId, 'Router'),
                        deliver: (sessionId) => deliverRouterCard(sessionId),
                    });
                }
                const state = await assembled.workbench.state(workspaceId);
                const withRedirect = dedup !== undefined
                    ? stateWithRedirect(state, dedup.pendingRedirectFor(workspaceId))
                    : state;
                // v1.2 B4 最小通知投影：guard 通知段非空才带键（lossless；C1 统一通知卡
                // 合并后由此键承载全部卡）。
                return withRedirect;
            },
            createRouterSession: async (workspaceId, name) => {
                const created = await assembled.workbench.createRouterSession(workspaceId, name);
                // v1.3 A2 规格 §2.2：Router 会话创建成功后投递一次身份卡（幂等）。
                await deliverRouterCard(created.sessionId);
                return created;
            },
            answerQuestion: async (questionId, answers) => {
                await assembled.workbench.answerQuestion(questionId, answers);
                void assembled.refreshSnapshot();
            },
            closeTab: (workspaceId, sessionId) => assembled.workbench.closeTab(workspaceId, sessionId),
            ackRedirect: (workspaceId, supersededSessionId) => {
                dedup?.ackRedirect(workspaceId, supersededSessionId);
                return Promise.resolve();
            },
            listWorkerTypes: async () => ({ types: await typeStore.list() }),
            createWorkerType: async (input) => {
                const type = await typeStore.create(input);
                await syncTypePresets(type);
                return { type };
            },
            updateWorkerType: async ({ templateId, patch }) => {
                const type = await typeStore.update(templateId, patch);
                await syncTypePresets(type);
                return { type };
            },
            setWorkerTypeEnabled: async ({ templateId, enabled }) => {
                const type = await typeStore.setEnabled(templateId, enabled);
                // 禁用不注销（保留注册只拒派发，r4 §4）；重新启用时重注册（定义可能在禁用期被改过）。
                await syncTypePresets(type);
                return { type };
            },
            removeWorkerType: async (templateId) => {
                await typeStore.remove(templateId);
                await engine.removeType(templateId); // 删除 = 注销动态预设（已关闭会话需重建同名类型才可重开）
            },
            getDefaults: () => defaultsStore.get(),
            saveDefaults: async (value) => {
                const saved = await defaultsStore.set(value);
                // C5 起 Router 动态定义不烘焙默认文本（prompt-section 运行时经
                // sessionPromptText 现读），默认值变更只需刷新缓存，不再重注册预设——
                // 也避免「保存默认时重注册瞬败 → 回退静态 persona 行 → 丢失会话级
                // 覆盖能力」的回归路径。
                defaultsText = saved.routerSystemPrompt;
                return saved;
            },
            // v1.3 C2 spawn-mode（规格 §1 volatile）：内存易变 holder——POST 即时生效
            // 不落盘，宿主重启回到启动配置值（要常驻用宿主设置页改 workerSpawnMode
            // 配置）。Part A 的组合引擎/分叉创建消费同一 holder（读 spawnMode()）。
            getSpawnMode: async () => ({ mode: spawnMode() }),
            saveSpawnMode: async (mode) => {
                currentSpawnMode = mode;
                return { mode: spawnMode() };
            },
            // 会话级系统提示词（v1.1 C5）：读带 isDefault 标记；写空串 = 清除回落
            // 默认。写后下一轮 system prompt 组装即生效（section text 每轮现读）。
            getSessionPrompt: async (sessionId) => {
                const override = sessionPrompts.get(sessionId);
                return override !== undefined
                    ? { prompt: override, isDefault: false }
                    : { prompt: defaultsText, isDefault: true };
            },
            saveSessionPrompt: async (sessionId, prompt) => {
                if (prompt === '')
                    await sessionPrompts.clear(sessionId);
                else
                    await sessionPrompts.set(sessionId, prompt);
            },
            ackNotification: (cardId) => notifications.ack(cardId),
            /* ── 用户控制与紧急暂停（v1.2 B4）：用户发起，绕过模型侧预算；caller 记 'user' ── */
            controlTask: async (taskId, action) => {
                if (action === 'redispatch') {
                    // redispatch 是再派发：受熔断约束（冻结时明确提示先解除；其余闸门
                    // ——状态机/依赖/深度——由 supplementTask 的既有路径把守）。
                    const breakerState = await breaker.state();
                    if (breakerState.frozen) {
                        throw new LedgerError('dispatch-frozen', `派发已冻结（${breakerState.reason ?? '原因未记录'}）：重派被拒——请先解除冻结（POST /router/breaker/unfreeze 或工作台「解除冻结」），再重派任务 ${taskId}`);
                    }
                    await assembled.core.supplementTask('user', taskId, ['用户重派：请按任务书当前版本推进（用户经控制路由发起）']);
                    const record = assembled.core.getTask(taskId);
                    return { status: record?.status ?? 'failed' };
                }
                return assembled.core.controlTask('user', taskId, action);
            },
            unfreezeBreaker: async () => {
                const beforeState = await breaker.state();
                const before = { frozen: beforeState.frozen };
                if (beforeState.frozen) {
                    if (beforeState.reason !== undefined)
                        before.reason = beforeState.reason;
                    if (beforeState.frozenAt !== undefined)
                        before.frozenAt = beforeState.frozenAt;
                }
                await breaker.unfreeze();
                const afterState = await breaker.state();
                return { before, after: { frozen: afterState.frozen } };
            },
            emergencyPause: async () => runEmergencyPause({
                targetSessionIds: async () => emergencyPauseTargets(await ledger.listAll()),
                freeze: async (reason) => {
                    await breaker.freeze(reason);
                    const state = await breaker.state();
                    return state.frozen && state.reason !== undefined
                        ? { frozen: state.frozen, reason: state.reason }
                        : { frozen: state.frozen };
                },
                interrupt: (sessionIds) => bridge.interruptTaskSessions(sessionIds),
                notify: async (input) => notifications.push({
                    kind: 'anomaly',
                    title: input.title,
                    summary: input.summary,
                    actions: anomalyActions(),
                }),
                logger: { warn: (message) => log.warn(message) },
            }),
        });
    });
    function workerInstructionsText() {
        return WORKER_INSTRUCTIONS;
    }
}
//# sourceMappingURL=entry.js.map