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
 *     → 四条 HTTP exact 路由（webServer/connection 机会式注入）
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
import { TaskDocStore } from "./host/docs/task-docs.js";
import { Scheduler } from "./host/ledger/scheduler.js";
import { SessionBridge } from "./host/bridge/sessions.js";
import { AnswerRelay } from "./host/bridge/questions.js";
import { UiStateStore } from "./host/bridge/tabs.js";
import { CompactionDriver } from "./host/context/compaction-driver.js";
import { registerRouterRoutes } from "./host/routes.js";
import { createRouterCore } from "./host/core.js";
import { workerInstructions as WORKER_INSTRUCTIONS } from "./host/prompts/worker-instructions.js";
import { BUILTIN_TEMPLATES } from "./host/templates.js";
export { Config } from "./host/root-config.js";
/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router';
/** 必需的宿主服务（缺席行装载失败，fail loud，不留静默残废）。 */
export const inject = ['sessionController', 'agents', 'workspaceRegistry'];
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
function resolveRootConfig(raw) {
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
    const workspaceRegistry = {
        list: () => ctx.workspaceRegistry.list(),
        get: (id) => ctx.workspaceRegistry.get(id),
    };
    const hosts = {
        sessionController: ctx.sessionController,
        agents: ctx.agents,
        workspaceRegistry,
        onSessionStatus: (callback) => {
            ctx.on('api-session/status', (sessionId, running) => callback(String(sessionId), Boolean(running)));
        },
    };
    const bridge = new SessionBridge({
        ledger,
        docsFor,
        workspaces: workspaceRegistry,
        host: {
            create: async (opts, signal) => (await ctx.sessionController.create(opts, signal)).sessionId,
            prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
            onStatus: (callback) => hosts.onSessionStatus(callback),
            rename: async (sessionId, title) => {
                await ctx.sessionController.rename({ sessionId, title });
            },
        },
        presets: { supervisor: config.supervisorPreset, worker: config.workerPreset },
        workerInstructions: () => workerInstructionsText(),
        signal: undefined,
    });
    const relay = new AnswerRelay({ ledger, newId: () => randomUUID(), now: () => Date.now() });
    const scheduler = new Scheduler(ledger, {
        maxDepth: config.maxDepth,
        concurrency: { default: config.perTypeConcurrency },
    });
    let pairing = null;
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
        lastUserMessageSeq: async (sessionId) => {
            const sessionQuery = ctx.get?.('sessionQuery');
            if (sessionQuery === undefined)
                return null;
            try {
                const surface = await sessionQuery.readSurface(sessionId);
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
        ledger,
        docsFor,
        bridge,
        relay,
        driver,
        scheduler,
        ui,
        hosts,
        config,
        newId: () => randomUUID(),
        isRunning: (sessionId) => bridge.isRunning(sessionId),
        maxActiveCards: config.maxActiveCards,
        logger: { warn: (message) => log.warn(message) },
    });
    // 供预设树的工具行 / 上下文行经作用域链注入。
    ctx.provide('routerCore', {
        ...assembled.core,
        snapshotText: assembled.snapshotText,
    });
    // 会话空闲 → 压缩驱动（pending 只由我方投递打标；空闲边才动作）。
    bridge.watchStatus();
    bridge.onStatusChange((sessionId, running) => {
        if (!running)
            void driver.onIdle(sessionId).then((outcome) => {
                if (outcome === 'compacted')
                    log.info(`会话 ${sessionId} 派发后上下文整理完成`);
            });
    });
    // 问答瀑布：全局监听收所有会话；prepend 抢在客户端兜底 UI 之前认领 worker 提问
    //（答案走 Router 界面浮窗，见规格 §3.3）。
    ctx.on('user-questions/request', (async (request, next) => {
        const outcome = await relay.claimQuestion(request, next);
        // 问答变化影响活动快照的「待回答事项」，同步刷缓存（fire-and-forget）
        void assembled.refreshSnapshot();
        return outcome;
    }), { prepend: true });
    // 启动恢复：UI 状态装载 + 账本孤儿问题清理 + 快照缓存预热。
    ctx.effect(() => {
        void (async () => {
            await ui.load();
            await ledger.listAll();
            const recovered = await assembled.recoverOrphans();
            if (recovered.length > 0)
                log.warn(`重启恢复：${recovered.length} 个待答问题已失效，对应任务标为受阻`);
            await assembled.refreshSnapshot();
            log.info('routerCore 就绪');
        })();
    }, 'dsh-router: 启动恢复');
    // 四条 HTTP 路由（webServer/connection 机会式：缺席不挡装载）。
    ctx.inject?.(['webServer', 'connection'], (child) => {
        registerRouterRoutes(child, {
            getState: (workspaceId) => assembled.workbench.state(workspaceId),
            createRouterSession: (workspaceId, name) => assembled.workbench.createRouterSession(workspaceId, name),
            answerQuestion: async (questionId, answers) => {
                await assembled.workbench.answerQuestion(questionId, answers);
                void assembled.refreshSnapshot();
            },
            closeTab: (workspaceId, sessionId) => assembled.workbench.closeTab(workspaceId, sessionId),
        });
    });
    function workerInstructionsText() {
        return WORKER_INSTRUCTIONS;
    }
}
//# sourceMappingURL=entry.js.map