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

/** 系统提示词编辑浮层（list、root、frame 级浮层——同槽位第三项，v1.1 C5）。 */
export const PROMPT_EDITOR_SLOT = 'shell.overlay'
export const PROMPT_EDITOR_ID = 'router-prompt-editor'
export const PROMPT_EDITOR_ORDER = 36

/**
 * 会话头部动作位（list、session——标题旁的动作按钮，v1.1 C5）。
 * 取证结论（r5 + 宿主源码）：conversation.view 第三视图的标签由宿主 viewTabs()
 * 全局枚举，registerOptions 只有 id/order/label，没有按会话显隐的谓词
 * （唯一的条件过滤是宿主写死的 trajectory 开发者工具开关）——第三方标签
 * 无法只在 Router 会话显示，故按规格 §10 批准的回退路线挂 header.actions
 * 按钮（组件可按会话返回 null 实现条件显隐），点击弹出编辑浮层。
 * 注意槽位文档：溢出会被裁切淡出，浮层必须 portal——编辑面板走 shell.overlay。
 */
export const PROMPT_ACTION_SLOT = 'conversation.session.header.actions'
export const PROMPT_ACTION_ID = 'router-prompt-action'
export const PROMPT_ACTION_ORDER = 50

/** 侧栏底部动作位（list、root——Settings 旁的增量入口）。 */
export const CREATE_ENTRY_SLOT = 'sidebar.footer.action'
export const CREATE_ENTRY_ID = 'router-create-entry'
export const CREATE_ENTRY_ORDER = 40

/** 设置段（list、root——一个 entry 一整页设置）。 */
export const SETTINGS_SLOT = 'settings.section'
export const SETTINGS_ID = 'router-settings'
export const SETTINGS_ORDER = 120
