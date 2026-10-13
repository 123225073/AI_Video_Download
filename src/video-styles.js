// Vite replaces BASE_URL with './' for the packaged file:// workbench.
const previewBase = import.meta.env?.BASE_URL || './';
const preview = id => `${previewBase.replace(/\/?$/, '/')}video-styles/${id}.png`;

export const VIDEO_STYLES = [
  {
    id: 'cyberpunk',
    label: '赛博朋克',
    prompt: '赛博朋克画风：深色未来都市，蓝紫与玫红霓虹，高反差光影，金属与玻璃质感，带有科技感的细节；保持主体清晰、构图简洁，全组配图统一视觉风格。',
    preview: preview('cyberpunk'),
    description: '霓虹光影 · 未来科技',
    suitableFor: '科技趋势、未来想象',
  },
  {
    id: 'anime',
    label: '日系动漫',
    prompt: '日系动漫画风：清晰的二维线稿与赛璐璐色块，明亮通透的色彩，富有表现力的人物和电影感场景；保持主体清晰、构图简洁，全组配图统一视觉风格。',
    preview: preview('anime'),
    description: '二维线稿 · 明亮色块',
    suitableFor: '人物故事、青春日常',
  },
  {
    id: 'photo',
    label: '写实摄影',
    prompt: '写实摄影风格：真实的材质、比例与环境，自然光照，细腻的镜头景深和可信的生活细节，避免插画化与夸张滤镜；保持主体清晰、构图简洁，全组配图统一视觉风格。',
    preview: preview('photo'),
    description: '自然光线 · 真实材质',
    suitableFor: '生活记录、产品展示',
  },
  {
    id: 'clay3d',
    label: '黏土3D',
    prompt: '黏土3D画风：圆润的立体造型，手工黏土纹理与柔和哑光材质，温暖低饱和配色，柔软的棚拍光影和微缩模型感；保持主体清晰、构图简洁，全组配图统一视觉风格。',
    preview: preview('clay3d'),
    description: '圆润立体 · 手作质感',
    suitableFor: '轻松科普、亲子内容',
  },
  {
    id: 'infographic',
    label: '简洁信息图',
    prompt: '简洁信息图画风：浅色背景，扁平矢量图形，清楚的视觉层级，少量强调色与充足留白；根据内容使用图标、流程或对比布局，只展示有依据的信息，不编造数据，全组配图统一视觉风格。',
    preview: preview('infographic'),
    description: '扁平图形 · 清楚层级',
    suitableFor: '知识讲解、步骤对比',
  },
  {
    id: 'watercolor',
    label: '水彩手绘',
    prompt: '水彩手绘画风：轻透的水彩晕染，纸张肌理与自然笔触，柔和淡彩和舒展留白，营造温暖安静的氛围；保持主体清晰、构图简洁，全组配图统一视觉风格。',
    preview: preview('watercolor'),
    description: '淡彩晕染 · 纸感笔触',
    suitableFor: '旅行随笔、情感表达',
  },
  {
    id: 'retrocomic',
    label: '复古漫画',
    prompt: '复古漫画画风：粗黑轮廓线，复古印刷网点与纸张质感，红黄蓝等有限色彩，戏剧化构图和鲜明动作；保持主体清晰，避免无关文字与对白，全组配图统一视觉风格。',
    preview: preview('retrocomic'),
    description: '粗线网点 · 复古撞色',
    suitableFor: '趣味故事、观点表达',
  },
  {
    id: 'ink',
    label: '国风水墨',
    prompt: '国风水墨画风：宣纸质感，浓淡墨色与写意笔触，以黑白灰为主并少量点彩，讲究虚实层次、意境与留白；保持主体可辨、构图简洁，全组配图统一视觉风格。',
    preview: preview('ink'),
    description: '写意墨色 · 东方留白',
    suitableFor: '传统文化、山水诗意',
  },
];

// Special modes do not count toward the eight fixed visual styles.
export const VIDEO_STYLE_OPTIONS = [
  {
    id: 'auto',
    label: '自动参考原视频',
    prompt: '参考原视频的画面色彩、材质与整体氛围，结合内容选择协调的配图风格，全组配图保持一致。',
    preview: null,
    description: '根据原视频画面选择协调的风格',
  },
  ...VIDEO_STYLES,
  {
    id: 'custom',
    label: '自定义',
    prompt: '',
    preview: null,
    description: '使用你填写的画风描述',
  },
];
