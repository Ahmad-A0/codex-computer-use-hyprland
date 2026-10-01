// Build a private runtime overlay of the installed @oai/cua and @oai/sky packages.
//
// Upstream ships minified code whose local identifiers change on every rebuild,
// so this script depends only on what minification preserves: file paths, ES
// module import/export names, string literals, property names, and the .d.ts
// declarations. Installed files are never edited.
//   - @oai/cua tinysky_alt/bind_linux_app.js is replaced by our readable
//     scripts/runtime/bind_linux_app.js (macOS behaviour of the App methods).
//   - Sky's Linux targets/linux/create_client.js (@oai/cua's bundled copy and
//     @oai/sky's) is generated from the create_<command> modules found beside it,
//     plus our extra commands and the app-approval gate.
//   - The one patch: getApp(name) in create_tinysky_alt.js, anchored on literals.
import {cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, symlinkSync} from 'node:fs';
import {join, resolve, posix} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {cacheDir} from './paths.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const own=join(root,'scripts/runtime');
const packages=['cua','sky'];
const tinysky='dist/lib/js/oai_js_cua/src/tinysky_alt';
const cuaFile=tinysky+'/create_tinysky_alt.js';
const appFile=tinysky+'/bind_linux_app.js';
const appTypes=tinysky+'/types.d.ts';
const sky='dist/project/cua/sky_js/src';
const linux=sky+'/targets/linux';
const clientTypes=sky+'/types/full-desktop/FullDesktopComputerUseClient.d.ts';
// Our files copied into the overlay: [package directory, file in scripts/runtime].
const ownFiles=[
  ['cua/'+tinysky,'bind_linux_app.js'],
  ['cua/'+tinysky,'hyprland_ax_diff.js'],
  ...packages.flatMap(pkg=>[[pkg+'/'+linux,'hyprland_parity_commands.js'],[pkg+'/'+linux,'hyprland_app_approval.js']]),
];
// Commands the generated client adds (scripts/runtime/hyprland_parity_commands.js).
const parityCommands=['resolve_app','select_text','set_value','paste'];
// Sky Linux support classes/functions the generated client wires, by export name.
const clientSupport=['ActionSettler','ElementIds','sky_linux'];

// Where prepared overlays live: one directory per source hash.
export function overlayDirectory(hash) { return join(cacheDir(),'runtime',hash,'node_modules'); }

function layout(message) {
  return new Error(`Codex runtime layout changed: ${message} Update scripts/prepare-runtime.mjs (and scripts/runtime/) for this @oai/cua / @oai/sky release.`);
}
function read(path) {
  if(!existsSync(path)) throw layout(`${path} is missing.`);
  return readFileSync(path,'utf8');
}
// Export names of an ES module: `export{a as b,c}`, `export{x}from"..."`, and
// `export function|class|const name`. Export names survive minification.
function exportsOf(source) {
  const names=new Set();
  for(const [,list] of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for(const part of list.split(',')) {
      const name=part.trim().split(/\s+as\s+/).pop();
      if(name) names.add(name);
    }
  }
  for(const [,name] of source.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s*([\w$]+)/g)) names.add(name);
  return names;
}
// Named imports of an ES module as [{names, from}], by imported (exported) name.
function importsOf(source) {
  return [...source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].map(([,list,from])=>({
    from, names:list.split(',').map(part=>part.trim().split(/\s+as\s+/)[0]).filter(Boolean),
  }));
}
function requireImport(source,file,name,from) {
  if(!importsOf(source).some(entry=>entry.from===from&&entry.names.includes(name))) throw layout(`${file} no longer imports ${name} from "${from}".`);
}
// Member names declared directly in a TypeScript interface or object type.
function declaredMembers(declarations,file,pattern) {
  const source=declarations.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  const head=source.match(pattern);
  if(!head) throw layout(`${file} no longer declares ${pattern}.`);
  const members=[];
  let depth=1,line='';
  for(let i=head.index+head[0].length;depth>0&&i<source.length;i++) {
    const ch=source[i];
    if(ch==='{'||ch==='(') depth++;
    else if(ch==='}'||ch===')') depth--;
    if(depth===1&&(ch==='\n'||ch===';')) {
      const member=line.match(/^\s*(?:readonly\s+)?([\w$]+)(\??)\s*[(:<]/);
      if(member) members.push({name:member[1],optional:member[2]==='?'});
      line='';
    } else if(depth===1||(depth===2&&(ch==='('||ch==='{'))) line+=ch;
  }
  return {members,extends:(head[1]??'').split(',').map(name=>name.trim()).filter(Boolean)};
}
function appMethods(source,file) {
  const methods=new Set(),seen=new Set();
  (function visit(name) {
    if(seen.has(name)) return;seen.add(name);
    const found=declaredMembers(source,file,new RegExp(`\\binterface\\s+${name}\\b(?:\\s+extends\\s+([\\w$.,\\s]+?))?\\s*\\{`));
    for(const member of found.members) methods.add(member.name);
    for(const base of found.extends) if(new RegExp(`\\binterface\\s+${base}\\b`).test(source)) visit(base);
  })('App');
  return [...methods];
}

// The one code patch: getApp accepts an app name on Linux, resolved (and
// launched if needed) by the backend's resolve_app command. Anchored on the
// "linux" literal, the list_windows property and the getApp validation message;
// identifiers are wildcards.
function patchGetApp(source,file) {
  const id='[\\w$]+';
  const validators=[...source.matchAll(new RegExp(`(?:function\\s+(${id})\\s*\\(|\\b(${id})\\s*=\\s*(?:function\\s*)?\\()(?:(?!function\\b)[\\s\\S]){0,600}?getApp requires \\{ windowId \\}`,'g'))];
  if(validators.length!==1) throw layout(`${file}: expected one getApp { windowId } validator, found ${validators.length}.`);
  const validator=validators[0][1]??validators[0][2];
  const branch=source.match(/\bcase\s*"linux"\s*:([\s\S]*?)(?=\bcase\s*"|\bdefault\s*:)/);
  if(!branch) throw layout(`${file}: the "linux" getApp branch is missing.`);
  const calls=[...branch[1].matchAll(new RegExp(`\\b${validator.replace(/\$/g,'\\$')}\\s*\\(\\s*(${id})\\s*,\\s*"linux"\\s*\\)`,'g'))];
  const lister=branch[1].match(new RegExp(`\\b(yield|await)\\s+(${id})\\s*\\.\\s*list_windows\\s*\\(`));
  if(calls.length!==1||!lister) throw layout(`${file}: the Linux getApp no longer validates { windowId } and lists windows.`);
  const [call,target]=calls[0],[,wait,computer]=lister;
  const start=branch.index+branch[0].length-branch[1].length+calls[0].index;
  return source.slice(0,start)+`("string"==typeof ${target}?(${wait} ${computer}.resolve_app({app:${target}})).id:${call})`+source.slice(start+call.length);
}

// Generate Sky's Linux create_client.js: the same client as upstream (target
// "linux", every create_<command> module in the directory, audio only when
// SKY_ENABLE_AUDIO=1, a shared ActionSettler and ElementIds), plus our extra
// commands, wrapped by the app-approval gate.
function generateClient(source,pkg) {
  const dir=join(source,pkg,linux),label=`@oai/${pkg}/${linux}`;
  const owner=new Map(),commands=new Map();
  for(const file of readdirSync(dir).filter(name=>name.endsWith('.js')&&name!=='create_client.js'&&!name.startsWith('hyprland_')).sort()) {
    for(const name of exportsOf(read(join(dir,file)))) {
      if(!/^[\w$]+$/.test(name)) continue;
      if(owner.has(name)) throw layout(`${label}: ${name} is exported by both ${owner.get(name)} and ${file}.`);
      owner.set(name,file);
      const command=name.match(/^create_(\w+)$/)?.[1];
      if(command) commands.set(command,name);
    }
  }
  const missing=clientSupport.filter(name=>!owner.has(name));
  if(missing.length) throw layout(`${label} no longer exports ${missing.join(', ')}.`);
  // The typed client interface lists the commands upstream's client provides.
  const declared=declaredMembers(read(join(source,pkg,clientTypes)),clientTypes,/\btype\s+FullDesktopComputerUseClient\s*=\s*\{/).members;
  const absent=declared.filter(m=>!m.optional&&m.name!=='target'&&!commands.has(m.name)).map(m=>m.name);
  if(absent.length) throw layout(`${label} has no create_<command> module for ${absent.join(', ')} declared by FullDesktopComputerUseClient.`);
  const upstream=read(join(dir,'create_client.js'));
  if(!exportsOf(upstream).has('create_client')) throw layout(`${label}/create_client.js no longer exports create_client.`);
  requireImport(read(join(source,pkg,sky,'create_client.js')),`@oai/${pkg}/${sky}/create_client.js`,'create_client','./targets/linux/create_client.js');
  const audio=commands.get('audio_recording');
  // Upstream's order (the declared interface), then any undeclared commands.
  const order=declared.map(m=>m.name);
  const rank=command=>order.includes(command)?order.indexOf(command):order.length;
  const regular=[...commands].filter(([command])=>command!=='audio_recording').sort(([a],[b])=>rank(a)-rank(b)||a.localeCompare(b));
  const imports=[...clientSupport,...commands.values()].sort().map(name=>`import { ${name} } from "./${owner.get(name)}";`);
  const text=`// Generated by codex-computer-use-hyprland scripts/prepare-runtime.mjs from the
// create_<command> modules in this directory; replaces upstream's create_client.js.
${imports.join('\n')}
import { parityCommands } from "./hyprland_parity_commands.js";
import { gateApps } from "./hyprland_app_approval.js";

function create_client(input) {
  const base = Object.assign({}, input);
  const options = Object.assign(Object.assign({}, base), { action_settler: new ActionSettler(base), element_ids: new ElementIds() });
  const client = {
    target: "linux",
${regular.map(([command,name])=>`    ${command}: ${name}(options),`).join('\n')}
  };
${audio?`  if (process.env.SKY_ENABLE_AUDIO === "1") Object.assign(client, ${audio}(options));\n`:''}  Object.assign(client, parityCommands(options, sky_linux));
  return gateApps(options, client, sky_linux);
}

export { create_client };
`;
  return {text,commands:[...declared.filter(m=>!m.optional&&m.name!=='target').map(m=>m.name),...parityCommands]};
}

// Check our binding's upstream imports and that upstream still loads the binding
// from the file we replace; return the App methods the binding must provide.
function reviewBinding(source) {
  const dir=join(source,'cua',tinysky);
  if(!exportsOf(read(join(dir,'bind_linux_app.js'))).has('bind_linux_app')) throw layout(`@oai/cua/${appFile} no longer exports bind_linux_app.`);
  requireImport(read(join(dir,'create_tinysky_alt.js')),`@oai/cua/${cuaFile}`,'bind_linux_app','./bind_linux_app.js');
  const binding=readFileSync(join(own,'bind_linux_app.js'),'utf8');
  for(const {from,names} of importsOf(binding)) {
    if(posix.basename(from).startsWith('hyprland_')) continue;
    const exported=exportsOf(read(join(dir,from)));
    const lost=names.filter(name=>!exported.has(name));
    if(lost.length) throw layout(`@oai/cua/${posix.join(tinysky,from)} no longer exports ${lost.join(', ')} (used by scripts/runtime/bind_linux_app.js).`);
  }
  const methods=appMethods(read(join(dir,'types.d.ts')),`@oai/cua/${appTypes}`);
  const unimplemented=methods.filter(name=>!new RegExp(`^\\s+(?:async\\s+)?${name}\\s*[(:]`,'m').test(binding));
  if(unimplemented.length) throw layout(`the App interface in @oai/cua/${appTypes} declares ${unimplemented.join(', ')}, which scripts/runtime/bind_linux_app.js does not implement.`);
  return methods;
}

// Load the finished overlay in a separate process: module linking proves every
// import resolves, and the bound app and clients must expose their typed API.
function selfCheck(temp,methods,commands) {
  const url=path=>pathToFileURL(join(temp,'@oai',path)).href;
  const clients=Object.fromEntries(packages.map(pkg=>[pkg,url(pkg+'/'+linux+'/create_client.js')]));
  const code=`
const failures=[];
const {bind_linux_app}=await import(${JSON.stringify(url('cua/'+appFile))});
const app=bind_linux_app({}, {id: 1});
for (const name of ${JSON.stringify(methods)}) if (typeof app[name] !== "function") failures.push("App." + name);
for (const [pkg, url] of Object.entries(${JSON.stringify(clients)})) {
  const {create_client}=await import(url);
  const client=create_client({});
  if (client.target !== "linux") failures.push(pkg + " client.target");
  for (const name of ${JSON.stringify(commands)}) if (typeof client[name] !== "function") failures.push(pkg + " client." + name);
}
await import(${JSON.stringify(url('cua/'+cuaFile))});
if (failures.length) { console.error("missing " + failures.join(", ") + "."); process.exit(1); }
`;
  try {
    execFileSync(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});
  } catch(error) {
    throw layout(`the prepared overlay failed its load check: ${String(error.stderr??error.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

export function reviewRuntime(runtime) {
  const source=join(runtime,'lib/node_modules/@oai');
  const digest=createHash('sha256').update(resolve(runtime)).update(readFileSync(fileURLToPath(import.meta.url)));
  for(const file of readdirSync(own).sort()) digest.update(file).update(readFileSync(join(own,file)));
  const revisions={};
  for(const pkg of packages) {
    const meta=JSON.parse(readFileSync(join(source,pkg,'package.json'),'utf8'));
    revisions[pkg]=meta.version;
    // Invalidate the copy when any shipped file changes, including browser
    // code and documentation whose package versions may remain the same.
    function hashFiles(dir,relative='') {
      for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const path=join(dir,entry.name),label=join(relative,entry.name);
        if(entry.isDirectory()) hashFiles(path,label);
        else if(entry.isFile()) digest.update(pkg+'/'+label).update(readFileSync(path));
      }
    }
    hashFiles(join(source,pkg));
  }
  // Validate only the layout we depend on. Versions remain diagnostic;
  // unrelated source changes invalidate the cache without rejecting the bundle.
  const methods=reviewBinding(source);
  const clients=Object.fromEntries(packages.map(pkg=>[pkg,generateClient(source,pkg)]));
  const tinyskyAlt=patchGetApp(read(join(source,'cua',cuaFile)),`@oai/cua/${cuaFile}`);
  const hash=digest.digest('hex').slice(0,20);
  return {source,hash,revisions,plan:{methods,clients,tinyskyAlt}};
}

export function prepareRuntime(runtime) {
  const {source,hash,revisions,plan}=reviewRuntime(runtime);
  const output=overlayDirectory(hash);
  if(existsSync(join(output,'parity-ready.json'))) return output;
  const temp=output+`.${process.pid}.tmp`;mkdirSync(join(temp,'@oai'),{recursive:true});
  for(const pkg of packages) cpSync(join(source,pkg),join(temp,'@oai',pkg),{recursive:true});
  // Preserve resolution of the upstream runtime's external dependencies.
  for(const entry of readdirSync(resolve(source,'..'))) {
    if(entry!=='@oai') symlinkSync(join(resolve(source,'..'),entry),join(temp,entry));
  }
  for(const entry of readdirSync(source)) {
    if(!packages.includes(entry)) symlinkSync(join(source,entry),join(temp,'@oai',entry));
  }
  try {
    for(const [dir,file] of ownFiles) cpSync(join(own,file),join(temp,'@oai',dir,file));
    for(const pkg of packages) writeFileSync(join(temp,'@oai',pkg,linux,'create_client.js'),plan.clients[pkg].text);
    writeFileSync(join(temp,'@oai/cua',cuaFile),plan.tinyskyAlt);
    // Cosmetic patches (messages the agent reads) never block startup if they drift.
    for(const pkg of packages) {
      const target=join(temp,'@oai',pkg,linux,'element_ids.js');
      if(existsSync(target)) writeFileSync(target,readFileSync(target,'utf8').replace('refresh get_window_state()','refresh getAXState()'));
    }
    patchDocumentation(join(temp,'@oai/cua/docs/tinysky-alt-core-cua-repl.md'));
    selfCheck(temp,plan.methods,[...new Set(Object.values(plan.clients).flatMap(client=>client.commands))]);
  } catch(error) {
    rmSync(temp,{recursive:true,force:true});
    throw error;
  }
  writeFileSync(join(temp,'parity-ready.json'),JSON.stringify({revisions,hash},null,2));
  mkdirSync(resolve(output,'..'),{recursive:true});
  try {renameSync(temp,output);} catch(error) {rmSync(temp,{recursive:true,force:true});if(!existsSync(join(output,'parity-ready.json')))throw error;}
  return output;
}

function patchDocumentation(docs) {
  if(!existsSync(docs)) return;
  let documentation=readFileSync(docs,'utf8');
  const replacements=[
    ['On macOS, use `cua.getApp("Example App")` with an app name, path, or bundle ID. On Linux and Windows, use `cua.getApp({ windowId: 123 })` with an exact open window ID from the app inventory.', 'On macOS and this Hyprland provider, `cua.getApp("Example App")` accepts an app name, path, or app ID and launches it if needed. On Hyprland and Windows, `cua.getApp({ windowId: 123 })` selects an exact open window.'],
    ['`getApp` does not launch apps on Linux or Windows.', '`getApp` does not launch apps on Windows. This Hyprland provider supports background launch when passed an app name or inventory ID.'],
    ['Linux and Windows app `paste` support only `text` and use the platform\'s native text input.', 'This Hyprland provider supports text, HTML, and rendered Markdown paste. Wayland uses private clipboard offers. XWayland temporarily owns the shared X clipboard and restores its prior formats unless a newer copy replaces them. Windows app paste supports only text.'],
    ['Native app `scroll` accepts a page count on macOS. On Linux, omit the distance for the native default or pass `{ pixels: 500 }`.', 'Native app `scroll` accepts a page count on macOS and this Hyprland provider. On Hyprland, omitted distance means one viewport page; `{ pixels: 500 }` specifies an exact distance.'],
    ['Linux element clicks support one left or right click. Use coordinates for other click options.', 'As on macOS, element clicks on this Hyprland provider accept any mouse button and click count.'],
    ['Linux and Windows always return full accessibility state.', 'As on macOS, this Hyprland provider returns a diff unless `disableDiffing` is set; Windows always returns full accessibility state.'],
    ['`selectText` is unavailable on Linux and Windows. `setValue` is unavailable on Linux. These methods throw before sending input. Use the supported bound actions to edit the UI and verify the result.', 'This Hyprland provider implements `selectText` and `setValue` through AT-SPI text, editable-text, and value interfaces. Controls without the required interface return a specific error. Windows selectText remains unavailable.'],
  ];
  for(const [from,to] of replacements) {
    documentation=documentation.replace(from,to);
  }
  documentation += '\n\nHyprland provider capabilities: getApp accepts names and IDs and supports background launch. selectText and setValue use AT-SPI. paste supports text, HTML and Markdown. scroll accepts viewport pages or pixels. These provider capabilities take precedence over generic Linux restrictions above.\n\nOn this Hyprland provider, app screenshots include owned popups. Coordinate actions use the latest app screenshot origin; accessibility-only observations retain that mapping. Identical windows are bound using geometry and, when necessary, temporary client-side focus notifications, without changing compositor focus.\n\nWhen asked to open a new window, record listWindows() before launch, refresh it after launch, and bind only a newly observed matching window ID. A launch may reuse an existing window; never label an existing window as newly created or close it as cleanup. If no new ID appears, inspect the application before proceeding. Screenshots refresh background rendering without switching workspaces. Paste uses the application category’s normal keyboard shortcut; do not assume Ctrl+V is paste in a terminal.\n';
  writeFileSync(docs,documentation);
}

if(process.argv[1]===fileURLToPath(import.meta.url)) console.log(prepareRuntime(process.env.CODEX_CUA_RUNTIME??'/usr/lib/chatgpt/resources/cua_node'));
