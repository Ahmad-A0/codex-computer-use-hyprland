// Dedicated XInput2 master devices. Never changes the physical/core X11 seat.
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XInput2.h>
#include <X11/extensions/XInput.h>
#include <X11/extensions/XTest.h>
#include <json-c/json.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
static void need(bool condition,const char* error){if(!condition)throw std::runtime_error(error);}
static json_object* field(json_object* j,const char* k){json_object* v=nullptr;need(json_object_object_get_ex(j,k,&v),"Missing X11 field");return v;}
static double num(json_object* j,const char* k){return json_object_get_double(field(j,k));}
static std::string str(json_object* j,const char* k){return json_object_get_string(field(j,k));}
static void settleEvents(){std::this_thread::sleep_for(std::chrono::milliseconds(12));}
struct Connection {Display* d;~Connection(){if(d)XCloseDisplay(d);}};
#include "xpopups.hpp"
int main(int argc,char** argv){
 try {
  need(argc==2,"Expected JSON request");
  std::unique_ptr<json_object,decltype(&json_object_put)> j(json_tokener_parse(argv[1]),json_object_put);need(bool(j),"Invalid JSON");
  Connection conn{XOpenDisplay(str(j.get(),"display").c_str())};need(conn.d,"Cannot connect to XWayland");auto* d=conn.d;
  int masterPointer=0,masterKeyboard=0,slavePointer=0,slaveKeyboard=0;
  auto discover=[&](){int count=0;auto* all=XIQueryDevice(d,XIAllDevices,&count);for(int i=0;i<count;++i){std::string name=all[i].name;if(name=="Codex background pointer")masterPointer=all[i].deviceid;else if(name=="Codex background keyboard")masterKeyboard=all[i].deviceid;else if(name=="Codex background XTEST pointer")slavePointer=all[i].deviceid;else if(name=="Codex background XTEST keyboard")slaveKeyboard=all[i].deviceid;}XIFreeDeviceInfo(all);};
  discover();
  // Keys and buttons held by Sky key_down/drag_handle/durations stay down on
  // the private devices between helper runs. Report what each device holds.
  auto pressed=[&](XDevice* device,int kind){std::vector<unsigned> codes;auto* state=XQueryDeviceState(d,device);if(!state)return codes;auto* c=state->data;
   for(int i=0;i<state->num_classes;++i){if(c->c_class==kind && kind==KeyClass){auto* k=reinterpret_cast<XKeyState*>(c);for(int code=8;code<k->num_keys && code<256;++code)if(k->keys[code/8]&(1<<(code%8)))codes.push_back(code);}
    if(c->c_class==kind && kind==ButtonClass){auto* b=reinterpret_cast<XButtonState*>(c);for(int n=1;n<b->num_buttons && n<256;++n)if(b->buttons[n/8]&(1<<(n%8)))codes.push_back(n);}
    c=reinterpret_cast<XInputClass*>(reinterpret_cast<char*>(c)+c->length);}
   XFreeDeviceState(state);return codes;};
  if(str(j.get(),"op")=="release_all"){
   if(slavePointer&&slaveKeyboard){auto* p=XOpenDevice(d,slavePointer);auto* k=XOpenDevice(d,slaveKeyboard);need(p&&k,"Cannot open isolated X11 input devices");
    for(auto b:pressed(p,ButtonClass))XTestFakeDeviceButtonEvent(d,p,b,False,nullptr,0,CurrentTime);
    for(auto code:pressed(k,KeyClass))XTestFakeDeviceKeyEvent(d,k,code,False,nullptr,0,CurrentTime);
    XSync(d,False);XCloseDevice(d,k);XCloseDevice(d,p);}
   std::cout<<"{\"ok\":true}\n";return 0;
  }
  Window target=json_object_get_uint64(field(j.get(),"xid"));XWindowAttributes attr;need(XGetWindowAttributes(d,target,&attr),"X11 window disappeared");
  if(str(j.get(),"op")=="popup_capture"){std::cout<<capturePopups(d,target,attr,j.get())<<std::endl;return 0;}
  if(!masterPointer){XIAddMasterInfo info{XIAddMaster,const_cast<char*>("Codex background"),True,True};need(XIChangeHierarchy(d,reinterpret_cast<XIAnyHierarchyChangeInfo*>(&info),1)==Success,"Cannot create isolated X11 input devices");XSync(d,False);discover();}
  need(masterPointer&&masterKeyboard&&slavePointer&&slaveKeyboard,"Isolated X11 devices unavailable");
  auto* pointerDevice=XOpenDevice(d,slavePointer);auto* keyboardDevice=XOpenDevice(d,slaveKeyboard);need(pointerDevice&&keyboardDevice,"Cannot open isolated X11 input devices");
  auto op=str(j.get(),"op");
  auto focusEvent=[&](Window w,int type){if(!w)return;XEvent e{};e.xfocus={type,0,True,d,w,NotifyNormal,NotifyNonlinear};XSendEvent(d,w,False,NoEventMask,&e);};
  auto pidFor=[&](Window w){Atom type;int format;unsigned long n,left;unsigned char* data=nullptr;unsigned long pid=0;XGetWindowProperty(d,w,XInternAtom(d,"_NET_WM_PID",False),0,1,False,XA_CARDINAL,&type,&format,&n,&left,&data);if(data){if(n&&format==32)pid=*reinterpret_cast<unsigned long*>(data);XFree(data);}return pid;};
  if(op=="ax_probe_clear"){
   Window previous=None;XIGetFocus(d,masterKeyboard,&previous);XISetFocus(d,masterKeyboard,None,CurrentTime);
   auto pid=pidFor(target);Window root,parent,*children=nullptr;unsigned count=0;
   if(pid && XQueryTree(d,DefaultRootWindow(d),&root,&parent,&children,&count)){for(unsigned i=0;i<count;++i)if(pidFor(children[i])==pid)focusEvent(children[i],FocusOut);if(children)XFree(children);}
   XSync(d,False);
   XCloseDevice(d,keyboardDevice);XCloseDevice(d,pointerDevice);std::cout<<"{\"ok\":true,\"previous\":"<<previous<<"}\n";return 0;
  }
  if(op=="ax_probe_end"){
   Window previous=json_object_get_uint64(field(j.get(),"previous"));XISetFocus(d,masterKeyboard,previous,CurrentTime);focusEvent(target,FocusOut);focusEvent(previous,FocusIn);XSync(d,False);
   XCloseDevice(d,keyboardDevice);XCloseDevice(d,pointerDevice);std::cout<<"{\"ok\":true}\n";return 0;
  }
  XISetFocus(d,masterKeyboard,target,CurrentTime);XSync(d,False);settleEvents();
  // The provider sends this target's held keys; the private keyboard holds
  // exactly those (in order), so another target's holds never leak here.
  std::vector<unsigned> held;
  if(json_object* names=nullptr;json_object_object_get_ex(j.get(),"held",&names)){
   need(json_object_is_type(names,json_type_array)&&json_object_array_length(names)<=16,"Expected at most 16 held keys");
   for(size_t i=0;i<json_object_array_length(names);++i){auto sym=XStringToKeysym(json_object_get_string(json_object_array_get_idx(names,i)));need(sym!=NoSymbol,"Unknown X11 key");
    int lo,hi;XDisplayKeycodes(d,&lo,&hi);unsigned code=0;for(int c=lo;c<=hi && !code;++c)for(int level=0;level<2;++level)if(XkbKeycodeToKeysym(d,c,0,level)==sym){code=c;break;}
    need(code,"X11 key is not mapped");if(std::find(held.begin(),held.end(),code)==held.end())held.push_back(code);}
  }
  {auto down=pressed(keyboardDevice,KeyClass);bool changed=false;
   for(auto it=down.rbegin();it!=down.rend();++it)if(std::find(held.begin(),held.end(),*it)==held.end()){XTestFakeDeviceKeyEvent(d,keyboardDevice,*it,False,nullptr,0,CurrentTime);changed=true;}
   for(auto code:held)if(std::find(down.begin(),down.end(),code)==down.end()){XTestFakeDeviceKeyEvent(d,keyboardDevice,code,True,nullptr,0,CurrentTime);changed=true;}
   if(changed){XSync(d,False);settleEvents();}}
  auto isHeld=[&](unsigned code){return std::find(held.begin(),held.end(),code)!=held.end();};
  auto point=[&](double x,double y){return std::pair<int,int>{std::lround(x*attr.width/num(j.get(),"width")),std::lround(y*attr.height/num(j.get(),"height"))};};
  auto pointer=[&](int type,double x,double y,unsigned button,unsigned){
   auto [px,py]=point(x,y);XIWarpPointer(d,masterPointer,None,target,0,0,0,0,px,py);XSync(d,False);settleEvents();
   if(type!=MotionNotify){need(XTestFakeDeviceButtonEvent(d,pointerDevice,button,type==ButtonPress,nullptr,0,CurrentTime),"X11 device button injection failed");XSync(d,False);settleEvents();}
  };
  auto key=[&](unsigned code,unsigned state){
   std::vector<unsigned> modifiers;
   for(auto [mask,symbol]:{std::pair{ShiftMask,XK_Shift_L},std::pair{ControlMask,XK_Control_L},std::pair{Mod1Mask,XK_Alt_L},std::pair{Mod4Mask,XK_Super_L},std::pair{Mod5Mask,XK_ISO_Level3_Shift}})
    if(state&mask){auto c=XKeysymToKeycode(d,symbol);if(c && !isHeld(c)){modifiers.push_back(c);XTestFakeDeviceKeyEvent(d,keyboardDevice,c,True,nullptr,0,CurrentTime);}}
   XTestFakeDeviceKeyEvent(d,keyboardDevice,code,True,nullptr,0,CurrentTime);XTestFakeDeviceKeyEvent(d,keyboardDevice,code,False,nullptr,0,CurrentTime);
   for(auto it=modifiers.rbegin();it!=modifiers.rend();++it)XTestFakeDeviceKeyEvent(d,keyboardDevice,*it,False,nullptr,0,CurrentTime);
   XSync(d,False);settleEvents();
  };
  auto find=[&](KeySym sym){int lo,hi;XDisplayKeycodes(d,&lo,&hi);for(int code=lo;code<=hi;++code)for(int level=0;level<2;++level)if(XkbKeycodeToKeysym(d,code,0,level)==sym)return std::pair<unsigned,unsigned>{code,level?ShiftMask:0};return std::pair<unsigned,unsigned>{0,0};};
  if(op=="ax_probe") {focusEvent(target,FocusIn);XSync(d,False);}
  else if(op=="hold") {}
  else if(op=="drag_motion") {double x=num(j.get(),"x"),y=num(j.get(),"y");need(std::isfinite(x)&&std::isfinite(y),"Invalid X11 point");pointer(MotionNotify,x,y,0,0);}
  else if(op=="key") {
   auto sym=XStringToKeysym(str(j.get(),"key").c_str());need(sym!=NoSymbol,"Unknown X11 key");auto [code,mods]=find(sym);need(code,"X11 key is not mapped");
   auto a=field(j.get(),"modifiers");for(size_t i=0;i<json_object_array_length(a);++i){std::string m=json_object_get_string(json_object_array_get_idx(a,i));mods|=m=="Shift"?ShiftMask:m=="Control"?ControlMask:m=="Mod1"?Mod1Mask:m=="Mod4"?Mod4Mask:m=="Mod5"?Mod5Mask:0;}
   key(code,mods);
  } else if(op=="text") {
   auto text=str(j.get(),"text");std::vector<unsigned> chars;
   for(size_t i=0;i<text.size();){unsigned char b=text[i++];unsigned cp=b;int n=0;if(b>=0xf0){cp=b&7;n=3;}else if(b>=0xe0){cp=b&15;n=2;}else if(b>=0xc0){cp=b&31;n=1;}for(int k=0;k<n;++k){need(i<text.size(),"Invalid UTF-8");cp=(cp<<6)|(text[i++]&63);}chars.push_back(cp);}
   std::vector<std::pair<unsigned,unsigned>> strokes;
   for(auto cp:chars){need(cp<128,"Unicode X11 typing requires the accessibility route");KeySym sym=cp=='\n'||cp=='\r'?XK_Return:cp=='\t'?XK_Tab:cp;auto stroke=find(sym);need(stroke.first,"X11 text key unavailable");strokes.push_back(stroke);}
   for(auto [code,mods]:strokes)key(code,mods);
  } else {
   double x=num(j.get(),"x"),y=num(j.get(),"y");bool valid=x>=0&&y>=0&&x<num(j.get(),"width")&&y<num(j.get(),"height");
   if(!valid){auto [px,py]=point(x,y);for(auto p:ownedPopups(d,target))if(px>=p.x&&py>=p.y&&px<p.x+p.width&&py<p.y+p.height)valid=true;}
   need(valid || (op=="button" && str(j.get(),"state")=="up"),"X11 point outside window and owned popups");
   bool press=op=="button" && str(j.get(),"state")=="down";
   if(op=="button" && !press){auto b=str(j.get(),"button");pointer(ButtonRelease,x,y,b=="left"?1:b=="middle"?2:3,0);XCloseDevice(d,keyboardDevice);XCloseDevice(d,pointerDevice);XSync(d,False);std::cout<<"{\"ok\":true}\n";return 0;}
   if(op=="click" || op=="move" || op=="scroll" || press){
    auto [px,py]=point(x,y);Window window=target;
    for(auto popup:ownedPopups(d,target))if(px>=popup.x&&py>=popup.y&&px<popup.x+popup.width&&py<popup.y+popup.height){window=popup.window;px-=popup.x;py-=popup.y;break;}
    bool menuGrab=false;for(auto popup:ownedPopups(d,target))if(popup.menu)menuGrab=true;
    int rx,ry;Window visible=None;
    XTranslateCoordinates(d,window,DefaultRootWindow(d),px,py,&rx,&ry,&visible);
    // XTest still uses server hit testing. A grab by this helper would consume
    // events in the helper, not deliver them to the target application's client.
    // Never let a covered coordinate silently reach an unrelated X window.
    need(menuGrab || visible==window,"X11 pointer target is covered by another X window; use an accessibility action or expose the target");
   }
   if(op=="click") {auto b=str(j.get(),"button");unsigned button=b=="left"?1:b=="middle"?2:3;json_object* duration=nullptr;int hold=json_object_object_get_ex(j.get(),"duration",&duration)?std::clamp<int>(json_object_get_int(duration),0,10000):0;
    for(int i=0;i<num(j.get(),"count");++i){pointer(ButtonPress,x,y,button,0);if(hold)std::this_thread::sleep_for(std::chrono::milliseconds(hold));pointer(ButtonRelease,x,y,button,1u<<(7+button));}}
   else if(press){auto b=str(j.get(),"button");pointer(ButtonPress,x,y,b=="left"?1:b=="middle"?2:3,0);}
   else if(op=="move")pointer(MotionNotify,x,y,0,0);
   else if(op=="drag"){
    double ex=num(j.get(),"end_x"),ey=num(j.get(),"end_y");json_object* destination=nullptr;
    if(json_object_object_get_ex(j.get(),"destination_xid",&destination)){
     Window dest=json_object_get_uint64(destination),child;XWindowAttributes geometry;need(XGetWindowAttributes(d,dest,&geometry),"Drag destination disappeared");int px,py;
     need(XTranslateCoordinates(d,dest,target,std::lround(ex*geometry.width/num(j.get(),"destination_width")),std::lround(ey*geometry.height/num(j.get(),"destination_height")),&px,&py,&child),"Cannot map X11 drag destination");
     ex=px*num(j.get(),"width")/attr.width;ey=py*num(j.get(),"height")/attr.height;
    }
    auto unobscured=[&](double cx,double cy,Window expected){auto [px,py]=point(cx,cy);int rx,ry;Window child=None;XTranslateCoordinates(d,target,DefaultRootWindow(d),px,py,&rx,&ry,&child);return child==expected;};
    need(unobscured(x,y,target),"X11 drag source is covered by another X window; no drag delivered");
    Window expected=destination?json_object_get_uint64(destination):target;
    need(unobscured(ex,ey,expected),"X11 drag destination is covered by another X window; no drag delivered");
    pointer(ButtonPress,x,y,1,0);
    for(int i=1;i<=30;++i)pointer(MotionNotify,x+(ex-x)*i/30.,y+(ey-y)*i/30.,0,Button1Mask);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));pointer(ButtonRelease,ex,ey,1,Button1Mask);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
   }
   else if(op=="scroll"){for(auto [axis,positive,negative]:{std::tuple{"dx",7,6},std::tuple{"dy",5,4}}){auto distance=num(j.get(),axis);unsigned button=distance>0?positive:negative;for(int i=0;i<std::ceil(std::abs(distance)/40.);++i){pointer(ButtonPress,x,y,button,0);pointer(ButtonRelease,x,y,button,0);}}}
   else if(op!="point")throw std::runtime_error("Unknown X11 operation");
  }
  XCloseDevice(d,keyboardDevice);XCloseDevice(d,pointerDevice);XSync(d,False);std::cout<<"{\"ok\":true}\n";return 0;
 }catch(const std::exception& e){auto* j=json_object_new_object();json_object_object_add(j,"ok",json_object_new_boolean(false));json_object_object_add(j,"error",json_object_new_string(e.what()));std::cout<<json_object_to_json_string_ext(j,JSON_C_TO_STRING_PLAIN)<<'\n';json_object_put(j);return 1;}
}
