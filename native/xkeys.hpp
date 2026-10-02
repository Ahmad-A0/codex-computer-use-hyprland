// Keysym lookup for the private X11 keyboard, independent of the seat's keymap.
// X clients translate key events with the core keyboard's map, which XWayland
// replaces with the Wayland seat's current keymap. After a virtual keyboard such
// as wtype types, that map holds only wtype's keys. A keysym missing from it is
// bound for this run to a core key without symbols (the core keyboard only, so
// physical keyboards and other devices keep their maps) and restored exactly
// afterwards: on success, on errors (destructor), and after a killed helper by
// the next run, from a root-window journal. A new seat keymap replaces the whole
// map; bindings it replaced are never "restored" over it. (The X server's
// keysym update also resets the core keyboard's per-key autorepeat flags to its
// keyboard feedback's, which XWayland never updates; the next seat keymap sets
// them again. Restoring them with SetControls would change that feedback and
// the slaves' flags for good, so they are left alone.)
// The private keyboard keeps the server's default complete map, so its modifier
// keys always set the modifier state the client sees.
#include <X11/Xatom.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XInput2.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

class XKeys {
 public:
  XKeys(Display* d,int privateKeyboard,Window target,std::vector<unsigned> down):d(d),target(target),down(std::move(down)){
   int major=XkbMajorVersion,minor=XkbMinorVersion,error;
   if(!XkbQueryExtension(d,&opcode,&eventBase,&error,&major,&minor))throw std::runtime_error("XWayland lacks the XKB extension");
   int pointer=0,count=0;XIGetClientPointer(d,None,&pointer);
   if(auto* info=XIQueryDevice(d,pointer,&count)){if(count==1)core=info[0].attachment;XIFreeDeviceInfo(info);}
   if(!core)throw std::runtime_error("No X11 core keyboard");
   XkbSelectEvents(d,core,XkbNewKeyboardNotifyMask,XkbNewKeyboardNotifyMask);
   journal=XInternAtom(d,"_CODEX_KEY_BINDINGS",False);
   map=fetch(core,XkbKeyTypesMask|XkbKeySymsMask);
   own=fetch(privateKeyboard,XkbKeySymsMask|XkbModifierMapMask|XkbKeyActionsMask);
   recover();
  }
  ~XKeys(){try{restore();}catch(...){}if(map)XkbFreeKeyboard(map,0,True);if(own)XkbFreeKeyboard(own,0,True);}
  XKeys(const XKeys&)=delete;XKeys& operator=(const XKeys&)=delete;

  // Keycode and Shift state that make the client read sym, binding it when needed.
  std::pair<unsigned,unsigned> find(KeySym sym){
   if(auto mask=modifierMask(sym))return {modifier(sym,mask),0};
   refresh();
   for(int code=map->min_key_code;code<=map->max_key_code;++code)for(int level=0;level<2;++level)if(symAt(map,code,level)==sym)return {unsigned(code),level?ShiftMask:0u};
   // Prefer the private map's own key (and Shift level) for sym: the server
   // processes it for the private device as the client reads it, a complete
   // seat keymap that returns mid-run reads the same stroke the same way, and
   // a held key gets the same keycode in every run. Else a key unused on both.
   for(int c=std::max(own->min_key_code,map->min_key_code);c<=std::min(own->max_key_code,map->max_key_code);++c)for(int level=0;level<2;++level)
    if(symAt(own,c,level)==sym && empty(map,c)){bind(c,sym);return {unsigned(c),level?ShiftMask:0u};}
   int code=0;
   for(int c=map->max_key_code;c>=map->min_key_code && !code;--c)if(spare(c,true))code=c;
   for(int c=map->max_key_code;c>=map->min_key_code && !code;--c)if(spare(c,false))code=c;
   if(!code)throw std::runtime_error("No free X11 keycode to bind "+name(sym));
   bind(code,sym);return {unsigned(code),0};
  }
  // Private-keyboard keycode of a modifier key (it sets the event state); the
  // core map gets the modifier's keysym there too when that key is unbound.
  unsigned modifier(KeySym sym,unsigned mask){
   refresh();
   int code=0;
   for(int c=own->min_key_code;c<=own->max_key_code && !code;++c)for(int level=0;level<2;++level)if(symAt(own,c,level)==sym && own->map->modmap && (own->map->modmap[c]&mask))code=c;
   if(!code)throw std::runtime_error("X11 modifier key is not mapped: "+name(sym));
   if(code>=map->min_key_code && code<=map->max_key_code && empty(map,code))bind(code,sym);
   return code;
  }
  static unsigned modifierMask(KeySym sym){
   switch(sym){case XK_Shift_L:case XK_Shift_R:return ShiftMask;case XK_Control_L:case XK_Control_R:return ControlMask;
    case XK_Alt_L:case XK_Alt_R:case XK_Meta_L:case XK_Meta_R:return Mod1Mask;case XK_Super_L:case XK_Super_R:return Mod4Mask;
    case XK_ISO_Level3_Shift:return Mod5Mask;default:return 0;}
  }
  // Undo this run's bindings once the target has read the keys sent with them.
  void restore(){
   if(bindings.empty())return;
   settle();refresh();
   Trap trap(d);
   for(auto it=bindings.rbegin();it!=bindings.rend();++it){XkbGetKeySyms(d,it->code,1,map);if(bound(it->code,it->sym))write(it->code,it->original);}
   bindings.clear();XDeleteProperty(d,DefaultRootWindow(d),journal);
  }

 private:
  struct Binding {int code;KeySym sym;XkbSymMapRec original;};
  // Collects X errors of keymap requests instead of Xlib's default exit.
  struct Trap {
   static inline int code=0;XErrorHandler previous;Display* d;
   explicit Trap(Display* d):d(d){XSync(d,False);code=0;previous=XSetErrorHandler([](Display*,XErrorEvent* e){code=e->error_code;return 0;});}
   ~Trap(){XSync(d,False);XSetErrorHandler(previous);}
  };
  Display* d;Window target;std::vector<unsigned> down;int opcode=0,eventBase=0,core=0;Atom journal;
  XkbDescPtr map=nullptr,own=nullptr;std::vector<Binding> bindings;

  XkbDescPtr fetch(int device,unsigned which){
   auto* x=XkbGetMap(d,which,device);
   if(!x||!x->map||!x->map->key_sym_map){if(x)XkbFreeKeyboard(x,0,True);throw std::runtime_error("Cannot read the X11 keyboard map");}
   x->device_spec=device;return x;  // Requests then change this device only.
  }
  static std::string name(KeySym sym){auto* s=XKeysymToString(sym);return s?s:std::to_string(sym);}
  static KeySym symAt(XkbDescPtr x,int code,int level){
   if(code<x->min_key_code||code>x->max_key_code||XkbKeyNumGroups(x,code)<1)return NoSymbol;
   if(x->map->types && level>=XkbKeyGroupWidth(x,code,0))return NoSymbol;
   return level<XkbKeyGroupsWidth(x,code)?XkbKeySymsPtr(x,code)[level]:NoSymbol;
  }
  static bool empty(XkbDescPtr x,int code){for(int i=0;i<XkbKeyNumSyms(x,code);++i)if(XkbKeySymsPtr(x,code)[i]!=NoSymbol)return false;return true;}
  bool bound(int code,KeySym sym){return XkbKeyNumGroups(map,code)==1 && XkbKeyNumSyms(map,code)==1 && map->map->key_sym_map[code].kt_index[0]==XkbOneLevelIndex && XkbKeySymsPtr(map,code)[0]==sym;}
  // A core key without symbols, not held, whose private key changes no state.
  bool spare(int code,bool unusedPrivately){
   if(code<8||!empty(map,code)||std::find(down.begin(),down.end(),unsigned(code))!=down.end())return false;
   if(code<own->min_key_code||code>own->max_key_code)return true;
   if(unusedPrivately)return empty(own,code);
   if(own->map->modmap && own->map->modmap[code])return false;
   if(own->server && own->server->key_acts && XkbKeyHasActions(own,code))for(int i=0;i<XkbKeyNumSyms(own,code);++i)if(XkbKeyActionsPtr(own,code)[i].type!=XkbSA_NoAction)return false;
   return true;
  }
  // A new seat keymap (XWayland's NewKeyboardNotify) replaced our bindings.
  void refresh(){
   bool replaced=false;
   while(XEventsQueued(d,QueuedAfterReading)){XEvent e;XNextEvent(d,&e);if(e.type==eventBase && reinterpret_cast<XkbAnyEvent*>(&e)->xkb_type==XkbNewKeyboardNotify)replaced=true;}
   if(!replaced)return;
   bindings.clear();XDeleteProperty(d,DefaultRootWindow(d),journal);
   auto* fresh=fetch(core,XkbKeyTypesMask|XkbKeySymsMask);XkbFreeKeyboard(map,0,True);map=fresh;
  }
  // Set one key's symbols; the keys we bind or restore have only NoSymbol.
  void write(int code,const XkbSymMapRec& entry,KeySym sym=NoSymbol){
   int count=entry.width*XkbNumGroups(entry.group_info);
   if(!XkbResizeKeySyms(map,code,count))throw std::runtime_error("Cannot resize the X11 keyboard map");
   auto& m=map->map->key_sym_map[code];std::memcpy(m.kt_index,entry.kt_index,sizeof m.kt_index);m.group_info=entry.group_info;m.width=entry.width;
   for(int i=0;i<count;++i)XkbKeySymsPtr(map,code)[i]=i?NoSymbol:sym;
   XkbMapChangesRec changes{};changes.changed=XkbKeySymsMask;changes.first_key_sym=code;changes.num_key_syms=1;
   XkbChangeMap(d,map,&changes);
  }
  // Checksum of the core map apart from the bound keys: the journal applies
  // only while no new seat keymap has replaced the one it was written for.
  unsigned long checksum(const std::vector<long>& skip){
   unsigned long h=2166136261u;auto mix=[&](unsigned long v){h=((h^(v&0xffffffff))*16777619u)&0xffffffff;};
   for(int c=map->min_key_code;c<=map->max_key_code;++c){
    bool skipped=false;for(size_t i=1;i+3<skip.size();i+=4)skipped|=skip[i]==c;if(skipped)continue;
    auto& m=map->map->key_sym_map[c];mix(c);mix(m.group_info);mix(m.width);for(auto t:m.kt_index)mix(t);
    for(int i=0;i<XkbKeyNumSyms(map,c);++i)mix(XkbKeySymsPtr(map,c)[i]);
   }
   return h;
  }
  // Journal: checksum, then code, keysym, group info and width, key types.
  std::vector<long> entries(){
   std::vector<long> e{0};
   for(auto& b:bindings){auto& o=b.original;e.insert(e.end(),{long(b.code),long(b.sym),long(o.group_info|(o.width<<8)),long(o.kt_index[0]|(o.kt_index[1]<<8)|(o.kt_index[2]<<16)|(unsigned(o.kt_index[3])<<24))});}
   e[0]=long(checksum(e));return e;
  }
  void bind(int code,KeySym sym){
   bindings.push_back({code,sym,map->map->key_sym_map[code]});
   auto e=entries();  // Written first, so a killed helper's binding is undone.
   XChangeProperty(d,DefaultRootWindow(d),journal,XA_INTEGER,32,PropModeReplace,reinterpret_cast<unsigned char*>(e.data()),e.size());
   XkbSymMapRec one{};one.kt_index[0]=XkbOneLevelIndex;one.width=1;
   one.group_info=XkbSetGroupInfo(1,XkbOutOfRangeGroupInfo(bindings.back().original.group_info),XkbOutOfRangeGroupNumber(bindings.back().original.group_info));
   Trap trap(d);write(code,one,sym);XSync(d,False);
   if(Trap::code){bindings.pop_back();XkbGetKeySyms(d,code,1,map);throw std::runtime_error("Cannot bind X11 key "+name(sym));}
  }
  // Bindings of a killed helper: undo those its keymap still holds.
  void recover(){
   Atom type;int format;unsigned long n,left;unsigned char* data=nullptr;
   if(XGetWindowProperty(d,DefaultRootWindow(d),journal,0,4096,False,XA_INTEGER,&type,&format,&n,&left,&data)!=Success||!data)return;
   std::vector<long> e(reinterpret_cast<long*>(data),reinterpret_cast<long*>(data)+(format==32?n:0));XFree(data);
   if(!e.empty() && (unsigned long)(e[0]&0xffffffff)==checksum(e)){
    Trap trap(d);
    for(size_t i=1;i+3<e.size();i+=4){int code=e[i];
     if(code<map->min_key_code||code>map->max_key_code||!bound(code,e[i+1]))continue;
     XkbSymMapRec o{};o.group_info=e[i+2]&0xff;o.width=(e[i+2]>>8)&0xff;for(int g=0;g<4;++g)o.kt_index[g]=(e[i+3]>>(8*g))&0xff;
     if(XkbNumGroups(o.group_info)>XkbNumKbdGroups)continue;
     write(code,o);}
   }
   XDeleteProperty(d,DefaultRootWindow(d),journal);
  }
  // Clients reread the map lazily when translating a key. Wait until the
  // target answers a _NET_WM_PING sent after the keys, so it has read them.
  void settle(){
   XSync(d,False);
   Atom protocols=XInternAtom(d,"WM_PROTOCOLS",False),ping=XInternAtom(d,"_NET_WM_PING",False);Atom* list=nullptr;int count=0;bool supported=false;
   if(XGetWMProtocols(d,target,&list,&count)){for(int i=0;i<count;++i)supported|=list[i]==ping;XFree(list);}
   if(!supported){std::this_thread::sleep_for(std::chrono::milliseconds(150));return;}
   Window root=DefaultRootWindow(d);XSelectInput(d,root,SubstructureNotifyMask);
   long stamp=0x40000000L|(getpid()&0xffffff);
   XEvent e{};e.xclient.type=ClientMessage;e.xclient.window=target;e.xclient.message_type=protocols;e.xclient.format=32;
   e.xclient.data.l[0]=ping;e.xclient.data.l[1]=stamp;e.xclient.data.l[2]=target;
   XSendEvent(d,target,False,NoEventMask,&e);XFlush(d);
   bool answered=false;
   for(auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);!answered && std::chrono::steady_clock::now()<deadline;){
    while(!answered && XPending(d)){XEvent r;XNextEvent(d,&r);
     if(r.type==eventBase && reinterpret_cast<XkbAnyEvent*>(&r)->xkb_type==XkbNewKeyboardNotify)XPutBackEvent(d,&r),answered=true;  // refresh() handles it
     else answered=r.type==ClientMessage && r.xclient.message_type==protocols && Atom(r.xclient.data.l[0])==ping && r.xclient.data.l[1]==stamp;}
    if(!answered){pollfd p{ConnectionNumber(d),POLLIN,0};poll(&p,1,20);}
   }
   XSelectInput(d,root,NoEventMask);XSync(d,False);
  }
};
