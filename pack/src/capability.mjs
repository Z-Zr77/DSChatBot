// 判断一个模型名"能不能看图"。
// 只是启发式：命中就认为支持视觉输入；没命中就当成纯文本模型。
// 用在两个地方：bridge 决定看图走哪个模型；控制台给你提示"要不要再配一个视觉模型"。
const VISION_PATTERNS = [
  /qwen[\w.-]*-?vl/i,          // qwen-vl-max / qwen3-vl-plus / qwen2.5-vl
  /qwen[\w.-]*-omni/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /o4-mini/i,
  /glm-4[\w.]*v/i,             // glm-4v / glm-4.5v
  /glm-4v/i,
  /doubao[\w.-]*vision/i,
  /doubao-seed-1[.-]6/i,       // 豆包 1.6 系列本身是多模态
  /claude-3/i,
  /claude-4/i,
  /gemini/i,
  /internvl/i,
  /llava/i,
  /pixtral/i,
  /moondream/i,
  /step-1v/i,
  /yi-vl/i,
  /minicpm-v/i,
  /kimi[\w.-]*vl/i,
  /ernie[\w.-]*-vl/i,
];

export function looksVision(model) {
  const m = String(model || '').trim();
  if (!m) return false;
  return VISION_PATTERNS.some(re => re.test(m));
}

// 控制台、参考图描述和聊天看图共用顺序，避免界面提示与真实请求不一致。
export function resolveVision(api = {}, custom = {}, aliKey = '', fallback = true) {
  const model = String(api.model || '');
  const base = String(api.baseUrl || '').replace(/\/+$/, '');
  if (looksVision(model)) return { mode: 'brain', baseUrl: base || 'https://api.deepseek.com/v1', model, key: api.key || process.env.DEEPSEEK_API_KEY || '' };
  if (custom.baseUrl || custom.model) return { mode: 'custom', baseUrl: String(custom.baseUrl || base).replace(/\/+$/, ''), model: custom.model || model, key: custom.key || api.key || '' };
  if (aliKey && fallback) return { mode: 'fallback', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', key: aliKey };
  return { mode: 'none', baseUrl: '', model: '', key: '' };
}
