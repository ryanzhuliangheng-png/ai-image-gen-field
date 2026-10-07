import {
  FieldType,
  fieldDecoratorKit,
  FormItemComponent,
  FieldExecuteCode,
  AuthorizationType,
} from 'dingtalk-docs-cool-app';
import * as https from 'https';

const { t } = fieldDecoratorKit;

/**
 * 域名白名单：只写域名，不带协议/路径/端口。
 * 注意：本地调试 SDK 的匹配是「精确主机名 或 正则」；父域名字符串只在正式环境自动放通子域名。
 * 所以这里字符串列表用于正式环境语义，下面的正则列表（ALLOW_HOSTS）用于覆盖子域名（两种环境都兼容）。
 */
const WHITELIST = [
  'openai.com', // OpenAI（api.openai.com）
  'openlux.ai', // OpenLux 中转（api.openlux.ai）
  'aliyuncs.com', // 阿里云 OSS / DashScope
  'dingtalk.com', // 钉钉附件/静态资源
  'bigmodel.cn', // 智谱 GLM
  'siliconflow.cn', // 硅基流动
  'volces.com', // 火山方舟
  'stepfun.com', // 阶跃星辰
  'cloud.tencent.com', // 腾讯混元
];

/** 子域名通配（正则）：本地调试全等匹配靠这个放行 *.openlux.ai / *.dingtalk.com / *.aliyuncs.com 等 */
const ALLOW_HOSTS: RegExp[] = [
  /^([a-z0-9-]+\.)+openai\.com$/i,
  /^([a-z0-9-]+\.)+openlux\.ai$/i,
  /^([a-z0-9-]+\.)+aliyuncs\.com$/i,
  /^([a-z0-9-]+\.)+dingtalk\.com$/i,
  /^([a-z0-9-]+\.)+bigmodel\.cn$/i,
  /^([a-z0-9-]+\.)+siliconflow\.cn$/i,
  /^([a-z0-9-]+\.)+volces\.com$/i,
  /^([a-z0-9-]+\.)+stepfun\.com$/i,
  /(^|\.)cloud\.tencent\.com$/i,
];
// 精确主机名兜底：正式环境白名单是全等匹配，子域名服务（如钉钉附件 CDN）必须显式列出
fieldDecoratorKit.setDomainList([
  ...WHITELIST,
  ...ALLOW_HOSTS,
  'api.openlux.ai',
  'alidocs2-zjk-cdn.dingtalk.com',
  'static.dingtalk.com',
  'img.alicdn.com',
  'videos.tpkcur.xyz',
] as unknown as string[]);

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * 网络请求 + 证书兼容重试：
 * 部分办公网/本机环境（代理、VPN、老版本 Node）对钉钉附件 CDN 建链报
 * "unable to get local issuer certificate"（沙箱外网实测证书链完整、验证通过，属用户端环境问题）。
 * 策略：先正常严格校验；仅证书类错误时降级重试一次（只影响图片下载/推理请求）。
 */
async function tolerantFetch(context: any, url: string, options: any, authId?: string): Promise<any> {
  try {
    return await context.fetch(url, options, authId);
  } catch (e) {
    const msg = String((e as any)?.message || e) + ' ' + String((e as any)?.code || '');
    if (/unable to get local issuer|self[ -]?signed|unable to verify|UNABLE_TO_|certificate has expired|SSL/i.test(msg)) {
      return await context.fetch(url, { ...options, agent: new https.Agent({ rejectUnauthorized: false }) }, authId);
    }
    throw e;
  }
}

/** 沙箱禁用 crypto 库，用时间戳+随机数生成 multipart boundary 即可 */
function makeBoundary(): string {
  return '----aitable' + Date.now().toString(16) + Math.random().toString(16).slice(2);
}

function isHostWhitelisted(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return WHITELIST.some((d) => host === d || host.endsWith('.' + d));
}

function guessMime(fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

/** 判断附件字段值是不是图片 */
function isImageAttachment(att: any): boolean {
  const type = String(att?.type || '').toLowerCase();
  const name = String(att?.name || '').toLowerCase();
  return type.startsWith('image') || /\.(png|jpe?g|webp|gif|bmp)$/.test(name);
}

interface ReferenceImage {
  filename: string;
  mime: string;
  data: Buffer;
  tmpUrl?: string;
}

/** 把参考图附件下载为二进制 */
async function loadReferenceImages(context: any, attachments: any[]): Promise<ReferenceImage[]> {
  const images: ReferenceImage[] = [];
  for (const att of attachments) {
    if (!att?.tmp_url || !isImageAttachment(att)) continue;
    const res = await tolerantFetch(context, att.tmp_url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`download reference image failed, http ${res.status}: ${att.name}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    images.push({
      filename: att.name || `reference-${images.length + 1}.png`,
      mime: guessMime(String(att.name || '')),
      data: buf,
    });
  }
  return images;
}

/** 手工构造 multipart/form-data 请求体（沙箱无 form-data 类库） */
function buildMultipartBody(fields: Array<[string, string]>, images: ReferenceImage[], boundary: string): Buffer {
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
        'utf8',
      ),
    );
  }
  const imageFieldName = images.length > 1 ? 'image[]' : 'image';
  for (const img of images) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${imageFieldName}"; filename="${img.filename.replace(/"/g, '')}"${CRLF}` +
          `Content-Type: ${img.mime}${CRLF}${CRLF}`,
        'utf8',
      ),
      img.data,
      Buffer.from(CRLF, 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return Buffer.concat(chunks);
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 视频协议：wan/happyhorse 走百炼原生任务式，其余按 Sora 式 /v1/videos */
function detectVideoProto(model: string, override: string): 'sora' | 'bailian' {
  if (override === 'sora' || override === 'bailian') return override;
  return /happyhorse|^wan[23]/i.test(model) ? 'bailian' : 'sora';
}

async function executeVideo(context: any, formData: any, target: URL, firstImageUrl: string): Promise<any> {
  const model = String(formData.model || '').trim();
  const prompt = String(formData.promptField ?? '').trim();
  const proto = detectVideoProto(model, String(formData.videoProtocol || 'auto'));
  const origin = target.origin;
  const base = origin + target.pathname.replace(/\/+$/, '');
  const sizeKey = String(formData.size || 'auto');
  const duration = Number(formData.videoDuration) || 5;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  let submitUrl: string;
  let submitBody: any;
  let poll: (id: string) => string;
  let getTask: (js: any) => { status: string; url?: string; msg?: string };

  if (proto === 'bailian') {
    const resolution = sizeKey === '480p' ? '480P' : sizeKey === '1080p' ? '1080P' : '720P';
    submitUrl = origin + '/alibailian/api/v1/services/aigc/video-generation/video-synthesis';
    submitBody = {
      model,
      input: firstImageUrl ? { prompt, img_url: firstImageUrl } : { prompt },
      parameters: { resolution, duration },
    };
    poll = (id) => origin + '/alibailian/api/v1/tasks/' + id;
    getTask = (js) => ({
      status: String(js?.output?.task_status || '').toUpperCase(),
      url: js?.output?.video_url,
      msg: js?.message || js?.output?.message,
    });
  } else {
    if (firstImageUrl) {
      // Sora 式协议不支持参考图，明确提示而不是静默忽略
      return { code: FieldExecuteCode.ConfigError, msg: 'sora-style video does not accept reference images; use bailian model (happyhorse/wan) for image-to-video', extra: { logId: context.logId, model } };
    }
    submitUrl = base + '/videos';
    submitBody = { model, prompt, seconds: String(duration) };
    const soraSize: Record<string, string> = { '480p': '854x480', '720p': '1280x720', '1080p': '1920x1080' };
    if (soraSize[sizeKey]) submitBody.size = soraSize[sizeKey];
    poll = (id) => base + '/videos/' + id;
    getTask = (js) => ({
      status: String(js?.status || '').toLowerCase() === 'completed' ? 'SUCCEEDED'
        : ['failed', 'error', 'cancelled'].includes(String(js?.status || '').toLowerCase()) ? 'FAILED' : 'RUNNING',
      url: js?.url || js?.result_url || js?.video_url || js?.data?.[0]?.url,
      msg: js?.error?.message,
    });
  }

  // ---- 提交任务 ----
  let submitJson: any = null;
  try {
    const res = await tolerantFetch(context, submitUrl, { method: 'POST', headers, body: JSON.stringify(submitBody) }, 'image_api_key');
    const text = await res.text();
    try { submitJson = JSON.parse(text); } catch { submitJson = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      return { code: FieldExecuteCode.Error, errorMessage: 'vid_failed', extra: { logId: context.logId, stage: 'submit', httpStatus: res.status, response: String(submitJson?.error?.message || submitJson?.message || submitJson?.raw || text).slice(0, 300) } };
    }
  } catch (e) {
    return { code: FieldExecuteCode.Error, errorMessage: 'vid_failed', extra: { logId: context.logId, stage: 'submit-network', reason: String((e as Error)?.message ?? e) } };
  }

  const taskId = String(submitJson?.id || submitJson?.task_id || submitJson?.output?.task_id || '');
  if (!taskId) {
    return { code: FieldExecuteCode.Error, errorMessage: 'vid_failed', extra: { logId: context.logId, stage: 'submit', reason: 'no task id in response', keys: Object.keys(submitJson || {}).join(',') } };
  }

  // ---- 轮询（最长约 12 分钟；视频任务通常 1~5 分钟）----
  for (let i = 0; i < 90; i++) {
    await sleep(8000);
    let js: any = null;
    try {
      const res = await tolerantFetch(context, poll(taskId), { method: 'GET' }, 'image_api_key');
      const text = await res.text();
      try { js = JSON.parse(text); } catch { continue; }
      if (!res.ok) continue;
      const t = getTask(js);
      if (t.status === 'SUCCEEDED' && t.url) {
        return {
          code: FieldExecuteCode.Success,
          data: [{ fileName: `ai-video-${Date.now()}.mp4`, type: 'video', url: String(t.url) }],
        };
      }
      if (t.status === 'FAILED') {
        return { code: FieldExecuteCode.Error, errorMessage: 'vid_failed', extra: { logId: context.logId, stage: 'task', taskId, reason: String(t.msg || '').slice(0, 300) } };
      }
    } catch {
      // 单次轮询失败继续重试
    }
  }
  // 轮询耗尽：优先用未记录的内置超时码
  return { code: FieldExecuteCode.Timeout, msg: `video task not finished in ~12min, taskId=${taskId}` };
}

fieldDecoratorKit.setDecorator({
  name: 'AI Image Gen (Custom Model)',

  i18nMap: {
    'zh-CN': {
      baseUrlLabel: '接口 Base URL（可选）',
      baseUrlTip:
        'OpenAI 兼容服务地址，留空默认 https://api.openai.com/v1。请求将调用 {BaseURL}/images/generations（无参考图）或 /images/edits（有参考图）。服务商域名需在代码 WHITELIST 中',
      modelLabel: '模型名称',
      modelTip: '图片如 gpt-image-2、qwen-image-3.0；视频如 veo_3_1-fast、happyhorse-1.1-t2v/i2v、wan2.6-i2v（协议自动识别）',
      promptFieldLabel: '提示词（选择文本字段）',
      refFieldLabel: '参考图（可多选附件字段）',
      refFieldTip:
        '可依次勾选多个附件字段（如先选「服装图」再选「模特照」），所有图片按勾选顺序作为参考图传入图生图；提示词里用「第1张/第2张」指代即可。不选则为纯文生图',
      sizeLabel: '输出尺寸',
      sizeAuto: '默认（不传 size）',
      sizeTip: '图片用 WxH 档；视频用 480p/720p/1080p 档（互不影响，按输出类型取对应档）',
      durLabel: '视频时长（秒）',
      fmtLabel: '返回格式参数',
      fmtUrl: '请求 response_format=url（推荐）',
      fmtNone: '不传 response_format（部分模型如 gpt-image-1 只回 base64，需服务商支持返回图片 URL）',
      outLabel: '输出类型',
      outImage: '图片',
      outVideo: '视频（生成约需 1~5 分钟，自动等待）',
      protoLabel: '视频接口协议',
      protoAuto: '自动（按模型名识别 wan/happyhorse→百炼式，其余→Sora 式）',
      protoSora: 'Sora 式（/v1/videos：veo、grok、seedance 等）',
      protoBailian: '百炼式（wan / happyhorse 系列，参考图生视频请用本系列）',
      vidNeedImage: '参考图生视频需要百炼式模型（如 happyhorse-1.1-i2v、wan2.6-i2v），或清空参考图改走文生视频',
      vidFailed: '视频生成任务失败',
      vidTimeout: '视频生成超时，请稍后重试',
      authTip: '请填写你的 AI 服务 API Key，请求会以 Authorization: Bearer <key> 发送',
      authLabel: 'AI 服务 API Key',
      needPrompt: '提示词字段内容为空，无法生图',
      noImage: '参考图字段里没有可用的图片附件',
      needPublicUrl:
        '服务端没有返回图片 URL（附件字段要求公开可访问的图片链接）。请改用支持返回 URL 的服务/模型，或在配置里选择「不传 response_format」后由服务端默认返回 URL',
      apiError: 'AI 服务调用失败，请检查 Base URL、模型名与 API Key',
      refDownloadError: '下载参考图失败，请稍后重试',
    },
    'en-US': {
      baseUrlLabel: 'Base URL (optional)',
      baseUrlTip:
        'OpenAI-compatible endpoint. Defaults to https://api.openai.com/v1 if empty. Calls {BaseURL}/images/generations (text-to-image) or /images/edits (with reference images). Provider domain must be in the code WHITELIST',
      modelLabel: 'Model name',
      modelTip: 'Image: gpt-image-2, qwen-image-3.0... Video: veo_3_1-fast, happyhorse-1.1-t2v/i2v (protocol auto-detected)',
      promptFieldLabel: 'Prompt (select a text field)',
      outLabel: 'Output type',
      outImage: 'Image',
      outVideo: 'Video (takes ~1-5 min, auto-waits)',
      protoLabel: 'Video API protocol',
      protoAuto: 'Auto (wan/happyhorse -> Bailian, others -> Sora-style)',
      protoSora: 'Sora-style (/v1/videos: veo, grok, seedance...)',
      protoBailian: 'Bailian-style (wan / happyhorse; image-to-video needs this)',
      durLabel: 'Video duration (seconds)',
      refFieldLabel: 'Reference images (multiple attachment fields)',
      refFieldTip:
        'Pick attachment fields in order (e.g. first the garment photo, then the model photo); all images are passed to image-to-image in that order — refer to them as "1st/2nd image" in your prompt. Leave empty for text-to-image',
      sizeLabel: 'Output size',
      sizeAuto: 'Default (omit size)',
      fmtLabel: 'response_format option',
      fmtUrl: 'Request response_format=url (recommended)',
      fmtNone: 'Omit response_format (some models only return base64)',
      sizeTip: 'Image uses WxH options; video uses 480p/720p/1080p options (each output type reads its own)',
      vidNeedImage: 'Image-to-video needs a Bailian model (e.g. happyhorse-1.1-i2v, wan2.6-i2v), or clear reference images for text-to-video',
      vidFailed: 'Video generation task failed',
      vidTimeout: 'Video generation timed out, please retry',
      authTip: 'Enter your AI service API Key. Requests will carry Authorization: Bearer <key>',
      authLabel: 'AI service API Key',
      needPrompt: 'The prompt field is empty; nothing to generate',
      noImage: 'No usable image attachment found in the reference field',
      needPublicUrl:
        'The service did not return an image URL (attachment output requires a publicly accessible URL). Use a model/service that returns URLs, or omit response_format',
      apiError: 'AI service call failed. Please check Base URL, model name and API key',
      refDownloadError: 'Failed to download reference image, please retry',
    },
  },

  errorMessages: {
    need_public_url: t('needPublicUrl'),
    vid_failed: t('vidFailed'),
    vid_timeout: t('vidTimeout'),
    api_error: t('apiError'),
    ref_download_error: t('refDownloadError'),
  },

  authorizations: {
    id: 'image_api_key',
    platform: 'OpenAICompatible',
    type: AuthorizationType.HeaderBearerToken,
    required: true,
    label: t('authLabel'),
    tooltips: t('authTip'),
    instructionsUrl: 'https://platform.openai.com/api-keys',
  },

  formItems: [
    {
      key: 'outputType',
      label: t('outLabel'),
      component: FormItemComponent.SingleSelect,
      props: {
        defaultValue: 'image',
        options: [
          { key: 'image', title: t('outImage') },
          { key: 'video', title: t('outVideo') },
        ],
      },
      validator: { required: true },
    },
    {
      key: 'model',
      label: t('modelLabel'),
      component: FormItemComponent.Textarea,
      props: { placeholder: 'gpt-image-1 / dall-e-2 / qwen-image ...' },
      validator: { required: true },
      tooltips: { title: t('modelTip') },
    },
    {
      key: 'baseUrl',
      label: t('baseUrlLabel'),
      component: FormItemComponent.Textarea,
      props: { placeholder: DEFAULT_BASE_URL },
      validator: { required: false },
      tooltips: { title: t('baseUrlTip') },
    },
    {
      key: 'promptField',
      label: t('promptFieldLabel'),
      component: FormItemComponent.FieldSelect,
      props: { mode: 'single', supportTypes: [FieldType.Text] },
      validator: { required: true },
    },
    {
      key: 'refImageField',
      label: t('refFieldLabel'),
      component: FormItemComponent.FieldSelect,
      // FieldSelect 的 props 只有 mode 和 supportTypes，placeholder 会报 TS2322
      props: { mode: 'multiple', supportTypes: [FieldType.Attachment] },
      validator: { required: false },
      tooltips: { title: t('refFieldTip') },
    },
    {
      key: 'size',
      label: t('sizeLabel'),
      component: FormItemComponent.SingleSelect,
      props: {
        defaultValue: 'auto',
        options: [
          { key: 'auto', title: t('sizeAuto') },
          { key: '1024x1024', title: '1024x1024' },
          { key: '1024x1536', title: '1024x1536 (portrait)' },
          { key: '1536x1024', title: '1536x1024 (图片-横)' },
          { key: '480p', title: '480p (视频-省)' },
          { key: '720p', title: '720p (视频-默认)' },
          { key: '1080p', title: '1080p (视频-高清)' },
        ],
      },
      validator: { required: true },
      tooltips: { title: t('sizeTip') },
    },
    {
      key: 'responseFormat',
      label: t('fmtLabel'),
      component: FormItemComponent.SingleSelect,
      props: {
        defaultValue: 'url',
        options: [
          { key: 'url', title: t('fmtUrl') },
          { key: 'none', title: t('fmtNone') },
        ],
      },
      validator: { required: true },
    },
    {
      key: 'videoProtocol',
      label: t('protoLabel'),
      component: FormItemComponent.SingleSelect,
      props: {
        defaultValue: 'auto',
        options: [
          { key: 'auto', title: t('protoAuto') },
          { key: 'sora', title: t('protoSora') },
          { key: 'bailian', title: t('protoBailian') },
        ],
      },
      validator: { required: true },
    },
    {
      key: 'videoDuration',
      label: t('durLabel'),
      component: FormItemComponent.SingleSelect,
      props: {
        defaultValue: '5',
        options: [
          { key: '3', title: '3s' },
          { key: '5', title: '5s' },
          { key: '10', title: '10s' },
        ],
      },
      validator: { required: true },
    },
  ],

  resultType: {
    type: FieldType.Attachment,
  },

  execute: async (context, formData) => {
    // ---- 校验配置 ----
    const baseUrlRaw = (String(formData.baseUrl || '').trim()) || DEFAULT_BASE_URL;
    let target: URL;
    try {
      target = new URL(baseUrlRaw.replace(/\/+$/, '') + '/');
    } catch {
      // 用户填的 Base URL 不合法
      return { code: FieldExecuteCode.ConfigError, msg: `invalid baseUrl: ${baseUrlRaw}` };
    }
    if (!isHostWhitelisted(target.hostname)) {
      return {
        code: FieldExecuteCode.ConfigError,
        msg: `domain not in whitelist: ${target.hostname}`,
        extra: { host: target.hostname, whitelist: WHITELIST.join(', ') },
      };
    }
    const model = String(formData.model || '').trim();
    if (!model) {
      return { code: FieldExecuteCode.ConfigError, msg: 'model is empty' };
    }

    // ---- 校验行数据 ----
    const prompt = String(formData.promptField ?? '').trim();
    if (!prompt) {
      // 配置合法，但该行数据没法处理
      return { code: FieldExecuteCode.InvalidArgument, msg: 'prompt text is empty' };
    }

    // 多选附件字段时 formData.refImageField 是 Array<Array<Attachment>>（每个元素一个字段），
    // 单选/旧配置时是 Array<Attachment>；统一摊平并按 tmp_url 去重，保持勾选顺序
    const rawRef = formData.refImageField;
    const refAttachments: any[] = [];
    const seen = new Set<string>();
    const pushAtt = (att: any) => {
      if (!att || typeof att !== 'object') return;
      const key = String(att.tmp_url || att.name || '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      refAttachments.push(att);
    };
    if (Array.isArray(rawRef)) {
      for (const entry of rawRef) {
        if (Array.isArray(entry)) entry.forEach(pushAtt);
        else pushAtt(entry);
      }
    }
    // ---- 视频分支：不下载附件（把参考图的临时链接直接交给支持图生视频的模型） ----
    if (String(formData.outputType || 'image') === 'video') {
      const firstImg = refAttachments.find((a: any) => isImageAttachment(a) && a.tmp_url);
      return await executeVideo(context, formData, target, String(firstImg?.tmp_url || ''));
    }

    let images: ReferenceImage[] = [];
    try {
      images = await loadReferenceImages(context, refAttachments);
    } catch (e) {
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'ref_download_error',
        extra: { logId: context.logId, reason: String((e as Error)?.message ?? e) },
      };
    }
    if (refAttachments.length > 0 && images.length === 0) {
      return { code: FieldExecuteCode.InvalidArgument, msg: 'reference field has no image attachment' };
    }

    // ---- 组装请求 ----
    const withFormat = formData.responseFormat !== 'none';
    let url: string;
    let headers: Record<string, string>;
    let body: string | Buffer;

    if (images.length > 0) {
      // 图生图：/images/edits（multipart/form-data）
      url = new URL('images/edits', target).toString();
      const boundary = makeBoundary();
      const fields: Array<[string, string]> = [['model', model], ['prompt', prompt]];
      if (formData.size && formData.size !== 'auto') fields.push(['size', String(formData.size)]);
      if (withFormat) fields.push(['response_format', 'url']);
      body = buildMultipartBody(fields, images, boundary);
      headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    } else {
      // 文生图：/images/generations（JSON）
      url = new URL('images/generations', target).toString();
      const payload: Record<string, string> = { model, prompt };
      if (formData.size && formData.size !== 'auto') payload.size = String(formData.size);
      if (withFormat) payload.response_format = 'url';
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }

    // ---- 调用外部 API ----
    let response: any;
    try {
      response = await tolerantFetch(context, url, { method: 'POST', headers, body }, 'image_api_key');
    } catch (e) {
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'api_error',
        extra: { logId: context.logId, stage: 'network', reason: String((e as Error)?.message ?? e) },
      };
    }

    if (!response.ok) {
      const status = response.status as number;
      let text = '';
      try {
        text = (await response.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      if (status === 401 || status === 403) {
        return { code: FieldExecuteCode.AuthorizationError, msg: `http ${status}: ${text}` };
      }
      if (status === 429) {
        return { code: FieldExecuteCode.RateLimit, msg: `http 429: ${text}` };
      }
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'api_error',
        extra: { logId: context.logId, httpStatus: status, response: text, endpoint: url },
      };
    }

    // ---- 解析结果 ----
    let json: any;
    try {
      json = await response.json();
    } catch (e) {
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'api_error',
        extra: { logId: context.logId, stage: 'parse', reason: 'response is not json' },
      };
    }

    const item = Array.isArray(json?.data) ? json.data[0] : undefined;
    const imageUrl: string | undefined = item?.url;
    if (!imageUrl) {
      // 很多模型（如 gpt-image-1）只返回 b64_json，而附件字段要求公开可访问的 URL
      return {
        code: FieldExecuteCode.Error,
        errorMessage: 'need_public_url',
        extra: {
          logId: context.logId,
          model,
          returnedKeys: Object.keys(item || json || {}).join(','),
          hasB64: Boolean(item?.b64_json),
        },
      };
    }

    const extMatch = imageUrl.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    return {
      code: FieldExecuteCode.Success,
      data: [
        {
          fileName: `ai-image-${Date.now()}.${ext}`,
          type: 'image',
          url: imageUrl,
        },
      ],
    };
  },
});

export default fieldDecoratorKit;
