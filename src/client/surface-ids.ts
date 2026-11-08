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

/** 全局「返回 Router」浮动按钮（list、root、frame 级浮层——问题浮窗同槽位的第二项）。 */
export const BACK_BUTTON_SLOT = 'shell.overlay'
export const BACK_BUTTON_ID = 'router-back-button'
export const BACK_BUTTON_ORDER = 35

/** 统一通知卡浮窗（list、root、frame 级浮层——同槽位第四项，v1.2 C1）：
 *  完成/异常卡 + 列顶「紧急暂停/解除冻结」按钮（裁定：常驻全局可见）。 */
export const NOTIFICATION_OVERLAY_SLOT = 'shell.overlay'
export const NOTIFICATION_OVERLAY_ID = 'router-notification-overlay'
export const NOTIFICATION_OVERLAY_ORDER = 37

/**
 * 「提示词」视图标签（v1.5：提示词管理移入会话界面）：conversation.view
  *（list、session）第三方条目自动进 viewTabs（r5 §1），order 20 落在轨迹与
  * 统计之间；Router 会话=编辑器，其余=空态说明。
 */
export const SYSTEM_PROMPT_VIEW_SLOT = 'conversation.view'
export const SYSTEM_PROMPT_VIEW_ID = 'router-system-prompt'
export const SYSTEM_PROMPT_VIEW_ORDER = 20

/** 设置段（list、root——一个 entry 一整页设置）。 */
export const SETTINGS_SLOT = 'settings.section'
export const SETTINGS_ID = 'router-settings'
export const SETTINGS_ORDER = 120
