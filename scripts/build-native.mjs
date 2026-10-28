#!/usr/bin/env node
/**
 * 原生件构建与回执（学 dsh-ops 的 runtime/<platform> 形态）。
 *
 *   node scripts/build-native.mjs
 *   → runtime/<platform>-<arch>/nw-constrain[.exe]
 *   → runtime/manifest.json { version, platform, arch, sha256, size, builtAt }
 *
 * 宿主解析顺序（lib/index.js locateBinary）：config.binaryPath → runtime/ → lib/native/（兼容）。
 * manifest 是**回执**：安装方可以用它核对拿到的二进制是不是构建出来的那一份。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binary = process.platform === 'win32' ? 'nw-constrain.exe' : 'nw-constrain'
const targetDir = join(root, 'runtime', `${process.platform}-${process.arch}`)
const source = join(root, 'native', 'target', 'release', binary)
const target = join(targetDir, binary)

if (!existsSync(source)) {
  console.error(`build-native: 未找到 ${source}；先跑 bash native/build.sh（Windows 无 MSVC 时它会自动回退 gnu 工具链）`)
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)

const stats = statSync(target)
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = {
  name: 'nw-constrain',
  version,
  platform: process.platform,
  arch: process.arch,
  sha256,
  size: stats.size,
  builtAt: new Date().toISOString(),
}
writeFileSync(join(root, 'runtime', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`build-native: ${binary} → runtime/${process.platform}-${process.arch}/（sha256 ${sha256.slice(0, 12)}…, ${stats.size} 字节）`)
