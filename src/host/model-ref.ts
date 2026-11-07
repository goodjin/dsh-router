/**
 * 模型引用解析（v1.1 规格 §5：允许模型列表存 "provider/model" 字符串，首个为
 * 该类型会话默认模型）。宿主侧的模型路由是 {provider, model} 对（r4 §6.4：
 * agent-default-model 的 config 形状；sessionController.selectModel 同款入参），
 * 钉定前经本函数把引用串拆开。
 *
 * 约定：在**第一个** "/" 处切分——provider id（deepseek-official、acp-glm、
 * minimax-cn 等）不含斜杠，model id（含供应商自有斜杠路径）整体保留。切不出
 * 两段的串视为不合法（返回 undefined，调用方跳过钉定并告警，不猜）。
 */

export interface ModelRef {
  provider: string
  model: string
}

export function parseModelRef(ref: string): ModelRef | undefined {
  if (typeof ref !== 'string') return undefined
  const slashAt = ref.indexOf('/')
  if (slashAt <= 0 || slashAt >= ref.length - 1) return undefined
  const provider = ref.slice(0, slashAt)
  const model = ref.slice(slashAt + 1)
  return provider.trim() === '' || model.trim() === '' ? undefined : { provider, model }
}
