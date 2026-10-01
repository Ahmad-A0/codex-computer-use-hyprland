// Build a private runtime overlay when the required patch sites still match.
import {cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, symlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cuaFile='dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js';
const appFile='dist/lib/js/oai_js_cua/src/tinysky_alt/bind_linux_app.js';
const linux='dist/project/cua/sky_js/src/targets/linux';
const packages=['cua','sky'];
const additions='resolve_app:parity(x,"resolve_app"),select_text:parity(x,"select_text"),set_value:parity(x,"set_value"),paste:parity(x,"paste"),';
const patches=[
  ['cua',appFile,'if("number"==typeof i)throw new Error("Linux scroll accepts { pixels }, not pages.");',''],
  ['cua',appFile,'void 0!==i&&(n.pixels=o(i.pixels)),s.scroll(n)','"number"==typeof i?n.pages=o(i):void 0!==i?n.pixels=o(i.pixels):n.pages=1,s.scroll(n)'],
  ['cua',appFile,'selectText(){return e(this,void 0,void 0,(function*(){throw new Error("selectText is unavailable on Linux.")}))},setValue(){return e(this,void 0,void 0,(function*(){throw new Error("setValue is unavailable on Linux; use click, pressKey, and typeText.")}))},paste:(e,t)=>(r(t,"Linux"),s.type_text({window:c,text:e}))',
    'selectText:(e,t,i)=>s.select_text({window:c,element_id:String(e),text:t,prefix:i?.prefix,suffix:i?.suffix,selection_type:i?.selectionType??"text"}),setValue:(e,t)=>s.set_value({window:c,element_id:String(e),value:t}),paste:(e,t)=>s.paste({window:c,text:e,format:t?.format??"text"})'],
  ['cua',cuaFile,'const i=p(t,"linux"),e=(yield y.list_windows())','const i="string"==typeof t?(yield y.resolve_app({app:t})).id:p(t,"linux"),e=(yield y.list_windows())'],
  ...packages.map(pkg=>[pkg,linux+'/create_client.js','A={target:"linux",','A={target:"linux",'+additions]),
];
function replacePatch(source,pkg,path,from,to) {
  if(source.split(from).length!==2) throw new Error(`Runtime patch no longer matches @oai/${pkg}/${path}. Update the adapter for this source layout.`);
  return source.replace(from,to);
}
export function reviewRuntime(runtime) {
  const source=join(runtime,'lib/node_modules/@oai');
  const digest=createHash('sha256').update(resolve(runtime)).update(readFileSync(fileURLToPath(import.meta.url)));
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
  // Validate only the code we need to replace. Versions remain diagnostic;
  // unrelated source changes invalidate the cache without rejecting the bundle.
  const pending=new Map();
  for(const [pkg,path,from,to] of patches) {
    const key=join(source,pkg,path);
    const text=pending.get(key)??readFileSync(key,'utf8');
    pending.set(key,replacePatch(text,pkg,path,from,to));
  }
  const hash=digest.digest('hex').slice(0,20);
  return {source,hash,revisions};
}
export function prepareRuntime(runtime) {
  const {source,hash,revisions}=reviewRuntime(runtime);
  const output=join(root,'build','runtime',hash,'node_modules');
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
  function patch(pkg,path,from,to) {
    const target=join(temp,'@oai',pkg,path),s=readFileSync(target,'utf8');
    writeFileSync(target,replacePatch(s,pkg,path,from,to));
  }
  for(const args of patches) patch(...args);
  for(const pkg of packages) {
    const target=join(temp,'@oai',pkg,linux,'create_client.js');
    writeFileSync(target,'import {sky_linux as parityTransport} from "./sky_linux.js";\nfunction parity(options, command) { return async function(input) { await options.action_settler.wait(); const result=await parityTransport(command,{options,input:options.element_ids.resolve(input)}); options.action_settler.defer(); if(command==="resolve_app") return JSON.parse(result); }; }\n'+readFileSync(target,'utf8'));
  }
  const docs=join(temp,'@oai/cua/docs/tinysky-alt-core-cua-repl.md');
  if(existsSync(docs)) {
    let documentation=readFileSync(docs,'utf8');
    const replacements=[
      ['On macOS, use `cua.getApp("Example App")` with an app name, path, or bundle ID. On Linux and Windows, use `cua.getApp({ windowId: 123 })` with an exact open window ID from the app inventory.', 'On macOS and this Hyprland provider, `cua.getApp("Example App")` accepts an app name, path, or app ID and launches it if needed. On Hyprland and Windows, `cua.getApp({ windowId: 123 })` selects an exact open window.'],
      ['`getApp` does not launch apps on Linux or Windows.', '`getApp` does not launch apps on Windows. This Hyprland provider supports background launch when passed an app name or inventory ID.'],
      ['Linux and Windows app `paste` support only `text` and use the platform\'s native text input.', 'This Hyprland provider supports text, HTML, and rendered Markdown paste. Wayland uses private clipboard offers. XWayland temporarily owns the shared X clipboard and restores its prior formats unless a newer copy replaces them. Windows app paste supports only text.'],
      ['Native app `scroll` accepts a page count on macOS. On Linux, omit the distance for the native default or pass `{ pixels: 500 }`.', 'Native app `scroll` accepts a page count on macOS and this Hyprland provider. On Hyprland, omitted distance means one viewport page; `{ pixels: 500 }` specifies an exact distance.'],
      ['`selectText` is unavailable on Linux and Windows. `setValue` is unavailable on Linux. These methods throw before sending input. Use the supported bound actions to edit the UI and verify the result.', 'This Hyprland provider implements `selectText` and `setValue` through AT-SPI text, editable-text, and value interfaces. Controls without the required interface return a specific error. Windows selectText remains unavailable.'],
    ];
    for(const [from,to] of replacements) {
      documentation=documentation.replace(from,to);
    }
    documentation += '\n\nHyprland provider capabilities: getApp accepts names and IDs and supports background launch. selectText and setValue use AT-SPI. paste supports text, HTML and Markdown. scroll accepts viewport pages or pixels. These provider capabilities take precedence over generic Linux restrictions above.\n\nOn this Hyprland provider, app screenshots include owned popups. Coordinate actions use the latest app screenshot origin; accessibility-only observations retain that mapping. Identical windows are bound using geometry and, when necessary, temporary client-side focus notifications, without changing compositor focus.\n\nWhen asked to open a new window, record listWindows() before launch, refresh it after launch, and bind only a newly observed matching window ID. A launch may reuse an existing window; never label an existing window as newly created or close it as cleanup. If no new ID appears, inspect the application before proceeding. Screenshots refresh background rendering without switching workspaces. Paste uses the application category’s normal keyboard shortcut; do not assume Ctrl+V is paste in a terminal.\n';
    writeFileSync(docs,documentation);
  }
  writeFileSync(join(temp,'parity-ready.json'),JSON.stringify({revisions,hash},null,2));
  mkdirSync(resolve(output,'..'),{recursive:true});
  try {renameSync(temp,output);} catch(error) {rmSync(temp,{recursive:true,force:true});if(!existsSync(join(output,'parity-ready.json')))throw error;}
  return output;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) console.log(prepareRuntime(process.env.CODEX_CUA_RUNTIME??'/usr/lib/chatgpt/resources/cua_node'));
