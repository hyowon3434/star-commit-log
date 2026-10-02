import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = message => { throw new Error(message); };
const json = async p => JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {encoding:'utf8', maxBuffer:32*1024*1024, windowsHide:true}).trimEnd();
}
function within(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) fail('Path escapes project: ' + relative);
  return target;
}
export async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), {recursive:true});
  const temp = target + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, data, {flag:'wx'}); await fs.rename(temp, target); }
  finally { await fs.rm(temp, {force:true}).catch(()=>{}); }
}
async function saveJson(p, data) { await atomicWrite(p, JSON.stringify(data, null, 2) + '\n'); }
export async function locked(root, operation) {
  const dir = path.join(root, '.star-log');
  await fs.mkdir(dir, {recursive:true});
  const lock = path.join(dir, 'write.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch(e) { if(e.code==='EEXIST') fail('STAR log is locked. Verify the PID in ' + lock + ' before removing a stale lock.'); throw e; }
  try {
    await handle.writeFile(JSON.stringify({pid:process.pid, created:new Date().toISOString()}));
    return await operation();
  } finally { await handle.close(); await fs.unlink(lock); }
}
export async function context(start=process.cwd()) {
  let root = path.resolve(start);
  while (!(await exists(path.join(root, '.star-log/config.json')))) {
    const parent = path.dirname(root);
    if(parent===root) fail('No .star-log/config.json found. Run init for this project first.');
    root = parent;
  }
  const config = await json(path.join(root, '.star-log/config.json'));
  if(config.version!==1 || !config.projectId || !Array.isArray(config.repositories) || !config.repositories.length) fail('Invalid STAR configuration');
  new Intl.DateTimeFormat('en', {timeZone:config.timezone}).format();
  const ids = new Set();
  for(const repo of config.repositories) {
    if(!repo.id || ids.has(repo.id)) fail('Duplicate/missing repository ID');
    ids.add(repo.id); within(root, repo.path);
  }
  return {root, config, historyPath:within(root,config.history), workbookPath:within(root,config.workbook)};
}
async function readHistory(ctx) {
  if(!(await exists(ctx.historyPath))) return {version:1, projectId:ctx.config.projectId, tasks:[], excluded:[]};
  const data = await json(ctx.historyPath);
  if(data.version!==1 || data.projectId!==ctx.config.projectId || !Array.isArray(data.tasks) || !Array.isArray(data.excluded)) fail('Invalid history/project identity');
  return data;
}
export async function init(root, options={}) {
  root = path.resolve(root);
  return locked(root, async()=>{
    const configPath = path.join(root,'.star-log/config.json');
    let config;
    if(await exists(configPath)) config = await json(configPath);
    else {
      const seen = new Set();
      const repositories = (options.repos || ['.']).map(relative=>{
        const absolute = within(root,relative);
        const top = path.resolve(git(absolute,'rev-parse','--show-toplevel'));
        if(top.toLowerCase()!==absolute.toLowerCase()) fail('Repository path must be its Git root: ' + relative);
        if(seen.has(top.toLowerCase())) fail('Duplicate repository path');
        seen.add(top.toLowerCase());
        return {id:'repo-'+randomUUID(), path:path.relative(root,top).split(path.sep).join('/') || '.'};
      });
      config = {version:1,projectId:randomUUID(),name:options.name || path.basename(root),repositories,
        history:'.star-log/history.json',workbook:'docs/task-history/STAR-작업이력.xlsx',
        language:options.language || 'ko',timezone:options.timezone || 'Asia/Seoul',initialMonths:6};
      new Intl.DateTimeFormat('en',{timeZone:config.timezone}).format();
      await saveJson(configPath,config);
    }
    const agents = path.join(root,'AGENTS.md');
    const old = await exists(agents) ? await fs.readFile(agents,'utf8') : '';
    const marker = '<!-- star-commit-log:start -->';
    if(!old.includes(marker)) {
      const skill = path.resolve(here,'../SKILL.md').split(path.sep).join('/');
      const block = '\n\n'+marker+'\n## STAR commit records\n\n'
        +'For this configured project, read [star-commit-log]('+skill+') before creating an authorized Git commit. '
        +'After each successful Codex-created commit, update the project STAR history and Excel using .star-log/config.json. '
        +'Use one Task ID per user request across repositories; retain it for follow-up commits. '
        +'Do not record uncommitted work or user-created commits except during explicitly requested historical backfills. '
        +'Leave quantitative results blank without evidence; distinguish measured results from commit-message claims. '
        +'Retry pending workbook export on the next skill run. Report logging failures separately from commit success. '
        +'Do not commit records or push automatically. This instruction does not authorize additional commits.\n'
        +'<!-- star-commit-log:end -->\n';
      await atomicWrite(agents,old+block);
    }
    return config;
  });
}
function repoPath(ctx,id) {
  const repo = ctx.config.repositories.find(r=>r.id===id);
  if(!repo) fail('Unregistered repository: '+id);
  return within(ctx.root,repo.path);
}
function primeCommits(ctx) {
  if(ctx.commitCache) return;
  ctx.commitCache=new Map();
  for(const repo of ctx.config.repositories) {
    const records=git(repoPath(ctx,repo.id),'log','--branches','--remotes','--format=%x1e%H%x00%cI%x00%aI%x00%an%x00%s%x00%b%x00%P').split('\x1e').filter(s=>s.trim());
    for(const record of records) {
      const [sha,date,authorDate,author,subject,body,parents]=record.split('\0');
      const c={repoId:repo.id,sha:sha.trim(),date,authorDate,author,subject,body:body.trim(),parents:parents.trim()?parents.trim().split(' '):[]};
      ctx.commitCache.set(repo.id+':'+c.sha,c);
    }
  }
}
export function commitInfo(ctx,id,sha) {
  if(!/^[a-f0-9]{7,64}$/i.test(sha || '')) fail('Invalid commit SHA');
  const cached=ctx.commitCache?.get(id+':'+sha);
  if(cached) return cached;
  const text = git(repoPath(ctx,id),'show','-s','--format=%H%x00%cI%x00%aI%x00%an%x00%s%x00%b%x00%P',sha+'^{commit}');
  const [full,date,authorDate,author,subject,body,parents] = text.split('\0');
  return {repoId:id,sha:full,date,authorDate,author,subject,body:body.trim(),parents:parents ? parents.split(' ') : []};
}
const key = c => c.repoId+':'+c.sha;
const fields = ['title','situation','task','action','quantitative','qualitative','evidence'];
export async function upsertData(ctx,input) {
  primeCommits(ctx);
  const data = await readHistory(ctx);
  const owners = new Map(data.tasks.flatMap(t=>t.commits.map(c=>[key(c),t.id])));
  const inputIds = new Set();
  for(const proposed of input.tasks || []) {
    if(!/^[\w.-]+$/.test(proposed.id || '') || inputIds.has(proposed.id)) fail('Invalid/duplicate Task ID');
    inputIds.add(proposed.id);
    for(const f of fields) if(typeof proposed[f]!=='string' || (f!=='quantitative' && !proposed[f].trim())) fail('Missing text field: '+f);
    if(proposed.quantitative.trim() && !(typeof proposed.quantitativeEvidence==='string' && proposed.quantitativeEvidence.trim())) fail('Quantitative result requires quantitativeEvidence');
    if(!Array.isArray(proposed.commits) || !proposed.commits.length) fail('A task requires successful commits');
    const index = data.tasks.findIndex(t=>t.id===proposed.id);
    const previous = index<0 ? null : data.tasks[index];
    const commits = new Map((previous?.commits || []).map(c=>[key(c),c]));
    for(const ref of proposed.commits) {
      if(!['codex-commit','historical-git','historical-git-and-conversation'].includes(ref.source)) fail('Invalid provenance source');
      const c = {...commitInfo(ctx,ref.repoId,ref.sha),source:ref.source};
      const owner = owners.get(key(c));
      if(owner && owner!==proposed.id) fail('Commit already belongs to task '+owner);
      owners.set(key(c),proposed.id);
      if(!commits.has(key(c))) commits.set(key(c),c);
    }
    const task = {id:proposed.id,...Object.fromEntries(fields.map(f=>[f,proposed[f].trim()])),
      quantitativeEvidence:proposed.quantitative.trim() ? proposed.quantitativeEvidence.trim() : '',
      commits:[...commits.values()].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date))};
    if(index<0) data.tasks.push(task); else data.tasks[index]=task;
  }
  const excluded = new Map(data.excluded.map(c=>[key(c),c]));
  for(const ref of input.excluded || []) {
    const c = commitInfo(ctx,ref.repoId,ref.sha);
    if(owners.has(key(c))) fail('Cannot exclude an assigned task commit');
    if(typeof ref.reason!=='string' || !ref.reason.trim()) fail('Exclusion requires reason');
    excluded.set(key(c),{...c,reason:ref.reason});
  }
  for(const k of owners.keys()) excluded.delete(k);
  data.excluded = [...excluded.values()];
  data.tasks.sort((a,b)=>(Date.parse(a.commits[0].date)-Date.parse(b.commits[0].date)) || a.id.localeCompare(b.id));
  data.updatedAt = new Date().toISOString();
  await saveJson(ctx.historyPath,data);
  return data;
}
function day(date,timezone) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(date));
  const part = name => parts.find(p=>p.type===name).value;
  return part('year')+'-'+part('month')+'-'+part('day');
}
export function defaultSince(until,months=6) {
  const d = new Date(until+'T12:00:00Z'), original=d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()-months);
  const last = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(original,last)); return d.toISOString().slice(0,10);
}
export function collect(ctx,options={}) {
  const until = options.until || day(new Date(),ctx.config.timezone);
  const since = options.since || defaultSince(until,ctx.config.initialMonths);
  for(const date of [since,until]) if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) fail('Invalid date');
  if(since>until) fail('since must not exceed until');
  const result = {projectId:ctx.config.projectId,since,until,timezone:ctx.config.timezone,commits:[],mergeCandidates:[]};
  for(const repo of ctx.config.repositories) {
    const repoDir=repoPath(ctx,repo.id);
    const records=git(repoDir,'log','--branches','--remotes','--format=%x1e%H%x00%cI%x00%aI%x00%an%x00%s%x00%b%x00%P%x00','--stat').split('\x1e').filter(s=>s.trim());
    for(const record of records) {
      const [sha,dateStamp,authorDate,author,subject,body,parents,stat]=record.split('\0');
      const c={repoId:repo.id,sha:sha.trim(),date:dateStamp,authorDate,author,subject,body:body.trim(),parents:parents.trim()?parents.trim().split(' '):[],stat:(stat||'').trim().slice(0,12000)};
      const date=day(c.date,ctx.config.timezone);
      if(date<since || date>until) continue;
      (c.parents.length>1 ? result.mergeCandidates : result.commits).push(c);
    }
  }
  for(const list of [result.commits,result.mergeCandidates]) list.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  return result;
}
async function artifact(ctx) {
  const candidates = [process.env.STAR_LOG_ARTIFACT_MODULES,ctx.config.artifactModules,
    path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')].filter(Boolean);
  for(const modules of candidates) {
    try {
      const require = createRequire(path.join(path.resolve(modules),'__star_loader__.cjs'));
      const entry = require.resolve('@oai/artifact-tool');
      return await import(pathToFileURL(entry).href);
    } catch(e) { if(e.code!=='MODULE_NOT_FOUND' && e.code!=='ERR_MODULE_NOT_FOUND') throw e; }
  }
  fail('@oai/artifact-tool unavailable. Set STAR_LOG_ARTIFACT_MODULES to the runtime node_modules directory; history is preserved.');
}
function safe(value) { return typeof value==='string' && /^[=+@-]/.test(value) ? "'"+value : value; }
function excelDate(value,timezone) { return new Date(day(value,timezone)+'T00:00:00Z'); }
export function workbookTables(ctx,history) {
  const rows=history.tasks.map(t=>{
    const dates=t.commits.map(c=>c.date).sort((a,b)=>Date.parse(a)-Date.parse(b));
    const authors=[...new Set(t.commits.map(c=>(c.author || '').trim()).filter(Boolean))];
    return [authors.join('\n'),t.title,excelDate(dates[0],ctx.config.timezone),excelDate(dates.at(-1),ctx.config.timezone),
      t.situation,t.task,t.action,t.quantitative || null,t.qualitative,
      t.evidence+(t.quantitativeEvidence ? '\n정량 근거: '+t.quantitativeEvidence : '')].map(safe);
  });
  const commitRows=history.tasks.flatMap(t=>t.commits.map(c=>[t.id,ctx.config.repositories.find(r=>r.id===c.repoId).path,
    c.sha,excelDate(c.date,ctx.config.timezone),c.author,c.subject,c.source].map(safe)));
  return [
    {name:'작업 이력',headers:['사용자 ID','작업명','최초 커밋일','최근 커밋일','Situation · 배경','Task · 목표','Action · 실행','Result · 정량','Result · 정성','검증 근거'],rows,widths:[25,42,14,14,48,48,64,28,54,60],dates:[2,3],table:'StarTasks'},
    {name:'커밋 근거',headers:['Task ID','저장소','커밋 SHA','커밋일','작성자','커밋 메시지','근거 구분'],rows:commitRows,widths:[25,26,44,14,20,90,34],dates:[3],table:'StarCommits'}
  ];
}
export async function exportWorkbook(ctx,options={}) {
  const history = await readHistory(ctx);
  if(!history.tasks.length) fail('No committed tasks to export');
  const {Workbook,SpreadsheetFile}=await artifact(ctx);
  const wb=Workbook.create();
  const definitions = workbookTables(ctx,history);
  for(const def of definitions) {
    const sheet=wb.worksheets.add(def.name); sheet.showGridLines=false;
    const matrix=[def.headers,...def.rows],count=matrix.length;
    sheet.getRangeByIndexes(0,0,count,def.headers.length).values=matrix;
    const full=sheet.getRangeByIndexes(0,0,count,def.headers.length);
    full.format.fill='#FFFFFF'; full.format.font={name:'Arial',size:11,color:'#000000'}; full.format.wrapText=true; full.format.verticalAlignment='top';
    def.widths.forEach((width,i)=>{sheet.getRangeByIndexes(0,i,count,1).format.columnWidth=width;});
    const header=sheet.getRangeByIndexes(0,0,1,def.headers.length);
    header.format.fill='#D9D9D9'; header.format.font={name:'Arial',size:11,bold:true,color:'#000000'};header.format.rowHeight=30;
    for(const col of def.dates) sheet.getRangeByIndexes(1,col,def.rows.length,1).setNumberFormat('yyyy-mm-dd');
    for(let i=0;i<def.rows.length;i++) {
      const lines=Math.max(...def.rows[i].map((value,col)=>{
        if(typeof value!=='string') return 1;
        return value.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].reduce((n,ch)=>n+(ch.charCodeAt(0)>255?2:1),0)/(def.widths[col]-2))),0);
      }));
      sheet.getRangeByIndexes(i+1,0,1,def.headers.length).format.rowHeight=Math.min(409,Math.max(42,lines*16+10));
    }
    const last=String.fromCharCode(64+def.headers.length);
    const table=sheet.tables.add('A1:'+last+count,true,def.table); table.showFilterButton=true; table.style='TableStyleLight1';
    sheet.freezePanes.freezeRows(1);
  }
  const inspection=await wb.inspect({kind:'table',range:"'작업 이력'!A1:J3",tableMaxRows:3,tableMaxCols:10,maxChars:2000});
  if(options.previewDir) {
    await fs.mkdir(options.previewDir,{recursive:true});
    for(const [name,range,file] of [['작업 이력','A1:D4','tasks-identifiers'],['작업 이력','E1:J4','tasks-star'],['커밋 근거','A1:G4','commits']]) {
      const blob=await wb.render({sheetName:name,range,scale:1,format:'png'});
      await fs.writeFile(path.join(options.previewDir,file+'.png'),new Uint8Array(await blob.arrayBuffer()));
    }
  }
  await fs.mkdir(path.dirname(ctx.workbookPath),{recursive:true});
  const temp=ctx.workbookPath+'.'+randomUUID()+'.tmp.xlsx';
  try {
    const output=await SpreadsheetFile.exportXlsx(wb); await output.save(temp);
    await fs.rename(temp,ctx.workbookPath);
  } finally { await fs.rm(temp,{force:true}).catch(()=>{}); await fs.rm(temp+'.inspect.ndjson',{force:true}).catch(()=>{}); }
  return {tasks:history.tasks.length,commits:definitions[1].rows.length,workbook:ctx.workbookPath,inspection:inspection.ndjson};
}
export async function validate(ctx) {
  primeCommits(ctx);
  const data=await readHistory(ctx),ids=new Set(),commits=new Set();
  for(const t of data.tasks) {
    if(ids.has(t.id)) fail('Duplicate task ID'); ids.add(t.id);
    for(const f of fields) if(typeof t[f]!=='string' || (f!=='quantitative'&&!t[f].trim())) fail('Invalid task field: '+f);
    if(t.quantitative && !t.quantitativeEvidence) fail('Missing quantitative evidence');
    if(!t.commits.length) fail('Empty task');
    for(const c of t.commits) {
      if(commits.has(key(c))) fail('Duplicate commit mapping'); commits.add(key(c));
      if(commitInfo(ctx,c.repoId,c.sha).sha!==c.sha) fail('SHA not canonical');
    }
  }
  const excluded=new Set();
  for(const c of data.excluded) {
    if(commits.has(key(c))||excluded.has(key(c))) fail('Duplicate exclusion');
    if(!c.reason) fail('Missing exclusion reason');
    commitInfo(ctx,c.repoId,c.sha); excluded.add(key(c));
  }
  return {tasks:ids.size,commits:commits.size,excluded:excluded.size,workbookExists:await exists(ctx.workbookPath)};
}
export async function main(argv=process.argv.slice(2)) {
  const [command,...rest]=argv,options={};
  for(let i=0;i<rest.length;i+=2) {
    if(!rest[i].startsWith('--') || rest[i+1]===undefined) fail('Expected --option value');
    options[rest[i].slice(2)]=rest[i+1];
  }
  const start=options.project || process.cwd();
  if(command==='init') return init(start,{...options,repos:options.repos?.split(',').map(p=>p.trim())});
  const ctx=await context(start);
  if(command==='collect') {
    const result=collect(ctx,options);
    if(options.out) {await saveJson(path.resolve(options.out),result);return {commits:result.commits.length,mergeCandidates:result.mergeCandidates.length,output:path.resolve(options.out)};}
    return result;
  }
  if(command==='validate') return validate(ctx);
  if(command==='export') return locked(ctx.root,()=>exportWorkbook(ctx,{previewDir:options['preview-dir']}));
  if(command==='upsert') {
    if(!options.input) fail('--input is required');
    const input=await json(path.resolve(options.input));
    return locked(ctx.root,async()=>{
      const data=await upsertData(ctx,input);
      try {return await exportWorkbook(ctx,{previewDir:options['preview-dir']});}
      catch(e) {throw new Error('History saved ('+data.tasks.length+' tasks); workbook export pending: '+e.message);}
    });
  }
  fail('Commands: init, collect, upsert, export, validate');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
