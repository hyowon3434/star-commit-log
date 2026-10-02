import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {init,context,upsertData,locked,collect,validate,atomicWrite,defaultSince,main,workbookTables} from './star-log.mjs';

const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true}).trim();
async function fixture(t,n=1) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'star 한글 space-'));
  t.after(async()=>{const p=path.resolve(root); if(p.startsWith(path.resolve(os.tmpdir())+path.sep)) await fs.rm(p,{recursive:true,force:true});});
  const repos=[];
  for(let i=0;i<n;i++){
    const relative='repo '+i,dir=path.join(root,relative); await fs.mkdir(dir);
    git(dir,'init','-q');git(dir,'config','user.name','Test');git(dir,'config','user.email','test@example.invalid');
    await fs.writeFile(path.join(dir,'sample.txt'),'one');git(dir,'add','.');git(dir,'commit','-qm','initial');
    repos.push(relative);
  }
  await fs.writeFile(path.join(root,'AGENTS.md'),'Existing instructions\n');
  await init(root,{repos}); return {root,ctx:await context(root),repos};
}
function input(ctx,index=0,id='task-first') {
  const repo=ctx.config.repositories[index],dir=path.join(ctx.root,repo.path);
  return {tasks:[{id,title:'변경',situation:'확인된 배경',task:'목표',action:'실행',quantitative:'',
    qualitative:'변경 반영; 운영 결과 미확인',evidence:'테스트용 Git 근거',
    commits:[{repoId:repo.id,sha:git(dir,'rev-parse','HEAD'),source:'codex-commit'}]}]};
}
test('init is idempotent and preserves instructions; nearest config supports Unicode paths',async t=>{
  const {root,ctx,repos}=await fixture(t);await init(root,{repos});
  const content=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
  assert.ok(content.startsWith('Existing instructions'));
  assert.equal(content.split('<!-- star-commit-log:start -->').length,2);
  assert.equal((await context(path.join(root,repos[0]))).config.projectId,ctx.config.projectId);
});
test('repeat commits deduplicate and same request merges commits across repositories',async t=>{
  const {ctx}=await fixture(t,2);
  const first=input(ctx);await upsertData(ctx,first);await upsertData(ctx,first);
  await upsertData(ctx,input(ctx,1));
  const result=await validate(ctx);assert.equal(result.tasks,1);assert.equal(result.commits,2);
  const data=JSON.parse(await fs.readFile(ctx.historyPath));assert.equal(data.tasks[0].quantitative,'');
});
test('unrelated projects keep independent records',async t=>{
  const a=await fixture(t),b=await fixture(t);
  await upsertData(a.ctx,input(a.ctx));assert.equal((await validate(b.ctx)).tasks,0);
});
test('invalid commit does not alter confirmed history',async t=>{
  const {ctx}=await fixture(t);await upsertData(ctx,input(ctx));
  const before=await fs.readFile(ctx.historyPath,'utf8'),bad=input(ctx);
  bad.tasks[0].commits[0].sha='0000000000000000000000000000000000000000';
  await assert.rejects(()=>upsertData(ctx,bad));
  assert.equal(await fs.readFile(ctx.historyPath,'utf8'),before);
});
test('cross-task reassignment and unevidenced quantities are rejected atomically',async t=>{
  const {ctx}=await fixture(t);await upsertData(ctx,input(ctx));const before=await fs.readFile(ctx.historyPath,'utf8');
  await assert.rejects(()=>upsertData(ctx,input(ctx,0,'task-other')),/already belongs/);
  const measured=input(ctx);measured.tasks[0].quantitative='10초';
  await assert.rejects(()=>upsertData(ctx,measured),/quantitativeEvidence/);
  assert.equal(await fs.readFile(ctx.historyPath,'utf8'),before);
});
test('valid quantitative provenance is retained',async t=>{
  const {ctx}=await fixture(t),entry=input(ctx);entry.tasks[0].quantitative='10초 → 2초';
  entry.tasks[0].quantitativeEvidence='커밋 메시지에 기재된 수치; 재측정하지 않음';
  const data=await upsertData(ctx,entry);assert.equal(data.tasks[0].quantitative,'10초 → 2초');
});
test('concurrent writer is rejected and original lock remains until owner exits',async t=>{
  const {root}=await fixture(t);
  await locked(root,async()=>{await assert.rejects(()=>locked(root,()=>{}),/locked/);assert.ok(await fs.stat(path.join(root,'.star-log/write.lock')));});
  await assert.rejects(()=>fs.stat(path.join(root,'.star-log/write.lock')),/ENOENT/);
});
test('collect ignores stash, deduplicates refs and validates date window',async t=>{
  const {ctx,root,repos}=await fixture(t),dir=path.join(root,repos[0]);
  git(dir,'branch','copy');
  await fs.writeFile(path.join(dir,'sample.txt'),'stash change');git(dir,'stash','push','-qm','internal stash');
  const data=collect(ctx,{since:'2000-01-01',until:'2100-01-01'});
  assert.equal(data.commits.length,1);assert.equal(data.mergeCandidates.length,0);
  assert.throws(()=>collect(ctx,{since:'2026-02-30',until:'2026-10-02'}),/Invalid date/);
  assert.equal(defaultSince('2026-08-31',6),'2026-02-28');
});
test('exclusion is idempotent and can be promoted to a task',async t=>{
  const {ctx}=await fixture(t),entry=input(ctx),ref=entry.tasks[0].commits[0];
  await upsertData(ctx,{excluded:[{...ref,reason:'test exclusion'}]});
  await upsertData(ctx,{excluded:[{...ref,reason:'test exclusion'}]});
  assert.equal((await validate(ctx)).excluded,1);
  await upsertData(ctx,entry);assert.equal((await validate(ctx)).excluded,0);
});
test('path escape in configuration is rejected',async t=>{
  const {ctx,root}=await fixture(t);
  const config={...ctx.config,history:'../outside.json'};
  await fs.writeFile(path.join(root,'.star-log/config.json'),JSON.stringify(config));
  await assert.rejects(()=>context(root),/escapes/);
});
test('failed atomic replacement preserves destination and removes temporary files',async t=>{
  const {root}=await fixture(t),target=path.join(root,'occupied');
  await fs.mkdir(target);await fs.writeFile(path.join(target,'keep.txt'),'keep');
  await assert.rejects(()=>atomicWrite(target,'replacement'));
  assert.equal(await fs.readFile(path.join(target,'keep.txt'),'utf8'),'keep');
  assert.equal((await fs.readdir(root)).filter(n=>n.endsWith('.tmp')).length,0);
});
test('failed workbook export retains history and releases lock',async t=>{
  const {ctx,root}=await fixture(t),entry=input(ctx);
  const config={...ctx.config,workbook:'blocked.xlsx'};
  await fs.writeFile(path.join(root,'.star-log/config.json'),JSON.stringify(config));
  await fs.mkdir(path.join(root,'blocked.xlsx'));
  await fs.writeFile(path.join(root,'blocked.xlsx','keep'),'keep');
  const file=path.join(root,'input.json');await fs.writeFile(file,JSON.stringify(entry));
  await assert.rejects(()=>main(['upsert','--project',root,'--input',file]),/History saved/);
  assert.equal((await validate(await context(root))).tasks,1);
  await assert.rejects(()=>fs.stat(path.join(root,'.star-log/write.lock')),/ENOENT/);
});

test('commit ordering uses timestamps across different timezone offsets',async t=>{
  const {root,ctx,repos}=await fixture(t),dir=path.join(root,repos[0]);
  const dated=(date,args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true,env:{...process.env,GIT_COMMITTER_DATE:date,GIT_AUTHOR_DATE:date}});
  dated('2026-01-02T00:30:00+14:00',['commit','--amend','--no-edit','--date=2026-01-02T00:30:00+14:00']);
  const first=input(ctx);await upsertData(ctx,first);
  await fs.writeFile(path.join(dir,'sample.txt'),'two');git(dir,'add','.');
  dated('2026-01-01T23:00:00-12:00',['commit','-qm','follow-up']);
  const second=input(ctx);
  const result=await upsertData(ctx,second);
  assert.equal(result.tasks[0].commits[0].sha,first.tasks[0].commits[0].sha);
  assert.equal(result.tasks[0].commits[1].sha,second.tasks[0].commits[0].sha);
});

test('workbook columns use Git author names and preserve audit identifiers',()=>{
  const ctx={config:{timezone:'Asia/Seoul',repositories:[{id:'repo',path:'server'}]}};
  const task={id:'task-secret-id',title:'작업',situation:'배경',task:'목표',action:'실행',
    quantitative:'',qualitative:'결과',evidence:'근거',quantitativeEvidence:'',
    commits:[{repoId:'repo',sha:'abc1234',date:'2026-10-02T01:00:00Z',author:'작성자 A',subject:'변경',source:'codex-commit'}]};
  const [tasks,commits]=workbookTables(ctx,{tasks:[task]});
  assert.deepEqual(tasks.headers,['사용자 ID','작업명','최초 커밋일','최근 커밋일','Situation · 배경','Task · 목표','Action · 실행','Result · 정량','Result · 정성','검증 근거']);
  assert.equal(tasks.rows[0][0],'작성자 A');
  assert.equal(tasks.rows[0][7],null);
  assert.ok(tasks.rows[0][2] instanceof Date);
  assert.equal(tasks.rows[0].length,tasks.headers.length);
  assert.ok(!tasks.rows[0].includes('task-secret-id'));
  assert.equal(commits.rows[0][0],'task-secret-id');
  assert.equal(commits.rows[0][1],'server');
});
test('multiple Git authors are deduplicated within each task only',()=>{
  const ctx={config:{timezone:'Asia/Seoul',repositories:[{id:'repo',path:'.'}]}};
  const commit={repoId:'repo',sha:'abc1234',date:'2026-10-02T01:00:00Z',subject:'변경',source:'codex-commit'};
  const task={id:'task-a',title:'작업',situation:'배경',task:'목표',action:'실행',quantitative:'',qualitative:'결과',evidence:'근거'};
  const history={tasks:[{...task,commits:['작성자 A','작성자 B','작성자 A'].map(author=>({...commit,author}))},
    {...task,id:'task-b',commits:[{...commit,author:'작성자 A'}]}]};
  const [tasks]=workbookTables(ctx,history);
  assert.equal(tasks.rows[0][0],'작성자 A\n작성자 B');
  assert.equal(tasks.rows[1][0],'작성자 A');
});

test('successful workbook export returns counts and does not modify history',async t=>{
  const {ctx}=await fixture(t);
  await upsertData(ctx,input(ctx));
  const before=await fs.readFile(ctx.historyPath,'utf8');
  const result=await main(['export','--project',ctx.root]);
  assert.equal(result.tasks,1);
  assert.equal(result.commits,1);
  assert.ok((await fs.stat(ctx.workbookPath)).size>0);
  assert.equal(await fs.readFile(ctx.historyPath,'utf8'),before);
});
