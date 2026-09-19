// Build a private, version-checked runtime overlay. Installed packages are read-only.
import {cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, symlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const cuaFile='dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js';
const linux='dist/project/cua/sky_js/src/targets/linux';
const revisions={cua:'0.2.5',sky:'0.7.1'};
export function prepareRuntime(runtime) {
  const source=join(runtime,'lib/node_modules/@oai');
  const input={};
  for(const [pkg,version] of Object.entries(revisions)) {
    const meta=JSON.parse(readFileSync(join(source,pkg,'package.json'),'utf8'));
    if(meta.version!==version) throw new Error(`Runtime parity patch requires @oai/${pkg} ${version}; found ${meta.version}. Review the upstream changes before updating the patch.`);
    input[pkg]=readFileSync(join(source,pkg,pkg==='cua'?cuaFile:linux+'/create_client.js'),'utf8');
  }
  const hash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).update(JSON.stringify(input)).digest('hex').slice(0,20);
  const output=join(root,'build','runtime',hash,'node_modules');
  if(existsSync(join(output,'parity-ready.json'))) return output;
  const temp=output+`.${process.pid}.tmp`;mkdirSync(join(temp,'@oai'),{recursive:true});
  for(const pkg of Object.keys(revisions)) cpSync(join(source,pkg),join(temp,'@oai',pkg),{recursive:true});
  // Preserve resolution of the upstream runtime's external dependencies.
  for(const entry of readdirSync(resolve(source,'..'))) {
    if(entry!=='@oai') symlinkSync(join(resolve(source,'..'),entry),join(temp,entry));
  }
  for(const entry of readdirSync(source)) {
    if(!(entry in revisions)) symlinkSync(join(source,entry),join(temp,'@oai',entry));
  }
  function patch(pkg,path,from,to) {
    const target=join(temp,'@oai',pkg,path),s=readFileSync(target,'utf8');
    if(s.split(from).length!==2) throw new Error(`Upstream source mismatch: ${pkg}/${path}`);
    writeFileSync(target,s.replace(from,to));
  }
  patch('cua',cuaFile,'if("number"==typeof r)throw new Error("Linux scroll accepts { pixels }, not pages.");','');
  patch('cua',cuaFile,'void 0!==r&&(n.pixels=h(r.pixels)),t.scroll(n)','"number"==typeof r?n.pages=h(r):void 0!==r?n.pixels=h(r.pixels):n.pages=1,t.scroll(n)');
  patch('cua',cuaFile,'selectText(){return e(this,void 0,void 0,(function*(){throw new Error("selectText is unavailable on Linux.")}))},setValue(){return e(this,void 0,void 0,(function*(){throw new Error("setValue is unavailable on Linux; use click, pressKey, and typeText.")}))},paste:(e,o)=>(m(o,"Linux"),t.type_text({window:i,text:e}))',
    'selectText:(e,o,r)=>t.select_text({window:i,element_id:String(e),text:o,prefix:r?.prefix,suffix:r?.suffix,selection_type:r?.selectionType??"text"}),setValue:(e,o)=>t.set_value({window:i,element_id:String(e),value:o}),paste:(e,o)=>t.paste({window:i,text:e,format:o?.format??"text"})');
  patch('cua',cuaFile,'const i=p(t,"linux"),o=(yield T.list_windows())','const i="string"==typeof t?(yield T.resolve_app({app:t})).id:p(t,"linux"),o=(yield T.list_windows())');
  const additions='resolve_app:parity(u,"resolve_app"),select_text:parity(u,"select_text"),set_value:parity(u,"set_value"),paste:parity(u,"paste"),';
  for(const pkg of ['cua','sky']) {
    patch(pkg,linux+'/create_client.js','y={target:"linux",','y={target:"linux",'+additions);
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
      if(!documentation.includes(from)) throw new Error('Upstream documentation changed: '+from);
      documentation=documentation.replace(from,to);
    }
    documentation += '\n\nOn this Hyprland provider, app screenshots include owned popups. Coordinate actions use the latest app screenshot origin; accessibility-only observations retain that mapping. Identical windows are bound using geometry and, when necessary, temporary client-side focus notifications, without changing compositor focus.\n';
    writeFileSync(docs,documentation);
  }
  writeFileSync(join(temp,'parity-ready.json'),JSON.stringify({revisions,hash},null,2));
  mkdirSync(resolve(output,'..'),{recursive:true});
  try {renameSync(temp,output);} catch(error) {rmSync(temp,{recursive:true,force:true});if(!existsSync(join(output,'parity-ready.json')))throw error;}
  return output;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) console.log(prepareRuntime(process.env.CODEX_CUA_RUNTIME??'/opt/codex-desktop/resources/cua_node'));
