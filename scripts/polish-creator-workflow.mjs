import fs from 'node:fs';
import assert from 'node:assert/strict';
let text=fs.readFileSync('src/CreatorPage.jsx','utf8');
const range='<section className="panel creator-range">';assert.ok(text.includes(range));text=text.replace(range,'{(creator.supported || items.length > 0) && <>'+range);
const close='    </>}\n  </>;';assert.ok(text.includes(close));text=text.replace(close,'    </>}\n    </>}\n  </>;');
text=text.replace('<button className="text-button" onClick={() => accounts()}>管理登录</button>',"<button className=\"text-button\" onClick={() => source?.includes('weixin.qq.com') ? settings() : accounts()}>检查连接与登录</button>");
fs.writeFileSync('src/CreatorPage.jsx',text);
