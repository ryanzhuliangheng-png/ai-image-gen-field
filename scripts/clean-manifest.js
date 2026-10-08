/**
 * pack:field 后置清理脚本：
 * 1. 清理 manifest.json 中 domainLists 里的非字符串项（RegExp 序列化后变成 {}，正式发布会报错）
 * 2. 重新生成干净的 output/output.zip
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'output', 'output');
const manifestPath = path.join(outDir, 'manifest.json');
const zipPath = path.join(root, 'output', 'output.zip');

// 1. 清理 manifest 白名单
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (Array.isArray(manifest.domainLists)) {
  const before = manifest.domainLists.length;
  manifest.domainLists = manifest.domainLists.filter((d) => typeof d === 'string');
  console.log(`[clean-manifest] domainLists 清理: ${before} -> ${manifest.domainLists.length}`);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// 2. 重新打包 zip
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(outDir, false);
output.on('close', () => {
  console.log(`[clean-manifest] 发布包已生成: ${zipPath} (${archive.pointer()} bytes)`);
});
archive.finalize();
