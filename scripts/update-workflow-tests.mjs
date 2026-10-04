import fs from 'node:fs';
const files=['scripts/e2e.mjs','scripts/creator-e2e.mjs','scripts/creator-recovery-smoke.mjs','scripts/installed-smoke.mjs','scripts/transcription-e2e.mjs'];
for(const file of files){let text=fs.readFileSync(file,'utf8').replaceAll("name: '新建下载'","name: '链接下载'").replaceAll("name: '博主作品'","name: '博主批量下载'").replaceAll("name: 'AI 与采集设置'","name: 'AI 模型设置'");if(file.includes('installed-smoke'))text=text.replace("initial.version, '0.3.0'","initial.version, '0.3.1'").replace("'AI 与采集设置'","'AI 模型设置'");fs.writeFileSync(file,text);}
