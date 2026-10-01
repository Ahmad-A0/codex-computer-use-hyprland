// X11 selection owner. Preserve every advertised data format before mutation.
// Paste offers "items" (text) or "items_hex" (a saved snapshot). Copy mode
// ("mode":"copy") waits for the app's Copy, reports every format it offers,
// then restores the previous formats.
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/XRes.h>
#include <X11/extensions/Xfixes.h>
#include <json-c/json.h>
#include <sys/select.h>
#include <unistd.h>
#include <chrono>
#include <iostream>
#include <map>
#include <vector>
#include <string>
#include <stdexcept>
#include <cstring>
using Clock=std::chrono::steady_clock;
void need(bool b,const char* s){if(!b)throw std::runtime_error(s);}
struct Value {Atom type=0;int format=8;std::vector<unsigned char> data;size_t count()const{return data.size()/(format==32?sizeof(long):format/8);}};
struct Out {Value value;size_t offset=0;};
int main(){
 Display* d=nullptr;Window window=0;bool owning=false,restoring=false;
 try {
  std::string line;std::getline(std::cin,line);auto* request=json_tokener_parse(line.c_str());need(request,"Invalid clipboard request");
  json_object *display=nullptr,*items=nullptr,*mode=nullptr;bool hex=false;
  bool copy=json_object_object_get_ex(request,"mode",&mode)&&std::string(json_object_get_string(mode))=="copy";
  if(!copy && !json_object_object_get_ex(request,"items",&items))hex=json_object_object_get_ex(request,"items_hex",&items);
  need(json_object_object_get_ex(request,"display",&display)&&(copy||items),"Missing clipboard fields");
  XSetErrorHandler([](Display*,XErrorEvent*){return 0;});
  d=XOpenDisplay(json_object_get_string(display));need(d,"Cannot open XWayland");
  window=XCreateSimpleWindow(d,DefaultRootWindow(d),0,0,1,1,0,0,0);XSelectInput(d,window,PropertyChangeMask);
  auto atom=[&](const char* s){return XInternAtom(d,s,False);};
  Atom clipboard=atom("CLIPBOARD"),targets=atom("TARGETS"),timestamp=atom("TIMESTAMP"),multiple=atom("MULTIPLE"),save=atom("SAVE_TARGETS"),incr=atom("INCR"),property=atom("CODEX_CLIPBOARD_DATA");
  // ICCCM requests, not data formats; DELETE and INSERT_* would edit the owner's selection.
  auto selectionRequest=[&,del=atom("DELETE"),insertSelection=atom("INSERT_SELECTION"),insertProperty=atom("INSERT_PROPERTY")](Atom t){return t==targets||t==timestamp||t==multiple||t==save||t==del||t==insertSelection||t==insertProperty;};
  auto read=[&](Window w,Atom p,bool erase){Value v;unsigned long count=0,left=0;unsigned char* data=nullptr;need(XGetWindowProperty(d,w,p,0,8*1024*1024,erase,AnyPropertyType,&v.type,&v.format,&count,&left,&data)==Success,"Cannot read clipboard property");if(left){if(data)XFree(data);throw std::runtime_error("Clipboard format exceeds 32 MiB snapshot limit");}if(data){v.data.assign(data,data+count*(v.format==32?sizeof(long):v.format/8));XFree(data);}return v;};
  auto waitEvent=[&](auto predicate){auto deadline=Clock::now()+std::chrono::seconds(3);XEvent event;while(Clock::now()<deadline){while(XPending(d)){XNextEvent(d,&event);if(predicate(event))return event;}fd_set fds;FD_ZERO(&fds);FD_SET(ConnectionNumber(d),&fds);timeval tv{0,20000};select(ConnectionNumber(d)+1,&fds,nullptr,nullptr,&tv);}throw std::runtime_error("Clipboard owner did not complete its transfer");};
  auto convert=[&](Atom target){XDeleteProperty(d,window,property);XConvertSelection(d,clipboard,target,property,window,CurrentTime);XFlush(d);auto event=waitEvent([&](XEvent& e){return e.type==SelectionNotify&&e.xselection.requestor==window;});if(event.xselection.property==None)return Value{};auto v=read(window,property,True);if(v.type!=incr)return v;Value result;for(;;){XFlush(d);waitEvent([&](XEvent& e){return e.type==PropertyNotify&&e.xproperty.window==window&&e.xproperty.atom==property&&e.xproperty.state==PropertyNewValue;});auto chunk=read(window,property,True);if(chunk.data.empty())break;if(result.data.empty()){result.type=chunk.type;result.format=chunk.format;}need(result.type==chunk.type&&result.format==chunk.format,"Clipboard format changed mid-transfer");need(result.data.size()+chunk.data.size()<=32*1024*1024,"Clipboard snapshot exceeds limit");result.data.insert(result.data.end(),chunk.data.begin(),chunk.data.end());}return result;};
  auto nibble=[](char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;throw std::runtime_error("Invalid snapshot encoding");};
  auto unhex=[&](json_object* encoded){need(json_object_is_type(encoded,json_type_string),"Invalid snapshot bytes");std::string hex=json_object_get_string(encoded);need(hex.size()%2==0 && hex.size()<=64*1024*1024,"Snapshot format exceeds limit");
   std::vector<unsigned char> bytes;bytes.reserve(hex.size()/2);for(size_t n=0;n<hex.size();n+=2)bytes.push_back((nibble(hex[n])<<4)|nibble(hex[n+1]));return bytes;};
  std::map<Atom,Value> previous,current;std::string copiedJson;
  Window previousOwner=XGetSelectionOwner(d,clipboard);
  auto snapshotDeadline=Clock::now()+std::chrono::seconds(8);size_t snapshotBytes=0;
  if(previousOwner){auto types=convert(targets);
   if(types.type==None){
    // A fresh XWM owns CLIPBOARD even with no Wayland selection. Verify the
    // owner process, rather than mistaking an unresponsive app for empty data.
    json_object *empty=nullptr,*pid=nullptr,*snapshot=nullptr;bool compositorOwner=false;
    if(json_object_object_get_ex(request,"compositor_pid",&pid)){
     XResClientIdSpec spec{previousOwner,XRES_CLIENT_ID_PID_MASK};long count=0;XResClientIdValue* ids=nullptr;
     if(XResQueryClientIds(d,1,&spec,&count,&ids)==Success){
      for(long i=0;i<count;++i)if(XResGetClientIdType(&ids[i])==XRES_CLIENT_ID_PID&&XResGetClientPid(&ids[i])==json_object_get_int64(pid))compositorOwner=true;
      XResClientIdsDestroy(count,ids);
     }
    }
    if(compositorOwner && json_object_object_get_ex(request,"wayland_snapshot",&snapshot)){
     need(json_object_is_type(snapshot,json_type_object),"Invalid Wayland clipboard snapshot");
     json_object_object_foreach(snapshot,mime,encoded){
      Value value;value.type=atom(mime);value.format=8;value.data=unhex(encoded);
      snapshotBytes+=value.data.size();need(snapshotBytes<=64*1024*1024,"Clipboard snapshot exceeds total limit");previous[value.type]=std::move(value);
     }
     auto plain=previous.find(atom("text/plain;charset=utf-8"));if(plain!=previous.end()){previous[atom("UTF8_STRING")]=plain->second;previous[atom("UTF8_STRING")].type=atom("UTF8_STRING");}
     types.type=XA_ATOM;types.format=32;
    }else if(compositorOwner && json_object_object_get_ex(request,"clipboard_empty",&empty)&&json_object_get_boolean(empty)){types.type=XA_ATOM;types.format=32;}
   }
   need(types.type==XA_ATOM&&types.format==32,"Clipboard owner did not enumerate formats");need(types.count()<=256,"Clipboard advertises too many formats");auto* values=reinterpret_cast<const unsigned long*>(types.data.data());for(size_t i=0;i<types.count();++i){Atom t=values[i];if(selectionRequest(t))continue;need(Clock::now()<snapshotDeadline,"Clipboard snapshot timed out");auto v=convert(t);snapshotBytes+=v.data.size();need(snapshotBytes<=64*1024*1024,"Clipboard snapshot exceeds total limit");if(v.type!=None)previous[t]=std::move(v);}}
  need(XGetSelectionOwner(d,clipboard)==previousOwner,"Clipboard changed during snapshot; paste not started");
  json_object* snapshot=nullptr;
  if(json_object_object_get_ex(request,"wayland_snapshot",&snapshot)){
   std::cout<<"{\"ok\":true,\"snapshot_ready\":true}"<<std::endl;
   std::string confirmation;need(bool(std::getline(std::cin,confirmation))&&confirmation=="own","Clipboard snapshot was not confirmed");
   need(XGetSelectionOwner(d,clipboard)==previousOwner,"Clipboard changed before paste; paste not started");
  }
  if(copy){
   // Wait for the app's Copy to take CLIPBOARD, capture each format it offers,
   // then give the previous formats back (or no owner if there were none).
   int event=0,error=0;need(XFixesQueryExtension(d,&event,&error),"XFixes is unavailable");
   XFixesSelectSelectionInput(d,window,clipboard,XFixesSetSelectionOwnerNotifyMask);XSync(d,False);
   std::cout<<"{\"ok\":true,\"armed\":true}"<<std::endl;
   try{waitEvent([&](XEvent& e){if(e.type!=event+XFixesSelectionNotify)return false;auto& n=reinterpret_cast<XFixesSelectionNotifyEvent&>(e);return n.selection==clipboard && n.owner!=None && n.owner!=window;});}
   catch(const std::runtime_error&){throw std::runtime_error("Copy did not update the clipboard; select content first");}
   std::map<Atom,Value> copied;size_t copiedBytes=0;
   auto types=convert(targets);need(types.type==XA_ATOM&&types.format==32,"Clipboard owner did not enumerate formats");need(types.count()<=256,"Clipboard advertises too many formats");
   auto* values=reinterpret_cast<const unsigned long*>(types.data.data());auto copyDeadline=Clock::now()+std::chrono::seconds(8);
   for(size_t i=0;i<types.count();++i){Atom t=values[i];if(selectionRequest(t))continue;need(Clock::now()<copyDeadline,"Clipboard capture timed out");auto v=convert(t);copiedBytes+=v.data.size();need(copiedBytes<=64*1024*1024,"Clipboard snapshot exceeds total limit");if(v.type!=None)copied[t]=std::move(v);}
   need(!copied.empty(),"Copy cleared the clipboard");
   // One reply line after restoration: the copied formats, hex-encoded.
   auto* formats=json_object_new_object();
   for(auto& [t,v]:copied){static const char* digits="0123456789abcdef";std::string hexed;hexed.reserve(v.data.size()*2);for(auto b:v.data){hexed+=digits[b>>4];hexed+=digits[b&15];}
    char* name=XGetAtomName(d,t);if(name){json_object_object_add(formats,name,json_object_new_string_len(hexed.data(),hexed.size()));XFree(name);}}
   copiedJson=json_object_to_json_string_ext(formats,JSON_C_TO_STRING_PLAIN);json_object_put(formats);json_object_put(request);
   if(previous.empty()){XSetSelectionOwner(d,clipboard,None,CurrentTime);XSync(d,False);std::cout<<"{\"ok\":true,\"restored\":true,\"formats\":"<<copiedJson<<"}"<<std::endl;XDestroyWindow(d,window);XCloseDisplay(d);return 0;}
   current=std::move(previous);restoring=true;
  } else {
   json_object_object_foreach(items,key,value){Atom t=atom(key);
    if(hex)current[t]={t,8,unhex(value)};
    else {need(json_object_is_type(value,json_type_string),"Invalid clipboard content");auto* bytes=json_object_get_string(value);auto n=json_object_get_string_len(value);need(n<=1024*1024,"Paste format exceeds 1 MiB");current[t]={t,8,{reinterpret_cast<const unsigned char*>(bytes),reinterpret_cast<const unsigned char*>(bytes)+n}};}}
  }
  auto plain=current.find(atom("text/plain;charset=utf-8"));if(plain!=current.end()){current[atom("UTF8_STRING")]=plain->second;current[atom("UTF8_STRING")].type=atom("UTF8_STRING");}
  if(!copy)json_object_put(request);
  XSetSelectionOwner(d,clipboard,window,CurrentTime);XSync(d,False);need(XGetSelectionOwner(d,clipboard)==window,"Cannot own X clipboard");owning=true;
  std::map<std::pair<Window,Atom>,Out> pending;unsigned received=0,completed=0;
  auto reply=[&](const std::string& extra=""){std::cout<<"{\"ok\":true,\"received\":"<<received<<",\"completed\":"<<completed<<extra<<"}"<<std::endl;};
  auto restore=[&](){if(restoring)return;restoring=true;if(XGetSelectionOwner(d,clipboard)!=window){owning=false;reply(",\"restored\":true,\"new_copy_preserved\":true");return;}current=std::move(previous);if(current.empty()){XSetSelectionOwner(d,clipboard,None,CurrentTime);XFlush(d);owning=false;}reply(",\"restored\":true");};
  reply(copy?",\"restored\":true,\"formats\":"+copiedJson:",\"ready\":true");auto deadline=Clock::now()+std::chrono::seconds(20);
  auto put=[&](Window w,Atom p,const Value& v){XChangeProperty(d,w,p,v.type,v.format,PropModeReplace,v.data.data(),v.count());};
  while(owning){
   if(!restoring&&Clock::now()>deadline)restore();
   while(XPending(d)){
    XEvent event;XNextEvent(d,&event);
    if(event.type==SelectionClear){owning=false;break;}
    if(event.type==PropertyNotify&&event.xproperty.state==PropertyDelete){auto key=std::pair{event.xproperty.window,event.xproperty.atom};auto it=pending.find(key);if(it!=pending.end()){auto& out=it->second;size_t n=std::min(size_t(32768),out.value.data.size()-out.offset);Value chunk{out.value.type,out.value.format,{out.value.data.begin()+out.offset,out.value.data.begin()+out.offset+n}};put(key.first,key.second,chunk);out.offset+=n;if(!n){++completed;pending.erase(it);}}}
    if(event.type!=SelectionRequest)continue;
    auto& r=event.xselectionrequest;Atom p=r.property?r.property:r.target;bool success=false;
    if(r.target==targets){std::vector<unsigned long> atoms{targets,timestamp};for(auto& [t,v]:current)atoms.push_back(t);XChangeProperty(d,r.requestor,p,XA_ATOM,32,PropModeReplace,reinterpret_cast<unsigned char*>(atoms.data()),atoms.size());success=true;}
    else if(r.target==timestamp){unsigned long t=CurrentTime;XChangeProperty(d,r.requestor,p,XA_INTEGER,32,PropModeReplace,reinterpret_cast<unsigned char*>(&t),1);success=true;}
    else if(auto it=current.find(r.target);it!=current.end()){
     ++received;auto& v=it->second;
     if(v.data.size()>65536){XSelectInput(d,r.requestor,PropertyChangeMask);unsigned long n=v.data.size();XChangeProperty(d,r.requestor,p,incr,32,PropModeReplace,reinterpret_cast<unsigned char*>(&n),1);pending[{r.requestor,p}]={v,0};}
     else {put(r.requestor,p,v);++completed;}success=true;
    }
    XEvent notification{};notification.xselection={SelectionNotify,0,True,d,r.requestor,r.selection,r.target,success?p:None,r.time};XSendEvent(d,r.requestor,False,0,&notification);XFlush(d);
   }
   if(!owning)break;
   fd_set fds;FD_ZERO(&fds);FD_SET(ConnectionNumber(d),&fds);if(!restoring)FD_SET(STDIN_FILENO,&fds);timeval tv{0,20000};int count=select(ConnectionNumber(d)+1,&fds,nullptr,nullptr,&tv);
   if(count>0&&!restoring&&FD_ISSET(STDIN_FILENO,&fds)){if(!std::getline(std::cin,line)||line=="end")restore();else if(line=="status")reply();}
   XFlush(d);
  }
  XDestroyWindow(d,window);XCloseDisplay(d);return 0;
 }catch(const std::exception& e){auto* j=json_object_new_object();json_object_object_add(j,"ok",json_object_new_boolean(false));json_object_object_add(j,"error",json_object_new_string(e.what()));std::cout<<json_object_to_json_string_ext(j,JSON_C_TO_STRING_PLAIN)<<std::endl;json_object_put(j);if(d)XCloseDisplay(d);return 1;}
}
