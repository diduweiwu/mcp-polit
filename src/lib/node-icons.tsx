/**
 * 资源树节点自定义图标注册表：key -> lucide 图标组件。
 *
 * key 持久化到数据库 tree_nodes.icon 列，并随同步目录的 tree.json 分发（跨设备恢复）。
 * key 集合只增不改名；旧数据/新仓库里出现未知 key 时查表返回 undefined，调用方回退默认图标，
 * 绝不因未知 key 报错或丢节点。
 */
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  Box,
  BrainCircuit,
  Briefcase,
  Bug,
  Building2,
  Calculator,
  Camera,
  Cloud,
  Code,
  Coffee,
  Compass,
  Cpu,
  Database,
  Film,
  FileText,
  Fingerprint,
  Flag,
  Gamepad2,
  GitBranch,
  Globe,
  HardDrive,
  Heart,
  Image,
  KeyRound,
  Layers,
  Lightbulb,
  Link,
  Lock,
  Mail,
  Map as MapIcon,
  MessageSquare,
  Music,
  Package,
  Puzzle,
  Rocket,
  Search,
  Send,
  Server,
  Shield,
  Sparkles,
  Star,
  Terminal,
  Users,
  Video,
  Wifi,
  Wrench,
  Zap,
} from "lucide-react";

/** 单个可选图标的定义 */
export interface NodeIconDef {
  /** 持久化 key（数据库 / tree.json 存储，只增不改名） */
  key: string;
  /** 中文语义名（选择器悬浮提示用） */
  label: string;
  /** lucide 图标组件 */
  Icon: LucideIcon;
}

/** 可选图标全集（按语义分组排列，选择器网格顺序即此顺序） */
export const NODE_ICONS: NodeIconDef[] = [
  { key: "database", label: "数据库", Icon: Database },
  { key: "cloud", label: "云服务", Icon: Cloud },
  { key: "globe", label: "网络", Icon: Globe },
  { key: "server", label: "服务器", Icon: Server },
  { key: "terminal", label: "终端", Icon: Terminal },
  { key: "hard-drive", label: "磁盘", Icon: HardDrive },
  { key: "wifi", label: "无线", Icon: Wifi },
  { key: "link", label: "链接", Icon: Link },
  { key: "bot", label: "机器人", Icon: Bot },
  { key: "brain-circuit", label: "AI", Icon: BrainCircuit },
  { key: "cpu", label: "芯片", Icon: Cpu },
  { key: "zap", label: "闪电", Icon: Zap },
  { key: "sparkles", label: "魔法", Icon: Sparkles },
  { key: "code", label: "代码", Icon: Code },
  { key: "git-branch", label: "分支", Icon: GitBranch },
  { key: "bug", label: "调试", Icon: Bug },
  { key: "wrench", label: "工具", Icon: Wrench },
  { key: "package", label: "包", Icon: Package },
  { key: "layers", label: "图层", Icon: Layers },
  { key: "box", label: "盒子", Icon: Box },
  { key: "key-round", label: "密钥", Icon: KeyRound },
  { key: "lock", label: "锁", Icon: Lock },
  { key: "shield", label: "安全", Icon: Shield },
  { key: "fingerprint", label: "指纹", Icon: Fingerprint },
  { key: "mail", label: "邮件", Icon: Mail },
  { key: "message-square", label: "消息", Icon: MessageSquare },
  { key: "send", label: "发送", Icon: Send },
  { key: "book-open", label: "文档", Icon: BookOpen },
  { key: "file-text", label: "文件", Icon: FileText },
  { key: "briefcase", label: "工作", Icon: Briefcase },
  { key: "building-2", label: "组织", Icon: Building2 },
  { key: "users", label: "团队", Icon: Users },
  { key: "calculator", label: "计算器", Icon: Calculator },
  { key: "camera", label: "相机", Icon: Camera },
  { key: "image", label: "图片", Icon: Image },
  { key: "music", label: "音乐", Icon: Music },
  { key: "video", label: "视频", Icon: Video },
  { key: "film", label: "影视", Icon: Film },
  { key: "rocket", label: "火箭", Icon: Rocket },
  { key: "star", label: "星标", Icon: Star },
  { key: "heart", label: "喜爱", Icon: Heart },
  { key: "flag", label: "旗帜", Icon: Flag },
  { key: "lightbulb", label: "灵感", Icon: Lightbulb },
  { key: "puzzle", label: "扩展", Icon: Puzzle },
  { key: "gamepad-2", label: "游戏", Icon: Gamepad2 },
  { key: "map", label: "地图", Icon: MapIcon },
  { key: "compass", label: "指南针", Icon: Compass },
  { key: "coffee", label: "咖啡", Icon: Coffee },
  { key: "search", label: "搜索", Icon: Search },
];

/** key -> 定义索引（查表渲染用） */
const byKey = new Map(NODE_ICONS.map((d) => [d.key, d]));

/**
 * 按 key 查图标定义；未注册（旧数据 / 后续版本移除）返回 undefined，调用方回退默认图标。
 *
 * @example
 * const def = nodeIconByKey(node.icon); // undefined = 用默认图标
 */
export function nodeIconByKey(key?: string | null): NodeIconDef | undefined {
  return key ? byKey.get(key) : undefined;
}

/**
 * 随机取一个图标定义（「一键随机」按钮用）。
 *
 * @example
 * const def = randomNodeIcon(); // { key: "rocket", ... }
 */
export function randomNodeIcon(): NodeIconDef {
  return NODE_ICONS[Math.floor(Math.random() * NODE_ICONS.length)];
}
