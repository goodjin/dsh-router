/**
 * 表面登记的唯一键名表（R3 报告核实的 slot key 与本包的登记 id）。
 *
 * 集中一处：index.ts 的 apply、四个表面模块、entry.spec 的接线断言都读
 * 这里，键名漂移会在接线测试里立刻红掉，而不是装上后静默失效。
 */

/** 会话导航标签条（single、root、零占用——头部 leading 座位）。 */
export const WORKBENCH_TABS_SLOT = 'conversation.header.leading'
export const WORKBENCH_TABS_ID = 'router-workbench-tabs'
export const WORKBENCH_TABS_ORDER = 10

/** 全局问题浮窗（list、root、frame 级浮层）。 */
export const QUESTION_OVERLAY_SLOT = 'shell.overlay'
export const QUESTION_OVERLAY_ID = 'router-question-overlay'
export const QUESTION_OVERLAY_ORDER = 30

/** 侧栏底部动作位（list、root——Settings 旁的增量入口）。 */
export const CREATE_ENTRY_SLOT = 'sidebar.footer.action'
export const CREATE_ENTRY_ID = 'router-create-entry'
export const CREATE_ENTRY_ORDER = 40

/** 设置段（list、root——一个 entry 一整页设置）。 */
export const SETTINGS_SLOT = 'settings.section'
export const SETTINGS_ID = 'router-settings'
export const SETTINGS_ORDER = 120
