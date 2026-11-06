/**
 * 设置段（计划 Task B7；slot key 以 R3 报告为准：settings.section）。
 *
 * 取舍（简报的回落分支）：本包还没有宿主 Config schema（cordis.patch.yml
 * 只有客户端装载行，本任务铁律不许改它），「经 settings.update 写 volatile
 * 配置」暂无落点——本段按约定做成只读展示：轮询间隔、浮窗开关、活动卡
 * 上限的当前值 + 一段说明。写通道已预留：client-prefs 的 startClientPrefs
 * 就是那条通道（localStorage 落盘 + 订阅广播，store 真正消费这些值），
 * 将来接宿主 Config 时把它的 storage 面换掉即可，本段换成可编辑控件。
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ClientPrefsStore } from './client-prefs.ts'
import { SETTINGS_ID, SETTINGS_ORDER, SETTINGS_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'

/** 组件的业务输入。 */
export interface SettingsFace {
  prefs: ClientPrefsStore
}

export type SettingsSectionProps = SettingsFace

/** 设置段的 rail 行文字（thunk；将来接 locale 时在这里换）。 */
export function settingsLabel(): string {
  return 'Router'
}

/** 把设置段注册进 settings.section（entry.spec 断言键名/id）。 */
export function registerSettingsSection(slots: SlotsHost, face: SettingsFace): void {
  slots.inject(SETTINGS_SLOT, () => slots.register(
    { name: SETTINGS_SLOT, id: SETTINGS_ID, order: SETTINGS_ORDER, label: settingsLabel, inject: () => face },
    RouterSettingsSection,
  ))
}

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 560,
  fontSize: 13,
  lineHeight: 1.6,
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
}

const NOTE_STYLE: CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
}

function seconds(pollMs: number): string {
  const value = pollMs / 1000
  return Number.isInteger(value) ? `${value} 秒` : `${value.toFixed(1)} 秒`
}

function onOff(enabled: boolean): string {
  return enabled ? '开' : '关'
}

/** 设置段：只读展示三样当前值 + 写通道说明（简报回落分支）。 */
export function RouterSettingsSection(props: SettingsSectionProps): ReactNode {
  const prefs = useSyncExternalStore(props.prefs.subscribe, props.prefs.get)
  return (
    <div data-router-settings style={PAGE_STYLE}>
      <div>
        <strong>Router 工作台</strong>
        <div style={NOTE_STYLE}>
          会话导航标签条、worker 问题浮窗与「新建 Router」入口的插件级设置。
        </div>
      </div>
      <div style={ROW_STYLE} data-router-setting="pollMs">
        <span>状态轮询间隔</span>
        <span data-router-setting-value>{seconds(prefs.pollMs)}</span>
      </div>
      <div style={ROW_STYLE} data-router-setting="overlayEnabled">
        <span>问题浮窗</span>
        <span data-router-setting-value>{onOff(prefs.overlayEnabled)}</span>
      </div>
      <div style={ROW_STYLE} data-router-setting="maxActiveCards">
        <span>活动问题卡上限</span>
        <span data-router-setting-value>{prefs.maxActiveCards} 张</span>
      </div>
      <div style={NOTE_STYLE} data-router-settings-note>
        当前版本本插件还没有宿主侧 Config 表，以上值来自代码默认并在浏览器本地
        保存（清站点数据即恢复默认）；本段暂为只读。写入通道已按
        startClientPrefs 的存储面预留，接入宿主 Config 后这里会换成可编辑控件，
        值经 settings.update 落到本包 volatile 配置。
      </div>
    </div>
  )
}
