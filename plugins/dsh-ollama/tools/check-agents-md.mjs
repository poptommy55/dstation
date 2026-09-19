import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const HOME = process.env.DSH_HOME;
function dec(buf){const M=[0x28,0xb5,0x2f,0xfd];const s=[];for(let i=0;i+3<buf.length;i++)if(buf[i]===M[0]&&buf[i+1]===M[1]&&buf[i+2]===M[2]&&buf[i+3]===M[3])s.push(i);if(!s.length)return buf.toString("utf8");const p=[];for(let k=0;k<s.length;k++){const e=k+1<s.length?s[k+1]:buf.length;try{p.push(zlib.zstdDecompressSync(buf.subarray(s[k],e)).toString("utf8"))}catch{}}return p.join("")}
function walk(d,a=[]){let l=[];try{l=fs.readdirSync(d,{withFileTypes:true})}catch{return a}for(const e of l){const f=path.join(d,e.name);if(e.isDirectory())walk(f,a);else if(e.name==="session.jsonl.zstd")a.push({file:f,mtime:fs.statSync(f).mtimeMs})}return a}
const all=walk(path.join(HOME,"sessions")).sort((a,b)=>b.mtime-a.mtime);
const t=dec(fs.readFileSync(all[0].file));
console.log("会话:", path.basename(path.dirname(all[0].file)));
for (const [label, needle] of [["AGENTS.md 标题","# AGENTS.md"],["用户全局指令正文","能力事实"],["ACES 字样","ACES"],["技能目录","available_skills"],["当前日期","Current date"],["skills 清单标记","skill-specialist"]]) {
  console.log(`  ${label.padEnd(18)}: ${t.includes(needle) ? "出现在会话记录中 ✅" : "未出现"}`);
}
