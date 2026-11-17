#!/usr/bin/env bash
# MCPilot 发版脚本：提升版本号 → 提交 → 打 tag → 推送触发 CI 打包
#
# 用法：
#   ./scripts/release.sh patch          # 0.1.2 -> 0.1.3
#   ./scripts/release.sh minor          # 0.1.2 -> 0.2.0
#   ./scripts/release.sh major          # 0.1.2 -> 1.0.0
#   ./scripts/release.sh 0.2.1          # 直接指定版本号（可带 v 前缀，如 v0.2.1）
#   ./scripts/release.sh --dry-run patch  # 只预览将执行的改动，不落盘、不提交、不推送
#
# 动作：
#   1. 同步四处版本号：package.json / src-tauri/tauri.conf.json /
#      src-tauri/Cargo.toml / src-tauri/Cargo.lock
#   2. 提交版本号（chore: bump 版本 x.y.z）并打 tag vX.Y.Z
#   3. 推送 master 与 tag → 触发 GitHub Actions 三平台打包 + Release + 在线更新 latest.json
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "用法：./scripts/release.sh [--dry-run] patch|minor|major|X.Y.Z"
  exit 1
}

# ---------- 参数解析 ----------
DRY_RUN=0
BUMP=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) usage ;;
    *) [ -z "$BUMP" ] || usage; BUMP="$arg" ;;
  esac
done
[ -n "$BUMP" ] || usage

# ---------- 前置检查 ----------
if [ -n "$(git status --porcelain)" ]; then
  echo "!! 工作区有未提交的改动，请先提交或暂存（git status）："
  git status --short
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "master" ]; then
  echo "!! 当前分支不是 master，发版请在 master 上执行"
  exit 1
fi

# ---------- 读取当前版本并计算新版本 ----------
CURRENT="$(node -p "require('./package.json').version")"

# 计算新版本（patch/minor/major 递增；指定版本号时直接采用）
case "$BUMP" in
  patch | minor | major)
    IFS='.' read -r MA MI PA <<< "$CURRENT"
    case "$BUMP" in
      patch) PA=$((PA + 1)) ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
    esac
    NEW="${MA}.${MI}.${PA}"
    ;;
  *)
    NEW="${BUMP#v}"
    case "$NEW" in
      *.*) : ;;
      *) echo "!! 版本号格式不对：$BUMP（应为 patch|minor|major 或 X.Y.Z）"; exit 1 ;;
    esac
    ;;
esac

TAG="v$NEW"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "!! 标签 $TAG 已存在，换个版本号或先删除旧标签"
  exit 1
fi

# 点号转义，供 sed 精确匹配当前版本字符串
CURRENT_RE="$(printf '%s' "$CURRENT" | sed 's/\./\\./g')"

# 跨平台原地替换：GNU sed 用 -i，BSD/macOS sed 用 -i ''
sed_inplace() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

# 替换单个文件中的版本号；替换后校验新版本已存在，失败立即退出（set -e 兜底）
replace_version() {
  local file="$1" sed_expr="$2"
  if ! grep -q "$CURRENT_RE" "$file"; then
    echo "!! $file 中找不到当前版本 $CURRENT，中止"
    exit 1
  fi
  sed_inplace "$sed_expr" "$file"
  if ! grep -q "$NEW" "$file"; then
    echo "!! $file 替换后未找到新版本 $NEW，请手动检查"
    exit 1
  fi
  echo "    updated $file: $CURRENT -> $NEW"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> [dry-run] version $CURRENT -> $NEW ($TAG)"
  echo "    package.json:              \"version\": \"$NEW\""
  echo "    src-tauri/tauri.conf.json: \"version\": \"$NEW\""
  echo "    src-tauri/Cargo.toml:      version = \"$NEW\""
  echo "    src-tauri/Cargo.lock:      mcpilot block version = \"$NEW\""
  echo "    git commit: chore: bump version $NEW"
  echo "    git push origin master && git push origin $TAG"
  exit 0
fi

# ---------- 更新四处版本号 ----------
echo "==> version $CURRENT -> $NEW"
# JSON 顶层版本（两文件中当前版本字符串仅出现一次，普通替换安全）
replace_version package.json "s/\"version\": \"${CURRENT_RE}\"/\"version\": \"${NEW}\"/"
replace_version src-tauri/tauri.conf.json "s/\"version\": \"${CURRENT_RE}\"/\"version\": \"${NEW}\"/"
# Cargo.toml 的 [package] version（文件中唯一）
replace_version src-tauri/Cargo.toml "s/^version = \"${CURRENT_RE}\"/version = \"${NEW}\"/"
# Cargo.lock 的 mcpilot 块：定位 name = "mcpilot" 的下一行
LOCK_LINE="$(grep -n 'name = "mcpilot"' src-tauri/Cargo.lock | head -1 | cut -d: -f1)"
if [ -z "$LOCK_LINE" ]; then
  echo "!! Cargo.lock 中找不到 mcpilot 块，请先跑一次 cargo check 生成"
  exit 1
fi
replace_version src-tauri/Cargo.lock "${LOCK_LINE}s/version = \"${CURRENT_RE}\"/version = \"${NEW}\"/"

# ---------- 提交、打 tag、推送 ----------
echo "==> commit & tag $TAG"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version $NEW"
git tag "$TAG"

echo "==> push master + $TAG (triggers GitHub Actions build)"
git push origin master
git push origin "$TAG"

echo "==> done: $TAG pushed. See Actions page for build progress."
