#!/usr/bin/env bash
# 构建 Rust 中间件到 native/target/release/nw-constrain[.exe]，并复制到 lib/native/。
#
# 为什么单独一步：DSH 插件的宿主半是 JS，原生件是**可选加速层**。
# 编译失败不该挡住插件安装——安装照常，面板显示只读降级
# （`/api/neural-workflow/graph` 会带 degraded 与原因）。
#
# 工具链：Windows 上默认的 `*-msvc` 需要 Visual Studio C++ build tools；
# 没有时退回 `*-gnu`（只需 MinGW）。可用 NW_TOOLCHAIN 强制指定。
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${NW_TARGET:-}"
TOOLCHAIN="${NW_TOOLCHAIN:-}"

# 未显式指定时，Windows 上先看 msvc 能不能用，不能就用 gnu。
if [ -z "$TOOLCHAIN" ] && command -v rustup >/dev/null 2>&1; then
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      if rustup toolchain list 2>/dev/null | grep -q '^stable-x86_64-pc-windows-gnu'; then
        TOOLCHAIN="stable-x86_64-pc-windows-gnu"
      fi
      ;;
  esac
fi

CARGO=(cargo)
if [ -n "$TOOLCHAIN" ]; then CARGO=(cargo "+$TOOLCHAIN"); fi

echo "native: ${CARGO[*]} build --release ${TARGET:+--target $TARGET}"
if [ -n "$TARGET" ]; then
  "${CARGO[@]}" build --release --target "$TARGET"
  OUT="target/$TARGET/release"
else
  "${CARGO[@]}" build --release
  OUT="target/release"
fi

BIN="nw-constrain"
if [ -f "$OUT/nw-constrain.exe" ]; then BIN="nw-constrain.exe"; fi

mkdir -p ../lib/native
cp "$OUT/$BIN" ../lib/native/
chmod +x "../lib/native/$BIN" 2>/dev/null || true
echo "native: 已复制到 lib/native/$BIN"

# 契约自检：二进制自己能证明它和 PROTOCOL.md 一致。
printf '%s\n' '{"id":"1","op":"selftest"}' | "../lib/native/$BIN"
